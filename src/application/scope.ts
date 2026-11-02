/**
 * 成果 scope：按 Task 累积、路径带当前指纹（DESIGN.md 5.3、9.3）。
 * scope 只记录已接收实施实际产生的路径；恢复与换会话不重置。
 * 新条目指纹含路径、类型、模式和内容；无类型字段的旧记录按原语义仅核内容（任务027）。
 */
import type { ScopeFile } from "../contracts/run.js";
import { digestOf, fileFacts, sha256Bytes } from "../infrastructure/fingerprint.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";

export type ScopeFactsKind = "file" | "directory" | "link" | "absent";

export interface ScopeEntry {
  path: string;
  digest: string | null;
  absent: boolean;
  /** 指纹种类；缺省视为 file（旧记录），link 条目的 digest 为目标字符串。 */
  factsKind?: ScopeFactsKind;
  /** 八进制模式；目录／缺失为 null。 */
  mode?: string | null;
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

/**
 * 当前路径指纹（DESIGN §5.3：路径、类型、模式和内容）。
 * options.factsKind 为 true 时条目带类型与模式；缺省仅内容摘要，类型缺省视为 file。
 */
export function currentEntry(root: string, relativePath: string, options: { factsKind?: boolean } = {}): ScopeEntry {
  const normalized = normalizeRoot(root);
  const path = `${normalized}/${relativePath}`;
  try {
    const facts = fileFacts(path);
    if (facts.kind === "absent") {
      return options.factsKind
        ? { path: relativePath, digest: null, absent: true, factsKind: "absent", mode: null }
        : { path: relativePath, digest: null, absent: true };
    }
    if (options.factsKind) {
      const digest =
        facts.kind === "directory" ? digestOf({ childCount: facts.childCount })
        : facts.kind === "link" ? facts.mode
        : facts.sha256;
      return { path: relativePath, digest, absent: false, factsKind: facts.kind, mode: facts.kind === "link" ? null : facts.mode };
    }
    if (facts.kind === "directory") return { path: relativePath, digest: digestOf({ directory: facts.childCount }), absent: false };
    return { path: relativePath, digest: facts.sha256, absent: false };
  } catch {
    return options.factsKind
      ? { path: relativePath, digest: null, absent: true, factsKind: "absent", mode: null }
      : { path: relativePath, digest: null, absent: true };
  }
}

/** 合并本次实际改动；同路径后来版本覆盖旧条目，但 scopeRunIds 保留历史。 */
export function mergeScope(
  previous: ScopeFile,
  input: { runId: string; taskId: string; paths: string[]; root: string; now: string },
): ScopeFile {
  const entries = new Map(previous.entries.map((entry) => [entry.path, entry]));
  for (const path of input.paths) {
    entries.set(path, currentEntry(input.root, path, { factsKind: true }));
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

/**
 * 已发布条目与当前事实对比：文件须同字节同模式，目录须同子项数，链接须同目标。
 * 无 factsKind 的旧条目按原语义仅核内容（stat 沿链接），升级不追溯失效（任务027）。
 */
export function entryDrifts(root: string, entry: ScopeEntry): boolean {
  const current = entry.factsKind === undefined ? legacyEntry(root, entry.path) : currentEntry(root, entry.path, { factsKind: true });
  if (current.absent || entry.absent) return current.absent !== entry.absent;
  if (entry.factsKind !== undefined) {
    if (current.factsKind !== entry.factsKind) return true;
    if (entry.factsKind !== "file") return current.digest !== entry.digest;
    if (current.digest !== entry.digest) return true;
    return entry.mode !== undefined && current.mode !== entry.mode;
  }
  return current.digest !== entry.digest;
}

export function scopeEntriesCurrent(root: string, entries: ScopeEntry[]): boolean {
  return entries.every((entry) => !entryDrifts(root, entry));
}

/** 旧版条目语义：stat 沿符号链接读内容，目录按子项数，缺失记 absent；仅用于无 factsKind 的存量记录。 */
function legacyEntry(root: string, relativePath: string): ScopeEntry {
  const path = `${normalizeRoot(root)}/${relativePath}`;
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return { path: relativePath, digest: digestOf({ directory: readdirSync(path).length }), absent: false };
    }
    return { path: relativePath, digest: sha256Bytes(readFileSync(path)), absent: false };
  } catch {
    return { path: relativePath, digest: null, absent: true };
  }
}

/** 字节指纹（供检查前后比对等调用方使用）。 */
export function digestBytes(data: Uint8Array): string {
  return sha256Bytes(data);
}
