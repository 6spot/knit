import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { archiveDirOf } from "../dist/application/task-store.js";
import { taskWorktree } from "../dist/application/worktree.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { gitIdentity } from "./helpers/deliver.mjs";
import { commitAll, git } from "./helpers/git.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";

function completed(t, tracked = false) {
  const root = runProject(t);
  gitIdentity(root);
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n");
  commitAll(root, "ignore runtime files");
  const task = readyTask(root, { verification: "self" });
  if (tracked) commitAll(root, "task before dispatch");
  const workflow = parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
  const prepared = prepareRun({ root, taskId: task.id, workflow, config: loadConfig(root).config, model: null });
  assert.deepEqual(prepared.problems, []);
  const worktree = taskWorktree(root, task.dir);
  mkdirSync(join(worktree.path, "src"));
  writeFileSync(join(worktree.path, "src/a.txt"), "worker result\n");
  assert.deepEqual(finishRun({ root, taskId: task.id, runId: prepared.run.id, workflow, verdict: null, failure: null, sessionFile: null }), []);
  const closed = knit(root, "task", "close", task.id, "--result", "主检出当前的成果和验证");
  assert.equal(closed.code, 0, closed.stderr);
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: deliver worker result\n\nTask: " + task.id + "\n");
  const deliver = (...args) => knit(root, "deliver", task.id, "--authorization", "user:delivery", "--message-file", message, ...args);
  return { root, task, worktree, archive: archiveDirOf(task), deliver };
}

const taskFiles = (root, task) => ["task.md", "record.json"].map((file) => readFileSync(join(root, task.dir, file), "utf8"));
const mainIdentity = (root) => [git(root, "branch", "--show-current"), git(root, "rev-parse", "HEAD")];

test("派发过的任务只在任务分支提交代码和归档，主检出 HEAD 不变", (t) => {
  const { root, task, worktree, archive, deliver } = completed(t);
  const main = mainIdentity(root);
  const taskHead = git(worktree.path, "rev-parse", "HEAD");
  writeFileSync(join(worktree.path, "other.txt"), "unrelated\n");
  git(worktree.path, "add", "other.txt");
  writeFileSync(join(root, "main-only.txt"), "main change\n");

  const delivered = deliver();

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.deepEqual(mainIdentity(root), main);
  assert.notEqual(git(worktree.path, "rev-parse", "HEAD"), taskHead);
  assert.equal(git(worktree.path, "rev-list", "--count", `${taskHead}..HEAD`), "1");
  assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
  assert.deepEqual(git(worktree.path, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [
    `${archive}/record.json`, `${archive}/task.md`, "src/a.txt",
  ]);
  assert.equal(git(worktree.path, "log", "-1", "--format=%B").split("\n").at(-1), `Knit-Task: ${task.id}`);
  assert.equal(git(worktree.path, "status", "--porcelain"), "A  other.txt");
  assert.equal(git(root, "status", "--porcelain"), "?? main-only.txt");
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(JSON.parse(readFileSync(join(worktree.path, archive, "record.json"), "utf8")).authorization, "user:delivery");
  assert.ok(delivered.stdout.includes(`归档: ${join(worktree.path, archive)}\n`), delivered.stdout);
  assert.ok(delivered.stdout.includes(`提交: ${git(worktree.path, "log", "-1", "--format=%h %s")}\n`), delivered.stdout);
  assert.ok(delivered.stdout.includes(`Worktree: ${worktree.path}（${worktree.branch}）\n`), delivered.stdout);
  assert.match(delivered.stdout, /还没有合并进主检出的分支/);
});

[false, true].forEach((tracked) => test(`任务分支 hook 拒绝时原样撤回（任务目录${tracked ? "已" : "未"}入库）`, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, tracked);
  const hooks = join(root, ".git/hooks");
  git(root, "config", "core.hooksPath", hooks);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho \"hook branch: $(git branch --show-current)\" >&2\necho 'worker lint failed' >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  const state = () => [mainIdentity(root), git(worktree.path, "rev-parse", "HEAD"), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain"), taskFiles(root, task), ...(tracked ? [taskFiles(worktree.path, task)] : [])];
  const before = state();

  const refused = deliver();

  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /^worker lint failed$/m);
  assert.ok(refused.stderr.split("\n").includes(`hook branch: ${worktree.branch}`), refused.stderr);
  assert.deepEqual(state(), before);
  assert.equal(git(worktree.path, "diff", "--cached", "--name-only"), "");
  assert.match(readFileSync(join(root, task.dir, "task.md"), "utf8"), /^status: done$/m);
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, ".knit/tasks/archive")), false);
  assert.equal(existsSync(join(worktree.path, task.dir)), tracked);
}));

test("已入库任务目录在任务分支删除原位置，主检出当前内容归档后可以合并", (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, true);
  const currentTask = readFileSync(join(root, task.dir, "task.md"), "utf8");
  assert.notEqual(readFileSync(join(worktree.path, task.dir, "task.md"), "utf8"), currentTask);
  const main = mainIdentity(root);

  const delivered = deliver();

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.deepEqual(mainIdentity(root), main);
  assert.equal(existsSync(join(worktree.path, task.dir)), false);
  assert.deepEqual(git(worktree.path, "diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", "HEAD").split("\n").sort(), [
    `${task.dir}/record.json`, `${task.dir}/task.md`, `${archive}/record.json`, `${archive}/task.md`, "src/a.txt",
  ].sort());
  assert.equal(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), currentTask.replace("status: done", "status: delivered"));

  const merged = git(root, "merge", `knit/${basename(task.dir)}`);

  assert.match(merged, /Fast-forward/);
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.equal(readFileSync(join(root, archive, "task.md"), "utf8"), currentTask.replace("status: done", "status: delivered"));
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "worker result\n");
  assert.equal(git(root, "status", "--porcelain"), "");
});
