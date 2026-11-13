/**
 * Task 业务状态与阶段转移（设计 §5；STATES.md 第3节）。
 * 纯函数：输入为已核实事实与生效流程，输出决定与原因；不做 IO、不看时钟、不信模型自报。
 * 封存／归档、Git 收尾与记录写入不在本模块——本模块只回答业务状态允许什么。
 *
 * 阶段模型：`start`／`deliver` 是内置锚点，其余取值必须出现在
 * `WorkflowDefinition.stages` 中。顺序边与 `onVerdict` 回退边都由配置驱动；
 * 阶段访问计数与 `maxVisits` 上限在转移层核对，超限返回 `repair_round_limit`。
 */
import type { VerificationMode } from "../contracts/task-inputs.js";
import { isReportEnum, isWorkflowAnchor } from "../contracts/workflow.js";
import type { WorkflowDefinition, WorkflowStage } from "./workflow.js";

/** status：业务工作是否结束；与 Git 提交、归档完成分别判断。 */
export type TaskStatus = "open" | "closed";

/** stage：下一项业务工作；内置锚点 start／deliver 或流程配置里的阶段 id。 */
export type TaskStage = string;

/** outcome：结束方式；open 时必须为 null（STATES.md 第3节）。 */
export type TaskOutcome = "completed" | "cancelled" | "superseded";

/** 待应用草案的更新类型；与应用时的 InputsUpdated 同一分类。 */
export type UpdateKind = "clarify" | "change";

/** 阶段访问计数：阶段 id → 已进入次数；锚点不计数（没有 maxVisits）。 */
export type StageVisits = Readonly<Record<string, number>>;

/** 阶段访问达到 maxVisits 时写入的稳定停止原因（设计 §5.3）。 */
export const STAGE_VISIT_LIMIT_REASON = "repair_round_limit";

/**
 * task.md 的业务投影；调用方从文件与绑定核对后传入。
 * visits／stopReason 由核心从 binding 读入并写回，不由模型自报。
 */
export interface TaskFacts {
  status: TaskStatus;
  stage: TaskStage;
  /** null 表示 open 无 outcome；closed 必有值。 */
  outcome: TaskOutcome | null;
  /** 完整本地分支引用；null 表示未绑定。 */
  branch: string | null;
  /** 未应用的待应用草案存在时为其 kind。 */
  pendingKind: UpdateKind | null;
  /** 完成验证要求；旧记录缺省按 independent 兼容。 */
  verification?: VerificationMode;
  /** 阶段访问计数；缺省视为空（旧绑定或未接线）。 */
  visits?: StageVisits;
  /** 流程停止原因；非空表示不自动续跑（如 repair_round_limit、check_blocked）。 */
  stopReason?: string | null;
  /** 任务是否已开始：至少有一个被接收的 run。旧绑定缺省按未开始处理。 */
  started?: boolean;
}

/**
 * 决定结果：allowed=false 时 reason 稳定可测。
 * reason 用细粒度字符串而不是 ReasonCode：领域拒绝原因比协议码更细，
 * 由应用层映射到协议响应（phase_mismatch→invalid_request 等）。
 */
export type Decision<Reason extends string> =
  | { allowed: true }
  | { allowed: false; reason: Reason };

export type TaskGuardReason =
  | "task_not_open"
  | "outcome_completed"
  | "outcome_cancelled"
  | "outcome_superseded"
  | "pending_draft_exists"
  /* 阶段与事件不符；原因码沿用既有协议面。 */
  | "phase_mismatch"
  /* 阶段值既不是锚点，也不在当前生效流程中；旧值只读展示。 */
  | "stage_not_in_workflow"
  /* 阶段再次进入次数达到 maxVisits：停止自动流转并报告 repair_round_limit。 */
  | "repair_round_limit";

/** 转移后事实由调用方写回 task.md 与 binding；本模块不保存状态。 */
export interface TaskTransition {
  status: TaskStatus;
  stage: TaskStage;
  /** 仅关闭事件产生 outcome；其余转移保持 null（取消／替代除外）。 */
  outcome: TaskOutcome | null;
  /** 本次事件后的阶段访问计数；未变化时与输入相同。 */
  visits: StageVisits;
  /** 非空表示流程已停止（如 repair_round_limit）；调用方写回 binding 并报告。 */
  stopReason: string | null;
}

