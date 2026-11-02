/**
 * 操作重入协议（ARCHITECTURE.md 第7节）：
 * 意图先落盘 → 核验前置版本 → 应用效果 → 观察真实结果 → 步骤检查点 → 更新投影。
 * decide 是纯函数；nextState 只有效果核验和回执完成后才对外当成事实。
 */
import type { DeterministicOperation, OperationState } from "../contracts/metadata.js";

/** 步骤意图：每个外部动作可从记录定位目标、已知起点与幂等键。 */
export interface OperationStep {
  stepId: string;
  /** 效果类型（git_commit / file_move / record_append 等），由调用方约定。 */
  kind: string;
  /** 幂等键：同键重复执行不产生第二份效果。 */
  idempotencyKey: string;
  /** 已知起点事实（如 before 指纹、基线 OID）。 */
  before: Record<string, string> | null;
  /** 期望的 after 事实。 */
  after: Record<string, string> | null;
  state: OperationState;
  /** 核验证据（真实 OID、目标路径、观察结果）。 */
  evidence: Record<string, string> | null;
}

/** 操作意图创建输入；state 初始 planned，执行前先持久化。 */
export interface OperationIntent {
  operationId: string;
  kind: string;
  reason?: string | null;
  steps: Array<Pick<OperationStep, "stepId" | "kind" | "idempotencyKey" | "before" | "after">>;
}

export type OperationDecisionReason =
  | "operation_not_found"
  | "operation_completed"
  | "operation_abandoned"
  | "operation_needs_attention"
  | "step_mismatch"
  | "idempotency_conflict";

export type OperationDecision =
  | { allowed: true; state: OperationState; step: OperationStep | null }
  | { allowed: false; reason: OperationDecisionReason };

/** 由意图构造持久化记录：planned、步骤 planned、无证据。 */
export function newOperation(intent: OperationIntent, recordedAt: string): DeterministicOperation & { steps: OperationStep[] } {
  return {
    operationId: intent.operationId,
    kind: intent.kind,
    state: "planned",
    reason: intent.reason ?? null,
    recordedAt,
    steps: intent.steps.map((step) => ({ ...step, state: "planned", evidence: null })),
  } as DeterministicOperation & { steps: OperationStep[] };
}

/**
 * 开始执行某步骤：仅 planned/needs_attention（恢复）操作可进入 running；
 * completed/abandoned 不改回运行中（STATES.md 第10节）。
 */
export function decideStartStep(
  operation: DeterministicOperation & { steps: OperationStep[] },
  stepId: string,
): OperationDecision {
  if (operation.state === "completed") return { allowed: false, reason: "operation_completed" };
  if (operation.state === "abandoned") return { allowed: false, reason: "operation_abandoned" };
  if (operation.state === "needs_attention") return { allowed: false, reason: "operation_needs_attention" };
  const step = operation.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) return { allowed: false, reason: "step_mismatch" };
  if (step.state === "completed") {
    // 幂等重入：已完成步骤不重执行，返回既有证据供核对。
    return { allowed: true, state: operation.state, step };
  }
  return { allowed: true, state: "running", step };
}

/**
 * 效果核验后的检查点：观察到的 after 与期望一致才 completed；
 * before/after 均不匹配保留 needs_attention；效果未知先核实不重试。
 */
export function decideStepCheckpoint(
  operation: DeterministicOperation & { steps: OperationStep[] },
  stepId: string,
  observed: { after: Record<string, string> | null; evidence: Record<string, string> },
  options: { abort?: { reason: string } } = {},
): OperationDecision {
  const step = operation.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) return { allowed: false, reason: "step_mismatch" };
  if (options.abort) {
    return { allowed: true, state: "needs_attention", step: { ...step, state: "needs_attention", evidence: observed.evidence } };
  }
  const afterMatches = step.after !== null && observed.after !== null &&
    Object.entries(step.after).every(([key, value]) => observed.after?.[key] === value);
  const beforeMatches = step.before !== null &&
    Object.entries(step.before).every(([key, value]) => observed.evidence[`before.${key}`] === value || step.before?.[key] === value);
  if (!beforeMatches && step.before !== null && observed.evidence["verifiedRestore"] !== "true") {
    // 前后均不匹配：保留现场，needs_attention。
    return { allowed: true, state: "needs_attention", step: { ...step, state: "needs_attention", evidence: observed.evidence } };
  }
  if (step.after !== null && !afterMatches) {
    return { allowed: true, state: "needs_attention", step: { ...step, state: "needs_attention", evidence: observed.evidence } };
  }
  return { allowed: true, state: operation.state === "planned" ? "running" : operation.state, step: { ...step, state: "completed", evidence: observed.evidence } };
}

/** 全部步骤完成后的收束：操作进入 completed；仍有未完成步骤时保持 running。 */
export function decideComplete(operation: DeterministicOperation & { steps: OperationStep[] }): OperationDecision {
  if (operation.state === "abandoned") return { allowed: false, reason: "operation_abandoned" };
  const pending = operation.steps.filter((step) => step.state !== "completed");
  if (pending.length > 0) return { allowed: true, state: "running", step: null };
  return { allowed: true, state: "completed", step: null };
}

/** 显式放弃：只有明确撤回且没有未知效果才 abandoned（调用方核实后传入）。 */
export function decideAbandon(operation: DeterministicOperation & { steps: OperationStep[] }): OperationDecision {
  if (operation.state === "completed") return { allowed: false, reason: "operation_completed" };
  const unknown = operation.steps.filter((step) => step.state === "running");
  if (unknown.length > 0) return { allowed: false, reason: "operation_needs_attention" };
  return { allowed: true, state: "abandoned", step: null };
}

/** 幂等接收：同 idempotencyKey 重复执行返回既有步骤事实，不另执行。 */
export function findStepByIdempotencyKey(
  operation: DeterministicOperation & { steps: OperationStep[] },
  key: string,
): OperationStep | null {
  return operation.steps.find((step) => step.idempotencyKey === key) ?? null;
}
