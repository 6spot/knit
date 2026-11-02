/**
 * 内部基础设施契约：原子写、锁、进程、Git 与时钟。
 * POSIX 首版；测试可注入 fake 实现。
 */
import type { DeterministicOperation, OperationState, TaskBinding } from "../contracts/metadata.js";
import type { StandardsReview } from "../contracts/standards.js";
import type { NativeSessionRef, SelectionSnapshot, SessionKind, SessionRecord, SessionStatus } from "../contracts/session.js";

/** 原子写单文件：锁内准备、写临时、同步、rename、同步目录；跨文件系统不降级。 */
export interface AtomicFileWriter {
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

/** 短临界区锁；不跨模型调用、工具等待或 hooks。 */
export interface LockStore {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** 进程身份与进程组；返回事实，不推断业务状态。 */
export interface ProcessPort {
  spawn(command: string, args: string[], options: {
    cwd: string;
    env?: Record<string, string>;
  }): Promise<ManagedProcess>;
  /** 等待进程退出；返回真实退出码与信号，不吞异常终态。 */
  wait(process: ManagedProcess): Promise<{ exitCode: number | null; signal: string | null }>;
  killProcessGroup(process: ManagedProcess, signal: string): Promise<void>;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

/** 原生 Git CLI 调用；argv 传参，不经 shell 拼接。 */
export interface GitPort {
  run(args: string[], options: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** 单调时钟；用于占用与耗时，不用墙钟替代。 */
export interface Clock {
  nowMs(): number;
}

/** Session 索引查询条件；省略字段表示不限制。 */
export interface SessionQuery {
  taskId?: string;
  client?: "pi";
  kind?: SessionKind;
  parentSessionId?: string;
  status?: SessionStatus;
}

/** MetadataStore：本机索引的短事务入口；物理后端（原子文件或 SQLite）由任务004决定。 */
export interface MetadataStore {
  sessions: {
    /** 按（客户端、原生 ID、角色）登记或更新完整索引记录。 */
    save(record: SessionRecord): Promise<void>;
    setStatus(ref: NativeSessionRef, status: SessionStatus, reason?: string | null): Promise<void>;
    get(ref: NativeSessionRef): Promise<SessionRecord | null>;
    getByKnitId(knitSessionId: string): Promise<SessionRecord | null>;
    list(query?: SessionQuery): Promise<SessionRecord[]>;
    /** 主会话选择快照的原子更新；清除用 taskId=null 的快照。 */
    setSelection(knitSessionId: string, selection: SelectionSnapshot | null): Promise<void>;
  };
  bindings: {
    get(taskId: string): Promise<TaskBinding | null>;
    /** 全量绑定；正式规范变化时机械找出冻结摘要不一致的任务。 */
    list(): Promise<TaskBinding[]>;
    save(binding: TaskBinding): Promise<void>;
  };
  standardsReviews: {
    save(review: StandardsReview): Promise<void>;
    list(taskId: string): Promise<StandardsReview[]>;
    /** 最近一次审阅回执；没有时返回 null。 */
    latest(taskId: string): Promise<StandardsReview | null>;
  };
  operations: {
    get(operationId: string): Promise<DeterministicOperation | null>;
    /** 全量操作记录；交付／归档按 taskId 查找最近一次。 */
    list(): Promise<DeterministicOperation[]>;
    save(operation: DeterministicOperation): Promise<void>;
    setState(operationId: string, state: OperationState, reason?: string | null): Promise<void>;
  };
  /** 同一后端内的短事务；不跨模型调用、工具等待或 hooks。 */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}
