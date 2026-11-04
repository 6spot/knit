/**
 * `knit worktree handoff` 核心（任务 k-19b5cad5c106；WORKTREE.md §6.1，快照语义）。
 * 仅从主检出执行：源任务目录全量快照到 transfers/<opId>/source/ 后以备份副本为唯一
 * 应用事实；目标侧按基线（binding.worktree.baseline）核对，冲突即停保留两边。
 * 每个破坏性步骤前落盘 journal，恢复以未完成 receipt 为断点线索，不静默覆盖目标。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeRoot } from "../infrastructure/paths.js";
import { fileFacts, sha256Bytes } from "../infrastructure/fingerprint.js";
import { gitBufferSync, gitSync } from "../infrastructure/process.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { ensurePrivateDir } from "../infrastructure/private-mode.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { locateTaskDocument, listTaskDirectories, TaskGuardError } from "./task-service.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { RunStore } from "../infrastructure/run-store.js";
import type { TaskBinding } from "../contracts/metadata.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import { parseTaskDocument } from "./task-document.js";

/** 交接暂存与回执容器（相对项目根）；运行资料按任务边界不进 worktree。 */
export const TRANSFERS_DIR = join(".knit", ".runtime", "transfers");
const TASK_FILE = "task.md";

/** manifest 单项：kind/symlink 记现状，文件带内容与模式指纹。 */
export interface HandoffEntry {
  /** 相对任务目录的 POSIX 路径。 */
  relativePath: string;
  kind: "file" | "directory" | "symlink" | "absent";
  sha256: string | null;
  mode: string | null;
  /** 符号链接目标字符串；其余为 null。 */
  linkTarget: string | null;
}

/** 快照相对源 Git HEAD 的差异事实。 */
export interface HandoffGitFacts {
  head: string | null;
  /** HEAD 跟踪但快照缺席的路径（相对任务目录）。 */
  deleted: string[];
  /** 工作区存在但未跟踪的路径（相对任务目录）。 */
  untracked: string[];
}

export interface HandoffReceipt {
  schemaVersion: 1;
  opId: string;
  taskId: string;
  sourceDir: string;
  sourceDirName: string;
  targetWorktreePath: string;
  targetTaskDir: string | null;
  branch: string;
  baseline: string;
  sourceHeadAtStart: string | null;
  manifest: HandoffEntry[];
  deleted: string[];
  untracked: string[];
  journal: Array<{ stepId: string; kind: string; at: string; evidence?: Record<string, unknown> }>;
  finishedAt: string | null;
}

/** handoff 一次执行的对外结果。 */
export interface WorktreeHandoffResult {
  taskId: string;
  opId: string;
  /** "completed" 正常交接；"resumed" 从断点续做；"no_op" 幂等命中。 */
  mode: "completed" | "resumed" | "no_op";
  sourceDir: string;
  targetTaskDir: string | null;
  worktreePath: string;
  branch: string;
  /** binding.branch 切换是否随本次生效。 */
  bindingBranchSwitched: boolean;
  /** 源资料处置：moved_untracked 整目录入 transfers；kept_tracked 保留并提示待清理。 */
  sourceDisposition: "moved_untracked" | "kept_tracked" | "unchanged";
  files: number;
  deleted: number;
  untracked: number;
}

interface TransferPaths {
  root: string;
  dir: string;
  source: string;
  manifest: string;
  receipt: string;
  journal: string;
}

function transferPaths(root: string, opId: string): TransferPaths {
  const dir = join(root, TRANSFERS_DIR, opId);
  return {
    root,
    dir,
    source: join(dir, "source"),
    manifest: join(dir, "manifest.json"),
    receipt: join(dir, "receipt.json"),
    journal: join(dir, "journal.jsonl"),
  };
}

/** 操作 ID；回执与暂存共用一个名称空间。 */
function newOpId(): string {
  return `op-${randomBytes(6).toString("hex")}`;
}

/** 运行/元数据路径不进交接（边界：目标侧运行资料属后续任务；防御 .git 误入）。 */
function isExcludedPath(relativePath: string): boolean {
  return relativePath === ".runtime" || relativePath.startsWith(".runtime/") ||
    relativePath === ".git" || relativePath.startsWith(".git/");
}

/** POSIX 相对路径（相对任务目录），目录树全量列举。 */
function walkTaskDir(dir: string, prefix: string, entries: HandoffEntry[], bytes: Map<string, Uint8Array>): void {
  const list = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of list) {
    const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
    if (isExcludedPath(rel)) continue;
    const full = join(dir, item.name);
    if (item.isSymbolicLink()) {
      // 符号链接按目标字符串记 manifest（DESIGN §5.3 事实口径），不展开目标。
      const facts = fileFacts(full);
      entries.push({ relativePath: rel, kind: "symlink", sha256: null, mode: null, linkTarget: facts.mode });
      continue;
    }
    if (item.isDirectory()) {
      entries.push({ relativePath: rel, kind: "directory", sha256: null, mode: null, linkTarget: null });
      walkTaskDir(full, rel, entries, bytes);
      continue;
    }
    if (!item.isFile()) continue;
    const data = readFileSync(full);
    bytes.set(rel, data);
    entries.push({ relativePath: rel, kind: "file", sha256: sha256Bytes(data), mode: statSync(full).mode.toString(8), linkTarget: null });
  }
}

