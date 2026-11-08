/**
 * 检查阶段写入约束与 independent 标注（任务 k-b88e4a80906d，审计 F3）。
 * 真实 Git／worker 子进程与最小 Pi RPC 假实现；假实现把 write／edit／bash 记入原生会话。
 */
import { isRunSettled } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { StatusService } from "../dist/application/status-service.js";
import { CompletionService } from "../dist/application/completion-service.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { completionDecision, verificationLabel, checkerChangedPathsOf } from "../dist/domain/completion.js";
import { stageMayWrite, writeWithoutCapabilityReason } from "../dist/domain/attribution.js";
import { buildUserPrompt } from "../dist/application/stage.js";

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

function project(prefix, { checkWrite = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-cwg-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  if (checkWrite) {
    const file = join(dir, ".knit", "workflow.yaml");
    const raw = readFileSync(file, "utf8");
    const updated = raw.replace(/(- id: check[\s\S]*?tools: )\[read, exec\]/, "$1[read, write, exec]");
    assert.notEqual(updated, raw, "模板 check 阶段应为 [read, exec]");
    writeFileSync(file, updated);
  }
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.fake*\n");
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
  const acceptance = new RunAcceptanceService({ store, locks, randomHex });
  return { store, locks, tasks, coordinator, acceptance };
}

async function readyTask(dir, s, title) {
  const task = await s.tasks.newTask({ dir, title, slug: title, branch: BRANCH, verification: "independent" });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

async function startRun(s, dir, taskId, phase, action) {
  const prepared = await s.coordinator.prepare({
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
  });
  const actionPath = join(dir, ".fake-action.json");
  writeFileSync(actionPath, JSON.stringify(action));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
  assert.equal(started.confirmed, true);
  return prepared.request;
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

function cleanup(dir, s) {
  delete process.env.KNIT_FAKE_ACTION;
  s.store.close();
  rmSync(dir, { recursive: true, force: true });
}

function stageOf(dir, task) {
  const raw = readFileSync(join(dir, ".knit", task.relativePath), "utf8");
  return /^stage: (.+)$/m.exec(raw)?.[1];
}

async function implemented(dir, s, title) {
  const task = await readyTask(dir, s, title);
  const impl = await startRun(s, dir, task.taskId, "implement", {
    writes: [{ path: "README.md", content: "# impl\n" }],
    report: { summary: "实现", changedPaths: ["README.md"] },
  });
  const status = await waitTerminal(s, dir, impl.runId);
  assert.equal(status.state, "completed", status.result?.failureReason ?? "");
  assert.equal(stageOf(dir, task), "check");
  return task;
}

const PASS = { summary: "核对通过", verdict: "pass", coverage: ["README.md"], findings: [], unverified: [] };

test("单元：能力判定、失败原因、完成守卫与验证标注", () => {
  assert.equal(stageMayWrite({ allow: ["read", "bash"], capabilities: ["read", "exec"] }), false, "exec 不等于写能力");
  assert.equal(stageMayWrite({ allow: [], capabilities: [] }), false);
  assert.equal(stageMayWrite({ allow: ["read", "write", "edit"], capabilities: ["read", "write"] }), true);
  assert.equal(stageMayWrite({ allow: ["read"], capabilities: null }), true, "未写 tools／all 全部放开");
  assert.equal(stageMayWrite({ allow: ["read", "bash"] }), false, "旧计划按 allow 解释");
  assert.equal(stageMayWrite({ allow: ["read", "edit"] }), true);
  assert.equal(writeWithoutCapabilityReason(["a.txt", "b.txt"]), "write_without_capability:a.txt,b.txt");
  const many = Array.from({ length: 25 }, (_, index) => `f${index}.txt`);
  assert.match(writeWithoutCapabilityReason(many), /,…\(\+5\)$/);

  const base = {
    status: "open",
    stage: "deliver",
    outcome: null,
    pendingKind: null,
    verification: "independent",
    confirmedInputsDigest: "d",
    currentInputsDigest: "d",
    currentScopeDigest: "s",
    scopeCurrent: true,
    lastImplement: { runId: "run-i", inputsDigest: "d", scopeDigest: "s" },
    implementationRecord: null,
    checkQualification: "valid",
    checkRunId: "run-c",
  };
  assert.equal(completionDecision(base).allowed, true);
  assert.equal(completionDecision({ ...base, checkerChangedPaths: [] }).allowed, true);
  assert.deepEqual(completionDecision({ ...base, checkerChangedPaths: ["a.txt"] }), { allowed: false, reason: "check_self_modified" });

  assert.equal(verificationLabel("independent", []), "independent");
  assert.equal(verificationLabel("independent", undefined), "independent");
  assert.equal(verificationLabel("independent", ["a.txt", "b.txt"]), "independent（检查者修复 2 个路径，修复部分为自检）");
  assert.deepEqual(checkerChangedPathsOf({ checkerChangedPaths: ["x"], changedPaths: ["x", "y"] }), ["x"]);
  assert.deepEqual(checkerChangedPathsOf({ changedPaths: ["y"] }), ["y"], "旧凭据按 changedPaths 识别检查者修改");
  assert.deepEqual(checkerChangedPathsOf(null), []);
});

test("检查提示：[read, exec] 写明不改文件；允许写的检查阶段写明修复须再派无改动检查", () => {
  const plan = { stageBrief: null, sections: [], role: "check" };
  const base = { taskId: "t", runId: "r", branch: null, snapshotDir: null, scope: [], previousImplement: null };
  const report = { verdict: ["pass", "changes_requested", "blocked"], coverage: "string[]", changedPaths: "paths" };
  const readOnly = buildUserPrompt(plan, { id: "check", name: "检查", tools: ["read", "exec"], report, onVerdict: {} }, {}, base);
  assert.match(readOnly, /不要修改任何项目文件/);
  assert.match(readOnly, /write_without_capability/);
  assert.doesNotMatch(readOnly, /可直接修复/);
  const writable = buildUserPrompt(plan, { id: "check", name: "检查", tools: ["read", "write", "exec"], report, onVerdict: {} }, {}, base);
  assert.match(writable, /可直接修复/);
  assert.match(writable, /再派一次未改动文件且通过的检查/);
  const template = readFileSync(join(TEMPLATES, "agents", "check.md"), "utf8");
  assert.match(template, /检查阶段不改文件/);
  assert.match(template, /write_without_capability/);
  assert.match(template, /check_self_modified/);
  assert.match(readFileSync(join(TEMPLATES, "workflow.yaml"), "utf8"), /- id: check[\s\S]*?tools: \[read, exec\]/, "默认 check 维持 [read, exec]");
});

test("F3：[read, exec] 检查者用 bash 改文件并报 pass → write_without_capability，lastCheckRunId 不变、不接收", async () => {
  const dir = project("f3");
  const s = services(dir);
  try {
    const task = await implemented(dir, s, "f3");
    const before = await s.store.bindings.get(task.taskId);
    const check = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "README.md", content: "# renamed by checker\n", via: "bash" }],
      report: { ...PASS, changedPaths: ["README.md"], selfVerified: true },
    });
    const status = await waitTerminal(s, dir, check.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "write_without_capability:README.md");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# renamed by checker\n", "工作区保留");
    assert.notEqual(status.acceptance?.reason, "check_pass");
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.lastCheckRunId, before.lastCheckRunId, "lastCheckRunId 不变");
    assert.equal(new RunStore(dir).readCheck(check.runId), null, "不发布检查凭据");
    assert.equal(stageOf(dir, task), "check", "任务不前进");
    await assert.rejects(
      () => s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true }),
      (error) => typeof error.details?.guardReason === "string",
      "未接收的检查不提供完成资格",
    );
  } finally {
    cleanup(dir, s);
  }
});

