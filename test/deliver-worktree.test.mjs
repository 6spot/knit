import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { cancelTask, closeTask, readyTask as confirmTask } from "../dist/application/task-lifecycle.js";
import { loadConfig } from "../dist/application/project-config.js";
import { deliverTask } from "../dist/application/delivery.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { archiveDirOf, createTask, scanTasks } from "../dist/application/task-store.js";
import { taskWorktree } from "../dist/application/worktree.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { project } from "./helpers/cli.mjs";
import { commitAll, git } from "./helpers/git.mjs";
import { agents, doneTask, readyTask, runProject } from "./helpers/run.mjs";

// macOS 的系统 git 是工具链启动器。让临时仓库的 Git 调用直接使用同一安装的可执行文件。
if (process.platform === "darwin") process.env.PATH = `${execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()}:${process.env.PATH}`;

const crossDeviceDir = process.env.KNIT_TEST_CROSS_DEVICE_DIR;
const crossDeviceSkip = crossDeviceDir === undefined || statSync(crossDeviceDir).dev === statSync(tmpdir()).dev
  ? "需要 KNIT_TEST_CROSS_DEVICE_DIR 指向另一个文件系统的可写目录"
  : false;

const templates = new Map();
const files = new DisposableStack();
after(() => files.dispose());
const fileLifetime = { after: (cleanup) => files.defer(cleanup) };
const exec = promisify(execFile);