/** 源任务目录 Git 事实：HEAD、相对 HEAD 的删除与未跟踪清单（literal 防路径通配）。 */
function gitFactsOfSource(root: string, taskDir: string): HandoffGitFacts {
  const headResult = gitSync(["rev-parse", "--verify", "HEAD"], root);
  const head = headResult.code === 0 ? headResult.stdout.trim() : null;
  const spec = `:(literal)${relative(root, taskDir).split(sep).join("/")}`;
  const tracked = new Set<string>();
  if (head !== null) {
    const lsTree = gitSync(["ls-tree", "-r", "-z", "--name-only", head, "--", spec], root);
    if (lsTree.code === 0) {
      for (const item of lsTree.stdout.split("\0")) {
        if (item === "") continue;
        tracked.add(relative(taskDir, resolve(root, item)).split(sep).join("/"));
      }
    }
  }
  const lsFiles = gitSync(["ls-files", "-z", "--", spec], root);
  if (lsFiles.code === 0) {
    for (const item of lsFiles.stdout.split("\0")) {
      if (item === "") continue;
      tracked.add(relative(taskDir, resolve(root, item)).split(sep).join("/"));
    }
  }
  const present = new Set<string>();
  const walk = (dir: string, prefix: string): void => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) walk(join(dir, item.name), rel);
      else if (item.isFile() || item.isSymbolicLink()) present.add(rel);
    }
  };
  walk(taskDir, "");
  const deleted = [...tracked].filter((path) => !present.has(path)).sort();
  const untracked = [...present].filter((path) => !tracked.has(path)).sort();
  return { head, deleted, untracked };
}

/** 删除项按深到浅排序，先删文件后删空目录，避免父目录先于子项。 */
function sortDeletedForApply(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const depth = b.split("/").length - a.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });
}

/** 快照副本完整性：逐项核对 kind/sha256/mode（恢复入口的判据）。 */
function verifySnapshot(paths: TransferPaths, manifest: HandoffEntry[], bytes: Map<string, Uint8Array>): { ok: boolean; problem: string | null } {
  for (const entry of manifest) {
    if (entry.kind === "absent") continue;
    const full = join(paths.source, entry.relativePath);
    if (!existsSync(full)) return { ok: false, problem: `备份缺项: ${entry.relativePath}` };
    if (entry.kind === "directory") {
      if (!statSync(full).isDirectory()) return { ok: false, problem: `备份目录项类型不符: ${entry.relativePath}` };
      continue;
    }
    if (entry.kind === "symlink") {
      const facts = fileFacts(full);
      if (facts.kind !== "link" || facts.mode !== entry.linkTarget) {
        return { ok: false, problem: `备份符号链接不符: ${entry.relativePath}` };
      }
      continue;
    }
    const current = bytes.get(entry.relativePath);
    if (current === undefined) return { ok: false, problem: `备份字节缺失: ${entry.relativePath}` };
    if (sha256Bytes(current) !== entry.sha256) return { ok: false, problem: `备份内容不符: ${entry.relativePath}` };
  }
  return { ok: true, problem: null };
}

function writeJournalLine(paths: TransferPaths, stepId: string, kind: string, evidence?: Record<string, unknown>): void {
  const line = JSON.stringify({ stepId, kind, at: new Date().toISOString(), ...(evidence ?? {}) }) + "\n";
  ensurePrivateDir(paths.dir);
  if (!existsSync(paths.journal)) writeFileSync(paths.journal, "", { mode: 0o600 });
  const existing = readFileSync(paths.journal, "utf8");
  writeFileSync(paths.journal, existing + line, { mode: 0o600 });
}

/** 快照后落盘 manifest 与字节副本；任一步失败即整体停止（目标尚未被触碰）。 */
function persistSnapshot(paths: TransferPaths, entries: HandoffEntry[], bytes: Map<string, Uint8Array>, git: HandoffGitFacts): void {
  mkdirSync(paths.source, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (entry.kind === "absent") continue;
    const full = join(paths.source, entry.relativePath);
    if (entry.kind === "directory") {
      mkdirSync(full, { recursive: true, mode: 0o700 });
      continue;
    }
    if (entry.kind === "symlink") {
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      symlinkSync(entry.linkTarget ?? "", full);
      continue;
    }
    const data = bytes.get(entry.relativePath);
    if (data === undefined) throw new InfrastructureError("io_error", `快照缺字节: ${entry.relativePath}`);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, data, { mode: 0o600 });
  }
  const manifestJson = entries;
  atomicWrite({
    path: paths.manifest,
    data: Buffer.from(JSON.stringify({ schemaVersion: 1, entries: manifestJson, git }, null, 2) + "\n"),
    mode: 0o600,
  });
}

