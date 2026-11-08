/**
 * 失败残留（DESIGN §5.3、STATES §8）：失败／取消 run 留下的改动按任务记录，不进 scope。
 * 下一个 run 的报告列出残留路径即声明继承：指纹未变且原 run 由 write／edit 写入时沿用并入，
 * 其余（指纹已变、来源不明）按本 run 改动或交主会话确认。任务资料与 `.knit/` 受保护区不记残留。
 */
import type { ResidueEntry, ResidueFile, RunResultFile, SnapshotManifest } from "../contracts/run.js";
import type { ResidueFact } from "../domain/attribution.js";
import { gitSync } from "../infrastructure/process.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import type { RunStore } from "../infrastructure/run-store.js";
import { porcelainStatusPaths } from "./git-status.js";
import { currentEntry, entryDrifts } from "./scope.js";

type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string };

function residueEligible(path: string): boolean {
  return path !== "" && !path.startsWith(".knit/") && path !== ".knit";
}

/** 当前残留事实：指纹是否未变、原 run 是否工具写入；供阶段收尾分类。 */
export function residueFactsOf(executionDir: string, residue: ResidueFile | null): ResidueFact[] {
  return (residue?.entries ?? []).map((entry) => ({
    path: entry.path,
    current: !entryDrifts(executionDir, entry),
    toolWritten: entry.toolWritten,
  }));
}

/** 结果中的残留：实际差异与发布时指纹；toolWritten 依据结果的来源归属。 */
export function residueFromResult(result: RunResultFile): ResidueEntry[] {
  const attribution = result.attribution;
  const tool = new Set(attribution?.toolPaths ?? []);
  const isolated = attribution?.source === "isolated";
  const actual = new Set(result.actualChangedPaths);
  return (result.actualEntries ?? [])
    .filter((entry) => actual.has(entry.path) && residueEligible(entry.path))
    .map((entry) => ({
      ...entry,
      runId: result.runId,
      toolWritten: isolated || tool.has(entry.path),
    }));
}

/**
 * 没有结果的 run（worker 崩溃、确认已死后收敛）：以本 run 快照为基线比较当前工作区，
 * 变化路径记为来源不明的残留（toolWritten=false），继承时须主会话确认。
 */
export function residueFromSnapshot(
  executionDir: string,
  manifest: SnapshotManifest,
  runId: string,
  git: GitRunner = gitSync,
): ResidueEntry[] {
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const candidates = new Set<string>();
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], executionDir);
  if (status.code === 0) for (const path of porcelainStatusPaths(status.stdout)) candidates.add(path);
  if (manifest.base.head !== null) {
    const diff = git(["diff", "--name-only", "-z", "--no-renames", manifest.base.head, "--"], executionDir);
    if (diff.code === 0) for (const path of diff.stdout.split("\0")) if (path !== "") candidates.add(path);
  }
  // 快照时已脏（未引用 HEAD 基线）的路径与未跟踪路径：改回原样也要能看出变化。
  for (const entry of manifest.entries) if (entry.source !== "head" || entry.layer === "untracked") candidates.add(entry.path);
  const out: ResidueEntry[] = [];
  for (const path of [...candidates].sort()) {
    if (!residueEligible(path)) continue;
    const now = currentEntry(executionDir, path, { factsKind: true });
    const snap = byPath.get(path);
    let changed: boolean;
    if (snap === undefined) changed = !now.absent;
    else if (snap.absent) changed = !now.absent;
    else if (snap.kind === "submodule") changed = false;
    else if (snap.kind === "symlink") changed = now.factsKind !== "link" || now.digest !== snap.linkTarget;
    else changed = now.factsKind !== "file" || now.digest !== snap.digest;
    if (changed) out.push({ ...now, runId, toolWritten: false });
  }
  return out;
}

/** 合并残留：同路径以后来 run 为准；atomicWrite 版本冲突时重读重试一次。 */
export function recordResidue(runs: RunStore, taskId: string, entries: ResidueEntry[], now: string): void {
  if (entries.length === 0) return;
  update(runs, taskId, now, (current) => {
    const map = new Map(current.map((entry) => [entry.path, entry]));
    for (const entry of entries) map.set(entry.path, entry);
    return [...map.values()];
  });
}

/** 消费残留：并入 scope 或被确认排除的路径从任务残留中移除；幂等。 */
export function consumeResidue(runs: RunStore, taskId: string, paths: readonly string[], now: string): void {
  if (paths.length === 0) return;
  const drop = new Set(paths);
  update(runs, taskId, now, (current) => current.filter((entry) => !drop.has(entry.path)));
}

function update(runs: RunStore, taskId: string, now: string, change: (entries: ResidueEntry[]) => ResidueEntry[]): void {
  for (let attempt = 0; ; attempt += 1) {
    const current = runs.readResidue(taskId);
    const before = current?.entries ?? [];
    const after = change(before).sort((a, b) => a.path.localeCompare(b.path));
    if (current === null && after.length === 0) return;
    if (current !== null && JSON.stringify(before) === JSON.stringify(after)) return;
    try {
      runs.writeResidue(taskId, { schemaVersion: 1, taskId, entries: after, updatedAt: now });
      return;
    } catch (error) {
      if (attempt > 0 || !(error instanceof InfrastructureError && error.code === "version_conflict")) throw error;
    }
  }
}
