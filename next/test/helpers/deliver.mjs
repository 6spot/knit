import assert from "node:assert/strict";
import { knit } from "./cli.mjs";
import { git } from "./git.mjs";
import { readyTask } from "./run.mjs";

/** 建一个任务、确认，再记为完成（`paths` 是主会话登记的改动）；返回任务的 id 和目录。 */
export function doneTask(dir, paths = []) {
  const task = readyTask(dir, { verification: "self" });
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了", ...(paths.length > 0 ? ["--paths", ...paths] : []));
  assert.equal(closed.code, 0, closed.stderr);
  return task;
}

/** 让临时仓库里的提交不依赖机器上的 Git 配置：身份、签名和 hook 的位置都写在仓库自己的配置里。 */
export function gitIdentity(dir) {
  git(dir, "config", "user.name", "knit");
  git(dir, "config", "user.email", "knit@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", ".git/hooks");
}