const cliFile = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
function knit(root, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliFile, ...args, "--dir", root], (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

// 交付从同一个真实完成记录开始。既有提交只保存派发前的任务文件。
function deliveryHistory() {
  const root = runProject(fileLifetime);
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n");
  commitAll(root, "ignore runtime files");
  const task = readyTask(root, { verification: "self" });
  const before = taskFiles(root, task);
  const workflow = parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
  const prepared = prepareRun({ root, taskId: task.id, workflow, config: loadConfig(root).config, model: null });
  assert.deepEqual(prepared.problems, []);
  const worktree = taskWorktree(root, task.dir);
  mkdirSync(join(worktree.path, "src"), { recursive: true });
  writeFileSync(join(worktree.path, "src/a.txt"), "worker result\n");
  assert.deepEqual(finishRun({ agents, root, taskId: task.id, runId: prepared.run.id, workflow, verdict: null, failure: null, sessionFile: null }), []);
  assert.equal(closeTask(root, task.id, { result: "主检出当前的成果和验证", paths: [] }).kind, "done");
  git(root, "worktree", "remove", "--force", worktree.path);
  git(root, "branch", "-D", worktree.branch);
  return { root, task, before };
}

function completedTemplate(tracked, ignored, baseContent) {
  if (!templates.has("history")) templates.set("history", deliveryHistory());
  const history = templates.get("history");
  if (!tracked && !ignored && baseContent === null) return history;
  const root = project(fileLifetime);
  cpSync(history.root, root, { recursive: true });
  const paths = [];
  if (tracked) {
    ["task.md", "record.json"].forEach((file, i) => writeFileSync(join(root, history.task.dir, file), history.before[i]));
    paths.push(history.task.dir);
  }
  if (ignored) {
    writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n.knit/tasks/\n");
    paths.push(".gitignore");
  }
  if (baseContent !== null) {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.txt"), baseContent);
    paths.push("src/a.txt");
  }
  git(root, "add", "--", ...paths);
  git(root, "commit", "-qm", "delivery base");
  if (tracked) cpSync(join(history.root, history.task.dir), join(root, history.task.dir), { recursive: true });
  return { root, task: history.task };
}

async function completed(t, tracked = false, ignored = false, device = null, baseContent = null) {
  const key = JSON.stringify([tracked, ignored, baseContent]);
  if (!templates.has(key)) templates.set(key, completedTemplate(tracked, ignored, baseContent));
  const template = templates.get(key);
  const task = template.task;
  const root = mkdtempSync(join(tmpdir(), "knit-delivery-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(template.root, root, { recursive: true });
  if (device !== null) {
    const home = mkdtempSync(join(device, "knit-test home's-"));
    const previous = process.env.KNIT_HOME;
    process.env.KNIT_HOME = home;
    t.after(() => { process.env.KNIT_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  }
  const worktree = taskWorktree(root, task.dir);
  await exec("git", ["worktree", "add", "-b", worktree.branch, worktree.path, "HEAD"], { cwd: root });
  mkdirSync(join(worktree.path, "src"), { recursive: true });
  writeFileSync(join(worktree.path, "src/a.txt"), "worker result\n");
  const message = join(root, ".git", "message.txt");
  writeFileSync(message, "feat: deliver worker result\n\nTask: " + task.id + "\n");
  const deliver = (options) => deliverTask(realpathSync(root), task.id, { authorization: "user:delivery", messageFile: message, ...options });
  const cli = (...args) => knit(root, "deliver", task.id, "--authorization", "user:delivery", "--message-file", message, ...args);
  return { root, task, worktree, archive: archiveDirOf(task), deliver, cli, message };
}

test("未合并的 Worktree 归档保留运行资料，合并后只在另一次交付成功时清理", async (t) => {
  const { root, task, worktree, deliver, message } = await completed(t);
  const file = join(root, task.dir, "record.json");
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.runs[0].startedAt = "2000-01-01T00:00:00.000Z";
  record.runs[0].endedAt = "2000-01-01T01:00:00.000Z";
  writeFileSync(file, JSON.stringify(record));
  const run = join(root, ".knit/.runtime/runs", record.runs[0].id);
  utimesSync(run, new Date(record.runs[0].endedAt), new Date(record.runs[0].endedAt));
  const options = { authorization: "user:delivery", messageFile: message };
  assert.equal(deliver().kind, "delivered");
  assert.equal(deliverTask(root, doneTask(root).id, options).cleanup.removed, 0);
  assert.ok(existsSync(run));
  git(root, "merge", "--no-edit", worktree.branch);
  const next = doneTask(root);
  const hook = join(root, ".git/hooks/pre-commit");
  mkdirSync(join(root, ".git/hooks"), { recursive: true });
  git(root, "config", "core.hooksPath", join(root, ".git/hooks"));
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal(deliverTask(root, next.id, options).kind, "rolledBack");
  assert.ok(existsSync(run));
  rmSync(hook);
  assert.equal(deliverTask(root, next.id, options).cleanup.removed, 1);
  assert.equal(existsSync(run), false);
});

const taskFiles = (root, task) => ["task.md", "record.json"].map((file) => readFileSync(join(root, task.dir, file), "utf8"));
const mainIdentity = (root) => [git(root, "branch", "--show-current"), git(root, "rev-parse", "HEAD")];

function autoMergeConfig(root, autoMerge = true) {
  writeFileSync(join(root, ".knit/config.json"), JSON.stringify({ worktree: { autoMerge } }));
  git(root, "add", "--", ".knit/config.json");
  git(root, "commit", "-qm", "auto merge configuration", "--only", "--", ".knit/config.json");
}

test("预览分别列出主检出未提交改动和共同修改路径，两个检出均只读", async (t) => {
  const { root, task, worktree, archive, cli } = await completed(t, true, false, null, "base\n");
  autoMergeConfig(root);
  writeFileSync(join(root, "dirty.txt"), "staged");
  git(root, "add", "dirty.txt");
  const snapshot = () => [root, worktree.path].map((cwd) => [
    git(cwd, "rev-parse", "HEAD"), git(cwd, "--no-optional-locks", "status", "--porcelain", "-uall"),
    readFileSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index")),
    ...taskFiles(cwd, task),
  ]);
  const preview = async () => {
    const before = snapshot();
    const result = await cli("--preview");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(snapshot(), before);
    return result.stdout;
  };
  const dirty = await preview();
  assert.match(dirty, /主检出有未提交改动，可能挡住交付后的自动合并：dirty\.txt\n/);
  assert.doesNotMatch(dirty, /自动合并可能冲突/);

  writeFileSync(join(worktree.path, "branch.txt"), "branch");
  writeFileSync(join(worktree.path, ".gitignore"), ".knit/.runtime/\n.knit/tasks/archive/**/ignored.txt\n");
  git(worktree.path, "add", "branch.txt", ".gitignore");
  git(worktree.path, "commit", "-qm", "task commit");
  writeFileSync(join(root, "branch.txt"), "main");
  writeFileSync(join(root, "src/a.txt"), "main");
  mkdirSync(join(root, archive), { recursive: true });
  writeFileSync(join(root, archive, "task.md"), "main");
  writeFileSync(join(root, archive, "ignored.txt"), "main");
  commitAll(root, "advance main");
  const overlap = await preview();
  assert.doesNotMatch(overlap, /主检出有未提交改动/);
  const expected = [`${task.dir}/record.json`, `${task.dir}/task.md`, `${archive}/task.md`, "branch.txt", "src/a.txt"].sort();
  assert.ok(overlap.includes(`自动合并可能冲突：${expected.join("、")}\n`), overlap);

  autoMergeConfig(root, false);
  writeFileSync(join(root, "dirty.txt"), "dirty again");
  assert.doesNotMatch(await preview(), /主检出有未提交改动|自动合并可能冲突/);
});

describe("独立仓库的自动合并矩阵", { concurrency: 3 }, () => {
  [false, true].forEach((tracked) => test(`自动合并到主检出的当前分支并清理，非快进落成合并提交（任务目录${tracked ? "已" : "未"}入库）`, async (t) => {
    const { root, task, worktree, archive, deliver } = await completed(t, tracked);
    git(root, "checkout", "-qb", "delivery-target");
    autoMergeConfig(root);
    writeFileSync(join(root, "main-only.txt"), "main branch advanced\n");
    git(root, "add", "main-only.txt");
    git(root, "commit", "-qm", "advance main branch", "--only", "--", "main-only.txt");
    const head = git(root, "rev-parse", "HEAD");
    const before = [taskFiles(root, task), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain")];

    const preview = deliver({ preview: true });
    assert.equal(preview.kind, "preview");
    assert.equal(preview.mergeBranch, "delivery-target");
    assert.deepEqual(preview.preview.worktree, worktree);
    assert.deepEqual([taskFiles(root, task), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain")], before);

    const delivered = deliver();
    assert.equal(delivered.kind, "delivered");
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
    assert.equal(delivered.integration.merged, true);
    assert.equal(delivered.integration.cleanup.branch, "deleted");
  }));

  [false, true].flatMap((tracked) => ["conflict", "dirty"].map((reason) => ({ tracked, reason }))).forEach(({ tracked, reason }) => test(`自动合并失败保留交付，主检出恢复原样：${reason}（任务目录${tracked ? "已" : "未"}入库）`, async (t) => {
    const { root, task, worktree, archive, deliver } = await completed(t, tracked, false, null, "base\n");
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
    assert.equal(delivered.kind, "delivered");
    assert.deepEqual(state(), before);
    assert.equal(existsSync(join(root, ".git/MERGE_HEAD")), false);
    assert.equal(existsSync(join(root, task.dir)), false, "abort 不能把已归档的任务恢复成主检出里的旧任务");
    assert.ok(existsSync(worktree.path));
    assert.equal(git(root, "rev-parse", worktree.branch), git(worktree.path, "rev-parse", "HEAD"));
    assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
    assert.equal(git(worktree.path, "log", "-1", "--format=%B").split("\n").at(-1), `Knit-Task: ${task.id}`);
    assert.equal(delivered.integration.merged, false);
    assert.deepEqual(delivered.integration.worktree, worktree);
    assert.match(delivered.integration.error, reason === "conflict" ? /CONFLICT \(content\): Merge conflict in src\/a.txt/ : /Your local changes to the following files would be overwritten by merge:/);
    assert.deepEqual(delivered.integration.abort, reason === "conflict" ? { ok: true } : null);
  }));
});

test("应用层返回自动合并冲突的原始 Git 输出，归档与提交保留在任务分支", async (t) => {
  const { root, task, worktree, archive, message } = await completed(t, true, false, null, "base\n");
  autoMergeConfig(root);
  writeFileSync(join(root, "src/a.txt"), "main result\n");
  git(root, "commit", "-qm", "main changes same line", "--only", "--", "src/a.txt");
  const result = deliverTask(root, task.id, { authorization: "user:delivery", messageFile: message });
  assert.equal(result.kind, "delivered");
  assert.equal(result.integration.merged, false);
  assert.deepEqual(result.integration.abort, { ok: true });
  assert.match(result.integration.error, /CONFLICT \(content\): Merge conflict in src\/a.txt\n/);
  assert.deepEqual(result.integration.worktree, worktree);
  assert.equal(result.archiveRoot, worktree.path);
  assert.equal(result.archiveDir, archive);
  assert.equal(result.commit.summary, git(worktree.path, "log", "-1", "--format=%h %s"));
  assert.equal(git(root, "rev-parse", worktree.branch), git(worktree.path, "rev-parse", "HEAD"));
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(result.archiveRoot, result.archiveDir, "task.md"), "utf8"), /^status: delivered$/m);
  assert.ok((await knit(root, "context", task.id)).stdout.includes(`目录: ${join(worktree.path, archive)}\n`));
});

test("Worktree 清理拒绝不强制，未入库文件和分支保留且退出码为 0", async (t) => {
  const { root, worktree, archive, cli } = await completed(t);
  autoMergeConfig(root);
  writeFileSync(join(worktree.path, "untracked.txt"), "must not delete\n");
  const delivered = await cli();
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

test("分支清理被 Git 拒绝时保留分支，已合并和已删除 Worktree 的结果可见", async (t) => {
  const { root, worktree, deliver } = await completed(t);
  autoMergeConfig(root);
  git(root, "branch", "unmerged-upstream", worktree.branch);
  git(worktree.path, "branch", "--set-upstream-to=unmerged-upstream");
  const delivered = deliver();
  assert.equal(delivered.kind, "delivered");
  assert.equal(delivered.integration.merged, true);
  assert.equal(delivered.integration.cleanup.kind, "removed");
  assert.equal(delivered.integration.cleanup.branch, "retained");
  assert.match(delivered.integration.cleanup.error, /not fully merged/);
  assert.equal(existsSync(worktree.path), false);
  assert.ok(git(root, "branch", "--list", worktree.branch).includes(worktree.branch));
});

test("快进合并并清理，被忽略的归档留在主检出", async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, false, true);
  autoMergeConfig(root);
  git(worktree.path, "merge", "--no-edit", git(root, "rev-parse", "HEAD"));
  const head = git(root, "rev-parse", "HEAD");
  const delivered = deliver();
  assert.equal(delivered.kind, "delivered");
  assert.equal(git(root, "rev-parse", "HEAD^"), head);
  assert.equal(git(root, "log", "-1", "--format=%P").split(" ").length, 1);
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n"), ["src/a.txt"]);
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
  assert.equal(realpathSync(delivered.archiveRoot), realpathSync(root));
  assert.equal(delivered.archiveDir, archive);
  assert.equal((await knit(root, "task", "show", task.id)).code, 0);
});

test("仅忽略 archive 时预览与实际归档都在主检出，自动合并后仍能读取", async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true);
  autoMergeConfig(root);
  writeFileSync(join(worktree.path, ".gitignore"), ".knit/.runtime/\n.knit/tasks/archive/\n");
  git(worktree.path, "commit", "-qm", "ignore only archive", "--only", "--", ".gitignore");
  const preview = deliver({ preview: true }).preview;
  assert.equal(realpathSync(preview.archiveRoot), realpathSync(root));
  assert.equal(preview.commit.taskDir, false);
  const result = deliver();
  assert.equal(result.integration.cleanup.kind, "removed");
  assert.equal(git(root, "ls-tree", "HEAD", "--", task.dir), "");
  assert.equal(existsSync(worktree.path), false);
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
});

test("Worktree 切偏分支或处于 detached HEAD 时拒绝预览与交付，切回后可正常交付", async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, false);
  autoMergeConfig(root);
  const mainHead = git(root, "rev-parse", "HEAD");
  for (const args of [["-c", "other"], ["--detach"]]) {
    git(worktree.path, "switch", ...args);
    for (const options of [{ preview: true }, {}]) {
      const refused = deliver(options);
      assert.equal(refused.kind, "refused");
      assert.ok(refused.problems.join("\n").includes(`git -C '${worktree.path}' switch '${worktree.branch}'`));
    }
    assert.equal(git(root, "rev-parse", "HEAD"), mainHead);
    assert.equal(existsSync(join(root, task.dir, "task.md")), true);
    assert.equal(existsSync(worktree.path), true);
  }
  git(worktree.path, "switch", worktree.branch);
  const delivered = deliver();
  assert.equal(delivered.kind, "delivered");
  assert.equal(delivered.integration.merged, true);
  assert.equal(existsSync(join(root, archive, "task.md")), true);
});

test("回滚时主检出原位置被占用，报告两个路径并保留两侧文件", async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true);
  const old = taskFiles(worktree.path, task);
  const hooks = join(root, ".git/hooks");
  git(root, "config", "core.hooksPath", hooks);
  writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nmkdir -p '${join(root, task.dir)}'\necho occupied > '${join(root, task.dir, "keep")}'\nexit 1\n`, { mode: 0o755 });
  const result = deliver();
  assert.equal(result.kind, "rolledBack");
  assert.ok(result.rollbackProblems.some((problem) => problem.includes(join(worktree.path, archive)) && problem.includes(task.dir)));
  assert.equal(readFileSync(join(root, task.dir, "keep"), "utf8"), "occupied\n");
  assert.deepEqual(taskFiles(worktree.path, task), old);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.ok(!readdirSync(dirname(worktree.path)).some((name) => name.startsWith(".knit-delivery-")));
});

test("hook 执行期间备份在 Worktree 外，回滚冲突保留用户修改和未归位的备份", async (t) => {
  const { root, task, worktree, archive, cli } = await completed(t, true);
  const oldFiles = taskFiles(worktree.path, task);
  const head = git(worktree.path, "rev-parse", "HEAD");
  const hooks = join(root, ".git/hooks");
  git(root, "config", "core.hooksPath", hooks);
  writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh
set -eu
for d in .knit-delivery-*; do test ! -e "$d"; done
set -- ../.knit-delivery-*/task
test -f "$1/task.md"
echo 'user note' >> '${archive}/task.md'
mkdir -p '${task.dir}'
echo 'keep my file' > '${task.dir}/keep'
echo 'fixture hook refused' >&2
exit 1
`, { mode: 0o755 });
  const result = await cli();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture hook refused/);
  assert.match(result.stderr, /撤回未完成/);
  assert.match(result.stderr, /恢复到已占用/);
  assert.match(result.stderr, /task\.md 在读入之后被改过/);
  assert.doesNotMatch(result.stderr, /状态是 done/);
  assert.match(taskFiles(root, task)[0], /user note/);
  assert.equal(readFileSync(join(worktree.path, task.dir, "keep"), "utf8"), "keep my file\n");
  const backups = readdirSync(dirname(worktree.path)).filter((name) => name.startsWith(".knit-delivery-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(taskFiles(join(dirname(worktree.path), backups[0]), { dir: "task" }), oldFiles);
  assert.equal(git(worktree.path, "rev-parse", "HEAD"), head);
});

