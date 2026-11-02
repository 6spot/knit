/**
 * 规范演进用例：候选、机械提示、审阅回执与采纳（DESIGN.md 第8.2节、STATES.md 第9节）。
 * 语义判断由主 Agent 完成；这里只核对候选摘要、分支、回执与目标版本。
 * 候选只作背景，不自动成为完成条件；采纳才改变正式规范摘要。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { TaskBinding } from "../contracts/metadata.js";
import {
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
import { sha256Text } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { GuardError } from "./guard-error.js";
import { scanCredentials, type CredentialHit } from "../contracts/credentials.js";
import { locateTaskDocument } from "./task-service.js";
import {
  STANDARDS_DIR,
  STANDARDS_INDEX,
  formalStandardFiles,
  formalStandardsDigest,
  indexedStandardPaths,
  normalizeTargetPath,
} from "./standards.js";

const CANDIDATES_FILE = "standards.md";

export interface StandardsServiceOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

export interface CandidateInput {
  dir: string;
  taskId: string;
  title: string;
  problem: string;
  evidence?: string;
  scope?: string;
  rule: string;
  verification?: string;
}

export interface ReviewInput {
  dir: string;
  taskId: string;
  decision: StandardsReviewDecision;
  reason: string;
  /** 采纳／混合时指向的正式规范；其他决定可为空。 */
  targets?: string[];
  /** 本次审阅覆盖的候选；省略表示全部当前候选。 */
  candidateIds?: string[];
}

export interface ApplyInput {
  dir: string;
  taskId: string;
  candidateId: string;
  target: string;
}

export interface PendingState {
  taskId: string;
  branch: string | null;
  hasCandidates: boolean;
  candidateIds: string[];
  candidateDigest: string | null;
  matchedReview: StandardsReview | null;
  latestReview: StandardsReview | null;
  needsReview: boolean;
  reason: "no_candidates" | "review_matched" | "review_required" | "candidate_changed" | "branch_changed";
}

