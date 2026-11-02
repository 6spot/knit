/**
 * 011 规范候选到正式规则闭环测试。
 * 真实临时 Git 仓库、真实 SQLite、真实文件写入；不调用模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { atomicWrite, readWithVersion } from "../dist/infrastructure/atomic.js";
import { TaskService } from "../dist/application/task-service.js";
import { StandardsService } from "../dist/application/standards-service.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";
import { formalStandardsDigest, indexedStandardPaths } from "../dist/application/standards.js";
import { parseCandidates } from "../dist/contracts/standards.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");

function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-011-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function installTemplates(dir) {
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
}

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function makeServices(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const standards = new StandardsService({ store, locks, randomHex });
  const planner = new ContextPlanner({ store, randomHex });
  return { store, locks, tasks, standards, planner };
}

function candidateInput(dir, taskId, overrides = {}) {
  return {
    dir,
    taskId,
    title: "错误信息应包含定位",
    problem: "检查发现同类失败缺少文件与行号，定位成本高。",
    evidence: "任务记录中的两次失败。",
    scope: "src/ 下全部运行错误",
    rule: "运行错误必须包含项目相对路径与行号，并说明失败对象。",
    verification: "构造缺失文件错误，输出含路径与行号。",
    ...overrides,
  };
}

test("propose：候选只写任务资料，正式摘要与输入摘要不变", async () => {
  const dir = gitProject("propose");
  installTemplates(dir);
  const { store, tasks, standards, planner } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "候选任务", slug: "cand" });
    const ready = await tasks.ready({ dir, taskId: task.taskId });
    assert.equal(ready.confirmedStandardsDigest, formalStandardsDigest(dir));
    const beforePlan = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    const beforeInputs = beforePlan.inputsDigest;
    const beforeStandards = formalStandardsDigest(dir);

    const proposed = await standards.propose(candidateInput(dir, task.taskId));
    assert.match(proposed.candidate.candidateId, /^c-[0-9a-f]{12}$/);
    assert.equal(proposed.file, `.knit/tasks/${task.relativePath.split("/")[1]}/standards.md`);
    const text = readFileSync(join(dir, proposed.file), "utf8");
    assert.ok(text.includes("<!-- knit:candidate:start"));
    const parsed = parseCandidates(text);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.candidates[0].digest, proposed.candidate.digest);

    // 候选与记录不改变正式规范摘要、需求摘要或冻结输入。
    assert.equal(formalStandardsDigest(dir), beforeStandards);
    const plan = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(plan.inputsDigest, beforeInputs);
    assert.equal(plan.standardsDigest, beforeStandards);
    assert.equal(plan.effectiveInputsDigest, beforePlan.effectiveInputsDigest);
    const section = plan.sections.find((item) => item.kind === "standard-candidate");
    assert.equal(section.background, true);
    assert.equal(section.countsTowardInputs, false);
    assert.ok(plan.excluded.some((item) => item.reason === "candidate_not_applied"));

    // 纯记录同样不改变摘要与冻结事实。
    await tasks.record({ dir, taskId: task.taskId, body: "记录：候选已提出\n" });
    assert.equal(formalStandardsDigest(dir), beforeStandards);
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.confirmedStandardsDigest, beforeStandards);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending：有候选无回执需审阅；延期／拒绝有理由即可继续", async () => {
  const dir = gitProject("pending");
  installTemplates(dir);
  const { store, tasks, standards } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "延期任务", slug: "defer" });
    assert.equal((await standards.pending({ dir, taskId: task.taskId })).reason, "no_candidates");

    await standards.propose(candidateInput(dir, task.taskId));
    const pending = await standards.pending({ dir, taskId: task.taskId });
    assert.equal(pending.needsReview, true);
    assert.equal(pending.reason, "review_required");

    // 无回执不能采纳。
    await assert.rejects(
      () =>
        standards.apply({
          dir,
          taskId: task.taskId,
          candidateId: pending.candidateIds[0],
          target: ".knit/standards/index.md",
        }),
      (error) => error.guardReason === "review_required",
    );

    const deferred = await standards.review({
      dir,
      taskId: task.taskId,
      decision: "deferred",
      reason: "规则需更多项目证据，本任务继续。",
    });
    assert.equal(deferred.pending.needsReview, false);
    assert.equal(deferred.pending.reason, "review_matched");
    assert.deepEqual(deferred.review.targets, []);
    // 延期不改变正式规范。
    assert.equal(deferred.pending.matchedReview.decision, "deferred");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review：候选或分支变化重新提示，回执按摘要匹配", async () => {
  const dir = gitProject("review");
  installTemplates(dir);
  const { store, tasks, standards } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "匹配任务", slug: "match", branch: "refs/heads/main" });
    const first = await standards.propose(candidateInput(dir, task.taskId));
    const reviewed = await standards.review({
      dir,
      taskId: task.taskId,
      decision: "rejected",
      reason: "与现有规范重复。",
    });
    assert.equal(reviewed.review.branch, "refs/heads/main");
    assert.equal((await standards.pending({ dir, taskId: task.taskId })).needsReview, false);

    // 新增候选：旧回执不再匹配。
    await standards.propose(candidateInput(dir, task.taskId, { title: "第二条候选", rule: "第二条规则。" }));
    const changed = await standards.pending({ dir, taskId: task.taskId });
    assert.equal(changed.needsReview, true);
    assert.equal(changed.reason, "candidate_changed");

    // 只覆盖部分候选也不匹配当前集合。
    await standards.review({
      dir,
      taskId: task.taskId,
      decision: "deferred",
      reason: "先处理第一条。",
      candidateIds: [first.candidate.candidateId],
    });
    assert.equal((await standards.pending({ dir, taskId: task.taskId })).reason, "candidate_changed");

    // 覆盖全部候选后匹配。
    await standards.review({
      dir,
      taskId: task.taskId,
      decision: "mixed",
      reason: "一条采纳、一条延期。",
      targets: [".knit/standards/index.md"],
      candidateIds: changed.candidateIds,
    });
    assert.equal((await standards.pending({ dir, taskId: task.taskId })).needsReview, false);

    // 分支变化：任务 frontmatter 的 branch 变了，回执需重新确认。
    const file = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    const version = readWithVersion(file);
    const document = parseTaskDocument(version.data.toString("utf8"), file);
    atomicWrite({
      path: file,
      data: Buffer.from(
        renderTaskDocument({ ...document, frontmatter: { ...document.frontmatter, branch: "refs/heads/dev" } }),
        "utf8",
      ),
      expectedSha256: version.sha256,
      mode: 0o644,
    });
    const branchChanged = await standards.pending({ dir, taskId: task.taskId });
    assert.equal(branchChanged.needsReview, true);
    assert.equal(branchChanged.reason, "branch_changed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：按回执写入正文与索引，正式摘要变化并列出受影响任务", async () => {
  const dir = gitProject("apply");
  installTemplates(dir);
  mkdirSync(join(dir, ".knit", "standards"), { recursive: true });
  writeFileSync(join(dir, ".knit", "standards", "errors.md"), "# 错误处理\n\n现有约定。\n");
  const { store, tasks, standards, planner } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "采纳任务", slug: "apply" });
    const ready = await tasks.ready({ dir, taskId: task.taskId });
    const beforeApply = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    const proposed = await standards.propose(candidateInput(dir, task.taskId));
    await standards.review({
      dir,
      taskId: task.taskId,
      decision: "applied",
      reason: "规则有证据，采纳。",
      targets: [".knit/standards/errors.md"],
    });
    const applied = await standards.apply({
      dir,
      taskId: task.taskId,
      candidateId: proposed.candidate.candidateId,
      target: ".knit/standards/errors.md",
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.indexUpdated, true);
    assert.notEqual(applied.standardsDigest, ready.confirmedStandardsDigest);
    assert.ok(applied.affectedTasks.includes(task.taskId));

    const targetText = readFileSync(join(dir, ".knit", "standards", "errors.md"), "utf8");
    assert.ok(targetText.includes("## 错误信息应包含定位"));
    assert.ok(targetText.includes("运行错误必须包含项目相对路径与行号"));
    assert.ok(targetText.includes(`来源：任务 ${task.taskId}／候选 ${proposed.candidate.candidateId}。`));
    const indexText = readFileSync(join(dir, ".knit", "standards", "index.md"), "utf8");
    assert.ok(indexText.includes("[errors.md](./errors.md)"));
    assert.ok(indexedStandardPaths(dir).includes("errors.md"));

    // 重复采纳幂等，不重复追加。
    const again = await standards.apply({
      dir,
      taskId: task.taskId,
      candidateId: proposed.candidate.candidateId,
      target: ".knit/standards/errors.md",
    });
    assert.equal(again.alreadyApplied, true);
    assert.equal(again.applied, false);
    assert.equal(
      readFileSync(join(dir, ".knit", "standards", "errors.md"), "utf8").match(/## 错误信息应包含定位/g).length,
      1,
    );

    // 正式规范变化进入上下文计划与摘要，候选仍只是背景。
    const plan = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(plan.standardsDigest, applied.standardsDigest);
    assert.notEqual(plan.standardsDigest, ready.confirmedStandardsDigest);
    assert.notEqual(plan.effectiveInputsDigest, beforeApply.effectiveInputsDigest, "正式规范变化改变整体输入身份");
    assert.ok(plan.sections.some((section) => section.kind === "standard" && section.path === ".knit/standards/errors.md"));
    const list = await standards.list({ dir, taskId: task.taskId });
    assert.equal(list.standardsDigest, applied.standardsDigest);
    assert.equal(list.task.pending.needsReview, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply 守卫：目标须在匹配回执内且不能是候选目录", async () => {
  const dir = gitProject("guard");
  installTemplates(dir);
  writeFileSync(join(dir, ".knit", "standards", "a.md"), "# A\n");
  writeFileSync(join(dir, ".knit", "standards", "b.md"), "# B\n");
  const { store, tasks, standards } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "守卫任务", slug: "guard" });
    const proposed = await standards.propose(candidateInput(dir, task.taskId));
    await standards.review({
      dir,
      taskId: task.taskId,
      decision: "applied",
      reason: "只采纳到 a。",
      targets: [".knit/standards/a.md"],
    });
    await assert.rejects(
      () =>
        standards.apply({
          dir,
          taskId: task.taskId,
          candidateId: proposed.candidate.candidateId,
          target: ".knit/standards/b.md",
        }),
      (error) => error.guardReason === "review_required",
    );
    await assert.rejects(
      () =>
        standards.review({
          dir,
          taskId: task.taskId,
          decision: "applied",
          reason: "候选目录不能作为正式目标。",
          targets: [".knit/standards/candidates/x.md"],
        }),
      (error) => /候选|正式/.test(error.message),
    );
    await assert.rejects(
      () =>
        standards.review({
          dir,
          taskId: task.taskId,
          decision: "applied",
          reason: "缺少目标。",
        }),
      (error) => error.guardReason === "target_required",
    );
    // 未采纳前目标正文不变。
    assert.equal(readFileSync(join(dir, ".knit", "standards", "b.md"), "utf8"), "# B\n");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：propose/review/apply/pending 走协议输出，未知决定为参数错误", async () => {
  const dir = gitProject("cli");
  installTemplates(dir);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  try {
    const tasks = new TaskService({ store });
    const task = await tasks.newTask({ dir, title: "CLI 规范", slug: "cli" });
    await tasks.ready({ dir, taskId: task.taskId });

    const proposeRaw = execFileSync(
      process.execPath,
      [
        CLI,
        "--json",
        "standards",
        "propose",
        "--task",
        task.taskId,
        "--title",
        "CLI 候选",
        "--problem",
        "问题描述",
        "--rule",
        "规则正文",
        "--dir",
        dir,
      ],
      { encoding: "utf8" },
    );
    const proposed = JSON.parse(proposeRaw);
    assert.equal(proposed.outcome, "completed");
    assert.match(proposed.data.candidate.candidateId, /^c-/);

    const pendingRaw = execFileSync(
      process.execPath,
      [CLI, "--json", "standards", "pending", "--task", task.taskId, "--dir", dir],
      { encoding: "utf8" },
    );
    const pending = JSON.parse(pendingRaw);
    assert.equal(pending.data.needsReview, true);
    assert.equal(pending.data.reason, "review_required");

    const reviewRaw = execFileSync(
      process.execPath,
      [
        CLI,
        "--json",
        "standards",
        "review",
        "--task",
        task.taskId,
        "--decision",
        "rejected",
        "--reason",
        "一次性细节，不收录。",
        "--dir",
        dir,
      ],
      { encoding: "utf8" },
    );
    assert.equal(JSON.parse(reviewRaw).data.pending.needsReview, false);

    const listRaw = execFileSync(
      process.execPath,
      [CLI, "--json", "standards", "list", "--task", task.taskId, "--dir", dir],
      { encoding: "utf8" },
    );
    const listed = JSON.parse(listRaw);
    assert.equal(listed.data.task.candidates.length, 1);
    assert.ok(listed.data.formal.length >= 1);

    // 未知决定：协议错误 + 非零退出。
    let badRaw;
    try {
      execFileSync(
        process.execPath,
        [CLI, "--json", "standards", "review", "--task", task.taskId, "--decision", "approve", "--reason", "x", "--dir", dir],
        { encoding: "utf8" },
      );
      assert.fail("未知决定应失败");
    } catch (error) {
      badRaw = error.stdout;
    }
    const bad = JSON.parse(badRaw);
    assert.equal(bad.outcome, "error");
    assert.equal(bad.reasonCode, "invalid_request");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
