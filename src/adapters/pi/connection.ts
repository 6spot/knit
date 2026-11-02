/**
 * Pi CLI stdin/stdout RPC 连接（DESIGN.md 5.6）。
 * 只使用公开 JSONL 协议：请求 {id, type, ...}，响应 {type:"response", id,...}；
 * 其余记录是事件流。响应被接受不等于终态，稳定终态由 agent_settled 事件表达。
 * Pi 协议形状只出现在本目录；不导入 Pi SDK 或 RpcClient。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { LfFrameDecoder } from "../../contracts/frames.js";

export type PiRpcRecord = { type: string } & Record<string, unknown>;

export interface PiRpcResponse {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: unknown;
}

export interface PiProcessExit {
  code: number | null;
  signal: string | null;
}

export class PiConnectionClosedError extends Error {
  constructor(message: string, readonly exit: PiProcessExit | null) {
    super(message);
    this.name = "PiConnectionClosedError";
  }
}

export function isResponse(record: PiRpcRecord): record is PiRpcResponse & PiRpcRecord {
  return record.type === "response" && typeof record.id === "string";
}

interface Pending {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const STDERR_TAIL_LIMIT = 8 * 1024;

/** 单个 pi --mode rpc 进程的协议连接；负责分帧、请求关联与 EOF 语义。 */
export class PiRpcConnection {
  private readonly child: ChildProcess;
  private readonly decoder = new LfFrameDecoder();
  private readonly pending = new Map<string, Pending>();
  private eofSeen = false;
  private exitInfo: PiProcessExit | null = null;
  private readonly exitWaiters: Array<(exit: PiProcessExit) => void> = [];
  private stderrTail = "";
  private stderrTruncated = false;
  /** 收到的协议事件（非 response 记录）；由调用方消费。 */
  readonly events: PiRpcRecord[] = [];
  /** 无法按 JSON 对象核实的帧（畸形或截断尾部）；不当作响应或事件。 */
  readonly invalidFrames: string[] = [];

  constructor(
    executablePath: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) {
    this.child = spawn(executablePath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX 下使子进程成为独立进程组，允许组信号；不跨越本连接管理的进程。
      detached: true,
    });
    this.child.on("error", () => this.handleEof());
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal: signal ?? null };
      this.handleEof();
      const waiters = this.exitWaiters.splice(0);
      for (const waiter of waiters) waiter(this.exitInfo);
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail += chunk.toString("utf-8");
      if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
        this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_LIMIT);
        this.stderrTruncated = true;
      }
    });
    void this.pumpStdout();
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get exit(): PiProcessExit | null {
    return this.exitInfo;
  }

  /** 最近 stderr 内容（尾部截断保留）；诊断用途，不作权威回执。 */
  get diagnostics(): string {
    return this.stderrTruncated ? `…(截断)${this.stderrTail}` : this.stderrTail;
  }

  private async pumpStdout(): Promise<void> {
    const stream = this.child.stdout;
    if (stream === null) {
      this.handleEof();
      return;
    }
    try {
      for await (const chunk of stream) {
        for (const frame of this.decoder.push(new Uint8Array(chunk))) {
          this.dispatch(frame);
        }
      }
      const tail = this.decoder.end();
      if (tail !== null) this.invalidFrames.push(tail);
    } catch {
      // 读流失败按 EOF 处理；真实退出状态以 exit 事件为准。
    }
    // stdout 结束可能先于 exit 事件；等待短暂窗口让真实退出码／信号先落地。
    if (this.exitInfo === null) {
      for (let i = 0; i < 200 && this.exitInfo === null; i++) {
        await sleep(10);
      }
    }
    this.handleEof();
  }

  private dispatch(frame: string): void {
    let record: unknown;
    try {
      record = JSON.parse(frame);
    } catch {
      this.invalidFrames.push(frame);
      return;
    }
    if (typeof record !== "object" || record === null || !("type" in record)) {
      this.invalidFrames.push(frame);
      return;
    }
    const typed = record as PiRpcRecord;
    if (isResponse(typed)) {
      const waiter = this.pending.get(typed.id);
      if (waiter !== undefined) {
        this.pending.delete(typed.id);
        clearTimeout(waiter.timer);
        waiter.resolve(typed);
      }
      return;
    }
    this.events.push(typed);
    if (this.events.length > 100_000) {
      // 事件仅作观察缓冲，超限丢弃最旧，避免长回合内存膨胀。
      this.events.splice(0, this.events.length - 100_000);
    }
  }

  private handleEof(): void {
    if (this.eofSeen) return;
    this.eofSeen = true;
    const exit = this.exitInfo;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new PiConnectionClosedError(`Pi RPC 连接在等待响应 ${id} 时结束`, exit));
    }
    this.pending.clear();
  }

  /** 进程已退出（或流已结束）后不再接受新请求。 */
  private ensureSendable(): void {
    if (this.eofSeen || this.exitInfo !== null) {
      throw new PiConnectionClosedError("Pi RPC 连接已结束，无法发送请求", this.exitInfo);
    }
    if (!this.child.stdin || this.child.stdin.destroyed) {
      throw new PiConnectionClosedError("Pi RPC stdin 不可用", this.exitInfo);
    }
  }

  send(kind: string, data: Record<string, unknown> = {}): string {
    this.ensureSendable();
    const id = crypto.randomUUID();
    const line = `${JSON.stringify({ id, type: kind, ...data })}\n`;
    this.child.stdin!.write(Buffer.from(line, "utf-8"));
    return id;
  }

  /** 发送控制请求并等待同 ID 响应；超时不自动终止进程，由调用方决定。 */
  call(kind: string, data: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<PiRpcResponse> {
    this.ensureSendable();
    const id = this.send(kind, data);
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC 请求超时: ${kind} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** 等待进程真实退出；返回真实退出码与信号。 */
  waitExit(timeoutMs = 10_000): Promise<PiProcessExit | null> {
    if (this.exitInfo !== null) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) this.exitWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (exit: PiProcessExit) => {
        clearTimeout(timer);
        resolve(exit);
      };
      this.exitWaiters.push(waiter);
    });
  }

  endStdin(): void {
    this.child.stdin?.end();
  }

  /** 向整个进程组发信号；进程不存在视为已结束。 */
  killProcessGroup(signal: NodeJS.Signals): boolean {
    const pid = this.pid;
    if (pid === null) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
