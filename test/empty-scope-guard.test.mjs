/**
 * 空成果完成守卫与无产物交付提示（任务 k-86d01bf85274，审计 F4）。
 * 空 scope 的 self／independent 任务不能静默完成：须显式 --no-artifacts --reason；
 * 交付没有产物提交时结果带 noArtifactCommit 与原因；空报告的实施 run 接收后 run status 提示。
 */
import { isRunSettled } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService, TaskGuardError } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { StatusService } from "../dist/application/status-service.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { completionDecision } from "../dist/domain/completion.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const BRANCH = "refs/heads/main";

let counter = 0x900;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-empty-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.fake*\n");
  writeFileSync(join(dir, "AGENTS.md"), "# 项目规则\n\n## 交付授权\n\n允许在当前分支按任务范围提交并归档。\n");
  writeFileSync(join(dir, "app.txt"), "old\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  const delivery = new DeliveryService({ store, locks, randomHex });
  return { store, locks, tasks, coordinator, delivery };
}

function cleanup(dir, s) {
  s.store.close();
  rmSync(dir, { recursive: true, force: true });
}

function guardRejects(promise, reason) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof TaskGuardError, `期望 TaskGuardError，实际 ${error}`);
    assert.equal(error.details.guardReason, reason);
    return true;
  });
}

