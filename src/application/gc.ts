/**
 * 引用核验的存储回收（`knit gc`）：默认只读预览，`--apply` 才删除。
 * 候选只来自三类可恢复证据：中断快照临时目录、未被 Session 索引引用的原生会话目录、
 * 无任务资料／元数据引用且已终态的 run。其它 runtime 资料一律不碰；
 * 不使用目录年龄或日志静默推断无用，也不清理 diagnostics。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LockManager, type LockStatus } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { atomicWrite } from "../infrastructure/atomic.js";
import { withReadOnlyDatabase } from "../infrastructure/sqlite-readonly.js";

const RUNTIME = join(".knit", ".runtime");
const NATIVE_SESSIONS_DIR = join(RUNTIME, "pi-sessions");
const GC_DIR = join(RUNTIME, "gc");
const LAST_RECORD = join(GC_DIR, "last.json");
const RUN_ID = /^run-[0-9a-f]{12}$/;
const TMP_PREFIX = "snapshot.tmp-";
const RUN_ID_IN_TEXT = /run-[0-9a-f]{12}/g;
const TERMINAL_RUN_STATES = new Set(["completed", "cancelled", "failed"]);

export type GcCandidateKind = "snapshot-tmp" | "native-session" | "run";
export type GcItemStatus = "removed" | "skipped" | "failed";

export interface GcCandidate {
  kind: GcCandidateKind;
  /** 项目相对路径（POSIX 分隔符），不输出绝对路径。 */
  path: string;
  sizeBytes: number;
  reason: string;
  evidence: string[];
}

export interface GcSkipped {
  kind: GcCandidateKind;
  path: string;
  sizeBytes: number;
  reason: string;
  evidence: string[];
}

export interface GcCounts {
  candidates: number;
  removed: number;
  skipped: number;
  failed: number;
  byKind: Record<GcCandidateKind, number>;
}

export interface GcPolicy {
  version: 1;
  snapshotTmp: string;
  nativeSessions: string;
  runs: string;
  age: "disabled";
  diagnostics: "out_of_scope";
}

export const GC_POLICY: GcPolicy = {
  version: 1,
  snapshotTmp: "仅回收 run 内 snapshot.tmp-*；manifest 非 preparing 且项目快照锁未持有",
  nativeSessions: "仅回收 pi-sessions 下未被 SQLite sessions 表任何行引用的目录；索引不可读视为未知",
  runs: "仅回收无 task.md 记录区／metadata bindings／operations 引用且状态为终态的 run；非终态或不可判定不收集",
  age: "disabled",
  diagnostics: "out_of_scope",
};

export interface GcScanResult {
  projectRoot: string;
  generatedAt: string;
  candidates: GcCandidate[];
  skipped: GcSkipped[];
  counts: GcCounts;
}

export interface GcPreviewResult extends GcScanResult {
  mode: "preview";
  apply: false;
  policy: GcPolicy;
}

export interface GcApplyItem extends GcCandidate {
  status: GcItemStatus;
  /** removed 时为判定理由；skipped／failed 时为原因。 */
  outcomeReason: string;
}

export interface GcApplyRecord {
  schemaVersion: 1;
  projectRoot: string;
  mode: "apply";
  startedAt: string;
  finishedAt: string;
  policy: GcPolicy;
  state: "completed" | "partial";
  counts: GcCounts;
  removed: GcCandidate[];
  skipped: GcSkipped[];
  failed: GcSkipped[];
  /** 逐项最终结果；中断后未处理项也在此列为 skipped。 */
  items: GcApplyItem[];
}

export interface GcApplyResult extends GcApplyRecord {
  recordPath: string;
}

export interface GcServiceOptions {
  /** 测试或调用方注入锁管理器；未提供时按 locksRoot／默认锁根创建。 */
  locks?: LockManager;
  now?: () => Date;
  /** 测试注入删除；默认递归删除候选目录。 */
  remove?: (absolutePath: string) => void;
}

