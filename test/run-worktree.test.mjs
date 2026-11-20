import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/application/config.js";
import { executeRun } from "../dist/application/run-execute.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { commitAll, git } from "./helpers/git.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";
import { nodeCommand, setupConfig } from "./helpers/setup.mjs";

const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const workflowOf = (root) => parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
const expectedWorktree = (root, task) => join(process.env.KNIT_HOME, "worktrees",
  `${basename(realpathSync(root))}-${createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 8)}`, basename(task.dir));
const branchOf = (task) => `knit/${basename(task.dir)}`;
const filesOf = (root, task) => ["task.md", "record.json"].map((file) => readFileSync(join(root, task.dir, file), "utf8"));
const lastRun = (root, task) => JSON.parse(filesOf(root, task)[1]).runs.at(-1);
const prepare = (root, task, extra = {}) => prepareRun({ root, taskId: task.id, workflow: workflowOf(root), config: loadConfig(root).config, model: null, ...extra });
const finish = (root, task, run) => finishRun({ root, taskId: task.id, runId: run.id, workflow: workflowOf(root), verdict: null, failure: null, sessionFile: null });
function script(t, contents) {
  const file = join(process.env.KNIT_HOME, "pi-script.json");
  const previous = process.env.KNIT_FAKE_PI;
  process.env.KNIT_FAKE_PI = file;
  t.after(() => {
    if (previous === undefined) delete process.env.KNIT_FAKE_PI;
    if (previous !== undefined) process.env.KNIT_FAKE_PI = previous;
  });
  writeFileSync(file, JSON.stringify(contents));
}
const execute = (root, task, run) => executeRun({ root, taskId: task.id, runId: run.id, workflow: workflowOf(root), model: run.model, piExecutable: FAKE_PI });

async function waitUntil(done) {
  const deadline = Date.now() + 10000;
  while (!done() && Date.now() < deadline) await sleep(20);
  assert.ok(done(), "执行者没有写出文件");
}

test("执行者写入任务 Worktree；主检出分支和 HEAD 不变，记录相对路径", async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const main = [git(root, "branch", "--show-current"), git(root, "rev-parse", "HEAD")];
  writeFileSync(join(root, "main-only.txt"), "尚未提交\n");
  writeFileSync(join(root, ".knit/agents/implement.md"), "主检出的当前角色\n");
  writeFileSync(join(root, ".knit/workflow.yaml"), readFileSync(join(root, ".knit/workflow.yaml"), "utf8").replace("fake/model", "fake/current-main"));
  mkdirSync(join(root, ".knit/standards"));
  writeFileSync(join(root, ".knit/standards/main.md"), "---\ntitle: 当前规范\nstages: [implement]\n---\n主检出的当前规范\n");
  writeFileSync(join(root, ".knit/config.json"), '{"handoff":{"fileBytes":16384,"totalBytes":65536}}');
  const { run, problems } = prepare(root, task);
  assert.deepEqual(problems, []);
  assert.equal(run.model, "fake/current-main");
  const system = readFileSync(join(root, RUNS_DIR, run.id, "system.md"), "utf8");
  assert.match(system, /主检出的当前角色/);
  assert.match(system, /主检出的当前规范/);
  script(t, { writes: [{ path: "src/a.txt", content: "worktree only\n" }] });
  assert.deepEqual(await execute(root, task, run), []);
  const worktree = expectedWorktree(root, task);
  assert.equal(readFileSync(join(worktree, "src/a.txt"), "utf8"), "worktree only\n");
  assert.equal(git(worktree, "branch", "--show-current"), branchOf(task));
  assert.equal(existsSync(join(root, "src/a.txt")), false);
  assert.deepEqual([git(root, "branch", "--show-current"), git(root, "rev-parse", "HEAD")], main);
  assert.equal(lastRun(root, task).failure, null);
  assert.deepEqual(lastRun(root, task).changedPaths, ["src/a.txt"]);
  assert.equal(existsSync(join(worktree, task.dir)), false);
  assert.equal(existsSync(join(worktree, RUNS_DIR)), false);
  assert.equal(existsSync(join(worktree, "main-only.txt")), false);
  assert.equal(existsSync(join(worktree, ".knit/config.json")), false);
  assert.equal(readFileSync(join(worktree, ".knit/agents/implement.md"), "utf8"), "你是实现环节的执行者。\n");
  assert.equal(readFileSync(join(root, "main-only.txt"), "utf8"), "尚未提交\n");
});

