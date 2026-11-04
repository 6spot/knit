/**
 * 规范演进用例：项目级候选、机械提示、审阅回执与采纳（DESIGN.md 第8.2节、STATES.md 第9节）。
 * 语义判断由主 Agent 完成；这里只核对候选摘要、回执与目标版本。
 * 候选与回执以项目为作用域，不要求 taskId、任务存在或任务阶段；
 * 旧任务目录的 standards.md 只读兼容，并可经 migrate 迁入项目候选文件。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { TaskBinding } from "../contracts/metadata.js";
import {
  PROJECT_CANDIDATES_FILE,
  PROJECT_SCOPE,
  candidateDigestOf,
  candidateSetDigest,
  newCandidateId,
  newReviewId,
  parseCandidates,
  renderCandidate,
  renderCandidateRule,
  type StandardsCandidate,
  type StandardsReview,
  type StandardsReviewDecision,
} from "../contracts/standards.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { GuardError } from "./guard-error.js";
import { scanCredentials } from "../contracts/credentials.js";
import { locateTaskDocument } from "./task-service.js";
import { currentBranch } from "./delivery.js";
import { parseTaskDocument } from "./task-document.js";
import {
  STANDARDS_DIR,
  STANDARDS_INDEX,
  formalStandardFiles,
  formalStandardsDigest,
  indexedStandardPaths,
  normalizeTargetPath,
} from "./standards.js";

const LEGACY_CANDIDATES_FILE = "standards.md";

export interface StandardsServiceOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

export interface CandidateInput {
  dir: string;
  /** 旧调用别名；与 sourceTaskId 一样只标注来源。 */
  taskId?: string;
  /** 仅标注来源，不要求任务存在。 */
  sourceTaskId?: string;
  /** 来源说明；省略时按 sourceTaskId 或“讨论”生成。 */
  source?: string;
  title: string;
  problem: string;
  evidence?: string;
  scope?: string;
  rule: string;
  verification?: string;
}

export interface ReviewInput {
  dir: string;
  /** 旧调用别名；与 sourceTaskId 一样只标注来源。 */
  taskId?: string;
  /** 仅标注来源，不参与项目级匹配。 */
  sourceTaskId?: string;
  decision: StandardsReviewDecision;
  reason: string;
  /** 采纳／混合时指向的正式规范；其他决定可为空。 */
  targets?: string[];
  /** 本次审阅覆盖的候选；省略表示全部当前候选。 */
  candidateIds?: string[];
}

export interface ApplyInput {
  dir: string;
  /** 旧调用别名；与 sourceTaskId 一样只用于来源标注。 */
  taskId?: string;
  /** 仅用于采纳正文的来源标注。 */
  sourceTaskId?: string;
  candidateId: string;
  target: string;
}

export interface PendingState {
  scope: "project" | "task";
  taskId: string | null;
  branch: string | null;
  hasCandidates: boolean;
  candidateIds: string[];
  candidateDigest: string | null;
  matchedReview: StandardsReview | null;
  latestReview: StandardsReview | null;
  needsReview: boolean;
  reason: "no_candidates" | "review_matched" | "review_required" | "candidate_changed" | "branch_changed";
}

export interface MigrationState {
  /** 尚未迁入项目候选文件的旧候选数。 */
  unmigrated: number;
  sources: { taskId: string; candidateIds: string[] }[];
}

export interface MigrateResult extends MigrationState {
  migrated: number;
  skipped: number;
}

interface TaskContext {
  taskId: string;
  branch: string | null;
  candidatesPath: string;
}

interface LegacyCandidateSet {
  taskId: string;
  candidates: StandardsCandidate[];
}

function taskContext(dir: string, taskId: string): TaskContext {
  const root = normalizeRoot(dir);
  let located;
  try {
    located = locateTaskDocument(root, taskId);
  } catch {
    throw new GuardError("unknown_task", `任务不存在: ${taskId}`);
  }
  return {
    taskId,
    branch: located.document.frontmatter.branch,
    candidatesPath: join(located.dir, LEGACY_CANDIDATES_FILE),
  };
}

