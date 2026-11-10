/**
 * worktree merge 测试（任务 k-200ec35a4ae0；WORKTREE.md §6.4／§6.8、DESIGN.md §10.1／§10.3）。
 * 隔离夹具：真实 Git 仓库 + worktree create/handoff + 已结束任务。覆盖只读预览、正常
 * 合入与资料／正文／binding 转交、dirty／target／任务状态阻断、真实冲突与未跟踪草稿、
 * 活动／未知 run 与锁、回执续做与幂等、合入后 deliver 接续、CLI 拒绝与缺授权。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { WorktreeMergeService, MERGE_DIR } from "../dist/application/worktree-merge.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { inputsDigestOf } from "../dist/contracts/task-inputs.js";
import { emptyScope } from "../dist/application/scope.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const NOW = new Date("2026-11-04T10:00:00.000Z");
const MAIN = "refs/heads/main";
const AUTHORIZATION = "workflow:AGENTS.md#交付";

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitCode(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status;
}

function fixture(prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `knit-wm-${prefix}-`)));
  const root = join(base, "root");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(root, ".knit"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# 项目规则\n\n## 交付\n\n允许在当前分支按任务范围提交并归档。\n");
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n.knit/worktrees/\n");
  writeFileSync(join(root, "README.md"), "# demo\n");
  writeFileSync(join(root, "app.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return { base, root, locksRoot: join(base, "locks") };
}

function services(dir, locksRoot) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: locksRoot });
  const tasks = new TaskService({ store, locks, now: () => NOW, randomHex });
  return { store, locks, tasks };
}

function mergeService(s) {
  return new WorktreeMergeService({ store: s.store, locks: s.locks, now: () => NOW });
}

function taskDirIn(root, sourceTaskDir) {
  return join(root, ".knit", "tasks", basename(sourceTaskDir));
}

function receiptFiles(root) {
  const dir = join(root, MERGE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("op-"))
    .map((name) => join(dir, name, "receipt.json"))
    .filter((file) => existsSync(file));
}

function journalLines(root, opId) {
  return readFileSync(join(root, MERGE_DIR, opId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

async function readyTask(root, s, slug, options = {}) {
  const task = await s.tasks.newTask({
    dir: root,
    title: options.title ?? slug,
    slug,
    branch: MAIN,
    verification: options.verification ?? "self",
  });
  await s.tasks.ready({ dir: root, taskId: task.taskId });
  return task;
}

/**
 * 已交接的 worktree 任务：业务文件在 worktree 分支提交，任务资料留在工作区
 * （任务资料目录内 dirty 允许），任务改为 closed/completed/deliver。
 */
async function setupWorktree(root, s, slug, options = {}) {
  const task = await readyTask(root, s, slug, options);
  const created = await new WorktreeService({ store: s.store, locks: s.locks, now: () => NOW })
    .create({ dir: root, taskId: task.taskId });
  const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(root) })
    .handoff({ dir: root, taskId: task.taskId });
  const worktree = created.worktree;
  if (options.business !== false) {
    const file = options.file ?? `${slug}.txt`;
    writeFileSync(join(worktree.path, file), options.content ?? `${slug}\n`);
    git(worktree.path, ["add", file]);
    git(worktree.path, ["commit", "-q", "-m", `feature ${slug}`]);
  }
  const taskFile = join(handed.targetTaskDir, "task.md");
  const status = options.closed === false ? "open" : "closed";
  const outcome = options.outcome ?? (options.closed === false ? "null" : "completed");
  const stage = options.stage ?? "deliver";
  let text = readFileSync(taskFile, "utf8")
    .replace(/^status: .*$/m, `status: ${status}`)
    .replace(/^outcome: .*$/m, `outcome: ${outcome}`)
    .replace(/^stage: .*$/m, `stage: ${stage}`)
    .replace(/^branch: .*$/m, `branch: ${worktree.branch}`);
  writeFileSync(taskFile, text);
  writeFileSync(join(handed.targetTaskDir, "draft.md"), "未提交草稿\n");
  text = readFileSync(taskFile, "utf8");
  return { task, worktree, taskDir: handed.targetTaskDir, taskFile, taskText: text };
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
      branch: MAIN,
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

