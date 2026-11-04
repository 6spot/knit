/**
 * 任务调度：优先级、前置依赖与稳定执行顺序（DESIGN §3.11）。
 * 纯函数：事实由应用层从 task.md 汇总后传入；不做 IO、不看时钟。
 * 排序只读 createdAt 与 order，从不推断目录名或文件系统枚举顺序。
 */
import { DEFAULT_PRIORITY, type TaskPriority } from "../contracts/task-inputs.js";

/** P0 最高；数值只用于比较，不持久化。 */
export const PRIORITY_RANK: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface ScheduleEntry {
  taskId: string;
  priority: TaskPriority;
  /** 原始创建时间（ISO 8601）；排序只读它，调整顺序不改写。 */
  createdAt: string;
  /** 人工调整后的业务顺序；null 表示沿用真实创建先后。 */
  order: number | null;
  /** 前置依赖的稳定任务身份；空数组表示无依赖。 */
  dependsOn: string[];
  status: "open" | "closed";
  outcome: "completed" | "cancelled" | "superseded" | null;
  archived: boolean;
}

/** 缺省 P2；未指定不等于可后置。 */
export function priorityOrDefault(value: TaskPriority | undefined): TaskPriority {
  return value ?? DEFAULT_PRIORITY;
}

/**
 * 稳定执行顺序：优先级 → 人工业务顺序 → 真实创建先后 → 稳定身份。
 * 已人工调整的排在未调整项之前；创建时间相同（历史信息不足）才用任务 ID，
 * 不伪造先后（DESIGN §3.11）。
 */
export function compareSchedule(a: ScheduleEntry, b: ScheduleEntry): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
  if (a.order !== null && b.order === null) return -1;
  if (a.order === null && b.order !== null) return 1;
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  if (byCreated !== 0) return byCreated;
  return a.taskId.localeCompare(b.taskId);
}

export type DependencyProblem =
  | "dependency_missing"
  | "dependency_self"
  | "dependency_not_completed"
  | "dependency_archived"
  | "dependency_cycle";

/** 未满足的前置依赖；problem 稳定可测，用于列表与执行入口的一致诊断。 */
export interface DependencyBlocker {
  taskId: string;
  problem: DependencyProblem;
  /** 依赖任务当前状态；缺失时为 null。 */
  status: "open" | "closed" | null;
  outcome: "completed" | "cancelled" | "superseded" | null;
}

/** 依赖图：稳定任务 ID → 其前置依赖。 */
export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

/**
 * 沿依赖方向做环检测：返回从 startTaskId 出发可回到自身的路径（不含重复的起点），
 * 否则返回 null。用于设置依赖与诊断既有异常数据。
 */
export function dependencyCycle(
  graph: DependencyGraph,
  startTaskId: string,
): string[] | null {
  const path: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const at = path.indexOf(id);
      return at === -1 ? [...path, id] : [...path.slice(at), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const next of graph.get(id) ?? []) {
      if (next === startTaskId && !visiting.has(next)) continue;
      const found = walk(next);
      if (found !== null) return found;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  if ((graph.get(startTaskId) ?? []).includes(startTaskId)) return [startTaskId, startTaskId];
  return walk(startTaskId);
}

/**
 * 未满足的前置依赖：缺失、自依赖、未完成（含已归档但未完成）与成环。
 * 已完成（closed/completed）即视为满足；取消／替代永不满足，需用户显式调整依赖。
 */
export function dependencyBlockers(
  entry: ScheduleEntry,
  index: ReadonlyMap<string, ScheduleEntry>,
): DependencyBlocker[] {
  const blockers: DependencyBlocker[] = [];
  const seen = new Set<string>();
  for (const dependencyId of entry.dependsOn) {
    if (seen.has(dependencyId)) continue;
    seen.add(dependencyId);
    if (dependencyId === entry.taskId) {
      blockers.push({ taskId: dependencyId, problem: "dependency_self", status: entry.status, outcome: entry.outcome });
      continue;
    }
    const dependency = index.get(dependencyId);
    if (dependency === undefined) {
      blockers.push({ taskId: dependencyId, problem: "dependency_missing", status: null, outcome: null });
      continue;
    }
    const completed = dependency.status === "closed" && dependency.outcome === "completed";
    if (completed) continue;
    blockers.push({
      taskId: dependencyId,
      problem: dependency.archived ? "dependency_archived" : "dependency_not_completed",
      status: dependency.status,
      outcome: dependency.outcome,
    });
  }
  // 显式依赖都已满足时仍需排除成环：成环的任务永远无法按先后完成，不能启动。
  const cycle = dependencyCycle(new Map([...index].map(([id, value]) => [id, value.dependsOn])), entry.taskId);
  if (cycle !== null) {
    const at = cycle[0] ?? entry.taskId;
    blockers.push({ taskId: at, problem: "dependency_cycle", status: index.get(at)?.status ?? null, outcome: index.get(at)?.outcome ?? null });
  }
  return blockers;
}

/** 可启动：依赖全部满足且任务本身 open；已结束任务不再进入执行队列。 */
export function isExecutable(entry: ScheduleEntry, index: ReadonlyMap<string, ScheduleEntry>): boolean {
  return entry.status === "open" && dependencyBlockers(entry, index).length === 0;
}

export type ReorderPosition =
  | { before: string }
  | { after: string }
  | { top: true }
  | { bottom: true };

export type ReorderProblem = "order_reference_missing" | "order_self_reference" | "order_target_not_open";

/**
 * 人工调整业务顺序：在优先级分组内移动目标，并把新的业务顺序分配给全部活跃任务。
 * 返回顺序号（已人工调整的显式落盘，未调整项也获得编号以保持稳定），
 * 不修改任何任务的 createdAt；未参与的任务不返回。
 */
export function planReorder(
  entries: readonly ScheduleEntry[],
  targetId: string,
  position: ReorderPosition,
): { orders: Array<{ taskId: string; order: number }> } | { allowed: false; reason: ReorderProblem } {
  const active = entries.filter((entry) => entry.status === "open").slice().sort(compareSchedule);
  const target = active.find((entry) => entry.taskId === targetId);
  if (target === undefined) return { allowed: false, reason: "order_target_not_open" };
  const rest = active.filter((entry) => entry.taskId !== targetId);
  let index: number;
  if ("before" in position) {
    if (position.before === targetId) return { allowed: false, reason: "order_self_reference" };
    const at = rest.findIndex((entry) => entry.taskId === position.before);
    if (at === -1) return { allowed: false, reason: "order_reference_missing" };
    index = at;
  } else if ("after" in position) {
    if (position.after === targetId) return { allowed: false, reason: "order_self_reference" };
    const at = rest.findIndex((entry) => entry.taskId === position.after);
    if (at === -1) return { allowed: false, reason: "order_reference_missing" };
    index = at + 1;
  } else if ("top" in position) {
    index = 0;
  } else {
    index = rest.length;
  }
  rest.splice(index, 0, target);
  return { orders: rest.map((entry, at) => ({ taskId: entry.taskId, order: (at + 1) * 10 })) };
}
