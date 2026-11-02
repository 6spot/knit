/**
 * 工作区签名：检查前后比对，发现检查者改动代码／文件（DESIGN.md 5.1）。
 * 以 Git 状态列出的路径为范围，逐路径取内容指纹；`.knit/.runtime/` 不计。
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync } from "../infrastructure/process.js";

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

/** 当前 Git 可见改动路径（含未跟踪）；Git 不可用时返回 null，调用方不得宣称检查无副作用。 */
export function worktreeSignature(root: string, git = gitSync): WorktreeSignature | null {
  const result = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  if (result.code !== 0) return null;
  const parts = result.stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    paths.push(path);
    if (status.includes("R") || status.includes("C")) {
      const original = parts[index + 1];
      if (original !== undefined && original !== "") paths.push(original);
      index += 1;
    }
  }
  return signatureOf(root, paths);
}
