import assert from "node:assert/strict";
import { knit } from "./cli.mjs";
import { readyTask } from "./run.mjs";

/** 建一个任务、确认，再记为完成（`paths` 是主会话登记的改动）；返回任务的 id 和目录。 */
export function doneTask(dir, paths = []) {
  const task = readyTask(dir, { verification: "self" });
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了", ...(paths.length > 0 ? ["--paths", ...paths] : []));
  assert.equal(closed.code, 0, closed.stderr);
  return task;
}
