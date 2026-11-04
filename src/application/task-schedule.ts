/**
 * 任务调度事实读取（DESIGN §3.11）：把 task.md 的优先级、依赖与业务顺序
 * 投影为领域事实，供执行入口与只读视图共用。
 * 只读：不写任务文件、不产生运行与授权。
 */
import { readWithVersion } from "../infrastructure/atomic.js";
import { join } from "node:path";
import { dependencyBlockers, priorityOrDefault, type DependencyBlocker, type ScheduleEntry } from "../domain/schedule.js";
import { parseTaskDocument } from "./task-document.js";
import { listTaskDirectories, tasksRootOf } from "./task-service.js";

const TASK_FILE = "task.md";

/** 全量调度事实：活跃与归档任务按稳定 ID 索引，重复 ID 保留首个。 */
export function scheduleIndexOf(root: string): Map<string, ScheduleEntry> {
  const index = new Map<string, ScheduleEntry>();
  const tasksRoot = tasksRootOf(root);
  for (const { name, archived } of listTaskDirectories(root)) {
    const file = join(tasksRoot, name, TASK_FILE);
    const raw = readWithVersion(file);
    if (raw === null) continue;
    let document;
    try {
      document = parseTaskDocument(raw.data.toString("utf8"), file);
    } catch (error) {
      // 归档区损坏条目由 list 诊断；执行入口只使用可解析事实。
      if (archived) continue;
      throw error;
    }
    const frontmatter = document.frontmatter;
    if (index.has(frontmatter.id)) continue;
    index.set(frontmatter.id, {
      taskId: frontmatter.id,
      priority: priorityOrDefault(frontmatter.priority),
      createdAt: frontmatter.createdAt,
      order: frontmatter.order ?? null,
      dependsOn: frontmatter.dependsOn ?? [],
      status: frontmatter.status,
      outcome: frontmatter.outcome,
      archived,
    });
  }
  return index;
}

/** 指定任务未满足的前置依赖；任务不存在时返回空（调用方先行核对存在性）。 */
export function dependencyBlockersOf(root: string, taskId: string): DependencyBlocker[] {
  const index = scheduleIndexOf(root);
  const entry = index.get(taskId);
  return entry === undefined ? [] : dependencyBlockers(entry, index);
}