test("[read, exec] 检查者用 write 工具改文件但漏报 → 仍判 write_without_capability（不被报告不实掩盖）", async () => {
  const dir = project("f3-write");
  const s = services(dir);
  try {
    const task = await implemented(dir, s, "f3-write");
    const check = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "src/new.txt", content: "x\n" }],
      report: PASS,
    });
    const status = await waitTerminal(s, dir, check.runId);
    assert.equal(status.state, "failed");
    assert.equal(status.result.failureReason, "write_without_capability:src/new.txt");
    assert.equal((await s.store.bindings.get(task.taskId)).lastCheckRunId, null);
  } finally {
    cleanup(dir, s);
  }
});

test("[read, exec] 检查期间主会话并发写入（外部改动）不算检查者写入：pass 正常接收", async () => {
  const dir = project("external");
  const s = services(dir);
  try {
    const task = await implemented(dir, s, "external");
    const check = await startRun(s, dir, task.taskId, "check", {
      external: [{ path: "notes.txt", content: "main session\n" }],
      report: PASS,
    });
    const status = await waitTerminal(s, dir, check.runId);
    assert.equal(status.state, "completed", status.result?.failureReason ?? "");
    assert.equal(status.acceptance.reason, "check_pass");
    assert.deepEqual(status.result.externalChanges, ["notes.txt"]);
    const checkFile = new RunStore(dir).readCheck(check.runId);
    assert.equal(checkFile.checkerChangedPaths, undefined);
    assert.equal(stageOf(dir, task), "deliver");
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.status, "closed");
  } finally {
    cleanup(dir, s);
  }
});

