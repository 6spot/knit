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
  completionDecision,
  type CompletionDecision,
  type ImplementEvidence,
} from "../domain/completion.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { validateCheckEvidence } from "./check-validation.js";
import type { TaskDocument } from "./task-document.js";
import { loadScope, scopeEntriesCurrent } from "./scope.js";

export interface CompletionAssessInput {
  root: string;
  taskId: string;
  document: TaskDocument;
  raw: Buffer;
  binding: TaskBinding;
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

  /** 按当前任务事实评估完成资格；不写文件。 */
  async assess(input: CompletionAssessInput): Promise<CompletionDecision> {
    const root = normalizeRoot(input.root);
    const runs = new RunStore(root);
    const scope = loadScope(runs, input.taskId, this.now().toISOString());
    const verification = verificationModeOf(input.document.frontmatter);
    const currentInputsDigest = inputsDigestOf(input.raw.toString("utf8"));
    let checkQualification: CheckQualification = "missing";
    let checkRunId: string | null = null;

    if (verification === "independent") {
      checkRunId = input.binding.lastCheckRunId;
      if (checkRunId !== null) {
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
          checkQualification = "valid";
        } catch {
          checkQualification = "stale";
        }
      }
    }

    const lastImplement: ImplementEvidence | null = input.binding.lastImplement ?? null;
    return completionDecision({
      status: input.document.frontmatter.status,
      phase: input.document.frontmatter.phase,
      outcome: input.document.frontmatter.outcome,
      pendingKind: input.binding.pendingDraft?.kind ?? null,
      verification,
      confirmedInputsDigest: input.binding.confirmedInputsDigest,
      currentInputsDigest,
      currentScopeDigest: scope.digest,
      scopeCurrent: scopeEntriesCurrent(root, scope.entries),
      lastImplement,
      checkQualification,
      checkRunId,
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
    const completion: CompletionFile = {
      schemaVersion: 1,
      taskId: input.taskId,
      verification,
      inputsDigest: inputsDigestOf(input.raw.toString("utf8")),
      scopeDigest: scope.digest,
      implementRunId: input.decision.implementRunId,
      checkRunId: input.decision.checkRunId,
      unverified: input.decision.unverified,
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
    const completion = this.read(root, input.taskId);
    if (completion === null) return { valid: false, reason: "completion_missing" };
    if (completion.taskId !== input.taskId) return { valid: false, reason: "completion_task_mismatch" };
    const runs = new RunStore(root);
    const scope = loadScope(runs, input.taskId, this.now().toISOString());
    if (completion.inputsDigest !== inputsDigestOf(input.raw.toString("utf8"))) {
      return { valid: false, reason: "completion_inputs_changed" };
    }
    if (completion.scopeDigest !== scope.digest) return { valid: false, reason: "completion_scope_changed" };
    if (!scopeEntriesCurrent(root, scope.entries)) return { valid: false, reason: "completion_scope_changed" };
    if (completion.verification === "independent") {
      if (completion.checkRunId === null) return { valid: false, reason: "completion_check_missing" };
      const check = runs.readCheck(completion.checkRunId);
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
      } catch {
        return { valid: false, reason: "completion_check_stale" };
      }
    }
    if (completion.verification === "self" && completion.implementRunId === null) {
      return { valid: false, reason: "completion_implementation_missing" };
    }
    return { valid: true, completion };
  }
}
