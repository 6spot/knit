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

/** 只在所有派发校验通过之后调用；已有目录复用，丢失目录按原分支重建。 */
export function ensureWorktree(root: string, worktree: TaskWorktree): string[] {
  if (existsSync(join(worktree.path, ".git"))) return [];
  const branchExists = gitSync(["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`], root).code === 0;
  const pruned = branchExists ? gitSync(["worktree", "prune"], root) : null;
  if (pruned !== null && pruned.code !== 0) return [pruned.stderr.trimEnd()];
  const added = gitSync(
    branchExists
      ? ["worktree", "add", worktree.path, worktree.branch]
      : ["worktree", "add", "-b", worktree.branch, worktree.path, "HEAD"],
    root,
  );
  return added.code === 0 ? [] : [added.stderr.trimEnd()];
}
