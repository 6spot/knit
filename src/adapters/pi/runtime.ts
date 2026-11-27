/**
 * 本机 Pi CLI AgentRuntime 最小实现。
 * 复用本机客户端鉴权与模型配置；不导入 SDK，不另建模型运行时。
 * 缺能力显式报错，不用自动换模型或伪造成功补齐。
 */
import { executorEnv, MAIN_SESSION_KEYS } from "../../infrastructure/process.js";
import { randomUUID } from "node:crypto";
import type { ToolCapability } from "../../contracts/workflow.js";
import {
  PiConnectionClosedError,
  PiRpcConnection,
  type PiProcessExit,
  type PiRpcRecord,
} from "./connection.js";

export const PI_ADAPTER_VERSION = 1;

const PI_EXECUTOR_ENV = { KNIT_PI_EXECUTOR: "1" };

/** dispose 等待 stderr 流收敛的上限；超时保留已有尾部，不阻塞收尾。 */
const STDERR_SETTLE_TIMEOUT_MS = 1_000;

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
  /** 显式加载的扩展路径；仍可用 `--no-extensions` 阻止自动发现。 */
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
  eventLimit?: number;
  /** 为真时启动的是交互界面：不带 `--mode rpc`，也不带 `--no-themes`（界面要用户设置的主题）。 */
  interactive?: boolean;
}

