/**
 * 成果 scope：按 Task 累积、路径带当前指纹（DESIGN.md 5.3、9.3）。
 * scope 只记录已接收实施实际产生的路径；恢复与换会话不重置。
 */
import type { ScopeFile } from "../contracts/run.js";
import { digestOf, fileFacts, sha256Bytes } from "../infrastructure/fingerprint.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";

export interface ScopeEntry {
  path: string;
  digest: string | null;
  absent: boolean;
}

export function scopeDigest(entries: ScopeEntry[]): string {
  return digestOf(Object.fromEntries(entries.map((entry) => [entry.path, entry.absent ? "absent" : entry.digest])));
}

export function emptyScope(taskId: string, now: string): ScopeFile {
  return { schemaVersion: 1, taskId, runIds: [], entries: [], digest: scopeDigest([]), updatedAt: now };
}

export function loadScope(store: RunStore, taskId: string, now: string): ScopeFile {
  return store.readScope(taskId) ?? emptyScope(taskId, now);
}

/** 当前路径指纹；符号链接按目标字符串，文件按字节，缺失记 absent。 */
export function currentEntry(root: string, relativePath: string): ScopeEntry {
  const normalized = normalizeRoot(root);
  const path = `${normalized}/${relativePath}`;
  try {
    const facts = fileFacts(path);
    if (facts.kind === "absent") return { path: relativePath, digest: null, absent: true };
    if (facts.kind === "directory") return { path: relativePath, digest: digestOf({ directory: facts.childCount }), absent: false };
    return { path: relativePath, digest: facts.sha256, absent: false };
  } catch {
    return { path: relativePath, digest: null, absent: true };
  }
}

/** 合并本次实际改动；同路径后来版本覆盖旧条目，但 scopeRunIds 保留历史。 */
export function mergeScope(
  previous: ScopeFile,
  input: { runId: string; taskId: string; paths: string[]; root: string; now: string },
): ScopeFile {
  const entries = new Map(previous.entries.map((entry) => [entry.path, entry]));
  for (const path of input.paths) {
    const entry = currentEntry(input.root, path);
    entries.set(path, { path: entry.path, digest: entry.digest, absent: entry.absent });
  }
  const sorted = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  const runIds = previous.runIds.includes(input.runId) ? previous.runIds : [...previous.runIds, input.runId];
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    runIds,
    entries: sorted,
    digest: scopeDigest(sorted),
    updatedAt: input.now,
  };
}

/** 字节指纹（供检查前后比对等调用方使用）。 */
export function digestBytes(data: Uint8Array): string {
  return sha256Bytes(data);
}