/** 转移函数的返回：拒绝时带稳定原因，允许时给出目标事实。 */
export type TaskTransitionResult =
  | TaskTransition
  | ({ allowed: false; reason: TaskGuardReason; stopReason?: string });

/** 拒绝结果的类型守卫：成功分支不含 allowed 字段。 */
export function isTransitionRefusal(
  result: TaskTransitionResult,
): result is Extract<TaskTransitionResult, { allowed: false }> {
  return "allowed" in result && result.allowed === false;
}

/** 调用方核对后传入的业务事件；阶段推进目标一律由生效流程推导。 */
export type TaskEvent =
  | { kind: "inputsUpdated"; updateKind: UpdateKind; digestChanged: boolean; archived?: boolean }
  | { kind: "pendingResolved"; updateKind: UpdateKind; digestChanged: boolean; archived?: boolean }
  | { kind: "ready" }
  /** implement 阶段完成；independent 走顺序下一阶段，self／none 直接收尾。 */
  | { kind: "implementationAccepted" }
  /** 任意阶段完成；verdict 命中该阶段 onVerdict 时跳转，否则顺序下一阶段。 */
  | { kind: "stageAccepted"; verdict?: string | null }
  | { kind: "recheckRequested" }
  | { kind: "recheckCompleted" }
  | { kind: "completed" }
  | { kind: "closed"; outcome: "cancelled" | "superseded" }
  | { kind: "adopted" }
  | { kind: "recordWritten" };

const ANCHOR_START = "start";
const ANCHOR_DELIVER = "deliver";

const OPEN = (stage: TaskStage, visits: StageVisits, stopReason: string | null): TaskTransition => ({
  status: "open",
  stage,
  outcome: null,
  visits,
  stopReason,
});

function visitsOf(task: TaskFacts): StageVisits {
  return task.visits ?? {};
}

function stopReasonOf(task: TaskFacts): string | null {
  return task.stopReason ?? null;
}

function stageDefinition(workflow: WorkflowDefinition, stage: TaskStage): WorkflowStage | null {
  return workflow.stages.find((entry) => entry.id === stage) ?? null;
}

/** 阶段值是否可作为当前状态：内置锚点或当前流程中的阶段 id。 */
export function isKnownStage(workflow: WorkflowDefinition, stage: TaskStage): boolean {
  return isWorkflowAnchor(stage) || stageDefinition(workflow, stage) !== null;
}

function stageIndex(workflow: WorkflowDefinition, stage: TaskStage): number {
  return workflow.stages.findIndex((entry) => entry.id === stage);
}

/** 顺序下一阶段；最后一个阶段之后是 deliver 锚点。未知阶段按降级语义直接收尾。 */
function nextStageOf(workflow: WorkflowDefinition, stage: TaskStage): TaskStage {
  const index = stageIndex(workflow, stage);
  if (index < 0) return ANCHOR_DELIVER;
  return workflow.stages[index + 1]?.id ?? ANCHOR_DELIVER;
}

function firstStageOf(workflow: WorkflowDefinition): TaskStage {
  return workflow.stages[0]?.id ?? ANCHOR_DELIVER;
}

function lastStageOf(workflow: WorkflowDefinition): TaskStage {
  return workflow.stages.at(-1)?.id ?? ANCHOR_DELIVER;
}

/** 报告值命中的回退／跳转目标；未声明或未命中返回 null。 */
function verdictTargetOf(workflow: WorkflowDefinition, stage: TaskStage, verdict: string | null | undefined): TaskStage | null {
  if (verdict === null || verdict === undefined) return null;
  return stageDefinition(workflow, stage)?.onVerdict[verdict] ?? null;
}

/** 阶段是否用报告枚举作结论；只有结论阶段承担独立检查凭据。 */
function isDecisionStage(stage: WorkflowStage): boolean {
  return Object.values(stage.report).some(isReportEnum);
}