export interface GcScanInput {
  dir: string;
  locksRoot?: string;
  locks?: LockManager;
  /** apply 自己持有的项目锁 token：重新核验时不能把它当成外部快照锁。 */
  ownProjectLockToken?: string;
  now?: () => Date;
}

interface MetadataSessionRow {
  nativeSessionId: string | null;
  recordNativeSessionId: string | null;
  sessionFile: string | null;
}

interface MetadataIndex {
  present: boolean;
  available: boolean;
  reason: string | null;
  sessions: MetadataSessionRow[];
  bindings: Array<{ id: string; text: string }>;
  operations: Array<{ id: string; text: string }>;
}

interface TaskReferenceScan {
  ok: boolean;
  scanned: number;
  refs: Map<string, string[]>;
  reason: string | null;
}

interface RunStateView {
  state: string | null;
  reason: string;
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** 规范项目根下的真实目录：拒绝由符号链接祖先指向项目外的候选。 */
function canonicalDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function fileBytes(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

function treeStats(path: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += fileBytes(child);
      }
    }
  };
  walk(path);
  return { files, bytes };
}

function readJsonObject(path: string): { exists: boolean; value: Record<string, unknown> | null } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, value: null };
    return { exists: true, value: null };
  }
  try {
    const raw: unknown = JSON.parse(text);
    return { exists: true, value: typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null };
  } catch {
    return { exists: true, value: null };
  }
}

function extractRunIds(text: string): string[] {
  return [...text.matchAll(RUN_ID_IN_TEXT)].map((match) => match[0]);
}

function metadataRecordSessionFile(record: string): { nativeSessionId: string | null; sessionFile: string | null } {
  try {
    const raw: unknown = JSON.parse(record);
    if (typeof raw !== "object" || raw === null) return { nativeSessionId: null, sessionFile: null };
    const object = raw as Record<string, unknown>;
    const ref = typeof object.ref === "object" && object.ref !== null ? (object.ref as Record<string, unknown>) : null;
    return {
      nativeSessionId: typeof ref?.nativeSessionId === "string" ? ref.nativeSessionId : null,
      sessionFile: typeof object.sessionFile === "string" ? object.sessionFile : null,
    };
  } catch {
    return { nativeSessionId: null, sessionFile: null };
  }
}

function readMetadataIndex(root: string): MetadataIndex {
  const path = join(root, RUNTIME, "metadata.db");
  if (!existsSync(path)) {
    return { present: false, available: true, reason: null, sessions: [], bindings: [], operations: [] };
  }
  try {
    return withReadOnlyDatabase(path, (db) => {
      const sessionRows = db.prepare("SELECT native_session_id, record FROM sessions").all() as Array<{
        native_session_id?: unknown;
        record?: unknown;
      }>;
      const bindingRows = db.prepare("SELECT task_id, record FROM bindings").all() as Array<{ task_id?: unknown; record?: unknown }>;
      const operationRows = db.prepare("SELECT operation_id, record FROM operations").all() as Array<{
        operation_id?: unknown;
        record?: unknown;
      }>;
      const sessions = sessionRows.map((row) => {
        const record = typeof row.record === "string" ? row.record : JSON.stringify(row.record ?? null);
        const parsed = metadataRecordSessionFile(record);
        return {
          nativeSessionId: typeof row.native_session_id === "string" ? row.native_session_id : null,
          recordNativeSessionId: parsed.nativeSessionId,
          sessionFile: parsed.sessionFile,
        };
      });
      const bindings = bindingRows.map((row) => ({
        id: typeof row.task_id === "string" ? row.task_id : "unknown",
        text: typeof row.record === "string" ? row.record : JSON.stringify(row.record ?? null),
      }));
      const operations = operationRows.map((row) => ({
        id: typeof row.operation_id === "string" ? row.operation_id : "unknown",
        text: typeof row.record === "string" ? row.record : JSON.stringify(row.record ?? null),
      }));
      return { present: true, available: true, reason: null, sessions, bindings, operations };
    });
  } catch (error) {
    return {
      present: true,
      available: false,
      reason: `metadata.db 无法只读核实: ${error instanceof Error ? error.message : String(error)}`,
      sessions: [],
      bindings: [],
      operations: [],
    };
  }
}

