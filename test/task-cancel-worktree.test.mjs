import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { archiveDirOf } from "../dist/application/task-store.js";
import { taskWorktree } from "../dist/application/worktree.js";
import { gitSync } from "../dist/infrastructure/process.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit } from "./helpers/cli.mjs";
import { commitAll, git } from "./helpers/git.mjs";
import { agents, readyTask, runProject } from "./helpers/run.mjs";

function dispatch(root) {
  const task = readyTask(root, { verification: "self" });
  const workflow = parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
  const prepared = prepareRun({ root, taskId: task.id, workflow, config: loadConfig(root).config, model: null });
  assert.deepEqual(prepared.problems, []);
  assert.deepEqual(finishRun({ agents, root, taskId: task.id, runId: prepared.run.id, workflow, verdict: null, failure: null, sessionFile: null }), []);
  return { task, worktree: taskWorktree(root, task.dir) };
}

const gitState = (root) => [git(root, "worktree", "list", "--porcelain"), git(root, "branch", "--list", "knit/*")];
const mainHead = (root) => [git(root, "branch", "--show-current"), git(root, "rev-parse", "HEAD")];

function assertArchived(root, task) {
  const shown = knit(root, "task", "show", task.id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.includes(`目录: ${archiveDirOf(task)}\n`), shown.stdout);
  assert.match(shown.stdout, /^状态: cancelled$/m);
  assert.match(readFileSync(join(root, archiveDirOf(task), "task.md"), "utf8"), /已取消：不做了/);
  assert.equal(git(root, "ls-files", "--", archiveDirOf(task)), "", "归档不提交");
}