function writeCompletionFor(root, taskId, taskFile, verification = "none") {
  const runs = new RunStore(root);
  runs.writeCompletion(taskId, {
    schemaVersion: 1,
    taskId,
    verification,
    inputsDigest: inputsDigestOf(readFileSync(taskFile, "utf8")),
    scopeDigest: emptyScope(taskId, NOW.toISOString()).digest,
    implementRunId: null,
    checkRunId: null,
    unverified: verification === "none" ? ["none"] : [],
    reason: null,
    completedAt: NOW.toISOString(),
  });
}

function cli(args, cwd, home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

test("1) 只读预览：mergeable 报告完整，无提交、无 binding／文件写入、无运行目录", async () => {
  const f = fixture("preview");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "preview-task");
    mkdirSync(join(setup.worktree.path, ".knit", ".runtime"), { recursive: true });
    writeFileSync(join(setup.worktree.path, ".knit", ".runtime", "ignored.tmp"), "ignored\n");
    const headBefore = git(f.root, ["rev-parse", "HEAD"]);
    const bindingBefore = await s.store.bindings.get(setup.task.taskId);
    const sourceBefore = readFileSync(setup.taskFile, "utf8");

    const result = await mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: MAIN });
    assert.equal(result.apply, false);
    assert.equal(result.status, "mergeable", result.reason ?? "");
    assert.equal(result.opId, null);
    assert.equal(result.receiptPath, null);
    assert.equal(result.journalPath, null);
    assert.equal(result.mergeRequired, true);
    assert.equal(result.mergeKind, null);
    assert.equal(result.beforeHead, headBefore);
    assert.equal(result.taskStatus, "closed");
    assert.equal(result.taskOutcome, "completed");
    assert.equal(result.source.path, setup.worktree.path);
    assert.equal(result.source.branch, setup.worktree.branch);
    assert.equal(result.source.baseline, setup.worktree.baseline);
    assert.equal(result.target.ref, MAIN);
    assert.equal(result.target.currentBranch, MAIN);
    assert.equal(result.material.disposition, "copied");
    assert.ok(result.material.entries.some((entry) => entry.path === "task.md" && entry.sha256 !== null));
    assert.ok(result.material.entries.some((entry) => entry.path === "draft.md"));
    assert.equal(result.document, null);
    assert.equal(result.binding, null);

    assert.equal(existsSync(join(f.root, MERGE_DIR)), false, "预览不创建运行目录");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore, "预览不产生提交");
    assert.deepEqual(await s.store.bindings.get(setup.task.taskId), bindingBefore, "预览不改 binding");
    assert.equal(readFileSync(setup.taskFile, "utf8"), sourceBefore, "预览不改任务正文");
    assert.equal(existsSync(taskDirIn(f.root, setup.taskDir)), false, "预览不复制资料");
    assert.equal(existsSync(setup.worktree.path), true);
    assert.equal(gitCode(f.root, ["rev-parse", "--verify", setup.worktree.branch]), 0, "源分支保留");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("2) 正常 apply：合入提交含 opId，资料／正文／binding 转交，源保留，回执可核对", async () => {
  const f = fixture("apply");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "apply-task");
    writeRun(f.root, setup.task.taskId, "run-000000000001", { state: "failed" });
    const runRequestFile = join(f.root, ".knit", ".runtime", "runs", "run-000000000001", "request.json");
    const runBefore = readFileSync(runRequestFile, "utf8");
    const runsBefore = new RunStore(f.root).listRunIds();
    const beforeHead = git(f.root, ["rev-parse", "HEAD"]);

    const result = await mergeService(s).merge({
      dir: f.root,
      taskId: setup.task.taskId,
      into: MAIN,
      apply: true,
      authorizationRef: AUTHORIZATION,
    });
    assert.equal(result.status, "merged", result.reason ?? "");
    assert.equal(result.mergeKind, "merge");
    assert.ok(result.opId);
    assert.equal(result.beforeHead, beforeHead);
    assert.equal(result.afterHead, git(f.root, ["rev-parse", "HEAD"]));
    assert.equal(result.mergeCommit, result.afterHead);
    assert.equal(git(f.root, ["log", "-1", "--format=%s"]), `knit: merge ${setup.task.taskId} (${result.opId})`);
    assert.equal(git(f.root, ["rev-parse", "HEAD^1"]), beforeHead);
    assert.equal(git(f.root, ["rev-parse", "HEAD^2"]), git(f.root, ["rev-parse", setup.worktree.branch]));
    assert.equal(readFileSync(join(f.root, "apply-task.txt"), "utf8"), "apply-task\n");
    const mergePaths = git(f.root, ["diff", "--name-only", beforeHead, result.mergeCommit])
      .split("\n").filter(Boolean).sort();
    assert.deepEqual(mergePaths, ["apply-task.txt"], "合入提交只含业务产物，不含任务资料");

    const mainTaskDir = taskDirIn(f.root, setup.taskDir);
    assert.equal(existsSync(mainTaskDir), true, "任务资料已复制到主检出");
    assert.equal(readFileSync(join(mainTaskDir, "draft.md"), "utf8"), "未提交草稿\n");
    const mainTaskFile = join(mainTaskDir, "task.md");
    const mainDocument = parseTaskDocument(readFileSync(mainTaskFile, "utf8"), mainTaskFile);
    assert.equal(mainDocument.frontmatter.branch, MAIN, "task.md branch 已更新到目标");
    assert.equal(mainDocument.frontmatter.status, "closed");
    assert.equal(mainDocument.frontmatter.stage, "deliver");
    assert.equal(mainDocument.frontmatter.outcome, "completed");

    const binding = await s.store.bindings.get(setup.task.taskId);
    assert.equal(binding.branch, MAIN);
    assert.equal(binding.worktree.active, false);
    assert.equal(binding.worktree.mergedAt, NOW.toISOString());
    assert.equal(binding.worktree.lastMergeOp, result.opId);
    assert.equal(binding.worktree.path, setup.worktree.path, "保留 worktree 路径");
    assert.equal(binding.worktree.branch, setup.worktree.branch, "保留 worktree 分支");
    assert.equal(binding.relativePath, `tasks/${basename(setup.taskDir)}/task.md`);

    assert.equal(existsSync(setup.worktree.path), true, "源 worktree 保留");
    assert.equal(gitCode(f.root, ["rev-parse", "--verify", setup.worktree.branch]), 0, "源分支保留");
    assert.equal(readFileSync(runRequestFile, "utf8"), runBefore, "历史 run 不变");
    assert.deepEqual(new RunStore(f.root).listRunIds(), runsBefore, "不新建 run");

    const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.opId, result.opId);
    assert.equal(receipt.taskId, setup.task.taskId);
    assert.equal(receipt.mainRoot, f.root);
    assert.equal(receipt.authorizationRef, AUTHORIZATION);
    assert.equal(receipt.authorization.kind, "workflow");
    assert.equal(receipt.authorization.verified, true);
    assert.equal(receipt.source.path, setup.worktree.path);
    assert.equal(receipt.source.branch, setup.worktree.branch);
    assert.equal(receipt.source.baseline, setup.worktree.baseline);
    assert.equal(receipt.target.ref, MAIN);
    assert.equal(receipt.merge.kind, "merge");
    assert.equal(receipt.merge.beforeHead, beforeHead);
    assert.equal(receipt.merge.commit, result.mergeCommit);
    assert.equal(receipt.material.disposition, "copied");
    assert.equal(receipt.material.targetDir, mainTaskDir);
    assert.ok(receipt.material.entries.some((entry) => entry.path === "task.md" && entry.sha256 !== null));
    assert.equal(receipt.document.changed, true);
    assert.equal(receipt.document.branchAfter, MAIN);
    assert.equal(receipt.binding.activeAfter, false);
    assert.equal(receipt.binding.lastMergeOp, result.opId);
    assert.notEqual(receipt.finishedAt, null);
    assert.deepEqual(receipt.steps.filter((step) => step.state === "failed"), []);

    const journal = journalLines(f.root, result.opId);
    for (const stepId of ["plan", "merge", "transfer", "document", "binding", "finish"]) {
      assert.ok(journal.some((line) => line.stepId === stepId), `journal 含 ${stepId}`);
    }
    const operation = await s.store.operations.get(result.opId);
    assert.equal(operation.kind, "worktree.merge");
    assert.equal(operation.state, "completed");

    const headAfter = git(f.root, ["rev-parse", "HEAD"]);
    const again = await mergeService(s).merge({
      dir: f.root,
      taskId: setup.task.taskId,
      into: MAIN,
      apply: true,
      authorizationRef: AUTHORIZATION,
    });
    assert.equal(again.status, "noop");
    assert.equal(again.opId, null);
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headAfter, "重复 apply 不产生新提交");
    assert.equal(receiptFiles(f.root).length, 1, "重复 apply 不新建回执");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("3) 源任务资料外 dirty、目标 index／tracked 脏：分别阻断且 HEAD 不变", async () => {
  const f = fixture("dirty");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "dirty-task");
    const headBefore = git(f.root, ["rev-parse", "HEAD"]);

    writeFileSync(join(setup.worktree.path, "outside.txt"), "outside\n");
    const sourcePreview = await mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: MAIN });
    assert.equal(sourcePreview.status, "blocked_dirty");
    assert.ok(sourcePreview.dirty.entries >= 1);
    assert.ok(sourcePreview.dirty.sample.includes("outside.txt"));
    const sourceApply = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(sourceApply.status, "blocked_dirty");
    assert.equal(sourceApply.opId, null);
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal((await s.store.bindings.get(setup.task.taskId)).worktree.active, true);
    assert.equal(existsSync(taskDirIn(f.root, setup.taskDir)), false);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false, "源 dirty 阻断不建运行目录");
    rmSync(join(setup.worktree.path, "outside.txt"));

    writeFileSync(join(f.root, "README.md"), "# staged\n");
    git(f.root, ["add", "README.md"]);
    const staged = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(staged.status, "blocked_target");
    assert.match(staged.reason, /index/);
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false);
    git(f.root, ["reset", "-q", "README.md"]);
    git(f.root, ["checkout", "--", "README.md"]);

    writeFileSync(join(f.root, "README.md"), "# unstaged\n");
    const unstaged = await mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: MAIN });
    assert.equal(unstaged.status, "blocked_dirty");
    assert.ok(unstaged.dirty.sample.includes("README.md"));
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(existsSync(setup.worktree.path), true);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("4) 真实冲突与未跟踪草稿阻挡：merge 失败后 abort，HEAD 恢复，源保留，状态可诊断", async () => {
  const f = fixture("conflict");
  const s = services(f.root, f.locksRoot);
  try {
    const conflicting = await setupWorktree(f.root, s, "conflict-task", { file: "conflict.txt", content: "feature\n" });
    writeFileSync(join(f.root, "conflict.txt"), "main\n");
    git(f.root, ["add", "conflict.txt"]);
    git(f.root, ["commit", "-q", "-m", "main conflict"]);
    const headBefore = git(f.root, ["rev-parse", "HEAD"]);

    const conflict = await mergeService(s).merge({
      dir: f.root, taskId: conflicting.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(conflict.status, "conflict", conflict.reason ?? "");
    assert.ok(conflict.opId);
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore, "HEAD 恢复原样");
    assert.equal(git(f.root, ["diff", "--cached", "--name-only"]), "", "index 恢复干净");
    assert.equal(gitCode(f.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]), 1, "无残余 MERGE_HEAD");
    assert.equal(readFileSync(join(f.root, "conflict.txt"), "utf8"), "main\n", "目标文件保留");
    assert.equal(existsSync(conflicting.worktree.path), true, "源 worktree 保留");
    assert.equal(gitCode(f.root, ["rev-parse", "--verify", conflicting.worktree.branch]), 0, "源分支保留");
    assert.equal(existsSync(taskDirIn(f.root, conflicting.taskDir)), false, "失败不转交资料");
    const binding = await s.store.bindings.get(conflicting.task.taskId);
    assert.equal(binding.worktree.active, true);
    assert.equal(binding.branch, conflicting.worktree.branch);
    const receipt = JSON.parse(readFileSync(conflict.receiptPath, "utf8"));
    assert.equal(receipt.finishedAt, null);
    assert.equal(receipt.merge.restored, true);
    assert.match(receipt.merge.failure, /CONFLICT|conflict/i);
    assert.equal(receipt.steps.find((step) => step.stepId === "merge").state, "failed");
    assert.equal((await s.store.operations.get(conflict.opId)).state, "needs_attention");

    const blockedDraft = await setupWorktree(f.root, s, "draft-block-task", { file: "draft-block.txt", content: "feature\n" });
    writeFileSync(join(f.root, "draft-block.txt"), "untracked draft\n");
    const headBeforeDraft = git(f.root, ["rev-parse", "HEAD"]);
    const draft = await mergeService(s).merge({
      dir: f.root, taskId: blockedDraft.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(draft.status, "conflict", draft.reason ?? "");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBeforeDraft);
    assert.equal(gitCode(f.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]), 1);
    assert.equal(readFileSync(join(f.root, "draft-block.txt"), "utf8"), "untracked draft\n", "未跟踪草稿保留");
    assert.equal(existsSync(blockedDraft.worktree.path), true);
    assert.equal(existsSync(taskDirIn(f.root, blockedDraft.taskDir)), false);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("4b) 冲突后 merge --abort 在 delivery.hooks=skip（缺省）下不触发 post-index-change／reference-transaction（k-28296c22647a）", async () => {
  const f = fixture("abort-hooks");
  const s = services(f.root, f.locksRoot);
  try {
    const conflicting = await setupWorktree(f.root, s, "abort-task", { file: "abort.txt", content: "feature\n" });
    writeFileSync(join(f.root, "abort.txt"), "main\n");
    git(f.root, ["add", "abort.txt"]);
    git(f.root, ["commit", "-q", "-m", "main conflict"]);
    // 主检出的仓库 hooks：标记写在 .git 内，不进入工作区状态。
    const marker = join(f.root, ".git", "abort-hook-ran");
    for (const name of ["post-index-change", "reference-transaction", "post-merge"]) {
      const hook = join(f.root, ".git", "hooks", name);
      writeFileSync(hook, `#!/bin/sh\necho ${name} >> '${marker}'\n`);
      chmodSync(hook, 0o755);
    }
    git(f.root, ["read-tree", "HEAD"]);
    assert.equal(existsSync(marker), true, "对照：直接 git read-tree 触发 post-index-change");
    rmSync(marker, { force: true });
    const headBefore = git(f.root, ["rev-parse", "HEAD"]);

    const conflict = await mergeService(s).merge({
      dir: f.root, taskId: conflicting.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(conflict.status, "conflict", conflict.reason ?? "");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore, "abort 后 HEAD 恢复");
    assert.equal(gitCode(f.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]), 1, "abort 已执行");
    assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("5) 目标不可用、任务未结束／已归档、Git locked：阻断且现场不变", async () => {
  const f = fixture("blocks");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "target-block");
    const headBefore = git(f.root, ["rev-parse", "HEAD"]);

    const missing = await mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: "refs/heads/absent" });
    assert.equal(missing.status, "blocked_target");
    assert.match(missing.reason, /不存在/);

    git(f.root, ["branch", "other"]);
    const notCurrent = await mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: "refs/heads/other" });
    assert.equal(notCurrent.status, "blocked_target");
    assert.match(notCurrent.reason, /当前分支/);

    await assert.rejects(
      () => mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: "main" }),
      /完整本地 refs\/heads/,
    );
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false);

    git(f.root, ["worktree", "lock", setup.worktree.path]);
    try {
      const locked = await mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: MAIN });
      assert.equal(locked.status, "blocked_locked");
      assert.match(locked.reason, /locked/);
      assert.equal(existsSync(setup.worktree.path), true);
    } finally {
      git(f.root, ["worktree", "unlock", setup.worktree.path]);
    }

    const open = await setupWorktree(f.root, s, "open-task", { closed: false });
    const openResult = await mergeService(s).merge({ dir: f.root, taskId: open.task.taskId, into: MAIN });
    assert.equal(openResult.status, "blocked_task_open");
    assert.equal(existsSync(open.worktree.path), true);

    const cancelled = await setupWorktree(f.root, s, "cancel-task", { outcome: "cancelled" });
    const cancelledResult = await mergeService(s).merge({ dir: f.root, taskId: cancelled.task.taskId, into: MAIN });
    assert.equal(cancelledResult.status, "blocked_task_open");
    assert.match(cancelledResult.reason, /outcome=cancelled/);

    const archived = await setupWorktree(f.root, s, "archived-task");
    const archiveDir = join(f.root, ".knit", "tasks", "archive", "2026-11", basename(archived.taskDir));
    mkdirSync(join(archiveDir, ".."), { recursive: true });
    cpSync(archived.taskDir, archiveDir, { recursive: true });
    const archivedResult = await mergeService(s).merge({ dir: f.root, taskId: archived.task.taskId, into: MAIN });
    assert.equal(archivedResult.status, "invalid");
    assert.match(archivedResult.reason, /已归档/);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false, "全部阻断不创建运行目录");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("5b) 目标被其它 worktree 检出：blocked_target，现场不变", async () => {
  const f = fixture("occupied");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "occupied-task");
    git(f.root, ["branch", "occupied"]);
    git(f.root, ["worktree", "add", "--force", join(f.base, "occupied-wt"), "occupied"]);
    git(f.root, ["symbolic-ref", "HEAD", "refs/heads/occupied"]);
    const headBefore = git(f.root, ["rev-parse", "HEAD"]);
    const result = await mergeService(s).merge({ dir: f.root, taskId: setup.task.taskId, into: "refs/heads/occupied" });
    assert.equal(result.status, "blocked_target");
    assert.match(result.reason, /其它 worktree/);
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false);
    assert.equal(existsSync(setup.worktree.path), true);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("6) 活动／未知 run、completed 未接收、任务锁／项目锁：阻断；释放后可 apply", async () => {
  const f = fixture("activity");
  const s = services(f.root, f.locksRoot);
  try {
    const active = await setupWorktree(f.root, s, "active-run");
    writeRun(f.root, active.task.taskId, "run-000000000011", { state: "running" });
    const activeBlocked = await mergeService(s).merge({ dir: f.root, taskId: active.task.taskId, into: MAIN });
    assert.equal(activeBlocked.status, "blocked_active");
    assert.match(activeBlocked.reason, /run-000000000011/);
    new RunStore(f.root).writeState("run-000000000011", runState(f.root, active.task.taskId, "run-000000000011", "failed"));
    const activeApplied = await mergeService(s).merge({
      dir: f.root, taskId: active.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(activeApplied.status, "merged", activeApplied.reason ?? "");

    const unknown = await setupWorktree(f.root, s, "unknown-run");
    writeRun(f.root, unknown.task.taskId, "run-000000000012");
    const unknownBlocked = await mergeService(s).merge({ dir: f.root, taskId: unknown.task.taskId, into: MAIN });
    assert.equal(unknownBlocked.status, "blocked_unknown");
    new RunStore(f.root).writeState("run-000000000012", runState(f.root, unknown.task.taskId, "run-000000000012", "failed"));
    const unknownApplied = await mergeService(s).merge({
      dir: f.root, taskId: unknown.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(unknownApplied.status, "merged", unknownApplied.reason ?? "");

    const unaccepted = await setupWorktree(f.root, s, "unaccepted-run");
    writeRun(f.root, unaccepted.task.taskId, "run-000000000013", { state: "completed", result: true });
    const unacceptedBlocked = await mergeService(s).merge({ dir: f.root, taskId: unaccepted.task.taskId, into: MAIN });
    assert.equal(unacceptedBlocked.status, "blocked_active");
    assert.match(unacceptedBlocked.reason, /待接收/);
    await s.store.operations.save({
      operationId: "op-accept-1",
      kind: "run.accept",
      state: "completed",
      reason: null,
      recordedAt: NOW.toISOString(),
    });
    const unacceptedApplied = await mergeService(s).merge({
      dir: f.root, taskId: unaccepted.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(unacceptedApplied.status, "merged", unacceptedApplied.reason ?? "");

    const taskLocked = await setupWorktree(f.root, s, "task-lock");
    const holder = new LockManager({ root: f.locksRoot });
    let held = await holder.acquire({ keys: [{ scope: "task", rawKey: `${f.root}::${taskLocked.task.taskId}` }], action: "test" });
    let blockedApply;
    try {
      blockedApply = await mergeService(s).merge({
        dir: f.root, taskId: taskLocked.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
      });
      assert.equal(blockedApply.status, "blocked_active");
      assert.match(blockedApply.reason, /任务|task/);
      assert.equal(blockedApply.opId, null, "预检即阻断，不创建操作目录");
    } finally {
      holder.release(held);
    }
    const taskLockApplied = await mergeService(s).merge({
      dir: f.root, taskId: taskLocked.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(taskLockApplied.status, "merged", taskLockApplied.reason ?? "");

    const projectLocked = await setupWorktree(f.root, s, "project-lock");
    const projectHolder = new LockManager({ root: f.locksRoot });
    held = await projectHolder.acquire({ keys: [{ scope: "project", rawKey: f.root }], action: "test" });
    try {
      const blocked = await mergeService(s).merge({ dir: f.root, taskId: projectLocked.task.taskId, into: MAIN });
      assert.equal(blocked.status, "blocked_active");
      assert.match(blocked.reason, /project|项目/);
    } finally {
      projectHolder.release(held);
    }
    const projectApplied = await mergeService(s).merge({
      dir: f.root, taskId: projectLocked.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(projectApplied.status, "merged", projectApplied.reason ?? "");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("7) 回执续做：合入已成功但资料／binding 未完成，不产生第二个合入提交；重复 apply noop", async () => {
  const f = fixture("resume");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "resume-task");
    const first = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(first.status, "merged", first.reason ?? "");
    const commitCount = git(f.root, ["rev-list", "--count", "HEAD"]);
    const mergeCommit = first.mergeCommit;

    // 模拟「合入已成功、资料／binding 未完成」的中断现场：回执未收束，binding 仍指向 worktree。
    const binding = await s.store.bindings.get(setup.task.taskId);
    const worktree = { ...binding.worktree, active: true };
    delete worktree.mergedAt;
    delete worktree.lastMergeOp;
    await s.store.bindings.save({ ...binding, branch: setup.worktree.branch, worktree });
    rmSync(taskDirIn(f.root, setup.taskDir), { recursive: true, force: true });
    const receipt = JSON.parse(readFileSync(first.receiptPath, "utf8"));
    receipt.finishedAt = null;
    writeFileSync(first.receiptPath, JSON.stringify(receipt, null, 2) + "\n");

    const resumed = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(resumed.status, "merged", resumed.reason ?? "");
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.opId, first.opId);
    assert.equal(resumed.mergeKind, "recovered");
    assert.equal(resumed.mergeCommit, mergeCommit);
    assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), commitCount, "不产生第二个合入提交");
    assert.equal(existsSync(taskDirIn(f.root, setup.taskDir)), true, "资料已补齐");
    const bindingAfter = await s.store.bindings.get(setup.task.taskId);
    assert.equal(bindingAfter.branch, MAIN);
    assert.equal(bindingAfter.worktree.active, false);
    assert.equal(bindingAfter.worktree.lastMergeOp, first.opId);
    const receiptAfter = JSON.parse(readFileSync(first.receiptPath, "utf8"));
    assert.notEqual(receiptAfter.finishedAt, null);
    assert.equal((await s.store.operations.get(first.opId)).state, "completed");
    assert.equal(receiptFiles(f.root).length, 1, "同一未完成回执续做，不新建操作目录");

    const again = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(again.status, "noop");
    assert.equal(again.opId, null);
    assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), commitCount);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("7b) binding 未完成的重试：目标 task.md 已被本操作改写 branch，不误判资料冲突", async () => {
  const f = fixture("resume-binding");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "resume-binding-task");
    const first = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(first.status, "merged", first.reason ?? "");
    const commitCount = git(f.root, ["rev-list", "--count", "HEAD"]);

    const binding = await s.store.bindings.get(setup.task.taskId);
    const worktree = { ...binding.worktree, active: true };
    delete worktree.mergedAt;
    delete worktree.lastMergeOp;
    await s.store.bindings.save({ ...binding, branch: setup.worktree.branch, worktree });
    const receipt = JSON.parse(readFileSync(first.receiptPath, "utf8"));
    receipt.finishedAt = null;
    receipt.binding = null;
    receipt.steps = receipt.steps.map((step) => (step.stepId === "binding" ? { ...step, state: "planned" } : step));
    writeFileSync(first.receiptPath, JSON.stringify(receipt, null, 2) + "\n");

    const mainTaskFile = join(taskDirIn(f.root, setup.taskDir), "task.md");
    assert.equal(parseTaskDocument(readFileSync(mainTaskFile, "utf8"), mainTaskFile).frontmatter.branch, MAIN);
    const resumed = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(resumed.status, "merged", resumed.reason ?? "");
    assert.equal(resumed.resumed, true);
    assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), commitCount, "不产生第二个合入提交");
    const bindingAfter = await s.store.bindings.get(setup.task.taskId);
    assert.equal(bindingAfter.branch, MAIN);
    assert.equal(bindingAfter.worktree.active, false);
    assert.equal(bindingAfter.worktree.lastMergeOp, first.opId);
    assert.equal(JSON.parse(readFileSync(first.receiptPath, "utf8")).binding.lastMergeOp, first.opId);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("8) 合入后 deliver --branch <target> 定位资料并通过完成校验，合入与交付提交分开", async () => {
  const f = fixture("deliver");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "deliver-task", { verification: "none" });
    const merged = await mergeService(s).merge({
      dir: f.root, taskId: setup.task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(merged.status, "merged", merged.reason ?? "");
    const mainTaskDir = taskDirIn(f.root, setup.taskDir);
    writeCompletionFor(f.root, setup.task.taskId, join(mainTaskDir, "task.md"), "none");

    const headAfterMerge = git(f.root, ["rev-parse", "HEAD"]);
    const delivery = new DeliveryService({ store: s.store, locks: s.locks, now: () => NOW, randomHex });
    const result = await delivery.deliver({
      dir: f.root,
      taskId: setup.task.taskId,
      branch: MAIN,
      authorizationRef: AUTHORIZATION,
    });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.workCommit, null);
    assert.ok(result.metadataCommit);
    assert.ok(result.archiveCommit);
    assert.ok(result.archivePath);
    assert.equal(existsSync(join(f.root, result.archivePath, "task.md")), true);
    assert.equal(existsSync(mainTaskDir), false, "原任务资料已归档移动");
    assert.notEqual(result.metadataCommit, headAfterMerge);
    assert.notEqual(result.archiveCommit, result.metadataCommit);
    assert.equal(git(f.root, ["rev-parse", `${result.metadataCommit}^`]), headAfterMerge, "资料提交接在合入提交之后");
    assert.equal(git(f.root, ["rev-parse", `${result.archiveCommit}^`]), result.metadataCommit, "归档提交接在资料提交之后");
    const subjects = git(f.root, ["log", "--format=%s", "-4"]).split("\n");
    assert.equal(subjects[0].startsWith("chore(task): archive "), true);
    assert.equal(subjects[1].startsWith("chore(task): "), true);
    assert.match(git(f.root, ["log", "-1", "--format=%B", result.archiveCommit]), /Knit-Stage: archive/);
    assert.match(git(f.root, ["log", "-1", "--format=%B", result.metadataCommit]), /Knit-Stage: metadata/);
    assert.equal(subjects[2], `knit: merge ${setup.task.taskId} (${merged.opId})`);
    const archived = parseTaskDocument(readFileSync(join(f.root, result.archivePath, "task.md"), "utf8"), "task.md");
    assert.equal(archived.frontmatter.branch, MAIN);
    assert.equal(archived.frontmatter.status, "closed");
    assert.equal(archived.frontmatter.outcome, "completed");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("9) CLI：关联 worktree 拒绝、apply 缺授权拒绝、非完整 ref 拒绝、正常预览与 apply", async () => {
  const f = fixture("cli");
  const s = services(f.root, f.locksRoot);
  try {
    const setup = await setupWorktree(f.root, s, "cli-task");
    const preview = cli(["--json", "worktree", "merge", "--task", setup.task.taskId, "--into", MAIN, "--dir", f.root], f.root, f.base);
    assert.equal(preview.status, 0, preview.stderr);
    const parsed = JSON.parse(preview.stdout);
    assert.equal(parsed.data.status, "mergeable");
    assert.equal(parsed.data.opId, null);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false, "CLI 预览不建运行目录");

    const missingAuth = cli([
      "worktree", "merge", "--task", setup.task.taskId, "--into", MAIN, "--apply", "--dir", f.root,
    ], f.root, f.base);
    assert.equal(missingAuth.status, 1);
    assert.match(missingAuth.stderr, /authorization_required/);
    assert.equal(existsSync(join(f.root, MERGE_DIR)), false);

    const linked = cli([
      "worktree", "merge", "--task", setup.task.taskId, "--into", MAIN, "--dir", setup.worktree.path,
    ], setup.worktree.path, f.base);
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /main_checkout_required/);

    const badRef = cli([
      "worktree", "merge", "--task", setup.task.taskId, "--into", "main", "--dir", f.root,
    ], f.root, f.base);
    assert.equal(badRef.status, 1);
    assert.match(badRef.stderr, /完整本地 refs\/heads/);

    const applied = cli([
      "worktree", "merge", "--task", setup.task.taskId, "--into", MAIN, "--apply",
      "--authorization-ref", AUTHORIZATION, "--dir", f.root,
    ], f.root, f.base);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /状态: merged/);
    assert.equal(git(f.root, ["log", "-1", "--format=%s"]).startsWith(`knit: merge ${setup.task.taskId} (`), true);
    assert.equal(existsSync(taskDirIn(f.root, setup.taskDir)), true);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
