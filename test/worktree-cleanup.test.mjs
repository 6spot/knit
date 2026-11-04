/**
 * worktree cleanup 测试（任务 k-7e09de42a7a3；WORKTREE.md §6.4、DESIGN.md §10/§16.3）。
 * 隔离夹具：真实 Git 仓库 + worktree create/handoff；覆盖只读预览、正式 apply、保全与
 * Session 迁移、阻断项、dirty 与分支、缺失文件、中断续做、noop/invalid、CLI 拒绝。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { WorktreeCleanupService, CLEANUP_DIR } from "../dist/application/worktree-cleanup.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { parseTaskDocument } from "../dist/application/task-document.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture(prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `knit-wc-${prefix}-`)));
  const root = join(base, "root");
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
  return { store, locks, tasks };
}

function taskFileOf(dir, taskId) {
  const tasksRoot = join(dir, ".knit", "tasks");
  for (const name of execFileSync("sh", ["-c", `find ${JSON.stringify(tasksRoot)} -name task.md`], { encoding: "utf8" }).trim().split("\n")) {
    if (name === "") continue;
    const document = parseTaskDocument(readFileSync(name, "utf8"), name);
    if (document.frontmatter.id === taskId) return name;
  }
  return null;
}

/** 真实任务 frontmatter 收尾（不经过完成资格，只用于夹具准备）。 */
function markClosed(dir, taskId, outcome = "cancelled") {
  const file = taskFileOf(dir, taskId);
  assert.ok(file, `缺少任务文档: ${taskId}`);
  const text = readFileSync(file, "utf8")
    .replace(/^status: .*$/m, "status: closed")
    .replace(/^outcome: .*$/m, `outcome: ${outcome}`);
  writeFileSync(file, text);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

async function readyTask(dir, s, title, slug) {
  const task = await s.tasks.newTask({ dir, title, slug, verification: "self" });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

/** 已结束任务的 worktree；open=false 时保持任务未结束。 */
async function setupWorktree(dir, s, slug, options = {}) {
  const task = await readyTask(dir, s, options.title ?? slug, slug);
  if (options.closed !== false) markClosed(dir, task.taskId, options.outcome ?? "cancelled");
  commitAll(dir, `task ${slug}`);
  const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir, taskId: task.taskId });
  const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(dir) }).handoff({ dir, taskId: task.taskId });
  return { task, worktree: created.worktree, taskDir: handed.targetTaskDir };
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

function runState(root, taskId, runId, state) {
  return {
    schemaVersion: 1,
    runId,
    taskId,
    phase: "implement",
    state,
    worker: { workerId: "worker-test", pid: process.pid, bootId: "boot-test", procStartTicks: null, hostname: "test" },
    claimedAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    prepared: true,
    preparedAt: "2026-11-03T10:00:00.000Z",
    snapshot: null,
    reason: null,
  };
}

function writeRun(root, taskId, runId, options = {}) {
  const runs = new RunStore(root);
  runs.create(runRequest(root, taskId, runId));
  if (options.state !== undefined) runs.writeState(runId, runState(root, taskId, runId, options.state));
  if (options.result === true) {
    runs.writeResult(runId, {
      schemaVersion: 1,
      runId,
      taskId,
      phase: "implement",
      state: "completed",
      report: { summary: "done", changedPaths: [] },
      reportSummary: "done",
      nativeEntries: { startEntryId: null, leafEntryId: null },
      usage: { inputTokens: null, outputTokens: null },
      session: null,
      actualChangedPaths: [],
      acceptanceOperationId: "op-accept-1",
      recordedAt: "2026-11-03T10:00:00.000Z",
      failureReason: null,
    });
  }
}

function cleanupDirExists(root) {
  return existsSync(join(root, CLEANUP_DIR));
}