function assertRemoved(root, worktree) {
  assert.equal(git(root, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${join(realpathSync(dirname(worktree.path)), basename(worktree.path))}`), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
  assert.equal(existsSync(worktree.path), false, "Worktree 目录已删除");
}

test("取消真实派发且已结束的任务：强制丢弃各类改动，只删除自己的 Worktree 和分支", (t) => {
  const root = runProject(t);
  writeFileSync(join(root, "modified.txt"), "base\n");
  writeFileSync(join(root, "deleted.txt"), "base\n");
  writeFileSync(join(root, "renamed.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  commitAll(root, "base files");
  const { task, worktree } = dispatch(root);
  const other = dispatch(root);
  writeFileSync(join(worktree.path, "checkpoint.txt"), "unmerged task commit\n");
  commitAll(worktree.path, "task checkpoint after execution ended");
  writeFileSync(join(worktree.path, "modified.txt"), "worker changes\n");
  rmSync(join(worktree.path, "deleted.txt"));
  renameSync(join(worktree.path, "renamed.txt"), join(worktree.path, "renamed\nnew.txt"));
  git(worktree.path, "add", "--", "renamed.txt", "renamed\nnew.txt");
  mkdirSync(join(worktree.path, "new-dir"));
  writeFileSync(join(worktree.path, "new-dir/one.txt"), "untracked\n");
  writeFileSync(join(worktree.path, "new-dir/two.txt"), "untracked\n");
  mkdirSync(join(worktree.path, "node_modules"));
  writeFileSync(join(worktree.path, "node_modules/ignored.txt"), "ignored\n");
  writeFileSync(join(other.worktree.path, "other.txt"), "must remain\n");
  const before = [mainHead(root), git(other.worktree.path, "status", "--porcelain"), git(root, "rev-parse", other.worktree.branch)];

  const cancelled = knit(root, "task", "cancel", task.id, "--reason", "不做了");

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stderr, "");
  assertArchived(root, task);
  assertRemoved(root, worktree);
  assert.ok(cancelled.stdout.includes(`已删除 Worktree: ${worktree.path}\n`), cancelled.stdout);
  assert.ok(cancelled.stdout.includes(`已删除分支: ${worktree.branch}\n`), cancelled.stdout);
  assert.match(cancelled.stdout, /已丢弃未提交的改动（6 个文件）/);
  assert.deepEqual([mainHead(root), git(other.worktree.path, "status", "--porcelain"), git(root, "rev-parse", other.worktree.branch)], before);
  assert.equal(readFileSync(join(other.worktree.path, "other.txt"), "utf8"), "must remain\n");
  assert.ok(git(root, "worktree", "list", "--porcelain").includes(other.worktree.path));
});

test("没有派发过的任务：取消输出逐字不变，Worktree 和分支列表不变", (t) => {
  const root = runProject(t);
  dispatch(root);
  const task = readyTask(root, { verification: "self" });
  const before = gitState(root);

  assert.deepEqual(knit(root, "task", "cancel", task.id, "--reason", "不做了"), {
    code: 0,
    stdout: `已取消 ${task.id}\n${archiveDirOf(task)}\n`,
    stderr: "",
  });
  assertArchived(root, task);
  assert.deepEqual(gitState(root), before);
});

test("Worktree 被锁住时仍取消并归档，退出码 0，原样报告 Git 错误和保留位置", (t) => {
  const root = runProject(t);
  const { task, worktree } = dispatch(root);
  writeFileSync(join(worktree.path, "untracked.txt"), "must remain\n");
  git(root, "worktree", "lock", "--reason", "test lock", worktree.path);
  const before = gitState(root);
  const refused = gitSync(["worktree", "remove", "--force", worktree.path], root);
  assert.notEqual(refused.code, 0);

  const cancelled = knit(root, "task", "cancel", task.id, "--reason", "不做了");

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stderr, "");
  assertArchived(root, task);
  assert.ok(cancelled.stdout.includes((refused.stdout + refused.stderr).trimEnd()), cancelled.stdout);
  assert.ok(cancelled.stdout.includes(`Worktree 和分支保留: ${worktree.path}（${worktree.branch}）`), cancelled.stdout);
  assert.equal(cancelled.stdout.includes("已丢弃"), false);
  assert.equal(cancelled.stdout.includes("已删除"), false);
  assert.deepEqual(gitState(root), before);
  assert.equal(readFileSync(join(worktree.path, "untracked.txt"), "utf8"), "must remain\n");
});

test("Worktree 目录已丢失时 prune 登记并强制删除任务分支，另一个 Worktree 保留", (t) => {
  const root = runProject(t);
  const { task, worktree } = dispatch(root);
  const other = dispatch(root);
  rmSync(worktree.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.ok(git(root, "worktree", "list", "--porcelain").includes(worktree.path));
  const before = [git(other.worktree.path, "status", "--porcelain"), git(root, "rev-parse", other.worktree.branch)];

  const cancelled = knit(root, "task", "cancel", task.id, "--reason", "不做了");

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assertArchived(root, task);
  assertRemoved(root, worktree);
  assert.ok(cancelled.stdout.includes(worktree.path), cancelled.stdout);
  assert.ok(cancelled.stdout.includes(`已删除分支: ${worktree.branch}\n`), cancelled.stdout);
  assert.deepEqual([git(other.worktree.path, "status", "--porcelain"), git(root, "rev-parse", other.worktree.branch)], before);
  assert.ok(git(root, "worktree", "list", "--porcelain").includes(other.worktree.path));
});

test("Worktree 已正常移除且仅剩任务分支时仍删除分支", (t) => {
  const root = runProject(t);
  const { task, worktree } = dispatch(root);
  git(root, "worktree", "remove", worktree.path);

  const cancelled = knit(root, "task", "cancel", task.id, "--reason", "不做了");

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assertArchived(root, task);
  assertRemoved(root, worktree);
  assert.ok(cancelled.stdout.includes(`已删除分支: ${worktree.branch}\n`), cancelled.stdout);
  assert.equal(cancelled.stdout.includes("已丢弃"), false);
});

test("Worktree 已移除但任务分支在别处检出：仍取消，报告分支删除失败和主检出位置", (t) => {
  const root = runProject(t);
  const { task, worktree } = dispatch(root);
  const moved = `${worktree.path}-moved`;
  git(root, "worktree", "move", worktree.path, moved);
  writeFileSync(join(moved, "keep.txt"), "must remain\n");
  const before = gitState(root);
  const refused = gitSync(["branch", "-D", worktree.branch], root);
  assert.notEqual(refused.code, 0);

  const cancelled = knit(root, "task", "cancel", task.id, "--reason", "不做了");

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stderr, "");
  assertArchived(root, task);
  assert.ok(cancelled.stdout.includes((refused.stdout + refused.stderr).trimEnd()), cancelled.stdout);
  assert.ok(cancelled.stdout.includes(`分支保留: ${worktree.branch}（主检出: ${realpathSync(root)}）`), cancelled.stdout);
  assert.deepEqual(gitState(root), before);
  assert.equal(readFileSync(join(moved, "keep.txt"), "utf8"), "must remain\n");
});

test("取消发生版本冲突时不归档、不删除 Worktree 或分支", (t) => {
  const root = runProject(t);
  const { task, worktree } = dispatch(root);
  writeFileSync(join(worktree.path, "keep.txt"), "must remain\n");
  const file = join(root, task.dir, "task.md");
  const edited = `${readFileSync(file, "utf8")}\n用户同时编辑的一行\n`;
  const record = readFileSync(join(root, task.dir, "record.json"), "utf8");
  const before = gitState(root);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { Command } from ${JSON.stringify(import.meta.resolve("commander"))};
    import { writeFileSync } from "node:fs";
    import { registerTaskCommands } from ${JSON.stringify(new URL("../dist/cli/task.js", import.meta.url).href)};
    const program = new Command();
    registerTaskCommands(program);
    program.hook("preAction", (_, command) => {
      Object.defineProperty(command.opts(), "reason", { get() {
        writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(edited)});
        return "不做了";
      }});
    });
    program.parse(["task", "cancel", ${JSON.stringify(task.id)}, "--reason", "不做了", "--dir", ${JSON.stringify(root)}], { from: "user" });
  `], { encoding: "utf8" });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /task\.md 在读入之后被改过，没有写入/);
  assert.equal(readFileSync(file, "utf8"), edited);
  assert.equal(readFileSync(join(root, task.dir, "record.json"), "utf8"), record);
  assert.equal(existsSync(join(root, archiveDirOf(task))), false);
  assert.deepEqual(gitState(root), before);
  assert.equal(readFileSync(join(worktree.path, "keep.txt"), "utf8"), "must remain\n");
});

