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
import { selectedPath, recoveredTreePaths } from "../dist/application/delivery.js";
import { StandardsService } from "../dist/application/standards-service.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { currentEntry, emptyScope, scopeDigest } from "../dist/application/scope.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { gitSync } from "../dist/infrastructure/process.js";
import { sha256Text } from "../dist/infrastructure/fingerprint.js";
import { searchHistory } from "../dist/application/history-search.js";

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
    // 本文件的 hook 用例验证 run 模式（仓库 hooks 参与交付提交）下的核验；skip 缺省行为见 credential-integrity.test.mjs。
    delivery: { mode: "local", hooks: "run" },
    workflow: { maxRepairRounds: 2 },
    limits: { heartbeatIntervalMs: 5000, heartbeatStaleMs: 30000, cancelGraceMs: 5000, snapshotsMaxBytes: 67108864, storageWarnBytes: 536870912 },
  }, null, 2) + "\n");
  writeFileSync(join(dir, "AGENTS.md"), [
    "# 项目规则", "", "## 交付授权", "", "允许在当前分支按任务范围提交并归档。", "", "## 检查", "", "检查完成条件。", "",
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

async function makeDeliverable(dir, s, { stage = "deliver", status = "open", outcome = null } = {}) {
  const created = await s.tasks.newTask({ dir, title: "交付测试", slug: "delivery", branch: BRANCH, verification: "independent" });
  const taskFile = join(dir, ".knit", created.relativePath);
  const doc = parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile);
  writeFileSync(taskFile, renderTaskDocument({
    ...doc,
    frontmatter: { ...doc.frontmatter, stage, status, outcome },
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

test("目录选择：尾斜杠等价且不匹配兄弟前缀，补认仍拒绝真实差异", () => {
  for (const selected of [["dir"], ["dir/"]]) {
    assert.equal(selectedPath("dir", selected), true);
    assert.equal(selectedPath("dir/file", selected), true);
    assert.equal(selectedPath("dir-other/file", selected), false);
  }
  assert.deepEqual(recoveredTreePaths({}, { "dir/a": "blob" }, ["dir/"], ["dir/a"]), ["dir/a"]);
  assert.equal(recoveredTreePaths({ a: "old" }, { a: "new" }, ["a"], ["a"]), null);
  assert.equal(recoveredTreePaths({}, { "dir/a": "blob" }, ["dir/"], []), null);
  assert.equal(recoveredTreePaths({}, { "dir/a": "blob" }, ["dir"], ["dir/a"]), null);
});

for (const variant of ["normal", "legacy", "work-legacy", "later", "dirty", "recorded-diff", "unexpected-path", "not-ancestor"]) test(`目录交付与恢复：${variant}`, async () => {
  const dir = project(`directory-${variant}`);
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "directory", branch: BRANCH, verification: "self" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    mkdirSync(join(dir, "dir"));
    writeFileSync(join(dir, "dir", "a.txt"), "a\n");
    writeFileSync(join(dir, "dir", "b.txt"), "b\n");
    await s.tasks.implement({ dir, taskId: task.taskId, paths: ["dir/"], validations: ["目录自检"] });
    await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    const hook = join(dir, ".git", "hooks", "pre-commit");
    if (variant !== "normal") {
      writeFileSync(hook, "#!/bin/sh\nif git diff --cached --name-only | grep -q '.knit/tasks/'; then exit 1; fi\n");
      chmodSync(hook, 0o755);
    }
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    if (variant === "normal") {
      assert.equal(first.state, "completed", first.reason);
      assert.ok(first.workCommit && first.metadataCommit && first.archiveCommit);
      return;
    }
    assert.equal(first.state, "needs_attention");
    assert.ok(first.workCommit);
    rmSync(hook);
    const op = await s.store.operations.get(first.operationId);
    const artifact = op.steps.find((step) => step.kind === "artifact_commit");
    const expectedTree = JSON.parse(artifact.evidence.expectedTree);
    if (variant === "recorded-diff") expectedTree["dir/a.txt"] = "100644 blob wrong";
    else for (const path of Object.keys(expectedTree)) delete expectedTree[path];
    const steps = op.steps.map((step) => step.kind === "artifact_commit" ? {
      ...step, state: "needs_attention", evidence: { ...step.evidence, expectedTree: JSON.stringify(expectedTree), ...(variant === "unexpected-path" ? { expectedPaths: "dir/a.txt" } : {}) },
    } : step.kind === "metadata_commit" ? { ...step, state: "planned", evidence: null } : step);
    // 还原旧检查点：产物已提交，目录条目未记入 expectedTree；不改任何真实任务运行资料。
    git(dir, ["reset", "--", join(".knit", task.relativePath)]);
    let productCommit = first.workCommit;
    if (variant === "work-legacy") {
      git(dir, ["commit", "--amend", "--only", "-q", "-m", `knit: deliver ${task.taskId} (${first.operationId})`]);
      productCommit = git(dir, ["rev-parse", "HEAD"]);
      steps.find((step) => step.kind === "artifact_commit").kind = "work_commit";
    }
    await s.store.operations.save({ ...op, workCommit: productCommit, reason: "hook_changed_selected", steps: variant === "work-legacy" ? steps.filter((step) => step.kind !== "metadata_commit") : steps });
    if (variant === "later" || variant === "dirty") {
      writeFileSync(join(dir, variant === "later" ? "other.txt" : "dir/a.txt"), "later committed\n");
      git(dir, ["add", "--", variant === "later" ? "other.txt" : "dir/a.txt"]);
      git(dir, ["commit", "-q", "-m", "later unrelated task"]);
      if (variant === "dirty") writeFileSync(join(dir, "dir/a.txt"), "later worktree\n");
    }
    if (variant === "not-ancestor") git(dir, ["reset", "--mixed", `${productCommit}^`]);
    const headBefore = git(dir, ["rev-parse", "HEAD"]);
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    if (["recorded-diff", "unexpected-path", "not-ancestor"].includes(variant)) {
      assert.equal(retry.state, "needs_attention");
      assert.equal(retry.reason, variant === "unexpected-path" || variant === "not-ancestor" ? "commit_scope_mismatch" : "hook_changed_selected");
    } else {
      assert.equal(retry.state, "completed", retry.reason);
      assert.equal(retry.workCommit, productCommit);
      assert.deepEqual(git(dir, ["show", "--format=", "--name-only", productCommit]).split("\n").filter(Boolean).sort(), ["dir/a.txt", "dir/b.txt"]);
      const saved = await s.store.operations.get(first.operationId);
      assert.equal(saved.steps.find((step) => step.kind === (variant === "work-legacy" ? "work_commit" : "artifact_commit")).evidence.supplementedPaths, "dir/a.txt\ndir/b.txt");
      if (variant !== "work-legacy") {
        assert.equal(git(dir, ["rev-parse", `${retry.metadataCommit}^`]), headBefore);
        assert.equal(git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", retry.metadataCommit]).includes("dir/a.txt"), false);
      }
      if (variant === "dirty") assert.equal(readFileSync(join(dir, "dir/a.txt"), "utf8"), "later worktree\n");
    }
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("正常交付：工作提交与归档提交范围准确，无关 staged／unstaged 保留", async () => {
  const dir = project("normal");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    assert.equal(s.tasks.list({ dir }).active.length, 1, "归档前列表已填充分区缓存");
    writeFileSync(join(dir, "other.txt"), "other dirty\n");
    writeFileSync(join(dir, "staged.txt"), "staged dirty\n");
    git(dir, ["add", "staged.txt"]);
    const beforeStaged = git(dir, ["diff", "--cached", "--name-only"]);

    const result = await s.delivery.deliver({
      dir,
      taskId: task.taskId,
      branch: BRANCH,
      authorizationRef: "workflow:AGENTS.md#交付授权",
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
    const afterArchive = s.tasks.list({ dir });
    assert.equal(afterArchive.active.length, 0);
    assert.equal(afterArchive.archived.length, 1);
    assert.equal(afterArchive.archived[0].taskId, task.taskId, "Knit 归档后列表立即反映新增归档");
    const text = readFileSync(archived, "utf8");
    assert.ok(text.includes("### 交付记录"));
    assert.ok(text.includes(`工作提交: ${result.workCommit}`));
    assert.ok(!existsSync(join(dir, result.archivePath, ".knit-sealed")));
    assert.equal(git(dir, ["log", "-1", "--format=%s"]), `chore(task): archive 11-02-delivery (${task.taskId})`);
    assert.match(git(dir, ["log", "-1", "--format=%B"]), /Knit-Stage: archive/);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("规范候选未审阅不阻塞交付：项目候选与旧任务候选保留", async () => {
  const dir = project("standards-unreviewed");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const candidateBlock = (id) => [
      `<!-- knit:candidate:start id=${id} -->`,
      "## 未审阅候选",
      "",
      "### 问题",
      "",
      "重复问题。",
      "",
      "### 建议规则",
      "",
      "可复用规则。",
      "<!-- knit:candidate:end -->",
      "",
    ].join("\n");
    writeFileSync(join(dir, ".knit", "standards", "candidates.md"), `# 规范候选\n\n${candidateBlock("c-0000000000a1")}`);
    const legacyDir = join(dir, ".knit", task.relativePath.split("/").slice(0, -1).join("/"));
    writeFileSync(join(legacyDir, "standards.md"), `${candidateBlock("c-0000000000a2")}`);

    const result = await s.delivery.deliver({
      dir,
      taskId: task.taskId,
      branch: BRANCH,
      authorizationRef: "workflow:AGENTS.md#交付授权",
    });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.ok(result.workCommit);
    assert.ok(result.metadataCommit);
    assert.ok(result.archiveCommit);
    assert.ok(existsSync(join(dir, ".knit", "standards", "candidates.md")), "项目候选保留");
    assert.ok(existsSync(join(dir, result.archivePath, "standards.md")), "旧任务候选随任务资料归档");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("项目级采纳目标按来源任务并入资料分类，规范处理不阻塞 preflight", async () => {
  const dir = project("standards-source");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    writeFileSync(join(dir, ".knit", "standards", "errors.md"), "# 错误处理\n\n现有约定。\n");
    const standards = new StandardsService({ store: s.store, locks: s.locks, now: () => NOW });
    const proposed = await standards.propose({
      dir,
      sourceTaskId: task.taskId,
      title: "来源任务候选",
      problem: "重复问题。",
      rule: "可复用规则。",
    });
    assert.ok(proposed);
    await standards.review({
      dir,
      sourceTaskId: task.taskId,
      decision: "applied",
      reason: "按来源任务记录采纳目标。",
      targets: [".knit/standards/errors.md"],
    });
    const plan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.equal(plan.tasks[0].status, "ready");
    assert.ok(plan.tasks[0].metadata.includes(".knit/standards/errors.md"));
    assert.ok(plan.tasks[0].metadata.includes(".knit/standards/index.md"));
    assert.equal(plan.tasks[0].artifacts.includes(".knit/standards/errors.md"), false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档提交包含任务同目录材料移动后的旧路径删除", async () => {
  const dir = project("archive-materials");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const taskDir = join(dir, ".knit", task.relativePath.split("/").slice(0, -1).join("/"));
    mkdirSync(join(taskDir, "research"), { recursive: true });
    writeFileSync(join(taskDir, "plan.md"), "# 计划\n");
    writeFileSync(join(taskDir, "design.md"), "# 设计\n");
    writeFileSync(join(taskDir, "research", "notes.md"), "调查材料\n");

    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.ok(result.archiveCommit);

    const oldPrefix = `.knit/${task.relativePath.split("/").slice(0, -1).join("/")}`;
    const archivePaths = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.archiveCommit]).split("\n").filter(Boolean);
    for (const material of ["task.md", "plan.md", "design.md", "research/notes.md"]) {
      assert.ok(archivePaths.includes(`${oldPrefix}/${material}`), `归档提交含旧路径删除: ${material}`);
      assert.ok(archivePaths.includes(`${result.archivePath}/${material}`), `归档提交含新路径新增: ${material}`);
      assert.ok(existsSync(join(dir, result.archivePath, material)), `归档文件存在: ${material}`);
      assert.ok(!existsSync(join(taskDir, material)), `旧文件已移走: ${material}`);
    }
    assert.equal(git(dir, ["status", "--porcelain", "--", oldPrefix]), "");
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
    const task = await makeDeliverable(dir, s, { stage: "implement", status: "closed", outcome: "cancelled" });
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
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
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
      policyVersion: sha256Text(agents),
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
    assert.equal(git(dir, ["log", "--format=%H", "--fixed-strings", "--grep=Knit-Stage: archive"]).split("\n").filter(Boolean).length, 1);
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

test("hook 后续改动工作区：retry 核对已提交产物，不提交后来改动", async () => {
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
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "completed", retry.reason);
    assert.equal(retry.workCommit, first.workCommit);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "hooked\n");
    assert.equal(git(dir, ["show", `${retry.workCommit}:app.txt`]), "new");
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

test("恢复时 HEAD 已有额外提交：核对操作提交后继续归档", async () => {
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
    const later = git(dir, ["rev-parse", "HEAD"]);
    const retry = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, retry: true });
    assert.equal(retry.state, "completed", retry.reason);
    assert.equal(git(dir, ["rev-parse", `${retry.metadataCommit}^`]), later);
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
    assert.equal(git(dir, ["log", "--format=%H", "--fixed-strings", "--grep=Knit-Stage: archive"]).split("\n").filter(Boolean).length, 1);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("资料提交已开始后出现额外提交：保留资料检查点的 HEAD 守卫", async () => {
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
    assert.equal(retry.reason, "commit_unverified");
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
    assert.ok(op.messages?.archive?.text);
    git(dir, ["commit", "-q", "-m", op.messages.archive.text]);
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
    const open = await makeDeliverable(dir, s, { stage: "implement", status: "open", outcome: null });
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
    const messageFile = join(dir, "cli-message.txt");
    writeFileSync(messageFile, "CLI 文案\n\nCLI 正文。\n");
    const output = execFileSync(process.execPath, [
      cli, "--json", "deliver", task.taskId,
      "--branch", BRANCH,
      "--dir", dir,
      "--locks", join(dir, ".cli-locks"),
      "--message-file", messageFile,
    ], { encoding: "utf8" });
    const response = JSON.parse(output);
    assert.equal(response.outcome, "completed");
    assert.equal(response.data.state, "completed");
    assert.equal(response.data.messages.artifact.source, "agent");
    assert.equal(response.data.messages.artifact.subject, "CLI 文案");
    assert.match(git(dir, ["log", "-1", "--format=%B", response.data.workCommit]), /^CLI 文案\n\nCLI 正文。/m);
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
    assert.equal(git(dir, ["log", "--format=%H", "--fixed-strings", "--grep=Knit-Stage: artifact"]).split("\n").filter(Boolean).length, 1);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凭据扫描只覆盖本次差异新增行：既有夹具不阻塞后续交付，新增命中行仍暂停", async () => {
  const dir = project("scan-diff-only");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    // 动态拼接，避免测试源码自身命中扫描模式。
    const fakeKey = ["AK", "IA", "IOSFODNN7", "EXAMP", "LE"].join("");
    const tracked = join(dir, "fixtures.txt");
    writeFileSync(tracked, `sample=${fakeKey}\n`);
    execFileSync("git", ["add", "fixtures.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir });

    // 只改动该跟踪文件的其它行：既有夹具不再阻塞交付。
    writeFileSync(tracked, `sample=${fakeKey}\nchanged=unrelated\n`);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
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
    assert.equal(git(dir, ["log", "--format=%H", "--fixed-strings", "--grep=Knit-Stage: artifact"]).split("\n").filter(Boolean).length, 0, "命中后无交付提交");
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
        authorizationRef: "workflow:AGENTS.md#交付授权",
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
    assert.equal(git(dir, ["log", "--format=%H", "--fixed-strings", "--grep=Knit-Stage: archive"]).split("\n").filter(Boolean).length, 1);
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

test("主会话文案：产物提交保留首行／正文并追加 trailer，资料与归档使用模板", async () => {
  const dir = project("agent-message");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const messageFile = join(dir, "message.txt");
    writeFileSync(messageFile, "交付可读文案\n\n为什么改这条：说明背景。\n改了什么：说明范围。\n验证：说明证据。\n");
    const result = await s.delivery.deliver({
      dir,
      taskId: task.taskId,
      branch: BRANCH,
      messageFile,
      authorizationRef: "workflow:AGENTS.md#交付授权",
    });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.messages.artifact?.source, "agent");
    assert.equal(result.messages.artifact?.subject, "交付可读文案");
    assert.equal(result.messages.metadata?.source, "template");
    assert.equal(result.messages.archive?.source, "template");

    const artifactBody = git(dir, ["log", "-1", "--format=%B", result.workCommit]);
    assert.match(artifactBody, /^交付可读文案\n\n为什么改这条/m);
    assert.match(artifactBody, /Knit-Task: k-[0-9a-f]{12}/);
    assert.match(artifactBody, new RegExp(`Knit-Operation: ${result.operationId}`));
    assert.match(artifactBody, /Knit-Stage: artifact/);
    assert.match(artifactBody, /Knit-Verification: independent/);

    const metadataBody = git(dir, ["log", "-1", "--format=%B", result.metadataCommit]);
    assert.match(metadataBody, /^chore\(task\): 交付测试 \(k-[0-9a-f]{12}\)/m);
    assert.match(metadataBody, /结果：completed/);
    assert.match(metadataBody, /验证：independent — 检查 run-[0-9a-f]+ 通过/);
    assert.match(metadataBody, new RegExp(`产物提交：${result.workCommit.slice(0, 8)}`));
    assert.match(metadataBody, /Knit-Stage: metadata/);

    const archiveBody = git(dir, ["log", "-1", "--format=%B", result.archiveCommit]);
    assert.match(archiveBody, /^chore\(task\): archive 11-02-delivery \(k-[0-9a-f]{12}\)/m);
    assert.match(archiveBody, /移动：tasks\/11-02-delivery → tasks\/archive\/2026-11\/11-02-delivery/);
    assert.match(archiveBody, new RegExp(`资料提交：${result.metadataCommit.slice(0, 8)}`));
    assert.match(archiveBody, /Knit-Stage: archive/);

    const hits = searchHistory({ dir, query: "为什么改这条", scope: "git" });
    assert.equal(hits.length > 0, true, "新正文可被历史检索命中");
    assert.equal(hits[0]?.path, "git");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无文案：产物提交回落事实模板并报告 template 来源", async () => {
  const dir = project("template-message");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.messages.artifact?.source, "template");
    assert.equal(result.messages.artifact?.subject, `交付测试 (${task.taskId})`);
    const body = git(dir, ["log", "-1", "--format=%B", result.workCommit]);
    assert.match(body, /结果：completed/);
    assert.match(body, /验证：independent — 检查 run-[0-9a-f]+ 通过/);
    assert.match(body, /Knit-Stage: artifact/);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法文案在创建操作与提交前拒绝，不留下部分状态", async () => {
  const dir = project("invalid-message");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const beforeHead = git(dir, ["rev-parse", "HEAD"]).trim();
    const beforeIndex = git(dir, ["diff", "--cached", "--name-only"]);
    const beforeOperations = (await s.store.operations.list()).length;
    const bad = join(dir, "bad-message.txt");
    writeFileSync(bad, "只有标题\n");
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, messageFile: bad }),
      (error) => error.guardReason === "message_body_missing",
    );
    assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), beforeHead, "不产生提交");
    assert.equal(git(dir, ["diff", "--cached", "--name-only"]), beforeIndex, "index 不变");
    assert.equal((await s.store.operations.list()).length, beforeOperations, "不创建交付操作");
    assert.equal(existsSync(task.taskFile), true, "任务资料未移动");
    assert.equal(git(dir, ["status", "--porcelain"]).includes("app.txt"), true, "业务改动保留");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重试复用已持久化文案，新文件被忽略并记录证据", async () => {
  const dir = project("message-retry");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nif [ ! -f .git/failed-once ]; then touch .git/failed-once; exit 1; fi\nexit 0\n");
    chmodSync(hook, 0o755);
    const firstFile = join(dir, "first-message.txt");
    writeFileSync(firstFile, "第一次文案\n\n第一版正文。\n");
    const first = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, messageFile: firstFile });
    assert.equal(first.state, "needs_attention");
    const stored = await s.store.operations.get(first.operationId);
    assert.equal(stored?.messages?.artifact?.text.includes("第一版正文。"), true);

    const secondFile = join(dir, "second-message.txt");
    writeFileSync(secondFile, "第二次文案\n\n第二版正文。\n");
    const retry = await s.delivery.deliver({
      dir,
      taskId: task.taskId,
      branch: BRANCH,
      messageFile: secondFile,
      retry: true,
    });
    assert.equal(retry.state, "completed", retry.reason ?? "");
    const body = git(dir, ["log", "-1", "--format=%B", retry.workCommit]);
    assert.match(body, /^第一次文案/m);
    assert.match(body, /第一版正文。/);
    assert.doesNotMatch(body, /第二版正文/);
    const step = (await s.store.operations.get(retry.operationId))?.steps.find((entry) => entry.kind === "artifact_commit");
    assert.equal(step?.evidence?.message_ignored_on_retry, "true");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--plan 预览文案来源与首行，非法文案在预检阶段拒绝", async () => {
  const dir = project("message-plan");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const templatePlan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.equal(templatePlan.tasks[0]?.message.source, "template");
    assert.equal(templatePlan.tasks[0]?.message.subject, `交付测试 (${task.taskId})`);
    assert.equal(templatePlan.tasks[0]?.message.bodyLines, 2);

    const messageFile = join(dir, "plan-message.txt");
    writeFileSync(messageFile, "计划中的文案\n\n正文一。\n正文二。\n");
    const agentPlan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH, messageFile }]);
    assert.equal(agentPlan.tasks[0]?.message.source, "agent");
    assert.equal(agentPlan.tasks[0]?.message.subject, "计划中的文案");
    assert.equal(agentPlan.tasks[0]?.message.bodyLines, 2);

    writeFileSync(messageFile, "不合法\n");
    await assert.rejects(
      () => s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH, messageFile }]),
      (error) => error.guardReason === "message_body_missing",
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit-msg hook 改写 trailer：保留提交但 needs_attention，不把错误消息当完成", async () => {
  const dir = project("message-hook");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const hook = join(dir, ".git", "hooks", "commit-msg");
    writeFileSync(hook, '#!/bin/sh\nprintf "\\nKnit-Stage: rewritten\\n" >> "$1"\n');
    chmodSync(hook, 0o755);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "needs_attention");
    assert.equal(result.reason, "commit_message_mismatch");
    assert.ok(result.workCommit);
    assert.equal(existsSync(task.taskFile), true);
    assert.equal(git(dir, ["log", "-1", "--format=%B"]).includes("Knit-Stage: rewritten"), true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("历史成果恢复：验证原签名来源、提交与内容，保留完整范围并失效旧检查", async () => {
  const dir = project("scope-recovery");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const runs = new RunStore(dir);
    writeFileSync(join(dir, "legacy.txt"), "original\n");
    const entries = [currentEntry(dir, "app.txt", { factsKind: true }), currentEntry(dir, "legacy.txt", { factsKind: true })];
    runs.writeImplementation(task.taskId, { schemaVersion: 1, taskId: task.taskId, executor: "main-session",
      inputsDigest: task.check.inputsDigest, entries, scopeDigest: scopeDigest(entries),
      validations: ["原实施实际验证"], unverified: [], summary: null, recordedAt: NOW.toISOString() });
    const source = join(dir, "original-implementation.json");
    writeFileSync(source, readFileSync(join(dir, ".knit/.runtime/implementations", `${task.taskId}.json`)));
    runs.removeImplementation(task.taskId);
    writeFileSync(join(dir, "app.txt"), "later committed implementation\n");
    git(dir, ["add", "app.txt", "legacy.txt"]);
    git(dir, ["commit", "-qm", "合法后续成果"]);
    const commit = git(dir, ["rev-parse", "HEAD"]);
    const recovery = { branch: BRANCH, commit, paths: ["app.txt", "legacy.txt"], implementationFile: source };
    const original = JSON.stringify(runs.readScope(task.taskId));
    for (const bad of [
      { ...recovery, paths: ["other.txt"] }, { ...recovery, commit: "f".repeat(40) },
      { ...recovery, branch: "refs/heads/other" }, { ...recovery, commit: "HEAD" },
    ]) {
      await assert.rejects(s.tasks.rebind({ dir, taskId: task.taskId, recovery: bad }));
      assert.equal(JSON.stringify(runs.readScope(task.taskId)), original);
      assert.equal((await s.store.bindings.get(task.taskId)).lastCheckRunId, task.check.runId);
    }
    writeFileSync(join(dir, "app.txt"), "uncommitted\n");
    await assert.rejects(s.tasks.rebind({ dir, taskId: task.taskId, recovery }), /内容或模式不同/);
    writeFileSync(join(dir, "app.txt"), "later committed implementation\n");
    const forged = join(dir, "forged.json");
    writeFileSync(forged, JSON.stringify({ taskId: task.taskId }));
    await assert.rejects(s.tasks.rebind({ dir, taskId: task.taskId, recovery: { ...recovery, implementationFile: forged } }), /签名不可核验/);
    const result = await s.tasks.rebind({ dir, taskId: task.taskId, recovery });
    assert.equal(result.rebound, true);
    const scope = runs.readScope(task.taskId);
    assert.deepEqual(scope.entries.map(entry => entry.path), ["app.txt", "legacy.txt"]);
    assert.deepEqual(scope.runIds, task.scope.runIds);
    assert.equal(scope.recoveries[0].before[0].digest, entries[0].digest);
    assert.notEqual(scope.recoveries[0].after[0].digest, entries[0].digest);
    assert.equal(scope.recoveries[0].commit, commit);
    assert.equal(runs.readImplementation(task.taskId), null);
    assert.equal((await s.store.bindings.get(task.taskId)).lastCheckRunId, null);
    assert.deepEqual(runs.readCheck(task.check.runId), task.check);
    await assert.rejects(s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true }), /check_missing/);
    const manifest = join(dir, "recover.json");
    writeFileSync(manifest, JSON.stringify({ branch: BRANCH, commit, paths: ["legacy.txt"] }));
    const cli = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "../dist/cli/knit.js"), "--json", "task", "rebind", task.taskId, "--dir", dir, "--recover", manifest], { encoding: "utf8" }));
    assert.equal(cli.data.rebound, true);
    assert.equal(runs.readScope(task.taskId).recoveries.length, 2);
    runs.writeImplementation(task.taskId, { schemaVersion: 1, taskId: task.taskId, executor: "main-session",
      inputsDigest: task.check.inputsDigest, entries: scope.entries, scopeDigest: scope.digest,
      validations: ["实际验证"], unverified: [], summary: null, recordedAt: NOW.toISOString() });
    await s.tasks.rebind({ dir, taskId: task.taskId, recovery: { branch: BRANCH, commit, paths: ["legacy.txt"] } });
    assert.ok(runs.readScope(task.taskId).recoveries[2].implementationSource);
    const stageEnv = process.env.KNIT_STAGE_RUN_ID;
    process.env.KNIT_STAGE_RUN_ID = "run-abcdef123456";
    try {
      await assert.rejects(s.tasks.rebind({ dir, taskId: task.taskId, recovery }), error => error.guardReason === "stage_context_forbidden");
    } finally {
      if (stageEnv === undefined) delete process.env.KNIT_STAGE_RUN_ID;
      else process.env.KNIT_STAGE_RUN_ID = stageEnv;
    }
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("策略显式恢复：保留旧策略，核验授权并正常提交归档目录材料", async () => {
  const dir = project("policy-recovery");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const runs = new RunStore(dir);
    const binding = await s.store.bindings.get(task.taskId);
    await s.store.bindings.save({ ...binding, lastCheckRunId: null });
    const request = { dir, taskId: task.taskId, branch: BRANCH, authorizationRef: "workflow:AGENTS.md#交付授权" };
    await assert.rejects(s.delivery.deliver(request), /没有可交付的检查/);
    const operation = (await s.store.operations.list()).find(op => op.kind === "delivery.deliver");
    assert.equal(operation.state, "planned");
    const configFile = join(dir, ".knit/config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    writeFileSync(configFile, JSON.stringify({ ...config, delivery: { ...config.delivery, hooks: "skip" } }));
    writeFileSync(join(dir, "AGENTS.md"), readFileSync(join(dir, "AGENTS.md"), "utf8") + "检查需要提供证据。\n");
    const currentPlan = await new ContextPlanner({ store: s.store, now: () => NOW, randomHex: () => "abcdef123456" }).plan({ dir, taskId: task.taskId, role: "check" });
    const currentCheck = { ...task.check, runId: "run-abcdef123456", inputsDigest: currentPlan.inputsDigest,
      standardsDigest: currentPlan.standardsDigest, effectiveInputsDigest: currentPlan.effectiveInputsDigest };
    runs.writeCheck(currentCheck.runId, currentCheck);
    await s.store.bindings.save({ ...binding, lastCheckRunId: currentCheck.runId });
    await assert.rejects(s.delivery.deliver(request), /策略在操作开始后变化/);
    await assert.rejects(s.delivery.deliver({ ...request, recoverPolicy: true, authorizationRef: "user:missing" }), /原操作授权来源/);
    assert.equal((await s.store.operations.get(operation.operationId)).policyVersion, operation.policyVersion);
    await s.store.operations.save({ ...operation, workCommit: git(dir, ["rev-parse", "HEAD"]) });
    await assert.rejects(s.delivery.deliver({ ...request, recoverPolicy: true }), /副作用|旧提交/);
    assert.equal((await s.store.operations.get(operation.operationId)).policyVersion, operation.policyVersion);
    await s.store.operations.save({ ...operation, authorization: { kind: "user_reference", ref: "user:missing", path: null, section: null, digest: null, verified: false } });
    await assert.rejects(s.delivery.deliver({ ...request, recoverPolicy: true }), /用户授权缺少/);
    await s.store.operations.save(operation);
    const taskDir = join(dir, ".knit", task.relativePath.replace(/\/task\.md$/, ""));
    mkdirSync(join(taskDir, "research"), { recursive: true });
    writeFileSync(join(taskDir, "research/evidence.md"), "真实资料\n");
    const delivered = await s.delivery.deliver({ ...request, recoverPolicy: true });
    assert.equal(delivered.state, "completed", delivered.reason ?? "");
    const recovered = await s.store.operations.get(operation.operationId);
    assert.equal(recovered.policyRecoveries[0].previousPolicy, operation.policyVersion);
    assert.notEqual(recovered.policyRecoveries[0].currentPolicy, operation.policyVersion);
    assert.equal(recovered.policyRecoveries[0].authorization.verified, true);
    assert.equal(s.tasks.list({ dir }).active.length, 0);
    assert.ok(existsSync(join(dir, delivered.archivePath, "research/evidence.md")));
    assert.ok(delivered.metadataCommit && delivered.archiveCommit);
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const variant of ["recorded", "trailing-directory", "before-commit", "tree-mismatch", "paths-mismatch", "parent-mismatch", "message-mismatch", "missing-commit", "not-ancestor", "unrecorded", "unverified-history", "retry-only", "recover-only", "wrong-authorization", "wrong-branch", "final_record", "seal", "move", "sealed"]) {
  test(`策略恢复随重试：${variant}`, async () => {
    const dir = project(`policy-retry-${variant}`);
    const s = services(dir);
    try {
      const task = await makeDeliverable(dir, s);
      const runs = new RunStore(dir);
      if (variant === "trailing-directory") {
        mkdirSync(join(dir, "dir"));
        writeFileSync(join(dir, "dir/a.txt"), "a\n");
        writeFileSync(join(dir, "dir/b.txt"), "b\n");
        task.scope.entries = [currentEntry(dir, "dir/", { factsKind: true })];
        task.scope.digest = scopeDigest(task.scope.entries);
        runs.writeScope(task.taskId, task.scope);
        task.check.scopeDigest = task.scope.digest;
        task.check.runId = "run-abcdef123457";
        runs.writeCheck(task.check.runId, task.check);
        const binding = await s.store.bindings.get(task.taskId);
        await s.store.bindings.save({ ...binding, lastCheckRunId: task.check.runId });
      }
      const request = { dir, taskId: task.taskId, branch: BRANCH, authorizationRef: "workflow:AGENTS.md#交付授权" };
      const hook = join(dir, ".git/hooks", variant === "before-commit" ? "pre-commit" : "post-commit");
      writeFileSync(hook, variant === "before-commit" ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\necho hook-change >> other.txt\n");
      chmodSync(hook, 0o755);
      const first = await s.delivery.deliver(request);
      assert.equal(first.state, "needs_attention", first.reason);
      assert.equal(Boolean(first.workCommit), variant !== "before-commit");
      rmSync(hook);
      git(dir, ["restore", "other.txt"]);
      let operation = await s.store.operations.get(first.operationId);
      const artifact = operation.steps.find(step => step.kind === "artifact_commit");
      assert.equal(artifact.state, "needs_attention");
      const originalCommit = first.workCommit;
      if (variant === "trailing-directory") artifact.evidence.expectedTree = "{}";
      if (variant === "tree-mismatch") artifact.evidence.expectedTree = JSON.stringify({ "app.txt": "100644 blob wrong" });
      if (variant === "paths-mismatch") artifact.evidence.expectedPaths = "other.txt";
      if (variant === "parent-mismatch") artifact.evidence.before = "f".repeat(40);
      if (variant === "missing-commit") operation.workCommit = "f".repeat(40);
      if (variant === "message-mismatch") {
        git(dir, ["commit", "--amend", "-qm", "unrelated commit"]);
        operation.workCommit = git(dir, ["rev-parse", "HEAD"]);
      }
      if (variant === "not-ancestor") git(dir, ["reset", "--soft", `${originalCommit}^`]);
      if (variant === "unrecorded") operation.workCommit = null;
      if (variant === "unverified-history") {
        const hidden = execFileSync("git", ["commit-tree", `${originalCommit}^{tree}`, "-p", `${originalCommit}^`, "-m", `knit: artifact ${task.taskId} (${operation.operationId})`], {
          cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
        }).trim();
        git(dir, ["branch", "unverified-history", hidden]);
      }
      if (["final_record", "seal", "move"].includes(variant)) {
        const step = operation.steps.find(step => step.kind === variant);
        step.state = "needs_attention";
        step.evidence = { reason: "interrupted" };
      }
      if (variant === "sealed") operation.sealDigest = "a".repeat(64);
      await s.store.operations.save(operation);
      writeFileSync(join(dir, "AGENTS.md"), readFileSync(join(dir, "AGENTS.md"), "utf8") + "策略新增检查说明。\n");
      if (variant === "before-commit") {
        // 策略变化后重建当前检查资格；恢复开关仍须经过正常 prepare 守卫。
        const document = parseTaskDocument(readFileSync(task.taskFile, "utf8"), task.taskFile);
        writeFileSync(task.taskFile, renderTaskDocument({ ...document, frontmatter: { ...document.frontmatter, status: "open", outcome: null } }));
        runs.removeCompletion(task.taskId);
        const plan = await new ContextPlanner({ store: s.store, now: () => NOW, randomHex: () => "abcdef123456" }).plan({ dir, taskId: task.taskId, role: "check" });
        const check = { ...task.check, runId: "run-abcdef123458", inputsDigest: plan.inputsDigest, standardsDigest: plan.standardsDigest, effectiveInputsDigest: plan.effectiveInputsDigest };
        runs.writeCheck(check.runId, check);
        const binding = await s.store.bindings.get(task.taskId);
        await s.store.bindings.save({ ...binding, lastCheckRunId: check.runId });
      }
      operation = await s.store.operations.get(first.operationId);
      const head = git(dir, ["rev-parse", "HEAD"]);
      const originalRecord = JSON.stringify(operation);
      const retry = { ...request, retry: true, recoverPolicy: true };
      if (variant === "retry-only") {
        await assert.rejects(s.delivery.deliver({ ...request, retry: true }), error =>
          error.guardReason === "policy_changed" && /交付策略在操作开始后变化/.test(error.message) && /--recover-policy/.test(error.message) && /--retry/.test(error.message));
      } else if (variant === "recover-only") {
        const result = await s.delivery.deliver({ ...request, recoverPolicy: true });
        assert.equal(result.state, "needs_attention");
        assert.equal(result.operationId, operation.operationId);
      } else if (variant === "wrong-authorization") {
        await assert.rejects(s.delivery.deliver({ ...retry, authorizationRef: "user:other" }), error => error.guardReason === "authorization_required");
      } else if (variant === "wrong-branch") {
        await assert.rejects(s.delivery.deliver({ ...retry, branch: "refs/heads/other" }), error => error.guardReason === "branch_mismatch");
      } else if (!["recorded", "trailing-directory", "before-commit"].includes(variant)) {
        await assert.rejects(s.delivery.deliver(retry), error => error.guardReason === "policy_recovery_effects" && /步骤|提交|副作用|封存/.test(error.message));
      } else {
        const result = await s.delivery.deliver(retry);
        assert.equal(result.state, "completed", result.reason);
        assert.ok(result.metadataCommit && result.archiveCommit);
        if (originalCommit !== null) assert.equal(result.workCommit, originalCommit);
        const recovered = await s.store.operations.get(operation.operationId);
        assert.equal(recovered.policyRecoveries.length, 1);
        const recovery = recovered.policyRecoveries[0];
        assert.equal(recovery.previousPolicy, operation.policyVersion);
        assert.notEqual(recovery.currentPolicy, operation.policyVersion);
        assert.equal(recovery.currentPolicy, recovered.policyVersion);
        assert.equal(recovery.authorization.verified, true);
        assert.deepEqual(recovery.verifiedCommits, originalCommit === null ? [] : [originalCommit]);
        assert.equal(git(dir, ["log", "--format=%H", "--fixed-strings", "--grep=Knit-Stage: artifact"]).split("\n").filter(Boolean).length, 1);
        if (variant === "trailing-directory") assert.equal(recovered.steps.find(step => step.kind === "artifact_commit").evidence.supplementedPaths, "dir/a.txt\ndir/b.txt");
        return;
      }
      assert.equal(JSON.stringify(await s.store.operations.get(operation.operationId)), originalRecord);
      assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
    } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("abandoned 的无副作用交付保留历史且不被重新执行", async () => {
  const dir = project("abandoned");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const runs = new RunStore(dir);
    const binding = await s.store.bindings.get(task.taskId);
    await s.store.bindings.save({ ...binding, lastCheckRunId: null });
    const request = { dir, taskId: task.taskId, branch: BRANCH };
    await assert.rejects(s.delivery.deliver(request), /没有可交付的检查/);
    const old = (await s.store.operations.list()).find(op => op.kind === "delivery.deliver");
    execFileSync(process.execPath, [join(import.meta.dirname, "../dist/cli/knit.js"), "cancel", "--operation", old.operationId, "--dir", dir], { encoding: "utf8" });
    await s.store.bindings.save(binding);
    const delivered = await s.delivery.deliver(request);
    assert.equal(delivered.state, "completed", delivered.reason ?? "");
    assert.notEqual(delivered.operationId, old.operationId);
    assert.equal((await s.store.operations.get(old.operationId)).state, "abandoned");
  } finally { s.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