export interface RuntimeStartCheck {
  ok: boolean;
  failure:
    | null
    | "spawn_failed"
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
  diagnostics?: string;
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

/**
 * 与本会话环境隔离，避免继承主会话的 PI_SESSION_ID／PI_MODEL 等。
 */
export function isolatedEnv(
  extra: Record<string, string> = {},
  options: { offline?: boolean } = {},
): Record<string, string> {
  const env = executorEnv();
  if (options.offline !== false) env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  return { ...env, ...extra, ...PI_EXECUTOR_ENV };
}

/** 构造 Pi RPC 参数；导出供能力→参数单测直接核对，不启动进程。 */
export function buildPiArgs(options: PiRuntimeOptions): string[] {
  const switches = capabilitySwitches(options.capabilities);
  const args = options.interactive
    ? ["--no-prompt-templates", "--no-approve"]
    : ["--mode", "rpc", "--no-prompt-templates", "--no-themes", "--no-approve"];
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

/**
 * 在别的程序给的环境里（例如 Rex 的窗格）启动交互界面的完整命令：环境变量没法直接传，
 * 所以写成 `/usr/bin/env -u … KEY=VALUE … pi 参数`，隔离的内容和 isolatedEnv 一样。
 */
export function interactivePiCommand(options: PiRuntimeOptions, extra: Record<string, string>): string[] {
  const env = { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...extra, ...PI_EXECUTOR_ENV };
  return [
    "/usr/bin/env",
    ...MAIN_SESSION_KEYS.flatMap((key) => ["-u", key]),
    ...(capabilitySwitches(options.capabilities).offline ? ["PI_OFFLINE=1"] : []),
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    options.executablePath,
    ...buildPiArgs({ ...options, interactive: true }),
  ];
}

export class PiAgentRuntime {
  private connection: PiRpcConnection | null = null;
  /** dispose 冻结的最终 stderr 快照；连接释放后仍可读（启动诊断用）。 */
  private stderrSnapshot: { tail: string; truncated: boolean } | null = null;
  /** 下一次 prompt 只观察它启动后的 agent_settled；之前的轮次不得冒充本次终态。 */
  private settledCursor = 0;
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
      eventLimit: this.options.eventLimit,
      env: this.options.env ? { ...this.options.env, ...PI_EXECUTOR_ENV } : isolatedEnv(undefined, { offline: switches.offline }),
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
      // 不一致还继续执行，会把成果写进错误的对象。
      if (this.options.sessionId !== undefined && sessionId !== this.options.sessionId) {
        return this.failStart(
          "session_identity_mismatch",
          `实际 sessionId ${sessionId} 与预期 ${this.options.sessionId} 不一致`,
        );
      }
      this.nativeSessionId = sessionId;
      this.sessionFile = sessionFile;
      const setModel = await connection.call("set_model", { provider: this.options.provider, modelId: this.options.modelId }, checkTimeoutMs);
      if (!setModel.success) {
        return this.failStart("set_model_rejected", `set_model 被拒绝: ${stringify(setModel.error)}`);
      }
      const effective = await connection.call("get_state", {}, checkTimeoutMs);
      if (!effective.success) return this.failStart("no_session_state", `get_state 被拒绝: ${stringify(effective.error)}`);
      const model = (effective.data as { model?: { provider?: unknown; id?: unknown } } | undefined)?.model;
      const actualProvider = model?.provider;
      const actualModelId = model?.id;
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
        if (connection.exit !== null) await connection.waitStderrClose(STDERR_SETTLE_TIMEOUT_MS);
        const { tail, truncated } = connection.stderrDiagnostics;
        const stderr = truncated ? `…(截断)${tail}` : tail;
        const extra = (error.cause ? stderr : connection.diagnostics).trim();
        return this.failStart(
          connection.pid === null ? "spawn_failed" : "connection_closed",
          extra ? `${error.message}；${extra}` : error.message,
        );
      }
      if (connection.diagnostics) throw new Error(`${String(error)}；${connection.diagnostics.trim()}`, { cause: error });
      throw error;
    }
  }

  private failStart(failure: NonNullable<RuntimeStartCheck["failure"]>, detail: string): RuntimeStartCheck {
    return { ok: false, failure, detail, nativeSessionId: this.nativeSessionId, sessionFile: this.sessionFile };
  }

  events(): readonly PiRpcRecord[] {
    return this.requireConnection().events;
  }

  /**
   * 提交 prompt；返回的 promise 在 agent_settled 或连接结束时解决，不接受单个响应作终态。
   * timeoutMs 仅控制单个 RPC 响应／观察等待，不是阶段总时限：传 null 表示无截止，
   * 终态只由 agent_settled、进程退出、abort 或连接失败决定。
   */
  async prompt(message: string, timeoutMs: number | null = null): Promise<SettledObservation> {
    const connection = this.requireConnection();
    this.settledCursor = connection.eventCount;
    const controller = new AbortController();
    const settled = connection.waitForSettled(this.settledCursor, timeoutMs, controller.signal);
    try {
      const response = connection.call("prompt", { message }, timeoutMs ?? 600_000);
      const first = await Promise.race([response, settled]).catch(() => settled);
      if (first && typeof first === "object" && !first.success) throw new Error(`prompt 被拒绝: ${stringify(first.error)}`);
      const aborted = await settled;
      if (aborted === null && connection.exit !== null) await connection.waitStderrClose(STDERR_SETTLE_TIMEOUT_MS);
      return { settled: aborted !== null, aborted: aborted === true, exit: connection.exit,
        ...(aborted === null && connection.diagnostics ? { diagnostics: connection.diagnostics } : {}) };
    } finally {
      controller.abort();
    }
  }

  /**
   * 最近一次 prompt 的最后一条助手消息是模型请求出错时，返回模型服务给的原因（可能是空的）；否则是 null。
   * 出错的消息没有文字，get_last_assistant_text 分不出它和“什么都没说”。
   */
  lastModelError(): string | null {
    return this.requireConnection().lastModelError(this.settledCursor);
  }

  async getLastAssistantText(): Promise<string> {
    const response = await this.requireConnection().call("get_last_assistant_text");
    if (!response.success) throw new Error(`get_last_assistant_text 被拒绝: ${stringify(response.error)}`);
    const data = (response.data ?? {}) as { text?: unknown };
    return typeof data.text === "string" ? data.text : "";
  }

  async dispose(graceMs = 5_000): Promise<PiProcessExit | null> {
    const connection = this.connection;
    if (connection === null) return null;
    this.connection = null;
    try {
      if (connection.pid !== null && connection.exit === null) {
        const clear = await connection.call("clear_queue", {}, 500).catch(() => null);
        if (clear?.success) await connection.call("abort", {}, 500).catch(() => null);
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

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}