test("没有要提交的文件也合并并清理，归档仍在主检出", async (t) => {
  const { root, worktree, archive, deliver } = await completed(t, false, true);
  autoMergeConfig(root);
  rmSync(join(worktree.path, "src"), { recursive: true });
  const head = git(root, "rev-parse", "HEAD");
  const delivered = deliver();
  assert.equal(delivered.kind, "delivered");
  assert.equal(delivered.commit.kind, "nothing");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
});

["hook", "move"].forEach((reason) => test(`自动合并开着但交付撤回时不合并、不清理：${reason}`, async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true);
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
  assert.equal(refused.kind, "rolledBack");
  assert.equal(refused.reason, reason === "hook" ? "commit" : "move");
  assert.match(String(refused.error), reason === "hook" ? /delivery refused/ : /ENOTDIR/);
  assert.deepEqual([mainIdentity(root), git(worktree.path, "rev-parse", "HEAD"), taskFiles(root, task), git(worktree.path, "status", "--porcelain")], before);
  assert.equal(existsSync(join(worktree.path, archive)), false);
}));

test("autoMerge 配置不是布尔值时在归档之前拒绝", async (t) => {
  const { root, task, worktree, deliver } = await completed(t);
  autoMergeConfig(root, "true");
  const before = [mainIdentity(root), taskFiles(root, task), git(worktree.path, "status", "--porcelain")];
  const refused = deliver();
  assert.equal(refused.kind, "refused");
  assert.match(refused.problems.join("\n"), /\.knit\/config\.json：.*worktree\/autoMerge/);
  assert.deepEqual([mainIdentity(root), taskFiles(root, task), git(worktree.path, "status", "--porcelain")], before);
});