test("接收侧兜底：[read, exec] 检查结果带归属改动 → needs_attention write_without_capability", async () => {
  const dir = project("accept-guard");
  const s = services(dir);
  try {
    const task = await implemented(dir, s, "accept-guard");
    const prepared = await s.coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "check",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "fake", model: "fake-model" },
    });
    await s.coordinator.start({ dir, runId: prepared.request.runId, prepareOnly: true });
    writeFileSync(join(dir, "README.md"), "# legacy checker edit\n");
    new RunStore(dir).writeResult(prepared.request.runId, {
      schemaVersion: 1,
      runId: prepared.request.runId,
      taskId: task.taskId,
      phase: "check",
      state: "completed",
      report: { ...PASS, changedPaths: ["README.md"] },
      reportSummary: PASS.summary,
      nativeEntries: { startEntryId: null, leafEntryId: null },
      usage: { inputTokens: null, outputTokens: null },
      session: null,
      actualChangedPaths: ["README.md"],
      acceptanceOperationId: prepared.request.acceptanceOperationId,
      recordedAt: new Date().toISOString(),
      failureReason: null,
    });
    const accepted = await s.acceptance.accept({ dir, runId: prepared.request.runId });
    assert.equal(accepted.accepted, false);
    assert.equal(accepted.reason, "write_without_capability:README.md");
    assert.equal((await s.store.bindings.get(task.taskId)).lastCheckRunId, null);
  } finally {
    cleanup(dir, s);
  }
});

