/**
 * 本机 Pi CLI AgentRuntime 最小实现（DESIGN.md 5.4–5.6、9.4）。
 * 复用本机客户端鉴权与模型配置；不导入 SDK，不另建模型运行时。
 * 缺能力显式报错，不用自动换模型或伪造成功补齐。
 */
import { randomUUID } from "node:crypto";
import { checkNativeSessionFile, type NativeFileCheck } from "./native-file.js";
import {
  PiConnectionClosedError,
  PiRpcConnection,
  type PiProcessExit,
  type PiRpcRecord,
  type PiRpcResponse,
} from "./connection.js";

export const PI_ADAPTER_VERSION = 1;

/** 启动后必须核对实际模型；仅字符串匹配 get_state 不算可用。 */
export interface ModelRequirement {
  provider: string;
  modelId: string;
}

export interface PiRuntimeOptions {
  executablePath: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  tools?: string[];
  /** 预分配原生 ID；不传则由 pi 生成（仍经 get_state 取回核实）。 */
  sessionId?: string;
  sessionName?: string;
  /** 追加系统约束；不注入业务状态机。 */
  appendSystemPrompt?: string;
  cwd: string;
  /** 稳定会话目录；跨 run 保存原生记录。 */
  sessionDir: string;
  /** 恢复指定的原生会话文件路径。 */
  sessionFile?: string;
  /** 恢复前可选预检结果；调用方也可自行调用 checkNativeSessionFile。 */
  env?: Record<string, string>;
}

export interface RuntimeStartCheck {
  ok: boolean;
  failure:
    | null
    | "connection_closed"
    | "set_model_rejected"
    | "model_mismatch"
    | "no_session_state";
  detail: string;
  nativeSessionId: string | null;
  sessionFile: string | null;
}

export interface SettledObservation {
  settled: boolean;
  aborted: boolean;
  exit: PiProcessExit | null;
}

const DEFAULT_OFFLINE_ENV: Record<string, string> = {
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};

/** 与本会话环境隔离，避免继承主会话的 PI_SESSION_ID／PI_MODEL 等。 */
export function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(DEFAULT_OFFLINE_ENV)) env[key] = value;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function baseArgs(options: PiRuntimeOptions): string[] {
  const args = [
    "--mode", "rpc",
    "--offline",
    "--no-mcp",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-extensions",
    "--no-approve",
    "--session-dir", options.sessionDir,
  ];
  if (options.tools !== undefined && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  } else {
    args.push("--no-tools");
  }
  args.push("--provider", options.provider, "--model", options.modelId);
  if (options.thinkingLevel !== undefined) args.push("--thinking", options.thinkingLevel);
  if (options.appendSystemPrompt !== undefined) args.push("--append-system-prompt", options.appendSystemPrompt);
  if (options.sessionFile !== undefined) {
    args.push("--session", options.sessionFile);
  } else {
    args.push("--session-id", options.sessionId ?? randomUUID());
    args.push("--name", options.sessionName ?? "Knit worker session");
  }
  return args;
}

export class PiAgentRuntime {
  private connection: PiRpcConnection | null = null;
  private settledSeen = false;
  private lastSettledAborted = false;
  private started = false;

  constructor(private readonly options: PiRuntimeOptions) {}

  /** 预分配的原生 ID（未显式给定时在 get_state 后回填）。 */
  nativeSessionId: string | null = null;
  sessionFile: string | null = null;

  get connectionForTests(): PiRpcConnection | null {
    return this.connection;
  }

  /** 本次进程 stderr 尾部与截断标志；启动失败诊断用，不作权威回执。 */
  get stderrDiagnostics(): { tail: string; truncated: boolean } {
    return this.connection?.stderrDiagnostics ?? { tail: "", truncated: false };
  }

  /** 已启动 Pi 进程的 PID；用于崩溃后核实并清理本次自有进程。 */
  get processId(): number | null {
    return this.connection?.pid ?? null;
  }

  private requireConnection(): PiRpcConnection {
    if (this.connection === null) {
      throw new Error("PiAgentRuntime 尚未 start；先调用 start()");
    }
    return this.connection;
  }

