/**
 * 任务17：多任务并行——按执行目录调度与冲突保护。
 * 隔离夹具：真实 Git 仓库／worktree、真实 worker 子进程、fake Pi RPC；不调用真实模型。
 * 覆盖：不同 worktree 并行、同执行目录互斥、同任务复用、路由改动拒绝、
 * 并行取消／失败隔离、status／locks 对执行目录锁可观察、主检出串行回归。
 */
import { writeAcceptanceFixture } from "./helpers/scenarios.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { WorktreePrepareService } from "../dist/application/worktree-prepare.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { isRunSettled } from "./helpers/run-settled.mjs";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-parallel-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.go*\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  const acceptance = new RunAcceptanceService({ store, locks, randomHex });
  return { store, locks, tasks, coordinator, acceptance };
}

async function readyTask(dir, s, title) {
  const task = await s.tasks.newTask({ dir, title, slug: title.replace(/\s+/g, "-"), verification: "independent" });
  writeAcceptanceFixture(dir, task.taskId);
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function prepareInput(dir, taskId, executionDir) {
  return {
    dir,
    taskId,
    phase: "implement",
    ...(executionDir === undefined ? {} : { executionDir }),
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
  };
}

function actionFile(dir, action) {
  const path = join(dir, ".fake-action.json");
  writeFileSync(path, JSON.stringify(action));
  return path;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(25);
  }
}

function projectLockEntries(dir) {
  return new LockManager({ root: join(dir, ".locks") })
    .list()
    .filter((entry) => entry.scope === "project");
}

function projectLockKeys(dir) {
  return projectLockEntries(dir)
    .map((entry) => entry.key)
    .filter((key) => key !== null);
}

async function waitTerminal(s, dir, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await s.coordinator.status({ dir, runId });
    if (isRunSettled(status)) return status;
    if (Date.now() > deadline) throw new Error(`run 未终止: ${status.state}`);
    await sleep(50);
  }
}

function taskPhase(taskDir) {
  return parseTaskDocument(readFileSync(join(taskDir, "task.md"), "utf8")).frontmatter.stage;
}

/** 已完成结果夹具：接收前由测试写入，模拟 prepare-only 后的外部结果。 */
function resultFixture(request, summary) {
  return {
    schemaVersion: 1,
    runId: request.runId,
    taskId: request.taskId,
    phase: request.phase,
    state: "completed",
    report: { summary, changedPaths: ["README.md"] },
    reportSummary: summary,
    nativeEntries: { startEntryId: null, leafEntryId: null },
    usage: { inputTokens: null, outputTokens: null },
    session: null,
    actualChangedPaths: ["README.md"],
    acceptanceOperationId: request.acceptanceOperationId,
    recordedAt: new Date().toISOString(),
    failureReason: null,
  };
}

/** 建 worktree → 交接 → prepare；返回现场与绑定登记。 */
async function setupWorktree(dir, s, taskId) {
  const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir, taskId });
  const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(dir) }).handoff({ dir, taskId });
  await new WorktreePrepareService({ store: s.store, locks: s.locks }).prepare({ dir, taskId });
  const binding = await s.store.bindings.get(taskId);
  assert.ok(binding !== null && binding.worktree !== undefined);
  return { path: created.worktree.path, branch: created.worktree.branch, info: binding.worktree, taskDir: handed.targetTaskDir };
}

/** 第二个任务登记到同一 worktree（复用已完成的公共准备）。 */
async function shareWorktree(dir, s, taskId, info) {
  const binding = await s.store.bindings.get(taskId);
  assert.ok(binding !== null);
  await s.store.bindings.save({
    ...binding,
    worktree: { ...info, active: false, handoffAt: null, lastHandoffOp: null },
  });
  const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(dir) }).handoff({ dir, taskId });
  await new WorktreePrepareService({ store: s.store, locks: s.locks }).prepare({ dir, taskId });
  assert.ok(handed.targetTaskDir !== null);
  return handed.targetTaskDir;
}