function readTransferState(paths: TransferPaths): { manifest: HandoffEntry[]; git: HandoffGitFacts; bytes: Map<string, Uint8Array> } | null {
  const version = readWithVersion(paths.manifest);
  if (version === null) return null;
  let parsed: { schemaVersion?: unknown; entries?: unknown; git?: unknown };
  try {
    parsed = JSON.parse(version.data.toString("utf8")) as typeof parsed;
  } catch (error) {
    throw new InfrastructureError("io_error", `manifest.json 不是合法 JSON: ${paths.manifest}: ${String(error)}`);
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) || typeof parsed.git !== "object" || parsed.git === null) {
    throw new InfrastructureError("io_error", `manifest.json 结构不符: ${paths.manifest}`);
  }
  const manifest = parsed.entries as HandoffEntry[];
  const bytes = new Map<string, Uint8Array>();
  for (const entry of manifest) {
    if (entry.kind !== "file") continue;
    const full = join(paths.source, entry.relativePath);
    const data = readWithVersion(full);
    if (data === null) return null;
    bytes.set(entry.relativePath, data.data);
  }
  return { manifest, git: parsed.git as HandoffGitFacts, bytes };
}

function readReceipt(paths: TransferPaths): HandoffReceipt | null {
  const version = readWithVersion(paths.receipt);
  if (version === null) return null;
  try {
    return JSON.parse(version.data.toString("utf8")) as HandoffReceipt;
  } catch (error) {
    throw new InfrastructureError("io_error", `receipt.json 不是合法 JSON: ${paths.receipt}: ${String(error)}`);
  }
}

/** 按快照事实写入目标任务目录；逐文件原子替换，保留可执行位。 */
function applyEntriesToTarget(taskDir: string, manifest: HandoffEntry[], bytes: Map<string, Uint8Array>): void {
  mkdirSync(taskDir, { recursive: true, mode: 0o755 });
  for (const entry of manifest) {
    if (entry.kind === "directory") {
      mkdirSync(join(taskDir, entry.relativePath), { recursive: true, mode: 0o755 });
      continue;
    }
    if (entry.kind !== "file") continue;
    const data = bytes.get(entry.relativePath);
    if (data === undefined) throw new InfrastructureError("io_error", `应用缺字节: ${entry.relativePath}`);
    const target = join(taskDir, entry.relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const mode = entry.mode === null ? 0o644 : parseInt(entry.mode, 8) & 0o777;
    atomicWrite({ path: target, data: Buffer.from(data), mode });
  }
  for (const entry of manifest) {
    if (entry.kind !== "symlink") continue;
    const target = join(taskDir, entry.relativePath);
    const facts = fileFacts(target);
    if (facts.kind === "file" || facts.kind === "link") unlinkSync(target);
    else if (facts.kind === "directory") rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    symlinkSync(entry.linkTarget ?? "", target);
  }
}

/** 应用删除项；目标缺项视为已满足（幂等重入），不报错。 */
function applyDeletions(taskDir: string, deleted: string[]): void {
  for (const path of sortDeletedForApply(deleted)) {
    const target = join(taskDir, path);
    const facts = fileFacts(target);
    if (facts.kind === "file" || facts.kind === "link") unlinkSync(target);
    else if (facts.kind === "directory") rmSync(target, { recursive: true, force: true });
  }
  // 不清理变空的父目录：空目录无害，且任务目录自身需保留（回执与核验仍指向它）。
}

/** manifest 逐项重算目标侧指纹；任一不符即报 io_error（交接不完整，不视为成功）。 */
function verifyAppliedTarget(taskDir: string, manifest: HandoffEntry[], bytes: Map<string, Uint8Array>): void {
  const problems: string[] = [];
  for (const entry of manifest) {
    if (entry.kind === "absent") continue;
    const full = join(taskDir, entry.relativePath);
    const facts = fileFacts(full);
    if (entry.kind === "directory") {
      if (facts.kind !== "directory") problems.push(`目录缺失: ${entry.relativePath}`);
      continue;
    }
    if (entry.kind === "symlink") {
      if (facts.kind !== "link" || facts.mode !== entry.linkTarget) problems.push(`符号链接不符: ${entry.relativePath}`);
      continue;
    }
    const data = bytes.get(entry.relativePath);
    if (facts.kind !== "file" || data === undefined || facts.sha256 !== entry.sha256 || facts.mode !== entry.mode) {
      problems.push(`内容或模式不符: ${entry.relativePath}`);
    }
  }
  if (problems.length > 0) {
    throw new InfrastructureError("io_error", `目标核验未通过（${problems.length} 项），保留现场待核实: ${problems.slice(0, 5).join("; ")}`);
  }
}

/** 目标侧基线内容；基线缺失（未提交路径）返回 null。 */
function baselineBytes(root: string, baseline: string, repoRelativePath: string): Buffer | null {
  const result = gitBufferSync(["show", `${baseline}:${repoRelativePath}`], root);
  if (result.code !== 0) return null;
  return result.stdout;
}

/** 目标工作区某路径是否与基线一致（不存在且基线无也算一致）。 */
function targetMatchesBaseline(root: string, baseline: string, absolutePath: string): { matches: boolean; problem: string | null } {
  const repoRelative = relative(root, absolutePath).split(sep).join("/");
  const base = baselineBytes(root, baseline, repoRelative);
  const facts = fileFacts(absolutePath);
  if (facts.kind === "absent") return { matches: base === null, problem: base !== null ? "目标缺基线文件" : null };
  if (facts.kind === "directory") return { matches: false, problem: "目标路径是目录" };
  if (facts.kind === "link") return { matches: false, problem: "目标路径是符号链接" };
  if (base === null) return { matches: false, problem: "目标存在基线之外的文件" };
  return { matches: sha256Bytes(base) === facts.sha256, problem: sha256Bytes(base) === facts.sha256 ? null : "目标与基线内容不同" };
}

/** 目标任务目录内清单与基线都覆盖不到的条目（来源不明额外资料）。 */
function targetHasUnmanifestedEntries(taskDir: string, manifest: HandoffEntry[], baselineTracked: ReadonlySet<string>): string[] {
  const expected = new Set<string>(baselineTracked);
  for (const entry of manifest) {
    if (entry.kind === "absent") continue;
    expected.add(entry.relativePath);
    const segments = entry.relativePath.split("/");
    for (let i = 1; i < segments.length; i += 1) expected.add(segments.slice(0, i).join("/"));
  }
  // 基线跟踪路径的父目录同样不视为额外资料。
  for (const path of baselineTracked) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i += 1) expected.add(segments.slice(0, i).join("/"));
  }
  const extras: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
      if (expected.has(rel)) {
        if (item.isDirectory()) walk(join(dir, item.name), rel);
        continue;
      }
      extras.push(rel);
    }
  };
  walk(taskDir, "");
  return extras;
}