test("显式关闭 autoMerge 时交付给出可以执行的合并和清理命令", async (t) => {
  const { root, task, worktree, archive, cli } = await completed(t, false, false, tmpdir());
  autoMergeConfig(root, false);
  const before = mainIdentity(root);
  const preview = await cli("--preview");
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /^提交在任务分支上，不会合并进主检出的分支$/m);
  const delivered = await cli();
  assert.equal(delivered.code, 0, delivered.stderr);
  const lines = delivered.stdout.trimEnd().split("\n");
  const hintPrefix = "在主检出运行 ";
  const command = `git merge --no-edit '${worktree.branch}' && git worktree remove '${worktree.path.replace("test home's-", "test home'\\''s-")}' && git branch -d '${worktree.branch}'`;
  assert.deepEqual(lines, [
    `已交付 加问候语（${task.id}）`,
    `归档: ${join(worktree.path, archive)}`,
    `提交: ${git(worktree.path, "log", "-1", "--format=%h %s")}`,
    `Worktree: ${worktree.path}（${worktree.branch}）`,
    "这个提交还没有合并进主检出的分支",
    `${hintPrefix}${command}`,
  ]);
  assert.deepEqual(mainIdentity(root), before);
  assert.ok(git(root, "worktree", "list", "--porcelain").includes(`branch refs/heads/${worktree.branch}`));

  await exec("sh", ["-c", lines.at(-1).slice(hintPrefix.length)], { cwd: root });
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "worker result\n");
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
});