/** 配置中最后一个结论阶段；作为 independent 的检查回归目标。 */
export function checkStageOf(workflow: WorkflowDefinition): TaskStage | null {
  let result: TaskStage | null = null;
  for (const stage of workflow.stages) {
    if (isDecisionStage(stage)) result = stage.id;
  }
  return result;
}

/**
 * 按配置顺序找出最近访问过的阶段；`withReport` 为 true 时只看声明报告字段的阶段。
 * 用于 deliver 失去交付资格后回到最后工作阶段／最后检查阶段。
 */
function lastVisitedStageOf(
  workflow: WorkflowDefinition,
  visits: StageVisits,
  withReport = false,
): TaskStage | null {
  let result: TaskStage | null = null;
  for (const stage of workflow.stages) {
    if ((visits[stage.id] ?? 0) <= 0) continue;
    if (withReport && !isDecisionStage(stage)) continue;
    result = stage.id;
  }
  return result;
}

type EnterResult =
  | { ok: true; stage: TaskStage; visits: StageVisits }
  | { ok: false; reason: "repair_round_limit" | "stage_not_in_workflow" };

/**
 * 进入阶段并累计访问。锚点不计数；配置阶段的 `maxVisits` 限制
 * 首次进入之后的再次进入次数（0 表示不允许回退进入），与 workflow.maxRepairRounds 对齐。
 */
function enterStage(workflow: WorkflowDefinition, stage: TaskStage, visits: StageVisits): EnterResult {
  if (isWorkflowAnchor(stage)) return { ok: true, stage, visits };
  const definition = stageDefinition(workflow, stage);
  if (definition === null) return { ok: false, reason: "stage_not_in_workflow" };
  const prior = visits[stage] ?? 0;
  if (definition.maxVisits !== null && prior > definition.maxVisits) {
    return { ok: false, reason: "repair_round_limit" };
  }
  return { ok: true, stage, visits: { ...visits, [stage]: prior + 1 } };
}

function enterRefusal(result: Extract<EnterResult, { ok: false }>): TaskTransitionResult {
  if (result.reason === "repair_round_limit") {
    return { allowed: false, reason: "repair_round_limit", stopReason: STAGE_VISIT_LIMIT_REASON };
  }
  return { allowed: false, reason: "stage_not_in_workflow" };
}

/** 保持当前阶段的转移；当前值必须仍可写（锚点或当前配置阶段）。 */
function stay(workflow: WorkflowDefinition, task: TaskFacts): TaskTransitionResult {
  if (!isKnownStage(workflow, task.stage)) return { allowed: false, reason: "stage_not_in_workflow" };
  return OPEN(task.stage, visitsOf(task), stopReasonOf(task));
}

/**
 * deliver（含未归档 completed）失去交付资格：
 * - independent 回到检查阶段（最后访问过且声明报告字段的阶段，其次配置中的检查阶段）；
 * - self／none 回到最近访问过的工作阶段，没有记录时回第一段；
 * - 降级流程（无阶段）回到 start，随后 ready 直接收尾。
 */
export function staleDeliverTransition(workflow: WorkflowDefinition, task: TaskFacts): TaskTransitionResult {
  const visits = visitsOf(task);
  if (workflow.stages.length === 0) return OPEN(ANCHOR_START, visits, stopReasonOf(task));
  const verification = task.verification ?? "independent";
  // independent 重新取得检查凭据：回到最后一个声明报告字段的阶段（无声明时用最后阶段）。
  if (verification === "independent") {
    const visitedCheck = lastVisitedStageOf(workflow, visits, true);
    return enterResult(workflow, visitedCheck ?? checkStageOf(workflow) ?? lastStageOf(workflow), visits, stopReasonOf(task));
  }
  // self／none 无独立检查：回到最近访问过的工作阶段；没有记录时从头开始。
  const lastVisited = lastVisitedStageOf(workflow, visits);
  return enterResult(workflow, lastVisited ?? firstStageOf(workflow), visits, stopReasonOf(task));
}

