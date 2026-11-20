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

function completed(t, tracked = false, ignored = false, crossDeviceDir = null, baseContent = null) {
  const root = runProject(t);
  gitIdentity(root);
  if (baseContent !== null) {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.txt"), baseContent);
  }
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
  mkdirSync(join(worktree.path, "src"), { recursive: true });
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

function autoMergeConfig(root, autoMerge = true) {
  writeFileSync(join(root, ".knit/config.json"), JSON.stringify({ worktree: { autoMerge } }));
  git(root, "add", "--", ".knit/config.json");
  git(root, "commit", "-qm", "auto merge configuration", "--only", "--", ".knit/config.json");
}

[false, true].forEach((tracked) => test(`自动合并到主检出的当前分支并清理，非快进落成合并提交（任务目录${tracked ? "已" : "未"}入库）`, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, tracked);
  git(root, "checkout", "-qb", "delivery-target");
  autoMergeConfig(root);
  writeFileSync(join(root, "main-only.txt"), "main branch advanced\n");
  git(root, "add", "main-only.txt");
  git(root, "commit", "-qm", "advance main branch", "--only", "--", "main-only.txt");
  const head = git(root, "rev-parse", "HEAD");
  const before = [taskFiles(root, task), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain")];

  const preview = deliver("--preview");
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /交付之后会合并进主检出的分支 delivery-target/);
  assert.ok(preview.stdout.includes(`删除 Worktree: ${worktree.path}`), preview.stdout);
  assert.ok(preview.stdout.includes(`删除分支: ${worktree.branch}`), preview.stdout);
  assert.deepEqual([taskFiles(root, task), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain")], before);

  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stderr, "");
  assert.equal(git(root, "rev-parse", "HEAD^1"), head);
  assert.equal(git(root, "log", "-1", "--format=%P").split(" ").length, 2);
  assert.equal(git(root, "show", "HEAD^2:src/a.txt"), "worker result");
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "worker result\n");
  assert.equal(readFileSync(join(root, "main-only.txt"), "utf8"), "main branch advanced\n");
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(JSON.parse(readFileSync(join(root, archive, "record.json"), "utf8")).authorization, "user:delivery");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
  assert.equal(git(root, "worktree", "list", "--porcelain").includes(worktree.path), false);
  assert.match(delivered.stdout, /已合并 .* → delivery-target/);
  assert.ok(delivered.stdout.includes(`已删除 Worktree: ${worktree.path}`), delivered.stdout);
  assert.ok(delivered.stdout.includes(`已删除分支: ${worktree.branch}`), delivered.stdout);
  assert.equal(delivered.stdout.includes("还没有合并"), false);
}));

[false, true].flatMap((tracked) => ["conflict", "dirty"].map((reason) => ({ tracked, reason }))).forEach(({ tracked, reason }) => test(`自动合并失败保留交付，主检出恢复原样：${reason}（任务目录${tracked ? "已" : "未"}入库）`, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, tracked, false, null, "base\n");
  autoMergeConfig(root);
  writeFileSync(join(root, "src/a.txt"), "main result\n");
  if (reason === "conflict") {
    git(root, "add", "src/a.txt");
    git(root, "commit", "-qm", "main changes same line", "--only", "--", "src/a.txt");
  }
  writeFileSync(join(root, "unrelated.txt"), "keep main changes\n");
  if (reason === "dirty") git(root, "add", "unrelated.txt");
  const state = () => [mainIdentity(root), git(root, "status", "--porcelain", "--", ".", `:(exclude)${task.dir}`), git(root, "diff", "--", ".", `:(exclude)${task.dir}`), git(root, "diff", "--cached", "--", ".", `:(exclude)${task.dir}`)];
  const before = state();

  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stderr, "");
  assert.deepEqual(state(), before);
  assert.equal(existsSync(join(root, ".git/MERGE_HEAD")), false);
  assert.equal(existsSync(join(root, task.dir)), false, "abort 不能把已归档的任务恢复成主检出里的旧任务");
  assert.ok(existsSync(worktree.path));
  assert.equal(git(root, "rev-parse", worktree.branch), git(worktree.path, "rev-parse", "HEAD"));
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(git(worktree.path, "log", "-1", "--format=%B").split("\n").at(-1), `Knit-Task: ${task.id}`);
  assert.match(delivered.stdout, /^已交付 /m);
  assert.ok(delivered.stdout.includes(`提交保留在任务分支 ${worktree.branch}`), delivered.stdout);
  assert.match(delivered.stdout, /合并没有成功/);
  assert.match(delivered.stdout, /主会话.*用户.*怎么处理/);
  assert.match(delivered.stdout, reason === "conflict" ? /CONFLICT \(content\): Merge conflict in src\/a.txt/ : /Your local changes to the following files would be overwritten by merge:/);
  assert.equal(delivered.stdout.includes("已删除"), false);
  assert.equal(delivered.stdout.includes("已放弃这次合并"), reason === "conflict");
}));

