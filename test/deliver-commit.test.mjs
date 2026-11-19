import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { knit, project } from "./helpers/cli.mjs";
import { doneTask, gitIdentity } from "./helpers/deliver.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";
import { readyTask } from "./helpers/run.mjs";

const now = new Date();
const archived = (task) =>
  `.knit/tasks/archive/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(task.dir)}`;
const resultOf = (run) => ({ code: run.code, stdout: run.stdout, stderr: run.stderr });
const deliver = (dir, task, ...rest) => knit(dir, "deliver", task.id, "--authorization", "user:1a2b3c4d", ...rest);

/** 文案写在项目外面，不算工作区里的改动。 */
function messageFile(t, text) {
  const dir = project(t);
  writeFileSync(join(dir, "message.txt"), text);
  return join(dir, "message.txt");
}

test("只提交这个任务的文件", (t) => {
  const dir = gitProject(t);
  gitIdentity(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "src/c.ts"), "c\n");
  const task = doneTask(dir, ["src/a.ts", "src/b.ts"]);
  commitAll(dir, "task");
  writeFileSync(join(dir, "src/a.ts"), "a2\n");
  writeFileSync(join(dir, "src/b.ts"), "b\n");
  writeFileSync(join(dir, "src/c.ts"), "c2\n");
  git(dir, "add", "src/c.ts");
  writeFileSync(join(dir, "other.txt"), "other\n");
  const head = git(dir, "rev-parse", "HEAD");

  const delivered = deliver(dir, task, "--message-file", messageFile(t, "\nfeat: 加问候语\n\n# 说明一行\n\n"));

  assert.deepEqual(resultOf(delivered), {
    code: 0,
    stdout: `已交付 ${task.id}\n归档: ${archived(task)}\n提交: ${git(dir, "rev-parse", "--short", "HEAD")} feat: 加问候语\n`,
    stderr: "",
  });
  assert.equal(git(dir, "rev-parse", "HEAD~1"), head);
  assert.deepEqual(git(dir, "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort(), [
    `A\t${archived(task)}/record.json`,
    `A\t${archived(task)}/task.md`,
    "A\tsrc/b.ts",
    `D\t${task.dir}/record.json`,
    `D\t${task.dir}/task.md`,
    "M\tsrc/a.ts",
  ]);
  assert.match(git(dir, "show", `HEAD:${archived(task)}/task.md`), /^status: delivered$/m);
  assert.equal(git(dir, "log", "-1", "--format=%B"), `feat: 加问候语\n\n# 说明一行\n\nKnit-Task: ${task.id}`);
  assert.equal(git(dir, "status", "--porcelain"), "M  src/c.ts\n?? other.txt");
});

test("用 git mv 移动过的文件", (t) => {
  const dir = gitProject(t);
  gitIdentity(dir);
  mkdirSync(join(dir, "d"));
  writeFileSync(join(dir, "d/a.md"), "a\n");
  const task = readyTask(dir, { verification: "self" });
  commitAll(dir, "task");
  mkdirSync(join(dir, "e"));
  git(dir, "mv", "d/a.md", "e/a.md");
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了", "--paths", "d/a.md", "e/a.md");
  assert.equal(closed.code, 0, closed.stderr);

  const delivered = deliver(dir, task, "--message-file", messageFile(t, "feat: 移动文件\n"));

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.match(delivered.stdout, /^已交付 /m);
  assert.deepEqual(git(dir, "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort(), [
    `A\t${archived(task)}/record.json`,
    `A\t${archived(task)}/task.md`,
    "A\te/a.md",
    `D\t${task.dir}/record.json`,
    `D\t${task.dir}/task.md`,
    "D\td/a.md",
  ]);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("用 git rm 删除的文件", (t) => {
  const dir = gitProject(t);
  gitIdentity(dir);
  mkdirSync(join(dir, "d"));
  writeFileSync(join(dir, "d/a.md"), "a\n");
  const task = readyTask(dir, { verification: "self" });
  commitAll(dir, "task");
  git(dir, "rm", "d/a.md");
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了", "--paths", "d/a.md");
  assert.equal(closed.code, 0, closed.stderr);

  const delivered = deliver(dir, task, "--message-file", messageFile(t, "feat: 删除文件\n"));

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.match(delivered.stdout, /^已交付 /m);
  assert.equal(
    git(dir, "show", "--name-only", "--no-renames", "--format=", "HEAD")
      .split("\n")
      .includes("d/a.md"),
    true,
  );
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("别的已经暂存的文件不受影响", (t) => {
  const dir = gitProject(t);
  gitIdentity(dir);
  mkdirSync(join(dir, "d"));
  writeFileSync(join(dir, "d/a.md"), "a\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  const task = readyTask(dir, { verification: "self" });
  commitAll(dir, "task");
  mkdirSync(join(dir, "e"));
  git(dir, "mv", "d/a.md", "e/a.md");
  writeFileSync(join(dir, "other.txt"), "other2\n");
  git(dir, "add", "other.txt");
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了", "--paths", "d/a.md", "e/a.md");
  assert.equal(closed.code, 0, closed.stderr);

  const delivered = deliver(dir, task, "--message-file", messageFile(t, "feat: 移动文件\n"));

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(
    git(dir, "show", "--name-only", "--no-renames", "--format=", "HEAD")
      .split("\n")
      .includes("other.txt"),
    false,
  );
  assert.equal(git(dir, "status", "--porcelain"), "M  other.txt");
});

test("没有提交文案时拒绝", (t) => {
  const dir = gitProject(t);
  gitIdentity(dir);
  const task = doneTask(dir);
  const stateOf = () => [
    git(dir, "rev-parse", "HEAD"),
    git(dir, "status", "--porcelain"),
    ...["task.md", "record.json"].map((name) => readFileSync(join(dir, task.dir, name), "utf8")),
  ];
  const before = stateOf();
  const blank = messageFile(t, " \n\n");

  assert.deepEqual(resultOf(deliver(dir, task)), {
    code: 1,
    stdout: "",
    stderr: "在 Git 仓库里交付要给提交文案：加 --message-file <文件>\n",
  });
  assert.deepEqual(resultOf(deliver(dir, task, "--message-file", blank)), {
    code: 1,
    stdout: "",
    stderr: `提交文案是空的：${blank}\n`,
  });
  assert.deepEqual(resultOf(deliver(dir, task, "--message-file", `${blank}.nope`)), {
    code: 1,
    stdout: "",
    stderr: `读不到提交文案：${blank}.nope\n`,
  });
  assert.deepEqual(stateOf(), before);
});

test("没有要提交的文件时不提交", (t) => {
  const dir = gitProject(t);
  gitIdentity(dir);
  writeFileSync(join(dir, ".gitignore"), "/.knit/\n");
  commitAll(dir, "ignore");
  const task = doneTask(dir);
  const head = git(dir, "rev-parse", "HEAD");

  const delivered = deliver(dir, task, "--message-file", messageFile(t, "feat: 加问候语\n"));

  assert.deepEqual(resultOf(delivered), {
    code: 0,
    stdout: `已交付 ${task.id}\n归档: ${archived(task)}\n提交: 没有要提交的文件\n`,
    stderr: "",
  });
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(existsSync(join(dir, task.dir)), false);
  assert.match(readFileSync(join(dir, archived(task), "task.md"), "utf8"), /^status: delivered$/m);
});
