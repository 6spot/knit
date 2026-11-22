import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNS_DIR } from "../contracts/task.js";

function taskLockPath(root: string, taskId: string): string {
  return join(root, dirname(RUNS_DIR), `${taskId}.lock`);
}

export function withTaskRunLock<T>(root: string, taskId: string, timeout: number, action: () => T, busy: () => T): T {
  return withRunLock(taskLockPath(root, taskId), timeout, action, busy);
}

export function taskRunLockHeld(root: string, taskId: string): boolean {
  const path = taskLockPath(root, taskId);
  return existsSync(path) && withRunLock(path, 0, () => false, () => true, true);
}

/** SQLite 的文件锁随进程退出释放，派发、结算和共享钩子按各自的资源路径互斥。 */
export function withRunLock<T>(path: string, timeout: number, action: () => T, busy: () => T, readOnly = false): T {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const lock = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(path, { timeout, readOnly });
  try {
    // 读取数据库头即可观察排他锁，在只读检出中也能查询进程状态。
    lock.exec(readOnly ? "PRAGMA user_version" : "BEGIN EXCLUSIVE");
    return action();
  } catch (error) {
    if (error instanceof Error && "errcode" in error && error.errcode === 5) return busy(); // SQLITE_BUSY
    throw error;
  } finally {
    lock.close();
  }
}
