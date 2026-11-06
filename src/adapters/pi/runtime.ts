/**
 * 本机 Pi CLI AgentRuntime 最小实现（DESIGN.md 5.4–5.6、9.4）。
 * 复用本机客户端鉴权与模型配置；不导入 SDK，不另建模型运行时。
 * 缺能力显式报错，不用自动换模型或伪造成功补齐。
 */
import { randomUUID } from "node:crypto";
import { checkNativeSessionFile, type NativeFileCheck } from "./native-file.js";
import type { ToolCapability } from "../../contracts/workflow.js";
import {
  PiConnectionClosedError,
  PiRpcConnection,
  type PiProcessExit,
  type PiRpcRecord,
  type PiRpcResponse,
} from "./connection.js";

export const PI_ADAPTER_VERSION = 1;

/** dispose 等待 stderr 流收敛的上限；超时保留已有尾部，不阻塞收尾。 */
const STDERR_SETTLE_TIMEOUT_MS = 1_000;

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
  /** 工具 allowlist；null 表示不限制（全部放开），空数组表示不给工具。 */
  tools?: string[] | null;
  /** 只增不删的工具名（external 场景保留扩展工具时使用）。 */
  toolAdditions?: string[];
  /** 明确排除的内置工具（external 场景限制内置工具）。 */
  excludeTools?: string[];
  /** 生效能力白名单；null 表示全部放开，缺省按旧行为收紧。 */
  capabilities?: readonly ToolCapability[] | null;
  /** 显式加载的扩展路径（task 能力用）；仍可用 `--no-extensions` 阻止自动发现。 */
  extensionPaths?: string[];
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
    | "no_session_state"
    | "session_identity_mismatch";
  detail: string;
  nativeSessionId: string | null;
  sessionFile: string | null;
}

export interface SettledObservation {
  settled: boolean;
  aborted: boolean;
  exit: PiProcessExit | null;
}

/** 能力 → Pi 启动开关（设计 §7）：external 放开扩展／MCP／技能，network 放开离线限制。 */
export interface PiCapabilitySwitches {
  offline: boolean;
  extensions: boolean;
  mcp: boolean;
  skills: boolean;
}

export function capabilitySwitches(
  capabilities: readonly ToolCapability[] | null | undefined,
): PiCapabilitySwitches {
  if (capabilities === null) {
    return { offline: false, extensions: true, mcp: true, skills: true };
  }
  const list = capabilities ?? [];
  const external = list.includes("external");
  return {
    offline: !list.includes("network"),
    extensions: external,
    mcp: external,
    skills: external,
  };
}

/** 与本会话环境隔离，避免继承主会话的 PI_SESSION_ID／PI_MODEL 等。 */
export function isolatedEnv(
  extra: Record<string, string> = {},
  options: { offline?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
    "PI_OFFLINE",
  ]) {
    delete env[key];
  }
  if (options.offline !== false) env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/** 构造 Pi RPC 参数；导出供能力→参数单测直接核对，不启动进程。 */
export function buildPiArgs(options: PiRuntimeOptions): string[] {
  const switches = capabilitySwitches(options.capabilities);
  const args = [
    "--mode", "rpc",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
  ];
  if (switches.offline) args.push("--offline");
  if (!switches.mcp) args.push("--no-mcp");
  if (!switches.skills) args.push("--no-skills");
  if (!switches.extensions) args.push("--no-extensions");
  for (const extensionPath of options.extensionPaths ?? []) {
    args.push("--extension", extensionPath);
  }
  args.push("--session-dir", options.sessionDir);
  if (options.toolAdditions !== undefined && options.toolAdditions.length > 0) {
    // 只增项保留扩展／自定义工具的默认选择，不把工具面收窄成 allowlist。
    args.push("--tools", options.toolAdditions.map((name) => `+${name}`).join(","));
  } else if (options.tools === null) {
    // 全部放开：不传 --tools，也不传 --no-tools。
  } else if (options.tools !== undefined && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  } else {
    args.push("--no-tools");
  }
  if (options.excludeTools !== undefined && options.excludeTools.length > 0) {
    args.push("--exclude-tools", options.excludeTools.join(","));
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
  /** dispose 冻结的最终 stderr 快照；连接释放后仍可读（启动诊断用）。 */
  private stderrSnapshot: { tail: string; truncated: boolean } | null = null;
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
    return this.connection?.stderrDiagnostics ?? this.stderrSnapshot ?? { tail: "", truncated: false };
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
    const switches = capabilitySwitches(this.options.capabilities);
    const connection = new PiRpcConnection(this.options.executablePath, buildPiArgs(this.options), {
      cwd: this.options.cwd,
      env: this.options.env ?? isolatedEnv(undefined, { offline: switches.offline }),
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
      // 启动身份核对：恢复（--session）与预分配（--session-id）都要求实际 ID 与预期一致；
      // 不一致带错误会话锁继续执行会把成果写进错误对象（任务035）。
      if (this.options.sessionId !== undefined && sessionId !== this.options.sessionId) {
        return this.failStart(
          "session_identity_mismatch",
          `实际 sessionId ${sessionId} 与预期 ${this.options.sessionId} 不一致`,
        );
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

  /**
   * 提交 prompt；返回的 promise 在 agent_settled 或连接结束时解决，不接受单个响应作终态。
   * timeoutMs 仅控制单个 RPC 响应／观察等待，不是阶段总时限（任务034）：传 null 表示无截止，
   * 终态只由 agent_settled、进程退出、abort 或连接失败决定。
   */
  async prompt(message: string, timeoutMs: number | null = null): Promise<SettledObservation> {
    const connection = this.requireConnection();
    this.settledSeen = false;
    this.lastSettledAborted = false;
    void connection.call("prompt", { message }, timeoutMs ?? 600_000).catch(() => {
      // prompt 响应失败或超时不代表模型已停止；终态以 agent_settled / exit 为准。
    });
    return this.waitSettled(timeoutMs);
  }

  /** 等待稳定终态；agent_settled 才算，agent_end 不算。timeoutMs 为 null 时无截止（任务034）。 */
  async waitSettled(timeoutMs: number | null = null): Promise<SettledObservation> {
    const connection = this.requireConnection();
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
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
      if (deadline !== null && Date.now() > deadline) {
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
    try {
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
      // 进程退出不等于 stderr 已读完：有界等待流收敛后再冻结快照，避免诊断读到空尾部。
      await connection.waitStderrClose(STDERR_SETTLE_TIMEOUT_MS);
      return connection.exit;
    } finally {
      // 超时也保留已有尾部；释放连接后 stderrDiagnostics 返回该快照，不为空。
      this.stderrSnapshot = connection.snapshotStderr();
    }
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
