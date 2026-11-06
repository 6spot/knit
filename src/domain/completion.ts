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

/** 主会话实施记录：没有 run，只有记录时的输入摘要与成果指纹是否仍成立。 */
export interface ImplementationRecordEvidence {
  inputsDigest: string;
  entriesCurrent: boolean;
}

export interface CompletionFacts {
  status: "open" | "closed";
  /** 任务阶段：内置锚点 start／deliver 或流程配置里的阶段 id。 */
  stage: string;
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
  /** 主会话实施记录；缺省为 null（只有 run 路径）。 */
  implementationRecord: ImplementationRecordEvidence | null;
  /** 正式检查资格；none／self 可能为 missing。 */
  checkQualification: CheckQualification;
  checkRunId: string | null;
}

export interface CompletionApproval {
  allowed: true;
  mode: VerificationMode;
  /** 实施事实来源；forced 表示用户明确跳过证据核对。 */
  implementedBy: "run" | "record" | "forced";
  implementRunId: string | null;
  checkRunId: string | null;
  unverified: string[];
  /** 强制完成的原因；仅 forced 时非空。 */
  forcedReason?: string | null;
}

export type CompletionDecision = CompletionApproval | ({ allowed: false; reason: CompletionGuardReason });

/**
 * 规则：
 * - none：用户明确选择不验证；不要求 ready、实施或检查，但不能有未应用草案。
 * - self：实施事实（已接收 run，或主会话实施记录）与当前输入／成果一致；run 路径要求阶段已到 deliver，
 *   主会话实施记录不受阶段限制。都不要求独立检查。
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
      implementedBy: facts.lastImplement === null ? "record" : "run",
      implementRunId: facts.lastImplement?.runId ?? null,
      checkRunId: null,
      unverified: ["用户选择 verification=none：未执行独立验证"],
    };
  }

  if (facts.confirmedInputsDigest === null) return { allowed: false, reason: "inputs_not_confirmed" };
  if (facts.confirmedInputsDigest !== facts.currentInputsDigest) return { allowed: false, reason: "inputs_changed" };
  if (!facts.scopeCurrent) return { allowed: false, reason: "scope_changed" };

  if (facts.verification === "self") {
    const run = facts.lastImplement;
    const runFresh =
      facts.stage === "deliver" &&
      run !== null &&
      run.inputsDigest === facts.currentInputsDigest &&
      run.scopeDigest === facts.currentScopeDigest;
    if (runFresh && run !== null) {
      return {
        allowed: true,
        mode: "self",
        implementedBy: "run",
        implementRunId: run.runId,
        checkRunId: null,
        unverified: [],
      };
    }
    const record = facts.implementationRecord;
    if (record !== null) {
      if (record.inputsDigest !== facts.currentInputsDigest || !record.entriesCurrent) {
        return { allowed: false, reason: "implementation_stale" };
      }
      return {
        allowed: true,
        mode: "self",
        implementedBy: "record",
        implementRunId: run?.runId ?? null,
        checkRunId: null,
        unverified: [],
      };
    }
    if (facts.stage !== "deliver") return { allowed: false, reason: "phase_mismatch" };
    if (run === null) return { allowed: false, reason: "implementation_missing" };
    return { allowed: false, reason: "implementation_stale" };
  }

  if (facts.checkQualification === "missing") return { allowed: false, reason: "check_missing" };
  if (facts.checkQualification !== "valid") return { allowed: false, reason: "check_not_valid" };
  if (facts.checkRunId === null) return { allowed: false, reason: "check_missing" };
  return {
    allowed: true,
    mode: "independent",
    implementedBy: facts.lastImplement === null ? "record" : "run",
    implementRunId: facts.lastImplement?.runId ?? null,
    checkRunId: facts.checkRunId,
    unverified: [],
  };
}