test("执行期间主检出的受保护文件和无关文件不算执行者改动", async (t) => {
  const root = runProject(t);
  mkdirSync(join(root, ".knit/standards"));
  writeFileSync(join(root, ".knit/standards/a.md"), "---\ntitle: 规范\nstages: [implement]\n---\n原规范\n");
  commitAll(root, "standard");
  const task = readyTask(root);
  const { run } = prepare(root, task);
  const gate = join(process.env.KNIT_HOME, "go");
  script(t, { writes: [{ path: "src/a.txt", content: "worker\n" }], waitFor: gate });
  const execution = execute(root, task, run);
  await waitUntil(() => existsSync(join(expectedWorktree(root, task), "src/a.txt")) || existsSync(join(root, "src/a.txt")));
  writeFileSync(join(root, ".knit/standards/a.md"), "主会话修改\n");
  writeFileSync(join(root, "unrelated.txt"), "user\n");
  writeFileSync(gate, "");
  assert.deepEqual(await execution, []);
  assert.equal(lastRun(root, task).failure, null);
  assert.deepEqual(lastRun(root, task).changedPaths, ["src/a.txt"]);
});

test("下个环节和返工复用同一 Worktree，执行者看得到上轮文件", async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const first = prepare(root, task).run;
  script(t, { writes: [{ path: "src/a.txt", content: "first\n" }] });
  assert.deepEqual(await execute(root, task, first), []);
  const second = prepare(root, task).run;
  assert.equal(second.stage.id, "review");
  script(t, { commands: [[process.execPath, "-e", 'require("node:fs").writeFileSync("seen.txt", require("node:fs").readFileSync("src/a.txt"))']], texts: ['```json\n{"verdict":"changes_requested"}\n```'] });
  assert.deepEqual(await execute(root, task, second), []);
  const worktree = expectedWorktree(root, task);
  assert.equal(readFileSync(join(worktree, "seen.txt"), "utf8"), "first\n");
  assert.equal(prepare(root, task).run.stage.id, "implement");
  assert.equal(git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line === `branch refs/heads/${branchOf(task)}`).length, 1);
});

test("目录删掉而分支还在时，prune 后按原任务分支重新检出", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const first = prepare(root, task).run;
  assert.deepEqual(finish(root, task, first), []);
  const worktree = expectedWorktree(root, task);
  // 分支上已有提交的夹具模拟原分支进度；不改真实项目的历史。
  writeFileSync(join(worktree, "saved.txt"), "saved\n");
  commitAll(worktree, "saved progress");
  const head = git(worktree, "rev-parse", "HEAD");
  rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.deepEqual(prepare(root, task).problems, []);
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(worktree, "saved.txt"), "utf8"), "saved\n");
  assert.equal(git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line === `branch refs/heads/${branchOf(task)}`).length, 1);
});

test("其它派发条件没通过时不建 Worktree 或任务分支", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const before = filesOf(root, task);
  assert.equal(prepare(root, task, { model: "invalid" }).run, null);
  rmSync(join(root, ".knit/agents/implement.md"));
  assert.equal(prepare(root, task).run, null);
  assert.equal(existsSync(expectedWorktree(root, task)), false);
  assert.deepEqual(filesOf(root, task), before);
  assert.equal(git(root, "branch", "--list", branchOf(task)), "");
});

