/**
 * 文件版 MetadataStore（隔离比较夹具，非产品实现）。
 * 结构：每记录一个 JSON 文件（sessions／bindings／operations／runs／entry-ranges），
 * withTransaction 用 store 根级锁文件串行化整个事务，记录写入为临时文件 + 同目录 rename。
 * 与 SQLite 版共用同一 store-contract 套件与场景脚本。
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_RETRY_MS = 25;
const LOCK_RETRY_LIMIT = 400;
// 惰性读取：ESM 导入顺序下驱动脚本可能在加载后才设置测试短窗。
function lockStaleMs() {
  return Number(process.env.KNIT_FIXTURE_LOCK_STALE_MS ?? 15_000);
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * 根级互斥：O_EXCL 锁文件 + 过期接管（mtime 超过 LOCK_STALE_MS 视为持有者已死）。
 * 与 SQLite 版的 BEGIN IMMEDIATE 对应：同一时刻只允许一个事务写。
 */
export class FileLock {
  constructor(path) {
    this.path = path;
  }

  async acquire() {
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(this.path, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        await handle.close();
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let info = null;
        try {
          info = JSON.parse(await readFile(this.path, "utf8"));
        } catch {
          info = null;
        }
        let fileStat = null;
        try {
          fileStat = await stat(this.path);
        } catch {
          fileStat = null;
        }
        const stale = fileStat !== null && Date.now() - fileStat.mtimeMs > lockStaleMs();
        if (stale) {
          // 过期锁接管；同名 rename 只有接管者成功，其余重试。
          const stealPath = `${this.path}.steal-${process.pid}`;
          try {
            await rename(this.path, stealPath);
            await rm(stealPath, { force: true });
          } catch {
            // 别的进程先接管了，继续等待。
          }
          continue;
        }
        if (attempt >= LOCK_RETRY_LIMIT) {
          throw new Error(`file lock busy: ${this.path} (holder=${info ? info.pid : "?"})`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  async release() {
    await rm(this.path, { force: true });
  }
}

export class FileMetadataStore {
  constructor(root) {
    this.root = root;
    this.lock = new FileLock(join(root, "store.lock"));
    this.closed = false;
  }

  #file(...parts) {
    return join(this.root, ...parts);
  }

  #sessionFile(ref) {
    // ref 三元组唯一；文件名保留完整身份，不再另加短 ID。
    return this.#file("sessions", `${ref.client}--${ref.nativeSessionId}--${ref.role}.json`);
  }

  #bindingFile(taskId) {
    return this.#file("bindings", `${taskId}.json`);
  }

  #operationFile(operationId) {
    return this.#file("operations", `${operationId}.json`);
  }

  #runDir(runId) {
    return this.#file("runs", runId);
  }

  #entryRangeFile(runId) {
    return this.#file("entry-ranges", `${runId}.json`);
  }

  async #readJson(file) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeJson(file, value) {
    await mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, JSON.stringify(value, null, 2));
  }

  sessions = {
    register: async (ref, record) => {
      await this.#writeJson(this.#sessionFile(ref), { ref, ...record });
    },
    setStatus: async (ref, status, reason = null) => {
      const file = this.#sessionFile(ref);
      const current = await this.#readJson(file);
      if (current === null) throw new Error(`session not found: ${ref.nativeSessionId}`);
      await this.#writeJson(file, { ...current, status, reason, recordedAt: new Date().toISOString() });
    },
    get: async (ref) => this.#readJson(this.#sessionFile(ref)),
  };

  bindings = {
    get: async (taskId) => this.#readJson(this.#bindingFile(taskId)),
    save: async (binding) => {
      await this.#writeJson(this.#bindingFile(binding.taskId), binding);
    },
    list: async () => {
      let names = [];
      try {
        names = await readdirSafe(this.#file("bindings"));
      } catch {
        return [];
      }
      const bindings = [];
      for (const name of names) {
        if (name.endsWith(".json")) {
          const value = await this.#readJson(this.#file("bindings", name));
          if (value !== null) bindings.push(value);
        }
      }
      return bindings;
    },
  };

  operations = {
    get: async (operationId) => this.#readJson(this.#operationFile(operationId)),
    save: async (operation) => {
      await this.#writeJson(this.#operationFile(operation.operationId), operation);
    },
    setState: async (operationId, state, reason = null) => {
      const file = this.#operationFile(operationId);
      const current = await this.#readJson(file);
      if (current === null) throw new Error(`operation not found: ${operationId}`);
      await this.#writeJson(file, { ...current, state, reason, recordedAt: new Date().toISOString() });
    },
  };

  runs = {
    create: async (requestId, request) => {
      const dir = this.#runDir(requestId);
      const stateFile = join(dir, "state.json");
      const existing = await this.#readJson(stateFile);
      if (existing !== null) return; // create 幂等：重复返回既有 run，不另执行。
      await this.#writeJson(stateFile, { runId: requestId, requestId, state: "prepared", ...request });
    },
    getState: async (runId) => {
      const value = await this.#readJson(join(this.#runDir(runId), "state.json"));
      return value === null ? null : value.state;
    },
    setState: async (runId, state) => {
      const file = join(this.#runDir(runId), "state.json");
      const current = await this.#readJson(file);
      if (current === null) throw new Error(`run not found: ${runId}`);
      await this.#writeJson(file, { ...current, state });
    },
    getResult: async (runId) => this.#readJson(join(this.#runDir(runId), "result.json")),
    acceptResult: async (runId, result) => {
      const file = join(this.#runDir(runId), "result.json");
      const existing = await this.#readJson(file);
      if (existing !== null) return false; // 终态只裁定一次。
      await this.#writeJson(file, result);
      await this.#writeJson(join(this.#runDir(runId), "state.json"), { runId, requestId: runId, state: result.state });
      return true;
    },
    getStatus: async (runId) => {
      const value = await this.#readJson(join(this.#runDir(runId), "state.json"));
      return value === null ? null : value.state;
    },
  };

  entryRanges = {
    setRange: async (runId, range) => {
      await this.#writeJson(this.#entryRangeFile(runId), range);
    },
    getRange: async (runId) => this.#readJson(this.#entryRangeFile(runId)),
  };

  /** 文件版事务 = 根级锁内执行全部读写；不持锁做外部副作用（由调用契约约束）。 */
  async withTransaction(fn) {
    await this.lock.acquire();
    try {
      return await fn();
    } finally {
      await this.lock.release();
    }
  }

  /**
   * 乐观版本检查：锁内读当前 binding，比对 expectedVersion 后写入 nextVersion+1。
   * 文件方案没有行级 CAS，正确性完全依赖根级锁覆盖读与写。
   */
  async executeStoreTransaction(expectedVersion, mutate) {
    await this.lock.acquire();
    try {
      const binding = await this.bindings.get("task-1");
      const currentVersion = binding === null ? 0 : binding.version ?? 0;
      if (currentVersion !== expectedVersion) return false;
      await mutate(this, binding);
      // mutate 负责正文；这里重读当前记录只叠加版本号，不用开始时的旧快照覆写。
      const after = (await this.bindings.get("task-1")) ?? { taskId: "task-1" };
      await this.bindings.save({ ...after, version: currentVersion + 1 });
      return true;
    } finally {
      await this.lock.release();
    }
  }

  async close() {
    this.closed = true;
  }

  /** 故障注入：事务中途崩溃（模拟持有锁的进程死亡）。 */
  async crashInsideTransaction() {
    await this.lock.acquire();
    await this.bindings.save({ taskId: "crash-marker", lastRunIds: [] });
    process.exit(9);
  }
}

async function readdirSafe(dir) {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
