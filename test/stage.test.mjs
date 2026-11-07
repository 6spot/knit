/**
 * 013 阶段执行、接收、检查失效、修复计数与恢复测试。
 * 使用真实 Git／文件／worker 子进程和最小 Pi RPC 假实现，不调用真实模型。
 */
import { isProcessAlive, isRunSettled } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { StatusService } from "../dist/application/status-service.js";
import { atomicWrite, readWithVersion } from "../dist/infrastructure/atomic.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";
import { parseStageReport } from "../dist/application/stage.js";
import { PiAgentRuntime } from "../dist/adapters/pi/runtime.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const ACCEPT_ONCE = join(import.meta.dirname, "fixtures", "accept-once.mjs");

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-013-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\nignored.txt\n.locks/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({
    store,
    randomHex,
    lockRoot: join(dir, ".locks"),
    confirmTimeoutMs: 8000,
  });
  const acceptance = new RunAcceptanceService({ store, locks, randomHex });
  return { store, locks, tasks, coordinator, acceptance };
}

async function readyTask(dir, s, title = "阶段任务") {
  const task = await s.tasks.newTask({ dir, title, slug: title.replace(/\s+/g, "-"), verification: "independent" });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function model() {
  return { runtime: "pi", provider: "fake", model: "fake-model" };
}

function prepareInput(dir, taskId, phase = "implement", extra = {}) {
  return {
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: model(),
    ...extra,
  };
}

function actionFile(dir, action) {
  const path = join(dir, ".fake-action.json");
  writeFileSync(path, JSON.stringify(action));
  return path;
}

async function startRun(s, dir, taskId, phase, action, extra = {}, prepareExtra = {}) {
  const prepared = await s.coordinator.prepare(prepareInput(dir, taskId, phase, { ...extra, ...prepareExtra }));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionFile(dir, action);
  const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
  assert.equal(started.confirmed, true);
  return { ...prepared, started, runId: prepared.request.runId };
}

async function waitTerminal(s, dir, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await s.coordinator.status({ dir, runId });
    if (isRunSettled(status)) return status;
    if (Date.now() > deadline) throw new Error(`run 未终止: ${status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function resultFixture(request, state, report, actualChangedPaths = []) {
  return {
    schemaVersion: 1,
    runId: request.runId,
    taskId: request.taskId,
    phase: request.phase,
    state,
    report,
    reportSummary: report?.summary ?? null,
    nativeEntries: { startEntryId: null, leafEntryId: null },
    usage: { inputTokens: null, outputTokens: null },
    session: null,
    actualChangedPaths,
    acceptanceOperationId: request.acceptanceOperationId,
    recordedAt: new Date().toISOString(),
    failureReason: state === "failed" ? "synthetic_failure" : null,
  };
}

test("implement→check 独立会话；结果与原生范围保存，重复接收幂等", async () => {
  const dir = project("flow");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# changed by implement\n" }],
      report: { summary: "修改 README", changedPaths: ["README.md"] },
    });
    const implStatus = await waitTerminal(s, dir, impl.runId);
    assert.equal(implStatus.state, "completed");
    assert.equal(implStatus.result.state, "completed");
    assert.equal(implStatus.acceptance.state, "completed");
    assert.deepEqual(implStatus.result.actualChangedPaths, ["README.md"]);
    assert.equal(implStatus.result.usage.inputTokens, 100);
    assert.equal(implStatus.result.usage.outputTokens, 20);
    assert.ok(implStatus.result.nativeEntries.startEntryId);
    assert.ok(implStatus.result.nativeEntries.leafEntryId);
    assert.equal(implStatus.result.session.status, "available");
    assert.equal(implStatus.result.session.nativeReadable, true);

    let binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.lastRunIds.includes(impl.runId), true);
    assert.equal(binding.scope[0].path, "README.md");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "check");

    const duplicate = await s.acceptance.accept({ dir, runId: impl.runId });
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await s.store.bindings.get(task.taskId)).lastRunIds.length, 1);

    const check = await startRun(s, dir, task.taskId, "check", {
      report: { summary: "核对 README 与完成条件", verdict: "pass", coverage: ["README.md"], findings: [], unverified: [] },
    });
    const checkStatus = await waitTerminal(s, dir, check.runId);
    assert.equal(checkStatus.state, "completed");
    assert.equal(checkStatus.result.report.verdict, "pass");
    assert.notEqual(checkStatus.result.session.nativeSessionId, implStatus.result.session.nativeSessionId);
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "checks", `${check.runId}.json`)), true);
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "deliver");
    binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.lastCheckRunId, check.runId);
    assert.equal(binding.confirmedInputsDigest.length, 64);
    const checkFile = new RunStore(dir).readCheck(check.runId);
    const plan = await new ContextPlanner({ store: s.store, randomHex }).plan({ dir, taskId: task.taskId, role: "check" });
    assert.equal(checkFile.inputsDigest, plan.inputsDigest);
    assert.equal(binding.confirmedInputsDigest, plan.inputsDigest);

    // 关闭后的旧回执只读：重复接收不重开任务，也不改写结束 outcome。
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.status, "closed");
    const oldReceipt = await s.acceptance.accept({ dir, runId: impl.runId });
    assert.equal(oldReceipt.accepted, true);
    assert.equal(oldReceipt.duplicate, true);
    const afterClose = parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile);
    assert.equal(afterClose.frontmatter.status, "closed");
    assert.equal(afterClose.frontmatter.outcome, "completed");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("接收检查点：Task 已写而 binding 失败时重入收敛，不重复推进或重跑", async () => {
  const dir = project("accept-journal");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "仅准备" } });
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    writeFileSync(join(dir, "README.md"), "# journal\n");
    const runs = new RunStore(dir);
    runs.writeResult(prepared.request.runId, resultFixture(prepared.request, "completed", {
      summary: "已写入结果",
      changedPaths: ["README.md"],
    }, ["README.md"]));
    const started = { request: prepared.request, runId: prepared.request.runId };

    // 独立进程执行第一次接收；binding 失败后进程退出，Task 已写、检查点保留。
    const child = spawnSync(process.execPath, [ACCEPT_ONCE, dir, started.runId], { encoding: "utf8" });
    assert.equal(child.status, 2, child.stderr);
    const rejected = JSON.parse(child.stdout.trim());
    assert.equal(rejected.accepted, false);
    assert.match(rejected.reason, /^acceptance_recovery_failed:/);
    assert.match(rejected.reason, /injected binding failure in child/);
    const journalPath = join(dir, ".knit", ".runtime", "runs", started.runId, "acceptance.json");
    assert.equal(existsSync(journalPath), true, "失败必须留下恢复检查点");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "check");
    assert.equal((await s.store.operations.get(started.request.acceptanceOperationId)).state, "needs_attention");

    const second = new RunAcceptanceService({ store: s.store, locks: s.locks, randomHex });
    const recovered = await second.accept({ dir, runId: started.runId });
    assert.equal(recovered.accepted, true, recovered.reason ?? "");
    assert.equal(recovered.reason, "implementation_accepted");
    assert.equal(existsSync(journalPath), false);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.lastRunIds.includes(started.runId), true);
    assert.equal(binding.lastRunIds.length, 1);
    assert.equal(binding.scope[0].path, "README.md");
    assert.equal((await s.store.operations.get(started.request.acceptanceOperationId)).state, "completed");

    const duplicate = await second.accept({ dir, runId: started.runId });
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await s.store.bindings.get(task.taskId)).lastRunIds.length, 1);

    // 检查接收同样在检查点重入：check 文件先落盘，task／binding 后失败可恢复。
    const checkPrepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check"));
    await s.coordinator.start({ dir, runId: checkPrepared.request.runId, prepareOnly: true });
    runs.writeResult(checkPrepared.request.runId, resultFixture(checkPrepared.request, "completed", {
      summary: "检查通过",
      verdict: "pass",
      coverage: ["README.md"],
    }));
    let checkFailed = false;
    const checkBindings = {
      ...s.store.bindings,
      save: async (binding) => {
        if (!checkFailed) {
          checkFailed = true;
          throw new Error("injected check binding failure");
        }
        return s.store.bindings.save(binding);
      },
    };
    const checkStore = new Proxy(s.store, {
      get(target, property, receiver) {
        if (property === "bindings") return checkBindings;
        return Reflect.get(target, property, receiver);
      },
    });
    const checkFirst = await new RunAcceptanceService({ store: checkStore, locks: s.locks, randomHex }).accept({
      dir,
      runId: checkPrepared.request.runId,
    });
    assert.equal(checkFirst.accepted, false);
    const checkFile = join(dir, ".knit", ".runtime", "checks", `${checkPrepared.request.runId}.json`);
    assert.equal(existsSync(checkFile), true);
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "deliver");
    const checkRecovered = await second.accept({ dir, runId: checkPrepared.request.runId });
    assert.equal(checkRecovered.accepted, true, checkRecovered.reason ?? "");
    assert.equal(checkRecovered.phase, "deliver");
    const checked = await s.store.bindings.get(task.taskId);
    assert.equal(checked.lastCheckRunId, checkPrepared.request.runId);
    assert.equal(checked.lastRunIds.length, 2);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查修复的接收检查点可重入：scope 并入与检查凭据不重复写", async () => {
  const dir = project("check-repair-journal");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check"));
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    // 检查者落盘修复后再发布结果，模拟接收前实际改动。
    writeFileSync(join(dir, "README.md"), "# checked repair\n");
    const runs = new RunStore(dir);
    runs.writeResult(prepared.request.runId, resultFixture(prepared.request, "completed", {
      summary: "检查修复",
      verdict: "pass",
      coverage: ["README.md"],
      changedPaths: ["README.md"],
      selfVerified: true,
    }, ["README.md"]));

    let bindingFailed = false;
    const bindings = {
      ...s.store.bindings,
      save: async (binding) => {
        if (!bindingFailed) {
          bindingFailed = true;
          throw new Error("injected check repair binding failure");
        }
        return s.store.bindings.save(binding);
      },
    };
    const store = new Proxy(s.store, {
      get(target, property, receiver) {
        if (property === "bindings") return bindings;
        return Reflect.get(target, property, receiver);
      },
    });
    const first = await new RunAcceptanceService({ store, locks: s.locks, randomHex }).accept({
      dir,
      runId: prepared.request.runId,
    });
    assert.equal(first.accepted, false);
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "runs", prepared.request.runId, "acceptance.json")), true);
    // 检查点已含并入后的 scope；重入不应清空既有条目或重复写 check。
    const scopeAfterFailure = runs.readScope(task.taskId);
    assert.deepEqual(scopeAfterFailure?.entries.map((entry) => entry.path), ["README.md"]);
    assert.ok(scopeAfterFailure?.runIds.includes(impl.runId));
    assert.ok(scopeAfterFailure?.runIds.includes(prepared.request.runId));

    const recovered = await s.acceptance.accept({ dir, runId: prepared.request.runId });
    assert.equal(recovered.accepted, true, recovered.reason ?? "");
    assert.equal(recovered.phase, "deliver");
    const binding = await s.store.bindings.get(task.taskId);
    assert.deepEqual((binding.scope ?? []).map((entry) => entry.path), ["README.md"]);
    assert.ok(binding.scopeRunIds?.includes(prepared.request.runId));
    const scope = runs.readScope(task.taskId);
    const checkFile = runs.readCheck(prepared.request.runId);
    assert.equal(checkFile?.scopeDigest, scope?.digest);
    assert.equal(binding.lastCheckRunId, prepared.request.runId);
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "runs", prepared.request.runId, "acceptance.json")), false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("任务关闭后迟到结果只保留事实，不隐式重开", async () => {
  const dir = project("late-result");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "仅准备" } });
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    writeFileSync(join(dir, "README.md"), "# late\n");
    const runs = new RunStore(dir);
    runs.writeResult(prepared.request.runId, resultFixture(prepared.request, "completed", {
      summary: "迟到结果",
      changedPaths: ["README.md"],
    }, ["README.md"]));
    // 不用 runActivity 的显式管理命令模拟人在 run 未收敛时关闭；迟到接收本身必须拒绝重开。
    const admin = new TaskService({ store: s.store, locks: s.locks, randomHex });
    await admin.close({ dir, taskId: task.taskId, outcome: "cancelled", runsSettled: true });
    const accepted = await s.acceptance.accept({ dir, runId: prepared.request.runId });
    assert.equal(accepted.accepted, false);
    const taskFile = join(dir, ".knit", task.relativePath);
    const after = parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile);
    assert.equal(after.frontmatter.status, "closed");
    assert.equal(after.frontmatter.outcome, "cancelled");
    assert.equal(after.frontmatter.stage, "implement");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活动 run 未收敛时 task close 拒绝；任务服务按真实 run 仓储保存草案", async () => {
  const dir = project("close-race");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "仅准备" } });
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    await assert.rejects(
      () => s.tasks.close({ dir, taskId: task.taskId, outcome: "cancelled", runsSettled: true }),
      (error) => /runs_unsettled|活动|收敛/.test(error.message),
    );
    const updated = await s.tasks.update({
      dir,
      taskId: task.taskId,
      kind: "clarify",
      reason: "活动 run 中补充",
      content: "## 目标与边界\n\n补充\n",
      runActive: false,
      updateOperationId: "op-close-race",
    });
    assert.equal(updated.applied, "pending_saved", "真实 run 仓储覆盖调用方自报的 runActive=false");
    assert.equal(parseTaskDocument(readFileSync(join(dir, ".knit", task.relativePath), "utf8"), join(dir, ".knit", task.relativePath)).frontmatter.stage, "implement");
    // 活动 run 中可撤回草案，输入与阶段不被改变。
    const withdrawn = await s.tasks.update({
      dir,
      taskId: task.taskId,
      expectPending: updated.pendingDraftDigest,
      withdrawReason: "活动 run 中撤回",
    });
    assert.equal(withdrawn.applied, "pending_withdrawn");
    assert.equal((await s.store.bindings.get(task.taskId)).pendingDraft, null);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查可在既定范围内修复：改动落盘、接收并入 scope，完成资格仍有效", async () => {
  const dir = project("check-repair");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const runs = new RunStore(dir);
    const check = await startRun(s, dir, task.taskId, "check", {
      writes: [
        { path: "README.md", content: "# fixed by checker\n" },
        { path: "src/fix.txt", content: "fix\n" },
      ],
      report: {
        summary: "修复范围内缺陷",
        verdict: "pass",
        coverage: ["README.md"],
        changedPaths: ["README.md", "src/fix.txt"],
        selfVerified: true,
        findings: ["README 说明与实际不符"],
        unverified: [],
      },
    });
    const status = await waitTerminal(s, dir, check.runId);
    assert.equal(status.state, "completed", status.result.failureReason ?? "");
    assert.equal(status.acceptance.reason, "check_pass");
    assert.deepEqual(status.result.actualChangedPaths, ["README.md", "src/fix.txt"]);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# fixed by checker\n");

    const binding = await s.store.bindings.get(task.taskId);
    assert.deepEqual((binding.scope ?? []).map((entry) => entry.path), ["README.md", "src/fix.txt"]);
    assert.ok(binding.scopeRunIds?.includes(check.runId));
    const scope = runs.readScope(task.taskId);
    assert.equal(scope?.entries.find((entry) => entry.path === "README.md")?.digest?.length, 64);
    const checkFile = runs.readCheck(check.runId);
    assert.deepEqual(checkFile?.changedPaths, ["README.md", "src/fix.txt"]);
    assert.equal(checkFile?.selfVerified, true);
    assert.equal(checkFile?.scopeDigest, scope?.digest, "检查凭据绑定并入后的 scope 摘要");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "deliver");

    // independent 完成资格仍由最新 pass 检查支撑，修复后的 scope 指纹已纳入。
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.status, "closed");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查 changes_requested 的落盘修复也并入 scope，避免后续指纹漂移", async () => {
  const dir = project("check-repair-partial");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const runs = new RunStore(dir);
    const check = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "README.md", content: "# partial fix\n" }],
      report: {
        summary: "已修复一部分，仍需实施调整",
        verdict: "changes_requested",
        coverage: ["README.md"],
        changedPaths: ["README.md"],
        selfVerified: true,
      },
    });
    const status = await waitTerminal(s, dir, check.runId);
    assert.equal(status.state, "completed", status.result.failureReason ?? "");
    assert.equal(status.acceptance.reason, "check_changes_requested");
    const scope = runs.readScope(task.taskId);
    assert.equal(scope?.entries.find((entry) => entry.path === "README.md")?.digest?.length, 64);
    const checkFile = runs.readCheck(check.runId);
    assert.equal(checkFile?.scopeDigest, scope?.digest);
    assert.deepEqual(checkFile?.changedPaths, ["README.md"]);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "implement");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查报告 changedPaths 缺失或与实际不符时拒绝，Task 不被推进", async () => {
  const dir = project("check-paths");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);

    const mismatch = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "README.md", content: "# checked\n" }],
      report: { summary: "检查", verdict: "pass", coverage: ["README.md"], changedPaths: ["other.txt"] },
    });
    const mismatchStatus = await waitTerminal(s, dir, mismatch.runId);
    assert.equal(mismatchStatus.state, "failed");
    assert.equal(mismatchStatus.result.failureReason, "changed_paths_mismatch:README.md");
    assert.deepEqual(mismatchStatus.result.actualChangedPaths, ["README.md"]);

    // 恢复检查前内容，验证有实际修改但漏报 changedPaths 也被拒绝。
    writeFileSync(join(dir, "README.md"), "# impl\n");
    const missing = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "README.md", content: "# checked-2\n" }],
      report: { summary: "检查", verdict: "pass", coverage: ["README.md"] },
    });
    const missingStatus = await waitTerminal(s, dir, missing.runId);
    assert.equal(missingStatus.state, "failed");
    assert.equal(missingStatus.result.failureReason, "report_changed_paths_missing");

    const runs = new RunStore(dir);
    assert.equal(runs.readCheck(mismatch.runId), null);
    assert.equal(runs.readCheck(missing.runId), null);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.lastCheckRunId, null);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "check");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查修改 .knit 元数据仍被拒绝", async () => {
  const dir = project("check-protected");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const protectedPath = ".knit/standards/release.md";
    const check = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: protectedPath, content: "# 检查者改规范\n" }],
      report: { summary: "检查", verdict: "pass", coverage: ["README.md"], changedPaths: [protectedPath] },
    });
    const status = await waitTerminal(s, dir, check.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, `protected_path_modified:${protectedPath}`);
    assert.equal(parseTaskDocument(readFileSync(join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md"), "utf8")).frontmatter.stage, "check");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取消终态且无 result 的 run 不把取消意图当完成，也不阻塞 task close", async () => {
  const dir = project("cancel-no-result");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "取消无结果");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    const runs = new RunStore(dir);
    const now = new Date().toISOString();
    runs.writeState(prepared.request.runId, {
      schemaVersion: 1,
      runId: prepared.request.runId,
      taskId: task.taskId,
      phase: "implement",
      state: "cancelled",
      worker: { workerId: "w-000000000001", pid: process.pid, bootId: "boot", procStartTicks: null, hostname: "test" },
      claimedAt: now,
      updatedAt: now,
      prepared: true,
      preparedAt: now,
      snapshot: null,
      reason: null,
    });
    assert.equal((await s.tasks.close({ dir, taskId: task.taskId, outcome: "cancelled", runsSettled: true })).status, "closed");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("报告改动路径与实际不符时不接收，失败原因带实际路径清单", async () => {
  const dir = project("mismatch");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [
        { path: "alpha.txt", content: "a\n" },
        { path: "notes.txt", content: "n\n" },
      ],
      report: { summary: "声称完成", changedPaths: ["other.txt"] },
    });
    const status = await waitTerminal(s, dir, impl.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "changed_paths_mismatch:alpha.txt,notes.txt");
    assert.deepEqual(status.result.actualChangedPaths, ["alpha.txt", "notes.txt"]);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "implement");
    assert.equal((await s.store.bindings.get(task.taskId)).scope, undefined);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("树基线已含改动时重派为零 diff，失败原因标注 zero_diff", async () => {
  const dir = project("zero-diff");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    // 第一次实施真实写入 README，但报告了错误路径：拒绝并保留实际改动在树中。
    const first = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# actual\n" }],
      report: { summary: "报告路径错误", changedPaths: ["other.txt"] },
    });
    const firstStatus = await waitTerminal(s, dir, first.runId);
    assert.equal(firstStatus.state, "failed");
    assert.equal(firstStatus.result.failureReason, "changed_paths_mismatch:README.md");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# actual\n");

    // 未还原基线即重派：本次观察不到差异，正确拒绝并明确标注 zero_diff。
    const second = await startRun(s, dir, task.taskId, "implement", {
      report: { summary: "重派", changedPaths: ["README.md"] },
    });
    const secondStatus = await waitTerminal(s, dir, second.runId);
    assert.equal(secondStatus.state, "failed");
    assert.equal(secondStatus.result.failureReason, "changed_paths_mismatch:zero_diff");
    assert.deepEqual(secondStatus.result.actualChangedPaths, []);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "implement");
    assert.equal((await s.store.bindings.get(task.taskId)).scope, undefined);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changes_requested→修复→重查两轮后停止，不自动开始第三轮", async () => {
  const dir = project("repair");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    let binding = await s.store.bindings.get(task.taskId);
    await s.store.bindings.save({ ...binding, repairCycleId: "rep-cycle-test", repairRounds: 0, stopReason: null });

    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# r0\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);

    for (let round = 1; round <= 2; round += 1) {
      const check = await startRun(s, dir, task.taskId, "check", {
        report: { summary: `检查第${round}轮`, verdict: "changes_requested", coverage: ["README.md"] },
      });
      const status = await waitTerminal(s, dir, check.runId);
      assert.equal(status.state, "completed");
      binding = await s.store.bindings.get(task.taskId);
      assert.equal(binding.repairRounds, round);
      assert.equal(binding.stopReason, round === 2 ? "repair_round_limit" : null);
      if (round === 2) break;
      const fix = await startRun(s, dir, task.taskId, "implement", {
        writes: [{ path: "README.md", content: `# r${round}\n` }],
        report: { summary: `修复第${round}轮`, changedPaths: ["README.md"] },
      });
      await waitTerminal(s, dir, fix.runId);
    }

    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(dir, task.taskId, "implement")),
      (error) => error.guardReason === "repair_stopped",
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("阶段 maxVisits：回退进入超过上限时接收需人工处理并写 repair_round_limit", async () => {
  const dir = project("stage-visits");
  const s = services(dir);
  try {
    writeFileSync(join(dir, ".knit", "workflow.yaml"), [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    maxVisits: 0",
      "  - id: check",
      "    report:",
      "      verdict: [pass, changes_requested, blocked]",
      "      coverage: string[]",
      "    onVerdict:",
      "      changes_requested: implement",
      "      blocked: check",
      "",
    ].join("\n"));
    const task = await readyTask(dir, s);
    let binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.stageVisits.implement, 1, "首次进入实施阶段计入访问");

    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# visits\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "check");

    // changes_requested 要回退进入 implement（maxVisits: 0 不允许第二次进入）。
    const check = await startRun(s, dir, task.taskId, "check", {
      report: { summary: "要求修复", verdict: "changes_requested", coverage: ["README.md"] },
    });
    const status = await waitTerminal(s, dir, check.runId);
    // 接收被拒绝：run 收敛为 acceptance_repair_round_limit，结论留在 acceptance 供人工处理。
    assert.equal(status.state, "failed");
    assert.equal(status.reason, "acceptance_repair_round_limit");
    assert.equal(status.acceptance.state, "needs_attention");
    assert.equal(status.acceptance.reason, "repair_round_limit");
    binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.stopReason, "repair_round_limit");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "check", "超限不推进阶段");

    // 重试接收保持同结论，不重复累计或越过上限。
    const retry = await s.acceptance.accept({ dir, runId: check.runId });
    assert.equal(retry.accepted, false);
    assert.equal(retry.reason, "repair_round_limit");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("自定义阶段：按声明校验报告、按配置流转并累计访问", async () => {
  const dir = project("custom-stage");
  const s = services(dir);
  try {
    writeFileSync(join(dir, ".knit", "workflow.yaml"), [
      "version: 1",
      "stages:",
      "  - id: build",
      "    name: 构建",
      "    description: 按任务完成实现",
      "    report:",
      "      changedPaths: paths",
      "  - id: verify",
      "    name: 验收",
      "    description: 独立核对实现成果",
      "    report:",
      "      verdict: [pass, fail]",
      "      coverage: string[]",
      "    onVerdict:",
      "      fail: build",
      "",
    ].join("\n"));
    const task = await readyTask(dir, s, "自定义阶段");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "build");

    const plan = await new ContextPlanner({ store: s.store, randomHex }).plan({ dir, taskId: task.taskId, stage: "build" });
    assert.match(plan.stageBrief, /流程：准备 → 构建 → 验收 → 收尾 ｜ 当前：构建/);
    assert.match(plan.stageBrief, /本步目标：按任务完成实现/);
    assert.match(plan.stageBrief, /完成条件：完成后 → 验收/);

    const build = await startRun(s, dir, task.taskId, "build", {
      writes: [{ path: "README.md", content: "# custom build\n" }],
      report: { summary: "构建完成", changedPaths: ["README.md"] },
    });
    const built = await waitTerminal(s, dir, build.runId);
    assert.equal(built.state, "completed", built.result?.failureReason ?? built.reason ?? "");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "verify");
    assert.equal((await s.store.bindings.get(task.taskId)).stageVisits.build, 1);

    // 结论字段由阶段声明决定：缺 verdict 时失败，不借用旧固定字段放行。
    const missing = await startRun(s, dir, task.taskId, "verify", {
      report: { summary: "缺少结论", coverage: ["README.md"] },
    });
    const missingStatus = await waitTerminal(s, dir, missing.runId);
    assert.equal(missingStatus.state, "failed");
    assert.equal(missingStatus.result.failureReason, "report_verdict_missing");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "verify");

    const verify = await startRun(s, dir, task.taskId, "verify", {
      report: { summary: "验收通过", verdict: "pass", coverage: ["README.md"] },
    });
    const verified = await waitTerminal(s, dir, verify.runId);
    assert.equal(verified.state, "completed", verified.result?.failureReason ?? verified.reason ?? "");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "deliver");
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "checks", `${verify.runId}.json`)), true);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.stageVisits.verify, 1);
    assert.equal(binding.lastCheckRunId, verify.runId);

    // 自定义检查阶段写的凭据可用于独立完成资格；不要求阶段 id 叫 check。
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.status, "closed");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置在 prepare 后降级：在途 run 继续完成并记录 fallback 模式", async () => {
  const dir = project("fallback-inflight");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "降级在途");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    assert.equal(prepared.request.workflowMode, "config");
    // prepare 之后配置损坏：worker 读取降级流程，但在途 run 仍应完成。
    writeFileSync(join(dir, ".knit", "workflow.yaml"), "version: 2\nstages: []\n");
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# fallback in flight\n" }],
      report: { summary: "降级实现", changedPaths: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? status.reason ?? "");
    assert.equal(status.result.workflowMode, "fallback");
    assert.equal(new RunStore(dir).readState(prepared.request.runId)?.workflowMode, "fallback");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "deliver");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const FROZEN_WORKFLOW = [
  "version: 1",
  "stages:",
  "  - id: build",
  "    name: 构建",
  "    description: 按任务完成实现",
  "    prompt: .knit/prompts/build.md",
  "    tools: [read, exec]",
  "    report:",
  "      changedPaths: paths",
  "      evidence: string[]",
  "  - id: verify",
  "    name: 验收",
  "    description: 独立核对实现成果",
  "    prompt: .knit/prompts/verify.md",
  "    tools: [read]",
  "    report:",
  "      verdict: [pass, fail]",
  "      coverage: string[]",
  "    onVerdict:",
  "      fail: build",
  "",
].join("\n");