function newTask(root, options) {
  return createTask(root, { title: "新任务", slug: "task", verification: "self", priority: "P2", parent: null, dependsOn: [], ...options });
}

test("交付后同名任务使用新目录，取消只清理新任务", async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t);
  const delivered = deliver();
  assert.equal(delivered.kind, "delivered");
  const commit = git(root, "rev-parse", worktree.branch);
  assert.equal(existsSync(join(root, task.dir)), false);
  const created = newTask(root);
  assert.deepEqual(created.problems, []);
  assert.equal(created.created.file, `${task.dir}-2/task.md`);
  assert.equal(cancelTask(root, created.created.id, { reason: "取消新任务" }).kind, "cancelled");
  assert.equal(git(root, "rev-parse", worktree.branch), commit);
  assert.equal(git(worktree.path, "rev-parse", "HEAD"), commit);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);

  git(root, "branch", `${worktree.branch}-3`);
  mkdirSync(`${worktree.path}-4`);
  git(root, "branch", `${worktree.branch}-5/part`);
  git(root, "pack-refs", "--all");
  const packedRefs = join(root, ".git/packed-refs");
  const originalRefs = readFileSync(packedRefs);
  writeFileSync(packedRefs, "broken packed reference\n");
  const refused = newTask(root);
  writeFileSync(packedRefs, originalRefs);
  assert.equal(refused.created, null);
  assert.match(refused.problems.join("\n"), /无法读取本地任务分支/);
  assert.equal(existsSync(join(root, `${task.dir}-3`)), false);

  const next = newTask(root);
  assert.deepEqual(next.problems, []);
  assert.equal(next.created.file, `${task.dir}-6/task.md`);

  const upper = newTask(root, { title: "不同大小写", slug: "TASK" });
  assert.deepEqual(upper.problems, []);
  const upperDir = task.dir.replace(/-task$/, "-TASK");
  const caseInsensitive = existsSync(worktree.path.replace(/-task$/, "-TASK"));
  assert.equal(upper.created.file, `${upperDir}${caseInsensitive ? "-7" : ""}/task.md`);
});