function cleanup(s, dir) {
  s.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

test("不同 worktree 并行：两个执行目录锁同时存在，主检出锁不被占用，结果各自接收", async () => {
  const dir = project("two");
  const s = services(dir);
  try {
    const taskA = await readyTask(dir, s, "parallel a");
    const taskB = await readyTask(dir, s, "parallel b");
    const wtA = await setupWorktree(dir, s, taskA.taskId);
    const wtB = await setupWorktree(dir, s, taskB.taskId);
    assert.notEqual(wtA.path, wtB.path);

    const prepA = await s.coordinator.prepare(prepareInput(dir, taskA.taskId, wtA.path));
    const prepB = await s.coordinator.prepare(prepareInput(dir, taskB.taskId, wtB.path));
    assert.equal(prepA.request.expected.executionDir, wtA.path);
    assert.equal(prepB.request.expected.executionDir, wtB.path);

    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".go",
      writes: [{ path: "README.md", content: "# parallel\n" }],
      report: { summary: "parallel", changedPaths: ["README.md"] },
    });
    const [startedA, startedB] = await Promise.all([
      s.coordinator.start({ dir, runId: prepA.request.runId }),
      s.coordinator.start({ dir, runId: prepB.request.runId }),
    ]);
    assert.equal(startedA.confirmed, true, startedA.launch.lastError ?? "");
    assert.equal(startedB.confirmed, true, startedB.launch.lastError ?? "");

    // 两个执行目录锁同时存在；主检出 project 键未被任一 worktree run 占用。
    await waitFor(
      () => {
        const keys = projectLockKeys(dir);
        return keys.includes(wtA.path) && keys.includes(wtB.path);
      },
      "两个 worktree 执行目录锁未同时出现",
    );
    assert.equal(projectLockKeys(dir).includes(dir), false, "worktree run 不得占用主检出 project 锁");
    // 主检出键此刻仍可由其它操作取得，说明并行是执行目录隔离而非主检出串行。
    const mainManager = new LockManager({ root: join(dir, ".locks") });
    const mainLock = await mainManager.acquire({ keys: [{ scope: "project", rawKey: dir }], action: "test.main" });
    mainManager.release(mainLock);

    // status 按执行目录观察心跳；locks 同时列出两个执行目录锁；无 worktree 字段保持原样。
    const statusJson = JSON.parse(
      execFileSync(process.execPath, [CLI, "--json", "status", "--run", prepA.request.runId, "--dir", dir, "--locks", join(dir, ".locks")], {
        encoding: "utf8",
      }),
    );
    assert.equal(statusJson.data.executionDir, wtA.path);
    assert.equal(statusJson.data.heartbeat.verdict, "alive");
    const statusText = execFileSync(
      process.execPath,
      [CLI, "status", "--run", prepA.request.runId, "--dir", dir, "--locks", join(dir, ".locks")],
      { encoding: "utf8" },
    );
    assert.match(statusText, /执行目录:/);
    const locksJson = JSON.parse(
      execFileSync(process.execPath, [CLI, "--json", "locks", "--locks", join(dir, ".locks")], { encoding: "utf8" }),
    );
    const lockKeys = locksJson.data.entries.filter((entry) => entry.scope === "project").map((entry) => entry.key);
    assert.ok(lockKeys.includes(wtA.path));
    assert.ok(lockKeys.includes(wtB.path));
    assert.equal(lockKeys.includes(dir), false);
    const locksText = execFileSync(process.execPath, [CLI, "locks", "--locks", join(dir, ".locks")], { encoding: "utf8" });
    assert.ok(locksText.includes(wtA.path) && locksText.includes(wtB.path));

    writeFileSync(join(wtA.path, ".go"), "");
    writeFileSync(join(wtB.path, ".go"), "");
    const [doneA, doneB] = await Promise.all([
      waitTerminal(s, dir, prepA.request.runId),
      waitTerminal(s, dir, prepB.request.runId),
    ]);
    assert.equal(doneA.state, "completed", doneA.result?.failureReason ?? "");
    assert.equal(doneB.state, "completed", doneB.result?.failureReason ?? "");
    assert.equal(doneA.result.taskId, taskA.taskId);
    assert.equal(doneB.result.taskId, taskB.taskId);
    assert.equal(taskPhase(wtA.taskDir), "check");
    assert.equal(taskPhase(wtB.taskDir), "check");
    // 完成后两个执行目录锁都释放，主检出锁从未参与 worktree 阶段占用。
    await waitFor(() => projectLockKeys(dir).length === 0, "执行目录锁未释放");
  } finally {
    cleanup(s, dir);
  }
});