function cleanupReceipts(root) {
  const dir = join(root, CLEANUP_DIR);
  if (!existsSync(dir)) return [];
  return execFileSync("sh", ["-c", `find ${JSON.stringify(dir)} -name receipt.json`], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
    .sort()
    .map((file) => JSON.parse(readFileSync(file, "utf8")));
}

function journalLines(root, opId) {
  return readFileSync(join(root, CLEANUP_DIR, opId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function cli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

test("1) 只读预览：可清理报告完整，不创建运行目录、不改 binding／Session、不删除目录", async () => {
  const f = fixture("preview");
  const s = services(f.root, f.locksRoot);
  try {
    const { task, worktree } = await setupWorktree(f.root, s, "preview-task");
    const bindingBefore = await s.store.bindings.get(task.taskId);
    const sessionsRoot = join(f.root, ".knit", ".runtime", "pi-sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, "main.jsonl"), "{}\n");
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-111111111111",
      taskId: task.taskId,
      cwd: worktree.path,
      sessionFile: join(sessionsRoot, "main.jsonl"),
    }));
    const sessionBefore = await s.store.sessions.getByKnitId("s-111111111111");

    const result = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: task.taskId });
    assert.equal(result.apply, false);
    assert.equal(result.status, "removable");
    assert.equal(result.opId, null);
    assert.equal(result.receiptPath, null);
    assert.equal(result.taskStatus, "closed");
    assert.equal(result.taskOutcome, "cancelled");
    assert.equal(result.worktree.path, worktree.path);
    assert.equal(cleanupDirExists(f.root), false, "预览不创建运行目录");
    assert.equal(existsSync(worktree.path), true);
    assert.deepEqual(await s.store.bindings.get(task.taskId), bindingBefore, "预览不改 binding");
    assert.deepEqual(await s.store.sessions.getByKnitId("s-111111111111"), sessionBefore, "预览不改 Session");
    assert.match(git(f.root, ["worktree", "list", "--porcelain"]), new RegExp(worktree.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(git(f.root, ["rev-parse", "--verify", "--quiet", worktree.branch]).trim() !== "", true, "预览保留分支");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("2) 正常 apply：先保全后删除，Session 改指，binding 清空，历史 run 不变，回执可核对", async () => {
  const f = fixture("apply");
  const s = services(f.root, f.locksRoot);
  try {
    const { task, worktree, taskDir } = await setupWorktree(f.root, s, "apply-task");
    writeFileSync(join(taskDir, "draft.md"), "未跟踪草稿\n");
    const sessionsRoot = join(worktree.path, ".knit", ".runtime", "pi-sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, "native.jsonl"), "{\"native\":true}\n");
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-222222222222",
      ref: { client: "pi", nativeSessionId: "native-2", role: "implement" },
      taskId: task.taskId,
      cwd: join(worktree.path, ".knit"),
      sessionFile: join(sessionsRoot, "native.jsonl"),
    }));
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-333333333333",
      ref: { client: "pi", nativeSessionId: "native-3", role: "check" },
      taskId: task.taskId,
      cwd: worktree.path,
      sessionFile: allowMainSessionFile(f.root),
    }));
    // 历史终态 run：request 不得被清理改写。
    writeRun(f.root, task.taskId, "run-000000000001", { state: "failed" });
    const requestFile = join(f.root, ".knit", ".runtime", "runs", "run-000000000001", "request.json");
    const requestBefore = readFileSync(requestFile, "utf8");
    const runsBefore = new RunStore(f.root).listRunIds();

    const result = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:cleanup-approved",
      discardChanges: true,
    });
    assert.equal(result.status, "removed", result.reason ?? "");
    assert.ok(result.opId);
    assert.equal(result.taskStatus, "closed");
    assert.equal(existsSync(worktree.path), false, "worktree 已删除");
    assert.equal(git(f.root, ["rev-parse", "--verify", "--quiet", worktree.branch]).trim() !== "", true, "默认保留分支");

    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.worktree, undefined, "binding.worktree 已清空");
    assert.equal(binding.repoRoot, f.root);
    assert.equal(binding.relativePath !== "", true);
    assert.equal(existsSync(join(f.root, ".knit", "tasks")) && taskFileOf(f.root, task.taskId) !== null, true, "主检出任务资料仍在");

    const preserved = join(result.receiptPath, "..", "preserved", "task-material");
    assert.equal(readFileSync(join(preserved, "draft.md"), "utf8"), "未跟踪草稿\n");
    assert.ok(readFileSync(join(preserved, "task.md"), "utf8").includes("status: closed"));

    const copiedSession = await s.store.sessions.getByKnitId("s-222222222222");
    assert.equal(copiedSession.cwd, f.root, "cwd 指向主检出");
    assert.match(copiedSession.sessionFile, new RegExp(`${f.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.knit/\\.runtime/pi-sessions/native\\.jsonl$`));
    assert.equal(readFileSync(copiedSession.sessionFile, "utf8"), "{\"native\":true}\n", "复制后可读");
    const cwdOnly = await s.store.sessions.getByKnitId("s-333333333333");
    assert.equal(cwdOnly.cwd, f.root);

    assert.equal(readFileSync(requestFile, "utf8"), requestBefore, "历史 run request 不变");
    assert.deepEqual(new RunStore(f.root).listRunIds(), runsBefore, "不新建 run");

    const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.opId, result.opId);
    assert.equal(receipt.mainRoot, f.root);
    assert.equal(receipt.authorizationRef, "user:cleanup-approved");
    assert.equal(receipt.authorization.kind, "user_reference");
    assert.equal(receipt.finishedAt !== null, true);
    assert.equal(receipt.preserved.taskMaterial.files.some((entry) => entry.path === "draft.md" && entry.sha256 !== null), true);
    assert.equal(receipt.sessions.some((entry) => entry.knitSessionId === "s-222222222222" && entry.applied === true), true);
    assert.equal(receipt.branchDeletion, null);
    assert.deepEqual([...receipt.steps.map((step) => step.stepId)].sort(), ["binding", "branch", "session-files", "sessions", "task-material", "worktree"]);
    assert.equal(receipt.steps.every((step) => step.state !== "failed"), true);

    const journal = journalLines(f.root, result.opId);
    assert.ok(journal.some((line) => line.stepId === "plan" && line.kind === "planned"));
    assert.ok(journal.some((line) => line.stepId === "preserve" && line.kind === "applied"));
    assert.ok(journal.some((line) => line.stepId === "remove" && line.kind === "applied"));
    assert.ok(journal.some((line) => line.stepId === "finish" && line.kind === "completed"));
    const operation = await s.store.operations.get(result.opId);
    assert.equal(operation.kind, "worktree.cleanup");
    assert.equal(operation.state, "completed");

    const again = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:cleanup-approved",
    });
    assert.equal(again.status, "noop");
    assert.equal(again.opId, null);
    assert.equal(cleanupReceipts(f.root).length, 1, "重复 apply 不新建回执");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

