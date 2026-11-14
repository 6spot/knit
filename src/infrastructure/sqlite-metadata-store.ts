/**
 * SQLite 版 MetadataStore（任务004 选定的生产实现）。
 * 用 Node24 内置 node:sqlite（本机 v24.21.0 无 ExperimentalWarning；Node>=22.5）。
 * 单文件库 + WAL；sessions/bindings/operations 各一张表，记录为 JSON 正文；
 * withTransaction 用 BEGIN IMMEDIATE 短事务覆盖多记录关联更新，不持事务等待模型／工具／hooks。
 * 并发由 SQLite 单写者保证：竞争者在 timeout 内等待，超时报 ERR_SQLITE_ERROR busy，由调用方重试。
 * 文件版实现保留在 validation/metadata-storage/fixture/ 作为比较夹具，不参与产品。
 */
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { enforcePrivateDatabase, ensurePrivateDir } from "./private-mode.js";
import type {
  DeterministicOperation,
  OperationState,
  TaskBinding,
} from "../contracts/metadata.js";
import type {
  NativeSessionRef,
  SelectionSnapshot,
  SessionRecord,
  SessionStatus,
} from "../contracts/session.js";
import { PROJECT_SCOPE, type StandardsReview } from "../contracts/standards.js";
import type { MetadataStore, SessionQuery } from "../ports/infrastructure.js";

export interface SqliteMetadataStoreOptions {
  /** BEGIN IMMEDIATE 竞争等待上限（毫秒）；超时抛错，不静默重试。 */
  timeoutMs?: number;
  /** 只读查询：不建目录、不迁移、不写 WAL；用于 status/doctor/storage。 */
  readOnly?: boolean;
}

/** TEXT 列严格读取；类型不符视为库结构损坏，不静默转换。 */
function textColumn(value: unknown, column: string): string {
  if (typeof value !== "string") throw new Error(`column ${column} is not TEXT`);
  return value;
}

