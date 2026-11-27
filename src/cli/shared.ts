import { locateProject } from "../application/host-hook.js";
import { readTask, type LoadedTask } from "../application/task-store.js";
import { readWorkflow } from "../application/project-config.js";
import type { WorktreeCleanup, WorktreeIntegration } from "../application/worktree.js";
import type { TaskRecord } from "../contracts/task.js";
import { currentStatus, type TaskDocument } from "../domain/task.js";
import type { WorkflowDefinition } from "../domain/workflow.js";

/** 面向用户的任务标识：`标题（id）`。 */
export function taskLabel(title: string, id: string): string {
  return `${title}（${id}）`;
}

export function projectRoot(dir: string): string {
  return locateProject(dir).root;
}

export function fail(problems: readonly string[]): void {
  process.stderr.write(problems.map((problem) => `${problem}\n`).join(""));
  process.exitCode = 1;
}

/** 有 `.knit/` 目录的项目根；没有时报错并返回 null。 */
export function knitRoot(dir: string): string | null {
  const project = locateProject(dir);
  if (project.initialized) return project.root;
  fail(["这个项目里没有 .knit/ 目录；运行 knit init 生成"]);
  return null;
}

/** 按 id 读出一个任务；项目、任务不存在或文件有格式问题时报错并返回 null。 */
export function loadTask(dir: string, id: string): LoadedTask | null {
  const root = knitRoot(dir);
  if (root === null) return null;
  const result = readTask(root, id);
  if (result.kind === "refused") {
    fail(result.problems);
    return null;
  }
  return result.task;
}

/** 显示用的状态；`stale` 表示文件里写着已确认，但确认之后需求被改过。 */
export function shownStatus(document: TaskDocument, record: TaskRecord): { text: string; stale: boolean } {
  const status = currentStatus(document, record);
  return {
    text: status === "active" ? `active(${document.frontmatter.stage})` : status,
    stale: status !== document.frontmatter.status,
  };
}

/** 读取并校验项目的流程文件；文件不存在或有问题时把原因写到标准错误，返回 null。 */
export function loadWorkflow(dir: string): WorkflowDefinition | null {
  const loaded = readWorkflow(projectRoot(dir));
  if (loaded.workflow === null) fail(loaded.problems);
  return loaded.workflow;
}

export function cleanupLines(root: string, cleanup: WorktreeCleanup): string[] {
  const worktree = cleanup.worktree;
  if (cleanup.kind === "absent") return [];
  if (cleanup.kind === "retained") {
    const reason = cleanup.failedAt === "status" ? "清理未完成" : "清理被 Git 拒绝";
    return [`${reason}，Worktree 和分支保留: ${worktree.path}（${worktree.branch}）`, cleanup.error.trimEnd()];
  }
  return [
    cleanup.kind === "removed" ? `已删除 Worktree: ${worktree.path}` : `Worktree 目录已不在: ${worktree.path}（已运行 git worktree prune）`,
    ...(cleanup.discardedFiles > 0 ? [`已丢弃未提交的改动（${cleanup.discardedFiles} 个文件）`] : []),
    ...(cleanup.branch === "deleted" ? [`已删除分支: ${worktree.branch}`] : []),
    ...(cleanup.branch === "retained" ? [`清理被 Git 拒绝，分支保留: ${worktree.branch}（主检出: ${root}）`, cleanup.error.trimEnd()] : []),
  ];
}

export function integrationLines(root: string, integration: WorktreeIntegration): string[] {
  const worktree = integration.worktree;
  const branches = `${worktree.branch} → ${integration.targetBranch}`;
  if (integration.merged) return [`已合并 ${branches}`, ...cleanupLines(root, integration.cleanup)];
  const abort = integration.abort;
  return [
    `合并没有成功: ${branches}`, integration.error.trimEnd(),
    ...(abort === null ? [] : abort.ok ? ["已放弃这次合并（git merge --abort）"] : ["放弃合并失败:", abort.error.trimEnd()]),
    `任务已经交付，提交保留在任务分支 ${worktree.branch}；Worktree 保留在 ${worktree.path}`,
    "由主会话把以上 Git 错误原样给用户看并问他怎么处理；不自己解决冲突，不强行合并",
  ];
}
