/**
 * Task 业务状态与阶段转移（STATES.md 第3节）。
 * 纯函数：输入为已核实事实，输出决定与原因；不做 IO、不看时钟、不信模型自报。
 * 封存／归档、Git 收尾与记录写入不在本模块——本模块只回答业务状态允许什么。
 */
import type { CheckVerdict } from "./check.js";

/** status：业务工作是否结束；与 Git 提交、归档完成分别判断。 */
export type TaskStatus = "open" | "closed";

/** phase：下一项业务工作。 */
export type TaskPhase = "discuss" | "implement" | "check" | "deliver";

/** outcome：结束方式；open 时必须为 null（STATES.md 第3节）。 */
export type TaskOutcome = "completed" | "cancelled" | "superseded";

/** 待应用草案的更新类型；与应用时的 InputsUpdated 同一分类。 */
export type UpdateKind = "clarify" | "change";

/**
 * task.md 的业务投影；调用方从文件与绑定核对后传入。
 * repairCycleId 等修复计数不在对象里：计数规则见 repair.ts，由核心写入 binding。
 */
export interface TaskFacts {
  status: TaskStatus;
  phase: TaskPhase;
  /** null 表示 open 无 outcome；closed 必有值。 */
  outcome: TaskOutcome | null;
  /** 完整本地分支引用；null 表示未绑定。 */
  branch: string | null;
  /** 未应用的待应用草案存在时为其 kind。 */
  pendingKind: UpdateKind | null;
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
  | "phase_mismatch";

/** 转移后事实由调用方写回 task.md 与 binding；本模块不保存状态。 */
export interface TaskTransition {
  status: TaskStatus;
  phase: TaskPhase;
  /** 仅关闭事件产生 outcome；其余转移保持 null（取消／替代除外，见 onCloseWithOutcome）。 */
  outcome: TaskOutcome | null;
}

/** 转移函数的返回：拒绝时带稳定原因，允许时给出目标事实。 */
export type TaskTransitionResult = TaskTransition | ({ allowed: false; reason: TaskGuardReason });

const OPEN = (phase: TaskPhase): TaskTransition => ({ status: "open", phase, outcome: null });

/**
 * 已结束任务的常规业务转移守卫。
 * 取消／替代不可隐式重开；completed 按 DESIGN §3.6 允许输入更新重新打开（是否完整归档由调用方核实），
 * 其余事件（ready、实施、检查、交付、关闭）不作用于已结束任务。
 */
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

/** 待应用草案守卫：未应用或未明确撤回时阻止后续代码阶段与交付（DESIGN.md 第3.6节）。 */
function pendingGuard(task: TaskFacts): Decision<TaskGuardReason> {
  return task.pendingKind === null ? { allowed: true } : { allowed: false, reason: "pending_draft_exists" };
}

/** 依次执行守卫，返回首个拒绝；全部通过返回 null。仅用于 completed 一律拒绝的事件。 */
function firstRefusal(task: TaskFacts): { allowed: false; reason: TaskGuardReason } | null {
  const closed = closedGuard(task);
  if (!closed.allowed) return closed;
  const pending = pendingGuard(task);
  if (!pending.allowed) return pending;
  return null;
}

/** 输入更新守卫：未归档 completed 放宽为可重开；pending 由 onInputsUpdated 内部按上下文裁决（任务036）。 */
function inputsUpdateRefusal(task: TaskFacts, archived: boolean, applyPending = false): { allowed: false; reason: TaskGuardReason } | null {
  const closed = inputsClosedGuard(task, archived);
  if (!closed.allowed) return closed;
  if (!applyPending) {
    const pending = pendingGuard(task);
    if (!pending.allowed) return pending;
  }
  return null;
}

/**
 * InputsUpdated（task update --kind）的领域规则（STATES.md 第3节）。
 * 摘要是否变化由调用方以冻结摘要对比传入；核心不做自然语言分类。
 * clarify：解释、纠正、补充定位／验证资料——保持 discuss/implement/check，
 * 摘要未变不迁移；deliver 的检查 stale 确定性回 open/check 并清 completed。
 * change：新增、删除或改变目标、条件、范围、业务约束——回 open/discuss。
 */
export function onInputsUpdated(task: TaskFacts, kind: UpdateKind, digestChanged: boolean, archived = false): TaskTransitionResult {
  const refusal = inputsUpdateRefusal(task, archived);
  if (refusal) return refusal;
  if (kind === "change") return OPEN("discuss");
  if (!digestChanged) return OPEN(task.phase);
  return task.phase === "deliver" ? OPEN("check") : OPEN(task.phase);
}

/**
 * PendingApplied／PendingWithdrawn：按草案保存的 kind 应用（STATES.md 第3节）。
 * 应用是待应用草案的解决路径，不受草案守卫拦截；摘要与基线匹配由调用方核对。
 */
export function onPendingResolved(task: TaskFacts, kind: UpdateKind, digestChanged: boolean, archived = false): TaskTransitionResult {
  const refusal = inputsUpdateRefusal(task, archived, true);
  if (refusal) return refusal;
  return onInputsUpdated({ ...task, pendingKind: null }, kind, digestChanged, archived);
}

/** DiscussionConfirmed（task ready）：discuss → implement，保存确认输入引用由调用方负责。 */
export function onReady(task: TaskFacts): TaskTransitionResult {
  const refusal = firstRefusal(task);
  if (refusal) return refusal;
  if (task.phase !== "discuss") return { allowed: false, reason: "phase_mismatch" };
  return OPEN("implement");
}

/**
 * ImplementationAccepted：实施回执与实际成果有效后 implement → check，累积 scope 由调用方记录。
 * 每次获准实施使旧检查失去交付资格——资格推导在 check.ts，不在此重复。
 */
export function onImplementationAccepted(task: TaskFacts): TaskTransitionResult {
  const refusal = firstRefusal(task);
  if (refusal) return refusal;
  if (task.phase !== "implement") return { allowed: false, reason: "phase_mismatch" };
  return OPEN("check");
}

/**
 * CheckAccepted（STATES.md 第3节）：最新获准检查及目标版本匹配时，
 * pass → deliver；changes_requested → implement；blocked 保留 check。
 */
export function onCheckAccepted(task: TaskFacts, verdict: CheckVerdict): TaskTransitionResult {
  const refusal = firstRefusal(task);
  if (refusal) return refusal;
  if (task.phase !== "check") return { allowed: false, reason: "phase_mismatch" };
  switch (verdict) {
    case "pass":
      return OPEN("deliver");
    case "changes_requested":
      return OPEN("implement");
    case "blocked":
      return OPEN("check");
  }
}

/**
 * RecheckRequested（run check --task）：当前为 check/deliver 时 open/check；
 * discuss/implement 明确拒绝 phase_mismatch，不自动跳过 ready／实施（STATES.md 第3节）。
 */
export function onRecheckRequested(task: TaskFacts): TaskTransitionResult {
  const refusal = firstRefusal(task);
  if (refusal) return refusal;
  switch (task.phase) {
    case "check":
    case "deliver":
      return OPEN("check");
    case "discuss":
    case "implement":
      return { allowed: false, reason: "phase_mismatch" };
  }
}

/**
 * 未归档 completed 任务的显式复查入口（STATES.md：RecheckRequested 含"未归档 completed"）。
 * completed 无隐式重开；仅 run check --task 显式触发，转 open/check。
 * open 任务不适用本入口，返回 null。
 */
export function onRecheckCompleted(task: TaskFacts): TaskTransitionResult | null {
  if (task.status === "open") return null;
  if (task.outcome !== "completed") return { allowed: false, reason: "task_not_open" };
  return OPEN("check");
}

/**
 * BusinessClosed：deliver（须有效检查与主 Agent 完成判断，守卫由调用方核对）后的正常完成。
 * 归档是收尾行为，不属于业务转移；Git 回执由收尾处理器核实。
 */
export function onComplete(task: TaskFacts): TaskTransitionResult {
  const refusal = firstRefusal(task);
  if (refusal) return refusal;
  return { status: "closed", phase: "deliver", outcome: "completed" };
}

/**
 * TaskEndRequested（task close --outcome cancelled/superseded）：明确取消／替代。
 * 守卫"无活动／未知 run、无未核实 Git 效果、待接收结果先收敛"属于调用方事实核对；
 * 本函数只裁决业务状态。phase 保留停止位置；草案撤回留记录由调用方完成。
 */
export function onCloseWithOutcome(task: TaskFacts, outcome: "cancelled" | "superseded"): TaskTransitionResult {
  const refusal = closedGuard(task);
  if (!refusal.allowed) return refusal;
  return { status: "closed", phase: task.phase, outcome };
}

/**
 * adopt（分支接管）的资格影响（DESIGN.md 第3.5节）。
 * 调用方须先核实：无存活／未知 run、无未核实 Git 效果、输入已收敛、文件在当前分支可见。
 * 仅分支改变且有效需求未变时：discuss/implement 保持；check 保持待检查；
 * deliver（含未归档 completed）恢复为 open/check 并清 completed。
 * 取消／替代只接管收尾，不自动重开。
 */
export function onAdopt(task: TaskFacts): TaskTransitionResult {
  if (task.status === "closed") {
    if (task.outcome === "cancelled") return { allowed: false, reason: "outcome_cancelled" };
    if (task.outcome === "superseded") return { allowed: false, reason: "outcome_superseded" };
    if (task.outcome === null) return { allowed: false, reason: "task_not_open" };
    return OPEN("check");
  }
  if (task.pendingKind !== null) return { allowed: false, reason: "pending_draft_exists" };
  return task.phase === "deliver" ? OPEN("check") : OPEN(task.phase);
}

/** 记录写入（task record）不改变业务状态；提供显式判定防止调用方误转移。 */
export function onRecordWritten(task: TaskFacts): TaskTransition {
  return { status: task.status, phase: task.phase, outcome: task.outcome };
}

/**
 * 检查资格的失效源归类（STATES.md 第8节）：
 * stale 只由输入、生效规则、成果、分支、restore 影响选定目标时触发；
 * 纯记录、运行引用、未生效候选、等价改名／归档移动不变。
 * 模型自报 phase／次数不进判定——模型可证实的变化一律以核心核实的事实传入。
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

/** 输入摘要覆盖哪些事件：需求摘要不纳入 status/phase/branch、运行引用、记录、模型用量（DESIGN.md 第3.3节）。 */
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