describe("独立仓库中的归档查询与交付", { concurrency: 3 }, () => {
  test("合并前按 ID 读取 Worktree 归档并建立依赖，合并后优先读取主检出", async (t) => {
    const { root, task, worktree, archive, deliver } = await completed(t);
    const delivered = deliver();
    assert.equal(delivered.kind, "delivered");
    const commit = git(worktree.path, "log", "-1", "--format=%h %s");
    git(root, "config", "trailer.separators", "=");
    git(root, "commit", "-qm", "document a delivery marker", "-m", `Example:\nKnit-Task: ${task.id}\nEnd of example.`, "--allow-empty");
    for (const args of [["context"], ["task", "show"], ["run", "status"]]) {
      const result = await knit(root, ...args, task.id);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^状态: delivered$/m);
      assert.ok(result.stdout.includes(`Worktree: ${worktree.path}（${worktree.branch}）`));
      if (args[0] !== "task") assert.match(result.stdout, /^下一步: 任务已结束，可取消选中（knit context --unuse）$/m);
      if (args[0] !== "run") {
        assert.ok(result.stdout.includes(`目录: ${join(worktree.path, archive)}\n`), result.stdout);
        assert.ok(result.stdout.includes(`提交: ${commit}\n`), result.stdout);
      }
    }
    assert.deepEqual(scanTasks(root), []);
    const refused = cancelTask(root, task.id, { reason: "已交付" });
    assert.equal(refused.kind, "refused");
    assert.match(refused.problems.join("\n"), /delivered/);
    assert.equal(git(worktree.path, "status", "--porcelain"), "");

    const child = newTask(root, { title: "子任务", parent: task.id, dependsOn: [task.id] });
    assert.deepEqual(child.problems, []);
    const childId = child.created.id;
    assert.equal(confirmTask(root, childId).kind, "ready");
    const blocked = await knit(root, "run", "start", childId);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.stderr.includes(`git merge --no-edit '${worktree.branch}'`), blocked.stderr);

    git(root, "merge", "--no-edit", worktree.branch);
    const shown = await knit(root, "task", "show", task.id);
    assert.equal(shown.code, 0, shown.stderr);
    assert.ok(shown.stdout.includes(`目录: ${archive}\n`), shown.stdout);
    assert.ok(shown.stdout.includes(`提交: ${commit}\n`), shown.stdout);
    assert.equal(scanTasks(root).filter((stored) => stored.archived && stored.id === task.id).length, 1);
  });

  test("任务 Worktree 在预期位置保留目录链接时仍能按 ID 读取归档", async (t) => {
    const { root, task, worktree, archive, deliver } = await completed(t);
    const delivered = deliver();
    assert.equal(delivered.kind, "delivered");
    const moved = join(root, "moved-checkout");
    git(root, "worktree", "move", worktree.path, moved);
    symlinkSync(moved, worktree.path, "dir");

    const context = await knit(root, "context", task.id);
    assert.equal(context.code, 0, context.stderr);
    assert.ok(context.stdout.includes(`目录: ${join(worktree.path, archive)}\n`), context.stdout);
    assert.ok(context.stdout.includes(`提交: ${git(moved, "log", "-1", "--format=%h %s")}\n`), context.stdout);
  });

  test("派发过的任务只在任务分支提交代码和归档，主检出 HEAD 不变", async (t) => {
    const { root, task, worktree, archive, cli } = await completed(t);
    const main = mainIdentity(root);
    const taskHead = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "other.txt"), "unrelated\n");
    git(worktree.path, "add", "other.txt");
    writeFileSync(join(root, "main-only.txt"), "main change\n");

    const delivered = await cli();

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
    assert.equal(delivered.stdout, [
      `已交付 加问候语（${task.id}）`,
      `归档: ${join(worktree.path, archive)}`,
      `提交: ${git(worktree.path, "log", "-1", "--format=%h %s")}`,
      `Worktree: ${worktree.path}（${worktree.branch}）`,
      "这个提交还没有合并进主检出的分支",
      `在主检出运行 git merge --no-edit '${worktree.branch}' && git worktree remove '${worktree.path}' && git branch -d '${worktree.branch}'`,
      "",
    ].join("\n"));
    assert.ok(git(root, "worktree", "list", "--porcelain").includes(`branch refs/heads/${worktree.branch}`));
  });
});