test("同一执行目录：第二个 worker 失败 lock_busy，锁释放后按既有重试启动", async () => {
  const dir = project("same");
  const s = services(dir);
  try {
    const taskA = await readyTask(dir, s, "same a");
    const taskB = await readyTask(dir, s, "same b");
    const wt = await setupWorktree(dir, s, taskA.taskId);
    const taskBDir = await shareWorktree(dir, s, taskB.taskId, wt.info);
    const prepA = await s.coordinator.prepare(prepareInput(dir, taskA.taskId, wt.path));
    const prepB = await s.coordinator.prepare(prepareInput(dir, taskB.taskId, wt.path));
    assert.equal(prepB.request.expected.executionDir, wt.path);

    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".go",
      writes: [{ path: "README.md", content: "# a\n" }],
      report: { summary: "a", changedPaths: ["README.md"] },
    });
    const startedA = await s.coordinator.start({ dir, runId: prepA.request.runId });
    assert.equal(startedA.confirmed, true, startedA.launch.lastError ?? "");
    await waitFor(() => projectLockKeys(dir).includes(wt.path), "执行目录锁未出现");

    const blocked = await s.coordinator.start({ dir, runId: prepB.request.runId });
    assert.equal(blocked.confirmed, false);
    assert.equal(blocked.launch.state, "failed");
    assert.equal(blocked.state.state, "failed");
    assert.equal(blocked.state.reason, "lock_busy");
    assert.equal(blocked.state.prepared, false);
    const runs = new RunStore(dir);
    assert.equal(existsSync(join(runs.runDir(prepB.request.runId), "inputs.json")), false);
    assert.equal(existsSync(join(runs.runDir(prepB.request.runId), "snapshot")), false);
    assert.equal(taskPhase(taskBDir), "implement");
    assert.equal(taskPhase(wt.taskDir), "implement");
    // 未取得执行目录锁的失败路径用主检出键接收失败结果；不因 A 仍持该 worktree 锁而滞留。
    await waitFor(
      async () => (await s.store.operations.get(prepB.request.acceptanceOperationId))?.state === "completed",
      "lock_busy 失败结果未完成接收",
    );
    assert.equal(new RunStore(dir).readResult(prepB.request.runId)?.failureReason, "lock_busy");

    writeFileSync(join(wt.path, ".go"), "");
    const doneA = await waitTerminal(s, dir, prepA.request.runId);
    assert.equal(doneA.state, "completed", doneA.result?.failureReason ?? "");
    await waitFor(() => !projectLockKeys(dir).includes(wt.path), "执行目录锁未释放");

    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".go2",
      writes: [{ path: "README2.md", content: "# b\n" }],
      report: { summary: "b", changedPaths: ["README2.md"] },
    });
    const retried = await s.coordinator.start({ dir, runId: prepB.request.runId, retry: true });
    assert.equal(retried.confirmed, true, retried.launch.lastError ?? "");
    assert.equal(retried.state.prepared, true);
    writeFileSync(join(wt.path, ".go2"), "");
    const doneB = await waitTerminal(s, dir, prepB.request.runId);
    assert.equal(doneB.state, "completed", doneB.result?.failureReason ?? "");
    assert.equal(doneB.result.taskId, taskB.taskId);
    // 首次 lock_busy 失败已按既有路径发布 failed result 并完成该 run 的接收操作；
    // retry 只证明锁释放后同一 run 可重新启动并完成阶段（业务推进仍由后续新 run 承担）。
    assert.equal(doneB.result.state, "completed");
  } finally {
    cleanup(s, dir);
  }
});

test("主检出 project 锁被占用时 worktree run 仍可完成接收", async () => {
  const dir = project("main-lock-accept");
  const s = services(dir);
  const mainManager = new LockManager({ root: join(dir, ".locks") });
  try {
    const task = await readyTask(dir, s, "main lock accept");
    const wt = await setupWorktree(dir, s, task.taskId);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, wt.path));

    // 主检出锁由另一操作持有；worktree run 的 worker 与接收都不得占用该键。
    const mainLock = await mainManager.acquire({ keys: [{ scope: "project", rawKey: dir }], action: "test.main" });
    try {
      process.env.KNIT_PI_BIN = FAKE_PI;
      process.env.KNIT_FAKE_ACTION = actionFile(dir, {
        waitFile: ".go",
        writes: [{ path: "README.md", content: "# accepted while main locked\n" }],
        report: { summary: "main locked", changedPaths: ["README.md"] },
      });
      const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
      assert.equal(started.confirmed, true, started.launch.lastError ?? "");
      await waitFor(() => projectLockKeys(dir).includes(wt.path), "worktree 执行目录锁未出现");
      assert.equal(projectLockKeys(dir).includes(dir), true, "测试主检出锁应保持");

      writeFileSync(join(wt.path, ".go"), "");
      const done = await waitTerminal(s, dir, prepared.request.runId);
      assert.equal(done.state, "completed", done.result?.failureReason ?? "");
      assert.equal(done.acceptance?.state, "completed");
      const operation = await s.store.operations.get(prepared.request.acceptanceOperationId);
      assert.equal(operation.state, "completed");
    } finally {
      mainManager.release(mainLock);
    }
  } finally {
    cleanup(s, dir);
  }
});