/** 只扫描任务入口 task.md；读失败意味着无法证明“无引用”，由调用方按未知处理。 */
function scanTaskReferences(root: string): TaskReferenceScan {
  const refs = new Map<string, string[]>();
  let scanned = 0;
  let problem: string | null = null;
  const visit = (dir: string): void => {
    if (problem !== null) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        problem = `任务目录无法读取: ${relativePath(root, dir)}: ${error instanceof Error ? error.message : String(error)}`;
      }
      return;
    }
    for (const entry of entries) {
      if (problem !== null) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile() && entry.name === "task.md") {
        let text: string;
        try {
          text = readFileSync(child, "utf8");
        } catch (error) {
          problem = `task.md 无法读取: ${relativePath(root, child)}: ${error instanceof Error ? error.message : String(error)}`;
          return;
        }
        scanned += 1;
        for (const runId of extractRunIds(text)) {
          const evidence = `task.md:${relativePath(root, child)}`;
          const list = refs.get(runId) ?? [];
          if (!list.includes(evidence)) list.push(evidence);
          refs.set(runId, list);
        }
      }
    }
  };
  visit(join(root, ".knit", "tasks"));
  return { ok: problem === null, scanned, refs, reason: problem };
}

function metadataRunReferences(index: MetadataIndex): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const add = (runId: string, evidence: string): void => {
    const list = refs.get(runId) ?? [];
    if (!list.includes(evidence)) list.push(evidence);
    refs.set(runId, list);
  };
  for (const binding of index.bindings) {
    for (const runId of extractRunIds(binding.text)) add(runId, `bindings:${binding.id}`);
  }
  for (const operation of index.operations) {
    for (const runId of extractRunIds(operation.text)) add(runId, `operations:${operation.id}`);
    for (const runId of extractRunIds(operation.id)) add(runId, `operations:${operation.id}`);
  }
  return refs;
}

function sessionDirectoryReferenced(root: string, dirName: string, dirPath: string, index: MetadataIndex): boolean {
  for (const session of index.sessions) {
    const ids = [session.nativeSessionId, session.recordNativeSessionId].filter((value): value is string => value !== null && value !== "");
    if (ids.some((id) => dirName === id || dirName.includes(id))) return true;
    if (session.sessionFile === null || session.sessionFile === "") continue;
    const resolved = isAbsolute(session.sessionFile) ? resolve(session.sessionFile) : resolve(root, session.sessionFile);
    const inside = relative(dirPath, resolved);
    if (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) return true;
  }
  return false;
}

function readRunState(runDir: string): RunStateView {
  const file = join(runDir, "state.json");
  const parsed = readJsonObject(file);
  if (!parsed.exists) return { state: null, reason: "state.json 缺失" };
  if (parsed.value === null) return { state: null, reason: "state.json 不可解析" };
  const state = typeof parsed.value.state === "string" ? parsed.value.state : null;
  if (state === null) return { state: null, reason: "state.json 缺少 state 字段" };
  return { state, reason: `state=${state}` };
}

function readSnapshotState(directory: string): { state: string | null; problem: string | null } {
  const parsed = readJsonObject(join(directory, "manifest.json"));
  if (!parsed.exists) return { state: null, problem: null };
  if (parsed.value === null) return { state: null, problem: "manifest.json 不可解析" };
  const state = typeof parsed.value.state === "string" ? parsed.value.state : null;
  if (state === null) return { state: null, problem: "manifest.json 缺少 state 字段" };
  return { state, problem: null };
}