[false, true].flatMap((tracked) => [false, true].map((crossDevice) => ({ tracked, crossDevice }))).forEach(({ tracked, crossDevice }) => test(`任务分支 hook 拒绝时原样撤回（任务目录${tracked ? "已" : "未"}入库${crossDevice ? "，跨文件系统" : ""}）`, { skip: crossDevice ? crossDeviceSkip : false }, async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, tracked, false, crossDevice ? crossDeviceDir : null);
  const hooks = join(root, ".git/hooks");
  git(root, "config", "core.hooksPath", hooks);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho \"hook branch: $(git branch --show-current)\" >&2\necho 'worker lint failed' >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  const state = () => [mainIdentity(root), git(worktree.path, "rev-parse", "HEAD"), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain"), taskFiles(root, task), ...(tracked ? [taskFiles(worktree.path, task)] : [])];
  const before = state();

  const refused = deliver();

  assert.equal(refused.kind, "rolledBack");
  assert.equal(refused.reason, "commit");
  assert.equal(refused.taskDir, task.dir);
  assert.match(refused.error, /^worker lint failed$/m);
  assert.ok(String(refused.error).split("\n").includes(`hook branch: ${worktree.branch}`), String(refused.error));
  assert.deepEqual(state(), before);
  assert.equal(git(worktree.path, "diff", "--cached", "--name-only"), "");
  assert.match(readFileSync(join(root, task.dir, "task.md"), "utf8"), /^status: done$/m);
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, ".knit/tasks/archive")), false);
  assert.equal(existsSync(join(worktree.path, task.dir)), tracked);
}));

[false, true].forEach((tracked) => test(`归档上级不是目录时原样撤回并可以重试（任务目录${tracked ? "已" : "未"}入库）`, async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, tracked);
  mkdirSync(join(worktree.path, ".knit/tasks"), { recursive: true });
  writeFileSync(join(worktree.path, ".knit/tasks/archive"), "blocks archive directory\n");
  const state = () => [mainIdentity(root), git(worktree.path, "rev-parse", "HEAD"), git(root, "status", "--porcelain"), git(worktree.path, "status", "--porcelain"), taskFiles(root, task), ...(tracked ? [taskFiles(worktree.path, task)] : [])];
  const before = state();

  const refused = deliver();

  assert.equal(refused.kind, "rolledBack");
  assert.equal(refused.reason, "move");
  assert.equal(refused.taskDir, task.dir);
  assert.match(String(refused.error), /ENOTDIR/);
  assert.deepEqual(state(), before);
  assert.equal(JSON.parse(taskFiles(root, task)[1]).authorization, null);
  assert.equal(git(worktree.path, "diff", "--cached", "--name-only"), "");
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, task.dir)), tracked);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  rmSync(join(worktree.path, ".knit/tasks/archive"));
  const retried = deliver();
  assert.equal(retried.kind, "delivered");
}));

test("被忽略的任务目录留在主检出归档，合并并删除 Worktree 后仍读得出", async (t) => {
  const { root, task, worktree, archive, cli } = await completed(t, false, true);
  const before = [taskFiles(root, task), git(worktree.path, "status", "--porcelain")];
  const preview = await cli("--preview");
  assert.equal(preview.code, 0, preview.stderr);
  assert.ok(preview.stdout.includes(`归档: ${task.dir} → ${join(realpathSync(root), archive)}\n`), preview.stdout);
  assert.ok(preview.stdout.includes(`Worktree: ${worktree.path}（${worktree.branch}）\n`), preview.stdout);
  assert.equal(preview.stdout.includes("（整个目录，移到归档的位置）"), false);
  assert.deepEqual([taskFiles(root, task), git(worktree.path, "status", "--porcelain")], before);

  const delivered = await cli();

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.ok(delivered.stdout.includes(`归档: ${join(realpathSync(root), archive)}\n`), delivered.stdout);
  assert.deepEqual(git(worktree.path, "show", "--name-only", "--format=", "HEAD").split("\n"), ["src/a.txt"]);
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.ok((await knit(root, "task", "show", task.id)).stdout.includes(`提交: ${git(worktree.path, "log", "-1", "--format=%h %s")}\n`));
  git(root, "merge", worktree.branch);
  git(root, "worktree", "remove", worktree.path);
  assert.match(readFileSync(join(root, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(JSON.parse(readFileSync(join(root, archive, "record.json"), "utf8")).authorization, "user:delivery");
  const shown = await knit(root, "task", "show", task.id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /delivered/);
});

test("旧任务目录无法移到备份位置时原样撤回", async (t) => {
  const { root, task, worktree, deliver } = await completed(t, true);
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  chmodSync(join(worktree.path, ".knit/tasks"), 0o555);
  const refused = deliver();
  chmodSync(join(worktree.path, ".knit/tasks"), 0o755);
  assert.equal(refused.kind, "rolledBack");
  assert.match(String(refused.error), /EACCES/);
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  const retried = deliver();
  assert.equal(retried.kind, "delivered");
});

test("归档目标已被非空目录占用时保留原目录并撤回", async (t) => {
  const { root, task, worktree, archive, cli } = await completed(t, true);
  mkdirSync(join(worktree.path, archive), { recursive: true });
  writeFileSync(join(worktree.path, archive, "existing.txt"), "leave this alone\n");
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  const refused = await cli();
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  const [cause, ...notice] = refused.stderr.trimEnd().split("\n");
  assert.match(cause, /ENOTEMPTY|EEXIST/);
  assert.deepEqual(notice, [`移动任务目录失败，交付已经撤回：任务目录仍在原位置 ${task.dir}，状态是 done`]);
  assert.match(taskFiles(root, task)[0], /^status: done$/m);
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readFileSync(join(worktree.path, archive, "existing.txt"), "utf8"), "leave this alone\n");
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
});

test("旧任务目录有只读子目录时交付成功且清掉临时副本", async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true);
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
  assert.equal(delivered.kind, "delivered");
  assert.deepEqual(mainIdentity(root), main);
  assert.equal(git(worktree.path, "rev-list", "--count", `${head}..HEAD`), "1");
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(git(worktree.path, "status", "--porcelain"), "");
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
});

