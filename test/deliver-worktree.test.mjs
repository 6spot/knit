import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const crossDeviceDir = process.env.KNIT_TEST_CROSS_DEVICE_DIR;
const crossDeviceSkip = crossDeviceDir === undefined || statSync(crossDeviceDir).dev === statSync(tmpdir()).dev
  ? "需要 KNIT_TEST_CROSS_DEVICE_DIR 指向另一个文件系统的可写目录"
  : false;

function completed(t, tracked = false, ignored = false, crossDeviceDir = null) {
  const root = runProject(t);
  gitIdentity(root);
  writeFileSync(join(root, ".gitignore"), `.knit/.runtime/\n${ignored ? ".knit/tasks/\n" : ""}`);
  commitAll(root, "ignore runtime files");
  const task = readyTask(root, { verification: "self" });
  if (tracked) commitAll(root, "task before dispatch");
  const workflow = parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
  if (crossDeviceDir !== null) {
    const home = mkdtempSync(join(crossDeviceDir, "knit-test-home-"));
    process.env.KNIT_HOME = home;
    t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
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

[false, true].flatMap((tracked) => [false, true].map((crossDevice) => ({ tracked, crossDevice }))).forEach(({ tracked, crossDevice }) => test(`任务分支 hook 拒绝时原样撤回（任务目录${tracked ? "已" : "未"}入库${crossDevice ? "，跨文件系统" : ""}）`, { skip: crossDevice ? crossDeviceSkip : false }, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, tracked, false, crossDevice ? crossDeviceDir : null);
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

[false, true].forEach((tracked) => test(`归档上级不是目录时原样撤回并可以重试（任务目录${tracked ? "已" : "未"}入库）`, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, tracked);
  mkdirSync(join(worktree.path, ".knit/tasks"), { recursive: true });
  writeFileSync(join(worktree.path, ".knit/tasks/archive"), "blocks archive directory\n");
  const state = () => [mainIdentity(root), git(worktree.path, "rev-parse", "HEAD"), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain"), taskFiles(root, task), ...(tracked ? [taskFiles(worktree.path, task)] : [])];
  const before = state();

  const refused = deliver();

  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /ENOTDIR/);
  assert.deepEqual(state(), before);
  assert.equal(JSON.parse(taskFiles(root, task)[1]).authorization, null);
  assert.equal(git(worktree.path, "diff", "--cached", "--name-only"), "");
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, task.dir)), tracked);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  rmSync(join(worktree.path, ".knit/tasks/archive"));
  const retried = deliver();
  assert.equal(retried.code, 0, retried.stderr);
}));

test("被忽略的任务目录留在主检出归档，合并并删除 Worktree 后仍读得出", (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, false, true);
  const before = [taskFiles(root, task), git(worktree.path, "status", "--porcelain")];
  const preview = deliver("--preview");
  assert.equal(preview.code, 0, preview.stderr);
  assert.ok(preview.stdout.includes(`归档: ${task.dir} → ${join(realpathSync(root), archive)}\n`), preview.stdout);
  assert.ok(preview.stdout.includes(`Worktree: ${worktree.path}（${worktree.branch}）\n`), preview.stdout);
  assert.equal(preview.stdout.includes("（整个目录，移到归档的位置）"), false);
  assert.deepEqual([taskFiles(root, task), git(worktree.path, "status", "--porcelain")], before);

  const delivered = deliver();

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.ok(delivered.stdout.includes(`归档: ${join(realpathSync(root), archive)}\n`), delivered.stdout);
  assert.deepEqual(git(worktree.path, "show", "--name-only", "--format=", "HEAD").split("\n"), ["src/a.txt"]);
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.equal(existsSync(join(worktree.path, archive)), false);
  git(root, "merge", worktree.branch);
  git(root, "worktree", "remove", worktree.path);
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(JSON.parse(readFileSync(join(root, archive, "record.json"), "utf8")).authorization, "user:delivery");
  const shown = knit(root, "task", "show", task.id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /delivered/);
});

test("旧任务目录无法移到备份位置时原样撤回", (t) => {
  const { root, task, worktree, deliver } = completed(t, true);
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  chmodSync(join(worktree.path, ".knit/tasks"), 0o555);
  const refused = deliver();
  chmodSync(join(worktree.path, ".knit/tasks"), 0o755);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /EACCES/);
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  const retried = deliver();
  assert.equal(retried.code, 0, retried.stderr);
});

