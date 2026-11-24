import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { knit, project } from "./helpers/cli.mjs";
import { git, gitProject } from "./helpers/git.mjs";
import { doneTask } from "./helpers/run.mjs";

const commitLines = (shown) => shown.stdout.split("\n").filter((line) => line.startsWith("提交:"));

test("在 Git 仓库里交付过的任务显示提交", (t) => {
  const dir = gitProject(t);
  const task = doneTask(dir);
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: 加问候语\n\n说明一行\n");
  const delivered = knit(dir, "deliver", task.id, "--authorization", "user:1a2b3c4d", "--message-file", message);
  assert.equal(delivered.code, 0, delivered.stderr);
  // 之后别的提交不影响查到的是哪一次。
  const commit = git(dir, "log", "-1", "--format=%h");
  writeFileSync(join(dir, "later.txt"), "later\n");
  git(dir, "add", "later.txt");
  git(dir, "commit", "-q", "-m", "later");

  const shown = knit(dir, "task", "show", task.id);

  assert.equal(shown.code, 0, shown.stderr);
  const lines = shown.stdout.split("\n");
  const at = lines.findIndex((line) => line.startsWith("目录:"));
  assert.equal(lines[at + 1], `提交: ${commit} feat: 加问候语`);
});

test("没有提交可以显示时没有这一行", (t) => {
  const plain = project(t);
  const delivered = doneTask(plain);
  assert.equal(knit(plain, "deliver", delivered.id, "--authorization", "user:1a2b3c4d").code, 0);
  const repository = gitProject(t);
  const done = doneTask(repository);

  const shown = [knit(plain, "task", "show", delivered.id), knit(repository, "task", "show", done.id)];

  assert.deepEqual(
    shown.map((result) => ({ code: result.code, commit: commitLines(result), stderr: result.stderr })),
    [
      { code: 0, commit: [], stderr: "" },
      { code: 0, commit: [], stderr: "" },
    ],
  );
  assert.match(shown[0].stdout, /^状态: delivered$/m);
});
