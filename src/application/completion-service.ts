/**
 * 业务完成资格与凭据（DESIGN §3.8、STATES §11）。
 * 完成不要求 Git 提交；凭据只冻结完成时的输入、成果与验证来源。
 */
import type { CompletionFile } from "../contracts/completion.js";
import type { TaskBinding } from "../contracts/metadata.js";
import {
  inputsDigestOf,
  verificationModeOf,
  type VerificationMode,
} from "../contracts/task-inputs.js";
import type { CheckQualification } from "../domain/check.js";
import {
  checkerChangedPathsOf,
  completionDecision,
  type CompletionDecision,
  type ImplementEvidence,
} from "../domain/completion.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { validateCheckEvidence } from "./check-validation.js";
import { currentEntry, type ScopeEntry } from "./scope.js";
import type { TaskDocument } from "./task-document.js";
import { loadScope, scopeEntriesCurrent } from "./scope.js";
import { readIntact } from "./guard-error.js";
import { isCredentialIntegrityError } from "../infrastructure/credential-seal.js";

export interface CompletionAssessInput {
  root: string;
  /** 任务正文与成果文件所在执行目录（worktree 路由）；缺省同 root。 */
  executionDir?: string;
  taskId: string;
  document: TaskDocument;
  raw: Buffer;
  binding: TaskBinding;
  /** 存在子任务的父任务：总体验收不受空 scope 守卫约束。 */
  parentTask?: boolean;
  /** 用户显式声明无产物（--no-artifacts）的原因。 */
  noArtifactsReason?: string | null;
}