/**
 * 跨机重建绑定时的阶段落点（任务 k-434714cbbb68）。
 * task.md 的 stage 只是名义业务位置；本机缺少 scope、确认摘要与凭据时，
 * 必须回到能重新取得证据的阶段。本函数只推导目标，不进入阶段、不累计 visits。
 */
export interface RebindStageDecision {
  stage: TaskStage;
  /** 目标阶段与 task.md 名义阶段不同。 */
  lowered: boolean;
  /** 写回记录区的降级原因。 */
  reason: string;
}

export function rebindStageOf(input: {
  workflow: WorkflowDefinition;
  stage: TaskStage;
  verification: VerificationMode;
  /** 本机已有实施记录或非空 scope：independent 可直接回到检查阶段。 */
  hasImplementationEvidence: boolean;
}): RebindStageDecision {
  const { workflow, stage, verification } = input;
  if (stage === ANCHOR_START) {
    return { stage, lowered: false, reason: "位于讨论阶段 start，不降级" };
  }
  // 降级流程没有配置阶段，也没有检查阶段：保持 task.md 的名义位置，由调用方按可用证据推进。
  if (workflow.stages.length === 0) {
    return { stage, lowered: false, reason: "生效流程没有配置阶段，保持 task.md 的名义阶段" };
  }
  if (verification !== "independent") {
    const first = firstStageOf(workflow);
    return {
      stage: first,
      lowered: first !== stage,
      reason: `verification=${verification} 无独立检查：回到首个工作阶段 ${first}，用实施记录重建完成资格`,
    };
  }
  const checkStage = checkStageOf(workflow) ?? lastStageOf(workflow);
  const index = stageIndex(workflow, stage);
  const checkIndex = stageIndex(workflow, checkStage);
  const atOrPastCheck = stage === ANCHOR_DELIVER || (index >= 0 && checkIndex >= 0 && index >= checkIndex);
  if (input.hasImplementationEvidence || atOrPastCheck) {
    return {
      stage: checkStage,
      lowered: checkStage !== stage,
      reason: `verification=independent：回到检查阶段 ${checkStage}，重新取得有效检查凭据`,
    };
  }
  if (index >= 0) {
    return { stage, lowered: false, reason: `verification=independent：实施尚未完成，保持 ${stage}` };
  }
  const first = firstStageOf(workflow);
  return {
    stage: first,
    lowered: true,
    reason: `声明阶段 ${stage} 不在生效流程中；回到首个工作阶段 ${first}`,
  };
}

function enterResult(
  workflow: WorkflowDefinition,
  stage: TaskStage,
  visits: StageVisits,
  stopReason: string | null,
): TaskTransitionResult {
  const entered = enterStage(workflow, stage, visits);
  if (!entered.ok) return enterRefusal(entered);
  return OPEN(entered.stage, entered.visits, stopReason);
}

/** 已结束任务的常规业务转移守卫。 */
function closedGuard(task: TaskFacts): Decision<TaskGuardReason> {
  if (task.status === "open") return { allowed: true };
  switch (task.outcome) {
    case "completed":
      return { allowed: false, reason: "outcome_completed" };
    case "cancelled":
      return { allowed: false, reason: "outcome_cancelled" };
    case "superseded":
      return { allowed: false, reason: "outcome_superseded" };
    case null:
      // 结构不一致由调用方 schema 校验拦下；这里按最保守处理。
      return { allowed: false, reason: "task_not_open" };
  }
}

/** 输入更新专用的已结束守卫：未归档 completed 可重新打开；已归档与 cancelled/superseded 拒绝（任务036）。 */
function inputsClosedGuard(task: TaskFacts, archived: boolean): Decision<TaskGuardReason> {
  if (task.status === "open") return { allowed: true };
  if (task.outcome === "completed" && archived === false) return { allowed: true };
  const closed = closedGuard(task);
  return closed.allowed ? { allowed: false, reason: "task_not_open" } : closed;
}