function projectCandidatesPath(root: string): string {
  return safeJoin(root, `${STANDARDS_DIR}/${PROJECT_CANDIDATES_FILE}`);
}

function readCandidatesFile(path: string): { candidates: StandardsCandidate[]; text: string; sha256: string | null } {
  const version = readWithVersion(path);
  if (version === null) return { candidates: [], text: "", sha256: null };
  const text = version.data.toString("utf8");
  const parsed = parseCandidates(text);
  if (parsed.errors.length > 0) {
    throw new InfrastructureError("io_error", `候选文件结构错误（${path}）：${parsed.errors.join("；")}`);
  }
  return { candidates: parsed.candidates, text, sha256: version.sha256 };
}

function appendCandidates(text: string, blocks: string[]): string {
  if (blocks.length === 0) return text;
  const prefix = text.trim() === "" ? "# 规范候选\n\n" : `${text.replace(/\s*$/, "")}\n\n`;
  return `${prefix}${blocks.join("\n\n")}\n`;
}

/** 递归找任务目录中的旧候选文件；归档目录同样扫描。 */
function legacyCandidateFiles(root: string): string[] {
  const tasksRoot = join(root, ".knit", "tasks");
  const result: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === LEGACY_CANDIDATES_FILE) result.push(full);
    }
  };
  walk(tasksRoot);
  return result;
}

function legacyTaskId(taskDir: string): string {
  const taskFile = join(taskDir, "task.md");
  if (existsSync(taskFile)) {
    try {
      const document = parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile);
      return document.frontmatter.id;
    } catch {
      // 损坏的 task.md 不阻止列出／迁移候选；用目录名标注来源并保留可读性。
    }
  }
  return basename(taskDir);
}

function scanLegacyCandidates(root: string): LegacyCandidateSet[] {
  return legacyCandidateFiles(root).map((path) => {
    const { candidates } = readCandidatesFile(path);
    return { taskId: legacyTaskId(dirname(path)), candidates };
  });
}

