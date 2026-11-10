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
  | "check_not_valid"
  /** 最新检查由检查者改过成果（修复部分只算自检）；independent 须再派一次未改动文件的 pass 检查。 */
  | "check_self_modified"
  /** self／independent 没有任何成果路径（scope 与主会话实施记录皆空）；须显式 --no-artifacts --reason。 */
  | "empty_scope"
  /** 声明 --no-artifacts 但 scope／实施记录已有成果路径；声明与事实矛盾。 */
  | "artifacts_present"
  /** 检查凭据或实施记录完整性校验失败（本机 HMAC 不符或密钥缺失）；不作有效凭据。 */
  | "credential_tampered"
  /** 旧格式凭据缺签名：需重建（重新检查或重新 task implement），不作有效凭据。 */
  | "credential_unsigned";

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
  /** 最新检查凭据中检查者自行修复的路径；缺省视为空。 */
  checkerChangedPaths?: readonly string[];
  /** 成果 scope 与主会话实施记录都没有路径；缺省视为非空（旧调用方不受影响）。 */
  scopeEmpty?: boolean;
  /** 存在子任务（其他任务的 parent 指向本任务）；父任务总体验收不受空 scope 守卫约束。 */
  parentTask?: boolean;
  /** 用户显式声明本任务没有产物（--no-artifacts）时的原因；未声明为 null。 */
  noArtifactsReason?: string | null;
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
  /** 用户显式声明无产物（--no-artifacts）时为 none，凭据照记。 */
  artifacts?: "none";
  /** 声明无产物的原因；仅 artifacts=none 时非空。 */
  noArtifactsReason?: string | null;
}

export type CompletionDecision = CompletionApproval | ({ allowed: false; reason: CompletionGuardReason });

/**
 * “验证”行的验证方式标注：检查者修复过路径时写明修复部分为自检，
 * 不输出不带标注的“independent 通过”（DESIGN §5.1、审计 F3）。
 */
export function verificationLabel(mode: string, checkerChangedPaths: readonly string[] | null | undefined): string {
  const count = new Set(checkerChangedPaths ?? []).size;
  return count === 0 ? mode : `${mode}（检查者修复 ${count} 个路径，修复部分为自检）`;
}

/** 检查凭据中检查者自行修复的路径；旧凭据没有 checkerChangedPaths 时以 changedPaths（同样是检查 run 并入的修改）为准。 */
export function checkerChangedPathsOf(check: { checkerChangedPaths?: string[]; changedPaths?: string[] } | null | undefined): string[] {
  if (check === null || check === undefined) return [];
  return [...(check.checkerChangedPaths ?? check.changedPaths ?? [])];
}

/**
 * 规则：
 * - none：用户明确选择不验证；不要求 ready、实施或检查，但不能有未应用草案。
 * - self：实施事实（已接收 run，或主会话实施记录）与当前输入／成果一致；run 路径要求阶段已到 deliver，
 *   主会话实施记录不受阶段限制。都不要求独立检查。
 * - independent：最新正式检查当前有效且 pass；检查资格已覆盖目标、输入、规范与 scope。
 * 以上模式都不要求已有 Git 提交、交付回执或归档。
 * 空成果守卫（审计 F4）：self／independent 在资格成立后，若 scope 与主会话实施记录都没有路径，
 * 返回 empty_scope；用户显式声明无产物（noArtifactsReason）才完成并记 artifacts=none。
 * none 模式、父任务（存在子任务）与用户强制完成（forced，已带原因）不受此守卫约束；
 * 声明无产物而成果路径非空时返回 artifacts_present（声明与事实矛盾）。
 */
export function completionDecision(facts: CompletionFacts): CompletionDecision {
  const decision = qualificationDecision(facts);
  if (decision.allowed === false) return decision;
  return withArtifactsGuard(facts, decision);
}

/** 空成果守卫：资格已成立后核对是否有可交付的成果路径，或用户已显式声明无产物。 */
export function withArtifactsGuard(
  facts: Pick<CompletionFacts, "scopeEmpty" | "parentTask" | "noArtifactsReason">,
  decision: CompletionApproval,
): CompletionDecision {
  const declared = (facts.noArtifactsReason ?? "").trim();
  if (declared !== "") {
    if (facts.scopeEmpty === false) return { allowed: false, reason: "artifacts_present" };
    return { ...decision, artifacts: "none", noArtifactsReason: declared };
  }
  if (decision.mode === "none" || decision.implementedBy === "forced" || facts.parentTask === true || facts.scopeEmpty !== true) return decision;
  return { allowed: false, reason: "empty_scope" };
}

function qualificationDecision(facts: CompletionFacts): CompletionDecision {
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
  // 检查者改过成果时，修复部分只是自检，不能冒充独立复核（DESIGN §5.1）。
  if ((facts.checkerChangedPaths ?? []).length > 0) return { allowed: false, reason: "check_self_modified" };
  return {
    allowed: true,
    mode: "independent",
    implementedBy: facts.lastImplement === null ? "record" : "run",
    implementRunId: facts.lastImplement?.runId ?? null,
    checkRunId: facts.checkRunId,
    unverified: [],
  };
}