const BROKEN_WORKFLOW = "version: 2\nstages: []\n";

function clearFakeStageEnv() {
  delete process.env.KNIT_FAKE_ARGS_FILE;
  delete process.env.KNIT_FAKE_PROMPT_FILE;
}

/** 测试钩子文件放在 gitignore 的运行目录，不污染阶段实际 diff。 */
function hookPath(dir, name) {
  return join(dir, ".knit", ".runtime", name);
}

test("配置在 prepare 后降级：自定义提示词／能力／报告按冻结定义执行", async () => {
  const dir = project("fallback-frozen-build");
  const s = services(dir);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  try {
    mkdirSync(join(dir, ".knit", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".knit", "prompts", "build.md"), "# 自定义构建提示词\n\n只构建任务范围内文件。\n");
    writeFileSync(join(dir, ".knit", "prompts", "verify.md"), "# 自定义验收提示词\n\n按冻结声明核对。\n");
    writeFileSync(workflowFile, FROZEN_WORKFLOW);
    const task = await readyTask(dir, s, "冻结构建");

    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "build"));
    assert.equal(prepared.request.workflowMode, "config");
    assert.equal(prepared.request.stageDefinition.id, "build");
    assert.equal(prepared.request.stageDefinition.prompt, ".knit/prompts/build.md");
    assert.deepEqual(prepared.request.stageDefinition.tools, ["read", "exec"]);
    assert.deepEqual(prepared.request.stageDefinition.report, {
      changedPaths: "paths",
      evidence: "string[]",
    });
    assert.equal(prepared.request.stageDefinition.decision, false);
    assert.deepEqual(prepared.request.toolPolicy.capabilities, ["read", "exec"]);

    // prepare 之后配置损坏：worker 读取降级流程，但本 run 仍按冻结定义执行。
    writeFileSync(workflowFile, BROKEN_WORKFLOW);
    const argvFile = hookPath(dir, "fake-argv-build.json");
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ARGS_FILE = argvFile;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# frozen build\n" }],
      report: { summary: "构建完成", changedPaths: ["README.md"], evidence: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? status.reason ?? "");
    assert.equal(status.result.workflowMode, "fallback");

    // 冻结提示词参与输入身份：摘要与 prepare 一致，且自定义提示词进入系统提示。
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.match(argValue(argv, "--append-system-prompt") ?? "", /自定义构建提示词/);
    // 冻结能力：降级后仍只给 read／exec 展开的工具，不放宽为全部工具。
    assert.equal(argValue(argv, "--tools"), "read,grep,find,ls,bash");
    assert.equal(argv.includes("--no-extensions"), true);

    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "deliver");
  } finally {
    clearFakeStageEnv();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools: [] 全部禁用：工具策略为空能力，Pi 启动参数含 --no-tools；all 不传工具开关", async () => {
  const dir = project("tools-disabled");
  const s = services(dir);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  try {
    writeFileSync(workflowFile, [
      "version: 1",
      "stages:",
      "  - id: build",
      "    tools: []",
      "  - id: verify",
      "    tools: all",
      "",
    ].join("\n"));
    const task = await readyTask(dir, s, "禁用工具");

    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "build"));
    assert.deepEqual(prepared.request.stageDefinition.tools, []);
    assert.deepEqual(prepared.request.toolPolicy, {
      mode: "read",
      allow: [],
      deny: ["write", "edit", "bash"],
      capabilities: [],
    });
    const argvFile = hookPath(dir, "fake-argv-disabled.json");
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ARGS_FILE = argvFile;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "无工具" } });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? status.reason ?? "");
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    for (const flag of ["--no-tools", "--offline", "--no-mcp", "--no-skills", "--no-extensions"]) {
      assert.equal(argv.includes(flag), true, `全部禁用应带 ${flag}`);
    }
    assert.equal(argv.includes("--tools"), false);

    const verify = await s.coordinator.prepare(prepareInput(dir, task.taskId, "verify"));
    assert.equal(verify.request.stageDefinition.tools, null, "all 归一为全部放开");
    assert.equal(verify.request.toolPolicy.capabilities, null);
    const allArgv = hookPath(dir, "fake-argv-all.json");
    process.env.KNIT_FAKE_ARGS_FILE = allArgv;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "全部放开" } });
    assert.equal((await s.coordinator.start({ dir, runId: verify.request.runId })).confirmed, true);
    const verifyStatus = await waitTerminal(s, dir, verify.request.runId);
    assert.equal(verifyStatus.state, "completed", verifyStatus.result?.failureReason ?? verifyStatus.reason ?? "");
    const verifyArgv = JSON.parse(readFileSync(allArgv, "utf8"));
    assert.equal(verifyArgv.includes("--tools"), false);
    assert.equal(verifyArgv.includes("--no-tools"), false);
  } finally {
    clearFakeStageEnv();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置在 prepare 后降级：自定义结论阶段按冻结定义接收并落到收尾", async () => {
  const dir = project("fallback-frozen-verify");
  const s = services(dir);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  try {
    mkdirSync(join(dir, ".knit", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".knit", "prompts", "build.md"), "# 自定义构建提示词\n");
    writeFileSync(join(dir, ".knit", "prompts", "verify.md"), "# 自定义验收提示词\n\n按冻结声明核对。\n");
    writeFileSync(workflowFile, FROZEN_WORKFLOW);
    const task = await readyTask(dir, s, "冻结验收");

    // 构建在 config 流程下完成，任务进入 verify。
    const build = await startRun(s, dir, task.taskId, "build", {
      writes: [{ path: "README.md", content: "# verified build\n" }],
      report: { summary: "构建完成", changedPaths: ["README.md"], evidence: ["README.md"] },
    });
    const buildStatus = await waitTerminal(s, dir, build.runId);
    assert.equal(buildStatus.state, "completed", buildStatus.result?.failureReason ?? buildStatus.reason ?? "");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "verify");

    // prepare 验收时仍为 config；随后配置降级，接收必须按冻结的 verify 定义判断结论阶段。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "verify"));
    assert.equal(prepared.request.stageDefinition.id, "verify");
    assert.equal(prepared.request.stageDefinition.decision, true);
    assert.equal(prepared.request.stageDefinition.prompt, ".knit/prompts/verify.md");
    assert.deepEqual(prepared.request.stageDefinition.tools, ["read"]);
    assert.deepEqual(prepared.request.stageDefinition.report, {
      verdict: ["pass", "fail"],
      coverage: "string[]",
    });

    writeFileSync(workflowFile, BROKEN_WORKFLOW);
    const argvFile = hookPath(dir, "fake-argv-verify.json");
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ARGS_FILE = argvFile;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      report: { summary: "验收通过", verdict: "pass", coverage: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? status.reason ?? "");
    assert.equal(status.result.report.verdict, "pass");
    assert.equal(status.result.workflowMode, "fallback");

    // 冻结验收提示词被读取，冻结只读能力生效。
    const verifyArgv = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.match(argValue(verifyArgv, "--append-system-prompt") ?? "", /自定义验收提示词/);
    assert.equal(argValue(verifyArgv, "--tools"), "read,grep,find,ls");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "deliver");

    // 自定义结论阶段在降级后仍写检查凭据：task close 不出现 check_missing 死路。
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "checks", `${prepared.request.runId}.json`)), true);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.lastCheckRunId, prepared.request.runId);
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.status, "closed");
  } finally {
    clearFakeStageEnv();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置在 prepare 后降级：自定义实施结果仍进入上一实施上下文", async () => {
  const dir = project("fallback-frozen-prev");
  const s = services(dir);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  try {
    mkdirSync(join(dir, ".knit", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".knit", "prompts", "build.md"), "# 自定义构建提示词\n");
    writeFileSync(join(dir, ".knit", "prompts", "verify.md"), "# 自定义验收提示词\n");
    writeFileSync(workflowFile, FROZEN_WORKFLOW);
    const task = await readyTask(dir, s, "冻结上下文");

    const build = await startRun(s, dir, task.taskId, "build", {
      writes: [{ path: "README.md", content: "# previous implement\n" }],
      report: { summary: "上一轮构建完成", changedPaths: ["README.md"], evidence: ["README.md"] },
    });
    assert.equal((await waitTerminal(s, dir, build.runId)).state, "completed");

    // verify 在 config 下冻结，随配置降级；上一轮 build 的请求也带冻结定义。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "verify"));
    writeFileSync(workflowFile, BROKEN_WORKFLOW);
    const promptFile = hookPath(dir, "fake-prompt-verify.txt");
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_PROMPT_FILE = promptFile;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      report: { summary: "验收通过", verdict: "pass", coverage: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? status.reason ?? "");

    // 自定义实施阶段在降级后仍被识别为工作阶段，上一实施结果不丢失。
    const prompt = readFileSync(promptFile, "utf8");
    assert.match(prompt, /上一实施结果：上一轮构建完成/);
    assert.match(prompt, /README\.md/);
  } finally {
    clearFakeStageEnv();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置在 prepare 后降级：接收按冻结声明校验报告", async () => {
  const dir = project("fallback-frozen-accept");
  const s = services(dir);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  try {
    mkdirSync(join(dir, ".knit", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".knit", "prompts", "build.md"), "# 自定义构建提示词\n");
    writeFileSync(join(dir, ".knit", "prompts", "verify.md"), "# 自定义验收提示词\n");
    writeFileSync(workflowFile, FROZEN_WORKFLOW);
    const task = await readyTask(dir, s, "冻结接收");

    const build = await startRun(s, dir, task.taskId, "build", {
      writes: [{ path: "README.md", content: "# build for accept\n" }],
      report: { summary: "构建完成", changedPaths: ["README.md"], evidence: ["README.md"] },
    });
    assert.equal((await waitTerminal(s, dir, build.runId)).state, "completed");

    // 冻结输入后配置降级，再直接投放缺少 verdict 的合成结果。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "verify"));
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    writeFileSync(workflowFile, BROKEN_WORKFLOW);
    const runs = new RunStore(dir);
    runs.writeResult(prepared.request.runId, resultFixture(prepared.request, "completed", {
      summary: "缺少结论",
      coverage: ["README.md"],
    }));
    const rejected = await s.acceptance.accept({ dir, runId: prepared.request.runId });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "report_verdict_missing");

    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "verify");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置在 prepare 后降级：无 prompt 阶段不套旧提示词", async () => {
  const dir = project("fallback-frozen-noprompt");
  const s = services(dir);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  try {
    writeFileSync(workflowFile, [
      "version: 1",
      "stages:",
      "  - id: noprompt",
      "    name: 无提示",
      "    report:",
      "      changedPaths: paths",
      "",
    ].join("\n"));
    // 同名旧阶段提示词存在：若降级后错误回退到它，输入摘要会与 prepare 不符。
    writeFileSync(join(dir, ".knit", "agents", "noprompt.md"), "# 不应被注入的旧提示词\n");
    const task = await readyTask(dir, s, "无提示阶段");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "noprompt"));
    assert.equal(prepared.request.stageDefinition.prompt, null);
    assert.equal(prepared.request.stageDefinition.decision, false);

    writeFileSync(workflowFile, BROKEN_WORKFLOW);
    const argvFile = hookPath(dir, "fake-argv-noprompt.json");
    process.env.KNIT_FAKE_ARGS_FILE = argvFile;
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# no prompt\n" }],
      report: { summary: "无提示完成", changedPaths: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? status.reason ?? "");
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.equal((argValue(argv, "--append-system-prompt") ?? "").includes("不应被注入的旧提示词"), false);
  } finally {
    clearFakeStageEnv();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置在 prepare 后降级：报告声明按冻结定义校验", async () => {
  const dir = project("fallback-frozen-report");
  const s = services(dir);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  const auditWorkflow = [
    "version: 1",
    "stages:",
    "  - id: audit",
    "    name: 审计",
    "    report:",
    "      changedPaths: paths",
    "      notes: string",
    "",
  ].join("\n");
  try {
    writeFileSync(workflowFile, auditWorkflow);
    const task = await readyTask(dir, s, "冻结报告");

    // 第一次：notes 类型不符；旧默认字段会忽略它，这里必须按冻结声明失败。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "audit"));
    assert.deepEqual(prepared.request.stageDefinition.report, { changedPaths: "paths", notes: "string" });
    writeFileSync(workflowFile, BROKEN_WORKFLOW);
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# audit\n" }],
      report: { summary: "声明字段类型错误", changedPaths: ["README.md"], notes: 123 },
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const failed = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.result.failureReason, "report_field_type:notes:string");

    // 第二次：按冻结声明补全后正常完成。
    writeFileSync(workflowFile, auditWorkflow);
    const retry = await s.coordinator.prepare(prepareInput(dir, task.taskId, "audit"));
    writeFileSync(workflowFile, BROKEN_WORKFLOW);
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# audit complete\n" }],
      report: { summary: "审计完成", changedPaths: ["README.md"], notes: "已核对" },
    });
    const retried = await s.coordinator.start({ dir, runId: retry.request.runId });
    assert.equal(retried.confirmed, true);
    const completed = await waitTerminal(s, dir, retry.request.runId);
    assert.equal(completed.state, "completed", completed.result?.failureReason ?? completed.reason ?? "");
  } finally {
    clearFakeStageEnv();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope 跨 run 累积、换会话不重置修复计数与检查事实", async () => {
  const dir = project("scope-races");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    let binding = await s.store.bindings.get(task.taskId);
    await s.store.bindings.save({ ...binding, repairCycleId: "rep-cycle-scope", repairRounds: 0, stopReason: null });
    const impl1 = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "a.txt", content: "a\n" }],
      report: { summary: "第一次实现", changedPaths: ["a.txt"] },
    });
    await waitTerminal(s, dir, impl1.runId);
    const check1 = await startRun(s, dir, task.taskId, "check", {
      report: { summary: "要求修复", verdict: "changes_requested", coverage: ["a.txt"] },
    });
    const checkStatus = await waitTerminal(s, dir, check1.runId);
    assert.equal(checkStatus.state, "completed");
    binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.lastCheckRunId, check1.runId);
    assert.equal(binding.repairRounds, 1);
    const impl2 = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "b.txt", content: "b\n" }],
      report: { summary: "第二次实现", changedPaths: ["b.txt"] },
    });
    await waitTerminal(s, dir, impl2.runId);
    binding = await s.store.bindings.get(task.taskId);
    assert.deepEqual(binding.scope.map((entry) => entry.path), ["a.txt", "b.txt"]);
    assert.equal(binding.scopeRunIds.filter((id) => id === impl1.runId).length, 1);
    assert.equal(binding.scopeRunIds.includes(impl2.runId), true);
    assert.equal(binding.repairRounds, 1, "新会话不重置修复计数");
    assert.equal(binding.lastCheckRunId, check1.runId, "新实现保留最近检查事实，不由旧回执改写");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查接收窗口外部改动成果：重核不符转 scope_changed，不发布检查凭据", async () => {
  const dir = project("check-window-drift");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check"));
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    const runs = new RunStore(dir);
    runs.writeResult(prepared.request.runId, resultFixture(prepared.request, "completed", {
      summary: "检查", verdict: "pass", coverage: ["README.md"],
    }));
    // 检查结果发布后、接收前，外部改写成果文件：旧指纹不再匹配当前事实。
    writeFileSync(join(dir, "README.md"), "# edited after check\n");
    const accepted = await s.acceptance.accept({ dir, runId: prepared.request.runId });
    assert.equal(accepted.accepted, false);
    assert.equal(accepted.reason, "scope_changed");
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "checks", `${prepared.request.runId}.json`)), false);
    assert.equal(parseTaskDocument(readFileSync(join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md"), "utf8")).frontmatter.stage, "check");
    // 恢复检查时内容后重接可收敛。
    writeFileSync(join(dir, "README.md"), "# impl\n");
    const recovered = await s.acceptance.accept({ dir, runId: prepared.request.runId });
    assert.equal(recovered.accepted, true, recovered.reason ?? "");
    assert.equal(recovered.phase, "deliver");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("输入在结果发布后变化时接收 stale，不写 Task／scope", async () => {
  const dir = project("stale");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# accepted\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "检查", verdict: "pass", coverage: ["README.md"] } });
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    // 冻结后修改输入区，模拟接收前变化。
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    const version = readWithVersion(taskFile);
    const document = parseTaskDocument(version.data.toString("utf8"), taskFile);
    atomicWrite({
      path: taskFile,
      data: Buffer.from(renderTaskDocument({ ...document, inputsBody: `${document.inputsBody}\n补充约束。\n` }), "utf8"),
      expectedSha256: version.sha256,
      mode: 0o644,
    });
    const runs = new RunStore(dir);
    runs.writeResult(prepared.request.runId, resultFixture(prepared.request, "completed", {
      summary: "检查", verdict: "pass", coverage: ["README.md"],
    }));
    const accepted = await s.acceptance.accept({ dir, runId: prepared.request.runId });
    assert.equal(accepted.accepted, false);
    assert.equal(accepted.reason, "stale_input");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "check");
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "checks", `${prepared.request.runId}.json`)), false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行边界核对实际分支：prepare、启动、接收三处拒绝，detach 拒绝，adopt 后可继续", async () => {
  const dir = project("branch-boundary");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "分支边界", slug: "branch-boundary", branch: "refs/heads/main", verification: "independent" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");

    // 1. prepare 前换分支：拒绝启动，不改绑。
    git(dir, ["checkout", "-q", "-b", "unrelated"]);
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(dir, task.taskId, "implement")),
      (error) => error.guardReason === "branch_mismatch",
    );
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.branch, "refs/heads/main");

    // detached HEAD 同样拒绝。
    git(dir, ["checkout", "-q", "--detach"]);
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(dir, task.taskId, "implement")),
      (error) => error.guardReason === "branch_mismatch",
    );
    git(dir, ["checkout", "-q", "main"]);

    // 2. prepare 后启动前换分支：worker 认领后拒绝执行，阶段失败。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    git(dir, ["checkout", "-q", "-b", "side"]);
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "不应执行" } });
    await s.coordinator.start({ dir, runId: prepared.request.runId });
    const failed = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.result.failureReason, "branch_mismatch");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "implement");

    // 在绑定分支上完成一次实施，推进到 check；再验证接收窗口的分支核对。
    git(dir, ["checkout", "-q", "main"]);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "check");

    // 3. 结果待接收时换分支：接收拒绝 branch_changed；切回后可接收。
    git(dir, ["checkout", "-q", "main"]);
    const checkPrepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check"));
    await s.coordinator.start({ dir, runId: checkPrepared.request.runId, prepareOnly: true });
    const runs = new RunStore(dir);
    runs.writeResult(checkPrepared.request.runId, resultFixture(checkPrepared.request, "completed", {
      summary: "检查", verdict: "pass", coverage: ["README.md"],
    }));
    git(dir, ["checkout", "-q", "side"]);
    const rejected = await s.acceptance.accept({ dir, runId: checkPrepared.request.runId });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "branch_changed");
    git(dir, ["checkout", "-q", "main"]);
    const accepted = await s.acceptance.accept({ dir, runId: checkPrepared.request.runId });
    assert.equal(accepted.accepted, true, accepted.reason ?? "");

    // 4. adopt 使 deliver 回 check；显式接管 side 后新运行在 side 正常准备，绑定不被悄悄改回。
    git(dir, ["checkout", "-q", "side"]);
    const adopted = await s.tasks.adopt({ dir, taskId: task.taskId, branch: "current" });
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.branch, "refs/heads/side");
    git(dir, ["checkout", "-q", "side"]);
    const onSide = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check"));
    assert.equal(onSide.request.expected.branch, "refs/heads/side");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.branch, "refs/heads/side");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume --run：结果待同步先接收不重跑；已完成不新建 run；失败后新 run 恢复原会话", async () => {
  const dir = project("resume");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const bad = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# bad\n" }],
      report: { summary: "错误路径", changedPaths: ["wrong"] },
    });
    const badStatus = await waitTerminal(s, dir, bad.runId);
    assert.equal(badStatus.state, "failed");
    const resumed = await s.coordinator.resume({ dir, oldRunId: bad.runId });
    assert.equal(resumed.resumed, true);
    assert.notEqual(resumed.request.runId, bad.runId);
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# fixed\n" }],
      report: { summary: "修复", changedPaths: ["README.md"] },
    });
    await s.coordinator.start({ dir, runId: resumed.request.runId });
    const fixed = await waitTerminal(s, dir, resumed.request.runId);
    assert.equal(fixed.state, "completed");
    const again = await s.coordinator.resume({ dir, oldRunId: resumed.request.runId });
    assert.equal(again.resumed, false);
    assert.equal(again.reason, "already_accepted");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("原生引用不可恢复时保留执行结果，不把会话失败当代码重跑理由", async () => {
  const dir = project("native-missing");
  const s = services(dir);
  const previous = process.env.KNIT_FAKE_NO_FILE;
  try {
    process.env.KNIT_FAKE_NO_FILE = "1";
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# native missing\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    const status = await waitTerminal(s, dir, impl.runId);
    assert.equal(status.state, "completed");
    assert.equal(status.result.state, "completed");
    assert.equal(status.result.session.nativeReadable, false);
    assert.equal(status.result.session.status, "opening");
    assert.equal(status.result.session.resumeReason, "no_previous_session");
    assert.equal(status.result.nativeEntries.startEntryId, null);
    assert.equal(status.acceptance.state, "completed");
  } finally {
    if (previous === undefined) delete process.env.KNIT_FAKE_NO_FILE;
    else process.env.KNIT_FAKE_NO_FILE = previous;
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime 启动失败保留 pi 侧错误细节；run 目录与 status 可读", async () => {
  const dir = project("start-fail");
  const s = services(dir);
  const previousFailure = process.env.KNIT_FAKE_START_FAILURE;
  try {
    process.env.KNIT_FAKE_START_FAILURE = "set_model";
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", { report: { summary: "不应到达" } });
    const status = await waitTerminal(s, dir, impl.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "runtime_start_failed:set_model_rejected");

    const diagnostics = JSON.parse(
      readFileSync(join(dir, ".knit", ".runtime", "runs", impl.runId, "diagnostics.json"), "utf8"),
    );
    assert.equal(diagnostics.kind, "runtime_start_failed");
    assert.equal(diagnostics.failure, "set_model_rejected");
    assert.match(diagnostics.detail, /set_model 被拒绝/);
    assert.match(diagnostics.stderrTail, /Model not found: magpie\/glm-5\.3-flash/);
    assert.equal(diagnostics.truncated, false);

    const view = await new StatusService({ store: s.store }).runStatus(dir, impl.runId);
    assert.notEqual(view.startupDiagnostics, null);
    assert.equal(view.startupDiagnostics.failure, "set_model_rejected");
    assert.match(view.startupDiagnostics.stderrTail, /Model not found: magpie\/glm-5\.3-flash/);

    const human = spawnSync(process.execPath, [CLI, "run", "status", impl.runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(human.status, 0);
    assert.match(human.stdout, /启动诊断: set_model_rejected/);
    assert.match(human.stdout, /Model not found: magpie\/glm-5\.3-flash/);
    const json = spawnSync(process.execPath, [CLI, "run", "status", impl.runId, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, KNIT_JSON: "1" },
    });
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.data.startupDiagnostics.failure, "set_model_rejected");
    assert.match(payload.data.startupDiagnostics.stderrTail, /Model not found/);

    // 非启动失败（正常完成）不附带启动诊断。
    delete process.env.KNIT_FAKE_START_FAILURE;
    const fixed = await startRun(s, dir, task.taskId, "implement", {
      report: { summary: "修复后实现", changedPaths: ["README.md"] },
      writes: [{ path: "README.md", content: "# fixed\n" }],
    });
    const fixedStatus = await waitTerminal(s, dir, fixed.runId);
    assert.equal(fixedStatus.state, "completed");
    const fixedView = await new StatusService({ store: s.store }).runStatus(dir, fixed.runId);
    assert.equal(fixedView.startupDiagnostics, null);
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "runs", fixed.runId, "diagnostics.json")), false);
  } finally {
    if (previousFailure === undefined) delete process.env.KNIT_FAKE_START_FAILURE;
    else process.env.KNIT_FAKE_START_FAILURE = previousFailure;
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("连接中断启动失败同样落盘诊断尾部", async () => {
  const dir = project("start-fail-exit");
  const s = services(dir);
  const previousFailure = process.env.KNIT_FAKE_START_FAILURE;
  try {
    process.env.KNIT_FAKE_START_FAILURE = "exit";
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", { report: { summary: "不应到达" } });
    const status = await waitTerminal(s, dir, impl.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "runtime_start_failed:connection_closed");
    const diagnostics = JSON.parse(
      readFileSync(join(dir, ".knit", ".runtime", "runs", impl.runId, "diagnostics.json"), "utf8"),
    );
    assert.equal(diagnostics.failure, "connection_closed");
    assert.match(diagnostics.stderrTail, /Unknown provider: magpie/);
  } finally {
    if (previousFailure === undefined) delete process.env.KNIT_FAKE_START_FAILURE;
    else process.env.KNIT_FAKE_START_FAILURE = previousFailure;
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真实 worker 持项目占用时草案保存与撤回；旧 run 沿冻结输入；接收不丢草案", async () => {
  const dir = project("active-draft");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      delayMs: 2500,
      writes: [{ path: "README.md", content: "# slow impl\n" }],
      report: { summary: "慢实现", changedPaths: ["README.md"] },
    });
    // worker 真实持项目锁期间：保存与按摘要撤回不报 lock_busy。
    const saved = await s.tasks.update({ dir, taskId: task.taskId, kind: "clarify", reason: "运行中新增约束", content: "## 目标与边界\n\n新增约束\n", runActive: true });
    assert.equal(saved.applied, "pending_saved");
    assert.ok(saved.pendingDraftDigest);
    const binding = await s.store.bindings.get(task.taskId);
    assert.notEqual(binding.pendingDraft, null);
    assert.equal(binding.pendingDraft.kind, "clarify");

    const withdrawn = await s.tasks.update({ dir, taskId: task.taskId, withdrawReason: "测试撤回", expectPending: saved.pendingDraftDigest });
    assert.equal(withdrawn.applied, "pending_withdrawn");
    assert.equal((await s.store.bindings.get(task.taskId)).pendingDraft, null);

    // 运行期间再次保存草案；旧 run 接收被 pending_inputs 暂停（待应用输入阻后续接收），
    // 撤回后重新接收正常收敛，草案生命周期不被 worker 拥挤丢内。
    const saved2 = await s.tasks.update({ dir, taskId: task.taskId, kind: "change", reason: "运行中新增目标", content: "## 目标与边界\n\n新增目标\n", runActive: true });
    assert.equal(saved2.applied, "pending_saved");
    const status = await waitTerminal(s, dir, impl.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.reason, "acceptance_pending_inputs");
    assert.equal((await s.store.bindings.get(task.taskId)).pendingDraft?.digest, saved2.pendingDraftDigest);
    const withdrawn2 = await s.tasks.update({ dir, taskId: task.taskId, withdrawReason: "改口", expectPending: saved2.pendingDraftDigest });
    assert.equal(withdrawn2.applied, "pending_withdrawn");
    const recovered = await s.acceptance.accept({ dir, runId: impl.runId });
    assert.equal(recovered.accepted, true, recovered.reason ?? "");
    assert.equal(recovered.reason, "implementation_accepted");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    const document = parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile);
    assert.equal(document.frontmatter.stage, "check");
    assert.ok(!document.inputsBody.includes("新增目标"), "冻结输入不被草案覆盖");

    // 撤回后无草案；旧摘要再撤回拒绝且确定。
    await assert.rejects(
      s.tasks.update({ dir, taskId: task.taskId, withdrawReason: "旧摘要", expectPending: "deadbeefdead" }),
      (error) => error.guardReason === "no_pending_draft" || error.code === "version_conflict",
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("结果写入失败不发布完成，Task 不推进", async () => {
  const dir = project("result-fail");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      delayMs: 1500,
      writes: [{ path: "README.md", content: "# result fail\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await s.coordinator.start({ dir, runId: prepared.request.runId });
    // 在结果写入前把 result.json 占成目录，模拟证据写入失败。
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".knit", ".runtime", "runs", prepared.request.runId, "result.json"), { recursive: true });
    let status = await waitTerminal(s, dir, prepared.request.runId);
    for (let attempt = 0; attempt < 40 && status.acceptance.reason !== "result_missing"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await s.coordinator.status({ dir, runId: prepared.request.runId });
    }
    assert.equal(status.state, "failed");
    assert.equal(status.reason, "result_write_failed");
    assert.equal(status.result, null);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "implement");
    assert.equal(status.acceptance.reason, "result_missing");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取消在安全点收敛为 cancelled，不推进 Task；旧 run 取消不影响新 run", async () => {
  const dir = project("cancel");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      delayMs: 5000,
      writes: [{ path: "README.md", content: "# cancelled\n" }],
      report: { summary: "不应完成", changedPaths: ["README.md"] },
    });
    await s.coordinator.start({ dir, runId: prepared.request.runId });
    // 等 worker 进入 running 后取消。
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await s.coordinator.status({ dir, runId: prepared.request.runId });
      if (status.state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cancel = await s.coordinator.cancel({ dir, runId: prepared.request.runId, reason: "测试取消" });
    assert.equal(cancel.requested, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    const again = await s.coordinator.cancel({ dir, runId: prepared.request.runId, reason: "重复取消" });
    assert.equal(again.requested, false);
    assert.equal(again.reason, "already_terminal");
    assert.equal(status.state, "cancelled");
    assert.equal(status.result.state, "cancelled");
    assert.equal(status.result.session === null, false);
    // 取消可能发生在模型前或模型后：用量允许未知，不伪造零。
    assert.ok(status.result.usage !== null);
    assert.equal(status.acceptance.state, "completed");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "implement");

    // 新 run 不受旧取消文件影响；复位工作区后写同内容，避免“未改变”被误判。
    writeFileSync(join(dir, "README.md"), "# demo\n");
    const next = await startRun(s, dir, task.taskId, "implement", {
      // 同路径、同内容的新 run：旧取消文件按 run 隔离，不得误伤后来操作。
      writes: [{ path: "README.md", content: "# cancelled\n" }],
      report: { summary: "同内容新 run 完成", changedPaths: ["README.md"] },
    });
    const nextStatus = await waitTerminal(s, dir, next.runId);
    assert.equal(nextStatus.state, "completed");
    assert.equal(nextStatus.acceptance.state, "completed");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取消与完成竞争：fake-pi 收到取消的同一 tick 发布完成结果，终态唯一", async () => {
  const dir = project("cancel-race");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_COMPLETE_ON_ABORT = "1";
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".race-wait",
      writes: [{ path: "race.txt", content: "race\n" }],
      report: { summary: "取消竞争中的完成结果", changedPaths: ["race.txt"] },
    });
    await s.coordinator.start({ dir, runId: prepared.request.runId });
    // 等 worker 进入 running 后取消；fake-pi 在收到 abort 的同一 tick 完成并发布结果，
    // 不依赖真实时序偶然命中（对照上一用例的「取消可能发生在模型前或模型后」）。
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await s.coordinator.status({ dir, runId: prepared.request.runId });
      if (status.state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cancel = await s.coordinator.cancel({ dir, runId: prepared.request.runId, reason: "取消竞争" });
    assert.equal(cancel.requested, true);
    const status = await waitTerminal(s, dir, prepared.request.runId);
    // 终态唯一：取消已记录，模型迟到完成不重开取消任务，也不产生第二个 result。
    assert.equal(status.state, "cancelled");
    assert.equal(status.result.state, "cancelled");
    assert.equal(status.result.session === null, false);
    assert.equal(status.acceptance.state, "completed");
    const events = readFileSync(join(dir, ".knit", ".runtime", "runs", prepared.request.runId, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((entry) => entry.event === "cancel_requested").length, 1);
    const published = events.filter((entry) => entry.event === "result_published");
    assert.equal(published.length, 1);
    assert.equal(published[0].state, "cancelled");
    // Task 不被迟到完成推进。
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "implement");
  } finally {
    delete process.env.KNIT_FAKE_COMPLETE_ON_ABORT;
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume --run：已完成结果待同步时只接收，不新建 run、不重跑模型", async () => {
  const dir = project("pending-sync");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# pending\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const check = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, { report: { summary: "检查", verdict: "pass", coverage: ["README.md"] } });
    await s.coordinator.start({ dir, runId: check.request.runId, prepareOnly: true });
    const runs = new RunStore(dir);
    runs.writeResult(check.request.runId, resultFixture(check.request, "completed", {
      summary: "检查", verdict: "pass", coverage: ["README.md"],
    }));
    // 模拟接收尚未发生：operation 保持 planned。
    const before = runs.listRunIds().length;
    const resumed = await s.coordinator.resume({ dir, oldRunId: check.request.runId });
    assert.equal(resumed.accepted, true);
    assert.equal(resumed.resumed, false);
    assert.equal(resumed.reason, "already_accepted");
    assert.equal(runs.listRunIds().length, before);
    assert.equal((await s.coordinator.status({ dir, runId: check.request.runId })).state, "completed");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("advisory 不再作为阶段：准备被拒绝，不推进 Task", async () => {
  const dir = project("advisory");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "讨论", slug: "discuss" });
    await assert.rejects(
      () => startRun(s, dir, task.taskId, "advisory", { report: { summary: "建议：先确认范围", ready: false } }),
      (error) => {
        assert.equal(error.guardReason, "stage_not_in_workflow");
        assert.match(error.message, /合法阶段: implement、check/);
        return true;
      },
    );
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.stage, "start");
    assert.equal(new RunStore(dir).listRunIds().length, 0);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取消在工具不响应 abort 时按宽限终止自有 Pi 进程组，留下真实终态与进程记录", async () => {
  const dir = project("cancel-tool");
  const s = services(dir);
  const previous = process.env.KNIT_FAKE_IGNORE_ABORT;
  try {
    process.env.KNIT_FAKE_IGNORE_ABORT = "1";
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      delayMs: 60_000,
      writes: [{ path: "README.md", content: "# tool kept running\n" }],
      report: { summary: "不应完成", changedPaths: ["README.md"] },
    });
    await s.coordinator.start({ dir, runId: prepared.request.runId });
    let running;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      running = await s.coordinator.status({ dir, runId: prepared.request.runId });
      if (running.state === "running" && running.stageProcess?.state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(running?.state, "running");
    assert.equal(running?.stageProcess?.state, "running");
    const began = Date.now();
    const cancelled = await s.coordinator.cancel({ dir, runId: prepared.request.runId, reason: "工具不响应" });
    assert.equal(cancelled.requested, true);
    const status = await waitTerminal(s, dir, prepared.request.runId, 15_000);
    assert.equal(status.state, "cancelled");
    assert.equal(status.result?.state, "cancelled");
    assert.ok(Date.now() - began < 12_000, "取消必须在宽限后实际终止，而不是无限等待");
    const processRecord = new RunStore(dir).readStageProcess(prepared.request.runId);
    assert.notEqual(processRecord, null);
    assert.equal(processRecord.state, "exited");
    assert.notEqual(processRecord.piPid, null);
    assert.equal(isProcessAlive(processRecord.piPid), false, "自有阶段进程不得残留");
  } finally {
    if (previous === undefined) delete process.env.KNIT_FAKE_IGNORE_ABORT;
    else process.env.KNIT_FAKE_IGNORE_ABORT = previous;
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL worker 后阶段 Pi 仍存活：resume 拒绝兜底；清理自有进程并显式解锁后才续做", async () => {
  const dir = project("kill-worker");
  const s = services(dir);
  const previous = process.env.KNIT_FAKE_IGNORE_ABORT;
  try {
    delete process.env.KNIT_FAKE_IGNORE_ABORT;
    const task = await readyTask(dir, s);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE = "1";
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      delayMs: 60_000,
      writes: [{ path: "README.md", content: "# orphan\n" }],
      report: { summary: "不应完成", changedPaths: ["README.md"] },
    });
    await s.coordinator.start({ dir, runId: prepared.request.runId });
    let status;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      status = await s.coordinator.status({ dir, runId: prepared.request.runId });
      if (status.stageProcess?.state === "running" && status.stageProcess.piPid !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status?.stageProcess?.state, "running");
    const launch = new RunStore(dir).readLaunch(prepared.request.runId);
    assert.notEqual(launch?.handle, null);
    process.kill(launch.handle.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(
      () => s.coordinator.resume({ dir, oldRunId: prepared.request.runId }),
      (error) => error.details?.guardReason === "run_active",
      "旧 Pi 存活时不得由新会话兜底",
    );
    const stage = new RunStore(dir).readStageProcess(prepared.request.runId);
    assert.notEqual(stage?.piPid, null);
    // 假 Pi 可能在 worker 死后自行退出；存在时清理整个进程组，不存在时同样断言无残留。
    if (isProcessAlive(stage.piPid)) {
      try {
        process.kill(-stage.piPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      for (let attempt = 0; attempt < 100 && isProcessAlive(stage.piPid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(isProcessAlive(stage.piPid), false, "先清理自有 Pi 进程组");
    const locked = s.locks.list().filter((entry) => entry.processVerdict !== "alive");
    assert.ok(locked.some((entry) => entry.scope === "project"));
    assert.ok(locked.some((entry) => entry.scope === "session"), "被强杀 worker 的 Session 锁也是残留");
    for (const entry of locked) {
      const key = entry.key ?? (entry.scope === "project" ? dir : null);
      if (key !== null) {
        const removed = s.locks.unlock({ key: { scope: entry.scope, rawKey: key }, expectToken: entry.owner.token, force: true });
        assert.equal(removed.removed, true, `应移除残留锁 ${entry.scope}`);
      }
    }
    assert.equal(s.locks.list().some((entry) => entry.scope === "project" && entry.key === dir), false);
    const resumed = await s.coordinator.resume({ dir, oldRunId: prepared.request.runId });
    assert.equal(resumed.resumed, true);
    assert.notEqual(resumed.request.runId, prepared.request.runId);
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# recovered\n" }],
      report: { summary: "恢复完成", changedPaths: ["README.md"] },
    });
    await s.coordinator.start({ dir, runId: resumed.request.runId });
    const final = await waitTerminal(s, dir, resumed.request.runId);
    assert.equal(final.state, "completed", JSON.stringify({ reason: final.reason, failure: final.result?.failureReason, stage: final.stageProcess }));
    assert.equal(new RunStore(dir).readState(prepared.request.runId)?.state, "failed");
  } finally {
    if (previous === undefined) delete process.env.KNIT_FAKE_IGNORE_ABORT;
    else process.env.KNIT_FAKE_IGNORE_ABORT = previous;
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("心跳丢失后 worker 停止新动作：fake-pi 下一次调用被拒绝，run 以 lock_ownership_lost 终止", async () => {
  const dir = project("heartbeat-lost");
  // 缩短心跳间隔，使测试秒级完成；heartbeatStaleMs 保持大于间隔即可。
  const configPath = join(dir, ".knit", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.limits.heartbeatIntervalMs = 100;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const runId = (await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"))).request.runId;
    process.env.KNIT_PI_BIN = FAKE_PI;
    // waitFile 永不出现：fake-pi 停在动作边界，只有被中止才退出等待。
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".knit-heartbeat-guard-never",
      writes: [{ path: "README.md", content: "# 丢失占用后不得写入\n" }],
      report: { summary: "不应到达", changedPaths: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId });
    assert.equal(started.confirmed, true);

    // 等待阶段进入 running（fake-pi 停在 waitFile，不会自行结束）。
    const deadline = Date.now() + 15_000;
    for (;;) {
      const status = await s.coordinator.status({ dir, runId });
      if (status.state === "running") break;
      if (["completed", "failed", "cancelled"].includes(status.state)) throw new Error(`阶段提前终止: ${status.state}`);
      if (Date.now() > deadline) throw new Error(`未进入 running: ${status.state}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // 模拟占用被外部强制解除：删除锁目录后，worker 下一次心跳必然失败。
    rmSync(join(dir, ".locks"), { recursive: true, force: true });

    const status = await waitTerminal(s, dir, runId);
    assert.equal(status.state, "failed");
    assert.ok(
      status.result.failureReason.startsWith("lock_ownership_lost"),
      `期望 lock_ownership_lost，实际 ${status.result.failureReason}`,
    );
    // fake-pi 的下一次动作被拒绝：等待信号期间被中止，未发生任何写入或写回。
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n");
    // 事件中留下心跳失败事实；丢失占用的失败结论落在 result 与 state。
    const events = readFileSync(join(dir, ".knit", ".runtime", "runs", runId, "events.jsonl"), "utf8");
    assert.ok(events.includes("lock_heartbeat_failed"));
    const resultFile = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "runs", runId, "result.json"), "utf8"));
    assert.equal(resultFile.state, "failed");
    assert.ok(resultFile.failureReason.startsWith("lock_ownership_lost"));
    assert.equal(new RunStore(dir).readState(runId)?.reason.startsWith("lock_ownership_lost"), true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无固定阶段总时限：长阶段跨原 15 分钟截止仍完成；显式取消仍收敛（任务034）", async () => {
  const dir = project("no-stage-deadline");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const runId = (await s.coordinator.prepare(prepareInput(dir, task.taskId, "implement"))).request.runId;
    process.env.KNIT_PI_BIN = FAKE_PI;
    // waitFile 信号在 waitTerminal 之后才发出：阶段等待远超旧 900s 截止时间概念上的窗口；
    // 用可控信号而非真等 15 分钟证明语义：只有取消／信号推进终态，无自动超时停止。
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".knit/.runtime/.no-deadline-signal",
      writes: [{ path: "README.md", content: "# long stage\n" }],
      report: { summary: "长阶段完成", changedPaths: ["README.md"] },
      waitTimeoutMs: 60_000,
    });
    const started = await s.coordinator.start({ dir, runId });
    assert.equal(started.confirmed, true);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const status = await s.coordinator.status({ dir, runId });
      if (status.state === "running") break;
      if (["completed", "failed", "cancelled"].includes(status.state)) throw new Error(`阶段提前终止: ${status.state}`);
      if (Date.now() > deadline) throw new Error(`未进入 running: ${status.state}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 阶段在 running 中逗留明显超过 fake-pi 的旧式默认响应窗口，无任何自动停止。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const midRun = await s.coordinator.status({ dir, runId });
    assert.equal(midRun.state, "running", "无取消意图时不自动终止");
    // 发出信号：阶段继续并正常完成。
    mkdirSync(join(dir, ".knit", ".runtime"), { recursive: true }); writeFileSync(join(dir, ".knit", ".runtime", ".no-deadline-signal"), "go\n");
    const status = await waitTerminal(s, dir, runId);
    assert.equal(status.state, "completed", status.reason ?? "");
    assert.equal(status.acceptance.reason, "implementation_accepted");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("授权规范成果：明确授权后实施可改正式规范并进 scope；未授权仍拒绝（任务037）", async () => {
  const dir = project("authorized-standard");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const standardPath = ".knit/standards/release.md";
    writeFileSync(join(dir, standardPath), "# 发布规则 v1\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "standards"]);

    // 未授权：实施改动正式规范 → protected_path_modified。
    const denied = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: standardPath, content: "# 发布规则 v2\n" }],
      report: { summary: "未授权改规范", changedPaths: [standardPath] },
    });
    const deniedStatus = await waitTerminal(s, dir, denied.runId);
    assert.equal(deniedStatus.state, "failed");
    assert.match(deniedStatus.result.failureReason, /^protected_path_modified:/);
    // 恢复被拒现场：文件回到已提交版本，取消意图不参与。
    writeFileSync(join(dir, standardPath), "# 发布规则 v1\n");

    // 明确授权同一文件为成果：冻结旧版本作输入，改动可完成并进入 scope。
    const authorized = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: standardPath, content: "# 发布规则 v2\n" }],
      report: { summary: "更新发布规则", changedPaths: [standardPath] },
    }, { authorizedStandardPaths: [standardPath] });
    const authorizedStatus = await waitTerminal(s, dir, authorized.runId);
    assert.equal(authorizedStatus.state, "completed", authorizedStatus.reason ?? "");
    assert.equal(authorizedStatus.acceptance.reason, "implementation_accepted");
    const binding = await s.store.bindings.get(task.taskId);
    assert.ok(binding.scope.map((entry) => entry.path).includes(standardPath), "授权规范成果进入 scope");
    const requestOutputs = authorized.request.expected.authorizedStandardOutputs ?? [];
    assert.deepEqual(requestOutputs.map((output) => output.path), [standardPath]);
    assert.equal(requestOutputs[0].frozenContent, "# 发布规则 v1\n", "冻结旧版本内容入请求");
    assert.ok(authorizedStatus.acceptance.reason === "implementation_accepted");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prefer 恢复身份核对与回退：实际 ID 不符新建续做，旧查询不歧义；恢复失败不静默重跑（任务035）", async () => {
  const dir = project("resume-fallback");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# first\n" }],
      report: { summary: "首轮", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);

    // check 阶段默认 prefer 恢复上一子会话；注入 runtime 模拟实际 ID 与预期不符触发回退。
    const implStatus = await s.coordinator.status({ dir, runId: impl.runId });
    const expectedNative = implStatus.result.session.nativeSessionId;
    let sawResumeOptions = false;
    const factory = (runtimeOptions) => {
      const real = new PiAgentRuntime(runtimeOptions);
      if (runtimeOptions.sessionFile !== undefined) {
        sawResumeOptions = true;
        // 包一层 start：首次 get_state 返回意外 sessionId，触发身份核对失败并回退新建。
        const originalStart = real.start.bind(real);
        real.start = async (timeout) => {
          const check = await originalStart(timeout);
          if (!check.ok) return check;
          return { ...check, ok: false, failure: "session_identity_mismatch", detail: "stub mismatch" };
        };
      }
      return real;
    };
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "check", {
      recovery: { nativeSessionId: expectedNative, resume: "prefer" },
    }));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      report: { summary: "检查", verdict: "pass", coverage: ["README.md"] },
    });
    // RunCoordinator 用 workerCommand 起子进程，runtimeFactory 只在本进程生效；
    // 改为直接驱动 StageRunner 验证回退语义。先经 worker prepareOnly 冻结 inputs。
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    const plan = await new (await import("../dist/application/context-planner.js")).ContextPlanner({ store: s.store, randomHex }).plan({
      dir, taskId: task.taskId, role: "check",
    });
    const runs = new RunStore(dir);
    const inputs = runs.readInputs(prepared.request.runId);
    const runner = new (await import("../dist/application/stage-runner.js")).StageRunner({
      root: dir,
      request: prepared.request,
      plan,
      inputs: inputs ?? (() => { throw new Error("inputs missing"); })(),
      store: s.store,
      runs,
      locks: s.locks,
      cancelGraceMs: 5000,
      runtimeFactory: factory,
    });
    const execution = await runner.execute();
    assert.equal(execution.result.state, "completed", execution.result.failureReason ?? "");
    assert.equal(sawResumeOptions, true, "应先尝试恢复旧会话");
    const resumeRecord = await s.store.sessions.get({ client: "pi", nativeSessionId: expectedNative, role: "check" });
    assert.equal(resumeRecord?.status, "incompatible", "旧会话标记 incompatible，保留引用");
    const fallbackRecord = await s.store.sessions.get({ client: "pi", nativeSessionId: execution.result.session.nativeSessionId, role: "check" });
    assert.equal(fallbackRecord?.source.kind, "resume_fallback");
    assert.notEqual(fallbackRecord?.knitSessionId, resumeRecord?.knitSessionId, "新旧会话独立稳定身份");
    assert.equal(fallbackRecord?.source.fromSessionId, resumeRecord?.knitSessionId, "来源可追溯");
    // 旧 run 的冻结 scope 不被重置；直接驱动的 StageRunner 不含接收，检查凭据需另行接收验证。
    const binding = await s.store.bindings.get(task.taskId);
    assert.ok(binding.scope.map((entry) => entry.path).includes("README.md"));
    assert.ok(binding.scopeRunIds.includes(impl.runId));
    assert.equal(binding.lastCheckRunId, null, "StageRunner 只执行阶段，接收属 worker 边界");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseStageReport 容错：围栏包裹、语言标注与字符串内围栏错位均可解析", () => {
  const report = { summary: "核对完成", verdict: "pass", coverage: ["README.md"], findings: [], unverified: [] };
  const json = JSON.stringify(report, null, 2);
  // 无围栏整体文本。
  assert.equal(parseStageReport(json).report?.summary, "核对完成");
  // ```json 围栏 + 前置说明文字。
  assert.equal(parseStageReport(`结论如下：\n\n\`\`\`json\n${json}\n\`\`\`\n`).report?.verdict, "pass");
  // 无语言标注的 ``` 围栏。
  assert.equal(parseStageReport(`\`\`\`\n${json}\n\`\`\``).report?.verdict, "pass");
  // 候选按「相邻及末尾闭标记」配对，字符串值内含 ``` 不再导致错位失败。
  const fencedInside = JSON.stringify({ summary: "a```b\nc", verdict: "pass", coverage: ["x"] });
  assert.equal(parseStageReport(`\`\`\`json\n${fencedInside}\n\`\`\``).report?.summary, "a```b\nc");
});

