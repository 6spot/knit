/**
 * 内部能力契约（ARCHITECTURE.md 第4节）。
 * 端口只声明能力；文件、Git、进程和原生客户端副作用留在适配与基础设施。
 * 这些是内部代码契约，不是对外插件 SDK。
 */
import type { NativeEntryRange, RunPhase, RunResult, RunStatus, RunState } from "../contracts/run.js";
import type { NativeSessionRef, SessionRole, SessionStatus } from "../contracts/session.js";
import type { DeterministicOperation, OperationState, TaskBinding } from "../contracts/metadata.js";

export * from "./infrastructure.js";

/** 原生阶段会话引用的登记与状态推进；状态枚举见 SessionStatus。 */
export interface SessionRefPort {
  register(ref: NativeSessionRef, taskId: string | null, runId: string | null): Promise<void>;
  setStatus(ref: NativeSessionRef, status: SessionStatus, reason?: string | null): Promise<void>;
  getStatus(ref: NativeSessionRef): Promise<SessionStatus>;
  findCurrent(role: SessionRole, taskId: string): Promise<NativeSessionRef | null>;
}

/** 绑定的读取与更新；至多一份待应用草案在应用时才并入，不在端口假设存在。 */
export interface BindingPort {
  get(taskId: string): Promise<TaskBinding | null>;
  save(binding: TaskBinding): Promise<void>;
  list(): Promise<TaskBinding[]>;
}

/**
 * 操作意图与状态；步骤证据留在实现。
 * 恢复按 before/after 核验结果推进，本端口只保存状态与理由。
 */
export interface OperationPort {
  get(operationId: string): Promise<DeterministicOperation | null>;
  save(operation: DeterministicOperation): Promise<void>;
  setState(operationId: string, state: OperationState, reason?: string | null): Promise<void>;
}

/** run 请求与执行回执；终态不覆写。 */
export interface RunPort {
  create(requestId: string, request: { taskId: string; phase: RunPhase }): Promise<void>;
  getState(runId: string): Promise<RunState | null>;
  setState(runId: string, state: RunState): Promise<void>;
  getResult(runId: string): Promise<RunResult | null>;
  /** 只接受首个合法终态；重复接收同 ID 返回 false，不视为错误。 */
  acceptResult(result: RunResult): Promise<boolean>;
  getStatus(runId: string): Promise<RunStatus | null>;
}

/** 本机原生会话的原生条目范围登记；取不到的端点保存 null。 */
export interface NativeEntryRangePort {
  setRange(runId: string, range: NativeEntryRange): Promise<void>;
  getRange(runId: string): Promise<NativeEntryRange | null>;
}
