import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { knit, project } from "./helpers/cli.mjs";
import { doneTask, gitIdentity } from "./helpers/deliver.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";

const now = new Date();
const archived = (task) =>
  `.knit/tasks/archive/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(task.dir)}`;

/**
 * 临时仓库里一个完成的任务：任务目录已经提交，记录的路径是改过的 src/a.ts 和新文件 src/b.ts，
 * 另外 src/c.ts 改了并且已经暂存；pre-commit hook 的内容是 `hook`。
 */
function prepared(t, hook) {
  const dir = gitProject(t);
  gitIdentity(dir);
  // 提交之后 Git 会在后台整理仓库，测试结束删目录时它可能还在写，删除就会失败。
  git(dir, "config", "maintenance.auto", "false");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "src/c.ts"), "c\n");
  const task = doneTask(dir, ["src/a.ts", "src/b.ts"]);
  commitAll(dir, "task");
  writeFileSync(join(dir, "src/a.ts"), "a2\n");
  writeFileSync(join(dir, "src/b.ts"), "b\n");
  writeFileSync(join(dir, "src/c.ts"), "c2\n");
  git(dir, "add", "src/c.ts");
  mkdirSync(join(dir, ".git/hooks"), { recursive: true });
  writeFileSync(join(dir, ".git/hooks/pre-commit"), `#!/bin/sh\n${hook}\n`);
  chmodSync(join(dir, ".git/hooks/pre-commit"), 0o755);
  // 文案写在项目外面，不算工作区里的改动。
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: 加问候语\n");
  const deliver = () => knit(dir, "deliver", task.id, "--authorization", "user:1a2b3c4d", "--message-file", message);
  return { dir, task, deliver };
}

test("Git 拒绝提交时撤回", (t) => {
  const { dir, task, deliver } = prepared(t, "echo 'lint failed' >&2\nexit 1");
  const stateOf = () => [
    git(dir, "rev-parse", "HEAD"),
    git(dir, "status", "--porcelain"),
    ...["task.md", "record.json"].map((name) => readFileSync(join(dir, task.dir, name), "utf8")),
  ];
  const before = stateOf();

  const refused = deliver();

  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /^lint failed$/m);
  assert.equal(
    refused.stderr.trimEnd().split("\n").at(-1),
    `Git 没有接受这次提交，交付已经撤回：任务目录在 ${task.dir}，状态是 done`,
  );
  assert.deepEqual(stateOf(), before);
  assert.equal(existsSync(join(dir, archived(task))), false);

  rmSync(join(dir, ".git/hooks/pre-commit"));
  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(git(dir, "log", "-1", "--format=%b"), `Knit-Task: ${task.id}`);
  assert.equal(git(dir, "status", "--porcelain"), "M  src/c.ts");
});

test("hook 改了提交的内容时报告差别", (t) => {
  const { dir, task, deliver } = prepared(t, "git rm -q --cached src/b.ts\necho hooked > hooked.txt\ngit add hooked.txt");

  const delivered = deliver();

  assert.deepEqual(
    { code: delivered.code, stdout: delivered.stdout, stderr: delivered.stderr },
    {
      code: 0,
      stdout: [
        `已交付 ${task.id}`,
        `归档: ${archived(task)}`,
        `提交: ${git(dir, "rev-parse", "--short", "HEAD")} feat: 加问候语`,
        "注意：提交里的文件和预期的不一样，提交保留",
        "  多了: hooked.txt",
        "  少了: src/b.ts",
        "",
      ].join("\n"),
      stderr: "",
    },
  );
  assert.equal(git(dir, "log", "-1", "--format=%b"), `Knit-Task: ${task.id}`);
  assert.equal(existsSync(join(dir, task.dir)), false);
  assert.match(readFileSync(join(dir, archived(task), "task.md"), "utf8"), /^status: delivered$/m);
});
