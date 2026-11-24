import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "../infrastructure/process.js";
import { RUNS_DIR } from "../contracts/task.js";

function taskLockPath(root: string, taskId: string): string {
  return join(root, dirname(RUNS_DIR), `${taskId}.lock`);
}

export function withTaskRunLock<T>(root: string, taskId: string, timeout: number, action: () => T, busy: () => T): T {
  return withFileLock(taskLockPath(root, taskId), timeout, action, busy);
}

export function taskRunLockHeld(root: string, taskId: string): boolean {
  const path = taskLockPath(root, taskId);
  return existsSync(path) && withFileLock(path, 0, () => false, () => true, true);
}
