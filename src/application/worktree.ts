/**
 * 工作区签名：阶段前后比对，发现实际改动；检查者新增修复也据此核对。
 * 以 Git 状态列出的路径为范围，逐路径取内容指纹；`.knit/.runtime/` 不计。
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync } from "../infrastructure/process.js";
import { porcelainStatusPaths } from "./git-status.js";

export interface WorktreeSignature {
  entries: Record<string, string>;
  digest: string;
}

function signatureOf(root: string, paths: string[]): WorktreeSignature {
  const entries: Record<string, string> = {};
  for (const path of paths.sort()) {
    if (path === ".knit/.runtime" || path.startsWith(".knit/.runtime/")) continue;
    const full = join(root, path);
    try {
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) entries[path] = `link:${readlinkSync(full)}`;
      else if (stats.isFile()) entries[path] = `file:${sha256Bytes(readFileSync(full))}`;
      else if (stats.isDirectory()) entries[path] = "dir";
      else entries[path] = "other";
    } catch {
      entries[path] = "absent";
    }
  }
  return { entries, digest: sha256Text(JSON.stringify(entries)) };
}

/**
 * 当前 Git 可见改动路径（含未跟踪）；Git 不可用时返回 null，调用方不得宣称检查无副作用。
 * `extraPaths` 追加需要一并取指纹的路径（阶段收尾传入基线脏路径与基线提交以来的改动，见 stage-baseline）。
 */
export function worktreeSignature(
  root: string,
  git: (args: string[], cwd: string) => { code: number; stdout: string } = gitSync,
  extraPaths: readonly string[] = [],
): WorktreeSignature | null {
  const result = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  if (result.code !== 0) return null;
  return signatureOf(root, [...new Set([...porcelainStatusPaths(result.stdout), ...extraPaths])]);
}
