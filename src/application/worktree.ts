import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gitSync } from "../infrastructure/process.js";

export interface TaskWorktree {
  readonly path: string;
  readonly branch: string;
}

/** 位置和分支由主检出的真实路径、任务目录名计算，不存绑定关系。 */
export function taskWorktree(root: string, taskDir: string): TaskWorktree {
  const realRoot = realpathSync(root);
  return {
    path: join(
      resolve(realRoot, process.env.KNIT_HOME || join(homedir(), ".knit")),
      "worktrees",
      `${basename(realRoot)}-${createHash("sha256").update(realRoot).digest("hex").slice(0, 8)}`,
      basename(taskDir),
    ),
    branch: `knit/${basename(taskDir)}`,
  };
}

export interface PreparedWorktree {
  readonly problems: readonly string[];
  readonly created: boolean;
  readonly branchCreated: boolean;
}

/** 非交接的派发校验通过后调用；已有目录复用，丢失目录按原分支重建。 */
export function ensureWorktree(root: string, worktree: TaskWorktree): PreparedWorktree {
  if (existsSync(join(worktree.path, ".git"))) return { problems: [], created: false, branchCreated: false };
  const branchExists = gitSync(["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`], root).code === 0;
  const pruned = branchExists ? gitSync(["worktree", "prune"], root) : null;
  if (pruned !== null && pruned.code !== 0) return { problems: [pruned.stderr.trimEnd()], created: false, branchCreated: false };
  const added = gitSync(
    branchExists
      ? ["worktree", "add", worktree.path, worktree.branch]
      : ["worktree", "add", "-b", worktree.branch, worktree.path, "HEAD"],
    root,
  );
  return added.code === 0
    ? { problems: [], created: true, branchCreated: !branchExists }
    : { problems: [added.stderr.trimEnd()], created: false, branchCreated: false };
}

/** 派发被拒绝时只撤回这次新建的目录和分支；运行过准备命令后强制删除它留下的文件。 */
export function rollbackWorktree(root: string, worktree: TaskWorktree, prepared: PreparedWorktree, force = false): string[] {
  if (!prepared.created) return [];
  const removed = gitSync(["worktree", "remove", ...(force ? ["--force"] : []), worktree.path], root);
  if (removed.code !== 0) return [removed.stderr.trimEnd()];
  if (!prepared.branchCreated) return [];
  const deleted = gitSync(["branch", "-D", worktree.branch], root);
  return deleted.code === 0 ? [] : [deleted.stderr.trimEnd()];
}

/** 交付已经成功；后续失败只报告，不撤回交付，也不强制清理。 */
export function mergeAndCleanWorktree(root: string, worktree: TaskWorktree, targetBranch: string): {
  readonly merged: boolean;
  readonly lines: readonly string[];
} {
  const merged = gitSync(["merge", "--no-edit", worktree.branch], root);
  if (merged.code !== 0) {
    // 覆盖本地改动等拒绝不会进入合并状态，不能对它运行 --abort。
    const aborted = gitSync(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], root).code === 0
      ? gitSync(["merge", "--abort"], root)
      : null;
    return {
      merged: false,
      lines: [
        `合并没有成功: ${worktree.branch} → ${targetBranch}`,
        (merged.stdout + merged.stderr).trimEnd(),
        ...(aborted === null ? [] : aborted.code === 0
          ? ["已放弃这次合并（git merge --abort）"]
          : ["放弃合并失败:", (aborted.stdout + aborted.stderr).trimEnd()]),
        `任务已经交付，提交保留在任务分支 ${worktree.branch}；Worktree 保留在 ${worktree.path}`,
        "由主会话把以上 Git 错误原样给用户看并问他怎么处理；不自己解决冲突，不强行合并",
      ],
    };
  }
  const removed = gitSync(["worktree", "remove", worktree.path], root);
  if (removed.code !== 0) {
    return {
      merged: true,
      lines: [
        `已合并 ${worktree.branch} → ${targetBranch}`,
        `清理被 Git 拒绝，Worktree 和分支保留: ${worktree.path}（${worktree.branch}）`,
        (removed.stdout + removed.stderr).trimEnd(),
      ],
    };
  }
  const deleted = gitSync(["branch", "-d", worktree.branch], root);
  return {
    merged: true,
    lines: [
      `已合并 ${worktree.branch} → ${targetBranch}`,
      `已删除 Worktree: ${worktree.path}`,
      ...(deleted.code === 0
        ? [`已删除分支: ${worktree.branch}`]
        : [`清理被 Git 拒绝，分支保留: ${worktree.branch}（主检出: ${root}）`, (deleted.stdout + deleted.stderr).trimEnd()]),
    ],
  };
}