test("两个 worktree 并行接收互不阻塞，主检出锁不参与", async () => {
  const dir = project("parallel-accept");
  const s = services(dir);
  const mainManager = new LockManager({ root: join(dir, ".locks") });
  try {
    const taskA = await readyTask(dir, s, "parallel accept a");
    const taskB = await readyTask(dir, s, "parallel accept b");
    const wtA = await setupWorktree(dir, s, taskA.taskId);
    const wtB = await setupWorktree(dir, s, taskB.taskId);
    const prepA = await s.coordinator.prepare(prepareInput(dir, taskA.taskId, wtA.path));
    const prepB = await s.coordinator.prepare(prepareInput(dir, taskB.taskId, wtB.path));

    // 只准备不执行阶段，随后由测试写入结果并从外部并行接收。
    await s.coordinator.start({ dir, runId: prepA.request.runId, prepareOnly: true });
    await s.coordinator.start({ dir, runId: prepB.request.runId, prepareOnly: true });
    await waitFor(() => !projectLockKeys(dir).includes(wtA.path) && !projectLockKeys(dir).includes(wtB.path), "准备后执行目录锁未释放");

    writeFileSync(join(wtA.path, "README.md"), "# accept a\n");
    writeFileSync(join(wtB.path, "README.md"), "# accept b\n");
    const runs = new RunStore(dir);
    runs.writeResult(prepA.request.runId, resultFixture(prepA.request, "accept a"));
    runs.writeResult(prepB.request.runId, resultFixture(prepB.request, "accept b"));

    const mainLock = await mainManager.acquire({ keys: [{ scope: "project", rawKey: dir }], action: "test.main" });
    try {
      const [acceptedA, acceptedB] = await Promise.all([
        s.acceptance.accept({ dir, runId: prepA.request.runId }),
        s.acceptance.accept({ dir, runId: prepB.request.runId }),
      ]);
      assert.equal(acceptedA.accepted, true, acceptedA.reason ?? "");
      assert.equal(acceptedB.accepted, true, acceptedB.reason ?? "");
      assert.equal((await s.store.operations.get(prepA.request.acceptanceOperationId)).state, "completed");
      assert.equal((await s.store.operations.get(prepB.request.acceptanceOperationId)).state, "completed");
    } finally {
      mainManager.release(mainLock);
    }
    assert.equal(taskPhase(wtA.taskDir), "check");
    assert.equal(taskPhase(wtB.taskDir), "check");
  } finally {
    cleanup(s, dir);
  }
});

test("同一任务第二次派发复用活动 run，不创建并行 run", async () => {
  const dir = project("reuse");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "reuse task");
    const wt = await setupWorktree(dir, s, task.taskId);
    const first = await s.coordinator.prepare(prepareInput(dir, task.taskId, wt.path));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".go",
      writes: [{ path: "README.md", content: "# reuse\n" }],
      report: { summary: "reuse", changedPaths: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId: first.request.runId });
    assert.equal(started.confirmed, true, started.launch.lastError ?? "");
    await waitFor(() => projectLockKeys(dir).includes(wt.path), "执行目录锁未出现");

    const runsBefore = new RunStore(dir).listRunIds().length;
    const again = await s.coordinator.prepare(prepareInput(dir, task.taskId, wt.path));
    assert.equal(again.reused, true);
    assert.equal(again.request.runId, first.request.runId);
    assert.equal(again.launch.runId, first.request.runId);
    assert.equal(new RunStore(dir).listRunIds().length, runsBefore, "活动 run 期间不得创建并行 run");

    writeFileSync(join(wt.path, ".go"), "");
    const done = await waitTerminal(s, dir, first.request.runId);
    assert.equal(done.state, "completed", done.result?.failureReason ?? "");
  } finally {
    cleanup(s, dir);
  }
});