/** 目标侧同 ID 任务目录定位；unparsed 记 task.md 不可解析的目录（无法核实，冲突处理）。 */
function locateTargetTaskDirs(worktreePath: string, taskId: string): { dirs: Array<{ dir: string; dirName: string }>; unparsed: string[] } {
  const tasksRoot = join(worktreePath, ".knit", "tasks");
  if (!existsSync(tasksRoot)) return { dirs: [], unparsed: [] };
  const dirs: Array<{ dir: string; dirName: string }> = [];
  const unparsed: string[] = [];
  for (const { name, archived } of listTaskDirectories(worktreePath)) {
    if (archived) continue;
    const dir = join(tasksRoot, name);
    const file = join(dir, TASK_FILE);
    if (!existsSync(file)) continue;
    try {
      const document = parseTaskDocument(readFileSync(file, "utf8"), file);
      if (document.frontmatter.id === taskId) dirs.push({ dir, dirName: name });
    } catch {
      unparsed.push(dir);
    }
  }
  return { dirs, unparsed };
}

export interface WorktreeHandoffOptions {
  store: MetadataStore;
  runs: RunStore;
  now?: () => Date;
}

export class WorktreeHandoffService {
  private readonly store: MetadataStore;
  private readonly runs: RunStore;
  private readonly now: () => Date;

  constructor(options: WorktreeHandoffOptions) {
    this.store = options.store;
    this.runs = options.runs;
    this.now = options.now ?? (() => new Date());
  }

  /** 目标 worktree 校验：已登记、现场与登记一致（porcelain+分支+基线后代，复用任务10语义）。 */
  private resolveTargetWorktree(root: string, binding: TaskBinding, explicitPath: string | null): WorktreeInfo {
    const registered = binding.worktree ?? null;
    if (registered === null) {
      throw new TaskGuardError("unknown_binding", `任务未登记 worktree，先执行 knit worktree create 或 connect: ${binding.taskId}`);
    }
    if (explicitPath !== null && resolve(explicitPath) !== resolve(registered.path)) {
      throw new TaskGuardError("worktree_mismatch", `任务已登记其它 worktree: ${registered.path}（--to ${explicitPath} 不符）`);
    }
    if (registered.active === true) {
      // 已激活仍允许显式续做（恢复/重试场景由幂等与冲突核对兜底）。
    }
    const verdict = this.verifyRegistered(root, registered);
    if (!verdict.ok) {
      throw new TaskGuardError("worktree_mismatch", `已登记 worktree 与现场不符，先 connect 或清理现场: ${verdict.problem ?? ""}`);
    }
    return registered;
  }