async function startRun(s, dir, taskId, action) {
  const prepared = await s.coordinator.prepare({
    dir,
    taskId,
    phase: "implement",
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
  });
  const actionPath = join(dir, ".fake-action.json");
  writeFileSync(actionPath, JSON.stringify(action));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
  assert.equal(started.confirmed, true);
  return prepared.request.runId;
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

/** 审计 F4 场景：实施报告 changedPaths: [] 被接收，任务进入 deliver，scope 为空。 */
async function emptyAcceptedTask(dir, s, title, verification = "self") {
  const task = await s.tasks.newTask({ dir, title, slug: title, branch: BRANCH, verification });
  await s.tasks.ready({ dir, taskId: task.taskId });
  const runId = await startRun(s, dir, task.taskId, { report: { summary: "无改动", changedPaths: [] } });
  const status = await waitTerminal(s, dir, runId);
  assert.equal(status.state, "completed", status.result?.failureReason ?? "");
  assert.equal(status.acceptance?.state, "completed");
  assert.equal(status.acceptance?.reason, "implementation_accepted");
  assert.deepEqual(new RunStore(dir).readScope(task.taskId)?.entries ?? [], []);
  return { task, runId };
}

test("领域守卫：空 scope 的 self／independent 报 empty_scope；声明无产物、none、父任务、强制放行", () => {
  const base = {
    status: "open",
    stage: "deliver",
    outcome: null,
    pendingKind: null,
    verification: "self",
    confirmedInputsDigest: "in",
    currentInputsDigest: "in",
    currentScopeDigest: "scope",
    scopeCurrent: true,
    lastImplement: { runId: "run-1", inputsDigest: "in", scopeDigest: "scope" },
    implementationRecord: null,
    checkQualification: "missing",
    checkRunId: null,
  };
  assert.equal(completionDecision(base).allowed, true, "未提供 scopeEmpty 的旧调用方不受影响");
  assert.equal(completionDecision({ ...base, scopeEmpty: false }).allowed, true);
  assert.deepEqual(completionDecision({ ...base, scopeEmpty: true }), { allowed: false, reason: "empty_scope" });
  const independent = { ...base, verification: "independent", checkQualification: "valid", checkRunId: "run-check" };
  assert.deepEqual(completionDecision({ ...independent, scopeEmpty: true }), { allowed: false, reason: "empty_scope" });
  // 资格未成立时先报资格原因，不被空 scope 掩盖。
  assert.deepEqual(completionDecision({ ...base, scopeEmpty: true, lastImplement: null }), { allowed: false, reason: "implementation_missing" });

  const declared = completionDecision({ ...base, scopeEmpty: true, noArtifactsReason: " 纯调研 " });
  assert.equal(declared.allowed, true);
  assert.equal(declared.artifacts, "none");
  assert.equal(declared.noArtifactsReason, "纯调研");
  assert.deepEqual(completionDecision({ ...base, scopeEmpty: false, noArtifactsReason: "x" }), { allowed: false, reason: "artifacts_present" });

  const none = completionDecision({ ...base, verification: "none", scopeEmpty: true, confirmedInputsDigest: null, lastImplement: null });
  assert.equal(none.allowed, true, "none 模式不受空 scope 守卫约束");
  assert.equal(none.artifacts, undefined);
  assert.equal(completionDecision({ ...base, scopeEmpty: true, parentTask: true }).allowed, true, "父任务不受空 scope 守卫约束");
});

test("F4：空报告的 self 任务 close 被 empty_scope 拒绝；--no-artifacts --reason 后完成，交付 noArtifactCommit", async () => {
  const dir = project("self");
  const s = services(dir);
  try {
    const { task, runId } = await emptyAcceptedTask(dir, s, "empty-self");

    // 接收提示：空报告的实施 run 接收后 run status 提示“本轮未产生成果”。
    const view = await new StatusService({ store: s.store, locksRoot: join(dir, ".locks") }).runStatus(dir, runId);
    assert.match(view.noOutputNotice ?? "", /本轮未产生成果/);
    assert.ok(view.nextActions.some((line) => line.includes("--no-artifacts")), view.nextActions.join("；"));
    const cliStatus = spawnSync(process.execPath, [CLI, "run", "status", runId, "--dir", dir, "--locks", join(dir, ".locks")], { encoding: "utf8" });
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    assert.match(cliStatus.stdout, /提示: 本轮未产生成果/);

    await guardRejects(s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true }), "empty_scope");
    // 交付预检同一守卫：未声明前不能借 deliver 静默完成。
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "empty_scope",
    );
    // --no-artifacts 必须带原因，且只能用于 completed。
    await guardRejects(s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true, noArtifacts: true }), "invalid_request");
    await guardRejects(
      s.tasks.close({ dir, taskId: task.taskId, outcome: "cancelled", runsSettled: true, noArtifacts: true, reason: "x" }),
      "invalid_request",
    );

    const closed = await s.tasks.close({
      dir,
      taskId: task.taskId,
      outcome: "completed",
      runsSettled: true,
      noArtifacts: true,
      reason: "只核对现状，无需改动",
    });
    assert.equal(closed.outcome, "completed");
    assert.equal(closed.artifacts, "none");
    const credential = new RunStore(dir).readCompletion(task.taskId);
    assert.equal(credential?.artifacts, "none");
    assert.equal(credential?.noArtifactsReason, "只核对现状，无需改动");

    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.workCommit, null);
    assert.equal(result.noArtifactCommit, true);
    assert.equal(result.noArtifactReason, "只核对现状，无需改动");
    assert.match(result.noArtifactNotice ?? "", /本次交付没有产物提交/);
    assert.match(result.noArtifactNotice ?? "", /只核对现状，无需改动/);

    // 重复调用返回已完成操作，提示保持一致。
    const again = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(again.noArtifactCommit, true);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    cleanup(dir, s);
  }
});