test("允许写的检查：修复后 pass → checkerChangedPaths、标注显示、close 报 check_self_modified；再跑无改动 pass 后可完成，提交说明不带自检标注", async () => {
  const dir = project("recheck", { checkWrite: true });
  const s = services(dir);
  try {
    const task = await implemented(dir, s, "recheck");
    const fix = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "README.md", content: "# fixed by checker\n" }],
      report: { ...PASS, changedPaths: ["README.md"], selfVerified: true, findings: ["README 有误，已修"] },
    });
    const fixStatus = await waitTerminal(s, dir, fix.runId);
    assert.equal(fixStatus.state, "completed", fixStatus.result?.failureReason ?? "");
    assert.equal(fixStatus.acceptance.reason, "check_pass");
    const runs = new RunStore(dir);
    assert.deepEqual(runs.readCheck(fix.runId).checkerChangedPaths, ["README.md"]);
    assert.equal(stageOf(dir, task), "deliver");

    // run status／status 同样显示标注与下一步。
    const statusService = new StatusService({ store: s.store, locksRoot: join(dir, ".locks") });
    const runView = await statusService.runStatus(dir, fix.runId);
    assert.deepEqual(runView.checkerChangedPaths, ["README.md"]);
    assert.equal(runView.verificationLabel, "independent（检查者修复 1 个路径，修复部分为自检）");
    assert.ok(runView.nextActions.some((line) => line.includes(`knit run check --task ${task.taskId}`)));
    const taskView = await statusService.taskStatus(dir, task.taskId);
    assert.equal(taskView.verificationLabel, "independent（检查者修复 1 个路径，修复部分为自检）");
    assert.deepEqual(taskView.lastCheckChangedPaths, ["README.md"]);
    const runText = execFileSync(process.execPath, [CLI, "run", "status", fix.runId, "--dir", dir, "--locks", join(dir, ".locks")], { encoding: "utf8" });
    assert.match(runText, /验证: independent（检查者修复 1 个路径，修复部分为自检）/);
    const taskText = execFileSync(process.execPath, [CLI, "status", task.taskId, "--dir", dir, "--locks", join(dir, ".locks")], { encoding: "utf8" });
    assert.match(taskText, /完成验证: independent（检查者修复 1 个路径，修复部分为自检）/);

    // independent 完成资格：检查者改过文件 → check_self_modified；deliver 同样在创建操作前拒绝。
    await assert.rejects(
      () => s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true }),
      (error) => error.details?.guardReason === "check_self_modified",
    );
    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    await assert.rejects(
      () => delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "check_self_modified",
    );
    assert.equal(runs.readCompletion(task.taskId), null);

    // 复查：从 deliver 派检查阶段，任务回到 check；这次不改任何文件且 pass，凭据替换。
    const recheck = await startRun(s, dir, task.taskId, "check", { report: { ...PASS, summary: "复查通过" } });
    const recheckStatus = await waitTerminal(s, dir, recheck.runId);
    assert.equal(recheckStatus.state, "completed", recheckStatus.result?.failureReason ?? "");
    assert.equal(recheckStatus.acceptance.reason, "check_pass");
    assert.equal(runs.readCheck(recheck.runId).checkerChangedPaths, undefined);
    assert.equal((await s.store.bindings.get(task.taskId)).lastCheckRunId, recheck.runId);
    assert.equal(stageOf(dir, task), "deliver");
    assert.equal((await statusService.taskStatus(dir, task.taskId)).verificationLabel, "independent");

    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.status, "closed");
    assert.equal(closed.checkRunId, recheck.runId);
    assert.equal(runs.readCompletion(task.taskId).checkerChangedPaths, undefined);

    const result = await delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    for (const commit of [result.workCommit, result.metadataCommit]) {
      const body = git(dir, ["log", "-1", "--format=%B", commit]);
      assert.match(body, new RegExp(`验证：independent — 检查 ${recheck.runId} 通过`));
      assert.doesNotMatch(body, /自检/);
    }
  } finally {
    cleanup(dir, s);
  }
});

test("审计 F3 旧完成凭据（检查者改过文件仍以 independent 完成）：交付提交「验证」行带自检标注", async () => {
  const dir = project("legacy", { checkWrite: true });
  const s = services(dir);
  try {
    const task = await implemented(dir, s, "legacy");
    const fix = await startRun(s, dir, task.taskId, "check", {
      writes: [{ path: "README.md", content: "# fixed by checker\n" }],
      report: { ...PASS, changedPaths: ["README.md"], selfVerified: true },
    });
    assert.equal((await waitTerminal(s, dir, fix.runId)).acceptance.reason, "check_pass");
    // 模拟本任务之前已关闭的历史任务：完成凭据直接写入（不经新的完成守卫）。
    const runs = new RunStore(dir);
    const file = join(dir, ".knit", task.relativePath);
    const raw = readFileSync(file);
    const { parseTaskDocument, renderTaskDocument } = await import("../dist/application/task-document.js");
    const document = parseTaskDocument(raw.toString("utf8"), file);
    const completion = new CompletionService({ store: s.store, randomHex }).record({
      root: dir,
      taskId: task.taskId,
      document,
      raw,
      decision: { allowed: true, mode: "independent", implementedBy: "run", implementRunId: null, checkRunId: fix.runId, unverified: [] },
    });
    assert.deepEqual(completion.checkerChangedPaths, ["README.md"], "完成凭据照实记录检查者修复路径");
    writeFileSync(file, renderTaskDocument({ ...document, frontmatter: { ...document.frontmatter, status: "closed", outcome: "completed" } }));
    assert.equal(runs.readCompletion(task.taskId).checkRunId, fix.runId);

    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    const result = await delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    for (const commit of [result.workCommit, result.metadataCommit]) {
      const body = git(dir, ["log", "-1", "--format=%B", commit]);
      assert.match(body, new RegExp(`验证：independent（检查者修复 1 个路径，修复部分为自检） — 检查 ${fix.runId} 通过`));
      assert.doesNotMatch(body, /验证：independent — /, "不再输出不带标注的 independent 通过");
    }
  } finally {
    cleanup(dir, s);
  }
});