  async start(checkTimeoutMs = 30_000): Promise<RuntimeStartCheck> {
    if (this.started) throw new Error("PiAgentRuntime 已启动，不能重复 start");
    this.started = true;
    const connection = new PiRpcConnection(this.options.executablePath, baseArgs(this.options), {
      cwd: this.options.cwd,
      env: this.options.env ?? isolatedEnv(),
    });
    this.connection = connection;
    try {
      const state = await connection.call("get_state", {}, checkTimeoutMs);
      if (!state.success) {
        return this.failStart("no_session_state", `get_state 被拒绝: ${stringify(state.error)}`);
      }
      const data = (state.data ?? {}) as Record<string, unknown>;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : null;
      const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : null;
      if (sessionId === null) {
        return this.failStart("no_session_state", "get_state 未返回 sessionId");
      }
      this.nativeSessionId = sessionId;
      this.sessionFile = sessionFile;
      const model = (data.model ?? {}) as Record<string, unknown>;
      const actualProvider = typeof model.provider === "string" ? model.provider : null;
      const actualModelId = typeof model.id === "string" ? model.id : null;
      // 启动可接受未登记模型描述符：必须经 set_model 受校验核对，不能只比较字符串。
      const setModel = await connection.call(
        "set_model",
        { provider: this.options.provider, modelId: this.options.modelId },
        checkTimeoutMs,
      );
      if (!setModel.success) {
        return this.failStart("set_model_rejected", `set_model 被拒绝: ${stringify(setModel.error)}`);
      }
      if (actualProvider !== this.options.provider || actualModelId !== this.options.modelId) {
        return this.failStart(
          "model_mismatch",
          `get_state 模型 ${actualProvider}/${actualModelId} 与请求 ${this.options.provider}/${this.options.modelId} 不一致`,
        );
      }
      return {
        ok: true,
        failure: null,
        detail: "model verified via set_model",
        nativeSessionId: sessionId,
        sessionFile,
      };
    } catch (error) {
      if (error instanceof PiConnectionClosedError) {
        return this.failStart("connection_closed", `${error.message}；stderr: ${connection.diagnostics.trim()}`);
      }
      throw error;
    }
  }

  private failStart(failure: NonNullable<RuntimeStartCheck["failure"]>, detail: string): RuntimeStartCheck {
    return { ok: false, failure, detail, nativeSessionId: this.nativeSessionId, sessionFile: this.sessionFile };
  }

  events(): readonly PiRpcRecord[] {
    return this.requireConnection().events;
  }

  invalidFrames(): readonly string[] {
    return this.requireConnection().invalidFrames;
  }

  /** 提交 prompt；返回的 promise 在 agent_settled 或连接结束时解决，不接受单个响应作终态。 */
  async prompt(message: string, timeoutMs = 600_000): Promise<SettledObservation> {
    const connection = this.requireConnection();
    this.settledSeen = false;
    this.lastSettledAborted = false;
    void connection.call("prompt", { message }, timeoutMs).catch(() => {
      // prompt 响应失败或超时不代表模型已停止；终态以 agent_settled / exit 为准。
    });
    return this.waitSettled(timeoutMs);
  }

  /** 等待稳定终态；agent_settled 才算，agent_end 不算。 */
  async waitSettled(timeoutMs = 600_000): Promise<SettledObservation> {
    const connection = this.requireConnection();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = connection.events.findIndex(
        (event) => event.type === "agent_settled",
      );
      if (index >= 0) {
        const event = connection.events[index] as { aborted?: unknown };
        this.lastSettledAborted = event.aborted === true;
        this.settledSeen = true;
        return { settled: true, aborted: this.lastSettledAborted, exit: connection.exit };
      }
      if (connection.exit !== null) {
        return { settled: false, aborted: false, exit: connection.exit };
      }
      if (Date.now() > deadline) {
        return { settled: false, aborted: false, exit: null };
      }
      await sleep(50);
    }
  }

  get hasSettled(): boolean {
    return this.settledSeen;
  }

  /** 队列清理与中止；返回各控制请求的真实响应结果。 */
  async abort(): Promise<{ queueCleared: boolean; aborted: boolean }> {
    const connection = this.requireConnection();
    const clear = await safeCall(connection, "clear_queue");
    const stop = await safeCall(connection, "abort");
    return { queueCleared: clear?.success === true, aborted: stop?.success === true };
  }

  async getLastAssistantText(): Promise<string> {
    const response = await this.requireConnection().call("get_last_assistant_text");
    const data = (response.data ?? {}) as { text?: unknown };
    return typeof data.text === "string" ? data.text : "";
  }

  /** 只读历史；不向会话追加内容。 */
  async getMessages(): Promise<unknown[]> {
    const response = await this.requireConnection().call("get_messages");
    if (!response.success) return [];
    const data = (response.data ?? {}) as { messages?: unknown };
    return Array.isArray(data.messages) ? data.messages : [];
  }

  /** 累计会话统计；增量用量由调用方按 run 前后差值计算。 */
  async getStats(): Promise<Record<string, unknown> | null> {
    const response = await this.requireConnection().call("get_session_stats");
    if (!response.success) return null;
    return (response.data ?? null) as Record<string, unknown> | null;
  }

  async dispose(graceMs = 5_000): Promise<PiProcessExit | null> {
    const connection = this.connection;
    if (connection === null) return null;
    this.connection = null;
    if (connection.exit === null) {
      await safeCall(connection, "clear_queue");
      await safeCall(connection, "abort");
      connection.endStdin();
      const exited = await connection.waitExit(graceMs);
      if (exited === null) {
        connection.killProcessGroup("SIGTERM");
        const terminated = await connection.waitExit(3_000);
        if (terminated === null) {
          connection.killProcessGroup("SIGKILL");
          await connection.waitExit(3_000);
        }
      }
    }
    return connection.exit;
  }
}

async function safeCall(connection: PiRpcConnection, kind: string): Promise<PiRpcResponse | null> {
  try {
    return await connection.call(kind, {}, 10_000);
  } catch {
    return null;
  }
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { NativeFileCheck };
export { checkNativeSessionFile };
