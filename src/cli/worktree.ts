import type { WorktreeCleanup, WorktreeIntegration } from "../application/worktree.js";

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