test("Git 建 Worktree 失败时原样报错，不登记执行", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const worktree = expectedWorktree(root, task);
  // 分支已在另一个目录检出：真实 Git 拒绝重复检出。
  const occupied = join(process.env.KNIT_HOME, "occupied");
  git(root, "worktree", "add", "-b", branchOf(task), occupied, "HEAD");
  const error = spawnSync("git", ["worktree", "add", worktree, branchOf(task)], { cwd: root, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stderr.trimEnd();
  const before = filesOf(root, task);
  const refused = prepare(root, task);
  assert.equal(refused.run, null);
  assert.deepEqual(refused.problems, [error]);
  assert.deepEqual(filesOf(root, task), before);
  assert.equal(existsSync(join(root, RUNS_DIR)), false);
});

test("预期位置被普通非空目录占用时保留原文件，Git 拒绝且不登记执行", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const worktree = expectedWorktree(root, task);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "keep.txt"), "keep\n");
  const before = filesOf(root, task);
  const refused = prepare(root, task);
  assert.equal(refused.run, null);
  assert.match(refused.problems.join("\n"), /already exists/);
  assert.deepEqual(filesOf(root, task), before);
  assert.equal(readFileSync(join(worktree, "keep.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(join(root, RUNS_DIR)), false);
});

test("没有提交的仓库拒绝派发并提示先提交一次", (t) => {
  const root = project(t);
  git(root, "init", "-q");
  assert.equal(knit(root, "init").code, 0);
  const task = readyTask(root);
  const before = filesOf(root, task);
  const refused = prepare(root, task, { model: "fake/model" });
  assert.equal(refused.run, null);
  assert.match(refused.problems.join("\n"), /先提交一次/);
  assert.deepEqual(filesOf(root, task), before);
  assert.equal(existsSync(join(process.env.KNIT_HOME, "worktrees")), false);
  assert.equal(existsSync(join(root, RUNS_DIR)), false);
});

test("Worktree 定位解析主检出符号链接，状态和每轮上下文逐字稳定", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const link = join(process.env.KNIT_HOME, "项目链接");
  symlinkSync(root, link, "dir");
  assert.deepEqual(prepare(link, task).problems, []);
  const line = `Worktree: ${expectedWorktree(root, task)}（${branchOf(task)}）`;
  const status = knit(root, "run", "status", task.id);
  assert.equal(status.code, 0, status.stderr);
  assert.ok(status.stdout.split("\n").includes(line), status.stdout);
  assert.deepEqual(knit(link, "run", "status", task.id), status);
  const context = knit(root, "context", task.id);
  assert.ok(context.stdout.split("\n").includes(line), context.stdout);
  assert.deepEqual(knit(root, "context", task.id), context);
});

test("相对 KNIT_HOME 按主检出定位，快照、执行和状态使用同一绝对路径", async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  process.env.KNIT_HOME = realpathSync(process.env.KNIT_HOME);
  const worktree = expectedWorktree(root, task);
  script(t, { writes: [{ path: "src/a.txt", content: "relative home\n" }] });
  process.env.KNIT_HOME = relative(realpathSync(root), process.env.KNIT_HOME);

  const { run, problems } = prepare(root, task);
  assert.deepEqual(problems, []);
  assert.equal(run.worktree.path, worktree);
  assert.deepEqual(await execute(root, task, run), []);
  assert.equal(readFileSync(join(worktree, "src/a.txt"), "utf8"), "relative home\n");
  assert.equal(existsSync(join(root, "src/a.txt")), false);
  assert.equal(lastRun(root, task).failure, null);
  assert.deepEqual(lastRun(root, task).changedPaths, ["src/a.txt"]);
  const line = `Worktree: ${worktree}（${branchOf(task)}）`;
  assert.ok(knit(root, "run", "status", task.id).stdout.split("\n").includes(line));
  assert.ok(knit(root, "context", task.id).stdout.split("\n").includes(line));
});

test("目录丢失后重新运行准备命令，原分支提交和旧执行记录保留", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const first = prepare(root, task).run;
  assert.deepEqual(finish(root, task, first), []);
  const worktree = expectedWorktree(root, task);
  writeFileSync(join(worktree, "saved.txt"), "original progress");
  commitAll(worktree, "saved progress");
  const head = git(worktree, "rev-parse", "HEAD");
  rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  setupConfig(root, [nodeCommand("require('node:fs').writeFileSync('rebuilt.txt', require('node:fs').readFileSync('saved.txt'))")]);
  const rebuilt = prepare(root, task);
  assert.deepEqual(rebuilt.problems, []);
  assert.equal(readFileSync(join(worktree, "rebuilt.txt"), "utf8"), "original progress");
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.equal(JSON.parse(filesOf(root, task)[1]).runs[0].id, first.id);
});

