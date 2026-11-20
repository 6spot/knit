import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { parseTaskDocument } from "../dist/domain/task-document.js";
import { knit, project } from "./helpers/cli.mjs";
import { doneTask } from "./helpers/deliver.mjs";
import { readyTask } from "./helpers/run.mjs";

const AUTHORIZATION = "交付要有用户的授权：加 --authorization <引用>，写明用户是在哪条消息里同意的\n";
const now = new Date();
const archived = (task) =>
  `.knit/tasks/archive/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(task.dir)}`;
const filesOf = (dir, taskDir) => ["task.md", "record.json"].map((name) => readFileSync(join(dir, taskDir, name), "utf8"));
const resultOf = (run) => ({ code: run.code, stdout: run.stdout, stderr: run.stderr });

[false, true].forEach((autoMerge) => test(`不在 Git 仓库里交付一个完成的任务（autoMerge=${autoMerge}）`, (t) => {
  const dir = project(t);
  writeFileSync(join(dir, ".knit/config.json"), JSON.stringify({ worktree: { autoMerge } }));
  const task = doneTask(dir, ["src/a.ts"]);
  const [taskBefore, recordBefore] = filesOf(dir, task.dir);

  const delivered = knit(dir, "deliver", task.id, "--authorization", " user:1a2b3c4d ");

  assert.deepEqual(resultOf(delivered), {
    code: 0,
    stdout: `已交付 ${task.id}\n归档: ${archived(task)}\n提交: 这个项目不在 Git 仓库里，没有提交\n`,
    stderr: "",
  });
  assert.equal(existsSync(join(dir, task.dir)), false);
  const [taskAfter, recordAfter] = filesOf(dir, archived(task));
  const before = parseTaskDocument(taskBefore).document;
  assert.deepEqual(parseTaskDocument(taskAfter).document, {
    ...before,
    frontmatter: { ...before.frontmatter, status: "delivered" },
  });
  assert.deepEqual(JSON.parse(recordAfter), { ...JSON.parse(recordBefore), authorization: "user:1a2b3c4d" });
  assert.equal(knit(dir, "task", "list").stdout, "没有任务\n");
  assert.match(knit(dir, "task", "list", "--archive").stdout, new RegExp(`${task.id}  delivered  加问候语`));
}));

test("不能交付时什么都不变", (t) => {
  const dir = project(t);
  const ready = readyTask(dir);
  const done = doneTask(dir);
  const before = [...filesOf(dir, ready.dir), ...filesOf(dir, done.dir)];

  assert.deepEqual(resultOf(knit(dir, "deliver", ready.id, "--authorization", "user:1a2b3c4d")), {
    code: 1,
    stdout: "",
    stderr: `任务 ${ready.id} 还没有完成（ready）；完成之后再交付：knit task close ${ready.id}\n`,
  });
  assert.deepEqual(resultOf(knit(dir, "deliver", done.id)), { code: 1, stdout: "", stderr: AUTHORIZATION });
  assert.deepEqual(resultOf(knit(dir, "deliver", done.id, "--authorization", "  ")), {
    code: 1,
    stdout: "",
    stderr: AUTHORIZATION,
  });
  assert.deepEqual([...filesOf(dir, ready.dir), ...filesOf(dir, done.dir)], before);
});