test("parseStageReport 失败语义：畸形 JSON 报 report_not_json；schema 不合报 report_schema_invalid 且保留根因", () => {
  const notJson = parseStageReport("完全不是 JSON");
  assert.equal(notJson.report, null);
  assert.ok(notJson.error.startsWith("report_not_json:"));
  // 畸形围栏：剥壳候选也解析不出 JSON，仍报 not_json 而非吞错。
  const fencedBad = parseStageReport("说明\n```json\n{summary: 未加引号}\n```");
  assert.equal(fencedBad.report, null);
  assert.ok(fencedBad.error.startsWith("report_not_json:"));
  // 报告字段集合由阶段声明决定，额外字段不在解析层拒绝；固定字段类型错误仍报 schema_invalid。
  const flexible = parseStageReport(JSON.stringify({ summary: "x", verdict: "pass", coverage: ["x"], evidence: "额外字段" }));
  assert.equal(flexible.report?.summary, "x");
  const invalid = parseStageReport(JSON.stringify({ verdict: "pass" }));
  assert.equal(invalid.report, null);
  assert.ok(invalid.error.startsWith("report_schema_invalid:"));
  assert.ok(invalid.error.includes("/summary"));
});

test("检查报告带 ```json 围栏与前置说明时 run 以 pass 完成；畸形报告仍失败", async () => {
  const dir = project("check-fence");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    const implStatus = await waitTerminal(s, dir, impl.runId);
    assert.equal(implStatus.state, "completed");

    // 检查报告：前置说明 + ```json 围栏（真实 worker 曾这样输出导致 run failed）。
    const fencedText = [
      "所有验证已完成。结论：",
      "",
      "```json",
      JSON.stringify({ summary: "独立核对完成", verdict: "pass", coverage: ["README.md"], findings: [], unverified: [] }, null, 2),
      "```",
    ].join("\n");
    const check = await startRun(s, dir, task.taskId, "check", { text: fencedText });
    const checkStatus = await waitTerminal(s, dir, check.runId);
    assert.equal(checkStatus.state, "completed");
    assert.equal(checkStatus.result.report.verdict, "pass");
    assert.equal(checkStatus.result.reportSummary, "独立核对完成");

    // 下一任务的检查输出畸形 JSON：run 仍失败且失败原因可诊断。
    const task2 = await readyTask(dir, s, "第二任务");
    const impl2 = await startRun(s, dir, task2.taskId, "implement", {
      writes: [{ path: "docs.md", content: "# docs\n" }],
      report: { summary: "实现二", changedPaths: ["docs.md"] },
    });
    const impl2Status = await waitTerminal(s, dir, impl2.runId);
    assert.equal(impl2Status.state, "completed");

    process.env.KNIT_FAKE_ACTION = actionFile(dir, { text: "检查结论：\n```json\n{summary: 未加引号}\n```" });
    const prepared = await s.coordinator.prepare(prepareInput(dir, task2.taskId, "check"));
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
    const badStatus = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(badStatus.state, "failed");
    assert.ok(badStatus.result.failureReason.startsWith("report_not_json:"));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