test("归档目标已被非空目录占用时保留原目录并撤回", (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, true);
  mkdirSync(join(worktree.path, archive), { recursive: true });
  writeFileSync(join(worktree.path, archive, "existing.txt"), "leave this alone\n");
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  const refused = deliver();
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ENOTEMPTY|EEXIST/);
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readFileSync(join(worktree.path, archive, "existing.txt"), "utf8"), "leave this alone\n");
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
});

test("旧任务目录有只读子目录时交付成功且清掉临时副本", (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, true);
  mkdirSync(join(worktree.path, task.dir, "old-material"));
  writeFileSync(join(worktree.path, task.dir, "old-material/note.txt"), "previous task material\n");
  git(worktree.path, "add", "--", `${task.dir}/old-material/note.txt`);
  git(worktree.path, "commit", "-qm", "old task material", "--only", "--", `${task.dir}/old-material/note.txt`);
  const head = git(worktree.path, "rev-parse", "HEAD");
  const main = mainIdentity(root);
  chmodSync(join(worktree.path, task.dir, "old-material"), 0o555);

  const delivered = deliver();

  // 失败的实现可能留下只读备份，恢复权限后临时夹具才能被删除。
  readdirSync(worktree.path)
    .filter((name) => name.startsWith(".knit-delivery-"))
    .forEach((name) => chmodSync(join(worktree.path, name, "task/old-material"), 0o755));
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.deepEqual(mainIdentity(root), main);
  assert.equal(git(worktree.path, "rev-list", "--count", `${head}..HEAD`), "1");
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(git(worktree.path, "status", "--porcelain"), "");
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
});

[false, true].forEach((tracked) => test(`跨文件系统交付代码和归档（任务目录${tracked ? "已" : "未"}入库）`, { skip: crossDeviceSkip }, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, tracked, false, crossDeviceDir);
  const head = git(worktree.path, "rev-parse", "HEAD");
  const main = mainIdentity(root);
  assert.notEqual(statSync(root).dev, statSync(worktree.path).dev);
  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.deepEqual(mainIdentity(root), main);
  assert.equal(git(worktree.path, "rev-list", "--count", `${head}..HEAD`), "1");
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.ok(git(worktree.path, "show", "--name-only", "--format=", "HEAD").includes(`${archive}/task.md`));
  assert.ok(git(worktree.path, "show", "--name-only", "--format=", "HEAD").includes("src/a.txt"));
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
}));

test("跨文件系统复制失败清掉半份目标并恢复旧任务目录，可以重试", { skip: crossDeviceSkip }, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, true, false, crossDeviceDir);
  const unreadable = join(root, task.dir, "z-unreadable.txt");
  writeFileSync(unreadable, "cannot copy\n");
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  chmodSync(unreadable, 0o000);
  const refused = deliver();
  chmodSync(unreadable, 0o644);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /EACCES/);
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readFileSync(unreadable, "utf8"), "cannot copy\n");
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, ".knit/tasks/archive")), false);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  const retried = deliver();
  assert.equal(retried.code, 0, retried.stderr);
});

test("跨文件系统删除源只完成一部分时补回源并撤回", { skip: crossDeviceSkip }, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, true, false, crossDeviceDir);
  const protectedDir = join(root, task.dir, "z-protected");
  mkdirSync(protectedDir);
  writeFileSync(join(protectedDir, "keep.txt"), "source must remain complete\n");
  chmodSync(join(protectedDir, "keep.txt"), 0o444);
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  chmodSync(protectedDir, 0o555);
  const refused = deliver();
  assert.equal(statSync(protectedDir).mode & 0o777, 0o555);
  chmodSync(protectedDir, 0o755);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /EACCES|ENOTEMPTY/);
  assert.ok(refused.stderr.includes(realpathSync(join(root, task.dir))), refused.stderr);
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readFileSync(join(protectedDir, "keep.txt"), "utf8"), "source must remain complete\n");
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, ".knit/tasks/archive")), false);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  const retried = deliver();
  assert.equal(retried.code, 0, retried.stderr);
});

test("系统临时目录在另一个文件系统时已入库任务仍能交付", { skip: crossDeviceSkip }, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, true);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = crossDeviceDir;
  const delivered = deliver();
  if (previous === undefined) delete process.env.TMPDIR;
  if (previous !== undefined) process.env.TMPDIR = previous;
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(readdirSync(crossDeviceDir).some((name) => name.startsWith("knit-delivery-")), false);
});

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
