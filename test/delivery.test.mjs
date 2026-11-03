/** 交付／归档：限定提交、无关 index 保护、hook 越界、取消归档与封存（任务014）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { currentEntry, emptyScope, scopeDigest } from "../dist/application/scope.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { gitSync } from "../dist/infrastructure/process.js";
import { sha256Text } from "../dist/infrastructure/fingerprint.js";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const BRANCH = "refs/heads/main";

function git(dir, args) {
  const result = gitSync(args, dir);
  assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function project(name) {
  const dir = mkdtempSync(join(tmpdir(), `knit-delivery-${name}-`));
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
  writeFileSync(join(dir, ".knit", "workflow.md"), [
    "# 工作流", "", "## 交付授权", "", "允许在当前分支按任务范围提交并归档。", "", "## 检查", "", "检查完成条件。", "",
  ].join("\n"));
  writeFileSync(join(dir, ".knit", "standards", "index.md"), "# 规范索引\n\n- 暂无\n");
  writeFileSync(join(dir, ".knit", "agents", "check.md"), "# 检查角色\n\n核对完成条件。\n");
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(dir, "app.txt"), "old\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  writeFileSync(join(dir, "staged.txt"), "staged base\n");
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

async function makeDeliverable(dir, s, { phase = "deliver", status = "open", outcome = null } = {}) {
  const created = await s.tasks.newTask({ dir, title: "交付测试", slug: "delivery", branch: BRANCH, verification: "independent" });
  const taskFile = join(dir, ".knit", created.relativePath);
  const doc = parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile);
  writeFileSync(taskFile, renderTaskDocument({
    ...doc,
    frontmatter: { ...doc.frontmatter, phase, status, outcome },
    progressBody: `${doc.progressBody}\n### 实施记录\n\n- 已完成。\n`,
  }));
  writeFileSync(join(dir, "app.txt"), "new\n");
  const planner = new ContextPlanner({ store: s.store, now: () => NOW, randomHex: () => "abcdef123456" });
  const plan = await planner.plan({ dir, taskId: created.taskId, role: "check" });
  const scope = emptyScope(created.taskId, NOW.toISOString());
  scope.entries.push(currentEntry(dir, "app.txt", { factsKind: true }));
  scope.digest = scopeDigest(scope.entries);
  scope.updatedAt = NOW.toISOString();
  const runs = new RunStore(dir);
  runs.writeScope(created.taskId, scope);
  const check = {
    schemaVersion: 1,
    taskId: created.taskId,
    runId: `run-${created.taskId.slice(2)}`,
    branch: BRANCH,
    verdict: "pass",
    report: { summary: "通过", verdict: "pass", coverage: ["app.txt"] },
    inputsDigest: plan.inputsDigest,
    standardsDigest: plan.standardsDigest,
    effectiveInputsDigest: plan.effectiveInputsDigest,
    scopeDigest: scope.digest,
    recordedAt: NOW.toISOString(),
  };
  runs.writeCheck(check.runId, check);
  const binding = await s.store.bindings.get(created.taskId);
  await s.store.bindings.save({
    ...binding,
    lastCheckRunId: check.runId,
    confirmedInputsDigest: plan.inputsDigest,
    confirmedStandardsDigest: plan.standardsDigest,
    scope: scope.entries,
    scopeRunIds: [check.runId],
  });
  if (status === "closed" && outcome === "completed") {
    runs.writeCompletion(created.taskId, {
      schemaVersion: 1,
      taskId: created.taskId,
      verification: "independent",
      inputsDigest: plan.inputsDigest,
      scopeDigest: scope.digest,
      implementRunId: check.runId,
      checkRunId: check.runId,
      unverified: [],
      reason: null,
      completedAt: NOW.toISOString(),
    });
  }
  return { ...created, taskFile, check, scope };
}

test("正常交付：工作提交与归档提交范围准确，无关 staged／unstaged 保留", async () => {
  const dir = project("normal");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    writeFileSync(join(dir, "other.txt"), "other dirty\n");
    writeFileSync(join(dir, "staged.txt"), "staged dirty\n");
    git(dir, ["add", "staged.txt"]);
    const beforeStaged = git(dir, ["diff", "--cached", "--name-only"]);

    const result = await s.delivery.deliver({
      dir,
      taskId: task.taskId,
      branch: BRANCH,
      authorizationRef: "workflow:.knit/workflow.md#交付授权",
    });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.needsAttention, false);
    assert.ok(result.workCommit);
    assert.ok(result.metadataCommit);
    assert.ok(result.archiveCommit);
    assert.equal(result.archivePath, `.knit/tasks/archive/2026-11/${task.relativePath.split("/")[1]}`);

    const workPaths = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.workCommit]).split("\n").filter(Boolean).sort();
    assert.deepEqual(workPaths, ["app.txt"]);
    const metadataPaths = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.metadataCommit]).split("\n").filter(Boolean).sort();
    assert.ok(metadataPaths.includes(".knit/tasks/11-02-delivery/task.md"));
    assert.ok(!metadataPaths.includes("app.txt"));
    assert.ok(!metadataPaths.includes("other.txt"));
    assert.ok(!metadataPaths.includes("staged.txt"));

    const archivePaths = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.archiveCommit]).split("\n").filter(Boolean);
    assert.ok(archivePaths.some((path) => path.includes("/archive/2026-11/")));
    assert.ok(archivePaths.some((path) => path.startsWith(".knit/tasks/11-02-delivery/")));

    assert.equal(git(dir, ["diff", "--cached", "--name-only"]), beforeStaged);
    assert.equal(readFileSync(join(dir, "other.txt"), "utf8"), "other dirty\n");
    assert.equal(readFileSync(join(dir, "staged.txt"), "utf8"), "staged dirty\n");
    const archived = join(dir, result.archivePath, "task.md");
    assert.ok(existsSync(archived));
    assert.ok(!existsSync(task.taskFile));
    const text = readFileSync(archived, "utf8");
    assert.ok(text.includes("### 交付记录"));
    assert.ok(text.includes(`工作提交: ${result.workCommit}`));
    assert.ok(!existsSync(join(dir, result.archivePath, ".knit-sealed")));
    assert.equal(git(dir, ["log", "-1", "--format=%s"]), `knit: archive ${task.taskId} (${result.operationId})`);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-commit hook 越界写文件：提交真实存在但 needs_attention，不移动任务", async () => {
  const dir = project("hook");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf 'hook\\n' > hook-out.txt\n");
    chmodSync(hook, 0o755);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "needs_attention");
    assert.equal(result.reason, "hook_changed_unrelated");
    assert.ok(result.workCommit);
    assert.equal(result.archiveCommit, null);
    assert.ok(existsSync(join(dir, "hook-out.txt")));
    assert.ok(existsSync(task.taskFile));
    assert.equal(git(dir, ["cat-file", "-t", result.workCommit]).trim(), "commit");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取消任务归档只移动资料，不提交半成品代码、不造空工作提交", async () => {
  const dir = project("cancel");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s, { phase: "implement", status: "closed", outcome: "cancelled" });
    // 取消时 app.txt 改动仍在工作区，但不得进入归档提交。
    const result = await s.delivery.archive({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.workCommit, null);
    assert.ok(result.archiveCommit);
    const paths = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.archiveCommit]).split("\n").filter(Boolean);
    assert.ok(!paths.includes("app.txt"));
    assert.ok(paths.some((path) => path.includes("/archive/2026-11/")));
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "new\n");
    const text = readFileSync(join(dir, result.archivePath, "task.md"), "utf8");
    assert.ok(text.includes("未提交半成品代码"));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("封存标记使 record 明确未保存；归档完成后可按档案新资料写入", async () => {
  const dir = project("seal");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    // 直接模拟封存窗口，验证 task record 的只读语义。
    writeFileSync(join(dir, ".knit", task.relativePath.split("/").slice(0, -1).join("/"), ".knit-sealed"), "sealed\n");
    const refused = await s.tasks.record({ dir, taskId: task.taskId, body: "不应写入" });
    assert.equal(refused.saved, false);
    assert.equal(refused.sealed, true);
    rmSync(join(dir, ".knit", task.relativePath.split("/").slice(0, -1).join("/"), ".knit-sealed"));
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    const archivedTask = join(dir, result.archivePath, "task.md");
    const written = await s.tasks.record({ dir, taskId: task.taskId, body: "归档后补记" });
    assert.equal(written.saved, true);
    const postscript = readFileSync(archivedTask, "utf8");
    assert.ok(postscript.includes("归档后补记"));
    assert.ok(postscript.includes("### 交付记录"), "后补记录保留原交付记录");
    assert.ok(postscript.includes("工作提交:"));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("授权与分支守卫：Agent 无来源拒绝、短分支拒绝、分支不一致拒绝", async () => {
  const dir = project("guard");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, caller: "agent" }),
      /authorization_required|authorizationRef/,
    );
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: "main" }),
      /branch_invalid|refs\/heads/,
    );
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: "refs/heads/other" }),
      /branch_mismatch|branch_missing|当前分支/,
    );
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.defaultBranch.source, "unknown");
    assert.equal(result.authorization.kind, "explicit_call");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回执丢失但提交已生效：按操作 ID 核实并继续，不重复工作提交", async () => {
  const dir = project("receipt");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const taskDir = `.knit/${task.relativePath.split("/").slice(0, 2).join("/")}`;
    const opId = "op-feedfacecafe";
    const now = NOW.toISOString();
    const workflow = readFileSync(join(dir, ".knit", "workflow.md"), "utf8");
    const steps = ["work_commit", "final_record", "seal", "move", "archive_commit"].map((kind, index) => ({
      stepId: `${index + 1}-${kind}`,
      kind,
      state: "planned",
      before: null,
      after: null,
      evidence: null,
    }));
    await s.store.operations.save({
      operationId: opId,
      kind: "delivery.deliver",
      mode: "deliver",
      taskId: task.taskId,
      state: "running",
      reason: null,
      recordedAt: now,
      updatedAt: now,
      branch: BRANCH,
      caller: "cli",
      authorizationRef: null,
      authorization: { kind: "explicit_call", ref: null, path: null, section: null, digest: null, verified: false },
      defaultBranch: { ref: null, source: "unknown", exists: false },
      policyVersion: sha256Text(workflow),
      taskPath: task.relativePath,
      archivePath: null,
      workCommit: null,
      archiveCommit: null,
      sealDigest: null,
      steps,
    });
    git(dir, ["add", "-A", "--", "app.txt", taskDir]);
    git(dir, ["commit", "-q", "-m", `knit: deliver ${task.taskId} (${opId})`, "--only", "--", "app.txt", taskDir]);
    const existingCommit = git(dir, ["rev-parse", "HEAD"]);

    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.workCommit, existingCommit);
    assert.equal(git(dir, ["log", "--format=%s"]).split("\n").filter((line) => line.startsWith("knit: deliver")).length, 1);
    assert.ok(result.archiveCommit);

    // 模拟归档提交已生效但步骤检查点丢失：再次 archive 只核实，不重复提交。
    const completed = await s.store.operations.get(result.operationId);
    const lost = {
      ...completed,
      state: "running",
      archiveCommit: null,
      steps: completed.steps.map((step) => step.kind === "archive_commit" ? { ...step, state: "planned", evidence: null, after: null } : step),
    };
    await s.store.operations.save(lost);
    const resumed = await s.delivery.archive({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(resumed.state, "completed", resumed.reason ?? "");
    assert.equal(resumed.archiveCommit, result.archiveCommit);
    assert.equal(git(dir, ["log", "--format=%s"]).split("\n").filter((line) => line.startsWith("knit: archive")).length, 1);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook 改动选中文件：提交保留但 needs_attention，不移动任务", async () => {
  const dir = project("hook-selected");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf 'hook\\n' > app.txt\n");
    chmodSync(hook, 0o755);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "needs_attention");
    assert.equal(result.reason, "hook_changed_selected");
    assert.ok(result.workCommit);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "hook\n");
    assert.ok(existsSync(task.taskFile));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook 改内容后的显式 retry 不复用旧 pass；scope 现状重核拒绝 check_stale", async () => {
  const dir = project("hook-content-retry");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf 'hooked\n' > app.txt\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    assert.equal(first.reason, "hook_changed_selected");
    rmSync(hook);
    // 任务027：hook 改写了 scope 文件，旧 pass 不再代表当前成果，重试必须重新检查。
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true }),
      /check_stale|检查后成果路径现状与记录不符/,
    );
    assert.ok(existsSync(task.taskFile));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit 已成功但回执丢失：恢复仍核验提交范围，不把越界提交当完成", async () => {
  const dir = project("recovery-scope");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    rmSync(hook);
    // 模拟提交已成功但执行者未写回操作检查点：提交 message 带操作 ID，范围却越界。
    writeFileSync(join(dir, "extra.txt"), "outside\n");
    git(dir, ["add", "extra.txt"]);
    git(dir, ["commit", "-q", "-m", `knit: deliver ${task.taskId} (${first.operationId})`]);
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "needs_attention");
    assert.equal(retry.reason, "commit_scope_mismatch");
    assert.equal(retry.workCommit, git(dir, ["rev-parse", "HEAD"]).trim());
    assert.equal(existsSync(join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md")), true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复时 HEAD 已有额外提交：即使找到操作提交也拒绝，不把后续历史并入归档", async () => {
  const dir = project("recovery-head-advanced");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    rmSync(hook);
    git(dir, ["add", "app.txt"]);
    git(dir, ["commit", "-q", "-m", `knit: deliver ${task.taskId} (${first.operationId})`]);
    writeFileSync(join(dir, "extra.txt"), "outside\n");
    git(dir, ["add", "extra.txt"]);
    git(dir, ["commit", "-q", "-m", "later external commit"]);
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "needs_attention");
    assert.equal(retry.reason, "commit_scope_mismatch");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复时提交 message 被改写：找不到操作提交但 HEAD 已前进，不误判 no_selected_changes", async () => {
  const dir = project("recovery-message-rewrite");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    rmSync(hook);
    writeFileSync(join(dir, "extra.txt"), "outside\n");
    git(dir, ["add", "extra.txt"]);
    git(dir, ["commit", "-q", "-m", "rewritten delivery message"]);
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "needs_attention");
    assert.equal(retry.reason, "commit_unverified");
    assert.equal(retry.workCommit, null);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复时操作保存的 workCommit 含越界路径：保留预期 checkpoint 并拒绝", async () => {
  const dir = project("recovery-extra-saved");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    rmSync(hook);
    writeFileSync(join(dir, "extra.txt"), "outside\n");
    git(dir, ["add", "app.txt", "extra.txt"]);
    git(dir, ["commit", "-q", "-m", `knit: deliver ${task.taskId} (${first.operationId})`]);
    const oid = git(dir, ["rev-parse", "HEAD"]).trim();
    const op = await s.store.operations.get(first.operationId);
    assert.ok(op);
    await s.store.operations.save({ ...op, workCommit: oid });
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "needs_attention");
    assert.equal(retry.reason, "commit_scope_mismatch");
    assert.equal(retry.workCommit, oid);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复时操作保存的 workCommit message 不匹配：不被当成完成提交", async () => {
  const dir = project("recovery-message-mismatch");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    rmSync(hook);
    writeFileSync(join(dir, "extra.txt"), "outside\n");
    git(dir, ["add", "extra.txt"]);
    git(dir, ["commit", "-q", "-m", "wrong message"]);
    const oid = git(dir, ["rev-parse", "HEAD"]).trim();
    const op = await s.store.operations.get(first.operationId);
    assert.ok(op);
    await s.store.operations.save({ ...op, workCommit: oid });
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "needs_attention");
    assert.equal(retry.reason, "commit_message_mismatch");
    assert.equal(retry.workCommit, oid);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档提交 pre-commit 拒绝后 retry：旧任务路径删除与新路径新增都进入提交", async () => {
  const dir = project("archive-reject");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nn=$(cat .git/hook-count 2>/dev/null || echo 0)\nif [ \"$n\" -ge 1 ]; then exit 1; fi\necho 1 > .git/hook-count\nexit 0\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    assert.equal(first.archiveCommit, null);
    rmSync(hook);
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "completed", retry.reason ?? "");
    assert.ok(retry.archiveCommit);
    assert.equal(existsSync(task.taskFile), false);
    assert.equal(existsSync(join(dir, retry.archivePath, "task.md")), true);
    assert.equal(git(dir, ["ls-tree", "--name-only", "HEAD", "--", task.taskFile]).trim(), "");
    assert.equal(git(dir, ["log", "--format=%s"]).split("\n").filter((line) => line.startsWith("knit: archive")).length, 1);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("工作提交完成后出现额外提交：恢复拒绝把额外历史并入归档", async () => {
  const dir = project("post-work-extra");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nn=$(cat .git/hook-count 2>/dev/null || echo 0)\nif [ \"$n\" -ge 1 ]; then exit 1; fi\necho 1 > .git/hook-count\nexit 0\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    assert.ok(first.workCommit);
    rmSync(hook);
    writeFileSync(join(dir, "extra.txt"), "outside\n");
    git(dir, ["add", "extra.txt"]);
    git(dir, ["commit", "-q", "-m", "external after work"]);
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "needs_attention");
    assert.equal(retry.reason, "commit_scope_mismatch");
    assert.equal(retry.archiveCommit, null);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档提交后出现同 message 额外提交：不落盘错误候选，清理后可恢复真实归档提交", async () => {
  const dir = project("archive-extra");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "completed");
    const op = await s.store.operations.get(first.operationId);
    assert.ok(op);
    const baseArchive = op.archiveCommit;
    assert.ok(baseArchive);
    const before = git(dir, ["rev-parse", `${baseArchive}^`]).trim();
    const expected = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", baseArchive]).split("\n").filter(Boolean).sort().join("\n");
    writeFileSync(join(dir, "extra.txt"), "outside\n");
    git(dir, ["add", "extra.txt"]);
    git(dir, ["commit", "-q", "-m", `knit: archive ${task.taskId} (${op.operationId})`]);
    const extraCommit = git(dir, ["rev-parse", "HEAD"]).trim();
    const steps = op.steps.map((item) => item.kind === "archive_commit"
      ? { ...item, state: "needs_attention", evidence: { before, expectedPaths: expected }, after: { before, expectedPaths: expected } }
      : item);
    await s.store.operations.save({ ...op, state: "needs_attention", reason: "archive_extra", archiveCommit: null, steps });
    const retry = await s.delivery.archive({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "needs_attention");
    assert.equal(retry.reason, "archive_parent_mismatch");
    assert.equal(retry.archiveCommit, null, "错误候选不能落盘或返回为权威 archiveCommit");
    const stored = await s.store.operations.get(op.operationId);
    assert.equal(stored?.archiveCommit, null);
    // 用户清理额外提交，保留真实归档提交；同一操作可恢复。
    git(dir, ["reset", "--hard", baseArchive]);
    const recovered = await s.delivery.archive({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(recovered.state, "completed", recovered.reason ?? "");
    assert.equal(recovered.archiveCommit, baseArchive);
    assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), baseArchive);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查后正式规范变化：交付拒绝 check_stale", async () => {
  const dir = project("stale");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    writeFileSync(join(dir, ".knit", "standards", "index.md"), "# 规范索引\n\n- 新规则\n");
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      /check_stale|检查后输入或正式规范变化/,
    );
    assert.ok(existsSync(task.taskFile));
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive 不能绕过正常交付：未交付的 completed／open 任务要求先 deliver", async () => {
  const dir = project("bypass");
  const s = services(dir);
  try {
    const completed = await makeDeliverable(dir, s, { status: "closed", outcome: "completed" });
    await assert.rejects(
      () => s.delivery.archive({ dir, taskId: completed.taskId, branch: BRANCH }),
      /deliver_required|正常完成/,
    );
    const open = await makeDeliverable(dir, s, { phase: "implement", status: "open", outcome: null });
    await assert.rejects(
      () => s.delivery.archive({ dir, taskId: open.taskId, branch: BRANCH }),
      /deliver_required|正常完成/,
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI deliver --json 走协议输出并真实归档", async () => {
  const dir = project("cli");
  const s = services(dir);
  let task;
  try {
    task = await makeDeliverable(dir, s);
    s.store.close();
    const cli = join(process.cwd(), "dist", "cli", "knit.js");
    const output = execFileSync(process.execPath, [
      cli, "--json", "deliver", task.taskId,
      "--branch", BRANCH,
      "--dir", dir,
      "--locks", join(dir, ".cli-locks"),
    ], { encoding: "utf8" });
    const response = JSON.parse(output);
    assert.equal(response.outcome, "completed");
    assert.equal(response.data.state, "completed");
    assert.ok(response.data.archiveCommit);
  } finally {
    try { s.store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显式 retry：hook 失败现场清理后核实原提交并继续，不重复工作提交", async () => {
  const dir = project("retry");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf 'hook\\n' > hook-out.txt\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    assert.ok(first.workCommit);
    rmSync(hook);
    rmSync(join(dir, "hook-out.txt"));
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "completed", retry.reason ?? "");
    assert.equal(retry.workCommit, first.workCommit);
    assert.ok(retry.archiveCommit);
    assert.equal(git(dir, ["log", "--format=%s"]).split("\n").filter((line) => line.startsWith("knit: artifact")).length, 1);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凭据扫描：限定提交命中即暂停、无新提交、结果不回显完整值（任务032）", async () => {
  const dir = project("scan-delivery");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const fakeKey = "AKIAIOSFODNN7EXAMPLE";
    writeFileSync(join(dir, "app.txt"), `key=${fakeKey}\n`);
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.guardReason === "credential_scan_hit" && !String(error.message).includes(fakeKey),
    );
    const log = git(dir, ["log", "--oneline"]);
    assert.equal(log.split("\n").filter((line) => line.includes("knit: deliver")).length, 0, "命中后无交付提交");
    // 移除命中内容并恢复检查时的同一字节后，重试可继续（scope 现状重核与凭据扫描都通过）。
    writeFileSync(join(dir, "app.txt"), "new\n");
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "completed", retry.reason ?? "");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope 现状重核：改字节、换类型、改执行位或删除后旧 pass 拒绝交付，恢复后可用", async () => {
  const cases = [
    { name: "content", mutate: (dir) => writeFileSync(join(dir, "app.txt"), "tampered\n") },
    { name: "mode", mutate: (dir) => chmodSync(join(dir, "app.txt"), 0o755) },
    { name: "type", mutate: (dir) => { rmSync(join(dir, "app.txt")); symlinkSync("other.txt", join(dir, "app.txt")); } },
    { name: "delete", mutate: (dir) => rmSync(join(dir, "app.txt")) },
  ];
  for (const scenario of cases) {
    const dir = project(`scope-recheck-${scenario.name}`);
    const s = services(dir);
    try {
      const task = await makeDeliverable(dir, s);
      scenario.mutate(dir);
      await assert.rejects(
        () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
        (error) => error.guardReason === "check_stale",
        `场景 ${scenario.name} 应拒绝旧 pass`,
      );
      const runs = new RunStore(dir);
      assert.equal(runs.readCheck(task.check.runId)?.verdict, "pass", "拒绝是重核拒绝，不改凭据记录");
      if (scenario.name === "mode") {
        // 恢复同一现状后旧 pass 仍有效，不要求重新检查。
        chmodSync(join(dir, "app.txt"), 0o644);
        const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
        assert.equal(result.state, "completed", result.reason ?? "");
      }
    } finally {
      s.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("最新检查失败时不回退旧 pass 交付", async () => {
  const dir = project("latest-check");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const runs = new RunStore(dir);
    const failedRunId = "run-000000000099";
    runs.writeCheck(failedRunId, {
      ...task.check,
      runId: failedRunId,
      verdict: "blocked",
      report: { summary: "最新检查阻塞", verdict: "blocked", coverage: ["app.txt"] },
      recordedAt: NOW.toISOString(),
    });
    const binding = await s.store.bindings.get(task.taskId);
    await s.store.bindings.save({ ...binding, lastCheckRunId: failedRunId });
    await assert.rejects(
      () => s.delivery.deliver({
        dir,
        taskId: task.taskId,
        branch: BRANCH,
        authorizationRef: "workflow:.knit/workflow.md#交付授权",
      }),
      (error) => /check_not_passed|最新检查结论/.test(error.message),
    );
    assert.equal(runs.readCheck(task.check.runId)?.verdict, "pass", "旧 pass 只作为历史保留");
    assert.equal(runs.readCheck(failedRunId)?.verdict, "blocked");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同任务混改：模式、删除、重命名与内容一起按真实提交范围核对", async () => {
  const dir = project("mixed");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    writeFileSync(join(dir, "mode.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "mode.sh"), 0o755);
    renameSync(join(dir, "other.txt"), join(dir, "renamed.txt"));
    rmSync(join(dir, "staged.txt"));
    writeFileSync(join(dir, "app.txt"), "mixed\n");
    const runs = new RunStore(dir);
    const scope = {
      ...task.scope,
      entries: [
        { ...currentEntry(dir, "app.txt", { factsKind: true }), path: "app.txt" },
        { ...currentEntry(dir, "mode.sh", { factsKind: true }), path: "mode.sh" },
        { ...currentEntry(dir, "renamed.txt", { factsKind: true }), path: "renamed.txt" },
        { ...currentEntry(dir, "other.txt", { factsKind: true }), path: "other.txt" },
        { ...currentEntry(dir, "staged.txt", { factsKind: true }), path: "staged.txt" },
      ],
    };
    scope.digest = scopeDigest(scope.entries);
    runs.writeScope(task.taskId, scope);
    const checkRun = "run-000000000088";
    runs.writeCheck(checkRun, {
      ...task.check,
      runId: checkRun,
      scopeDigest: scope.digest,
      recordedAt: NOW.toISOString(),
    });
    const binding = await s.store.bindings.get(task.taskId);
    await s.store.bindings.save({ ...binding, lastCheckRunId: checkRun, scope: scope.entries, scopeRunIds: [checkRun] });
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(first.state, "needs_attention");
    rmSync(hook);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(git(dir, ["show", "HEAD:app.txt"]).trim(), "mixed");
    assert.equal(git(dir, ["show", "HEAD:mode.sh"]).trim(), "#!/bin/sh\necho hi");
    assert.equal(git(dir, ["ls-tree", "HEAD", "--", "mode.sh"]).split(" ")[0], "100755");
    assert.equal(existsSync(join(dir, "staged.txt")), false);
    assert.equal(git(dir, ["show", "HEAD:renamed.txt"]).trim(), "other");
    await assert.rejects(async () => git(dir, ["show", "HEAD:staged.txt"]));
    await assert.rejects(async () => git(dir, ["show", "HEAD:other.txt"]));
    assert.equal(git(dir, ["status", "--porcelain"]).includes("mode.sh"), false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook 拒绝提交：事实保留，不移动任务", async () => {
  const dir = project("hook-reject");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf 'rejected\\n' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "needs_attention");
    assert.equal(result.reason, "git_commit_failed");
    assert.equal(result.workCommit, null);
    assert.equal(result.archiveCommit, null);
    assert.ok(existsSync(task.taskFile));
    assert.equal(git(dir, ["log", "-1", "--format=%s"]), "init");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook 把无关文件加入 index：检测 index 变化并保留提交事实", async () => {
  const dir = project("hook-index");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    writeFileSync(join(dir, "extra.txt"), "extra\n");
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\ngit add extra.txt\n");
    chmodSync(hook, 0o755);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "needs_attention");
    assert.ok(["hook_changed_index", "commit_scope_mismatch"].includes(result.reason), result.reason ?? "");
    assert.ok(result.workCommit);
    assert.equal(result.archiveCommit, null);
    assert.ok(existsSync(task.taskFile));
    assert.equal(git(dir, ["diff", "--cached", "--name-only"]).includes("extra.txt"), true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("移动成功但 move 检查点丢失：核实目标后继续，不重复移动", async () => {
  const dir = project("move-recovery");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed");
    const operation = await s.store.operations.get(result.operationId);
    assert.ok(operation);
    const lost = {
      ...operation,
      state: "running",
      archiveCommit: null,
      steps: operation.steps.map((step) =>
        step.kind === "archive_commit" || step.kind === "move"
          ? { ...step, state: "planned", evidence: null, after: null }
          : step),
    };
    await s.store.operations.save(lost);
    const recovered = await s.delivery.archive({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(recovered.state, "completed", recovered.reason ?? "");
    assert.equal(recovered.archivePath, result.archivePath);
    assert.equal(recovered.archiveCommit, result.archiveCommit);
    assert.equal(existsSync(join(dir, result.archivePath, "task.md")), true);
    assert.equal(existsSync(task.taskFile), false);
    assert.equal(git(dir, ["log", "--format=%s"]).split("\n").filter((line) => line.startsWith("knit: archive")).length, 1);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档目标已存在：不覆盖、不移动，保留现场", async () => {
  const dir = project("target-conflict");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const target = join(dir, ".knit", "tasks", "archive", "2026-11", "11-02-delivery");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "foreign.txt"), "foreign\n");
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "needs_attention");
    assert.equal(result.reason, "archive_target_exists");
    assert.ok(existsSync(task.taskFile));
    assert.equal(readFileSync(join(target, "foreign.txt"), "utf8"), "foreign\n");
    assert.equal(result.archiveCommit, null);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨月重试沿用操作首次 archivePath，不按当前月份改目标", async () => {
  const dir = project("cross-month");
  const s = services(dir);
  let current = NOW;
  let sequence = 0;
  const delivery = new DeliveryService({
    store: s.store,
    locks: s.locks,
    now: () => current,
    randomHex: () => (++sequence).toString(16).padStart(12, "0").slice(-12),
  });
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const failed = await delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(failed.state, "needs_attention");
    const operation = await s.store.operations.get(failed.operationId);
    assert.ok(operation?.archivePath?.includes("/2026-11/"), operation?.archivePath ?? "");
    chmodSync(hook, 0o644);
    current = new Date("2026-12-03T10:00:00.000Z");
    const resumed = await delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(resumed.state, "completed", resumed.reason ?? "");
    assert.ok(resumed.archivePath?.includes("/2026-11/"), resumed.archivePath ?? "");
    assert.equal(existsSync(join(dir, resumed.archivePath, "task.md")), true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