interface TaskContext {
  root: string;
  taskId: string;
  dir: string;
  taskDir: string;
  branch: string | null;
  archived: boolean;
  candidatesPath: string;
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
    root,
    taskId,
    dir: located.dir,
    taskDir: located.dir,
    branch: located.document.frontmatter.branch,
    archived: located.archived,
    candidatesPath: join(located.dir, CANDIDATES_FILE),
  };
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

  /** 机械清单：正式规范、索引引用、任务候选与最近回执。 */
  async list(input: { dir: string; taskId?: string }): Promise<{
    standardsDigest: string;
    formal: { path: string; relativePath: string; title: string | null; digest: string; indexed: boolean }[];
    index: { path: string; referenced: boolean }[];
    task?: { taskId: string; candidates: StandardsCandidate[]; candidateDigest: string | null; pending: PendingState };
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
    const result: {
      standardsDigest: string;
      formal: typeof formal;
      index: { path: string; referenced: boolean }[];
      task?: { taskId: string; candidates: StandardsCandidate[]; candidateDigest: string | null; pending: PendingState };
    } = {
      standardsDigest: formalStandardsDigest(root),
      formal,
      index: formal.map((file) => ({ path: file.path, referenced: file.indexed })),
    };
    if (input.taskId !== undefined) {
      const context = taskContext(root, input.taskId);
      const { candidates } = readCandidatesFile(context.candidatesPath);
      result.task = {
        taskId: input.taskId,
        candidates,
        candidateDigest: candidates.length === 0 ? null : candidateSetDigest(candidates),
        pending: await this.pendingState(context, candidates),
      };
    }
    return result;
  }

  /** 新增候选：写入任务辅助资料 standards.md，不改变正式规范与输入摘要。 */
  async propose(input: CandidateInput): Promise<{
    taskId: string;
    candidate: StandardsCandidate;
    candidateDigest: string;
    file: string;
  }> {
    const context = taskContext(input.dir, input.taskId);
    if (context.archived) throw new GuardError("task_archived", `任务已归档: ${input.taskId}`);
    if (input.title.trim() === "" || input.problem.trim() === "" || input.rule.trim() === "") {
      throw new GuardError("invalid_candidate", "候选必须包含标题、问题与建议规则");
    }
    const lock = await this.locks.acquire({
      keys: [this.taskLockKey(context.root, input.taskId)],
      action: "standards.propose",
    });
    try {
      const existing = readCandidatesFile(context.candidatesPath);
      const used = new Set(existing.candidates.map((candidate) => candidate.candidateId));
      let candidateId = newCandidateId(this.randomHex);
      while (used.has(candidateId)) candidateId = newCandidateId(this.randomHex);
      const base = {
        candidateId,
        title: input.title.trim(),
        problem: input.problem.trim(),
        evidence: (input.evidence ?? "").trim(),
        scope: (input.scope ?? "").trim(),
        rule: input.rule.trim(),
        verification: (input.verification ?? "").trim(),
      };
      const candidate: StandardsCandidate = { ...base, digest: candidateDigestOf(base) };
      const block = renderCandidate(candidate);
      const prefix = existing.text === "" ? "# 规范候选\n\n" : `${existing.text.replace(/\s*$/, "")}\n\n`;
      const next = `${prefix}${block}\n`;
      atomicWrite({
        path: context.candidatesPath,
        data: Buffer.from(next, "utf8"),
        expectedSha256: existing.sha256,
        mode: 0o644,
      });
      return {
        taskId: input.taskId,
        candidate,
        candidateDigest: candidate.digest,
        file: relative(context.root, context.candidatesPath).split(sep).join("/"),
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 保存主 Agent 的审阅决定、理由与目标引用；语义判断不在此处。 */
  async review(input: ReviewInput): Promise<{ review: StandardsReview; pending: PendingState }> {
    const context = taskContext(input.dir, input.taskId);
    if (context.archived) throw new GuardError("task_archived", `任务已归档: ${input.taskId}`);
    if (input.reason.trim() === "") throw new GuardError("review_reason_required", "审阅必须记录理由");
    const { candidates } = readCandidatesFile(context.candidatesPath);
    if (candidates.length === 0) throw new GuardError("no_candidates", "当前任务没有规范候选");
    const selectedIds = input.candidateIds ?? candidates.map((candidate) => candidate.candidateId);
    const selected = selectedIds.map((id) => {
      const candidate = candidates.find((item) => item.candidateId === id);
      if (candidate === undefined) throw new GuardError("unknown_candidate", `候选不存在: ${id}`);
      return candidate;
    });
    const targets = (input.targets ?? []).map((target) => normalizeTargetPath(target));
    for (const target of targets) {
      if (!existsSync(join(context.root, target))) {
        throw new GuardError("unknown_target", `目标规范不存在: ${target}`);
      }
    }
    if ((input.decision === "applied" || input.decision === "mixed") && targets.length === 0) {
      throw new GuardError("target_required", `${input.decision} 必须给出至少一个目标规范`);
    }
    const review: StandardsReview = {
      reviewId: newReviewId(this.randomHex),
      taskId: input.taskId,
      branch: context.branch,
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
    return { review, pending: await this.pendingState(context, candidates) };
  }

  /**
   * 采纳：按匹配回执把候选规则机械追加到目标规范并补索引。
   * 正式规范摘要变化后返回受影响任务；检查资格由 run／check 层据此推导。
   */
  async apply(input: ApplyInput): Promise<{
    taskId: string;
    candidateId: string;
    target: string;
    applied: boolean;
    alreadyApplied: boolean;
    indexUpdated: boolean;
    standardsDigest: string;
    affectedTasks: string[];
  }> {
    const context = taskContext(input.dir, input.taskId);
    if (context.archived) throw new GuardError("task_archived", `任务已归档: ${input.taskId}`);
    const target = normalizeTargetPath(input.target);
    const lock = await this.locks.acquire({
      keys: orderKeys([
        { scope: "project", rawKey: context.root },
        this.taskLockKey(context.root, input.taskId),
      ]),
      action: "standards.apply",
    });
    try {
      const { candidates } = readCandidatesFile(context.candidatesPath);
      const candidate = candidates.find((item) => item.candidateId === input.candidateId);
      if (candidate === undefined) throw new GuardError("unknown_candidate", `候选不存在: ${input.candidateId}`);
      const latest = await this.store.standardsReviews.latest(input.taskId);
      const matched =
        latest !== null &&
        latest.branch === context.branch &&
        latest.candidateDigest === candidateSetDigest(candidates) &&
        (latest.decision === "applied" || latest.decision === "mixed") &&
        latest.targets.includes(target);
      if (!matched) {
        throw new GuardError("review_required", "没有匹配当前候选摘要、分支与目标的采纳回执");
      }
      // 目标及其父目录逐段核实未越出项目：拒绝父级／目标符号链接、绝对路径与 .. 逃逸（任务033）。
      const targetPath = safeJoin(context.root, target);
      const targetVersion = readWithVersion(targetPath);
      if (targetVersion === null) throw new GuardError("unknown_target", `目标规范不存在: ${target}`);
      const targetText = targetVersion.data.toString("utf8");
      const rule = renderCandidateRule(candidate, input.taskId);
      // 已采纳判定按实际效果：正文含完整规则块（候选版本内容）且索引已链接，才幂等返回；
      // 只有来源行不算完整回执（旧候选同 ID 新版本、正文成功索引失败都可恢复）（任务038）。
      const targetContainsRule = targetText.includes(rule.trimEnd());
      const relativePath = target.slice(STANDARDS_DIR.length + 1);
      const indexedPaths = new Set(indexedStandardPaths(context.root));
      const indexLinked = indexedPaths.has(relativePath);
      if (targetContainsRule && indexLinked) {
        return {
          taskId: input.taskId,
          candidateId: candidate.candidateId,
          target,
          applied: false,
          alreadyApplied: true,
          indexUpdated: false,
          standardsDigest: formalStandardsDigest(context.root),
          affectedTasks: await this.affectedTasks(context.root),
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
        const indexPath = join(context.root, STANDARDS_DIR, STANDARDS_INDEX);
        const indexVersion = readWithVersion(indexPath);
        const indexText = indexVersion === null ? "# 规范索引\n" : indexVersion.data.toString("utf8");
        const link = `./${relativePath}`;
        const entry = `- [${basename(relativePath)}](${link}) —— ${candidate.title}（任务 ${input.taskId} 采纳）\n`;
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
      const standardsDigest = formalStandardsDigest(context.root);
      return {
        taskId: input.taskId,
        candidateId: candidate.candidateId,
        target,
        applied: true,
        alreadyApplied: false,
        indexUpdated,
        standardsDigest,
        affectedTasks: await this.affectedTasks(context.root, standardsDigest),
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 指定候选的完整规则块；gate 按实际效果核对采纳（任务038）。候选不存在返回 null。 */
  async candidateRuleText(input: { dir: string; taskId: string; candidateId: string }): Promise<string | null> {
    const context = taskContext(input.dir, input.taskId);
    const { candidates } = readCandidatesFile(context.candidatesPath);
    const candidate = candidates.find((item) => item.candidateId === input.candidateId);
    return candidate === undefined ? null : renderCandidateRule(candidate, input.taskId).trimEnd();
  }

  /** 收尾／检查前的机械提示：有候选且无匹配回执则要求处理。 */
  async pending(input: { dir: string; taskId: string }): Promise<PendingState> {
    const context = taskContext(input.dir, input.taskId);
    const { candidates } = readCandidatesFile(context.candidatesPath);
    return this.pendingState(context, candidates);
  }

  private async pendingState(context: TaskContext, candidates: StandardsCandidate[]): Promise<PendingState> {
    const latest = await this.store.standardsReviews.latest(context.taskId);
    if (candidates.length === 0) {
      return {
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
    if (matched) {
      return {
        taskId: context.taskId,
        branch: context.branch,
        hasCandidates: true,
        candidateIds: candidates.map((candidate) => candidate.candidateId),
        candidateDigest,
        matchedReview: latest,
        latestReview: latest,
        needsReview: false,
        reason: "review_matched",
      };
    }
    const branchChanged = latest !== null && latest.candidateDigest === candidateDigest && latest.branch !== context.branch;
    return {
      taskId: context.taskId,
      branch: context.branch,
      hasCandidates: true,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      candidateDigest,
      matchedReview: null,
      latestReview: latest,
      needsReview: true,
      reason: branchChanged ? "branch_changed" : latest === null ? "review_required" : "candidate_changed",
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

  private taskLockKey(root: string, taskId: string) {
    return { scope: "task" as const, rawKey: `${root}::${taskId}` };
  }
}
