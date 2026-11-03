/**
 * 业务完成资格（DESIGN §3.8、STATES §11）。
 * 只回答“当前事实能否按任务要求标记完成”，不读文件、不写记录、不要求 Git 提交。
 */
import type { VerificationMode } from "../contracts/task-inputs.js";
import type { CheckQualification } from "./check.js";

export type CompletionGuardReason =
  | "task_not_open"
  | "pending_draft_exists"
  | "inputs_not_confirmed"
  | "inputs_changed"
  | "scope_changed"
  | "phase_mismatch"
  | "implementation_missing"
  | "implementation_stale"
  | "check_missing"
  | "check_not_valid";

export interface ImplementEvidence {
  runId: string;
  inputsDigest: string;
  scopeDigest: string;
}

export interface CompletionFacts {
  status: "open" | "closed";
  phase: "discuss" | "implement" | "check" | "deliver";
  outcome: "completed" | "cancelled" | "superseded" | null;
  pendingKind: "clarify" | "change" | null;
  verification: VerificationMode;
  /** ready 时冻结的输入摘要；未 ready 为 null。 */
  confirmedInputsDigest: string | null;
  currentInputsDigest: string;
  currentScopeDigest: string;
  /** 已记录 scope 路径的当前指纹是否仍一致。 */
  scopeCurrent: boolean;
  lastImplement: ImplementEvidence | null;
  /** 正式检查资格；none／self 可能为 missing。 */
  checkQualification: CheckQualification;
  checkRunId: string | null;
}

export interface CompletionApproval {
  allowed: true;
  mode: VerificationMode;
  implementRunId: string | null;
  checkRunId: string | null;
  unverified: string[];
}

export type CompletionDecision = CompletionApproval | ({ allowed: false; reason: CompletionGuardReason });

/**
 * 规则：
 * - none：用户明确选择不验证；不要求 ready、实施或检查，但不能有未应用草案。
 * - self：实施已获准且其冻结输入／成果仍与当前一致，阶段已到 deliver；不要求独立检查。
 * - independent：最新正式检查当前有效且 pass；检查资格已覆盖目标、输入、规范与 scope。
 * 以上模式都不要求已有 Git 提交、交付回执或归档。
 */
export function completionDecision(facts: CompletionFacts): CompletionDecision {
  if (facts.status !== "open" || facts.outcome !== null) return { allowed: false, reason: "task_not_open" };
  if (facts.pendingKind !== null) return { allowed: false, reason: "pending_draft_exists" };

  if (facts.verification === "none") {
    return {
      allowed: true,
      mode: "none",
      implementRunId: facts.lastImplement?.runId ?? null,
      checkRunId: null,
      unverified: ["用户选择 verification=none：未执行独立验证"],
    };
  }

  if (facts.confirmedInputsDigest === null) return { allowed: false, reason: "inputs_not_confirmed" };
  if (facts.confirmedInputsDigest !== facts.currentInputsDigest) return { allowed: false, reason: "inputs_changed" };
  if (!facts.scopeCurrent) return { allowed: false, reason: "scope_changed" };

  if (facts.verification === "self") {
    if (facts.phase !== "deliver") return { allowed: false, reason: "phase_mismatch" };
    if (facts.lastImplement === null) return { allowed: false, reason: "implementation_missing" };
    if (
      facts.lastImplement.inputsDigest !== facts.currentInputsDigest ||
      facts.lastImplement.scopeDigest !== facts.currentScopeDigest
    ) {
      return { allowed: false, reason: "implementation_stale" };
    }
    return {
      allowed: true,
      mode: "self",
      implementRunId: facts.lastImplement.runId,
      checkRunId: null,
      unverified: [],
    };
  }

  if (facts.checkQualification === "missing") return { allowed: false, reason: "check_missing" };
  if (facts.checkQualification !== "valid") return { allowed: false, reason: "check_not_valid" };
  if (facts.checkRunId === null) return { allowed: false, reason: "check_missing" };
  return {
    allowed: true,
    mode: "independent",
    implementRunId: facts.lastImplement?.runId ?? null,
    checkRunId: facts.checkRunId,
    unverified: [],
  };
}
