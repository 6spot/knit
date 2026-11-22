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

export type WorktreeCleanup = { readonly worktree: TaskWorktree } & (
  | { kind: "absent" }
  | { kind: "retained"; failedAt: "status" | "remove"; error: string }
  | { kind: "removed" | "pruned"; discardedFiles: number; branch: "absent" | "deleted" }
  | { kind: "removed" | "pruned"; discardedFiles: number; branch: "retained"; error: string }
);

/** 取消并归档成功之后强制清理；Git 拒绝时只报告，不能撤回取消。 */
export function cleanCancelledWorktree(root: string, worktree: TaskWorktree): WorktreeCleanup {
  const present = existsSync(worktree.path);
  const branchExists = gitSync(["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`], root).code === 0;
  if (!present && !branchExists) return { kind: "absent", worktree };
  // NUL 分隔支持文件名中的换行；逐个列出未跟踪文件，不把目录算作一个文件。
  const status = present ? gitSync(["status", "--porcelain=v1", "--no-renames", "--untracked-files=all", "-z"], worktree.path) : null;
  if (status !== null && status.code !== 0) {
    return { kind: "retained", worktree, failedAt: "status", error: status.stdout + status.stderr };
  }
  const removed = gitSync(present ? ["worktree", "remove", "--force", worktree.path] : ["worktree", "prune"], root);
  if (removed.code !== 0) {
    return { kind: "retained", worktree, failedAt: "remove", error: removed.stdout + removed.stderr };
  }
  const changedFiles = status?.stdout.split("\0").filter((entry) => entry !== "").length ?? 0;
  return cleanBranch(root, worktree, present ? "removed" : "pruned", changedFiles, branchExists ? "-D" : null);
}

function cleanBranch(root: string, worktree: TaskWorktree, kind: "removed" | "pruned", discardedFiles: number, flag: "-d" | "-D" | null): WorktreeCleanup {
  if (flag === null) return { kind, worktree, discardedFiles, branch: "absent" };
  const deleted = gitSync(["branch", flag, worktree.branch], root);
  return deleted.code === 0
    ? { kind, worktree, discardedFiles, branch: "deleted" }
    : { kind, worktree, discardedFiles, branch: "retained", error: deleted.stdout + deleted.stderr };
}

export type WorktreeIntegration = { readonly targetBranch: string; readonly worktree: TaskWorktree } & (
  | { merged: true; cleanup: WorktreeCleanup }
  | { merged: false; error: string; abort: { ok: true } | { ok: false; error: string } | null }
);

/** 交付已经成功；后续失败只报告，不撤回交付，也不强制清理。 */
export function mergeAndCleanWorktree(root: string, worktree: TaskWorktree, targetBranch: string): WorktreeIntegration {
  const merged = gitSync(["merge", "--no-edit", worktree.branch], root);
  if (merged.code !== 0) {
    // 覆盖本地改动等拒绝不会进入合并状态，不能对它运行 --abort。
    const aborted = gitSync(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], root).code === 0
      ? gitSync(["merge", "--abort"], root)
      : null;
    return {
      merged: false, worktree, targetBranch, error: merged.stdout + merged.stderr,
      abort: aborted === null ? null : aborted.code === 0 ? { ok: true } : { ok: false, error: aborted.stdout + aborted.stderr },
    };
  }
  const removed = gitSync(["worktree", "remove", worktree.path], root);
  return {
    merged: true, worktree, targetBranch,
    cleanup: removed.code === 0 ? cleanBranch(root, worktree, "removed", 0, "-d")
      : { kind: "retained", worktree, failedAt: "remove", error: removed.stdout + removed.stderr },
  };
}
