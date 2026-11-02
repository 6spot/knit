/**
 * 检查资格（STATES.md 第8节、DESIGN.md 第5.3节）。
 * 资格是从事实推导的判断，不是持久状态机：核心发布 scope/check 证据，
 * 本模块按当前身份／输入／成果版本计算当前资格。
 * 模型自报与运行引用不进判定；无凭据不猜通过。
 */
import type { Decision } from "./task.js";

/** 检查结论（DESIGN.md 第5.3节）；附覆盖、证据与未执行项由调用方保存。 */
export type CheckVerdict = "pass" | "changes_requested" | "blocked";

/** 资格枚举，与 STATES.md 第8节表格一一对应。 */
export type CheckQualification =
  | "missing"
  | "pending"
  | "valid"
  | "stale"
  | "blocked";

export type CheckGuardReason =
  | "run_not_accepted"
  | "evidence_incomplete"
  | "superseded_by_newer_check";

/** 检查凭据的核心事实：由核心在检查获占用并正式接纳时写入（DESIGN.md 第5.3节）。 */
export interface CheckCredential {
  /** 产生凭据的 run；lastCheckRunId 的唯一候选。 */
  runId: string;
  /** 检查发生时的身份与目标版本快照。 */
  taskId: string;
  branch: string;
  /** 冻结的需求摘要（确认的输入区及适用引用版本）。 */
  inputsDigest: string;
  /** 检查核对过的成果版本；按 Task 累积的 scope 由调用方核对当前版本。 */
  scopeDigest: string;
  verdict: CheckVerdict;
  /** 结论证据是否齐备：报告、范围与检查前后输入摘要（DESIGN.md 第5.3节 check.json）。 */
  evidenceComplete: boolean;
}

/**
 * 绑定上的当前事实：调用方从 binding 与当前目标核对后传入。
 * 这些是观察值，不是持久状态。
 */
export interface CheckFacts {
  /** 绑定的 lastCheckRunId；null 表示从未有获准检查。 */
  lastCheckRunId: string | null;
  /** lastCheckRunId 对应 run 的当前执行状态；null 表示凭据记录缺失。 */
  lastCheckRunState: "running" | "completed" | "cancelled" | "failed" | null;
  /** 待核对的当前身份与目标版本。 */
  currentTaskId: string;
  currentBranch: string;
  currentInputsDigest: string;
  currentScopeDigest: string;
  /** 检查必需的凭据记录是否存在。 */
  credentialAvailable: boolean;
  /** run check --scope 的非正式检查没有正式任务资格；这里只处理正式路径。 */
}

export type CheckQualificationDecision = Decision<CheckGuardReason> & {
  /** 拒绝时为 missing（无凭据）；允许时给出具体资格。 */
  qualification?: CheckQualification;
};

/**
 * 计算正式任务的当前检查资格。
 *
 * 规则（STATES.md 第8节）：
 * - 无凭据或缺范围 → missing：补足范围并检查。
 * - 最新检查尚未结束 → pending：不能借更早 pass 收尾。
 * - pass 且身份／输入／成果版本匹配 → valid。
 * - changes_requested、blocked 或必需证据缺失 → blocked。
 * - 身份／输入／成果／分支失配 → stale，复查。
 *
 * "仅被忙拒绝的请求不算开始，已接纳后的准备／执行失败不回退旧 pass"：
 * lastCheckRunId 只在获准接纳时更新，本函数不处理请求竞争。
 */
export function qualificationOf(credential: CheckCredential, facts: CheckFacts): CheckQualificationDecision {
  // 最新候选以绑定为准：lastCheckRunId 之外的凭据不参与资格。
  if (facts.lastCheckRunId === null || !facts.credentialAvailable) {
    return { allowed: true, qualification: "missing" };
  }
  if (credential.runId !== facts.lastCheckRunId) {
    return { allowed: false, reason: "superseded_by_newer_check" };
  }
  // 最新检查尚未结束：pending，不能借更早 pass 收尾。
  if (facts.lastCheckRunState === "running") {
    return { allowed: true, qualification: "pending" };
  }
  // 已接纳后的准备／执行失败不回退旧 pass：取消／失败的检查 run 没有产生新结论，
  // 旧凭据不再代表一次已完成的检查，资格回到 missing（补检查），不装作有 pass。
  if (facts.lastCheckRunState !== "completed") {
    return { allowed: true, qualification: "missing" };
  }
  if (!credential.evidenceComplete) {
    return { allowed: true, qualification: "blocked" };
  }
  // 身份与目标版本核对：任一失配即 stale（分支失配也使交付资格失效，但不等于需求重议）。
  const identityMismatch =
    credential.taskId !== facts.currentTaskId ||
    credential.branch !== facts.currentBranch ||
    credential.inputsDigest !== facts.currentInputsDigest ||
    credential.scopeDigest !== facts.currentScopeDigest;
  if (identityMismatch) {
    return { allowed: true, qualification: "stale" };
  }
  switch (credential.verdict) {
    case "pass":
      return { allowed: true, qualification: "valid" };
    case "changes_requested":
    case "blocked":
      return { allowed: true, qualification: "blocked" };
  }
}

/** 交付资格：仅 valid 可交付（deliver 前置"有效检查"）。 */
export function isDeliverable(decision: CheckQualificationDecision): boolean {
  return decision.allowed === true && decision.qualification === "valid";
}

/** 实施资格：missing（首轮或补范围）或 stale／blocked（复查、修复）都可获准实施。 */
export function mayStartImplement(decision: CheckQualificationDecision): boolean {
  return decision.allowed === true && decision.qualification !== "pending";
}

/**
 * 资格降级表：某事件发生后旧资格如何变化。
 * 与 task.ts 的 stalenessOf 配合使用：stale 源把 valid 变 stale，
 * 其余源不变。pending 不会被事件跳过——检查结束前资格仍是 pending。
 */
export function demoteAfterEvent(current: CheckQualification, event: "stale" | null): CheckQualification {
  if (event === null) return current;
  switch (current) {
    case "valid":
      return "stale";
    case "missing":
      return "missing";
    case "pending":
      return "pending";
    case "stale":
    case "blocked":
      return current;
  }
}