test("F4：主会话已登记路径的 self 任务、none 任务与有产物交付不受影响", async () => {
  const dir = project("unaffected");
  const s = services(dir);
  try {
    const recorded = await s.tasks.newTask({ dir, title: "recorded", slug: "recorded", branch: BRANCH, verification: "self" });
    writeFileSync(join(dir, "app.txt"), "new\n");
    await s.tasks.ready({ dir, taskId: recorded.taskId });
    await s.tasks.implement({ dir, taskId: recorded.taskId, paths: ["app.txt"], validations: ["手动检查通过"] });
    // 已有成果时声明无产物与事实矛盾。
    await guardRejects(
      s.tasks.close({ dir, taskId: recorded.taskId, outcome: "completed", runsSettled: true, noArtifacts: true, reason: "x" }),
      "artifacts_present",
    );
    const closed = await s.tasks.close({ dir, taskId: recorded.taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.artifacts, undefined);
    const delivered = await s.delivery.deliver({ dir, taskId: recorded.taskId, branch: BRANCH });
    assert.equal(delivered.state, "completed", delivered.reason ?? "");
    assert.notEqual(delivered.workCommit, null);
    assert.equal(delivered.noArtifactCommit, false);
    assert.equal(delivered.noArtifactNotice, null);

    const none = await s.tasks.newTask({ dir, title: "none-mode", slug: "none-mode", branch: BRANCH, verification: "none" });
    const noneClosed = await s.tasks.close({ dir, taskId: none.taskId, outcome: "completed", runsSettled: true });
    assert.equal(noneClosed.outcome, "completed");
    const noneDelivered = await s.delivery.deliver({ dir, taskId: none.taskId, branch: BRANCH });
    assert.equal(noneDelivered.state, "completed", noneDelivered.reason ?? "");
    assert.equal(noneDelivered.noArtifactCommit, true, "none 模式无产物交付同样明确标注");
    assert.match(noneDelivered.noArtifactNotice ?? "", /本次交付没有产物提交/);
  } finally {
    cleanup(dir, s);
  }
});

test("F4：父任务（存在子任务）以空 scope 总体验收完成，不受 empty_scope 约束", async () => {
  const dir = project("parent");
  const s = services(dir);
  try {
    const parent = await s.tasks.newTask({ dir, title: "parent", slug: "parent", branch: BRANCH, verification: "self" });
    const child = await s.tasks.newTask({ dir, title: "child", slug: "child", branch: BRANCH, verification: "none", parent: parent.taskId });
    await s.tasks.ready({ dir, taskId: parent.taskId });
    await s.tasks.close({ dir, taskId: child.taskId, outcome: "completed", runsSettled: true });
    // 父任务自身没有实施事实时仍按资格拒绝；主会话以 --force --reason 给出总体验收依据即可空 scope 完成。
    await assert.rejects(
      () => s.tasks.close({ dir, taskId: parent.taskId, outcome: "completed", runsSettled: true, reason: "总体验收通过" }),
      (error) => error instanceof TaskGuardError && error.details.guardReason !== "empty_scope",
    );
    const closed = await s.tasks.close({
      dir,
      taskId: parent.taskId,
      outcome: "completed",
      runsSettled: true,
      force: true,
      reason: "子任务全部结束，总体验收通过",
    });
    assert.equal(closed.outcome, "completed");
    assert.equal(new RunStore(dir).readScope(parent.taskId)?.entries.length ?? 0, 0);
  } finally {
    cleanup(dir, s);
  }
});

test("F4：父任务有接收过的空实施 run 时，self 完成不报 empty_scope", async () => {
  const dir = project("parent-run");
  const s = services(dir);
  try {
    const { task } = await emptyAcceptedTask(dir, s, "parent-run");
    const child = await s.tasks.newTask({ dir, title: "child2", slug: "child2", branch: BRANCH, verification: "none", parent: task.taskId });
    await s.tasks.close({ dir, taskId: child.taskId, outcome: "completed", runsSettled: true });
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true, reason: "子任务成果核对通过" });
    assert.equal(closed.outcome, "completed");
    assert.equal(closed.verification, "self");
    assert.equal(closed.artifacts, undefined);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    cleanup(dir, s);
  }
});

test("CLI：task close 报 empty_scope；--no-artifacts --reason 完成，deliver 人读输出写明没有产物提交", async () => {
  const dir = project("cli");
  const s = services(dir);
  try {
    const { task } = await emptyAcceptedTask(dir, s, "cli-empty");
    s.store.close();
    const rejected = spawnSync(process.execPath, [CLI, "--json", "task", "close", task.taskId, "--outcome", "completed", "--runs-settled", "--dir", dir], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /empty_scope/);
    const closed = spawnSync(process.execPath, [
      CLI, "task", "close", task.taskId, "--outcome", "completed", "--runs-settled", "--no-artifacts", "--reason", "无需改动", "--dir", dir,
    ], { encoding: "utf8" });
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    assert.match(closed.stdout, /声明无产物/);
    const delivered = spawnSync(process.execPath, [CLI, "deliver", task.taskId, "--branch", BRANCH, "--dir", dir], { encoding: "utf8" });
    assert.equal(delivered.status, 0, delivered.stderr || delivered.stdout);
    assert.match(delivered.stdout, /本次交付没有产物提交（完成时声明无产物：无需改动）/);
    assert.doesNotMatch(delivered.stdout, /业务产物提交:/);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    rmSync(dir, { recursive: true, force: true });
  }
});