export class SqliteMetadataStore implements MetadataStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, options: SqliteMetadataStoreOptions = {}) {
    if (options.readOnly === true) {
      this.db = new DatabaseSync(databasePath, { readOnly: true, timeout: options.timeoutMs ?? 2_000 });
      return;
    }
    // 运行目录与数据库及其 sidecar 保持本用户私有：目录 0700、文件 0600（任务040）。
    ensurePrivateDir(dirname(databasePath));
    this.db = new DatabaseSync(databasePath, { timeout: options.timeoutMs ?? 2_000 });
    enforcePrivateDatabase(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        client TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        record TEXT NOT NULL,
        knit_session_id TEXT,
        kind TEXT,
        task_id TEXT,
        parent_session_id TEXT,
        PRIMARY KEY (client, native_session_id, role)
      );
      CREATE INDEX IF NOT EXISTS sessions_task ON sessions (task_id);
      CREATE INDEX IF NOT EXISTS sessions_knit ON sessions (knit_session_id);
      CREATE TABLE IF NOT EXISTS bindings (
        task_id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS standards_reviews (
        review_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS standards_reviews_task ON standards_reviews (task_id);
    `);
    // 旧库升级：早期版本只有 (client, native_session_id, role, record)。
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(sessions)").all() as { name?: unknown }[]).map((row) =>
        typeof row.name === "string" ? row.name : "",
      ),
    );
    for (const [name, type] of [
      ["knit_session_id", "TEXT"],
      ["kind", "TEXT"],
      ["task_id", "TEXT"],
      ["parent_session_id", "TEXT"],
    ] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_task ON sessions (task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_knit ON sessions (knit_session_id)");
  }

  sessions = {
    save: (record: SessionRecord): Promise<void> => {
      this.db
        .prepare(
          `INSERT INTO sessions (client, native_session_id, role, record, knit_session_id, kind, task_id, parent_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(client, native_session_id, role) DO UPDATE SET
             record = excluded.record,
             knit_session_id = excluded.knit_session_id,
             kind = excluded.kind,
             task_id = excluded.task_id,
             parent_session_id = excluded.parent_session_id`,
        )
        .run(
          record.ref.client,
          record.ref.nativeSessionId,
          record.ref.role,
          JSON.stringify(record),
          record.knitSessionId,
          record.kind,
          record.taskId,
          record.parentSessionId,
        );
      return Promise.resolve();
    },

    setStatus: (ref: NativeSessionRef, status: SessionStatus, reason?: string | null): Promise<void> => {
      const current = this.sessionsGet(ref);
      if (current === null) throw new Error(`session not found: ${ref.nativeSessionId}`);
      return this.sessions.save({
        ...current,
        status,
        reason: reason ?? null,
        recordedAt: new Date().toISOString(),
      });
    },

    get: (ref: NativeSessionRef): Promise<SessionRecord | null> =>
      Promise.resolve(this.sessionsGet(ref)),

    getByKnitId: (knitSessionId: string): Promise<SessionRecord | null> => {
      const row = this.db
        .prepare("SELECT record FROM sessions WHERE knit_session_id = ?")
        .get(knitSessionId);
      return Promise.resolve(
        row === undefined ? null : (JSON.parse(textColumn(row.record, "sessions.record")) as SessionRecord),
      );
    },

    list: (query: SessionQuery = {}): Promise<SessionRecord[]> => {
      const clauses: string[] = [];
      const params: string[] = [];
      if (query.taskId !== undefined) {
        clauses.push("task_id = ?");
        params.push(query.taskId);
      }
      if (query.client !== undefined) {
        clauses.push("client = ?");
        params.push(query.client);
      }
      if (query.kind !== undefined) {
        clauses.push("kind = ?");
        params.push(query.kind);
      }
      if (query.parentSessionId !== undefined) {
        clauses.push("parent_session_id = ?");
        params.push(query.parentSessionId);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db
        .prepare(`SELECT record FROM sessions${where} ORDER BY knit_session_id`)
        .all(...params) as { record?: unknown }[];
      const records = rows.map(
        (row) => JSON.parse(textColumn(row.record, "sessions.record")) as SessionRecord,
      );
      return Promise.resolve(
        query.status === undefined ? records : records.filter((record) => record.status === query.status),
      );
    },

    setSelection: (knitSessionId: string, selection: SelectionSnapshot | null): Promise<void> => {
      const row = this.db
        .prepare("SELECT record FROM sessions WHERE knit_session_id = ?")
        .get(knitSessionId);
      if (row === undefined) throw new Error(`session not found: ${knitSessionId}`);
      const current = JSON.parse(textColumn(row.record, "sessions.record")) as SessionRecord;
      const updated: SessionRecord = { ...current, selection, recordedAt: new Date().toISOString() };
      return this.sessions.save(updated);
    },
  };

  bindings = {
    get: (taskId: string): Promise<TaskBinding | null> => {
      const row = this.db.prepare("SELECT record FROM bindings WHERE task_id = ?").get(taskId);
      return Promise.resolve(row === undefined ? null : (JSON.parse(textColumn(row.record, "bindings.record")) as TaskBinding));
    },

    list: (): Promise<TaskBinding[]> => Promise.resolve(this.bindings.listSync()),

    listSync: (): TaskBinding[] => {
      const rows = this.db.prepare("SELECT record FROM bindings ORDER BY task_id").all() as { record?: unknown }[];
      return rows.map((row) => JSON.parse(textColumn(row.record, "bindings.record")) as TaskBinding);
    },

    save: (binding: TaskBinding): Promise<void> => {
      this.db
        .prepare(
          "INSERT INTO bindings (task_id, record) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET record = excluded.record",
        )
        .run(binding.taskId, JSON.stringify(binding));
      return Promise.resolve();
    },
  };

  operations = {
    get: (operationId: string): Promise<DeterministicOperation | null> => {
      const row = this.db.prepare("SELECT record FROM operations WHERE operation_id = ?").get(operationId);
      return Promise.resolve(
        row === undefined
          ? null
          : (JSON.parse(textColumn(row.record, "operations.record")) as DeterministicOperation),
      );
    },

    list: (): Promise<DeterministicOperation[]> => {
      const rows = this.db.prepare("SELECT record FROM operations ORDER BY rowid").all() as Array<{ record: unknown }>;
      return Promise.resolve(
        rows.map((row) => JSON.parse(textColumn(row.record, "operations.record")) as DeterministicOperation),
      );
    },

    save: (operation: DeterministicOperation): Promise<void> => {
      this.db
        .prepare("INSERT OR REPLACE INTO operations (operation_id, record) VALUES (?, ?)")
        .run(operation.operationId, JSON.stringify(operation));
      return Promise.resolve();
    },

    setState: (operationId: string, state: OperationState, reason?: string | null): Promise<void> => {
      const current = this.operationsGet(operationId);
      if (current === null) throw new Error(`operation not found: ${operationId}`);
      const updated: DeterministicOperation = {
        ...current,
        state,
        reason: reason ?? null,
        recordedAt: new Date().toISOString(),
      };
      this.db
        .prepare("UPDATE operations SET record = ? WHERE operation_id = ?")
        .run(JSON.stringify(updated), operationId);
      return Promise.resolve();
    },
  };

  standardsReviews = {
    save: (review: StandardsReview): Promise<void> => {
      // 新回执是项目作用域；旧任务回执保留 task_id 以兼容读取与按任务过滤。
      const scopeKey = review.taskId ?? PROJECT_SCOPE;
      this.db
        .prepare(
          "INSERT INTO standards_reviews (review_id, task_id, record) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET task_id = excluded.task_id, record = excluded.record",
        )
        .run(review.reviewId, scopeKey, JSON.stringify(review));
      return Promise.resolve();
    },

    list: (taskId: string): Promise<StandardsReview[]> => {
      const rows = this.db
        .prepare("SELECT record FROM standards_reviews WHERE task_id = ? ORDER BY review_id")
        .all(taskId) as { record?: unknown }[];
      return Promise.resolve(
        rows.map((row) => JSON.parse(textColumn(row.record, "standards_reviews.record")) as StandardsReview),
      );
    },

    latest: (taskId: string): Promise<StandardsReview | null> => {
      // reviewId 是随机稳定 ID，不表达时间顺序；按记录时间取最近回执。
      const rows = this.db
        .prepare("SELECT record FROM standards_reviews WHERE task_id = ?")
        .all(taskId) as { record?: unknown }[];
      const records = rows.map(
        (row) => JSON.parse(textColumn(row.record, "standards_reviews.record")) as StandardsReview,
      );
      records.sort(
        (a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.reviewId.localeCompare(a.reviewId),
      );
      return Promise.resolve(records[0] ?? null);
    },
  };

  /** BEGIN IMMEDIATE 短事务：多记录关联更新同提交同回滚；await 期间保持写锁。 */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = await fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已由驱动自动回滚（如 BEGIN 时 SQLITE_BUSY）。
      }
      throw error;
    }
  }

  /** 关闭连接；-wal/-shm 由 SQLite 正常关闭时收敛。 */
  close(): void {
    this.db.close();
  }

  private sessionsGet(ref: NativeSessionRef): SessionRecord | null {
    const row = this.db
      .prepare("SELECT record FROM sessions WHERE client = ? AND native_session_id = ? AND role = ?")
      .get(ref.client, ref.nativeSessionId, ref.role);
    return row === undefined ? null : (JSON.parse(textColumn(row.record, "sessions.record")) as SessionRecord);
  }

  private operationsGet(operationId: string): DeterministicOperation | null {
    const row = this.db.prepare("SELECT record FROM operations WHERE operation_id = ?").get(operationId);
    return row === undefined
      ? null
      : (JSON.parse(textColumn(row.record, "operations.record")) as DeterministicOperation);
  }
}