  /** porcelain 登记、分支与基线后代核对（worktree-manager 同语义，本文件独立实现避免反向依赖）。 */
  private verifyRegistered(root: string, info: WorktreeInfo): { ok: boolean; problem: string | null } {
    if (!existsSync(info.path) || !statSync(info.path).isDirectory()) {
      return { ok: false, problem: `登记路径缺失: ${info.path}` };
    }
    const inside = gitSync(["rev-parse", "--show-toplevel"], info.path);
    if (inside.code !== 0 || resolve(inside.stdout.trim()) !== resolve(info.path)) {
      return { ok: false, problem: `登记路径不是本仓库 worktree 根: ${info.path}` };
    }
    const list = gitSync(["worktree", "list", "--porcelain"], root);
    if (list.code !== 0) return { ok: false, problem: `git worktree list 失败: ${list.stderr.trim()}` };
    const entry = list.stdout.split("\n").find((line) => line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === resolve(info.path));
    if (entry === undefined) return { ok: false, problem: `登记路径未在 git worktree list 中: ${info.path}` };
    const branch = this.branchForWorktreeEntry(list.stdout, info.path);
    if (branch !== info.branch) {
      return { ok: false, problem: `登记分支不符: 期望 ${info.branch}，实际 ${branch ?? "（detached）"}` };
    }
    if (gitSync(["merge-base", "--is-ancestor", info.baseline, info.branch], root).code !== 0) {
      return { ok: false, problem: `登记分支 ${info.branch} 不在基线 ${info.baseline} 或其后代` };
    }
    return { ok: true, problem: null };
  }

  private branchForWorktreeEntry(porcelain: string, path: string): string | null {
    const blocks = porcelain.split("\n\n");
    for (const block of blocks) {
      const lines = block.split("\n");
      const worktreeLine = lines.find((line) => line.startsWith("worktree "));
      if (worktreeLine === undefined || resolve(worktreeLine.slice("worktree ".length)) !== resolve(path)) continue;
      const branchLine = lines.find((line) => line.startsWith("branch "));
      return branchLine === undefined ? null : branchLine.slice("branch ".length);
    }
    return null;
  }