function projectLockStatus(root: string, locks: LockManager, ownProjectLockToken: string | undefined): { held: boolean; detail: string } {
  let status: LockStatus;
  try {
    status = locks.inspect({ scope: "project", rawKey: root });
  } catch (error) {
    return { held: true, detail: `项目锁无法核实: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!status.exists) return { held: false, detail: "项目锁未持有" };
  if (status.owner === null) return { held: true, detail: "项目锁存在但 owner 不可核实" };
  if (ownProjectLockToken !== undefined && status.owner.token === ownProjectLockToken) {
    return { held: false, detail: "本项目锁由本次 gc 持有，不阻塞快照临时目录回收" };
  }
  if (status.processVerdict === "not_alive") return { held: false, detail: "项目锁 owner 已不存活（残留锁不视为快照进行中）" };
  return {
    held: true,
    detail: `项目锁由 ${status.owner.action} 持有 (pid=${status.owner.pid}, ${status.processVerdict})`,
  };
}

function emptyCounts(): GcCounts {
  return { candidates: 0, removed: 0, skipped: 0, failed: 0, byKind: { "snapshot-tmp": 0, "native-session": 0, run: 0 } };
}

function candidateCounts(candidates: GcCandidate[]): GcCounts {
  const counts = emptyCounts();
  counts.candidates = candidates.length;
  for (const candidate of candidates) counts.byKind[candidate.kind] += 1;
  return counts;
}

function lockManagerFor(input: { locks?: LockManager; locksRoot?: string }): LockManager {
  return input.locks ?? new LockManager(input.locksRoot === undefined ? {} : { root: input.locksRoot });
}

function scanSnapshotTemporary(
  root: string,
  locks: LockManager,
  ownProjectLockToken: string | undefined,
  candidates: GcCandidate[],
  skipped: GcSkipped[],
): void {
  const store = new RunStore(root);
  for (const runId of store.listRunIds()) {
    const runDir = store.runDir(runId);
    if (!canonicalDirectory(runDir)) continue;
    let entries;
    try {
      entries = readdirSync(runDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith(TMP_PREFIX)).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(runDir, entry.name);
      const path = relativePath(root, absolute);
      const sizeBytes = treeStats(absolute).bytes;
      const manifest = readSnapshotState(runDir);
      const tmpManifest = readSnapshotState(absolute);
      const lock = projectLockStatus(root, locks, ownProjectLockToken);
      const evidence = [
        `run=${runId}`,
        `snapshot manifest=${manifest.state ?? "缺失"}${manifest.problem === null ? "" : `（${manifest.problem}）`}`,
        `临时目录 manifest=${tmpManifest.state ?? "缺失"}${tmpManifest.problem === null ? "" : `（${tmpManifest.problem}）`}`,
        lock.detail,
      ];
      if (manifest.problem !== null) {
        skipped.push({ kind: "snapshot-tmp", path, sizeBytes, reason: `快照 manifest 不可判定，不收集（${manifest.problem}）`, evidence });
        continue;
      }
      if (tmpManifest.problem !== null) {
        skipped.push({ kind: "snapshot-tmp", path, sizeBytes, reason: `临时目录 manifest 不可判定，不收集（${tmpManifest.problem}）`, evidence });
        continue;
      }
      if (manifest.state === "preparing" || tmpManifest.state === "preparing") {
        skipped.push({ kind: "snapshot-tmp", path, sizeBytes, reason: "快照正在准备（manifest=preparing），不收集", evidence });
        continue;
      }
      if (lock.held) {
        skipped.push({ kind: "snapshot-tmp", path, sizeBytes, reason: `项目快照锁被持有，不收集（${lock.detail}）`, evidence });
        continue;
      }
      candidates.push({
        kind: "snapshot-tmp",
        path,
        sizeBytes,
        reason: "中断遗留的 snapshot 临时目录；该 run 无进行中快照",
        evidence,
      });
    }
  }
}

function scanNativeSessions(root: string, index: MetadataIndex, candidates: GcCandidate[], skipped: GcSkipped[]): void {
  const nativeRoot = join(root, NATIVE_SESSIONS_DIR);
  if (!canonicalDirectory(nativeRoot)) return;
  let entries;
  try {
    entries = readdirSync(nativeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of directories) {
    const absolute = join(nativeRoot, entry.name);
    const path = relativePath(root, absolute);
    const sizeBytes = treeStats(absolute).bytes;
    if (!index.present) {
      skipped.push({
        kind: "native-session",
        path,
        sizeBytes,
        reason: "Session 索引不存在，无法核实引用；未知不收集",
        evidence: [`metadata.db 缺失`, `目录=${entry.name}`],
      });
      continue;
    }
    if (!index.available) {
      skipped.push({
        kind: "native-session",
        path,
        sizeBytes,
        reason: `Session 索引不可读，未知不收集${index.reason === null ? "" : `（${index.reason}）`}`,
        evidence: [`sessions 表不可读`, `目录=${entry.name}`],
      });
      continue;
    }
    if (sessionDirectoryReferenced(root, entry.name, absolute, index)) {
      continue;
    }
    candidates.push({
      kind: "native-session",
      path,
      sizeBytes,
      reason: "pi-sessions 下未被 Session 索引任何行引用的目录",
      evidence: [`sessions 索引可读：${index.sessions.length} 行，0 行引用`, `目录=${entry.name}`],
    });
  }
}

function scanRuns(
  root: string,
  index: MetadataIndex,
  taskScan: TaskReferenceScan,
  candidates: GcCandidate[],
  skipped: GcSkipped[],
): void {
  const store = new RunStore(root);
  const metadataRefs = index.available ? metadataRunReferences(index) : new Map<string, string[]>();
  const references = new Map<string, string[]>();
  for (const [runId, evidence] of taskScan.refs) references.set(runId, [...evidence]);
  for (const [runId, evidence] of metadataRefs) {
    const list = references.get(runId) ?? [];
    for (const item of evidence) if (!list.includes(item)) list.push(item);
    references.set(runId, list);
  }
  const scanProblem = !taskScan.ok
    ? taskScan.reason ?? "任务资料引用不可判定"
    : !index.available
      ? index.reason ?? "metadata 引用不可判定"
      : null;
  for (const runId of store.listRunIds()) {
    const absolute = store.runDir(runId);
    const path = relativePath(root, absolute);
    if (!canonicalDirectory(absolute)) {
      skipped.push({
        kind: "run",
        path,
        sizeBytes: 0,
        reason: "run 目录经符号链接或无法核实为项目内真实目录，不收集",
        evidence: [`run=${runId}`],
      });
      continue;
    }
    const sizeBytes = treeStats(absolute).bytes;
    if (scanProblem !== null) {
      skipped.push({
        kind: "run",
        path,
        sizeBytes,
        reason: `任务资料／元数据引用不可判定，未知不收集（${scanProblem}）`,
        evidence: [`run=${runId}`, scanProblem],
      });
      continue;
    }
    const found = references.get(runId);
    const state = readRunState(absolute);
    if (state.state === null) {
      skipped.push({
        kind: "run",
        path,
        sizeBytes,
        reason: `运行状态不可判定，未知不收集（${state.reason}）`,
        evidence: [`run=${runId}`, state.reason, ...(found ?? []).map((item) => `引用:${item}`)],
      });
      continue;
    }
    if (!TERMINAL_RUN_STATES.has(state.state)) {
      skipped.push({
        kind: "run",
        path,
        sizeBytes,
        reason: `运行状态 ${state.state} 非终态，活跃／未知，不收集`,
        evidence: [`run=${runId}`, `state=${state.state}`, ...(found ?? []).map((item) => `引用:${item}`)],
      });
      continue;
    }
    if (found !== undefined && found.length > 0) {
      // 被活动／归档任务或元数据引用：终态也保留，不列为候选。
      continue;
    }
    candidates.push({
      kind: "run",
      path,
      sizeBytes,
      reason: `终态 run（${state.state}），任务资料与 metadata 均无引用`,
      evidence: [
        `run=${runId}`,
        `state=${state.state}`,
        `task.md 扫描 ${taskScan.scanned} 个，无引用`,
        `bindings 扫描 ${index.bindings.length} 行，无引用`,
        `operations 扫描 ${index.operations.length} 行，无引用`,
      ],
    });
  }
}

function sortCandidates(candidates: GcCandidate[]): void {
  const rank = (kind: GcCandidateKind): number => (kind === "snapshot-tmp" ? 0 : kind === "native-session" ? 1 : 2);
  candidates.sort((a, b) => rank(a.kind) - rank(b.kind) || a.path.localeCompare(b.path));
}

/** 只读扫描候选；不取锁、不写 record、不创建目录。 */
export function scanGcCandidates(input: GcScanInput): GcScanResult {
  const root = normalizeRoot(input.dir);
  const locks = lockManagerFor(input);
  const now = input.now ?? (() => new Date());
  const candidates: GcCandidate[] = [];
  const skipped: GcSkipped[] = [];
  const index = readMetadataIndex(root);
  const taskScan = scanTaskReferences(root);
  scanSnapshotTemporary(root, locks, input.ownProjectLockToken, candidates, skipped);
  scanNativeSessions(root, index, candidates, skipped);
  scanRuns(root, index, taskScan, candidates, skipped);
  sortCandidates(candidates);
  return {
    projectRoot: root,
    generatedAt: now().toISOString(),
    candidates,
    skipped,
    counts: candidateCounts(candidates),
  };
}

/** storage 摘要用：任何扫描异常都不让只读统计失败。 */
export function countGcCandidates(input: { dir: string; locksRoot?: string; now?: () => Date }): number {
  try {
    return scanGcCandidates(input).candidates.length;
  } catch {
    return 0;
  }
}

function candidateRunId(candidate: GcCandidate): string | null {
  const parts = candidate.path.split("/");
  if (parts.length < 4 || parts[0] !== ".knit" || parts[1] !== ".runtime" || parts[2] !== "runs") return null;
  return parts[3] !== undefined && RUN_ID.test(parts[3]) ? parts[3] : null;
}

function revalidateCandidate(
  root: string,
  candidate: GcCandidate,
  input: { locks: LockManager; ownProjectLockToken: string | undefined },
): { ok: true; candidate: GcCandidate } | { ok: false; skipped: GcSkipped } {
  const absolute = join(root, candidate.path);
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    return {
      ok: false,
      skipped: { ...candidate, reason: "执行前候选已不存在（原样跳过）" },
    };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return {
      ok: false,
      skipped: { ...candidate, reason: "执行前候选类型变化，非目录；不收集" },
    };
  }
  try {
    if (realpathSync(absolute) !== absolute) {
      return { ok: false, skipped: { ...candidate, reason: "执行前路径经符号链接变化，不收集" } };
    }
  } catch {
    return { ok: false, skipped: { ...candidate, reason: "执行前候选路径无法核实，不收集" } };
  }
  if (candidate.kind === "snapshot-tmp") {
    const runId = candidateRunId(candidate);
    const parts = candidate.path.split("/");
    if (runId === null || parts.length !== 5 || !parts[4]?.startsWith(TMP_PREFIX)) {
      return { ok: false, skipped: { ...candidate, reason: "临时快照路径结构不符，不收集" } };
    }
    const runDir = new RunStore(root).runDir(runId);
    const manifest = readSnapshotState(runDir);
    const tmpManifest = readSnapshotState(absolute);
    const lock = projectLockStatus(root, input.locks, input.ownProjectLockToken);
    const evidence = [
      `run=${runId}`,
      `snapshot manifest=${manifest.state ?? "缺失"}${manifest.problem === null ? "" : `（${manifest.problem}）`}`,
      `临时目录 manifest=${tmpManifest.state ?? "缺失"}${tmpManifest.problem === null ? "" : `（${tmpManifest.problem}）`}`,
      lock.detail,
    ];
    if (manifest.problem !== null) return { ok: false, skipped: { ...candidate, evidence, reason: `执行前快照 manifest 不可判定（${manifest.problem}）` } };
    if (tmpManifest.problem !== null) return { ok: false, skipped: { ...candidate, evidence, reason: `执行前临时目录 manifest 不可判定（${tmpManifest.problem}）` } };
    if (manifest.state === "preparing" || tmpManifest.state === "preparing") {
      return { ok: false, skipped: { ...candidate, evidence, reason: "执行前快照进入 preparing，不收集" } };
    }
    if (lock.held) return { ok: false, skipped: { ...candidate, evidence, reason: `执行前项目快照锁被持有（${lock.detail}）` } };
    return { ok: true, candidate: { ...candidate, sizeBytes: treeStats(absolute).bytes, evidence } };
  }
  if (candidate.kind === "native-session") {
    const parts = candidate.path.split("/");
    if (parts.length !== 4 || parts[0] !== ".knit" || parts[1] !== ".runtime" || parts[2] !== "pi-sessions" || parts[3] === undefined) {
      return { ok: false, skipped: { ...candidate, reason: "会话目录路径结构不符，不收集" } };
    }
    const index = readMetadataIndex(root);
    if (!index.present) {
      return { ok: false, skipped: { ...candidate, reason: "执行前 Session 索引不存在，未知不收集", evidence: ["metadata.db 缺失"] } };
    }
    if (!index.available) {
      return {
        ok: false,
        skipped: { ...candidate, reason: `执行前 Session 索引不可读，未知不收集${index.reason === null ? "" : `（${index.reason}）`}` },
      };
    }
    if (sessionDirectoryReferenced(root, parts[3], absolute, index)) {
      return { ok: false, skipped: { ...candidate, reason: "执行前发现 Session 索引引用，保留" } };
    }
    return {
      ok: true,
      candidate: {
        ...candidate,
        sizeBytes: treeStats(absolute).bytes,
        evidence: [`sessions 索引可读：${index.sessions.length} 行，0 行引用`, `目录=${parts[3]}`],
      },
    };
  }
  const runId = candidateRunId(candidate);
  if (runId === null || candidate.path.split("/").length !== 4) {
    return { ok: false, skipped: { ...candidate, reason: "run 目录路径结构不符，不收集" } };
  }
  const index = readMetadataIndex(root);
  const taskScan = scanTaskReferences(root);
  if (!taskScan.ok) {
    return { ok: false, skipped: { ...candidate, reason: `执行前任务资料引用不可判定（${taskScan.reason ?? "未知"}）` } };
  }
  if (!index.available) {
    return { ok: false, skipped: { ...candidate, reason: `执行前 metadata 引用不可判定（${index.reason ?? "未知"}）` } };
  }
  const references = new Map<string, string[]>();
  for (const [id, evidence] of taskScan.refs) references.set(id, [...evidence]);
  for (const [id, evidence] of metadataRunReferences(index)) {
    const list = references.get(id) ?? [];
    for (const item of evidence) if (!list.includes(item)) list.push(item);
    references.set(id, list);
  }
  const found = references.get(runId);
  if (found !== undefined && found.length > 0) {
    return {
      ok: false,
      skipped: { ...candidate, reason: `执行前发现引用，保留（${found.join(", ")}）`, evidence: found },
    };
  }
  const state = readRunState(absolute);
  if (state.state === null) {
    return { ok: false, skipped: { ...candidate, reason: `执行前运行状态不可判定（${state.reason}）` } };
  }
  if (!TERMINAL_RUN_STATES.has(state.state)) {
    return { ok: false, skipped: { ...candidate, reason: `执行前运行状态 ${state.state} 非终态，不收集` } };
  }
  if (candidate.path.split("/")[3] !== runId) {
    return { ok: false, skipped: { ...candidate, reason: "run 路径与 ID 不一致，不收集" } };
  }
  return {
    ok: true,
    candidate: {
      ...candidate,
      sizeBytes: treeStats(absolute).bytes,
      evidence: [
        `run=${runId}`,
        `state=${state.state}`,
        `task.md 扫描 ${taskScan.scanned} 个，无引用`,
        `bindings 扫描 ${index.bindings.length} 行，无引用`,
        `operations 扫描 ${index.operations.length} 行，无引用`,
      ],
    },
  };
}

function writeLastRecord(root: string, record: GcApplyRecord): string {
  const dir = join(root, GC_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(root, LAST_RECORD);
  atomicWrite({
    path,
    data: Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8"),
    expectedSha256: null,
    mode: 0o600,
  });
  return LAST_RECORD.split(sep).join("/");
}

export class GcService {
  private readonly locks: LockManager | null;
  private readonly now: () => Date;
  private readonly remove: (absolutePath: string) => void;

  constructor(options: GcServiceOptions = {}) {
    this.locks = options.locks ?? null;
    this.now = options.now ?? (() => new Date());
    this.remove = options.remove ?? ((absolutePath) => rmSync(absolutePath, { recursive: true, force: true }));
  }

  preview(input: { dir: string; locksRoot?: string }): GcPreviewResult {
    const scan = scanGcCandidates({
      dir: input.dir,
      ...(input.locksRoot === undefined ? {} : { locksRoot: input.locksRoot }),
      ...(this.locks === null ? {} : { locks: this.locks }),
      now: this.now,
    });
    return { ...scan, mode: "preview", apply: false, policy: GC_POLICY };
  }

  async apply(input: { dir: string; locksRoot?: string }): Promise<GcApplyResult> {
    const root = normalizeRoot(input.dir);
    const locks = this.locks ?? new LockManager(input.locksRoot === undefined ? {} : { root: input.locksRoot });
    const acquired = await locks.acquire({
      keys: [{ scope: "project", rawKey: root }],
      action: "gc",
    });
    const startedAt = this.now().toISOString();
    try {
      const scan = scanGcCandidates({
        dir: root,
        ...(input.locksRoot === undefined ? {} : { locksRoot: input.locksRoot }),
        locks,
        ownProjectLockToken: acquired.token,
        now: this.now,
      });
      const items: GcApplyItem[] = [];
      const removed: GcCandidate[] = [];
      const skipped: GcSkipped[] = [];
      const failed: GcSkipped[] = [];
      let aborted = false;
      for (const candidate of scan.candidates) {
        if (aborted) {
          const item: GcApplyItem = {
            ...candidate,
            status: "skipped",
            outcomeReason: "前序删除失败，未处理（原样保留）",
          };
          items.push(item);
          skipped.push({ kind: candidate.kind, path: candidate.path, sizeBytes: candidate.sizeBytes, reason: item.outcomeReason, evidence: candidate.evidence });
          continue;
        }
        try {
          const fresh = revalidateCandidate(root, candidate, { locks, ownProjectLockToken: acquired.token });
          if (!fresh.ok) {
            items.push({ ...fresh.skipped, status: "skipped", outcomeReason: fresh.skipped.reason });
            skipped.push(fresh.skipped);
            continue;
          }
          const absolute = join(root, fresh.candidate.path);
          this.remove(absolute);
          if (existsSync(absolute)) throw new Error(`删除后路径仍存在: ${fresh.candidate.path}`);
          items.push({ ...fresh.candidate, status: "removed", outcomeReason: fresh.candidate.reason });
          removed.push(fresh.candidate);
        } catch (error) {
          const reason = `删除失败：${error instanceof Error ? error.message : String(error)}`;
          const failure: GcSkipped = { kind: candidate.kind, path: candidate.path, sizeBytes: candidate.sizeBytes, reason, evidence: candidate.evidence };
          failed.push(failure);
          items.push({ ...failure, status: "failed", outcomeReason: reason });
          aborted = true;
        }
      }
      // 扫描阶段已判定为未知／活跃的项也逐项写入记录，便于诊断。
      for (const item of scan.skipped) {
        skipped.push(item);
        items.push({ ...item, status: "skipped", outcomeReason: item.reason });
      }
      const finishedAt = this.now().toISOString();
      const counts = candidateCounts(scan.candidates);
      counts.removed = removed.length;
      counts.failed = failed.length;
      counts.skipped = skipped.length;
      const record: GcApplyRecord = {
        schemaVersion: 1,
        projectRoot: root,
        mode: "apply",
        startedAt,
        finishedAt,
        policy: GC_POLICY,
        state: failed.length === 0 ? "completed" : "partial",
        counts,
        removed,
        skipped,
        failed,
        items,
      };
      const recordPath = writeLastRecord(root, record);
      return { ...record, recordPath };
    } finally {
      locks.release(acquired);
    }
  }
}
