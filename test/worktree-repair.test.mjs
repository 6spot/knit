/**
 * worktree repair 测试（任务 k-d10f8d4c2833；WORKTREE.md §6.5、DESIGN.md §16.3）。
 * 隔离夹具：真实 Git 仓库 + worktree create/handoff/prepare；覆盖整体移动、global 布局、
 * 冲突／不可证明、活动阻塞、部分修复重试、只读与项目级错误、Session 映射与任务13路由回归。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { WorktreePrepareService } from "../dist/application/worktree-prepare.js";
import { WorktreeRepairService, REPAIR_DIR } from "../dist/application/worktree-repair.js";
import { resolveProjectStart, executionRouteOf, assertExecutionRoute } from "../dist/application/worktree-routing.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
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

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** 项目夹具：base/old 为项目根，base/locks 为锁根（项目移动后仍可复用）。 */
function fixture(prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `knit-wr-${prefix}-`)));
  const root = join(base, "old");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(root, ".knit"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(root, "README.md"), "# demo\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return { base, root, locksRoot: join(base, "locks") };
}

function services(dir, locksRoot) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: locksRoot });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({ store, locks, randomHex, lockRoot: locksRoot, confirmTimeoutMs: 8000 });
  return { store, locks, tasks, coordinator };
}

async function readyTask(dir, s, title, slug) {
  const task = await s.tasks.newTask({ dir, title, slug, verification: "self" });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

/** 建 worktree → 交接任务资料；global 布局通过临时 HOME 固定全局根。 */
async function setupWorktree(dir, s, taskId, options = {}) {
  let created;
  if (options.global === true) {
    const previous = process.env.HOME;
    process.env.HOME = options.home;
    try {
      created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir, taskId, global: true });
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  } else {
    created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir, taskId });
  }
  const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(dir) }).handoff({ dir, taskId });
  return { path: created.worktree.path, branch: created.worktree.branch, relativePath: created.worktree.relativePath, taskDir: handed.targetTaskDir };
}

function moveProject(oldRoot, newRoot) {
  renameSync(oldRoot, newRoot);
  return newRoot;
}

function sessionRecord(overrides = {}) {
  return {
    knitSessionId: "s-aaaaaaaaaaaa",
    protocolVersion: 1,
    ref: { client: "pi", nativeSessionId: "native-1", role: "implement" },
    kind: "sub",
    status: "available",
    sessionFile: null,
    parentSessionId: null,
    source: null,
    taskId: null,
    branch: null,
    runId: null,
    cwd: "/tmp",
    checkpoint: null,
    selection: null,
    reason: null,
    lastVerifiedAt: null,
    nativeReadable: true,
    relatedRunState: null,
    recordedAt: "2026-11-03T10:00:00.000Z",
    ...overrides,
  };
}

function runRequest(root, taskId, runId) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    runId,
    taskId,
    phase: "implement",
    purpose: "stage",
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: root },
    createdAt: "2026-11-03T10:00:00.000Z",
    expected: {
      branch: "refs/heads/main",
      executionDir: root,
      inputsDigest: "digest",
      standardsDigest: "digest",
      effectiveInputsDigest: "digest",
      planId: "plan-1",
    },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
    toolPolicy: { mode: "write", allow: [], deny: [] },
    recovery: { nativeSessionId: null, resume: "prefer" },
    acceptanceOperationId: "op-accept-1",
    diagnostics: { enabled: false },
  };
}

function writeRunningRun(root, taskId, runId) {
  const runs = new RunStore(root);
  runs.create(runRequest(root, taskId, runId));
  runs.writeState(runId, {
    schemaVersion: 1,
    runId,
    taskId,
    phase: "implement",
    state: "running",
    worker: { workerId: "worker-test", pid: process.pid, bootId: "boot-test", procStartTicks: null, hostname: "test" },
    claimedAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    prepared: true,
    preparedAt: "2026-11-03T10:00:00.000Z",
    snapshot: null,
    reason: null,
  });
}

function writeUnknownRun(root, taskId, runId) {
  new RunStore(root).create(runRequest(root, taskId, runId));
}