test("锁内绑定路由被改动：失败 route_changed，不冻结输入或执行阶段", async () => {
  const dir = project("route-changed");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "route changed");
    const wt = await setupWorktree(dir, s, task.taskId);
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, wt.path));

    // prepare 后把绑定改回主检出路由：worker 锁内发现请求执行目录已不成立。
    const binding = await s.store.bindings.get(task.taskId);
    assert.ok(binding !== null && binding.worktree !== undefined);
    await s.store.bindings.save({ ...binding, worktree: { ...binding.worktree, active: false } });

    process.env.KNIT_PI_BIN = FAKE_PI;
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, false);
    const terminal = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.reason, "route_changed");
    assert.equal(terminal.result.failureReason, "route_changed");
    assert.equal(terminal.prepared, false);
    const runDir = new RunStore(dir).runDir(prepared.request.runId);
    assert.equal(existsSync(join(runDir, "inputs.json")), false);
    assert.equal(existsSync(join(runDir, "snapshot")), false);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
    assert.ok(!events.includes('"stage_started"'), "route_changed 不得进入阶段");
    assert.ok(events.includes("worker_failed"));
    // 现场可诊断：status 给出失败原因；任务阶段与资料未被推进。
    const status = await s.coordinator.status({ dir, runId: prepared.request.runId });
    assert.equal(status.reason, "route_changed");
    assert.equal(taskPhase(wt.taskDir), "implement");
  } finally {
    cleanup(s, dir);
  }
});

test("并行 run 的取消与失败互不影响，结果按 runId／taskId 隔离", async () => {
  const dir = project("isolation");
  const s = services(dir);
  try {
    const taskA = await readyTask(dir, s, "isolation a");
    const taskB = await readyTask(dir, s, "isolation b");
    const wtA = await setupWorktree(dir, s, taskA.taskId);
    const wtB = await setupWorktree(dir, s, taskB.taskId);
    const prepA = await s.coordinator.prepare(prepareInput(dir, taskA.taskId, wtA.path));
    const prepB = await s.coordinator.prepare(prepareInput(dir, taskB.taskId, wtB.path));

    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      waitFile: ".go",
      writes: [{ path: "README.md", content: "# isolation\n" }],
      report: { summary: "isolation", changedPaths: ["README.md"] },
    });
    const [startedA, startedB] = await Promise.all([
      s.coordinator.start({ dir, runId: prepA.request.runId }),
      s.coordinator.start({ dir, runId: prepB.request.runId }),
    ]);
    assert.equal(startedA.confirmed, true, startedA.launch.lastError ?? "");
    assert.equal(startedB.confirmed, true, startedB.launch.lastError ?? "");
    await waitFor(
      () => {
        const keys = projectLockKeys(dir);
        return keys.includes(wtA.path) && keys.includes(wtB.path);
      },
      "两个执行目录锁未同时出现",
    );

    // 取消 A：只终止 A 的 worker／Pi，B 的执行目录锁与阶段保持。
    const cancelled = await s.coordinator.cancel({ dir, runId: prepA.request.runId, reason: "parallel cancel" });
    assert.equal(cancelled.requested, true);
    const doneA = await waitTerminal(s, dir, prepA.request.runId);
    assert.equal(doneA.state, "cancelled");
    assert.equal(doneA.result.taskId, taskA.taskId);
    await waitFor(
      () => {
        const keys = projectLockKeys(dir);
        return !keys.includes(wtA.path) && keys.includes(wtB.path);
      },
      "取消 A 影响了 B 的执行目录锁",
    );

    // B 在阶段中换分支：以 branch_mismatch 失败，不影响 A 的已取消事实。
    git(wtB.path, ["checkout", "-q", "-b", "parallel-side"]);
    writeFileSync(join(wtB.path, ".go"), "");
    const doneB = await waitTerminal(s, dir, prepB.request.runId);
    assert.equal(doneB.state, "failed");
    assert.match(doneB.result.failureReason, /branch_mismatch/);
    assert.equal(doneB.result.taskId, taskB.taskId);

    assert.equal(taskPhase(wtA.taskDir), "implement");
    assert.equal(taskPhase(wtB.taskDir), "implement");
    const opA = await s.store.operations.get(prepA.request.acceptanceOperationId);
    const opB = await s.store.operations.get(prepB.request.acceptanceOperationId);
    assert.equal(opA.state, "completed");
    assert.equal(opB.state, "completed");
  } finally {
    cleanup(s, dir);
  }
});
