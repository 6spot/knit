/**
 * 013 阶段执行、接收、检查失效、修复计数与恢复测试。
 * 使用真实 Git／文件／worker 子进程和最小 Pi RPC 假实现，不调用真实模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), `knit-013-${prefix}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\nignored.txt\n");
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
  const task = await s.tasks.newTask({ dir, title, slug: title.replace(/\s+/g, "-") });
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

async function startRun(s, dir, taskId, phase, action, extra = {}) {
  const prepared = await s.coordinator.prepare(prepareInput(dir, taskId, phase, extra));
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
    if (["completed", "failed", "cancelled"].includes(status.state)) return status;
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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "check");

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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "deliver");
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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "check");
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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "deliver");
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
    assert.equal(after.frontmatter.phase, "implement");
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
    assert.equal(parseTaskDocument(readFileSync(join(dir, ".knit", task.relativePath), "utf8"), join(dir, ".knit", task.relativePath)).frontmatter.phase, "implement");
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

test("检查改动文件时该次结果失败，Task 不被推进", async () => {
  const dir = project("check-side");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# impl\n" }],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    await waitTerminal(s, dir, impl.runId);
    const check = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "README.md", content: "# changed by checker\n" }],
      report: { summary: "检查", verdict: "pass", coverage: ["README.md"] },
    });
    const status = await waitTerminal(s, dir, check.runId);
    assert.equal(status.state, "failed");
    assert.match(status.result.failureReason, /^check_side_effects:/);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "check");
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "cancelled", runsSettled: true });
    assert.equal(closed.status, "closed", "失败的终态 run 与 needs_attention 接收不应永久阻塞关闭");
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

test("报告改动路径与实际不符时不接收；模型报告不直接改 Task", async () => {
  const dir = project("mismatch");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const impl = await startRun(s, dir, task.taskId, "implement", {
      writes: [{ path: "README.md", content: "# actual\n" }],
      report: { summary: "声称完成", changedPaths: ["other.txt"] },
    });
    const status = await waitTerminal(s, dir, impl.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "changed_paths_mismatch");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "implement");
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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "check");
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "checks", `${prepared.request.runId}.json`)), false);
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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "implement");
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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "implement");

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
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "implement");
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

test("advisory 只产出建议，不推进 Task；CLI resume/accept 协议输出", async () => {
  const dir = project("advisory");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "讨论", slug: "discuss" });
    const advisory = await startRun(s, dir, task.taskId, "advisory", {
      report: { summary: "建议：先确认范围", ready: false },
    });
    const status = await waitTerminal(s, dir, advisory.runId);
    assert.equal(status.state, "completed");
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    assert.equal(parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile).frontmatter.phase, "discuss");
    const raw = execFileSync(
      process.execPath,
      [CLI, "--json", "run", "resume", advisory.runId, "--locks", join(dir, ".locks"), "--dir", dir],
      { encoding: "utf8" },
    );
    const resumed = JSON.parse(raw);
    assert.equal(resumed.outcome, "completed");
    assert.equal(resumed.data.resumed, false);
    assert.equal(resumed.data.reason, "already_accepted");
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
    assert.equal(existsSync(`/proc/${processRecord.piPid}`), false, "自有阶段进程不得残留");
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
    if (existsSync(`/proc/${stage.piPid}`)) {
      try {
        process.kill(-stage.piPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      for (let attempt = 0; attempt < 100 && existsSync(`/proc/${stage.piPid}`); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(existsSync(`/proc/${stage.piPid}`), false, "先清理自有 Pi 进程组");
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