/** 待应用草案守卫：未应用或未明确撤回时阻止后续代码阶段与交付（DESIGN.md 第3.8节）。 */
function pendingGuard(task: TaskFacts): Decision<TaskGuardReason> {
  return task.pendingKind === null ? { allowed: true } : { allowed: false, reason: "pending_draft_exists" };
}

function firstRefusal(task: TaskFacts): { allowed: false; reason: TaskGuardReason } | null {
  const closed = closedGuard(task);
  if (!closed.allowed) return closed;
  const pending = pendingGuard(task);
  if (!pending.allowed) return pending;
  return null;
}

/** 输入更新守卫：未归档 completed 放宽为可重开；pending 由 inputsUpdated 内部按上下文裁决（任务036）。 */
function inputsUpdateRefusal(task: TaskFacts, archived: boolean, applyPending = false): { allowed: false; reason: TaskGuardReason } | null {
  const closed = inputsClosedGuard(task, archived);
  if (!closed.allowed) return closed;
  if (!applyPending) {
    const pending = pendingGuard(task);
    if (!pending.allowed) return pending;
  }
  return null;
}

function inputsUpdated(workflow: WorkflowDefinition, task: TaskFacts, kind: UpdateKind, digestChanged: boolean, archived: boolean): TaskTransitionResult {
  const refusal = inputsUpdateRefusal(task, archived);
  if (refusal) return refusal;
  // change 是目标／范围变化：回到 start。尚未开始时（没有接收过 run）准备期改需求不占进入预算，
  // 清空访问计数；已开始后保留计数，不重置回退历史。
  if (kind === "change") {
    if (task.started !== true) return OPEN(ANCHOR_START, {}, stopReasonOf(task));
    return OPEN(ANCHOR_START, visitsOf(task), stopReasonOf(task));
  }
  if (!digestChanged) return stay(workflow, task);
  if (task.stage !== ANCHOR_DELIVER) return stay(workflow, task);
  return staleDeliverTransition(workflow, task);
}

/**
 * 阶段转移唯一入口（设计 §13）：按生效流程决定目标阶段、访问计数与停止原因。
 * 不读文件、不写 binding；调用方核对事实并写回结果。
 */
