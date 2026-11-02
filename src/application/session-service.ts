/**
 * SessionService：统一主／子会话身份、当前任务选择与原生引用核实（DESIGN.md 第9节、STATES.md 第7节）。
 * 索引只存定位、选择、关系与可确认的指令信息；原始历史仍在所属客户端。
 * 原生有效路径是选择权威，索引快照只作经核实的投影；未落盘只记待确认。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  newKnitSessionId,
  type SessionKind,
  type SessionRecord,
  type SessionRole,
  type SessionSource,
  type SessionStatus,
  type SelectionSnapshot,
} from "../contracts/session.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import {
  checkNativeSessionFile,
  findNativeSessionFile,
  findStoredSessionFile,
  type NativeFileCheck,
} from "../adapters/pi/native-file.js";
import {
  readActiveEntryIds,
  readCustomEntries,
  readEntrySummaries,
  type NativeEntrySummary,
} from "../adapters/pi/native-entries.js";
import { GuardError } from "./guard-error.js";
import { locateTaskDocument } from "./task-service.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { LockManager } from "../infrastructure/locks.js";
import type { MetadataStore, SessionQuery } from "../ports/infrastructure.js";

/** 主会话选择事件的原生自定义条目类型（桥接写入同一类型）。 */
export const SELECTION_ENTRY_TYPE = "knit.selection";

export interface SelectionEventData {
  taskId: string | null;
  branch: string | null;
  operationId: string;
}

export interface SessionServiceOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  /** Pi 配置根；默认 ~/.pi/agent。测试注入临时目录。 */
  agentDir?: string;
  checkFile?: (filePath: string, expectedNativeId: string) => Promise<NativeFileCheck>;
  readActive?: typeof readActiveEntryIds;
  readCustom?: typeof readCustomEntries;
  readHistory?: typeof readEntrySummaries;
}

export interface SessionAttachInput {
  dir: string;
  nativeSessionId?: string;
  kind: SessionKind;
  role: SessionRole;
  taskId?: string | null;
  branch?: string | null;
  /** 已知原生记录位置；缺省按 cwd + 原生 ID 查找稳定路径。 */
  sessionFile?: string | null;
  parentKnitSessionId?: string | null;
  source?: SessionSource | null;
  runId?: string | null;
  checkpoint?: string | null;
  /** 主会话已有选择快照（桥接恢复时带入）；未落盘必须 persisted=false。 */
  selection?: SelectionSnapshot | null;
}

export interface SessionAttachResult {
  record: SessionRecord;
  /** 本次是否新分配 Knit Session ID。 */
  created: boolean;
  /** 原生记录可读取但身份不符等问题的稳定原因。 */
  problem: string | null;
}

export interface SessionSelectionInput {
  dir: string;
  knitSessionId: string;
  taskId: string;
  operationId?: string;
  branch?: string | null;
  /** 桥接已写入并核实原生条目时的条目引用。 */
  entryRef?: string | null;
  /** true 表示条目已落盘并核实；false 只记待确认。 */
  persisted: boolean;
}

export interface SessionClearInput {
  dir: string;
  knitSessionId: string;
  operationId?: string;
  branch?: string | null;
  entryRef?: string | null;
  persisted: boolean;
}

export interface SessionSelectionResult {
  knitSessionId: string;
  selection: SelectionSnapshot;
  /** 已落盘才生效；未落盘返回 null，不宣称已保存选择。 */
  effectiveTaskId: string | null;
}

export interface SelectionResolution {
  knitSessionId: string;
  taskId: string | null;
  branch: string | null;
  /** native：当前有效路径上的选择事件；index：仅索引快照（不可作为权威）。 */
  source: "native" | "index";
  effective: boolean;
  entryRef: string | null;
  snapshotMatches: boolean | null;
  reason: string | null;
}

export interface SessionHistoryResult {
  knitSessionId: string;
  sessionFile: string | null;
  problem: string | null;
  entries: NativeEntrySummary[];
}