test("执行还没结束时拒绝取消，Worktree、分支和未提交文件保留", (t) => {
  const root = runProject(t);
  const task = readyTask(root, { verification: "self" });
  const workflow = parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
  const prepared = prepareRun({ root, taskId: task.id, workflow, config: loadConfig(root).config, model: null });
  assert.deepEqual(prepared.problems, []);
  const worktree = taskWorktree(root, task.dir);
  writeFileSync(join(worktree.path, "keep.txt"), "must remain\n");
  const before = [gitState(root), readFileSync(join(root, task.dir, "task.md"), "utf8"), readFileSync(join(root, task.dir, "record.json"), "utf8")];

  const cancelled = knit(root, "task", "cancel", task.id, "--reason", "不做了");

  assert.deepEqual(cancelled, { code: 1, stdout: "", stderr: `任务 ${task.id} 的执行 ${prepared.run.id} 还没有结束；等它结束，或运行 knit run cancel ${task.id}\n` });
  assert.deepEqual([gitState(root), readFileSync(join(root, task.dir, "task.md"), "utf8"), readFileSync(join(root, task.dir, "record.json"), "utf8")], before);
  assert.equal(existsSync(join(root, archiveDirOf(task))), false);
  assert.equal(readFileSync(join(worktree.path, "keep.txt"), "utf8"), "must remain\n");
});

test("真实派发的干净 Worktree 也删除，不报丢弃改动", (t) => {
  const root = runProject(t);
  const { task, worktree } = dispatch(root);

  const cancelled = knit(root, "task", "cancel", task.id, "--reason", "不做了");

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assertArchived(root, task);
  assertRemoved(root, worktree);
  assert.equal(cancelled.stdout.includes("已丢弃"), false);
});