export function transition(workflow: WorkflowDefinition, task: TaskFacts, event: TaskEvent): TaskTransitionResult {
  switch (event.kind) {
    case "inputsUpdated":
      return inputsUpdated(workflow, task, event.updateKind, event.digestChanged, event.archived ?? false);
    case "pendingResolved":
      // 应用是待应用草案的解决路径，不受草案守卫拦截；摘要与基线匹配由调用方核对。
      return inputsUpdated(
        workflow,
        { ...task, pendingKind: null },
        event.updateKind,
        event.digestChanged,
        event.archived ?? false,
      );
    case "ready": {
      // DiscussionConfirmed：start → 配置的第一个阶段；降级流程直接进入 deliver。
      const refusal = firstRefusal(task);
      if (refusal) return refusal;
      if (task.stage !== ANCHOR_START) return { allowed: false, reason: "phase_mismatch" };
      return enterResult(workflow, firstStageOf(workflow), visitsOf(task), stopReasonOf(task));
    }
    case "implementationAccepted": {
      const refusal = firstRefusal(task);
      if (refusal) return refusal;
      if (isWorkflowAnchor(task.stage)) return { allowed: false, reason: "phase_mismatch" };
      // 旧任务未做数据迁移时，降级流程按 start → deliver 判定。
      if (workflow.stages.length === 0) return OPEN(ANCHOR_DELIVER, visitsOf(task), stopReasonOf(task));
      if (!isKnownStage(workflow, task.stage)) return { allowed: false, reason: "stage_not_in_workflow" };
      const verification = task.verification ?? "independent";
      // independent 保留正式检查；self／none 实施获准后直接进入收尾。
      const target = verification === "independent" ? nextStageOf(workflow, task.stage) : ANCHOR_DELIVER;
      return enterResult(workflow, target, visitsOf(task), stopReasonOf(task));
    }
    case "stageAccepted": {
      const refusal = firstRefusal(task);
      if (refusal) return refusal;
      if (task.stage === ANCHOR_START) {
        return enterResult(workflow, firstStageOf(workflow), visitsOf(task), stopReasonOf(task));
      }
      if (task.stage === ANCHOR_DELIVER) return { allowed: false, reason: "phase_mismatch" };
      // 降级流程（无阶段）：在途 run 的旧阶段值继续跑完并收敛到 deliver。
      if (workflow.stages.length === 0) return OPEN(ANCHOR_DELIVER, visitsOf(task), stopReasonOf(task));
      if (!isKnownStage(workflow, task.stage)) return { allowed: false, reason: "stage_not_in_workflow" };
      const target = verdictTargetOf(workflow, task.stage, event.verdict) ?? nextStageOf(workflow, task.stage);
      // 显式指向本阶段（如 blocked 保留检查）是原地停留，不重复累计访问。
      if (target === task.stage) return OPEN(task.stage, visitsOf(task), stopReasonOf(task));
      return enterResult(workflow, target, visitsOf(task), stopReasonOf(task));
    }
    case "recheckRequested": {
      const refusal = firstRefusal(task);
      if (refusal) return refusal;
      if (workflow.stages.length === 0) {
        // 降级流程只有 start → deliver；复查直接回到收尾，不自动重开工作阶段。
        return task.stage === ANCHOR_START ? { allowed: false, reason: "phase_mismatch" } : OPEN(ANCHOR_DELIVER, visitsOf(task), stopReasonOf(task));
      }
      // 复查目标是检查阶段（声明报告字段的最后阶段）；从 deliver 或检查阶段本身发起。
      const checkStage = checkStageOf(workflow) ?? lastStageOf(workflow);
      if (task.stage !== ANCHOR_DELIVER && task.stage !== checkStage && task.stage !== lastStageOf(workflow)) {
        return { allowed: false, reason: "phase_mismatch" };
      }
      return enterResult(workflow, checkStage, visitsOf(task), stopReasonOf(task));
    }
    case "recheckCompleted": {
      if (task.status === "open") return { allowed: false, reason: "task_not_open" };
      if (task.outcome !== "completed") return { allowed: false, reason: "task_not_open" };
      return enterResult(workflow, checkStageOf(workflow) ?? lastStageOf(workflow), visitsOf(task), stopReasonOf(task));
    }
    case "completed": {
      // BusinessClosed：完成资格（self 需 deliver、independent 需有效检查、none 明确跳过）
      // 由 completion 层核对；本转移只落业务状态，与既有语义一致。
      const refusal = firstRefusal(task);
      if (refusal) return refusal;
      return { status: "closed", stage: ANCHOR_DELIVER, outcome: "completed", visits: visitsOf(task), stopReason: stopReasonOf(task) };
    }
    case "closed": {
      // 取消／替代保留停止位置；已结束任务不可再次结束。
      const closed = closedGuard(task);
      if (!closed.allowed) return closed;
      const valid = stay(workflow, task);
      if ("allowed" in valid) return valid;
      return { ...valid, status: "closed", outcome: event.outcome };
    }
    case "adopted": {
      // adopt 只处理分支变化；资格影响按 verification 与已访问阶段推导。
      if (task.status === "closed") {
        if (task.outcome === "cancelled") return { allowed: false, reason: "outcome_cancelled" };
        if (task.outcome === "superseded") return { allowed: false, reason: "outcome_superseded" };
        if (task.outcome === null) return { allowed: false, reason: "task_not_open" };
        return staleDeliverTransition(workflow, task);
      }
      if (task.pendingKind !== null) return { allowed: false, reason: "pending_draft_exists" };
      if (task.stage === ANCHOR_DELIVER) return staleDeliverTransition(workflow, task);
      return stay(workflow, task);
    }
    case "recordWritten":
      // 记录写入不改变业务状态；提供显式判定防止调用方误转移。
      return {
        status: task.status,
        stage: task.stage,
        outcome: task.outcome,
        visits: visitsOf(task),
        stopReason: stopReasonOf(task),
      };
  }
}

