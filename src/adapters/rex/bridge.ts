/**
 * Rex worker 与 Knit 宿主之间的本机双向通道（本任务 design.md S1）。
 *
 * 协议是 Unix socket 上的 LF 分隔 JSON 帧：
 *   请求  {id, method: "status"|"subscribe"|"steer"|"stop", message?}
 *   响应  {id, value} 或 {id, error}
 *   事件  {event: "state", state}
 *
 * 只传控制事实，不传模型 transcript；单帧上限 256 KiB，超限或畸形直接断开，
 * 不把截断帧当作有效指令。帧布局参考 pi-rexagents 的 transport.ts。
 */
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { ensureSocketDirectory } from "./state.js";

export const MAX_FRAME = 256 * 1024;

export type BridgeMethod = "status" | "subscribe" | "steer" | "stop";

export interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  message?: string;
}

type BridgeFrame =
  | { id: string; value?: unknown; error?: string }
  | { event: "state"; state: unknown };

function write(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

/** 逐行切帧；跨 chunk 的半行留在缓冲，超限或非法 JSON 立即断开连接。 */
function readFrames(socket: Socket, receive: (value: unknown) => void): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (data: string) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > MAX_FRAME) {
      socket.destroy(new Error("Rex worker 协议帧超过上限"));
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        try {
          receive(JSON.parse(line));
        } catch {
          socket.destroy(new Error("Rex worker 协议帧不是合法 JSON"));
          return;
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
}

export function parseBridgeRequest(value: unknown): BridgeRequest {
  if (typeof value !== "object" || value === null) throw new Error("Rex worker 请求必须是对象");
  const input = value as Partial<BridgeRequest>;
  if (typeof input.id !== "string" || input.id === "") throw new Error("Rex worker 请求缺少 id");
  if (
    input.method !== "status" &&
    input.method !== "subscribe" &&
    input.method !== "steer" &&
    input.method !== "stop"
  ) {
    throw new Error("Rex worker 请求方法不合法");
  }
  if (input.method === "steer" && (typeof input.message !== "string" || input.message.trim() === "")) {
    throw new Error("Rex worker steer 需要非空 message");
  }
  return input as BridgeRequest;
}

/** worker 侧 server：同一 socket 上响应请求并广播状态快照。 */
export class BridgeServer {
  private readonly server: Server;
  private readonly clients = new Set<Socket>();
  private readonly subscribers = new Set<Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly snapshot: () => unknown,
    private readonly handle: (input: BridgeRequest) => unknown,
  ) {
    this.server = createServer((socket) => {
      this.clients.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        this.clients.delete(socket);
        this.subscribers.delete(socket);
      });
      readFrames(socket, (value) => {
        let id = "";
        try {
          const input = parseBridgeRequest(value);
          id = input.id;
          if (input.method === "subscribe") {
            this.subscribers.add(socket);
            write(socket, { id, value: this.snapshot() });
          } else {
            write(socket, { id, value: this.handle(input) });
          }
        } catch (error) {
          write(socket, { id, error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
  }

  async listen(): Promise<void> {
    // 短路径回退位于 $TMPDIR 下的私有目录；目录缺失时创建，归属不符拒绝。
    ensureSocketDirectory(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.removeListener("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.socketPath);
    });
    chmodSync(this.socketPath, 0o600);
    this.server.on("error", () => {});
  }

  publish(): void {
    for (const socket of this.subscribers) {
      // 读得慢的客户端不能无限积累快照；超过单帧上限就断开。
      if (socket.writableLength > MAX_FRAME) socket.destroy();
      else write(socket, { event: "state", state: this.snapshot() });
    }
  }

  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    rmSync(this.socketPath, { force: true });
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 宿主侧 client：请求-响应带超时，订阅状态事件。 */
export class BridgeClient {
  private readonly pending = new Map<string, Pending>();
  private disposed = false;

  private constructor(
    private readonly socket: Socket,
    onState: (state: unknown) => void,
    onClose: () => void,
  ) {
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Rex worker 连接已断开；指令是否送达未知"));
      }
      this.pending.clear();
      if (!this.disposed) onClose();
    });
    readFrames(this.socket, (value) => {
      const frame = value as BridgeFrame;
      if ("event" in frame) {
        if (frame.event === "state") onState(frame.state);
        return;
      }
      const pending = this.pending.get(frame.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error !== undefined) pending.reject(new Error(frame.error));
      else pending.resolve(frame.value);
    });
  }

  /**
   * 连接 worker socket；启动早期 socket 尚未创建时短间隔重试。
   * 连接成功前不会发出任何控制请求。
   */
  static async connect(
    socketPath: string,
    onState: (state: unknown) => void,
    onClose: () => void,
    timeoutMs = 5_000,
  ): Promise<BridgeClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = connect(socketPath);
          const cleanup = (): void => {
            candidate.removeListener("connect", onConnect);
            candidate.removeListener("error", onError);
          };
          const onConnect = (): void => {
            cleanup();
            resolve(candidate);
          };
          const onError = (error: Error): void => {
            cleanup();
            candidate.destroy();
            reject(error);
          };
          candidate.once("connect", onConnect);
          candidate.once("error", onError);
        });
        return new BridgeClient(socket, onState, onClose);
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(
            `无法连接 Rex worker socket：${socketPath}（${error instanceof Error ? error.message : String(error)}）`,
          );
        }
        await sleep(50);
      }
    }
  }

  call(method: BridgeMethod, message?: string): Promise<unknown> {
    if (this.disposed || this.socket.destroyed) {
      return Promise.reject(new Error("Rex worker 已断开"));
    }
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Rex worker 请求超时；指令是否送达未知"));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      const frame = { id, method, ...(message === undefined ? {} : { message }) };
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME - 1) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Rex worker 指令超过单帧上限"));
        return;
      }
      write(this.socket, frame);
    });
  }

  close(): void {
    this.disposed = true;
    this.socket.destroy();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
