/**
 * 规范沉淀独立于任务：项目级候选、审阅、采纳、迁移与旧任务只读兼容。
 * 真实临时 Git 仓库、真实 SQLite、真实文件写入；不调用模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { agentsManagedBlock } from "../dist/application/templates.js";
import {
  PROJECT_CANDIDATES_FILE,
  PROJECT_SCOPE,
  candidateDigestOf,
  candidateSetDigest,
  parseCandidates,
  renderCandidate,
} from "../dist/contracts/standards.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");

function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-standards-${prefix}-`));
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

function writeTarget(dir, path = ".knit/standards/errors.md") {
  mkdirSync(join(dir, ".knit", "standards"), { recursive: true });
  writeFileSync(join(dir, path), "# 错误处理\n\n现有约定。\n");
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

function candidateInput(dir, overrides = {}) {
  return {
    dir,
    title: "错误信息应包含定位",
    problem: "检查发现同类失败缺少文件与行号，定位成本高。",
    evidence: "任务记录中的两次失败。",
    scope: "src/ 下全部运行错误",
    rule: "运行错误必须包含项目相对路径与行号，并说明失败对象。",
    verification: "构造缺失文件错误，输出含路径与行号。",
    ...overrides,
  };
}

test("无任务项目：候选保存、明确采纳与正式规范索引闭环", async () => {
  const dir = gitProject("project-only");
  installTemplates(dir);
  writeTarget(dir);
  const { store, standards } = makeServices(dir);
  try {
    const before = formalStandardsDigest(dir);
    const proposed = await standards.propose(candidateInput(dir));
    assert.match(proposed.candidate.candidateId, /^c-[0-9a-f]{12}$/);
    assert.equal(proposed.candidate.source, "讨论");
    assert.equal(proposed.file, `.knit/standards/${PROJECT_CANDIDATES_FILE}`);
    assert.equal(existsSync(join(dir, ".knit", "tasks", "standards.md")), false);
    const text = readFileSync(join(dir, proposed.file), "utf8");
    const parsed = parseCandidates(text);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.candidates[0].digest, proposed.candidate.digest);

    // 候选不进入正式规范摘要，也不出现在正式规范清单。
    assert.equal(formalStandardsDigest(dir), before);
    const listed = await standards.list({ dir });
    assert.equal(listed.formal.some((file) => file.relativePath === PROJECT_CANDIDATES_FILE), false);
    assert.equal(listed.candidates.length, 1);
    assert.equal(listed.pending.reason, "review_required");
    assert.equal(listed.migration.unmigrated, 0);

    const reviewed = await standards.review({
      dir,
      decision: "applied",
      reason: "用户明确要求长期规则，含义清楚，直接采纳。",
      targets: [".knit/standards/errors.md"],
    });
    assert.equal(reviewed.review.taskId, undefined);
    assert.equal(reviewed.review.sourceTaskId, undefined);
    assert.equal(reviewed.review.branch, "refs/heads/main");
    assert.equal((await standards.pending({ dir })).reason, "review_matched");

    const applied = await standards.apply({
      dir,
      candidateId: proposed.candidate.candidateId,
      target: ".knit/standards/errors.md",
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.indexUpdated, true);
    assert.equal(applied.sourceTaskId, null);
    assert.deepEqual(applied.affectedTasks, []);
    assert.notEqual(applied.standardsDigest, before);
    const targetText = readFileSync(join(dir, ".knit", "standards", "errors.md"), "utf8");
    assert.ok(targetText.includes("## 错误信息应包含定位"));
    assert.ok(targetText.includes("来源：讨论／候选"));
    assert.ok(readFileSync(join(dir, ".knit", "standards", "index.md"), "utf8").includes("[errors.md](./errors.md)"));
    assert.ok(indexedStandardPaths(dir).includes("errors.md"));

    const again = await standards.apply({
      dir,
      candidateId: proposed.candidate.candidateId,
      target: ".knit/standards/errors.md",
    });
    assert.equal(again.alreadyApplied, true);
    assert.equal(
      readFileSync(join(dir, ".knit", "standards", "errors.md"), "utf8").match(/## 错误信息应包含定位/g).length,
      1,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("自行采纳与来源任务：sourceTaskId 只标注来源，不要求任务存在或分支一致", async () => {
  const dir = gitProject("source-task");
  installTemplates(dir);
  writeTarget(dir);
  const { store, standards } = makeServices(dir);
  try {
    const sourceTaskId = "k-000000000000";
    const proposed = await standards.propose(candidateInput(dir, { sourceTaskId }));
    assert.equal(proposed.candidate.source, `任务 ${sourceTaskId}`);
    const reviewed = await standards.review({
      dir,
      sourceTaskId,
      decision: "applied",
      reason: "依据：讨论已确认 + 两次一致处理，自行采纳。",
      targets: [".knit/standards/errors.md"],
    });
    assert.equal(reviewed.review.taskId, undefined);
    assert.equal(reviewed.review.sourceTaskId, sourceTaskId);
    const projectReview = await store.standardsReviews.latest(PROJECT_SCOPE);
    assert.equal(projectReview?.reviewId, reviewed.review.reviewId);
    assert.equal(await store.standardsReviews.latest(sourceTaskId), null, "不伪造任务作用域回执");

    // 项目级匹配不要求分支一致；分支只作记录。
    execFileSync("git", ["checkout", "-q", "-b", "dev"], { cwd: dir });
    assert.equal((await standards.pending({ dir })).reason, "review_matched");

    const applied = await standards.apply({
      dir,
      sourceTaskId,
      candidateId: proposed.candidate.candidateId,
      target: ".knit/standards/errors.md",
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.sourceTaskId, sourceTaskId);
    assert.ok(
      readFileSync(join(dir, ".knit", "standards", "errors.md"), "utf8").includes(`来源：任务 ${sourceTaskId}／候选`),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("候选保留、冲突等待决定与一次性例外：延期不改正式规范", async () => {
  const dir = gitProject("deferred");
  installTemplates(dir);
  writeTarget(dir);
  const { store, standards } = makeServices(dir);
  try {
    // 一次性例外：不提议、不写入候选文件。
    assert.equal((await standards.pending({ dir })).reason, "no_candidates");
    assert.equal(existsSync(join(dir, ".knit", "standards", PROJECT_CANDIDATES_FILE)), false);
    const before = formalStandardsDigest(dir);

    const first = await standards.propose(candidateInput(dir));
    const second = await standards.propose(
      candidateInput(dir, { title: "第二条候选", rule: "第二条规则。", scope: "文档" }),
    );
    const retained = await standards.pending({ dir });
    assert.equal(retained.needsReview, true);
    assert.equal(retained.reason, "review_required");
    assert.equal(retained.candidateIds.length, 2);

    // 只处理部分候选：仍提示候选已变化。
    await standards.review({
      dir,
      decision: "deferred",
      reason: "与现有规则冲突，先等用户决定。",
      candidateIds: [first.candidate.candidateId],
    });
    const partial = await standards.pending({ dir });
    assert.equal(partial.reason, "candidate_changed");
    assert.equal(partial.matchedReview, null);

    // 全部延期：有理由即可继续，但不改变正式规范。
    const deferred = await standards.review({
      dir,
      decision: "deferred",
      reason: "两条规则都需要用户确认取舍。",
      candidateIds: [first.candidate.candidateId, second.candidate.candidateId],
    });
    assert.equal(deferred.pending.reason, "review_matched");
    assert.equal(deferred.pending.matchedReview.decision, "deferred");
    assert.equal(formalStandardsDigest(dir), before);
    assert.equal(readFileSync(join(dir, ".knit", "standards", "errors.md"), "utf8"), "# 错误处理\n\n现有约定。\n");

    // 新候选保留待审阅。
    await standards.propose(candidateInput(dir, { title: "第三条候选", rule: "第三条规则。" }));
    const after = await standards.pending({ dir });
    assert.equal(after.needsReview, true);
    assert.equal(after.reason, "candidate_changed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移旧任务候选：幂等、原文不变、旧回执可读且迁移后按 ID 审阅采纳", async () => {
  const dir = gitProject("migrate");
  installTemplates(dir);
  writeTarget(dir);
  const { store, tasks, standards } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "旧候选任务", slug: "legacy", branch: "refs/heads/main" });
    const base = {
      candidateId: "c-000000000abc",
      title: "旧规则",
      problem: "旧问题",
      evidence: "旧证据",
      scope: "src/",
      rule: "旧规则正文。",
      verification: "",
    };
    const legacy = { ...base, digest: candidateDigestOf(base) };
    const legacyFile = join(dir, ".knit", task.relativePath.split("/").slice(0, -1).join("/"), "standards.md");
    writeFileSync(legacyFile, `# 规范候选\n\n${renderCandidate(legacy)}\n`);
    const before = readFileSync(legacyFile, "utf8");

    // 旧任务回执仍可按任务读取。
    await store.standardsReviews.save({
      reviewId: "r-000000000abc",
      taskId: task.taskId,
      branch: "refs/heads/main",
      candidateDigest: candidateSetDigest([legacy]),
      decision: "rejected",
      reason: "旧回执",
      targets: [],
      candidateIds: [legacy.candidateId],
      operationId: "op-old-review",
      recordedAt: "2026-11-01T00:00:00.000Z",
    });
    const listed = await standards.list({ dir, taskId: task.taskId });
    assert.equal(listed.task.candidates.length, 1);
    assert.equal(listed.task.pending.reason, "review_matched");
    assert.equal(listed.task.pending.latestReview.reviewId, "r-000000000abc");
    assert.equal(listed.migration.unmigrated, 1);
    assert.deepEqual(listed.migration.sources, [{ taskId: task.taskId, candidateIds: [legacy.candidateId] }]);

    // 旧视图保留分支匹配；项目视图不受任务分支影响。
    const taskFile = join(dir, ".knit", task.relativePath);
    const version = readWithVersion(taskFile);
    const document = parseTaskDocument(version.data.toString("utf8"), taskFile);
    atomicWrite({
      path: taskFile,
      data: Buffer.from(
        renderTaskDocument({ ...document, frontmatter: { ...document.frontmatter, branch: "refs/heads/dev" } }),
        "utf8",
      ),
      expectedSha256: version.sha256,
      mode: 0o644,
    });
    assert.equal((await standards.list({ dir, taskId: task.taskId })).task.pending.reason, "branch_changed");

    const beforeMigrateDigest = formalStandardsDigest(dir);
    const first = await standards.migrate({ dir });
    assert.equal(first.migrated, 1);
    assert.equal(formalStandardsDigest(dir), beforeMigrateDigest, "迁移不改变正式规范摘要");
    assert.equal(first.skipped, 0);
    assert.deepEqual(first.sources, [{ taskId: task.taskId, candidateIds: [legacy.candidateId] }]);
    assert.equal(readFileSync(legacyFile, "utf8"), before, "原 standards.md 不改写");
    const project = await standards.list({ dir });
    assert.equal(project.candidates.length, 1);
    assert.equal(project.candidates[0].candidateId, legacy.candidateId);
    assert.equal(project.candidates[0].source, `任务 ${task.taskId}`);
    assert.equal(project.candidates[0].digest, legacy.digest, "来源不进入候选摘要");
    assert.equal(project.migration.unmigrated, 0);

    const second = await standards.migrate({ dir });
    assert.equal(second.migrated, 0);
    assert.equal(second.skipped, 1);
    assert.equal(readFileSync(legacyFile, "utf8"), before);

    // 迁移后旧候选按 ID 审阅采纳，来源保留原任务说明。
    await standards.review({
      dir,
      decision: "applied",
      reason: "迁移后按项目候选重新审阅。",
      targets: [".knit/standards/errors.md"],
    });
    const applied = await standards.apply({
      dir,
      candidateId: legacy.candidateId,
      target: ".knit/standards/errors.md",
    });
    assert.equal(applied.applied, true);
    assert.ok(
      readFileSync(join(dir, ".knit", "standards", "errors.md"), "utf8").includes(
        `来源：任务 ${task.taskId}／候选 ${legacy.candidateId}`,
      ),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("采纳目标边界：父链接、目标链接、候选文件、.. 与绝对路径拒绝；项目内采纳正常", async () => {
  const outside = mkdtempSync(join(tmpdir(), "knit-standards-outside-"));
  writeFileSync(join(outside, "rules.md"), "# Outside\n");
  const scenarios = [
    { name: "parent-symlink", setup: (dir) => { symlinkSync(outside, join(dir, ".knit", "standards", "ext"), "dir"); return ".knit/standards/ext/rules.md"; }, outsidePath: () => join(outside, "rules.md") },
    { name: "target-symlink", setup: (dir) => { mkdirSync(join(dir, ".knit", "standards", "ext")); writeFileSync(join(dir, ".knit", "standards", "ext", "rules.md"), "# Local\n"); rmSync(join(dir, ".knit", "standards", "ext", "rules.md")); symlinkSync(join(outside, "rules.md"), join(dir, ".knit", "standards", "ext", "rules.md")); return ".knit/standards/ext/rules.md"; }, outsidePath: () => join(outside, "rules.md") },
    { name: "dotdot", setup: () => ".knit/standards/../outside.md", outsidePath: null },
    { name: "absolute", setup: () => join(outside, "rules.md"), outsidePath: () => join(outside, "rules.md") },
    { name: "candidate-file", setup: () => `.knit/standards/${PROJECT_CANDIDATES_FILE}`, outsidePath: null },
  ];
  for (const scenario of scenarios) {
    const dir = gitProject(`contain-${scenario.name}`);
    installTemplates(dir);
    const s = makeServices(dir);
    try {
      const target = scenario.setup(dir);
      const proposed = await s.standards.propose(candidateInput(dir));
      let reviewOk = true;
      try {
        await s.standards.review({ dir, decision: "applied", reason: "合成审阅", targets: [target] });
      } catch {
        reviewOk = false;
      }
      if (reviewOk) {
        await assert.rejects(
          () => s.standards.apply({ dir, candidateId: proposed.candidate.candidateId, target }),
          (error) =>
            ["path_escape", "unknown_target", "review_required"].includes(error.guardReason) ||
            /目标规范|越界|symlink|escape|必须位于|候选/.test(String(error.message ?? error)),
          `场景 ${scenario.name} 应拒绝`,
        );
      }
      if (scenario.outsidePath !== null) {
        assert.equal(readFileSync(scenario.outsidePath(), "utf8"), "# Outside\n", `场景 ${scenario.name} 项目外无变化`);
      }
    } finally {
      s.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(outside, { recursive: true, force: true });

  const dir = gitProject("contain-normal");
  installTemplates(dir);
  writeTarget(dir, ".knit/standards/normal.md");
  const s = makeServices(dir);
  try {
    const proposed = await s.standards.propose(candidateInput(dir));
    await s.standards.review({
      dir,
      decision: "applied",
      reason: "正常审阅",
      targets: [".knit/standards/normal.md"],
    });
    const applied = await s.standards.apply({
      dir,
      candidateId: proposed.candidate.candidateId,
      target: ".knit/standards/normal.md",
    });
    assert.equal(applied.applied, true);
    const again = await s.standards.apply({
      dir,
      candidateId: proposed.candidate.candidateId,
      target: ".knit/standards/normal.md",
    });
    assert.equal(again.alreadyApplied, true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("propose：项目候选只作背景，正式摘要、需求摘要与有效身份不变", async () => {
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

    const proposed = await standards.propose(candidateInput(dir, { sourceTaskId: task.taskId }));
    assert.equal(proposed.file, `.knit/standards/${PROJECT_CANDIDATES_FILE}`);
    assert.equal(formalStandardsDigest(dir), beforeStandards);

    const plan = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(plan.inputsDigest, beforeInputs);
    assert.equal(plan.standardsDigest, beforeStandards);
    assert.equal(plan.effectiveInputsDigest, beforePlan.effectiveInputsDigest);
    const section = plan.sections.find((item) => item.sourceId === "standard-candidate:project");
    assert.equal(section.background, true);
    assert.equal(section.countsTowardInputs, false);
    assert.ok(plan.excluded.some((item) => item.reason === "candidate_not_applied"));
    assert.equal(plan.sections.some((item) => item.kind === "standard" && item.path.endsWith(PROJECT_CANDIDATES_FILE)), false);

    await tasks.record({ dir, taskId: task.taskId, body: "记录：候选已提出\n" });
    assert.equal(formalStandardsDigest(dir), beforeStandards);
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.confirmedStandardsDigest, beforeStandards);

    // 旧任务候选文件仍作为只读背景，不改变有效身份。
    const legacyFile = join(dir, ".knit", task.relativePath.split("/").slice(0, -1).join("/"), "standards.md");
    const base = {
      candidateId: "c-0000000000aa",
      title: "旧背景候选",
      problem: "旧问题",
      evidence: "",
      scope: "",
      rule: "旧规则。",
      verification: "",
    };
    writeFileSync(legacyFile, `${renderCandidate({ ...base, digest: candidateDigestOf(base) })}\n`);
    const legacyPlan = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(legacyPlan.effectiveInputsDigest, beforePlan.effectiveInputsDigest);
    assert.ok(legacyPlan.sections.some((item) => item.kind === "standard-candidate" && item.path.endsWith("standards.md")));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("采纳按实际效果恢复：正文成功索引失败可补齐；候选同 ID 新版本不假成功（任务038）", async () => {
  const dir = gitProject("recover");
  installTemplates(dir);
  writeTarget(dir);
  const { store, standards } = makeServices(dir);
  try {
    const proposed = await standards.propose(candidateInput(dir));
    const target = ".knit/standards/errors.md";
    await standards.review({ dir, decision: "applied", reason: "采纳。", targets: [target] });
    const first = await standards.apply({ dir, candidateId: proposed.candidate.candidateId, target });
    assert.equal(first.applied, true);

    // 中断恢复：回滚索引（保留正文），重试补齐索引而不重复正文。
    const indexPath = join(dir, ".knit", "standards", "index.md");
    const textBefore = readFileSync(join(dir, target), "utf8");
    writeFileSync(indexPath, "# 规范索引\n\n- 暂无\n");
    const recovered = await standards.apply({ dir, candidateId: proposed.candidate.candidateId, target });
    assert.equal(recovered.alreadyApplied, false);
    assert.equal(recovered.indexUpdated, true);
    assert.equal(readFileSync(join(dir, target), "utf8"), textBefore, "正文不重复追加");
    assert.ok(readFileSync(indexPath, "utf8").includes("errors.md"));

    const again = await standards.apply({ dir, candidateId: proposed.candidate.candidateId, target });
    assert.equal(again.alreadyApplied, true);
    assert.equal(readFileSync(join(dir, target), "utf8"), textBefore);

    // 候选同 ID 新版本（v2）：直接改项目候选文件内容模拟候选更新；旧 v1 已在正文，新版本仍需真正写入。
    const candidatesFile = join(dir, proposed.file);
    writeFileSync(candidatesFile, readFileSync(candidatesFile, "utf8").replace(proposed.candidate.rule, "运行错误必须同时包含项目相对路径与行号（v2）。"));
    await standards.review({ dir, decision: "applied", reason: "采纳 v2。", targets: [target] });
    const applyV2 = await standards.apply({ dir, candidateId: proposed.candidate.candidateId, target });
    assert.equal(applyV2.alreadyApplied, false, "新版本不冒充已采纳");
    assert.equal(applyV2.applied, true);
    const finalText = readFileSync(join(dir, target), "utf8");
    assert.ok(finalText.includes("（v2）。"), "正式正文含 v2 规则");
    assert.ok(readFileSync(indexPath, "utf8").includes("errors.md"), "索引仍链接目标");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply 守卫：目标须在匹配回执内，项目候选不能作为正式目标", async () => {
  const dir = gitProject("guard");
  installTemplates(dir);
  writeFileSync(join(dir, ".knit", "standards", "a.md"), "# A\n");
  writeFileSync(join(dir, ".knit", "standards", "b.md"), "# B\n");
  const { store, standards } = makeServices(dir);
  try {
    const proposed = await standards.propose(candidateInput(dir));
    await standards.review({
      dir,
      decision: "applied",
      reason: "只采纳到 a。",
      targets: [".knit/standards/a.md"],
    });
    await assert.rejects(
      () => standards.apply({ dir, candidateId: proposed.candidate.candidateId, target: ".knit/standards/b.md" }),
      (error) => error.guardReason === "review_required",
    );
    await assert.rejects(
      () =>
        standards.review({
          dir,
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
          decision: "applied",
          reason: "缺少目标。",
        }),
      (error) => error.guardReason === "target_required",
    );
    assert.equal(readFileSync(join(dir, ".knit", "standards", "b.md"), "utf8"), "# B\n");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：无任务 propose/review/apply/pending/list/migrate 走协议输出", async () => {
  const dir = gitProject("cli");
  installTemplates(dir);
  writeTarget(dir);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  try {
    const run = (args) => JSON.parse(execFileSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], { encoding: "utf8" }));

    const proposed = run([
      "standards", "propose",
      "--title", "CLI 候选",
      "--problem", "问题描述",
      "--rule", "规则正文",
      "--source", "讨论",
    ]);
    assert.equal(proposed.outcome, "completed");
    assert.match(proposed.data.candidate.candidateId, /^c-/);
    assert.equal(proposed.data.candidate.source, "讨论");

    const pending = run(["standards", "pending"]);
    assert.equal(pending.data.needsReview, true);
    assert.equal(pending.data.reason, "review_required");

    const review = run([
      "standards", "review",
      "--decision", "applied",
      "--reason", "明确长期规则，采纳。",
      "--target", ".knit/standards/errors.md",
    ]);
    assert.equal(review.data.pending.needsReview, false);

    const applied = run([
      "standards", "apply",
      "--candidate", proposed.data.candidate.candidateId,
      "--target", ".knit/standards/errors.md",
    ]);
    assert.equal(applied.data.applied, true);
    assert.equal(applied.data.indexUpdated, true);

    const listed = run(["standards", "list"]);
    assert.equal(listed.data.candidates.length, 1);
    assert.equal(listed.data.pending.reason, "review_matched");
    assert.equal(listed.data.formal.some((file) => file.relativePath === PROJECT_CANDIDATES_FILE), false);

    const migrated = run(["standards", "migrate"]);
    assert.equal(migrated.data.migrated, 0);
    assert.equal(migrated.data.skipped, 0);

    // 未知决定：协议错误 + 非零退出。
    let badRaw;
    try {
      execFileSync(
        process.execPath,
        [CLI, "--json", "standards", "review", "--decision", "approve", "--reason", "x", "--dir", dir],
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


test("模板指令：主动识别、冲突待决定、项目候选、一次性范围与末尾告知均有规则", () => {
  const agents = agentsManagedBlock("npx --no-install knit");
  assert.match(agents, /规范沉淀/);
  assert.match(agents, /不依附任务/);
  assert.match(agents, /冲突.*取得用户决定/);
  assert.match(agents, /一次性要求只留本次范围/);
  assert.match(agents, /正常回复末尾简短说明/);
  assert.match(agents, /\.knit\/standards\/candidates\.md/);
  assert.match(readFileSync(join(TEMPLATES, "agents", "implement.md"), "utf8"), /主动沉淀可复用规范/);
  assert.match(readFileSync(join(TEMPLATES, "agents", "check.md"), "utf8"), /项目规范沉淀/);
  assert.equal(existsSync(join(TEMPLATES, "agents", "deliver.md")), false, "交付辅助角色模板已撤除");
  assert.match(agents, /核对实际成果与完成条件/);
  assert.match(agents, /不另启动交付辅助 worker/);
  assert.match(agents, /已有明确授权不重复确认/);
  assert.match(agents, /按操作记录核实工具与 Git 实际效果/);
  assert.match(agents, /规范候选未审阅不构成交付前置/);
});
