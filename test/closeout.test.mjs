/** 055–057：用户选择的完成验证、业务完成守卫、资料／产物分开提交与批量收尾。 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { currentEntry, emptyScope, scopeDigest } from "../dist/application/scope.js";
import { inputsDigestOf } from "../dist/contracts/task-inputs.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const BRANCH = "refs/heads/main";
const NOW = new Date("2026-11-03T10:00:00.000Z");

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function project(name) {
  const dir = mkdtempSync(join(tmpdir(), `knit-closeout-${name}-`));
  mkdirSync(join(dir, ".knit", "agents"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, ".knit", "standards"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".knit", "config.json"), JSON.stringify({
    schemaVersion: 1,
    client: { default: "pi" },
    agent: { runtime: "pi", resume: "prefer" },
    execution: { host: "local" },
    delivery: { mode: "local" },
    workflow: { maxRepairRounds: 2 },
    limits: { heartbeatIntervalMs: 5000, heartbeatStaleMs: 30000, cancelGraceMs: 5000, snapshotsMaxBytes: 67108864, storageWarnBytes: 536870912 },
  }, null, 2) + "\n");
  writeFileSync(join(dir, "AGENTS.md"), "# 项目规则\n\n## 交付授权\n\n允许在当前分支按任务范围提交并归档。\n");
  writeFileSync(join(dir, ".knit", "standards", "index.md"), "# 规范索引\n\n- 暂无\n");
  writeFileSync(join(dir, ".knit", "agents", "check.md"), "# 检查角色\n\n核对完成条件。\n");
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(dir, "app.txt"), "old\n");
  writeFileSync(join(dir, "second.txt"), "old2\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  let sequence = 0;
  const hex = () => (++sequence).toString(16).padStart(12, "0").slice(-12);
  const tasks = new TaskService({ store, locks, now: () => NOW, randomHex: hex });
  const delivery = new DeliveryService({ store, locks, now: () => NOW, randomHex: hex });
  return { store, locks, tasks, delivery };
}

async function taskWithWork(dir, s, { title, path, content, verification = "self" }, stage = "deliver") {
  const task = await s.tasks.newTask({ dir, title, slug: title, branch: BRANCH, verification });
  writeFileSync(join(dir, path), content);
  const file = join(dir, ".knit", task.relativePath);
  const doc = parseTaskDocument(readFileSync(file, "utf8"), file);
  const updated = renderTaskDocument({
    ...doc,
    frontmatter: { ...doc.frontmatter, stage, ...(stage === "deliver" ? { status: "open", outcome: null } : {}) },
    progressBody: `${doc.progressBody}\n### 实施记录\n\n- 已完成并自检。\n`,
  });
  writeFileSync(file, updated);
  const runs = new RunStore(dir);
  const scope = emptyScope(task.taskId, NOW.toISOString());
  scope.entries.push(currentEntry(dir, path, { factsKind: true }));
  scope.digest = scopeDigest(scope.entries);
  scope.updatedAt = NOW.toISOString();
  runs.writeScope(task.taskId, scope);
  const binding = await s.store.bindings.get(task.taskId);
  const inputsDigest = inputsDigestOf(updated);
  await s.store.bindings.save({
    ...binding,
    confirmedInputsDigest: inputsDigest,
    scope: scope.entries,
    scopeRunIds: ["run-000000000001"],
    lastImplement: {
      runId: "run-000000000001",
      inputsDigest,
      scopeDigest: scope.digest,
    },
  });
  return { ...task, file, inputsDigest, scope };
}

test("060：计划报告任务资料部分暂存冲突，预检保持index与任务原样", async () => {
  const dir = project("metadata-plan");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "meta-plan", path: "app.txt", content: "new\n" });
    const file = join(dirname(task.file), "plan.md");
    const path = relative(dir, file).split("\\").join("/");
    writeFileSync(file, "staged A\n"); git(dir, ["add", "--", path]);
    writeFileSync(file, "worktree B\n");
    const head = git(dir, ["rev-parse", "HEAD"]);
    const plan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.equal(plan.tasks[0].status, "conflict");
    assert.deepEqual(plan.tasks[0].stagedMetadata, [path]);
    assert.equal(plan.tasks[0].reason, "preexisting_staged");
    assert.equal(git(dir, ["show", `:${path}`]), "staged A");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
    assert.equal((await s.store.operations.list()).length, 0);
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("060：服务直接交付在metadata部分暂存时先拒绝，不被hook失败覆盖index", async () => {
  const dir = project("metadata-direct");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "meta-direct", path: "app.txt", content: "new\n" });
    const file = join(dirname(task.file), "plan.md");
    const path = relative(dir, file).split("\\").join("/");
    writeFileSync(file, "staged A\n"); git(dir, ["add", "--", path]);
    writeFileSync(file, "worktree B\n");
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nif git diff --cached --name-only | grep -q '/plan.md$'; then exit 1; fi\n");
    chmodSync(hook, 0o755);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const taskText = readFileSync(task.file, "utf8");
    let rejected = null;
    try { await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }); } catch (error) { rejected = error; }
    assert.equal(git(dir, ["show", `:${path}`]), "staged A", "不得把工作区B覆盖到用户预先暂存的A");
    assert.equal(rejected?.guardReason, "preexisting_staged");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
    assert.equal(readFileSync(task.file, "utf8"), taskText);
    assert.equal((await s.store.operations.list()).length, 0);
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const changeWorktree of [false, true]) test(`060：metadata hook失败后的重试${changeWorktree ? "保护新出现的部分暂存" : "复核本操作checkpoint后继续"}`, async () => {
  const dir = project(`metadata-retry-${changeWorktree}`);
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "meta-retry", path: "app.txt", content: "new\n" });
    const file = join(dirname(task.file), "plan.md");
    const path = relative(dir, file).split("\\").join("/");
    writeFileSync(file, "operation A\n");
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nif git diff --cached --name-only | grep -q '/plan.md$'; then exit 1; fi\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.reason, "git_commit_failed");
    assert.equal(git(dir, ["show", `:${path}`]), "operation A");
    rmSync(hook);
    if (changeWorktree) writeFileSync(file, "user B\n");
    const plan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    if (changeWorktree) {
      const head = git(dir, ["rev-parse", "HEAD"]);
      assert.deepEqual(plan.tasks[0].stagedMetadata, [path]);
      await assert.rejects(() => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true }), (error) => error.guardReason === "preexisting_staged");
      assert.equal(git(dir, ["show", `:${path}`]), "operation A");
      assert.equal(readFileSync(file, "utf8"), "user B\n");
      assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
    } else {
      assert.equal(plan.tasks[0].status, "ready");
      const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
      assert.equal(retry.state, "completed", retry.reason ?? "");
      assert.equal(retry.workCommit, first.workCommit);
      assert.ok(retry.metadataCommit);
      assert.ok(retry.archiveCommit);
    }
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["file", "dangling-symlink"]) test(`060：删除checkpoint后重建${kind}仍保护index中的删除`, async () => {
  const dir = project(`metadata-delete-${kind}`);
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "meta-delete", path: "app.txt", content: "new\n" });
    const file = join(dirname(task.file), "notes.txt");
    const path = relative(dir, file).split("\\").join("/");
    writeFileSync(file, "tracked original\n");
    git(dir, ["add", "--", path]);
    git(dir, ["commit", "-q", "-m", "fixture tracked notes", "--only", "--", path]);
    rmSync(file);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nif git diff --cached --name-only | grep -q '/notes.txt$'; then exit 1; fi\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.reason, "git_commit_failed");
    assert.equal(git(dir, ["ls-files", "--", path]), "");
    assert.equal((await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }])).tasks[0].status, "ready", "尚未重建时可沿删除checkpoint重试");
    if (kind === "file") writeFileSync(file, "user recreation\n");
    else symlinkSync("missing-target", file);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const plan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.equal(plan.tasks[0].status, "conflict");
    assert.ok(plan.tasks[0].stagedMetadata.includes(path));
    await assert.rejects(() => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true }), (error) => error.guardReason === "preexisting_staged");
    assert.equal(git(dir, ["ls-files", "--", path]), "", "index删除仍保留");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
    if (kind === "file") assert.equal(readFileSync(file, "utf8"), "user recreation\n");
    else assert.equal(readlinkSync(file), "missing-target");
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("055/056：self 任务完成后无 Git 提交；完成凭据记录实际验证方式", async () => {
  const dir = project("self-close");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "self", path: "app.txt", content: "new\n" });
    const before = git(dir, ["rev-parse", "HEAD"]);
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true, reason: "自检通过" });
    assert.equal(closed.outcome, "completed");
    assert.equal(closed.verification, "self");
    assert.equal(closed.checkRunId, null);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), before, "业务完成不自动提交");
    const completion = new RunStore(dir).readCompletion(task.taskId);
    assert.equal(completion?.verification, "self");
    assert.equal(completion?.implementRunId, "run-000000000001");
    assert.equal(completion?.reason, "自检通过");
    assert.equal(readFileSync(join(dir, ".knit", task.relativePath), "utf8").includes("status: closed"), true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("056：independent 任务缺少当前有效检查时不能完成；none 必须由用户显式选择", async () => {
  const dir = project("guard");
  const s = services(dir);
  try {
    const independent = await taskWithWork(dir, s, { title: "independent", path: "app.txt", content: "new\n", verification: "independent" });
    await assert.rejects(
      () => s.tasks.close({ dir, taskId: independent.taskId, outcome: "completed", runsSettled: true }),
      (error) => error.details?.guardReason === "check_missing",
    );
    const none = await s.tasks.newTask({ dir, title: "none", slug: "none", branch: BRANCH, verification: "none" });
    const closed = await s.tasks.close({ dir, taskId: none.taskId, outcome: "completed", runsSettled: true, reason: "用户明确跳过" });
    assert.equal(closed.verification, "none");
    const completion = new RunStore(dir).readCompletion(none.taskId);
    assert.ok(completion?.unverified.some((item) => item.includes("verification=none")));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("056：完成凭据随输入或成果变化失效，交付不能沿用旧完成", async () => {
  const dir = project("completion-stale");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "stale", path: "app.txt", content: "new\n" });
    await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    writeFileSync(join(dir, "app.txt"), "changed after completion\n");
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "completion_scope_changed",
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("057：业务产物与任务资料分开提交，归档单独提交", async () => {
  const dir = project("split-commits");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "split", path: "app.txt", content: "new\n" });
    await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.ok(result.workCommit);
    assert.ok(result.metadataCommit);
    assert.ok(result.archiveCommit);
    const artifactPaths = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.workCommit]).split("\n").filter(Boolean);
    const metadataPaths = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.metadataCommit]).split("\n").filter(Boolean);
    assert.deepEqual(artifactPaths, ["app.txt"]);
    assert.ok(metadataPaths.every((path) => path.startsWith(".knit/tasks/")));
    assert.ok(metadataPaths.some((path) => path.endsWith("/task.md")));
    assert.equal(git(dir, ["log", "-1", "--format=%s", result.workCommit]).startsWith("knit: artifact"), true);
    assert.equal(git(dir, ["log", "-1", "--format=%s", result.metadataCommit]).startsWith("knit: metadata"), true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("057：批量收尾逐任务提交，跨任务同路径在执行前报告冲突", async () => {
  const dir = project("batch");
  const s = services(dir);
  try {
    const first = await taskWithWork(dir, s, { title: "first", path: "app.txt", content: "first\n" });
    const second = await taskWithWork(dir, s, { title: "second", path: "second.txt", content: "second\n" });
    const plan = await s.delivery.plan([
      { dir, taskId: first.taskId, branch: BRANCH },
      { dir, taskId: second.taskId, branch: BRANCH },
    ]);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(plan.conflicts, []);

    const ids = [first.taskId, second.taskId];
    for (const taskId of ids) await s.tasks.close({ dir, taskId, outcome: "completed", runsSettled: true });
    const output = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "deliver", ...ids, "--branch", BRANCH, "--dir", dir], { cwd: dir, encoding: "utf8" }));
    assert.equal(output.outcome, "completed");
    assert.equal(output.data.results.length, 2);
    const artifactCommits = output.data.results.map((entry) => entry.result.workCommit);
    const metadataCommits = output.data.results.map((entry) => entry.result.metadataCommit);
    assert.equal(new Set(artifactCommits).size, 2);
    assert.equal(new Set(metadataCommits).size, 2);
    assert.equal(git(dir, ["log", "--format=%s"]).split("\n").filter((line) => line.startsWith("knit: artifact")).length, 2);
    assert.equal(git(dir, ["log", "--format=%s"]).split("\n").filter((line) => line.startsWith("knit: metadata")).length, 2);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("057：已暂存业务路径不能可靠归属时 plan 报告冲突", async () => {
  const dir = project("plan-staged");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "staged", path: "app.txt", content: "new\n" });
    git(dir, ["add", "app.txt"]);
    const plan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.equal(plan.tasks[0].status, "conflict");
    assert.equal(plan.tasks[0].reason, "preexisting_staged");
    assert.deepEqual(plan.tasks[0].stagedArtifacts, ["app.txt"]);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("057：两个任务需要同一业务路径时 plan 停止并列出归属冲突", async () => {
  const dir = project("plan-conflict");
  const s = services(dir);
  try {
    const first = await taskWithWork(dir, s, { title: "same-a", path: "app.txt", content: "a\n" });
    const second = await taskWithWork(dir, s, { title: "same-b", path: "app.txt", content: "b\n" });
    const plan = await s.delivery.plan([
      { dir, taskId: first.taskId, branch: BRANCH },
      { dir, taskId: second.taskId, branch: BRANCH },
    ]);
    assert.deepEqual(plan.conflicts, [{ path: "app.txt", taskIds: [first.taskId, second.taskId] }]);
    assert.ok(plan.tasks.every((task) => task.status === "conflict" && task.reason === "path_shared_by_tasks"));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("055/056：CLI close completed 被完成守卫拒绝，任务保持 open", async () => {
  const dir = project("cli-close");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "cli", slug: "cli", branch: BRANCH, verification: "self" });
    let failed = null;
    try {
      execFileSync(process.execPath, [CLI, "--json", "task", "close", task.taskId, "--outcome", "completed", "--runs-settled", "--dir", dir], { cwd: dir, encoding: "utf8" });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, "CLI 应拒绝无完成资格的 completed");
    assert.match(String(failed.stdout) + String(failed.stderr), /inputs_not_confirmed|任务不能完成/);
    const file = join(dir, ".knit", task.relativePath);
    assert.equal(parseTaskDocument(readFileSync(file, "utf8"), file).frontmatter.status, "open");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("055：验证要求只能在讨论阶段显式调整，并清空旧完成凭据", async () => {
  const dir = project("verification");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "v", slug: "v", branch: BRANCH });
    const changed = await s.tasks.setVerification({ dir, taskId: task.taskId, verification: "none", reason: "本轮只记录结论" });
    assert.equal(changed.changed, true);
    assert.equal(changed.verification, "none");
    const file = join(dir, ".knit", task.relativePath);
    assert.equal(parseTaskDocument(readFileSync(file, "utf8"), file).frontmatter.verification, "none");
    await s.tasks.ready({ dir, taskId: task.taskId });
    await assert.rejects(
      () => s.tasks.setVerification({ dir, taskId: task.taskId, verification: "self" }),
      (error) => error.details?.guardReason === "phase_mismatch",
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("057：CLI deliver --plan 只读预检，不创建提交", async () => {
  const dir = project("cli-plan");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "plan", path: "app.txt", content: "new\n" });
    await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    const head = git(dir, ["rev-parse", "HEAD"]);
    const output = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "deliver", task.taskId, "--branch", BRANCH, "--dir", dir, "--plan"], { cwd: dir, encoding: "utf8" }));
    assert.equal(output.outcome, "completed");
    assert.equal(output.data.readOnly, true);
    assert.deepEqual(output.data.tasks[0].artifacts, ["app.txt"]);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), head, "plan 不提交");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("055/056：self 任务在 deliver 上澄清会回实施，不逼出独立检查", async () => {
  const dir = project("self-clarify");
  const s = services(dir);
  try {
    const task = await taskWithWork(dir, s, { title: "clarify", path: "app.txt", content: "new\n" });
    const changed = await s.tasks.update({
      dir,
      taskId: task.taskId,
      kind: "clarify",
      reason: "补充范围说明",
      content: "# clarify\n\n补充范围说明\n",
      runActive: false,
    });
    assert.equal(changed.stage, "implement");
    assert.equal(changed.status, "open");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