test("重建目录的准备命令失败时强制撤回新目录，但不删已有分支和旧执行记录", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const first = prepare(root, task).run;
  assert.deepEqual(finish(root, task, first), []);
  const worktree = expectedWorktree(root, task);
  writeFileSync(join(worktree, "saved.txt"), "original progress");
  commitAll(worktree, "saved progress");
  const head = git(worktree, "rev-parse", "HEAD");
  rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  setupConfig(root, [nodeCommand("require('node:fs').writeFileSync('unfinished.txt', 'unfinished'); process.exit(24)")]);
  const before = filesOf(root, task);
  const refused = prepare(root, task);
  assert.equal(refused.run, null);
  assert.match(refused.problems.join("\n"), /退出码[：: ]+24/);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(root, "rev-parse", branchOf(task)), head);
  assert.deepEqual(filesOf(root, task), before);
  assert.equal(existsSync(join(root, first.dir, "before.json")), true);
  setupConfig(root, [nodeCommand("require('node:fs').writeFileSync('ready.txt', 'ready')")]);
  assert.deepEqual(prepare(root, task).problems, []);
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(worktree, "ready.txt"), "utf8"), "ready");
});

["需求没确认", "依赖没完成", "有执行在跑", "没有模型", "没有提交", "资料不存在", "资料没提交", "角色文件不存在"].forEach((reason) => {
  test(`准备命令不在其它拒绝条件下运行：${reason}`, (t) => {
    const root = reason === "没有提交" ? project(t) : runProject(t);
    if (reason === "没有提交") {
      git(root, "init", "-q");
      assert.equal(knit(root, "init").code, 0);
    }
    const dependency = reason === "依赖没完成" ? readyTask(root) : null;
    const task = readyTask(root, reason === "依赖没完成" ? { dependsOn: [dependency.id] } : {});
    if (reason === "有执行在跑") assert.deepEqual(prepare(root, task).problems, []);
    if (reason === "需求没确认") {
      const path = join(root, task.dir, "task.md");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n改过的需求\n`);
    }
    if (reason === "资料不存在" || reason === "资料没提交") {
      if (reason === "资料没提交") writeFileSync(join(root, "new-material.md"), "new material");
      const path = join(root, task.dir, "task.md");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n- \`new-material.md\` — 资料\n`);
      assert.equal(knit(root, "task", "ready", task.id).code, 0);
    }
    if (reason === "角色文件不存在") rmSync(join(root, ".knit/agents/implement.md"));
    if (reason === "没有模型") {
      const provider = process.env.PI_PROVIDER;
      const model = process.env.PI_MODEL;
      delete process.env.PI_PROVIDER;
      delete process.env.PI_MODEL;
      t.after(() => {
        if (provider !== undefined) process.env.PI_PROVIDER = provider;
        if (model !== undefined) process.env.PI_MODEL = model;
      });
    }
    setupConfig(root, [nodeCommand("require('node:fs').writeFileSync(require('node:path').join(process.env.KNIT_HOME, 'setup-ran'), 'bad')")]);
    assert.notEqual(loadConfig(root).config, null);
    const before = filesOf(root, task);
    const trees = git(root, "worktree", "list", "--porcelain");
    const refused = prepare(root, task, {
      model: reason === "没有提交" ? "fake/model" : null,
      ...(reason === "没有模型" ? { workflow: { ...workflowOf(root), stages: workflowOf(root).stages.map((stage) => ({ ...stage, model: null })) } } : {}),
    });
    assert.equal(refused.run, null);
    assert.equal(existsSync(join(process.env.KNIT_HOME, "setup-ran")), false);
    assert.equal(existsSync(expectedWorktree(root, task)), reason === "有执行在跑");
    assert.equal(git(root, "branch", "--list", branchOf(task)), reason === "有执行在跑" ? `+ ${branchOf(task)}` : "");
    assert.equal(git(root, "worktree", "list", "--porcelain"), trees);
    assert.deepEqual(filesOf(root, task), before);
  });
});

test("主会话直接完成任务不建 Worktree", (t) => {
  const root = runProject(t);
  const task = readyTask(root, { verification: "self" });
  assert.equal(knit(root, "task", "close", task.id, "--result", "直接完成").code, 0);
  assert.equal(existsSync(join(process.env.KNIT_HOME, "worktrees")), false);
  assert.doesNotMatch(knit(root, "run", "status", task.id).stdout, /Worktree:/);
});