/**
 * 检查资格的失效源归类（STATES.md 第8节）：
 * stale 只由输入、生效规则、成果、分支、restore 影响选定目标时触发；
 * 纯记录、运行引用、未生效候选、等价改名／归档移动不变。
 * 模型自报阶段／次数不进判定——模型可证实的变化一律以核心核实的事实传入。
 */
export type StaleSource =
  | { kind: "inputs"; digestChanged: boolean }
  | { kind: "effectiveRules" }
  | { kind: "artifacts" }
  | { kind: "branch" }
  | { kind: "restore" };

/** 返回 null 表示资格不变（纯记录等）；否则旧检查按该源失资格。 */
export function stalenessOf(source: StaleSource): "stale" | null {
  switch (source.kind) {
    case "inputs":
      return source.digestChanged ? "stale" : null;
    case "effectiveRules":
    case "artifacts":
    case "branch":
    case "restore":
      return "stale";
  }
}

/** 输入摘要覆盖哪些事件：需求摘要不纳入 status/stage/branch、运行引用、记录、模型用量（DESIGN.md 第3.3节）。 */
export type DigestRelevantEvent =
  | { kind: "record" }
  | { kind: "runReference" }
  | { kind: "standardsCandidate" }
  | { kind: "modelOrUsage" }
  | { kind: "rename"; equivalent: boolean };

/** 摘要未变返回 null；摘要变化返回 stale。改名仅在不等价时影响输入。 */
export function digestImpact(event: DigestRelevantEvent): "stale" | null {
  switch (event.kind) {
    case "record":
    case "runReference":
    case "standardsCandidate":
    case "modelOrUsage":
      return null;
    case "rename":
      return event.equivalent ? null : "stale";
  }
}

/**
 * 父子任务结构（DESIGN.md 第3.10节）。
 * 关系只存子任务一侧的 parent（稳定任务身份），父级的子任务集合由扫描派生；
 * 目录改名与归档移动不改变关联。层级与执行依赖是两件事：父子不构成开始前置。
 */
export type ParentGuardReason =
  | "child_not_open"
  | "child_archived"
  | "parent_missing"
  | "parent_not_open"
  | "parent_archived"
  /* 自我挂接沿链检查同样无解，按 parent_cycle 报告。 */
  | "parent_cycle";

/**
 * 沿 parent 链向上查找 target：用于拒绝成环。
 * parentOf 是当前工程内“任务 ID → 父任务 ID”的快照；未知任务视为链终止。
 */
export function parentChainContains(
  parentOf: ReadonlyMap<string, string | null>,
  startTaskId: string,
  targetTaskId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = parentOf.get(startTaskId) ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === targetTaskId) return true;
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

/** 挂接父任务前的结构核对；parentKnown=false 表示父任务不存在。 */
export function onParentAssigned(input: {
  child: TaskFacts;
  childArchived: boolean;
  parentKnown: boolean;
  parent: TaskFacts | null;
  parentArchived: boolean;
  cycle: boolean;
}): Decision<ParentGuardReason> {
  if (input.childArchived) return { allowed: false, reason: "child_archived" };
  if (input.child.status !== "open") return { allowed: false, reason: "child_not_open" };
  if (!input.parentKnown || input.parent === null) return { allowed: false, reason: "parent_missing" };
  if (input.parentArchived) return { allowed: false, reason: "parent_archived" };
  if (input.parent.status !== "open") return { allowed: false, reason: "parent_not_open" };
  if (input.cycle) return { allowed: false, reason: "parent_cycle" };
  return { allowed: true };
}

/**
 * 父任务完成资格：所有子任务都已结束，且主会话给出总体验收依据。
 * 子任务完成只表示分项结束，不自动使父任务完成。
 */
export type ParentCompletionReason = "children_incomplete" | "parent_acceptance_missing";

export function onParentCompletion(input: { openChildren: string[]; reason: string | null }): Decision<ParentCompletionReason> {
  if (input.openChildren.length > 0) return { allowed: false, reason: "children_incomplete" };
  if (input.reason === null || input.reason.trim() === "") return { allowed: false, reason: "parent_acceptance_missing" };
  return { allowed: true };
}