export class StandardsService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(options: StandardsServiceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  }

  /** 机械清单：正式规范、索引引用、项目候选与迁移提示；--task 额外只读显示旧任务候选。 */
  async list(input: { dir: string; taskId?: string }): Promise<{
    standardsDigest: string;
    formal: { path: string; relativePath: string; title: string | null; digest: string; indexed: boolean }[];
    index: { path: string; referenced: boolean }[];
    candidates: StandardsCandidate[];
    candidateDigest: string | null;
    pending: PendingState;
    migration: MigrationState;
    task?: {
      taskId: string;
      candidates: StandardsCandidate[];
      candidateDigest: string | null;
      pending: PendingState;
    };
  }> {
    const root = normalizeRoot(input.dir);
    const indexed = new Set(indexedStandardPaths(root));
    const formal = formalStandardFiles(root).map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      title: file.title,
      digest: file.digest,
      // 索引自身即入口，不需要自引用。
      indexed: file.relativePath === STANDARDS_INDEX || indexed.has(file.relativePath),
    }));
    const project = readCandidatesFile(projectCandidatesPath(root));
    const legacy = scanLegacyCandidates(root);
    const projectIds = new Set(project.candidates.map((candidate) => candidate.candidateId));
    const unmigrated = legacy
      .map((entry) => ({
        taskId: entry.taskId,
        candidateIds: entry.candidates
          .map((candidate) => candidate.candidateId)
          .filter((candidateId) => !projectIds.has(candidateId)),
      }))
      .filter((entry) => entry.candidateIds.length > 0);
    const result: {
      standardsDigest: string;
      formal: typeof formal;
      index: { path: string; referenced: boolean }[];
      candidates: StandardsCandidate[];
      candidateDigest: string | null;
      pending: PendingState;
      migration: MigrationState;
      task?: {
        taskId: string;
        candidates: StandardsCandidate[];
        candidateDigest: string | null;
        pending: PendingState;
      };
    } = {
      standardsDigest: formalStandardsDigest(root),
      formal,
      index: formal.map((file) => ({ path: file.path, referenced: file.indexed })),
      candidates: project.candidates,
      candidateDigest: project.candidates.length === 0 ? null : candidateSetDigest(project.candidates),
      pending: await this.projectPendingState(root, project.candidates),
      migration: {
        unmigrated: unmigrated.reduce((count, entry) => count + entry.candidateIds.length, 0),
        sources: unmigrated,
      },
    };
    if (input.taskId !== undefined) {
      const context = taskContext(root, input.taskId);
      const legacyTask = readCandidatesFile(context.candidatesPath);
      result.task = {
        taskId: input.taskId,
        candidates: legacyTask.candidates,
        candidateDigest: legacyTask.candidates.length === 0 ? null : candidateSetDigest(legacyTask.candidates),
        pending: await this.legacyPendingState(context, legacyTask.candidates),
      };
    }
    return result;
  }

  /** 新增项目级候选；--task 只标注来源，不读写任务目录。 */
  async propose(input: CandidateInput): Promise<{
    sourceTaskId: string | null;
    candidate: StandardsCandidate;
    candidateDigest: string;
    file: string;
  }> {
    const root = normalizeRoot(input.dir);
    if (input.title.trim() === "" || input.problem.trim() === "" || input.rule.trim() === "") {
      throw new GuardError("invalid_candidate", "候选必须包含标题、问题与建议规则");
    }
    const sourceTaskId = input.sourceTaskId ?? input.taskId;
    const path = projectCandidatesPath(root);
    const lock = await this.locks.acquire({
      keys: [this.standardsLockKey(root)],
      action: "standards.propose",
    });
    try {
      const existing = readCandidatesFile(path);
      const used = new Set(existing.candidates.map((candidate) => candidate.candidateId));
      let candidateId = newCandidateId(this.randomHex);
      while (used.has(candidateId)) candidateId = newCandidateId(this.randomHex);
      const source = (input.source ?? (sourceTaskId === undefined ? "讨论" : `任务 ${sourceTaskId}`)).trim();
      const base = {
        candidateId,
        title: input.title.trim(),
        problem: input.problem.trim(),
        evidence: (input.evidence ?? "").trim(),
        scope: (input.scope ?? "").trim(),
        rule: input.rule.trim(),
        verification: (input.verification ?? "").trim(),
        source,
      };
      const candidate: StandardsCandidate = { ...base, digest: candidateDigestOf(base) };
      const next = appendCandidates(existing.text, [renderCandidate(candidate)]);
      atomicWrite({
        path,
        data: Buffer.from(next, "utf8"),
        expectedSha256: existing.sha256,
        mode: 0o644,
      });
      return {
        sourceTaskId: sourceTaskId ?? null,
        candidate,
        candidateDigest: candidate.digest,
        file: relative(root, path).split(sep).join("/"),
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 保存主 Agent 的审阅决定、理由与目标引用；项目级匹配不要求任务或分支一致。 */
  async review(input: ReviewInput): Promise<{ review: StandardsReview; pending: PendingState }> {
    const root = normalizeRoot(input.dir);
    const sourceTaskId = input.sourceTaskId ?? input.taskId;
    if (input.reason.trim() === "") throw new GuardError("review_reason_required", "审阅必须记录理由");
    const lock = await this.locks.acquire({
      keys: [this.standardsLockKey(root)],
      action: "standards.review",
    });
    try {
      const { candidates } = readCandidatesFile(projectCandidatesPath(root));
      if (candidates.length === 0) throw new GuardError("no_candidates", "当前项目没有规范候选");
      const selectedIds = input.candidateIds ?? candidates.map((candidate) => candidate.candidateId);
      const selected = selectedIds.map((id) => {
        const candidate = candidates.find((item) => item.candidateId === id);
        if (candidate === undefined) throw new GuardError("unknown_candidate", `候选不存在: ${id}`);
        return candidate;
      });
      const targets = (input.targets ?? []).map((target) => normalizeTargetPath(target));
      for (const target of targets) {
        if (!existsSync(join(root, target))) {
          throw new GuardError("unknown_target", `目标规范不存在: ${target}`);
        }
      }
      if ((input.decision === "applied" || input.decision === "mixed") && targets.length === 0) {
        throw new GuardError("target_required", `${input.decision} 必须给出至少一个目标规范`);
      }
      const review: StandardsReview = {
        reviewId: newReviewId(this.randomHex),
        ...(sourceTaskId === undefined ? {} : { sourceTaskId }),
        branch: currentBranch(root),
        candidateDigest: candidateSetDigest(selected),
        decision: input.decision,
        reason: input.reason.trim(),
        targets: [...new Set(targets)],
        candidateIds: selected.map((candidate) => candidate.candidateId),
        operationId: `std-review-${this.randomHex(6)}`,
        recordedAt: this.now().toISOString(),
      };
      await this.store.withTransaction(async () => {
        await this.store.standardsReviews.save(review);
        await this.store.operations.save({
          operationId: review.operationId,
          kind: "standards_review",
          state: "completed",
          reason: `${review.decision} ${review.candidateDigest}`,
          recordedAt: review.recordedAt,
        });
      });
      return { review, pending: await this.projectPendingState(root, candidates) };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * 采纳：按项目级匹配回执把候选规则机械追加到目标规范并补索引。
   * 正式规范摘要变化后返回受影响任务；检查资格由 run／check 层据此推导。
   */
  async apply(input: ApplyInput): Promise<{
    sourceTaskId: string | null;
    candidateId: string;
    target: string;
    applied: boolean;
    alreadyApplied: boolean;
    indexUpdated: boolean;
    standardsDigest: string;
    affectedTasks: string[];
  }> {
    const root = normalizeRoot(input.dir);
    const sourceTaskId = input.sourceTaskId ?? input.taskId;
    const target = normalizeTargetPath(input.target);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.standardsLockKey(root)]),
      action: "standards.apply",
    });
    try {
      const { candidates } = readCandidatesFile(projectCandidatesPath(root));
      const candidate = candidates.find((item) => item.candidateId === input.candidateId);
      if (candidate === undefined) throw new GuardError("unknown_candidate", `候选不存在: ${input.candidateId}`);
      const latest = await this.store.standardsReviews.latest(PROJECT_SCOPE);
      const matched =
        latest !== null &&
        latest.candidateDigest === candidateSetDigest(candidates) &&
        (latest.decision === "applied" || latest.decision === "mixed") &&
        latest.targets.includes(target);
      if (!matched) {
        throw new GuardError("review_required", "没有匹配当前候选摘要与目标的采纳回执");
      }
      // 目标及其父目录逐段核实未越出项目：拒绝父级／目标符号链接、绝对路径与 .. 逃逸（任务033）。
      const targetPath = safeJoin(root, target);
      const targetVersion = readWithVersion(targetPath);
      if (targetVersion === null) throw new GuardError("unknown_target", `目标规范不存在: ${target}`);
      const targetText = targetVersion.data.toString("utf8");
      const sourceLabel =
        (candidate.source ?? "").trim() !== ""
          ? (candidate.source ?? "").trim()
          : sourceTaskId === undefined
            ? "讨论"
            : `任务 ${sourceTaskId}`;
      const rule = renderCandidateRule(candidate, sourceLabel);
      // 已采纳判定按实际效果：正文含完整规则块（候选版本内容）且索引已链接，才幂等返回；
      // 只有来源行不算完整回执（旧候选同 ID 新版本、正文成功索引失败都可恢复）（任务038）。
      const targetContainsRule = targetText.includes(rule.trimEnd());
      const relativePath = target.slice(STANDARDS_DIR.length + 1);
      const indexedPaths = new Set(indexedStandardPaths(root));
      const indexLinked = indexedPaths.has(relativePath);
      if (targetContainsRule && indexLinked) {
        return {
          sourceTaskId: sourceTaskId ?? null,
          candidateId: candidate.candidateId,
          target,
          applied: false,
          alreadyApplied: true,
          indexUpdated: false,
          standardsDigest: formalStandardsDigest(root),
          affectedTasks: await this.affectedTasks(root),
        };
      }
      const targetHits = scanCredentials(rule);
      if (targetHits.length > 0) {
        throw new GuardError("credential_scan_hit", `正式规范命中常见凭据模式，已暂停写入: ${targetHits.map((hit) => `${hit.type}@行${hit.line}`).join(", ")}`);
      }
      const nextTarget = targetContainsRule
        ? targetText // 正文已有当前版本规则：只补索引，不重复正文。
        : `${targetText}${targetText.endsWith("\n") ? "\n" : "\n\n"}${rule}`;
      // 正文无变化时不原子重写同内容，避免无意义的版本推进。
      if (!targetContainsRule) {
        atomicWrite({
          path: targetPath,
          data: Buffer.from(nextTarget, "utf8"),
          expectedSha256: targetVersion.sha256,
          mode: 0o644,
        });
      }

      const indexed = indexedPaths;
      let indexUpdated = false;
      if (!indexed.has(relativePath)) {
        const indexPath = join(root, STANDARDS_DIR, STANDARDS_INDEX);
        const indexVersion = readWithVersion(indexPath);
        const indexText = indexVersion === null ? "# 规范索引\n" : indexVersion.data.toString("utf8");
        const link = `./${relativePath}`;
        const entry = `- [${basename(relativePath)}](${link}) —— ${candidate.title}（${sourceLabel} 采纳）\n`;
        const nextIndex = `${indexText.replace(/\s*$/, "")}\n\n${entry}`;
        atomicWrite({
          path: indexPath,
          data: Buffer.from(nextIndex, "utf8"),
          expectedSha256: indexVersion?.sha256 ?? null,
          mode: 0o644,
        });
        indexUpdated = true;
      }

      await this.store.operations.save({
        operationId: `std-apply-${this.randomHex(6)}`,
        kind: "standards_apply",
        state: "completed",
        reason: `${latest?.reviewId ?? "review"} ${target}`,
        recordedAt: this.now().toISOString(),
      });
      const standardsDigest = formalStandardsDigest(root);
      return {
        sourceTaskId: sourceTaskId ?? null,
        candidateId: candidate.candidateId,
        target,
        applied: true,
        alreadyApplied: false,
        indexUpdated,
        standardsDigest,
        affectedTasks: await this.affectedTasks(root, standardsDigest),
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 收尾／检查前的机械提示总是项目作用域；--task 额外只读返回旧任务视图。 */
  async pending(input: { dir: string; taskId?: string }): Promise<PendingState & { legacy?: PendingState }> {
    const root = normalizeRoot(input.dir);
    const project = readCandidatesFile(projectCandidatesPath(root));
    const state = await this.projectPendingState(root, project.candidates);
    if (input.taskId === undefined) return state;
    const context = taskContext(root, input.taskId);
    const legacy = readCandidatesFile(context.candidatesPath);
    return { ...state, legacy: await this.legacyPendingState(context, legacy.candidates) };
  }

  /** 把旧任务 standards.md 的候选幂等迁入项目候选文件；原文件不删除、不改写。 */
  async migrate(input: { dir: string }): Promise<MigrateResult> {
    const root = normalizeRoot(input.dir);
    const path = projectCandidatesPath(root);
    const lock = await this.locks.acquire({
      keys: [this.standardsLockKey(root)],
      action: "standards.migrate",
    });
    try {
      const existing = readCandidatesFile(path);
      const known = new Set(existing.candidates.map((candidate) => candidate.candidateId));
      const blocks: string[] = [];
      const sources: { taskId: string; candidateIds: string[] }[] = [];
      let migrated = 0;
      let skipped = 0;
      for (const entry of scanLegacyCandidates(root)) {
        const candidateIds: string[] = [];
        for (const candidate of entry.candidates) {
          if (known.has(candidate.candidateId)) {
            skipped += 1;
            continue;
          }
          const source = (candidate.source ?? "").trim() === "" ? `任务 ${entry.taskId}` : (candidate.source ?? "").trim();
          const withSource: StandardsCandidate = { ...candidate, source };
          blocks.push(renderCandidate(withSource));
          known.add(candidate.candidateId);
          candidateIds.push(candidate.candidateId);
          migrated += 1;
        }
        if (candidateIds.length > 0) sources.push({ taskId: entry.taskId, candidateIds });
      }
      if (blocks.length > 0) {
        atomicWrite({
          path,
          data: Buffer.from(appendCandidates(existing.text, blocks), "utf8"),
          expectedSha256: existing.sha256,
          mode: 0o644,
        });
      }
      return {
        migrated,
        skipped,
        unmigrated: 0,
        sources,
      };
    } finally {
      this.locks.release(lock);
    }
  }

  private async projectPendingState(root: string, candidates: StandardsCandidate[]): Promise<PendingState> {
    const latest = await this.store.standardsReviews.latest(PROJECT_SCOPE);
    const branch = currentBranch(root);
    if (candidates.length === 0) {
      return {
        scope: "project",
        taskId: null,
        branch,
        hasCandidates: false,
        candidateIds: [],
        candidateDigest: null,
        matchedReview: null,
        latestReview: latest,
        needsReview: false,
        reason: "no_candidates",
      };
    }
    const candidateDigest = candidateSetDigest(candidates);
    const matched = latest !== null && latest.candidateDigest === candidateDigest;
    return {
      scope: "project",
      taskId: null,
      branch,
      hasCandidates: true,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      candidateDigest,
      matchedReview: matched ? latest : null,
      latestReview: latest,
      needsReview: !matched,
      reason: matched ? "review_matched" : latest === null ? "review_required" : "candidate_changed",
    };
  }

  /** 旧任务视图：仍按任务与分支匹配旧回执，仅供 list／pending --task 兼容读取。 */
  private async legacyPendingState(context: TaskContext, candidates: StandardsCandidate[]): Promise<PendingState> {
    const latest = await this.store.standardsReviews.latest(context.taskId);
    if (candidates.length === 0) {
      return {
        scope: "task",
        taskId: context.taskId,
        branch: context.branch,
        hasCandidates: false,
        candidateIds: [],
        candidateDigest: null,
        matchedReview: null,
        latestReview: latest,
        needsReview: false,
        reason: "no_candidates",
      };
    }
    const candidateDigest = candidateSetDigest(candidates);
    const matched =
      latest !== null && latest.branch === context.branch && latest.candidateDigest === candidateDigest;
    const branchChanged = latest !== null && latest.candidateDigest === candidateDigest && latest.branch !== context.branch;
    return {
      scope: "task",
      taskId: context.taskId,
      branch: context.branch,
      hasCandidates: true,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      candidateDigest,
      matchedReview: matched ? latest : null,
      latestReview: latest,
      needsReview: !matched,
      reason: matched
        ? "review_matched"
        : branchChanged
          ? "branch_changed"
          : latest === null
            ? "review_required"
            : "candidate_changed",
    };
  }

  /** 冻结正式规范摘要与当前摘要不一致的任务；用于提示检查失效。 */
  private async affectedTasks(root: string, digest = formalStandardsDigest(root)): Promise<string[]> {
    const bindings: TaskBinding[] = await this.store.bindings.list();
    return bindings
      .filter(
        (binding) =>
          binding.repoRoot === root &&
          binding.confirmedStandardsDigest !== null &&
          binding.confirmedStandardsDigest !== digest,
      )
      .map((binding) => binding.taskId);
  }

  private standardsLockKey(root: string) {
    return { scope: "task" as const, rawKey: `${root}::standards` };
  }
}