test("Worktree 清理拒绝不强制，未入库文件和分支保留且退出码为 0", (t) => {
  const { root, worktree, archive, deliver } = completed(t);
  autoMergeConfig(root);
  writeFileSync(join(worktree.path, "untracked.txt"), "must not delete\n");
  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stderr, "");
  assert.match(delivered.stdout, /已合并/);
  assert.match(delivered.stdout, /contains modified or untracked files/);
  assert.ok(delivered.stdout.includes(worktree.path), delivered.stdout);
  assert.equal(readFileSync(join(worktree.path, "untracked.txt"), "utf8"), "must not delete\n");
  assert.ok(git(root, "branch", "--list", worktree.branch).includes(worktree.branch));
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(delivered.stdout.includes("已删除"), false);
});

test("分支清理被 Git 拒绝时保留分支，已合并和已删除 Worktree 的结果可见", (t) => {
  const { root, worktree, deliver } = completed(t);
  autoMergeConfig(root);
  git(root, "branch", "unmerged-upstream", worktree.branch);
  git(worktree.path, "branch", "--set-upstream-to=unmerged-upstream");
  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stderr, "");
  assert.match(delivered.stdout, /已合并/);
  assert.match(delivered.stdout, /已删除 Worktree/);
  assert.match(delivered.stdout, /not fully merged/);
  assert.ok(delivered.stdout.includes(worktree.branch), delivered.stdout);
  assert.equal(existsSync(worktree.path), false);
  assert.ok(git(root, "branch", "--list", worktree.branch).includes(worktree.branch));
});

test("快进合并并清理，被忽略的归档留在主检出", (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, false, true);
  autoMergeConfig(root);
  git(worktree.path, "merge", "--no-edit", git(root, "rev-parse", "HEAD"));
  const head = git(root, "rev-parse", "HEAD");
  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(git(root, "rev-parse", "HEAD^"), head);
  assert.equal(git(root, "log", "-1", "--format=%P").split(" ").length, 1);
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n"), ["src/a.txt"]);
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
  assert.ok(delivered.stdout.includes(`归档: ${join(realpathSync(root), archive)}`), delivered.stdout);
  assert.equal(knit(root, "task", "show", task.id).code, 0);
});

test("没有要提交的文件也合并并清理，归档仍在主检出", (t) => {
  const { root, worktree, archive, deliver } = completed(t, false, true);
  autoMergeConfig(root);
  rmSync(join(worktree.path, "src"), { recursive: true });
  const head = git(root, "rev-parse", "HEAD");
  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.match(delivered.stdout, /提交: 没有要提交的文件/);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
});

["hook", "move"].forEach((reason) => test(`自动合并开着但交付撤回时不合并、不清理：${reason}`, (t) => {
  const { root, task, worktree, archive, deliver } = completed(t, true);
  autoMergeConfig(root);
  if (reason === "hook") {
    const hooks = join(root, ".git/hooks");
    git(root, "config", "core.hooksPath", hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'delivery refused' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
  }
  if (reason === "move") writeFileSync(join(worktree.path, ".knit/tasks/archive"), "blocks directory\n");
  const before = [mainIdentity(root), git(worktree.path, "rev-parse", "HEAD"), taskFiles(root, task), git(worktree.path, "status", "--porcelain")];
  const refused = deliver();
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, reason === "hook" ? /delivery refused/ : /ENOTDIR/);
  assert.deepEqual([mainIdentity(root), git(worktree.path, "rev-parse", "HEAD"), taskFiles(root, task), git(worktree.path, "status", "--porcelain")], before);
  assert.equal(existsSync(join(worktree.path, archive)), false);
}));

test("autoMerge 配置不是布尔值时在归档之前拒绝", (t) => {
  const { root, task, worktree, deliver } = completed(t);
  autoMergeConfig(root, "true");
  const before = [mainIdentity(root), taskFiles(root, task), git(worktree.path, "status", "--porcelain")];
  const refused = deliver();
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /\.knit\/config\.json：.*worktree\/autoMerge/);
  assert.deepEqual([mainIdentity(root), taskFiles(root, task), git(worktree.path, "status", "--porcelain")], before);
});

test("显式关闭 autoMerge 时预览和交付沿用原文", (t) => {
  const { root, task, worktree, archive, deliver } = completed(t);
  autoMergeConfig(root, false);
  const before = mainIdentity(root);
  const preview = deliver("--preview");
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /^提交在任务分支上，不会合并进主检出的分支$/m);
  const delivered = deliver();
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, `已交付 ${task.id}\n归档: ${join(worktree.path, archive)}\n提交: ${git(worktree.path, "log", "-1", "--format=%h %s")}\nWorktree: ${worktree.path}（${worktree.branch}）\n这个提交还没有合并进主检出的分支\n`);
  assert.deepEqual(mainIdentity(root), before);
});

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
  assert.equal(delivered.stdout, `已交付 ${task.id}\n归档: ${join(worktree.path, archive)}\n提交: ${git(worktree.path, "log", "-1", "--format=%h %s")}\nWorktree: ${worktree.path}（${worktree.branch}）\n这个提交还没有合并进主检出的分支\n`);
  assert.ok(git(root, "worktree", "list", "--porcelain").includes(`branch refs/heads/${worktree.branch}`));
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
