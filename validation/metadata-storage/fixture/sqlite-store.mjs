/**
 * SQLite 版 MetadataStore（隔离比较夹具，非产品实现）。
 * 用 Node24 内置 node:sqlite（本机 v24.21.0 无 ExperimentalWarning）。
 * 单文件库；sessions/bindings/operations/runs/entry_ranges 各一张表；
 * withTransaction 用 BEGIN IMMEDIATE 短事务；乐观版本检查走行级 CAS（UPDATE WHERE version）。
 * PRAGMA：journal_mode=WAL、synchronous=NORMAL、busy_timeout 见构造参数。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export class SqliteMetadataStore {
  constructor(root, { busyTimeoutMs = 2_000 } = {}) {
    mkdirSync(root, { recursive: true });
    this.root = root;
    this.db = new DatabaseSync(join(root, "metadata.db"), { timeout: busyTimeoutMs });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        client TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (client, native_session_id, role)
      );
      CREATE TABLE IF NOT EXISTS bindings (
        task_id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        state TEXT NOT NULL,
        request TEXT,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS entry_ranges (
        run_id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
    `);
    this.inTx = false;
  }

  sessions = {
    register: (ref, record) => {
      this.db
        .prepare("INSERT OR REPLACE INTO sessions (client, native_session_id, role, record) VALUES (?, ?, ?, ?)")
        .run(ref.client, ref.nativeSessionId, ref.role, JSON.stringify({ ref, ...record }));
    },
    setStatus: (ref, status, reason = null) => {
      const row = this.sessions.get(ref);
      if (row === null) throw new Error(`session not found: ${ref.nativeSessionId}`);
      const updated = { ...row, status, reason, recordedAt: new Date().toISOString() };
      this.db
        .prepare("UPDATE sessions SET record = ? WHERE client = ? AND native_session_id = ? AND role = ?")
        .run(JSON.stringify(updated), ref.client, ref.nativeSessionId, ref.role);
    },
    get: (ref) => {
      const row = this.db
        .prepare("SELECT record FROM sessions WHERE client = ? AND native_session_id = ? AND role = ?")
        .get(ref.client, ref.nativeSessionId, ref.role);
      return row === undefined ? null : JSON.parse(row.record);
    },
  };

  bindings = {
    get: (taskId) => {
      const row = this.db.prepare("SELECT record, version FROM bindings WHERE task_id = ?").get(taskId);
      return row === undefined ? null : { ...JSON.parse(row.record), version: row.version };
    },
    save: (binding) => {
      // 版本存列不存正文；正文剥离 version 字段，避免两处权威。
      const { version, ...record } = binding;
      this.db
        .prepare("INSERT INTO bindings (task_id, record, version) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET record = excluded.record, version = excluded.version")
        .run(binding.taskId, JSON.stringify(record), version ?? 0);
    },
    list: () =>
      this.db
        .prepare("SELECT record FROM bindings ORDER BY task_id")
        .all()
        .map((row) => JSON.parse(row.record)),
  };

  operations = {
    get: (operationId) => {
      const row = this.db.prepare("SELECT record FROM operations WHERE operation_id = ?").get(operationId);
      return row === undefined ? null : JSON.parse(row.record);
    },
    save: (operation) => {
      this.db
        .prepare("INSERT OR REPLACE INTO operations (operation_id, record) VALUES (?, ?)")
        .run(operation.operationId, JSON.stringify(operation));
    },
    setState: (operationId, state, reason = null) => {
      const row = this.operations.get(operationId);
      if (row === null) throw new Error(`operation not found: ${operationId}`);
      const updated = { ...row, state, reason, recordedAt: new Date().toISOString() };
      this.db.prepare("UPDATE operations SET record = ? WHERE operation_id = ?").run(JSON.stringify(updated), operationId);
    },
  };

  runs = {
    create: (requestId, request) => {
      this.db
        .prepare("INSERT OR IGNORE INTO runs (run_id, request_id, state, request) VALUES (?, ?, 'prepared', ?)")
        .run(requestId, requestId, JSON.stringify(request));
    },
    getState: (runId) => {
      const row = this.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(runId);
      return row === undefined ? null : row.state;
    },
    setState: (runId, state) => {
      const info = this.db.prepare("UPDATE runs SET state = ? WHERE run_id = ?").run(state, runId);
      if (info.changes === 0) throw new Error(`run not found: ${runId}`);
    },
    getResult: (runId) => {
      const row = this.db.prepare("SELECT result FROM runs WHERE run_id = ?").get(runId);
      return row === undefined || row.result === null ? null : JSON.parse(row.result);
    },
    acceptResult: (runId, result) => {
      // 终态只裁定一次：UPDATE 带 result IS NULL 条件，rows affected 决定成败。
      const info = this.db
        .prepare("UPDATE runs SET result = ?, state = ? WHERE run_id = ? AND result IS NULL")
        .run(JSON.stringify(result), result.state, runId);
      return info.changes === 1;
    },
    getStatus: (runId) => this.runs.getState(runId),
  };

  entryRanges = {
    setRange: (runId, range) => {
      this.db
        .prepare("INSERT OR REPLACE INTO entry_ranges (run_id, record) VALUES (?, ?)")
        .run(runId, JSON.stringify(range));
    },
    getRange: (runId) => {
      const row = this.db.prepare("SELECT record FROM entry_ranges WHERE run_id = ?").get(runId);
      return row === undefined ? null : JSON.parse(row.record);
    },
  };

  /**
   * node:sqlite 是同步 API，但调用方工作流是 async：必须 await 回调让
   * BEGIN IMMEDIATE 真正跨越整个事务体；否则写入落在 COMMIT 之后的隐式自动提交里。
   */
  async withTransaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = await fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已由驱动自动回滚（如 SQLITE_BUSY on BEGIN）。
      }
      throw error;
    }
  }

  /**
   * 乐观版本检查：读 version 列，CAS UPDATE WHERE version = expected。
   * 读取在写事务里：BEGIN IMMEDIATE 已挡住并发写者，读到的版本不会被中途改掉。
   */
  async executeStoreTransaction(expectedVersion, mutate) {
    return await this.withTransaction(async () => {
      const row = this.db.prepare("SELECT version FROM bindings WHERE task_id = ?").get("task-1");
      const currentVersion = row === undefined ? 0 : row.version;
      if (currentVersion !== expectedVersion) return false;
      const binding = row === undefined ? null : this.bindings.get("task-1");
      await mutate(this, binding);
      if (row === undefined) {
        this.db.prepare("INSERT INTO bindings (task_id, record, version) VALUES (?, ?, 1)").run("task-1", JSON.stringify({ taskId: "task-1" }));
      } else {
        const info = this.db
          .prepare("UPDATE bindings SET version = version + 1 WHERE task_id = ? AND version = ?")
          .run("task-1", expectedVersion);
        if (info.changes !== 1) return false;
      }
      return true;
    });
  }

  close() {
    this.db.close();
  }

  /** 故障注入：事务中途崩溃（模拟 WAL 中途死进程）。 */
  crashInsideTransaction() {
    this.withTransaction(() => {
      this.db.prepare("INSERT INTO bindings (task_id, record, version) VALUES (?, ?, 0)").run("crash-marker", "{}");
      process.exit(9);
    });
  }
}