  async handoff(input: { dir: string; taskId: string; to?: string }): Promise<WorktreeHandoffResult> {
    const root = normalizeRoot(input.dir);
    const now = this.now();
    const located = locateTaskDocument(root, input.taskId);
    if (located.archived) {
      throw new TaskGuardError("task_archived", `任务已归档: ${input.taskId}`);
    }
    const sourceDirName = basename(located.dir);
    const sourceDir = located.dir;
    // 活动运行拒绝：交接改变资料权威位置，与进行中 run 的快照/写入相互干扰。
    if (await this.hasActiveRun(input.taskId)) {
      throw new TaskGuardError("runs_unsettled", "任务仍有活动或未收敛 run，先取消或等待结束再交接");
    }
    const binding = await this.requireBinding(input.taskId);
    const worktree = this.resolveTargetWorktree(root, binding, input.to ?? null);
    const targetWorktreePath = worktree.path;

    // 已成功交接的幂等：源与 receipt 快照一致 → no-op；源已变化 → 报错（权威已在目标）。
    const completed = this.findCompletedReceipt(root, input.taskId, sourceDir);
    if (completed !== null) {
      const same = this.sourceMatchesReceipt(sourceDir, completed.receipt);
      if (same) {
        return {
          taskId: input.taskId,
          opId: completed.opId,
          mode: "no_op",
          sourceDir,
          targetTaskDir: completed.receipt.targetTaskDir,
          worktreePath: targetWorktreePath,
          branch: worktree.branch,
          bindingBranchSwitched: false,
          sourceDisposition: "unchanged",
          files: completed.receipt.manifest.filter((entry) => entry.kind === "file").length,
          deleted: completed.receipt.deleted.length,
          untracked: completed.receipt.untracked.length,
        };
      }
      throw new TaskGuardError(
        "worktree_mismatch",
        `任务资料已交接且权威在目标 worktree（${targetWorktreePath}）；源目录在交接后又发生变化，先在源目录确认这些改动属于哪一侧: ${completed.receiptPath ?? join(root, TRANSFERS_DIR, completed.opId)}`,
      );
    }

    // 未完成 receipt（上次中断）→ 核对备份后从断点续做。
    const pending = this.findPendingReceipt(root, input.taskId, sourceDir);
    if (pending !== null) {
      return await this.resumeFromReceipt(root, input.taskId, pending, now);
    }

    const opId = newOpId();
    const paths = transferPaths(root, opId);
    const manifest: HandoffEntry[] = [];
    const bytes = new Map<string, Uint8Array>();
    walkTaskDir(sourceDir, "", manifest, bytes);
    const git = gitFactsOfSource(root, sourceDir);
    try {
      persistSnapshot(paths, manifest, bytes, git);
      writeJournalLine(paths, "snapshot", "persisted", { files: manifest.filter((entry) => entry.kind === "file").length });
    } catch (error) {
      // 快照失败即停：清掉半成品暂存，目标完全未动。
      try {
        rmSync(paths.dir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响原始错误
      }
      throw error;
    }
    const receipt: HandoffReceipt = {
      schemaVersion: 1,
      opId,
      taskId: input.taskId,
      sourceDir,
      sourceDirName,
      targetWorktreePath,
      targetTaskDir: null,
      branch: worktree.branch,
      baseline: worktree.baseline,
      sourceHeadAtStart: git.head,
      manifest,
      deleted: git.deleted,
      untracked: git.untracked,
      journal: [{ stepId: "snapshot", kind: "persisted", at: now.toISOString() }],
      finishedAt: null,
    };
    this.saveReceipt(paths, receipt);
    return await this.applyAndFinish(root, input.taskId, paths, sourceDir, now, "completed");
  }

  private saveReceipt(paths: TransferPaths, receipt: HandoffReceipt): void {
    ensurePrivateDir(paths.dir);
    atomicWrite({
      path: paths.receipt,
      data: Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
      mode: 0o600,
    });
  }

  /** 同任务全部 transfers；损坏的目录跳过（恢复入口按 receipts 报告）。 */
  private receiptsForTask(root: string, taskId: string): Array<{ opId: string; receipt: HandoffReceipt; receiptPath: string }> {
    const transfersRoot = join(root, TRANSFERS_DIR);
    if (!existsSync(transfersRoot)) return [];
    const result: Array<{ opId: string; receipt: HandoffReceipt; receiptPath: string }> = [];
    for (const name of readdirSync(transfersRoot).sort()) {
      if (!/^op-[0-9a-f]{12}$/.test(name)) continue;
      const receiptPath = join(transfersRoot, name, "receipt.json");
      const version = readWithVersion(receiptPath);
      if (version === null) continue;
      let receipt: HandoffReceipt;
      try {
        receipt = JSON.parse(version.data.toString("utf8")) as HandoffReceipt;
      } catch {
        continue;
      }
      if (receipt.taskId !== taskId) continue;
      result.push({ opId: name, receipt, receiptPath });
    }
    return result;
  }

  private findCompletedReceipt(root: string, taskId: string, sourceDir: string): { opId: string; receipt: HandoffReceipt; receiptPath: string | null } | null {
    const candidates = this.receiptsForTask(root, taskId).filter((item) => item.receipt.finishedAt !== null);
    if (candidates.length === 0) return null;
    const latest = candidates[candidates.length - 1];
    if (latest === undefined) return null;
    if (resolve(latest.receipt.sourceDir) !== resolve(sourceDir)) return null;
    return { opId: latest.opId, receipt: latest.receipt, receiptPath: latest.receiptPath };
  }

  private findPendingReceipt(root: string, taskId: string, sourceDir: string): { opId: string; receipt: HandoffReceipt; receiptPath: string } | null {
    const pending = this.receiptsForTask(root, taskId).filter((item) => item.receipt.finishedAt === null);
    if (pending.length === 0) return null;
    const latest = pending[pending.length - 1];
    if (latest === undefined) return null;
    if (resolve(latest.receipt.sourceDir) !== resolve(sourceDir)) {
      throw new TaskGuardError("worktree_mismatch", `存在其它源目录的未完成交接回执: ${latest.receiptPath}`);
    }
    return latest;
  }

  /** 源目录当前内容是否与 receipt 快照完全一致（幂等判据）。 */
  private sourceMatchesReceipt(sourceDir: string, receipt: HandoffReceipt): boolean {
    const bytes = new Map<string, Uint8Array>();
    const current: HandoffEntry[] = [];
    try {
      walkTaskDir(sourceDir, "", current, bytes);
    } catch {
      return false;
    }
    const previous = receipt.manifest;
    if (current.length !== previous.length) return false;
    for (let index = 0; index < current.length; index += 1) {
      const nowEntry = current[index];
      const before = previous[index];
      if (nowEntry === undefined || before === undefined) return false;
      if (nowEntry.relativePath !== before.relativePath || nowEntry.kind !== before.kind) return false;
      if (nowEntry.kind === "file" && (nowEntry.sha256 !== before.sha256 || nowEntry.mode !== before.mode)) return false;
      if (nowEntry.kind === "symlink" && nowEntry.linkTarget !== before.linkTarget) return false;
    }
    return true;
  }

  /** 中断恢复：核对备份完整性后按 receipt 断点续做；备份损坏报错给出恢复入口。 */
  private async resumeFromReceipt(root: string, taskId: string, pending: { opId: string; receipt: HandoffReceipt; receiptPath: string }, now: Date): Promise<WorktreeHandoffResult> {
    const paths = transferPaths(root, pending.opId);
    const state = readTransferState(paths);
    const problem = state === null ? "备份暂存缺失" : verifySnapshot(paths, state.manifest, state.bytes).problem;
    if (state === null || problem !== null) {
      throw new TaskGuardError(
        "handoff_backup_corrupt",
        `上次交接未完成且备份不完整（${problem ?? "未知"}），不覆盖目标也不丢弃源；备份与回执位于: ${paths.dir}`,
      );
    }
    return await this.applyAndFinish(root, taskId, paths, pending.receipt.sourceDir, now, "resumed");
  }

  /** 共同收尾：目标核对 → 应用 → 删除项 → 重算核验 → 回执 → 处置源 → 切绑定。 */
  private async applyAndFinish(root: string, taskId: string, paths: TransferPaths, sourceDir: string, now: Date, mode: "completed" | "resumed"): Promise<WorktreeHandoffResult> {
    const receipt = readReceipt(paths);
    if (receipt === null) {
      throw new TaskGuardError("handoff_backup_corrupt", `交接回执缺失，无法续做: ${paths.dir}`);
    }
    const state = readTransferState(paths);
    if (state === null) {
      throw new TaskGuardError("handoff_backup_corrupt", `交接暂存缺失: ${paths.dir}`);
    }
    const binding = await this.requireBinding(taskId);
    const worktree = this.resolveTargetWorktree(root, binding, receipt.targetWorktreePath);
    const baseline = receipt.baseline;

    // 目标定位：同 ID 任务目录（目录名可不同）；期望位置为源目录名。
    const located = locateTargetTaskDirs(worktree.path, taskId);
    if (located.unparsed.length > 0) {
      // task.md 不可解析的目录无法核实身份与基线，覆盖即可能丢弃本地修改。
      throw new TaskGuardError(
        "handoff_conflict",
        `目标任务目录 task.md 无法解析，先人工核实: ${located.unparsed.join(", ")}；源备份: ${paths.dir}`,
      );
    }
    const targetTasks = located.dirs;
    const targetTask = targetTasks.find((item) => resolve(item.dir) === resolve(join(worktree.path, ".knit", "tasks", receipt.sourceDirName)))
      ?? targetTasks[0]
      ?? null;
    const staleSiblings = targetTasks.filter((item) => resolve(item.dir) !== resolve(targetTask?.dir ?? ""));
    const desiredDir = join(worktree.path, ".knit", "tasks", receipt.sourceDirName);
    const rename = targetTask !== null && resolve(targetTask.dir) !== resolve(desiredDir);
    if (targetTask !== null) {
      // 逐项核对目标现存内容与基线：基线一致才可覆盖（冲突即停，保留两边）。
      const trackedAtBaseline = this.baselineTrackedPaths(worktree.path, baseline, targetTask.dir);
      const trackedRelative = new Set<string>();
      for (const repoPath of trackedAtBaseline) {
        const relativeInTask = relative(targetTask.dir, resolve(worktree.path, repoPath)).split(sep).join("/");
        if (relativeInTask !== "" && !relativeInTask.startsWith("..")) trackedRelative.add(relativeInTask);
      }
      for (const repoRelative of trackedAtBaseline) {
        const verdict = targetMatchesBaseline(worktree.path, baseline, resolve(worktree.path, repoRelative));
        if (!verdict.matches) {
          throw new TaskGuardError(
            "handoff_conflict",
            `目标 ${repoRelative} 与基线不同（${verdict.problem ?? "本地修改"}），保留两边待核实；源备份: ${paths.dir}`,
          );
        }
      }
      const extras = targetHasUnmanifestedEntries(targetTask.dir, state.manifest, trackedRelative);
      if (extras.length > 0) {
        throw new TaskGuardError(
          "handoff_conflict",
          `目标存在来源不明的额外资料，保留两边待核实: ${extras.slice(0, 5).join(", ")}；源备份: ${paths.dir}`,
        );
      }
    }

    // 应用：按 manifest 写入期望目录（改名时新目录全新写入）。
    writeJournalLine(paths, "apply", "planned", { target: desiredDir, rename });
    applyEntriesToTarget(desiredDir, state.manifest, state.bytes);
    writeJournalLine(paths, "apply", "applied", { target: desiredDir, rename });

    // 目录改名与旧目录清理：内容已核对与基线一致，整体移除，使目标任务资料只位于选定路径。
    const cleanupDirs = [
      ...(rename && targetTask !== null ? [targetTask.dir] : []),
      ...staleSiblings.map((item) => item.dir),
    ];
    for (const cleanupDir of cleanupDirs) {
      writeJournalLine(paths, "rename_cleanup", "planned", { from: cleanupDir });
      rmSync(cleanupDir, { recursive: true, force: true });
      writeJournalLine(paths, "rename_cleanup", "applied", { from: cleanupDir });
    }

    // 删除项：目标基线跟踪但源清单缺席的路径（应用前已核对目标与基线一致）。
    const deletions = targetTask === null ? [] : this.deletionsForTarget(worktree.path, baseline, targetTask.dir, state.manifest);
    if (deletions.length > 0) {
      writeJournalLine(paths, "delete", "planned", { count: deletions.length });
      applyDeletions(desiredDir, deletions);
      writeJournalLine(paths, "delete", "applied", { count: deletions.length });
    }

    // 逐项重算目标侧指纹；全部一致才视为交接完整。
    verifyAppliedTarget(desiredDir, state.manifest, state.bytes);
    writeJournalLine(paths, "verify", "applied", { target: desiredDir });

    const finishedAt = now.toISOString();
    receipt.finishedAt = finishedAt;
    receipt.targetTaskDir = desiredDir;
    this.saveReceipt(paths, receipt);

    // 源资料处置：无任何 Git 跟踪文件 → 整目录移入 transfers；混合 → 保留并报告待清理。
    const trackedFiles = this.sourceTrackedFiles(root, sourceDir);
    let sourceDisposition: WorktreeHandoffResult["sourceDisposition"] = "kept_tracked";
    if (trackedFiles.length === 0) {
      const archive = join(paths.dir, "source-original");
      writeJournalLine(paths, "source_move", "planned", { to: archive });
      renameSync(sourceDir, archive);
      writeJournalLine(paths, "source_move", "applied", { to: archive });
      sourceDisposition = "moved_untracked";
    }

    const bindingAfter = await this.switchBinding(taskId, worktree, finishedAt, receipt.opId);
    return {
      taskId,
      opId: receipt.opId,
      mode,
      sourceDir,
      targetTaskDir: desiredDir,
      worktreePath: worktree.path,
      branch: worktree.branch,
      bindingBranchSwitched: bindingAfter.branch === worktree.branch,
      sourceDisposition,
      files: state.manifest.filter((entry) => entry.kind === "file").length,
      deleted: deletions.length,
      untracked: receipt.untracked.length,
    };
  }

  /** 目标侧在基线提交中跟踪的路径（相对 worktree 根，限定目标任务目录前缀）。 */
  private baselineTrackedPaths(worktreePath: string, baseline: string, taskDir: string): string[] {
    const prefix = relative(worktreePath, taskDir).split(sep).join("/");
    const result = gitSync(["ls-tree", "-r", "-z", "--name-only", baseline, "--", `:(literal)${prefix}`], worktreePath);
    if (result.code !== 0) return [];
    return result.stdout.split("\0").filter((path) => path !== "");
  }

  /** 目标应删除项：基线跟踪 ∩ 源清单缺席（旧目录前缀下的路径映射到相对路径）。 */
  private deletionsForTarget(worktreePath: string, baseline: string, taskDir: string, manifest: HandoffEntry[]): string[] {
    const present = new Set<string>();
    for (const entry of manifest) {
      if (entry.kind === "absent") continue;
      present.add(entry.relativePath);
    }
    const prefix = relative(worktreePath, taskDir).split(sep).join("/");
    const result = gitSync(["ls-tree", "-r", "-z", "--name-only", baseline, "--", `:(literal)${prefix}`], worktreePath);
    if (result.code !== 0) return [];
    const deleted: string[] = [];
    for (const repoPath of result.stdout.split("\0")) {
      if (repoPath === "") continue;
      const relativeInTask = relative(taskDir, resolve(worktreePath, repoPath)).split(sep).join("/");
      if (relativeInTask === "" || relativeInTask.startsWith("..")) continue;
      if (!present.has(relativeInTask)) deleted.push(relativeInTask);
    }
    return deleted;
  }

  private sourceTrackedFiles(root: string, sourceDir: string): string[] {
    const spec = `:(literal)${relative(root, sourceDir).split(sep).join("/")}`;
    const result = gitSync(["ls-files", "-z", "--", spec], root);
    if (result.code !== 0) return [relative(root, sourceDir)]; // 不可判定按有跟踪处理，保守保留
    return result.stdout.split("\0").filter((path) => path !== "");
  }

  /** 核验成功后的绑定切换：worktree.active/handoffAt/lastHandoffOp 与主字段 branch；relativePath 不变。 */
  private async switchBinding(taskId: string, worktree: WorktreeInfo, finishedAt: string, opId: string): Promise<TaskBinding> {
    const current = await this.requireBinding(taskId);
    const next: TaskBinding = {
      ...current,
      branch: worktree.branch,
      worktree: { ...worktree, active: true, handoffAt: finishedAt, lastHandoffOp: opId },
    };
    await this.store.bindings.save(next);
    return next;
  }

  private async hasActiveRun(taskId: string): Promise<boolean> {
    for (const runId of this.runs.listRunIds()) {
      const request = this.runs.readRequest(runId);
      if (request === null || request.taskId !== taskId) continue;
      const state = this.runs.readState(runId);
      if (state !== null && ["completed", "cancelled", "failed"].includes(state.state)) continue;
      return true;
    }
    return false;
  }

  private async requireBinding(taskId: string): Promise<TaskBinding> {
    const binding = await this.store.bindings.get(taskId);
    if (binding === null) {
      throw new TaskGuardError("unknown_binding", `任务缺少绑定: ${taskId}`);
    }
    return binding;
  }
}