[false, true].forEach((tracked) => test(`跨文件系统交付代码和归档（任务目录${tracked ? "已" : "未"}入库）`, { skip: crossDeviceSkip }, async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, tracked, false, crossDeviceDir);
  const head = git(worktree.path, "rev-parse", "HEAD");
  const main = mainIdentity(root);
  assert.notEqual(statSync(root).dev, statSync(worktree.path).dev);
  const delivered = deliver();
  assert.equal(delivered.kind, "delivered");
  assert.deepEqual(mainIdentity(root), main);
  assert.equal(git(worktree.path, "rev-list", "--count", `${head}..HEAD`), "1");
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.ok(git(worktree.path, "show", "--name-only", "--format=", "HEAD").includes(`${archive}/task.md`));
  assert.ok(git(worktree.path, "show", "--name-only", "--format=", "HEAD").includes("src/a.txt"));
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
}));

test("跨文件系统复制失败清掉半份目标并恢复旧任务目录，可以重试", { skip: crossDeviceSkip }, async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true, false, crossDeviceDir);
  const unreadable = join(root, task.dir, "z-unreadable.txt");
  writeFileSync(unreadable, "cannot copy\n");
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  chmodSync(unreadable, 0o000);
  const refused = deliver();
  chmodSync(unreadable, 0o644);
  assert.equal(refused.kind, "rolledBack");
  assert.match(String(refused.error), /EACCES/);
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readFileSync(unreadable, "utf8"), "cannot copy\n");
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, ".knit/tasks/archive")), false);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  const retried = deliver();
  assert.equal(retried.kind, "delivered");
});

test("跨文件系统删除源只完成一部分时补回源并撤回", { skip: crossDeviceSkip }, async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true, false, crossDeviceDir);
  const protectedDir = join(root, task.dir, "z-protected");
  mkdirSync(protectedDir);
  writeFileSync(join(protectedDir, "keep.txt"), "source must remain complete\n");
  chmodSync(join(protectedDir, "keep.txt"), 0o444);
  const before = [taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")];
  chmodSync(protectedDir, 0o555);
  const refused = deliver();
  assert.equal(statSync(protectedDir).mode & 0o777, 0o555);
  chmodSync(protectedDir, 0o755);
  assert.equal(refused.kind, "rolledBack");
  assert.match(String(refused.error), /EACCES|ENOTEMPTY/);
  assert.ok(String(refused.error).includes(realpathSync(join(root, task.dir))), String(refused.error));
  assert.deepEqual([taskFiles(root, task), taskFiles(worktree.path, task), git(worktree.path, "status", "--porcelain"), git(worktree.path, "rev-parse", "HEAD")], before);
  assert.equal(readFileSync(join(protectedDir, "keep.txt"), "utf8"), "source must remain complete\n");
  assert.equal(existsSync(join(worktree.path, archive)), false);
  assert.equal(existsSync(join(worktree.path, ".knit/tasks/archive")), false);
  assert.equal(readdirSync(worktree.path).some((name) => name.startsWith(".knit-delivery-")), false);
  const retried = deliver();
  assert.equal(retried.kind, "delivered");
});

test("系统临时目录在另一个文件系统时已入库任务仍能交付", { skip: crossDeviceSkip }, async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = crossDeviceDir;
  const delivered = deliver();
  if (previous === undefined) delete process.env.TMPDIR;
  if (previous !== undefined) process.env.TMPDIR = previous;
  assert.equal(delivered.kind, "delivered");
  assert.equal(existsSync(join(root, task.dir)), false);
  assert.match(readFileSync(join(worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(readdirSync(crossDeviceDir).some((name) => name.startsWith("knit-delivery-")), false);
});

test("已入库任务目录在任务分支删除原位置，主检出当前内容归档后可以合并", async (t) => {
  const { root, task, worktree, archive, deliver } = await completed(t, true);
  const currentTask = readFileSync(join(root, task.dir, "task.md"), "utf8");
  assert.notEqual(readFileSync(join(worktree.path, task.dir, "task.md"), "utf8"), currentTask);
  const main = mainIdentity(root);

  const delivered = deliver();

  assert.equal(delivered.kind, "delivered");
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
