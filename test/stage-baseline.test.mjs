/**
 * 阶段基线冻结与边界核对（任务 k-a8ace0d90676）。
 * 真实 Git／worker 子进程与最小 Pi RPC 假实现；不调用真实模型。
 * 覆盖：阶段内提交 → head_moved_during_stage；写 .git/hooks 或 .knit/.runtime/checks → protected_runtime_modified；
 * 写 ignored 目录 → ignoredChanges 非空且正常接收；基线写入 run 状态；index 变化只记录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { captureStageBaseline, inspectStageBoundary, protectedRuntimeReason } from "../dist/application/stage-baseline.js";
import { isRunSettled } from "./helpers/run-settled.mjs";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");

let counter = 0x5b0000;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-baseline-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\nnode_modules/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  return { store, locks, tasks, coordinator };
}

async function readyTask(dir, s, title, verification = "independent") {
  const task = await s.tasks.newTask({ dir, title, slug: title.replace(/\s+/g, "-"), verification });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function prepareInput(dir, taskId, phase) {
  return {
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
  };
}

async function startRun(s, dir, taskId, phase, action) {
  const prepared = await s.coordinator.prepare(prepareInput(dir, taskId, phase));
  // 动作文件放在项目外，避免它本身成为工作区改动。
  const actionPath = join(dir, "..", `${prepared.request.runId}-action.json`);
  writeFileSync(actionPath, JSON.stringify(action));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
  assert.equal(started.confirmed, true, started.launch.lastError ?? "");
  return { runId: prepared.request.runId, actionPath };
}

async function waitTerminal(s, dir, runId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await s.coordinator.status({ dir, runId });
    if (isRunSettled(status)) return status;
    if (Date.now() > deadline) throw new Error(`run 未终止: ${status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function taskStage(dir, task) {
  const file = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
  return parseTaskDocument(readFileSync(file, "utf8"), file).frontmatter.stage;
}

function cleanup(s, dir, extra = []) {
  s.store.close();
  for (const path of extra) rmSync(path, { force: true });
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

test("阶段内提交 → head_moved_during_stage：带提交列表，不接收、不并入 scope，任务不前进", async () => {
  const dir = project("commit");
  const s = services(dir);
  const extra = [];
  try {
    const task = await readyTask(dir, s, "阶段内提交", "self");
    const baseHead = git(dir, ["rev-parse", "HEAD"]).trim();
    const run = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "h.txt", content: "hidden\n" }],
      exec: [
        ["git", "add", "h.txt"],
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "in-stage"],
      ],
      report: { summary: "提交了 h.txt", changedPaths: [] },
    });
    extra.push(run.actionPath);
    const status = await waitTerminal(s, dir, run.runId);
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(head, baseHead, "夹具确实在阶段内产生了提交");
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "head_moved_during_stage");
    assert.equal(status.result.baseline.head, baseHead);
    assert.equal(status.result.baseline.symbolicRef, "refs/heads/main");
    assert.equal(status.result.boundary.headMoved, true);
    assert.deepEqual(status.result.boundary.commits, [head]);
    // 改动按基线提交计算：阶段内提交过的路径也出现在实际差异里。
    assert.deepEqual(status.result.actualChangedPaths, ["h.txt"]);
    assert.equal(taskStage(dir, task), "implement", "任务不前进");
    const runs = new RunStore(dir);
    assert.equal(runs.readScope(task.taskId)?.entries.some((entry) => entry.path === "h.txt") ?? false, false, "不并入 scope");
    assert.equal(runs.readCompletion(task.taskId), null, "self 任务没有完成凭据");
    // run 状态记录基线。
    assert.equal(runs.readState(run.runId).baseline.head, baseHead);
    // 现场保留：提交不回滚。
    assert.equal(existsSync(join(dir, "h.txt")), true);
    // run status 人读输出显示阶段内提交。
    const text = execFileSync(process.execPath, [CLI, "run", "status", run.runId, "--dir", dir, "--locks", join(dir, ".locks")], { encoding: "utf8" });
    assert.match(text, /阶段内提交: 1 个/);
  } finally {
    delete process.env.KNIT_FAKE_ACTION;
    cleanup(s, dir, extra);
  }
});

test("写 .git/hooks/pre-commit → protected_runtime_modified，任务不前进", async () => {
  const dir = project("hook");
  const s = services(dir);
  const extra = [];
  try {
    const task = await readyTask(dir, s, "写 hook");
    const run = await startRun(s, dir, task.taskId, "implement", {
      writes: [
        { path: "README.md", content: "# changed\n" },
        { path: ".git/hooks/pre-commit", content: "#!/bin/sh\necho pwned\n" },
      ],
      report: { summary: "改 README", changedPaths: ["README.md"] },
    });
    extra.push(run.actionPath);
    const status = await waitTerminal(s, dir, run.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "protected_runtime_modified:.git/hooks/pre-commit");
    assert.deepEqual(status.result.boundary.protectedPaths, [".git/hooks/pre-commit"]);
    assert.equal(status.result.boundary.headMoved, false);
    assert.equal(taskStage(dir, task), "implement");
    assert.equal(new RunStore(dir).readScope(task.taskId)?.entries.length ?? 0, 0);
  } finally {
    delete process.env.KNIT_FAKE_ACTION;
    cleanup(s, dir, extra);
  }
});

test("写 .knit/.runtime/checks/x.json → protected_runtime_modified，任务不前进", async () => {
  const dir = project("checks");
  const s = services(dir);
  const extra = [];
  try {
    const task = await readyTask(dir, s, "伪造检查凭据");
    const run = await startRun(s, dir, task.taskId, "implement", {
      writes: [
        { path: "README.md", content: "# changed\n" },
        { path: ".knit/.runtime/checks/x.json", content: "{}\n" },
      ],
      report: { summary: "改 README", changedPaths: ["README.md"] },
    });
    extra.push(run.actionPath);
    const status = await waitTerminal(s, dir, run.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "protected_runtime_modified:.knit/.runtime/checks/x.json");
    assert.equal(taskStage(dir, task), "implement");
  } finally {
    delete process.env.KNIT_FAKE_ACTION;
    cleanup(s, dir, extra);
  }
});

test("写 ignored 目录 → ignoredChanges 非空，run 正常接收；index 变化只记录", async () => {
  const dir = project("ignored");
  const s = services(dir);
  const extra = [];
  try {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "keep.js"), "keep\n");
    const task = await readyTask(dir, s, "写忽略区");
    const run = await startRun(s, dir, task.taskId, "implement", {
      writes: [
        { path: "README.md", content: "# changed\n" },
        { path: "node_modules/x.js", content: "x\n" },
      ],
      exec: [["git", "add", "README.md"]],
      report: { summary: "改 README", changedPaths: ["README.md"] },
    });
    extra.push(run.actionPath);
    const status = await waitTerminal(s, dir, run.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? "");
    assert.equal(status.acceptance.state, "completed");
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"]);
    assert.ok(status.result.ignoredChanges.length > 0, "ignoredChanges 非空");
    assert.deepEqual(status.result.ignoredChanges, [{ path: "node_modules/", change: "modified" }]);
    assert.equal(status.result.boundary.indexChanged, true, "暂存变化写进结果");
    assert.equal(status.result.boundary.headMoved, false);
    assert.deepEqual(status.result.boundary.protectedPaths, []);
    assert.equal(taskStage(dir, task), "check", "正常接收并前进");
    const text = execFileSync(process.execPath, [CLI, "status", "--run", run.runId, "--dir", dir, "--locks", join(dir, ".locks")], { encoding: "utf8" });
    assert.match(text, /忽略区变化（仅报告）: node_modules\/\(modified\)/);
  } finally {
    delete process.env.KNIT_FAKE_ACTION;
    cleanup(s, dir, extra);
  }
});

test("边界核对单元：活动 run 与本 run 目录、会话目录不计；终态 run 资料与 .git/config 改动被发现", () => {
  const dir = project("unit");
  try {
    const runtime = join(dir, ".knit", ".runtime");
    const own = "run-00000000aa01";
    const active = "run-00000000aa02";
    const settled = "run-00000000aa03";
    for (const [runId, state] of [[own, "running"], [active, "running"], [settled, "completed"]]) {
      mkdirSync(join(runtime, "runs", runId), { recursive: true });
      writeFileSync(join(runtime, "runs", runId, "state.json"), JSON.stringify({ state, reason: null }));
      writeFileSync(join(runtime, "runs", runId, "result.json"), "{}\n");
    }
    const context = { executionDir: dir, root: dir, runId: own, taskId: "k-000000000001" };
    const baseline = captureStageBaseline(context);
    assert.ok(baseline !== null);
    writeFileSync(join(runtime, "runs", own, "result.json"), "{\"own\":1}\n");
    writeFileSync(join(runtime, "runs", active, "result.json"), "{\"active\":1}\n");
    mkdirSync(join(runtime, "pi-sessions"), { recursive: true });
    writeFileSync(join(runtime, "pi-sessions", "s.jsonl"), "{}\n");
    mkdirSync(join(runtime, "task-list"), { recursive: true });
    writeFileSync(join(runtime, "task-list", "cache"), "x\n");
    const clean = inspectStageBoundary(baseline, context);
    assert.deepEqual(clean.facts.protectedPaths, []);

    writeFileSync(join(runtime, "runs", settled, "result.json"), "{\"forged\":1}\n");
    git(dir, ["config", "core.hooksPath", "/tmp/evil"]);
    writeFileSync(join(runtime, "installation.json"), "{}\n");
    const dirty = inspectStageBoundary(baseline, context);
    assert.deepEqual(dirty.facts.protectedPaths, [
      ".git/config",
      `.knit/.runtime/installation.json`,
      `.knit/.runtime/runs/${settled}/result.json`,
    ]);
    assert.equal(
      protectedRuntimeReason(dirty.facts.protectedPaths),
      `protected_runtime_modified:.git/config,.knit/.runtime/installation.json,.knit/.runtime/runs/${settled}/result.json`,
    );
    const many = Array.from({ length: 25 }, (_, index) => `.git/hooks/h${index}`);
    assert.match(protectedRuntimeReason(many), /,…\(\+5\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