function allowMainSessionFile(root) {
  const dir = join(root, ".knit", ".runtime", "pi-sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "check.jsonl");
  writeFileSync(file, "{}\n");
  return file;
}

test("3) 未结束任务、活动／未知执行、任务锁占用、worktree locked：分别阻断且现场不变", async () => {
  const f = fixture("blocks");
  const s = services(f.root, f.locksRoot);
  try {
    // 未结束任务
    const open = await setupWorktree(f.root, s, "block-open", { closed: false });
    const openResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: open.task.taskId });
    assert.equal(openResult.status, "blocked_task_open");
    assert.equal(existsSync(open.worktree.path), true);
    assert.notEqual((await s.store.bindings.get(open.task.taskId)).worktree, undefined);

    // 活动 run
    const active = await setupWorktree(f.root, s, "block-active");
    writeRun(f.root, active.task.taskId, "run-000000000002", { state: "running" });
    const activeResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: active.task.taskId });
    assert.equal(activeResult.status, "blocked_active");
    assert.match(activeResult.reason, /run-000000000002/);
    assert.equal(existsSync(active.worktree.path), true);

    // 已完成 run 但结果尚未接收
    const unaccepted = await setupWorktree(f.root, s, "block-unaccepted");
    writeRun(f.root, unaccepted.task.taskId, "run-000000000003", { state: "completed", result: true });
    const unacceptedResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: unaccepted.task.taskId });
    assert.equal(unacceptedResult.status, "blocked_active", unacceptedResult.reason);
    assert.match(unacceptedResult.reason, /待接收/);
    assert.equal(existsSync(unaccepted.worktree.path), true);

    // 未知 run 状态
    const unknown = await setupWorktree(f.root, s, "block-unknown");
    writeRun(f.root, unknown.task.taskId, "run-000000000004");
    const unknownResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: unknown.task.taskId });
    assert.equal(unknownResult.status, "blocked_unknown");
    assert.equal(existsSync(unknown.worktree.path), true);

    // 任务锁被占用
    const lockedTask = await setupWorktree(f.root, s, "block-lock");
    const holder = new LockManager({ root: f.locksRoot });
    const held = await holder.acquire({ keys: [{ scope: "task", rawKey: `${f.root}::${lockedTask.task.taskId}` }], action: "test" });
    try {
      const lockResult = await new WorktreeCleanupService({ store: s.store, locks: new LockManager({ root: f.locksRoot }) }).cleanup({ dir: f.root, taskId: lockedTask.task.taskId });
      assert.equal(lockResult.status, "blocked_active");
      assert.equal(existsSync(lockedTask.worktree.path), true);
    } finally {
      holder.release(held);
    }

    // Git worktree locked
    const lockedWorktree = await setupWorktree(f.root, s, "block-wt-lock");
    git(f.root, ["worktree", "lock", lockedWorktree.worktree.path]);
    try {
      const lockedResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
        dir: f.root,
        taskId: lockedWorktree.task.taskId,
        discardChanges: true,
      });
      assert.equal(lockedResult.status, "blocked_locked");
      assert.equal(existsSync(lockedWorktree.worktree.path), true);
    } finally {
      git(f.root, ["worktree", "unlock", lockedWorktree.worktree.path]);
    }

    assert.equal(cleanupDirExists(f.root), false, "全部阻断不创建运行目录");
    assert.equal(cleanupReceipts(f.root).length, 0);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("4) dirty 默认阻断；--discard-changes 时先保全任务资料再删除 ignored／untracked", async () => {
  const f = fixture("dirty");
  const s = services(f.root, f.locksRoot);
  try {
    const { task, worktree, taskDir } = await setupWorktree(f.root, s, "dirty-task");
    writeFileSync(join(taskDir, "draft.md"), "draft\n");
    mkdirSync(join(worktree.path, "ignored-dir"), { recursive: true });
    writeFileSync(join(worktree.path, "ignored-dir", "cache.bin"), "cache");
    writeFileSync(join(worktree.path, ".gitignore"), ".knit/.runtime/\nignored-dir/\n");

    const preview = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: task.taskId });
    assert.equal(preview.status, "blocked_dirty");
    assert.ok(preview.dirty.entries >= 2);

    const blockedApply = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:no",
    });
    assert.equal(blockedApply.status, "blocked_dirty");
    assert.equal(blockedApply.opId, null);
    assert.equal(cleanupDirExists(f.root), false, "阻断的 apply 不创建操作目录");
    assert.equal(existsSync(worktree.path), true);

    const applied = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:discard",
      discardChanges: true,
    });
    assert.equal(applied.status, "removed", applied.reason ?? "");
    assert.equal(existsSync(worktree.path), false, "ignored／untracked 内容随目录清除");
    const preserved = JSON.parse(readFileSync(applied.receiptPath, "utf8")).preserved.taskMaterial;
    assert.ok(preserved.files.some((entry) => entry.path === "draft.md"));
    const target = join(applied.receiptPath, "..", "preserved", "task-material", "draft.md");
    assert.equal(readFileSync(target, "utf8"), "draft\n");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("5) --branch：已合入删除；未合入阻断；--discard-branch 明确丢弃后删除", async () => {
  const f = fixture("branch");
  const s = services(f.root, f.locksRoot);
  try {
    const merged = await setupWorktree(f.root, s, "branch-merged");
    writeFileSync(join(f.root, "main-only.txt"), "main\n");
    commitAll(f.root, "advance main");
    const mergedResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: merged.task.taskId,
      apply: true,
      authorizationRef: "user:merged",
      branch: true,
    });
    assert.equal(mergedResult.status, "removed", mergedResult.reason ?? "");
    assert.equal(mergedResult.branch.result, "deleted");
    assert.equal(mergedResult.branch.mergeCheck, "merged");
    assert.equal(mergedResult.branch.target, "refs/heads/main");
    assert.equal(mergedResult.branch.discarded, false);
    assert.notEqual(spawnSync("git", ["rev-parse", "--verify", merged.worktree.branch], { cwd: f.root, encoding: "utf8" }).status, 0);

    const unmerged = await setupWorktree(f.root, s, "branch-unmerged");
    writeFileSync(join(unmerged.worktree.path, "feature.txt"), "feature\n");
    commitAll(unmerged.worktree.path, "feature commit");
    const blocked = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: unmerged.task.taskId,
      apply: true,
      authorizationRef: "user:unmerged",
      branch: true,
    });
    assert.equal(blocked.status, "blocked_unmerged");
    assert.equal(blocked.opId, null);
    assert.equal(existsSync(unmerged.worktree.path), true);
    assert.equal(git(f.root, ["rev-parse", "--verify", unmerged.worktree.branch]).trim() !== "", true);

    const discarded = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: unmerged.task.taskId,
      apply: true,
      authorizationRef: "user:discard-branch",
      branch: true,
      discardBranch: true,
      discardChanges: false,
    });
    assert.equal(discarded.status, "removed", discarded.reason ?? "");
    assert.equal(discarded.branch.discarded, true);
    assert.equal(discarded.branch.mergeCheck, "unmerged");
    assert.equal(discarded.branch.result, "deleted");
    assert.notEqual(spawnSync("git", ["rev-parse", "--verify", unmerged.worktree.branch], { cwd: f.root, encoding: "utf8" }).status, 0);

    await assert.rejects(
      () => new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: unmerged.task.taskId, discardBranch: true }),
      (error) => error.guardReason === "invalid_request",
    );
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("6) Session 文件在 worktree：复制改指、冲突加 ID 前缀；缺失文件如实记录", async () => {
  const f = fixture("sessions");
  const s = services(f.root, f.locksRoot);
  try {
    const { task, worktree } = await setupWorktree(f.root, s, "session-task");
    const sessionsRoot = join(worktree.path, ".knit", ".runtime", "pi-sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, "native.jsonl"), "{\"v\":1}\n");
    const mainSessions = join(f.root, ".knit", ".runtime", "pi-sessions");
    mkdirSync(mainSessions, { recursive: true });
    writeFileSync(join(mainSessions, "native.jsonl"), "{\"other\":true}\n");
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-444444444444",
      ref: { client: "pi", nativeSessionId: "native-4", role: "implement" },
      taskId: task.taskId,
      cwd: worktree.path,
      sessionFile: join(sessionsRoot, "native.jsonl"),
    }));
    const missingFile = join(sessionsRoot, "missing.jsonl");
    await s.store.sessions.save(sessionRecord({
      knitSessionId: "s-555555555555",
      ref: { client: "pi", nativeSessionId: "native-5", role: "check" },
      taskId: task.taskId,
      cwd: join(worktree.path, ".knit"),
      sessionFile: missingFile,
    }));

    const result = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:sessions",
      discardChanges: true,
    });
    assert.equal(result.status, "removed", result.reason ?? "");

    const copied = await s.store.sessions.getByKnitId("s-444444444444");
    assert.equal(copied.cwd, f.root);
    assert.equal(basename(copied.sessionFile), "s-444444444444-native.jsonl", "冲突时加 Knit Session ID 前缀");
    assert.equal(readFileSync(copied.sessionFile, "utf8"), "{\"v\":1}\n");
    assert.equal(readFileSync(join(mainSessions, "native.jsonl"), "utf8"), "{\"other\":true}\n", "不覆盖既有文件");

    const missing = await s.store.sessions.getByKnitId("s-555555555555");
    assert.equal(missing.cwd, f.root);
    assert.equal(missing.sessionFile, null, "缺失文件不冒充可恢复");
    assert.equal(missing.status, "missing");
    assert.equal(missing.nativeReadable, false);
    const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
    const missingRecord = receipt.preserved.sessionFiles.find((entry) => entry.knitSessionId === "s-555555555555");
    assert.equal(missingRecord.missing, true);
    assert.equal(missingRecord.target, null);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("7) 中断／部分成功重试：按未完成回执继续；重复 apply 幂等 noop", async () => {
  const f = fixture("resume");
  const s = services(f.root, f.locksRoot);
  try {
    const { task, worktree } = await setupWorktree(f.root, s, "resume-task");
    // 主检出任务资料故意落后（open），删除后只能以回执保全副本的 closed 事实续做。
    const mainTaskFile = taskFileOf(f.root, task.taskId);
    writeFileSync(mainTaskFile, readFileSync(mainTaskFile, "utf8")
      .replace(/^status: .*$/m, "status: open")
      .replace(/^outcome: .*$/m, "outcome: null"));
    commitAll(f.root, "stale main task copy");
    let failBindingSave = true;
    const wrapper = {
      bindings: {
        get: (taskId) => s.store.bindings.get(taskId),
        list: () => s.store.bindings.list(),
        save: async (binding) => {
          if (failBindingSave) {
            failBindingSave = false;
            throw new Error("simulated binding save failure");
          }
          return s.store.bindings.save(binding);
        },
      },
      sessions: s.store.sessions,
      operations: s.store.operations,
    };
    const first = await new WorktreeCleanupService({ store: wrapper, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:resume",
    });
    assert.equal(first.status, "partial");
    assert.equal(existsSync(worktree.path), false, "目录已删除");
    assert.notEqual((await s.store.bindings.get(task.taskId)).worktree, undefined, "binding 尚未清除");
    const pendingReceipt = JSON.parse(readFileSync(first.receiptPath, "utf8"));
    assert.equal(pendingReceipt.finishedAt, null);
    assert.equal(pendingReceipt.steps.find((step) => step.stepId === "worktree").state, "completed");
    assert.equal(pendingReceipt.steps.find((step) => step.stepId === "binding").state, "failed");

    const second = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:resume",
    });
    assert.equal(second.status, "removed", second.reason ?? "");
    assert.equal(second.opId, first.opId, "沿用同一操作目录");
    assert.equal((await s.store.bindings.get(task.taskId)).worktree, undefined);
    const finished = JSON.parse(readFileSync(second.receiptPath, "utf8"));
    assert.notEqual(finished.finishedAt, null);
    assert.equal(finished.steps.every((step) => step.state !== "planned" && step.state !== "failed"), true);
    assert.equal(cleanupReceipts(f.root).length, 1);

    const third = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: task.taskId,
      apply: true,
      authorizationRef: "user:resume",
    });
    assert.equal(third.status, "noop");
    assert.equal(third.opId, null);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("8) 无 worktree → noop；路径缺失／分支不符 → invalid 且保留 binding", async () => {
  const f = fixture("invalid");
  const s = services(f.root, f.locksRoot);
  try {
    const noTree = await readyTask(f.root, s, "no tree", "no-tree");
    markClosed(f.root, noTree.taskId);
    commitAll(f.root, "no-tree closed");
    const noop = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: noTree.taskId });
    assert.equal(noop.status, "noop");
    const noopApply = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({
      dir: f.root,
      taskId: noTree.taskId,
      apply: true,
      authorizationRef: "user:noop",
    });
    assert.equal(noopApply.status, "noop");
    assert.equal(noopApply.opId, null);

    const missing = await setupWorktree(f.root, s, "missing-path");
    const bindingBefore = await s.store.bindings.get(missing.task.taskId);
    rmSync(missing.worktree.path, { recursive: true, force: true });
    const missingResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: missing.task.taskId });
    assert.equal(missingResult.status, "invalid");
    assert.match(missingResult.reason, /路径缺失/);
    assert.deepEqual(await s.store.bindings.get(missing.task.taskId), bindingBefore);

    const mismatch = await setupWorktree(f.root, s, "branch-mismatch");
    const mismatchBinding = await s.store.bindings.get(mismatch.task.taskId);
    await s.store.bindings.save({
      ...mismatchBinding,
      worktree: { ...mismatchBinding.worktree, branch: "refs/heads/other-branch" },
    });
    const mismatchResult = await new WorktreeCleanupService({ store: s.store, locks: s.locks }).cleanup({ dir: f.root, taskId: mismatch.task.taskId });
    assert.equal(mismatchResult.status, "invalid");
    assert.match(mismatchResult.reason, /分支不符/);
    assert.equal((await s.store.bindings.get(mismatch.task.taskId)).worktree.branch, "refs/heads/other-branch");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("9) 关联 worktree 内调用拒绝；apply 无授权引用拒绝且不触碰现场", async () => {
  const f = fixture("cli");
  const s = services(f.root, f.locksRoot);
  try {
    const { task, worktree } = await setupWorktree(f.root, s, "cli-task");
    const inside = cli(["--json", "worktree", "cleanup", "--task", task.taskId, "--dir", worktree.path], f.root);
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr + inside.stdout, /主检出/);
    assert.equal(existsSync(worktree.path), true);

    const unauth = cli(["worktree", "cleanup", "--task", task.taskId, "--apply", "--dir", f.root], f.root);
    assert.notEqual(unauth.status, 0);
    assert.match(unauth.stderr + unauth.stdout, /authorization-ref/);
    assert.equal(existsSync(worktree.path), true);
    assert.equal(cleanupDirExists(f.root), false);

    const preview = cli(["--json", "worktree", "cleanup", "--task", task.taskId, "--dir", f.root], f.root);
    assert.equal(preview.status, 0, preview.stderr);
    const parsed = JSON.parse(preview.stdout);
    assert.equal(parsed.data.status, "removable");
    assert.equal(parsed.data.opId, null);
    assert.equal(cleanupDirExists(f.root), false);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