export class CompletionService {
  private readonly store: MetadataStore;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(options: { store: MetadataStore; now?: () => Date; randomHex?: (bytes: number) => string }) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? (() => "000000000000");
  }

  /** 成果是否为空：累积 scope 与主会话实施记录都没有路径（审计 F4）。 */
  scopeEmpty(root: string, taskId: string): boolean {
    const runs = new RunStore(normalizeRoot(root));
    const scope = loadScope(runs, taskId, this.now().toISOString());
    return scope.entries.length === 0 && (readIntact(() => runs.readImplementation(taskId))?.entries.length ?? 0) === 0;
  }

  /** 按当前任务事实评估完成资格；不写文件。 */
  async assess(input: CompletionAssessInput): Promise<CompletionDecision> {
    const root = normalizeRoot(input.root);
    const executionDir = normalizeRoot(input.executionDir ?? input.root);
    const runs = new RunStore(root);
    const scope = loadScope(runs, input.taskId, this.now().toISOString());
    const verification = verificationModeOf(input.document.frontmatter);
    const currentInputsDigest = inputsDigestOf(input.raw.toString("utf8"));
    let checkQualification: CheckQualification = "missing";
    let checkRunId: string | null = null;
    let checkerChangedPaths: string[] = [];

    if (verification === "independent") {
      checkRunId = input.binding.lastCheckRunId;
      if (checkRunId !== null) {
        try {
          const check = await validateCheckEvidence({
            root,
            executionDir,
            store: this.store,
            taskId: input.taskId,
            binding: input.binding,
            branch: input.document.frontmatter.branch,
            now: this.now,
            randomHex: this.randomHex,
          });
          checkQualification = "valid";
          checkerChangedPaths = checkerChangedPathsOf(check);
        } catch (error) {
          // 检查凭据完整性失败不是“过期”：按 credential_tampered／credential_unsigned 拒绝，不当作有效凭据。
          const reason = integrityReasonOf(error);
          if (reason !== null) return { allowed: false, reason };
          checkQualification = "stale";
        }
      }
    }

    const lastImplement: ImplementEvidence | null = input.binding.lastImplement ?? null;
    let implementation;
    try {
      implementation = runs.readImplementation(input.taskId);
    } catch (error) {
      const reason = integrityReasonOf(error);
      if (reason !== null) return { allowed: false, reason };
      throw error;
    }
    return completionDecision({
      status: input.document.frontmatter.status,
      stage: input.document.frontmatter.stage,
      outcome: input.document.frontmatter.outcome,
      pendingKind: input.binding.pendingDraft?.kind ?? null,
      verification,
      confirmedInputsDigest: input.binding.confirmedInputsDigest,
      currentInputsDigest,
      currentScopeDigest: scope.digest,
      scopeCurrent: scopeEntriesCurrent(executionDir, scope.entries),
      lastImplement,
      implementationRecord:
        implementation === null
          ? null
          : {
              inputsDigest: implementation.inputsDigest,
              entriesCurrent: scopeEntriesCurrent(root, implementation.entries as ScopeEntry[]),
            },
      checkQualification,
      checkRunId,
      checkerChangedPaths,
      // 空成果：累积 scope 与主会话实施记录都没有路径（审计 F4）。
      scopeEmpty: scope.entries.length === 0 && (implementation?.entries.length ?? 0) === 0,
      parentTask: input.parentTask === true,
      noArtifactsReason: input.noArtifactsReason ?? null,
    });
  }

  /** 把已批准的完成资格写成凭据；调用方负责在任务锁内写 task.md。 */
  record(input: {
    root: string;
    taskId: string;
    document: TaskDocument;
    raw: Buffer;
    decision: Extract<CompletionDecision, { allowed: true }>;
    reason?: string | null;
  }): CompletionFile {
    const root = normalizeRoot(input.root);
    const runs = new RunStore(root);
    const scope = loadScope(runs, input.taskId, this.now().toISOString());
    const verification: VerificationMode = input.decision.mode;
    // 完成守卫已拒绝带检查者修复的 independent 检查；这里照实记录所引用检查的修复路径，供“验证”行标注。
    const checkerChangedPaths = input.decision.checkRunId === null
      ? []
      : checkerChangedPathsOf(readIntact(() => runs.readCheck(input.decision.checkRunId!)));
    const completion: CompletionFile = {
      schemaVersion: 1,
      taskId: input.taskId,
      verification,
      inputsDigest: inputsDigestOf(input.raw.toString("utf8")),
      scopeDigest: scope.digest,
      ...(scope.recoveries === undefined ? {} : { recoveryCommits: scope.recoveries.map(item => item.commit) }),
      implementedBy: input.decision.implementedBy,
      implementRunId: input.decision.implementRunId,
      checkRunId: input.decision.checkRunId,
      ...(checkerChangedPaths.length > 0 ? { checkerChangedPaths } : {}),
      unverified: input.decision.unverified,
      forced: input.decision.implementedBy === "forced",
      forcedReason: input.decision.implementedBy === "forced" ? (input.decision.forcedReason ?? null) : null,
      ...(input.decision.artifacts === "none" && (input.decision.noArtifactsReason ?? "") !== ""
        ? { artifacts: "none" as const, noArtifactsReason: input.decision.noArtifactsReason ?? "" }
        : {}),
      reason: input.reason ?? null,
      completedAt: this.now().toISOString(),
    };
    runs.writeCompletion(input.taskId, completion);
    return completion;
  }

  read(root: string, taskId: string): CompletionFile | null {
    return new RunStore(root).readCompletion(taskId);
  }

  /**
   * 交付前核对已落盘完成凭据：输入／成果必须仍是完成时的版本。
   * 返回具体原因，不把过期凭据当作当前完成。
   */
  async validate(input: {
    root: string;
    taskId: string;
    document: TaskDocument;
    raw: Buffer;
    binding: TaskBinding;
  }): Promise<{ valid: true; completion: CompletionFile } | { valid: false; reason: string }> {
    const root = normalizeRoot(input.root);
    let completion: CompletionFile | null;
    try {
      completion = this.read(root, input.taskId);
    } catch (error) {
      // 篡改或旧格式缺签名的完成凭据不是有效凭据：按原因拒绝，旧凭据需重新 task close 重建。
      const reason = integrityReasonOf(error);
      if (reason !== null) return { valid: false, reason };
      throw error;
    }
    if (completion === null) return { valid: false, reason: "completion_missing" };
    if (completion.taskId !== input.taskId) return { valid: false, reason: "completion_task_mismatch" };
    const runs = new RunStore(root);
    const scope = loadScope(runs, input.taskId, this.now().toISOString());
    if (completion.inputsDigest !== inputsDigestOf(input.raw.toString("utf8"))) {
      return { valid: false, reason: "completion_inputs_changed" };
    }
    if (completion.scopeDigest !== scope.digest) return { valid: false, reason: "completion_scope_changed" };
    if (!scopeEntriesCurrent(root, scope.entries)) return { valid: false, reason: "completion_scope_changed" };
    if (completion.forced === true) {
      if (completion.forcedReason === null || (completion.forcedReason ?? "").trim() === "") {
        return { valid: false, reason: "completion_forced_reason_missing" };
      }
      return { valid: true, completion };
    }
    if (completion.verification === "independent") {
      if (completion.checkRunId === null) return { valid: false, reason: "completion_check_missing" };
      let check;
      try {
        check = runs.readCheck(completion.checkRunId);
      } catch (error) {
        const reason = integrityReasonOf(error);
        if (reason !== null) return { valid: false, reason };
        throw error;
      }
      if (check === null || check.verdict !== "pass") return { valid: false, reason: "completion_check_missing" };
      try {
        await validateCheckEvidence({
          root,
          store: this.store,
          taskId: input.taskId,
          binding: input.binding,
          branch: input.document.frontmatter.branch,
          now: this.now,
          randomHex: this.randomHex,
        });
      } catch (error) {
        const reason = integrityReasonOf(error);
        return { valid: false, reason: reason ?? "completion_check_stale" };
      }
    }
    if (completion.verification === "self" && completion.implementedBy === "record") {
      let implementation;
      try {
        implementation = runs.readImplementation(input.taskId);
      } catch (error) {
        const reason = integrityReasonOf(error);
        if (reason !== null) return { valid: false, reason };
        throw error;
      }
      if (implementation === null) return { valid: false, reason: "completion_implementation_missing" };
      if (implementation.inputsDigest !== inputsDigestOf(input.raw.toString("utf8"))) {
        return { valid: false, reason: "completion_inputs_changed" };
      }
      if (!scopeEntriesCurrent(root, implementation.entries as ScopeEntry[])) {
        return { valid: false, reason: "completion_scope_changed" };
      }
      return { valid: true, completion };
    }
    if (completion.verification === "self" && completion.implementRunId === null) {
      return { valid: false, reason: "completion_implementation_missing" };
    }
    return { valid: true, completion };
  }
}

/** 凭据完整性失败原因：签名校验（infrastructure）或已转为 GuardError 的同名原因；其它错误返回 null。 */
function integrityReasonOf(error: unknown): "credential_tampered" | "credential_unsigned" | null {
  if (isCredentialIntegrityError(error)) return error.guardReason;
  const guard = (error as { details?: { guardReason?: unknown } } | null)?.details?.guardReason;
  return guard === "credential_tampered" || guard === "credential_unsigned" ? guard : null;
}