function taskDocument(dir, taskId) {
  const tasksRoot = join(dir, ".knit", "tasks");
  for (const name of execFileSync("sh", ["-c", `find ${JSON.stringify(tasksRoot)} -name task.md`], { encoding: "utf8" }).trim().split("\n")) {
    if (name === "") continue;
    const document = parseTaskDocument(readFileSync(name, "utf8"), name);
    if (document.frontmatter.id === taskId) return document;
  }
  return null;
}

function repairReceipts(dir) {
  const root = join(dir, REPAIR_DIR);
  if (!existsSync(root)) return [];
  return execFileSync("sh", ["-c", `find ${JSON.stringify(root)} -name receipt.json`], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
    .sort()
    .map((file) => JSON.parse(readFileSync(file, "utf8")));
}

function journalLines(dir, opId) {
  return readFileSync(join(dir, REPAIR_DIR, opId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function prepareInput(mainRoot, taskId, executionDir) {
  return {
    dir: mainRoot,
    taskId,
    phase: "implement",
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: mainRoot },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
    ...(executionDir === undefined ? {} : { executionDir }),
  };
}

async function startRun(s, mainRoot, taskId, executionDir) {
  const prepared = await s.coordinator.prepare(prepareInput(mainRoot, taskId, executionDir));
  const action = join(mainRoot, ".fake-action.json");
  writeFileSync(action, JSON.stringify({
    writes: [{ path: "README.md", content: "# repaired worktree\n" }],
    report: { summary: "repaired dispatch", changedPaths: ["README.md"] },
  }));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = action;
  try {
    const started = await s.coordinator.start({ dir: mainRoot, runId: prepared.request.runId });
    assert.equal(started.confirmed, true, `worker 未确认: ${started.launch.lastError ?? ""}`);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const status = await s.coordinator.status({ dir: mainRoot, runId: prepared.request.runId });
      if (isRunSettled(status)) return { prepared, status, runId: prepared.request.runId };
      if (Date.now() > deadline) throw new Error(`run 未终止: ${status.state}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
  }
}

test("1) 整体移动 project 布局：repair 修复关联、binding 与执行路由，历史 run 不变", async () => {
  const f = fixture("move");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "move project", "move-project");
    const wt = await setupWorktree(f.root, s, task.taskId);
    await new WorktreePrepareService({ store: s.store, locks: s.locks }).prepare({ dir: f.root, taskId: task.taskId });
    const oldWorktreePath = wt.path;

    // 历史 run 与受影响 Session 在移动前落盘。
    writeRunningRun(f.root, task.taskId, "run-000000000001");
    new RunStore(f.root).writeState("run-000000000001", {
      schemaVersion: 1,
      runId: "run-000000000001",
      taskId: task.taskId,
      phase: "implement",
      state: "completed",
      worker: { workerId: "worker-test", pid: process.pid, bootId: "boot-test", procStartTicks: null, hostname: "test" },
      claimedAt: "2026-11-03T10:00:00.000Z",
      updatedAt: "2026-11-03T10:00:00.000Z",
      prepared: true,
      preparedAt: "2026-11-03T10:00:00.000Z",
      snapshot: null,
      reason: null,
    });
    const originalRequest = readFileSync(new RunStore(f.root).runDir("run-000000000001") + "/request.json", "utf8");
    const sessionsRoot = join(f.root, ".knit", ".runtime", "pi-sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, "main.jsonl"), "{}\n");
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-aaaaaaaaaaaa",
      taskId: task.taskId,
      cwd: f.root,
      sessionFile: join(sessionsRoot, "main.jsonl"),
    }));
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-bbbbbbbbbbbb",
      ref: { client: "pi", nativeSessionId: "native-2", role: "check" },
      taskId: task.taskId,
      cwd: oldWorktreePath,
      sessionFile: null,
      checkpoint: "checkpoint-1",
      selection: { taskId: task.taskId, branch: wt.branch, entryRef: "entry-1", operationId: "op-1", recordedAt: "2026-11-03T10:00:00.000Z", persisted: true, pendingReason: null },
    }));
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-cccccccccccc",
      ref: { client: "pi", nativeSessionId: "native-3", role: "implement" },
      taskId: task.taskId,
      cwd: "/tmp/not-under-old-root",
      sessionFile: null,
    }));
    const bindingBefore = await s.store.bindings.get(task.taskId);
    s.store.close();

    const newRoot = moveProject(f.root, join(f.base, "new"));
    const newWorktreePath = join(newRoot, wt.relativePath);
    s = services(newRoot, f.locksRoot);
    const repair = new WorktreeRepairService({ store: s.store, locks: s.locks });
    const readOnly = await repair.repair({ dir: newRoot });
    const readTask = readOnly.tasks.find((entry) => entry.taskId === task.taskId);
    assert.equal(readOnly.apply, false);
    assert.equal(readTask.status, "repairable");
    assert.equal(readOnly.opId, null);
    assert.equal(existsSync(join(newRoot, REPAIR_DIR)), false, "只读预检不创建操作目录");
    assert.equal((await s.store.bindings.get(task.taskId)).repoRoot, f.root, "只读不写 binding");
    assert.match(git(newRoot, ["worktree", "list", "--porcelain"]), /old\/\.knit\/worktrees/, "只读不执行 git repair");

    const applied = await repair.repair({ dir: newRoot, apply: true });
    const appliedTask = applied.tasks.find((entry) => entry.taskId === task.taskId);
    assert.equal(appliedTask.status, "repaired");
    assert.equal(appliedTask.association, "valid");
    assert.ok(applied.opId);
    assert.ok(existsSync(applied.receiptPath));
    assert.ok(existsSync(applied.journalPath));
    assert.match(git(newRoot, ["worktree", "list", "--porcelain"]), new RegExp(newWorktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.repoRoot, newRoot);
    assert.equal(binding.worktree.path, newWorktreePath);
    assert.equal(binding.worktree.relativePath, bindingBefore.worktree.relativePath);
    assert.equal(binding.worktree.branch, bindingBefore.worktree.branch);
    assert.equal(binding.worktree.baseline, bindingBefore.worktree.baseline);
    assert.equal(binding.worktree.handoffAt, bindingBefore.worktree.handoffAt);
    assert.equal(binding.worktree.lastHandoffOp, bindingBefore.worktree.lastHandoffOp);
    assert.equal(binding.worktree.active, true);
    assert.equal(binding.worktree.preparedAt, bindingBefore.worktree.preparedAt);
    assert.equal(binding.worktree.lastRepairOp, applied.opId);
    assert.ok(binding.worktree.repairedAt);

    const route = executionRouteOf(binding, newRoot);
    assert.equal(route.state, "worktree");
    assert.equal(route.dir, newWorktreePath);
    assert.doesNotThrow(() => assertExecutionRoute(route, newWorktreePath));
    assert.throws(() => assertExecutionRoute(route, newRoot), (error) => error.guardReason === "execution_dir_mismatch");

    // 历史 run 的 request 不改写；新路由由 binding 提供。
    assert.equal(readFileSync(new RunStore(newRoot).runDir("run-000000000001") + "/request.json", "utf8"), originalRequest);
    // Session 映射与字段保留。
    const mainSession = await s.store.sessions.getByKnitId("s-aaaaaaaaaaaa");
    assert.equal(mainSession.cwd, newRoot);
    assert.equal(mainSession.sessionFile, join(newRoot, ".knit", ".runtime", "pi-sessions", "main.jsonl"));
    assert.equal(mainSession.knitSessionId, "s-aaaaaaaaaaaa");
    assert.equal(mainSession.ref.nativeSessionId, "native-1");
    const worktreeSession = await s.store.sessions.getByKnitId("s-bbbbbbbbbbbb");
    assert.equal(worktreeSession.cwd, newWorktreePath);
    assert.equal(worktreeSession.checkpoint, "checkpoint-1");
    assert.equal(worktreeSession.selection.entryRef, "entry-1");
    const outside = await s.store.sessions.getByKnitId("s-cccccccccccc");
    assert.equal(outside.cwd, "/tmp/not-under-old-root");

    // worktree status／list 均正常。
    const status = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "worktree", "status", "--task", task.taskId, "--dir", newRoot], { encoding: "utf8" }));
    assert.equal(status.data.state, "worktree");
    assert.equal(status.data.dir, newWorktreePath);
    const list = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "worktree", "list", "--dir", newRoot], { encoding: "utf8" }));
    assert.equal(list.data.entries.find((entry) => entry.taskId === task.taskId).state, "worktree");
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("2) global 布局：主项目移动后修复关联，worktree.path 不变、repoRoot 更新", async () => {
  const f = fixture("global");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "global move", "global-move");
    const home = join(f.base, "home");
    mkdirSync(home, { recursive: true });
    const wt = await setupWorktree(f.root, s, task.taskId, { global: true, home });
    assert.equal(existsSync(wt.path), true);
    const globalPath = wt.path;
    s.store.close();

    const newRoot = moveProject(f.root, join(f.base, "new"));
    assert.equal(existsSync(globalPath), true, "global worktree 不随项目移动");
    s = services(newRoot, f.locksRoot);
    const repair = new WorktreeRepairService({ store: s.store, locks: s.locks });
    const applied = await repair.repair({ dir: newRoot, apply: true });
    const taskResult = applied.tasks.find((entry) => entry.taskId === task.taskId);
    assert.equal(taskResult.status, "repaired");

    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.repoRoot, newRoot);
    assert.equal(binding.worktree.path, globalPath, "global 布局路径保持不变");
    assert.equal(binding.worktree.layout, "global");
    assert.ok(binding.worktree.repairedAt);
    assert.match(git(globalPath, ["rev-parse", "--show-toplevel"]).trim(), new RegExp(globalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(resolveProjectStart(globalPath).mainRoot, newRoot);
    assert.equal(executionRouteOf(binding, newRoot).state, "worktree");
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("3) 新路径 frontmatter／分支不符 → conflict，binding 原样保留", async () => {
  const f = fixture("conflict");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "conflict task", "conflict-task");
    const wt = await setupWorktree(f.root, s, task.taskId);
    const bindingBefore = await s.store.bindings.get(task.taskId);
    s.store.close();
    const newRoot = moveProject(f.root, join(f.base, "new"));
    const newWorktreePath = join(newRoot, wt.relativePath);
    // 新路径被另一个任务身份占用（frontmatter id 不符）。
    const taskFile = join(newWorktreePath, ".knit", "tasks", basename(wt.taskDir), "task.md");
    writeFileSync(taskFile, readFileSync(taskFile, "utf8").replace(`id: ${task.taskId}`, "id: k-ffffffffffff"));

    s = services(newRoot, f.locksRoot);
    const repair = new WorktreeRepairService({ store: s.store, locks: s.locks });
    const applied = await repair.repair({ dir: newRoot, apply: true });
    const taskResult = applied.tasks.find((entry) => entry.taskId === task.taskId);
    assert.equal(taskResult.status, "conflict");
    assert.match(taskResult.reason, /身份不符/);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.repoRoot, bindingBefore.repoRoot);
    assert.equal(binding.worktree.path, bindingBefore.worktree.path);
    assert.equal(binding.worktree.repairedAt, undefined);
    assert.match(git(newRoot, ["worktree", "list", "--porcelain"]), /old\/\.knit\/worktrees/);
    assert.equal(taskDocument(newRoot, task.taskId), null);
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("4) 新路径缺失／关系不可证明 → invalid，保留条目与诊断，不启动任务", async () => {
  const f = fixture("invalid");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "invalid task", "invalid-task");
    const wt = await setupWorktree(f.root, s, task.taskId);
    const bindingBefore = await s.store.bindings.get(task.taskId);
    const runsBefore = new RunStore(f.root).listRunIds().length;
    s.store.close();
    const newRoot = moveProject(f.root, join(f.base, "new"));
    const newWorktreePath = join(newRoot, wt.relativePath);
    rmSync(newWorktreePath, { recursive: true, force: true });

    s = services(newRoot, f.locksRoot);
    const applied = await new WorktreeRepairService({ store: s.store, locks: s.locks }).repair({ dir: newRoot, apply: true });
    const taskResult = applied.tasks.find((entry) => entry.taskId === task.taskId);
    assert.equal(taskResult.status, "invalid");
    assert.match(taskResult.reason, /新路径缺失/);
    assert.ok(applied.receiptPath !== null);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.repoRoot, bindingBefore.repoRoot);
    assert.equal(binding.worktree.path, bindingBefore.worktree.path);
    assert.equal(binding.lastRunIds.length, 0);
    assert.equal(new RunStore(newRoot).listRunIds().length, runsBefore, "不新建 run");
    assert.equal(existsSync(newWorktreePath), false, "不重建缺失目录");
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("5) 活动／未知执行阻塞该任务；其它候选修复并如实报告", async () => {
  const f = fixture("blocked");
  let s = services(f.root, f.locksRoot);
  try {
    const activeTask = await readyTask(f.root, s, "active task", "active-task");
    const unknownTask = await readyTask(f.root, s, "unknown task", "unknown-task");
    const okTask = await readyTask(f.root, s, "ok task", "ok-task");
    await setupWorktree(f.root, s, activeTask.taskId);
    await setupWorktree(f.root, s, unknownTask.taskId);
    await setupWorktree(f.root, s, okTask.taskId);
    writeRunningRun(f.root, activeTask.taskId, "run-000000000002");
    writeUnknownRun(f.root, unknownTask.taskId, "run-000000000003");
    s.store.close();

    const newRoot = moveProject(f.root, join(f.base, "new"));
    s = services(newRoot, f.locksRoot);
    const applied = await new WorktreeRepairService({ store: s.store, locks: s.locks }).repair({ dir: newRoot, apply: true });
    const byId = new Map(applied.tasks.map((entry) => [entry.taskId, entry]));
    assert.equal(byId.get(activeTask.taskId).status, "blocked_active");
    assert.equal(byId.get(unknownTask.taskId).status, "blocked_unknown");
    assert.equal(byId.get(okTask.taskId).status, "repaired");

    const activeBinding = await s.store.bindings.get(activeTask.taskId);
    const unknownBinding = await s.store.bindings.get(unknownTask.taskId);
    const okBinding = await s.store.bindings.get(okTask.taskId);
    assert.equal(activeBinding.repoRoot, f.root);
    assert.equal(unknownBinding.repoRoot, f.root);
    assert.equal(okBinding.repoRoot, newRoot);
    assert.equal(activeBinding.worktree.repairedAt, undefined);
    assert.equal(unknownBinding.worktree.repairedAt, undefined);
    assert.ok(okBinding.worktree.repairedAt);

    const receipt = JSON.parse(readFileSync(applied.receiptPath, "utf8"));
    const receiptById = new Map(receipt.tasks.map((entry) => [entry.taskId, entry.status]));
    assert.equal(receiptById.get(activeTask.taskId), "blocked_active");
    assert.equal(receiptById.get(unknownTask.taskId), "blocked_unknown");
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("6) 部分修复后重试：已修复项 no-op，未完成项继续，receipt／journal 可核对", async () => {
  const f = fixture("retry");
  let s = services(f.root, f.locksRoot);
  try {
    const first = await readyTask(f.root, s, "first task", "first-task");
    const second = await readyTask(f.root, s, "second task", "second-task");
    const firstWt = await setupWorktree(f.root, s, first.taskId);
    const secondWt = await setupWorktree(f.root, s, second.taskId);
    s.store.close();
    const newRoot = moveProject(f.root, join(f.base, "new"));
    const secondNew = join(newRoot, secondWt.relativePath);
    const held = join(f.base, "held-second");
    renameSync(secondNew, held); // 模拟第二项尚未就位

    s = services(newRoot, f.locksRoot);
    const repair = new WorktreeRepairService({ store: s.store, locks: s.locks });
    const firstRun = await repair.repair({ dir: newRoot, apply: true });
    const firstById = new Map(firstRun.tasks.map((entry) => [entry.taskId, entry]));
    assert.equal(firstById.get(first.taskId).status, "repaired");
    assert.equal(firstById.get(second.taskId).status, "invalid");
    const firstReceipt = JSON.parse(readFileSync(firstRun.receiptPath, "utf8"));
    assert.ok(firstReceipt.finishedAt !== null);
    assert.equal(firstReceipt.tasks.find((entry) => entry.taskId === first.taskId).status, "repaired");
    assert.equal(firstReceipt.tasks.find((entry) => entry.taskId === second.taskId).status, "invalid");
    const lines = journalLines(newRoot, firstRun.opId);
    assert.ok(lines.some((line) => line.stepId === "precheck"));
    assert.ok(lines.some((line) => line.stepId === "result" && line.taskId === second.taskId && line.kind === "invalid"));

    renameSync(held, secondNew); // 位置就绪后重试
    const secondRun = await repair.repair({ dir: newRoot, apply: true });
    const secondById = new Map(secondRun.tasks.map((entry) => [entry.taskId, entry]));
    assert.equal(secondById.get(first.taskId).status, "ok");
    assert.equal(secondById.get(second.taskId).status, "repaired");
    assert.deepEqual(secondById.get(first.taskId).appliedActions, []);
    const firstBinding = await s.store.bindings.get(first.taskId);
    const secondBinding = await s.store.bindings.get(second.taskId);
    assert.equal(firstBinding.worktree.path, firstWt.path.replace(f.root, newRoot));
    assert.equal(secondBinding.worktree.path, secondNew);
    assert.equal(secondBinding.worktree.lastRepairOp, secondRun.opId);

    // 全部一致后再次 apply：no-op，不产生新操作目录。
    const third = await repair.repair({ dir: newRoot, apply: true });
    assert.equal(third.noop, true);
    assert.equal(third.opId, null);
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("7) 只读模式无写入；非 Git 根与关联 worktree 内运行明确报错", async () => {
  const f = fixture("readonly");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "readonly task", "readonly-task");
    const wt = await setupWorktree(f.root, s, task.taskId);
    // 关联 worktree 内运行：身份错误，明确拒绝。
    const wrongStart = spawnSync(process.execPath, [CLI, "--json", "worktree", "repair", "--dir", wt.path, "--apply"], { encoding: "utf8" });
    assert.notEqual(wrongStart.status, 0);
    assert.match(wrongStart.stderr + wrongStart.stdout, /只在主检出/);

    s.store.close();
    const newRoot = moveProject(f.root, join(f.base, "new"));
    s = services(newRoot, f.locksRoot);
    const beforeList = git(newRoot, ["worktree", "list", "--porcelain"]);
    const readOnly = await new WorktreeRepairService({ store: s.store, locks: s.locks }).repair({ dir: newRoot });
    assert.equal(readOnly.noop, false);
    assert.equal(existsSync(join(newRoot, REPAIR_DIR)), false);
    assert.equal(git(newRoot, ["worktree", "list", "--porcelain"]), beforeList);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.repoRoot, join(f.base, "old"));
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }

  const notGit = realpathSync(mkdtempSync(join(tmpdir(), "knit-wr-notgit-")));
  try {
    const result = spawnSync(process.execPath, [CLI, "--json", "worktree", "repair", "--dir", notGit, "--apply"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /需要 Git 工作区/);
    assert.equal(existsSync(join(notGit, ".knit")), false, "项目级错误不写半份结果");
  } finally {
    rmSync(notGit, { recursive: true, force: true });
  }
});

test("8) 无移动时 apply 为 no-op，不产生 Git 副作用", async () => {
  const f = fixture("noop");
  let s = services(f.root, f.locksRoot);
  try {
    const plain = await readyTask(f.root, s, "plain task", "plain-task");
    const worktreeTask = await readyTask(f.root, s, "worktree task", "worktree-task");
    await setupWorktree(f.root, s, worktreeTask.taskId);
    const bindingBefore = await s.store.bindings.get(worktreeTask.taskId);
    const beforeList = git(f.root, ["worktree", "list", "--porcelain"]);
    const result = await new WorktreeRepairService({ store: s.store, locks: s.locks }).repair({ dir: f.root, apply: true });
    assert.equal(result.noop, true);
    assert.equal(result.opId, null);
    assert.equal(existsSync(join(f.root, REPAIR_DIR)), false);
    assert.equal(git(f.root, ["worktree", "list", "--porcelain"]), beforeList);
    const plainBinding = await s.store.bindings.get(plain.taskId);
    const worktreeBinding = await s.store.bindings.get(worktreeTask.taskId);
    assert.equal(plainBinding.repoRoot, f.root);
    assert.equal(worktreeBinding.worktree.repairedAt, undefined);
    assert.equal(worktreeBinding.worktree.path, bindingBefore.worktree.path);
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("9) Session 映射：旧根／旧 worktree 下映射，新位置文件缺失时保留 sessionFile", async () => {
  const f = fixture("session");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "session task", "session-task");
    const wt = await setupWorktree(f.root, s, task.taskId);
    const sessionsRoot = join(f.root, ".knit", ".runtime", "pi-sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, "exists.jsonl"), "{}\n");
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-111111111111",
      taskId: task.taskId,
      cwd: f.root,
      sessionFile: join(sessionsRoot, "exists.jsonl"),
      source: { kind: "fork", fromSessionId: "s-ffffffffffff", reason: null },
    }));
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-222222222222",
      ref: { client: "pi", nativeSessionId: "native-missing", role: "implement" },
      taskId: task.taskId,
      cwd: join(wt.path, "nested"),
      sessionFile: join(sessionsRoot, "missing.jsonl"),
    }));
    s.store.close();
    const newRoot = moveProject(f.root, join(f.base, "new"));
    const newWorktreePath = join(newRoot, wt.relativePath);
    s = services(newRoot, f.locksRoot);
    await new WorktreeRepairService({ store: s.store, locks: s.locks }).repair({ dir: newRoot, apply: true });

    const exists = await s.store.sessions.getByKnitId("s-111111111111");
    assert.equal(exists.cwd, newRoot);
    assert.equal(exists.sessionFile, join(newRoot, ".knit", ".runtime", "pi-sessions", "exists.jsonl"));
    assert.deepEqual(exists.source, { kind: "fork", fromSessionId: "s-ffffffffffff", reason: null });
    const missing = await s.store.sessions.getByKnitId("s-222222222222");
    assert.equal(missing.cwd, join(newWorktreePath, "nested"));
    assert.equal(missing.sessionFile, join(f.root, ".knit", ".runtime", "pi-sessions", "missing.jsonl"), "新位置无文件时不改 sessionFile");
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("10) 任务13回归：修复后 worktree 内派发按新路径执行，主检出拒绝、status／list 正常", async () => {
  const f = fixture("dispatch");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "dispatch after repair", "dispatch-after-repair");
    const wt = await setupWorktree(f.root, s, task.taskId);
    s.store.close();
    const newRoot = moveProject(f.root, join(f.base, "new"));
    const newWorktreePath = join(newRoot, wt.relativePath);
    s = services(newRoot, f.locksRoot);
    await new WorktreeRepairService({ store: s.store, locks: s.locks }).repair({ dir: newRoot, apply: true });
    // prepare 使用修复后的登记与执行目录。
    await new WorktreePrepareService({ store: s.store, locks: s.locks }).prepare({ dir: newRoot, taskId: task.taskId });

    const { prepared, status } = await startRun(s, newRoot, task.taskId, newWorktreePath);
    assert.equal(prepared.request.expected.executionDir, newWorktreePath);
    assert.equal(status.state, "completed");
    assert.equal(status.result.state, "completed");
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"]);
    assert.equal(readFileSync(join(newWorktreePath, "README.md"), "utf8"), "# repaired worktree\n");
    assert.equal(readFileSync(join(newRoot, "README.md"), "utf8"), "# demo\n");
    assert.ok(existsSync(join(newRoot, ".knit", ".runtime", "runs", prepared.request.runId, "snapshot", "manifest.json")));

    // 主检出拒绝 worktree-active 任务派发。
    await assert.rejects(
      s.coordinator.prepare(prepareInput(newRoot, task.taskId)),
      (error) => error.guardReason === "execution_dir_mismatch",
    );

    const statusJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "worktree", "status", "--task", task.taskId, "--dir", newRoot], { encoding: "utf8" }));
    assert.equal(statusJson.data.state, "worktree");
    assert.equal(statusJson.data.dir, newWorktreePath);
    const listJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "worktree", "list", "--dir", newRoot], { encoding: "utf8" }));
    const entry = listJson.data.entries.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(entry.state, "worktree");
    assert.equal(entry.problem, null);
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("11) 候选包含没有 worktree 的任务：整体移动后只更新 repoRoot", async () => {
  const f = fixture("plain");
  let s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(f.root, s, "plain binding", "plain-binding");
    s.store.close();
    const newRoot = moveProject(f.root, join(f.base, "new"));
    s = services(newRoot, f.locksRoot);
    const applied = await new WorktreeRepairService({ store: s.store, locks: s.locks }).repair({ dir: newRoot, apply: true });
    const taskResult = applied.tasks.find((entry) => entry.taskId === task.taskId);
    assert.equal(taskResult.status, "repaired");
    assert.deepEqual(taskResult.appliedActions, ["binding"]);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.repoRoot, newRoot);
    assert.equal(binding.worktree, undefined);
    assert.match(binding.relativePath, /^tasks\/\d{2}-\d{2}-plain-binding\/task\.md$/);
  } finally {
    try { s.store.close(); } catch {}
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