export class SessionService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;
  private readonly agentDir: string;
  private readonly checkFile: (filePath: string, expectedNativeId: string) => Promise<NativeFileCheck>;
  private readonly readActive: typeof readActiveEntryIds;
  private readonly readCustom: typeof readCustomEntries;
  private readonly readHistory: typeof readEntrySummaries;

  constructor(options: SessionServiceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
    this.agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
    this.checkFile = options.checkFile ?? checkNativeSessionFile;
    this.readActive = options.readActive ?? readActiveEntryIds;
    this.readCustom = options.readCustom ?? readCustomEntries;
    this.readHistory = options.readHistory ?? readEntrySummaries;
  }

  private sessionLockKey(record: Pick<SessionRecord, "ref">) {
    // 锁保护实际原生记录资源，跨项目同一原生 ID 仍互斥；不用会随 fallback 改变的目录。
    return { scope: "session" as const, rawKey: `${record.ref.client}:${record.ref.nativeSessionId}` };
  }

  private async requireSession(knitSessionId: string): Promise<SessionRecord> {
    const record = await this.store.sessions.getByKnitId(knitSessionId);
    if (record === null) throw new GuardError("session_not_found", `会话不存在: ${knitSessionId}`);
    return record;
  }

  /** 按原生身份与角色取记录（角色不同是不同对象，不互相覆盖）。 */
  private async byNative(client: "pi", nativeSessionId: string, role: SessionRole): Promise<SessionRecord | null> {
    return this.store.sessions.get({ client, nativeSessionId, role });
  }

  /**
   * 登记会话：预分配原生 ID、稳定 Knit Session ID 与记录位置，核实原生状态。
   * opening 期间参数／指令就绪即可首轮调用；available 只表示可恢复。
   */
  async attach(input: SessionAttachInput): Promise<SessionAttachResult> {
    const root = normalizeRoot(input.dir);
    const nativeSessionId = input.nativeSessionId ?? randomUUID();
    const existing = await this.byNative("pi", nativeSessionId, input.role);
    if (existing !== null && normalizeRoot(existing.cwd) !== root) {
      throw new GuardError(
        "project_conflict",
        `原生会话 ${nativeSessionId} 已登记在 ${existing.cwd}，不能在 ${root} 复用`,
      );
    }
    if (input.kind === "sub") {
      // 活跃主会话文件不得被 worker 复用（STATES.md 第7节）。
      const mainRecords = await this.store.sessions.list({ client: "pi", kind: "main" });
      const reused = mainRecords.find((record) => record.ref.nativeSessionId === nativeSessionId);
      if (reused !== undefined) {
        throw new GuardError("main_session_reuse", `子会话不能复用主会话原生文件: ${nativeSessionId}`);
      }
      if (existing !== null && existing.kind !== "sub") {
        throw new GuardError("role_conflict", `原生会话 ${nativeSessionId} 已登记为 ${existing.kind}`);
      }
      if (input.parentKnitSessionId === undefined || input.parentKnitSessionId === null) {
        throw new GuardError("parent_required", "子会话必须登记父 Session");
      }
      const parent = await this.store.sessions.getByKnitId(input.parentKnitSessionId);
      if (parent === null) throw new GuardError("parent_not_found", `父会话不存在: ${input.parentKnitSessionId}`);
    }
    if (input.kind === "main" && input.parentKnitSessionId != null) {
      throw new GuardError("parent_not_allowed", "主会话不能带父 Session");
    }
    if (existing !== null && existing.kind !== input.kind) {
      throw new GuardError("role_conflict", `原生会话 ${nativeSessionId} 已登记为 ${existing.kind}`);
    }
    if (input.taskId != null) this.assertTaskUsable(root, input.taskId);

    const sessionFile =
      input.sessionFile ?? findStoredSessionFile(root, nativeSessionId, this.agentDir);
    const verification = await this.verifyNative(
      sessionFile,
      nativeSessionId,
      existing?.sessionFile !== null && existing?.sessionFile !== undefined,
    );
    const knitSessionId = existing?.knitSessionId ?? newKnitSessionId(this.randomHex);
    const now = this.now().toISOString();
    const record: SessionRecord = {
      knitSessionId,
      protocolVersion: PROTOCOL_VERSION,
      ref: { client: "pi", nativeSessionId, role: input.role },
      kind: input.kind,
      status: verification.status,
      sessionFile,
      parentSessionId: input.parentKnitSessionId ?? null,
      source: input.source ?? null,
      taskId: input.taskId ?? null,
      branch: input.branch ?? null,
      runId: input.runId ?? null,
      cwd: root,
      checkpoint: input.checkpoint ?? null,
      selection: input.kind === "main" ? (input.selection ?? null) : null,
      reason: verification.reason,
      lastVerifiedAt: verification.checked ? now : null,
      nativeReadable: verification.readable,
      relatedRunState: null,
      recordedAt: now,
    };
    await this.store.sessions.save(record);
    return { record, created: existing === null, problem: verification.problem };
  }

  private async verifyNative(
    sessionFile: string | null,
    nativeSessionId: string,
    previouslyPersisted: boolean,
  ): Promise<{ status: SessionStatus; reason: string | null; readable: boolean; checked: boolean; problem: string | null }> {
    if (sessionFile === null) {
      return {
        status: previouslyPersisted ? "missing" : "opening",
        reason: previouslyPersisted ? "native_file_missing" : "native_file_not_persisted",
        readable: false,
        checked: false,
        problem: null,
      };
    }
    const check = await this.checkFile(sessionFile, nativeSessionId);
    if (!check.exists) {
      return {
        status: previouslyPersisted ? "missing" : "opening",
        reason: previouslyPersisted ? "native_file_missing" : "native_file_not_persisted",
        readable: false,
        checked: true,
        problem: null,
      };
    }
    if (check.problem === null) {
      return { status: "available", reason: null, readable: true, checked: true, problem: null };
    }
    if (check.problem === "id_mismatch") {
      return {
        status: "incompatible",
        reason: "native_id_mismatch",
        readable: false,
        checked: true,
        problem: check.problem,
      };
    }
    if (check.problem === "unreadable") {
      return { status: "missing", reason: "native_unreadable", readable: false, checked: true, problem: check.problem };
    }
    return {
      status: "incompatible",
      reason: `native_${check.problem}`,
      readable: false,
      checked: true,
      problem: check.problem,
    };
  }

  /** 只读核实：重新定位原生记录并更新可用性；不改写原生历史。 */
  async verify(knitSessionId: string, sessionFileOverride?: string | null): Promise<SessionRecord> {
    const record = await this.requireSession(knitSessionId);
    const lock = await this.locks.acquire({
      keys: [this.sessionLockKey(record)],
      action: "session.verify",
    });
    try {
      const sessionFile =
        sessionFileOverride ?? record.sessionFile ?? findStoredSessionFile(record.cwd, record.ref.nativeSessionId, this.agentDir);
      const verification = await this.verifyNative(
        sessionFile,
        record.ref.nativeSessionId,
        record.sessionFile !== null,
      );
      const updated: SessionRecord = {
        ...record,
        sessionFile,
        status: verification.status,
        reason: verification.reason,
        nativeReadable: verification.readable,
        lastVerifiedAt: verification.checked ? this.now().toISOString() : record.lastVerifiedAt,
        recordedAt: this.now().toISOString(),
      };
      await this.store.sessions.save(updated);
      return updated;
    } finally {
      this.locks.release(lock);
    }
  }

  async list(query: SessionQuery = {}): Promise<SessionRecord[]> {
    return this.store.sessions.list(query);
  }

  private assertTaskUsable(root: string, taskId: string): void {
    let located;
    try {
      located = locateTaskDocument(root, taskId);
    } catch {
      throw new GuardError("unknown_task", `任务不存在: ${taskId}`);
    }
    if (located.archived) throw new GuardError("task_archived", `任务已归档: ${taskId}`);
  }

  private async writeSelection(
    record: SessionRecord,
    selection: SelectionSnapshot,
  ): Promise<SessionSelectionResult> {
    const lock = await this.locks.acquire({
      keys: [this.sessionLockKey(record)],
      action: "session.selection",
    });
    try {
      await this.store.sessions.setSelection(record.knitSessionId, selection);
      const updated: SessionRecord = {
        ...record,
        selection,
        taskId: selection.persisted ? selection.taskId : record.taskId,
        branch: selection.branch,
        recordedAt: this.now().toISOString(),
      };
      await this.store.sessions.save(updated);
    } finally {
      this.locks.release(lock);
    }
    return {
      knitSessionId: record.knitSessionId,
      selection,
      effectiveTaskId: selection.persisted ? selection.taskId : null,
    };
  }

  /**
   * 主会话选择任务：条目已落盘并核实（persisted=true + entryRef）才生效；
   * 否则只记待确认，不宣称已保存选择（DESIGN.md 第9.1节）。
   */
  async useTask(input: SessionSelectionInput): Promise<SessionSelectionResult> {
    const root = normalizeRoot(input.dir);
    const record = await this.requireSession(input.knitSessionId);
    if (record.kind !== "main") {
      throw new GuardError("selection_requires_main_session", "只有主会话保存任务选择；子会话使用绑定");
    }
    if (normalizeRoot(record.cwd) !== root) {
      throw new GuardError("project_conflict", `会话登记在 ${record.cwd}，与 ${root} 不一致`);
    }
    this.assertTaskUsable(root, input.taskId);
    if (input.persisted && (input.entryRef === undefined || input.entryRef === null)) {
      throw new GuardError("entry_ref_required", "条目已落盘时必须给出原生条目引用");
    }
    const selection: SelectionSnapshot = {
      taskId: input.taskId,
      branch: input.branch ?? record.branch,
      entryRef: input.persisted ? (input.entryRef ?? null) : null,
      operationId: input.operationId ?? `sel-${this.randomHex(6)}`,
      recordedAt: this.now().toISOString(),
      persisted: input.persisted,
      pendingReason: input.persisted ? null : "native_entry_not_persisted",
    };
    return this.writeSelection(record, selection);
  }

  /** 清除选择：追加空选择事件；未落盘同样只待确认，不能让更早选择复活。 */
  async clearTask(input: SessionClearInput): Promise<SessionSelectionResult> {
    const root = normalizeRoot(input.dir);
    const record = await this.requireSession(input.knitSessionId);
    if (record.kind !== "main") {
      throw new GuardError("selection_requires_main_session", "只有主会话保存任务选择；子会话使用绑定");
    }
    if (normalizeRoot(record.cwd) !== root) {
      throw new GuardError("project_conflict", `会话登记在 ${record.cwd}，与 ${root} 不一致`);
    }
    if (input.persisted && (input.entryRef === undefined || input.entryRef === null)) {
      throw new GuardError("entry_ref_required", "条目已落盘时必须给出原生条目引用");
    }
    const selection: SelectionSnapshot = {
      taskId: null,
      branch: input.branch ?? record.branch,
      entryRef: input.persisted ? (input.entryRef ?? null) : null,
      operationId: input.operationId ?? `sel-${this.randomHex(6)}`,
      recordedAt: this.now().toISOString(),
      persisted: input.persisted,
      pendingReason: input.persisted ? null : "native_entry_not_persisted",
    };
    return this.writeSelection(record, selection);
  }

  /**
   * 从当前原生有效路径恢复选择并校验：树切换后旧条目不在路径上则不复活；
   * 临时 cwd／项目不一致时不误选；索引快照与原生事件不一致时以原生为准。
   */
  async resolveSelection(dir: string, knitSessionId: string): Promise<SelectionResolution> {
    const root = normalizeRoot(dir);
    const record = await this.requireSession(knitSessionId);
    if (record.kind !== "main") {
      throw new GuardError("selection_requires_main_session", "只有主会话保存任务选择；子会话使用绑定");
    }
    const snapshot = record.selection;
    if (normalizeRoot(record.cwd) !== root) {
      return {
        knitSessionId,
        taskId: null,
        branch: null,
        source: "index",
        effective: false,
        entryRef: null,
        snapshotMatches: null,
        reason: "cwd_mismatch",
      };
    }
    const sessionFile =
      record.sessionFile ?? findStoredSessionFile(record.cwd, record.ref.nativeSessionId, this.agentDir);
    if (sessionFile === null || !existsSync(sessionFile)) {
      return {
        knitSessionId,
        taskId: null,
        branch: null,
        source: "index",
        effective: false,
        entryRef: null,
        snapshotMatches: null,
        reason: snapshot?.persisted === true ? "native_file_missing" : "native_file_not_persisted",
      };
    }
    const active = await this.readActive(sessionFile);
    if (active.problem !== null) {
      return {
        knitSessionId,
        taskId: null,
        branch: null,
        source: "index",
        effective: false,
        entryRef: null,
        snapshotMatches: null,
        reason: `native_${active.problem}`,
      };
    }
    const scan = await this.readCustom(sessionFile, SELECTION_ENTRY_TYPE);
    if (scan.problem !== null) {
      return {
        knitSessionId,
        taskId: null,
        branch: null,
        source: "index",
        effective: false,
        entryRef: null,
        snapshotMatches: null,
        reason: `native_${scan.problem}`,
      };
    }
    const activeSet = new Set(active.activeIds);
    const onPath = scan.entries.filter((entry) => activeSet.has(entry.entryId));
    const last = onPath.at(-1);
    if (last === undefined) {
      const staleEntry =
        snapshot !== null && snapshot.entryRef !== null && !activeSet.has(snapshot.entryRef);
      return {
        knitSessionId,
        taskId: null,
        branch: null,
        source: "index",
        effective: false,
        entryRef: null,
        snapshotMatches: null,
        reason: staleEntry
          ? "selection_entry_not_on_active_path"
          : snapshot !== null && !snapshot.persisted
            ? "selection_not_persisted"
            : "no_selection_event",
      };
    }
    const data = this.selectionData(last.data);
    if (data === null) {
      return {
        knitSessionId,
        taskId: null,
        branch: null,
        source: "native",
        effective: false,
        entryRef: last.entryId,
        snapshotMatches: null,
        reason: "malformed_selection_entry",
      };
    }
    let taskId = data.taskId;
    let reason: string | null = null;
    if (taskId !== null) {
      try {
        this.assertTaskUsable(root, taskId);
      } catch {
        reason = "task_not_available";
        taskId = null;
      }
    }
    const snapshotMatches =
      snapshot === null
        ? null
        : snapshot.taskId === data.taskId &&
          snapshot.entryRef === last.entryId &&
          snapshot.operationId === data.operationId;
    const updated: SelectionSnapshot = {
      taskId: data.taskId,
      branch: data.branch,
      entryRef: last.entryId,
      operationId: data.operationId,
      recordedAt: this.now().toISOString(),
      persisted: true,
      pendingReason: null,
    };
    await this.store.sessions.save({
      ...record,
      sessionFile,
      selection: updated,
      taskId,
      branch: data.branch,
      recordedAt: this.now().toISOString(),
    });
    return {
      knitSessionId,
      taskId,
      branch: data.branch,
      source: "native",
      effective: taskId !== null,
      entryRef: last.entryId,
      snapshotMatches,
      reason,
    };
  }

  private selectionData(data: unknown): SelectionEventData | null {
    if (typeof data !== "object" || data === null) return null;
    const typed = data as { taskId?: unknown; branch?: unknown; operationId?: unknown };
    if (typed.taskId !== null && typeof typed.taskId !== "string") return null;
    if (typed.branch !== undefined && typed.branch !== null && typeof typed.branch !== "string") return null;
    if (typeof typed.operationId !== "string" || typed.operationId === "") return null;
    return {
      taskId: (typed.taskId as string | null) ?? null,
      branch: (typed.branch as string | null | undefined) ?? null,
      operationId: typed.operationId,
    };
  }

  /** 只读历史摘要：不复制正文、不修改原生文件；未知格式如实报告限制。 */
  async history(knitSessionId: string, limit: number | null = null): Promise<SessionHistoryResult> {
    const record = await this.requireSession(knitSessionId);
    const sessionFile =
      record.sessionFile ?? findStoredSessionFile(record.cwd, record.ref.nativeSessionId, this.agentDir);
    if (sessionFile === null) {
      return { knitSessionId, sessionFile: null, problem: "native_file_not_persisted", entries: [] };
    }
    const scan = await this.readHistory(sessionFile, limit);
    return { knitSessionId, sessionFile, problem: scan.problem, entries: scan.entries };
  }
}
