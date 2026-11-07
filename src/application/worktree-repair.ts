/**
 * `knit worktree repair` 核心（任务 k-d10f8d4c2833；WORKTREE.md §6.5、DESIGN.md §16.3）。
 * 项目或 project 布局 worktree 整体移动后，从主检出核实身份与目录关系：
 * 只按可证明关系修复 Git 关联与本机定位，保留 taskId、历史 run、来源与未知项。
 *
 * 边界：只改 binding 定位与受影响 Session 的 cwd／sessionFile；不改任务业务状态、
 * 分支归属、历史 run 资料，不执行 prune／删除／提交／推送，也不接管或取消执行。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { ensurePrivateDir } from "../infrastructure/private-mode.js";
import { gitSync, machineBootId, procStartTicks, sameProcessStart } from "../infrastructure/process.js";
import { LockManager, orderKeys, type LockKey } from "../infrastructure/locks.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { GuardError } from "./guard-error.js";
import { parseTaskDocument } from "./task-document.js";
import { resolveProjectStart, verifyWorktreeRegistration } from "./worktree-routing.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskBinding } from "../contracts/metadata.js";
import type { SessionRecord } from "../contracts/session.js";

/** 修复回执容器（相对项目根）；运行资料按任务边界不进 worktree。 */
export const REPAIR_DIR = join(".knit", ".runtime", "worktree-repair");
const RECEIPT_FILE = "receipt.json";
const JOURNAL_FILE = "journal.jsonl";
const TASK_FILE = "task.md";
const RUNTIME_DIR = join(".knit", ".runtime");
const PI_SESSIONS_DIR = join(RUNTIME_DIR, "pi-sessions");
const PROJECT_WORKTREE_PREFIX = join(".knit", "worktrees");
const TERMINAL_RUN_STATES = new Set(["completed", "cancelled", "failed"]);

export type RepairStatus =
  | "ok"
  | "repairable"
  | "repaired"
  | "invalid"
  | "conflict"
  | "blocked_active"
  | "blocked_unknown"
  | "failed";

/** 逐任务修复结果与诊断；只读模式没有 repaired。 */
export interface RepairTaskResult {
  taskId: string;
  status: RepairStatus;
  oldRoot: string;
  newRoot: string;
  oldWorktreePath: string | null;
  newWorktreePath: string | null;
  layout: "project" | "global" | null;
  branch: string | null;
  /** Git 关联核实结论；无 worktree 或未检查时为 null。 */
  association: "valid" | "needs_repair" | "missing" | "foreign" | "ambiguous" | null;
  reason: string | null;
  plannedActions: string[];
  appliedActions: string[];
}

export interface WorktreeRepairResult {
  mainRoot: string;
  /** 只读模式为 null；本次没有候选或 no-op 时也可能为 null。 */
  opId: string | null;
  apply: boolean;
  /** true 表示没有候选需要动作（无移动、无失效关联）。 */
  noop: boolean;
  tasks: RepairTaskResult[];
  journalPath: string | null;
  receiptPath: string | null;
}

export interface WorktreeRepairOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
}

interface RepairPaths {
  root: string;
  dir: string;
  receipt: string;
  journal: string;
}

interface RepairReceiptTask {
  taskId: string;
  status: RepairStatus;
  oldRoot: string;
  newRoot: string;
  oldWorktreePath: string | null;
  newWorktreePath: string | null;
  completedSteps: string[];
  reason: string | null;
}

interface RepairReceipt {
  schemaVersion: 1;
  opId: string;
  mainRoot: string;
  applied: boolean;
  tasks: RepairReceiptTask[];
  finishedAt: string | null;
}

interface AssociationVerdict {
  state: "valid" | "needs_repair" | "missing" | "foreign" | "ambiguous";
  problem: string | null;
  /** true 表示分支／frontmatter 等占用冲突，按 conflict 处理。 */
  conflict: boolean;
}

interface PlannedRepair {
  result: RepairTaskResult;
  binding: TaskBinding;
  /** 本任务需要执行的 Git 关联修复；false 为无需 repair（已可用）。 */
  needsGitRepair: boolean;
  targetWorktreePath: string | null;
  registration: WorktreeInfo | null;
  /** 旧主检出／旧 worktree 路径，用于 Session 映射。 */
  oldRoot: string;
  oldWorktreePath: string | null;
}

interface ActivityVerdict {
  status: "none" | "active" | "unknown";
  reason: string | null;
}

function newOpId(): string {
  return `op-${randomBytes(6).toString("hex")}`;
}

function repairPaths(root: string, opId: string): RepairPaths {
  const dir = join(root, REPAIR_DIR, opId);
  return {
    root,
    dir,
    receipt: join(dir, RECEIPT_FILE),
    journal: join(dir, JOURNAL_FILE),
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `dir` 是否等于或包含 `candidate`（不同根目录不视为包含）。 */
function insideDir(dir: string, candidate: string): boolean {
  const rel = relative(resolve(dir), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 旧路径映射到新根：只在等于旧根或位于旧根下时返回新位置。 */
function mapUnder(oldBase: string, newBase: string, value: string): string | null {
  if (!insideDir(oldBase, value)) return null;
  const rel = relative(resolve(oldBase), resolve(value));
  return rel === "" ? resolve(newBase) : join(resolve(newBase), rel);
}

/** `.git` 文件中的 gitdir 目标；目录或无 gitdir 行返回 null。 */
function gitdirTarget(worktreePath: string): string | null {
  const file = join(worktreePath, ".git");
  if (!existsSync(file)) return null;
  try {
    if (statSync(file).isDirectory()) return null;
    const text = readFileSync(file, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
    if (match === null) return null;
    const value = match[1]?.trim();
    if (value === undefined || value === "") return null;
    return isAbsolute(value) ? resolve(value) : resolve(worktreePath, value);
  } catch {
    return null;
  }
}

/** 路径是否位于 `<root>/.git/worktrees/` 下。 */
function insideGitWorktrees(root: string, candidate: string): boolean {
  return insideDir(join(root, ".git", "worktrees"), candidate);
}

function branchAncestorOk(mainRoot: string, baseline: string, branch: string): boolean {
  return gitSync(["merge-base", "--is-ancestor", baseline, branch], mainRoot).code === 0;
}

/** worktree 登记列表；Git 失败按项目级错误上抛（不猜现场）。 */
function listWorktreeEntries(mainRoot: string): Array<{ path: string; branch: string | null }> {
  const result = gitSync(["worktree", "list", "--porcelain"], mainRoot);
  if (result.code !== 0) {
    throw new GuardError("git_unavailable", `git worktree list 失败: ${result.stderr.trim() || "无输出"}`);
  }
  const entries: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

/**
 * 任务目录内 task.md 的 frontmatter id；缺失或不可解析返回 null。
 * binding.relativePath 的历史形态有两种（`tasks/...` 相对 `.knit`，或 `.knit/tasks/...`
 * 相对项目根），按两种基址与补全 task.md 的顺序核实，不猜测其它位置。
 */
function taskIdAt(worktreePath: string, taskRelativePath: string): string | null {
  const relatives = [taskRelativePath];
  if (!taskRelativePath.endsWith(`/${TASK_FILE}`) && taskRelativePath !== TASK_FILE) {
    relatives.push(join(taskRelativePath, TASK_FILE));
  }
  const files = [
    ...relatives.map((rel) => join(worktreePath, ".knit", rel)),
    ...relatives.map((rel) => join(worktreePath, rel)),
  ];
  for (const file of [...new Set(files)]) {
    if (!existsSync(file)) continue;
    try {
      return parseTaskDocument(readFileSync(file, "utf8"), file).frontmatter.id;
    } catch {
      return null;
    }
  }
  return null;
}

/** 项目布局的新路径必须位于 `.knit` 资料目录内，且新路径存在。 */
function projectTargetOf(mainRoot: string, info: WorktreeInfo): { path: string | null; problem: string | null } {
  const rel = info.relativePath;
  if (rel === undefined || rel === "") {
    return { path: null, problem: "project 布局缺少 relativePath，无法证明新位置" };
  }
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    return { path: null, problem: `relativePath 越界，无法证明新位置: ${rel}` };
  }
  let target: string;
  try {
    target = safeJoin(mainRoot, rel);
  } catch (error) {
    return { path: null, problem: `relativePath 越界或经符号链接逃逸: ${rel}: ${String(error)}` };
  }
  if (!insideDir(join(mainRoot, ".knit"), target) || resolve(target) === resolve(join(mainRoot, ".knit"))) {
    return { path: null, problem: `relativePath 不在项目资料目录内: ${rel}` };
  }
  if (!insideDir(join(mainRoot, PROJECT_WORKTREE_PREFIX), target)) {
    return { path: null, problem: `relativePath 不在 .knit/worktrees/ 内: ${rel}` };
  }
  if (!existsSync(target) || !isDirectory(target)) {
    return { path: null, problem: `新路径缺失: ${target}` };
  }
  return { path: target, problem: null };
}

function registrationConflict(entries: Array<{ path: string; branch: string | null }>, path: string, branch: string): string | null {
  const entry = entries.find((candidate) => resolve(candidate.path) === resolve(path));
  if (entry !== undefined && entry.branch !== branch) {
    return `登记分支不符: 期望 ${branch}，实际 ${entry.branch ?? "（detached）"}`;
  }
  return null;
}

/**
 * Git 关联核实：只读判断 worktree 当前是否指向当前主检出、登记路径与分支是否相符。
 * 结果均为事实描述，不修改现场；conflict 表示路径／分支被其它对象占用。
 */
function inspectAssociation(input: {
  mainRoot: string;
  oldRoot: string;
  path: string;
  branch: string;
  baseline: string;
  oldWorktreePath: string | null;
  entries: Array<{ path: string; branch: string | null }>;
}): AssociationVerdict {
  const { mainRoot, oldRoot, path, branch, baseline, oldWorktreePath, entries } = input;
  const conflict = registrationConflict(entries, path, branch);
  if (conflict !== null) return { state: "needs_repair", problem: conflict, conflict: true };
  // 旧路径上的登记仍是本 worktree 的 Git 管理入口；分支被改走时按占用冲突处理，不擅自改分支。
  if (oldWorktreePath !== null && resolve(oldWorktreePath) !== resolve(path)) {
    const stale = entries.find((entry) => resolve(entry.path) === resolve(oldWorktreePath));
    if (stale !== undefined && stale.branch !== branch) {
      return {
        state: "needs_repair",
        problem: `旧路径登记分支不符: 期望 ${branch}，实际 ${stale.branch ?? "（detached）"}`,
        conflict: true,
      };
    }
  }

  // 同一分支已登记在其它路径：旧 worktree 路径属本次移动线索，其余路径视为歧义。
  const sameBranch = entries.filter((entry) => entry.branch === branch);
  const elsewhere = sameBranch.filter((entry) => resolve(entry.path) !== resolve(path));
  if (elsewhere.length > 0) {
    const allStale = elsewhere.every((entry) => oldWorktreePath !== null && resolve(entry.path) === resolve(oldWorktreePath));
    if (!allStale) {
      return {
        state: "ambiguous",
        problem: `分支 ${branch} 已登记在其它路径: ${elsewhere.map((entry) => entry.path).join(", ")}`,
        conflict: false,
      };
    }
  }

  const start = resolveProjectStart(path);
  const revParse = gitSync(["rev-parse", "--show-toplevel"], path);
  if (revParse.code === 0) {
    const top = resolve(revParse.stdout.trim());
    if (top !== resolve(path)) {
      return { state: "foreign", problem: `目标目录不是 worktree 根: ${path}（实际 ${top}）`, conflict: true };
    }
    if (!start.linkedWorktree) {
      return { state: "foreign", problem: `目标目录是其它 Git 主检出: ${path}`, conflict: true };
    }
    if (resolve(start.mainRoot) === resolve(mainRoot)) {
      const entry = entries.find((candidate) => resolve(candidate.path) === resolve(path));
      if (entry === undefined) {
        return { state: "needs_repair", problem: `未在 git worktree list 中: ${path}`, conflict: false };
      }
      if (entry.branch !== branch) {
        return { state: "needs_repair", problem: `登记分支不符: 期望 ${branch}，实际 ${entry.branch ?? "（detached）"}`, conflict: true };
      }
      if (!branchAncestorOk(mainRoot, baseline, branch)) {
        return {
          state: "needs_repair",
          problem: `登记分支 ${branch} 不在基线 ${baseline} 或其后代`,
          conflict: false,
        };
      }
      return { state: "valid", problem: null, conflict: false };
    }
    if (oldRoot !== mainRoot && resolve(start.mainRoot) === resolve(oldRoot)) {
      return { state: "needs_repair", problem: `gitdir 仍指旧主检出: ${oldRoot}`, conflict: false };
    }
    return {
      state: "foreign",
      problem: `worktree 归属其它主检出: ${start.mainRoot}`,
      conflict: true,
    };
  }

  // rev-parse 失败：按 .git 文件判断是否只是登记路径失效。
  const dotGit = join(path, ".git");
  if (!existsSync(dotGit)) {
    return { state: "foreign", problem: `目标目录不是 Git worktree: ${path}`, conflict: true };
  }
  if (isDirectory(dotGit)) {
    return { state: "foreign", problem: `目标目录是其它 Git 主检出: ${path}`, conflict: true };
  }
  const target = gitdirTarget(path);
  if (target === null) {
    return { state: "needs_repair", problem: `无法读取 worktree 的 .git 关联: ${path}`, conflict: false };
  }
  if (insideGitWorktrees(mainRoot, target)) {
    return { state: "needs_repair", problem: `worktree gitdir 未指向可用登记: ${target}`, conflict: false };
  }
  if (oldRoot !== mainRoot && insideGitWorktrees(oldRoot, target)) {
    return { state: "needs_repair", problem: `worktree gitdir 仍指旧主检出: ${target}`, conflict: false };
  }
  return { state: "foreign", problem: `worktree gitdir 指向其它仓库: ${target}`, conflict: true };
}

/** 其它 binding 可能占用的目标路径（已登记路径＋project 相对路径推导）。 */
function bindingTargets(binding: TaskBinding, mainRoot: string): string[] {
  const info = binding.worktree;
  if (info === undefined) return [];
  const targets = [info.path];
  if (info.layout === "project" && info.relativePath !== undefined) {
    targets.push(join(mainRoot, info.relativePath));
  }
  return targets;
}

/** 旧路径仍被 Git 或其它任务占用时不得覆盖。 */
function oldPathConflict(input: {
  oldWorktreePath: string;
  targetWorktreePath: string;
  mainRoot: string;
  entries: Array<{ path: string; branch: string | null }>;
  bindings: TaskBinding[];
  taskId: string;
}): string | null {
  const { oldWorktreePath, targetWorktreePath, mainRoot, entries, bindings, taskId } = input;
  if (resolve(oldWorktreePath) === resolve(targetWorktreePath)) return null;
  for (const other of bindings) {
    if (other.taskId === taskId) continue;
    if (bindingTargets(other, mainRoot).some((target) => resolve(target) === resolve(oldWorktreePath))) {
      return `旧路径属于其它任务 ${other.taskId}: ${oldWorktreePath}`;
    }
  }
  if (!existsSync(oldWorktreePath)) return null;
  const registration = entries.find((entry) => resolve(entry.path) === resolve(oldWorktreePath));
  if (registration !== undefined) {
    return `旧路径仍被 Git 登记占用: ${oldWorktreePath}（${registration.branch ?? "（detached）"}）`;
  }
  const start = resolveProjectStart(oldWorktreePath);
  const revParse = gitSync(["rev-parse", "--show-toplevel"], oldWorktreePath);
  if (revParse.code === 0) {
    if (start.linkedWorktree && resolve(start.mainRoot) === resolve(mainRoot)) {
      return `旧路径仍是本仓库的 Git worktree: ${oldWorktreePath}`;
    }
    return `旧路径仍是 Git 工作区: ${oldWorktreePath}`;
  }
  // 关联不可读但残留 .git：仍属占用，保留现场交人工核实。
  if (existsSync(join(oldWorktreePath, ".git"))) {
    return `旧路径仍有 .git 关联，占用未解除: ${oldWorktreePath}`;
  }
  return null;
}

/** 新路径被其它任务或其它分支占用。 */
function targetPathConflict(input: {
  targetWorktreePath: string;
  taskId: string;
  bindings: TaskBinding[];
  entries: Array<{ path: string; branch: string | null }>;
  branch: string;
  mainRoot: string;
}): string | null {
  const { targetWorktreePath, taskId, bindings, entries, branch, mainRoot } = input;
  for (const other of bindings) {
    if (other.taskId === taskId) continue;
    if (bindingTargets(other, mainRoot).some((target) => resolve(target) === resolve(targetWorktreePath))) {
      return `新路径已被其它任务 ${other.taskId} 登记: ${targetWorktreePath}`;
    }
  }
  const entry = entries.find((candidate) => resolve(candidate.path) === resolve(targetWorktreePath));
  if (entry !== undefined && entry.branch !== branch) {
    return `新路径被其它分支占用: ${entry.branch ?? "（detached）"}`;
  }
  return null;
}

/** run 与阶段进程核实：非终态 run 为 active；缺失／损坏状态按 unknown。 */
function runActivity(root: string, taskId: string): ActivityVerdict {
  const runs = new RunStore(root);
  let unknown: string | null = null;
  for (const runId of runs.listRunIds()) {
    let request;
    try {
      request = runs.readRequest(runId);
    } catch {
      unknown = unknown ?? `run ${runId} request 不可读`;
      continue;
    }
    if (request === null) {
      unknown = unknown ?? `run ${runId} 缺少 request`;
      continue;
    }
    if (request.taskId !== taskId) continue;
    let state;
    try {
      state = runs.readState(runId);
    } catch {
      unknown = unknown ?? `run ${runId} state 不可读`;
      continue;
    }
    if (state === null) {
      unknown = unknown ?? `run ${runId} 状态未知`;
      continue;
    }
    if (!TERMINAL_RUN_STATES.has(state.state)) {
      return { status: "active", reason: `run ${runId} 状态 ${state.state}` };
    }
    let stage;
    try {
      stage = runs.readStageProcess(runId);
    } catch {
      unknown = unknown ?? `run ${runId} 阶段进程不可读`;
      continue;
    }
    if (stage !== null && stage.state !== "exited" && stage.piPid !== null) {
      const alive = processAlive(stage.piPid, stage.bootId, stage.procStartTicks);
      if (alive !== "not_alive") {
        return {
          status: alive === "unknown" ? "unknown" : "active",
          reason: `run ${runId} 阶段进程 ${alive}`,
        };
      }
    }
  }
  return unknown === null ? { status: "none", reason: null } : { status: "unknown", reason: unknown };
}

/** 进程身份核实（与锁同口径；跨机／标识不符按 unknown）。 */
function processAlive(pid: number, bootId: string, ticks: string | null): "alive" | "not_alive" | "unknown" {
  if (bootId !== machineBootId()) return "unknown";
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "not_alive";
    return "unknown";
  }
  const current = procStartTicks(pid);
  if (current === null || ticks === null) return "alive";
  return sameProcessStart(ticks, current) ? "alive" : "not_alive";
}

/** 任务锁核实：只读 inspect，不创建锁目录；旧根与新根都核对。 */
function lockActivity(locks: LockManager, roots: string[], taskId: string): ActivityVerdict {
  let unknown: string | null = null;
  for (const root of roots) {
    const key: LockKey = { scope: "task", rawKey: `${root}::${taskId}` };
    const status = locks.inspect(key);
    if (!status.exists) continue;
    if (status.owner === null || status.processVerdict === "unknown") {
      unknown = unknown ?? `任务锁 owner 不可核实: ${root}`;
      continue;
    }
    if (status.processVerdict === "alive") {
      return { status: "active", reason: `任务锁仍被占用: ${root}` };
    }
  }
  return unknown === null ? { status: "none", reason: null } : { status: "unknown", reason: unknown };
}

function combineActivity(...verdicts: ActivityVerdict[]): ActivityVerdict {
  for (const verdict of verdicts) {
    if (verdict.status === "active") return verdict;
  }
  for (const verdict of verdicts) {
    if (verdict.status === "unknown") return verdict;
  }
  return { status: "none", reason: null };
}

/** cwd 映射：等于旧主检出，或位于旧 project worktree 路径下。 */
function mapSessionCwd(oldRoot: string, newRoot: string, oldWorktreePath: string | null, newWorktreePath: string | null, cwd: string): string {
  if (oldWorktreePath !== null && newWorktreePath !== null && resolve(oldWorktreePath) !== resolve(newWorktreePath)) {
    const mapped = mapUnder(oldWorktreePath, newWorktreePath, cwd);
    if (mapped !== null) return mapped;
  }
  if (resolve(cwd) === resolve(oldRoot)) return resolve(newRoot);
  return cwd;
}

/** sessionFile 映射：仅旧根 pi-sessions 下且新位置文件存在时更新。 */
function mapSessionFile(oldRoot: string, newRoot: string, sessionFile: string | null): string | null {
  if (sessionFile === null) return null;
  const sessionsRoot = join(oldRoot, PI_SESSIONS_DIR);
  if (!insideDir(sessionsRoot, sessionFile)) return sessionFile;
  const mapped = mapUnder(oldRoot, newRoot, sessionFile);
  if (mapped === null) return sessionFile;
  return existsSync(mapped) ? mapped : sessionFile;
}

function receiptForTasks(
  tasks: RepairTaskResult[],
  prior: RepairReceipt | null,
): RepairReceiptTask[] {
  const current = tasks.map((task) => {
    const previous = prior?.tasks.find((candidate) => candidate.taskId === task.taskId);
    return {
      taskId: task.taskId,
      status: task.status,
      oldRoot: task.oldRoot,
      newRoot: task.newRoot,
      oldWorktreePath: task.oldWorktreePath,
      newWorktreePath: task.newWorktreePath,
      completedSteps: previous?.completedSteps ?? task.appliedActions,
      reason: task.reason,
    };
  });
  // 续做时保留上次回执中本次未选中的任务事实，不丢已记录结果。
  const ids = new Set(current.map((task) => task.taskId));
  const carried = (prior?.tasks ?? []).filter((task) => !ids.has(task.taskId));
  return [...current, ...carried];
}

/** 由 binding 与目标路径构造核验登记；layout 与 relativePath 保持原样。 */
function registrationOf(info: WorktreeInfo, targetPath: string): WorktreeInfo {
  return { ...info, path: targetPath };
}

function writeJournalLine(paths: RepairPaths, stepId: string, kind: string, evidence?: Record<string, unknown>): void {
  ensurePrivateDir(paths.dir);
  const line = JSON.stringify({ stepId, kind, at: new Date().toISOString(), ...(evidence ?? {}) }) + "\n";
  if (!existsSync(paths.journal)) writeFileSync(paths.journal, "", { mode: 0o600 });
  const existing = readFileSync(paths.journal, "utf8");
  writeFileSync(paths.journal, existing + line, { mode: 0o600 });
}

function saveReceipt(paths: RepairPaths, receipt: RepairReceipt): void {
  ensurePrivateDir(paths.dir);
  atomicWrite({
    path: paths.receipt,
    data: Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
    mode: 0o600,
  });
}

function readReceipt(paths: RepairPaths): RepairReceipt | null {
  const version = readWithVersion(paths.receipt);
  if (version === null) return null;
  try {
    return JSON.parse(version.data.toString("utf8")) as RepairReceipt;
  } catch {
    return null;
  }
}

/** 最近一份未完成修复回执；用于中断后沿用同一操作目录续做。 */
function findPendingReceipt(mainRoot: string): { opId: string; receipt: RepairReceipt; paths: RepairPaths } | null {
  const root = join(mainRoot, REPAIR_DIR);
  if (!existsSync(root)) return null;
  let latest: { opId: string; receipt: RepairReceipt; paths: RepairPaths } | null = null;
  for (const name of readdirSync(root).sort()) {
    if (!/^op-[0-9a-f]{12}$/.test(name)) continue;
    const paths = repairPaths(mainRoot, name);
    const receipt = readReceipt(paths);
    if (receipt === null || receipt.finishedAt !== null) continue;
    if (resolve(receipt.mainRoot) !== resolve(mainRoot)) continue;
    latest = { opId: name, receipt, paths };
  }
  return latest;
}

export class WorktreeRepairService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;

  constructor(options: WorktreeRepairOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
  }

  private taskLock(root: string, taskId: string): LockKey {
    return { scope: "task", rawKey: `${root}::${taskId}` };
  }

  /**
   * 预检并（可选）应用修复。只读模式不创建任何目录／文件，也不运行 git worktree repair；
   * apply 先整体预检，再持项目锁逐任务执行，单个任务阻塞或失败不冒充已修复。
   */
  async repair(input: { dir: string; taskId?: string; apply?: boolean }): Promise<WorktreeRepairResult> {
    const start = resolveProjectStart(input.dir);
    if (start.linkedWorktree) {
      throw new GuardError(
        "main_checkout_required",
        `worktree repair 只在主检出运行；当前 ${start.executionDir} 位于关联 worktree`,
      );
    }
    const mainRoot = normalizeRoot(start.mainRoot);
    this.assertMainCheckout(mainRoot);
    const apply = input.apply === true;
    const bindings = await this.store.bindings.list();
    if (input.taskId !== undefined && !bindings.some((binding) => binding.taskId === input.taskId)) {
      throw new GuardError("unknown_binding", `任务缺少绑定: ${input.taskId}`);
    }
    const pendingAcceptance = await this.pendingAcceptanceActivity(mainRoot);
    const allPlans = bindings.map((binding) =>
      this.precheck(binding, bindings, mainRoot, true, pendingAcceptance.get(binding.taskId) ?? null));
    const plans = input.taskId === undefined
      ? allPlans
      : allPlans.filter((plan) => plan.result.taskId === input.taskId);
    const resultTasks = plans.map((plan) => plan.result);
    const blockedTaskIds = new Set(
      allPlans
        .filter((plan) => ["invalid", "conflict", "blocked_active", "blocked_unknown", "failed"].includes(plan.result.status))
        .map((plan) => plan.result.taskId),
    );
    const needsAction = resultTasks.some((task) => ["repairable", "invalid", "conflict", "blocked_active", "blocked_unknown"].includes(task.status));

    if (!apply) {
      return {
        mainRoot,
        opId: null,
        apply: false,
        noop: !needsAction,
        tasks: resultTasks,
        journalPath: null,
        receiptPath: null,
      };
    }
    if (!needsAction) {
      // 上次中断的修复若已全部一致，收束其回执；不新建操作、不重复 Git 副作用。
      const pending = findPendingReceipt(mainRoot);
      const statusById = new Map(allPlans.map((plan) => [plan.result.taskId, plan.result.status]));
      const pendingDone = pending !== null && pending.receipt.tasks.every((task) => {
        const status = statusById.get(task.taskId);
        return status === undefined || status === "ok";
      });
      if (pending !== null && pendingDone) {
        for (const task of pending.receipt.tasks) {
          const status = statusById.get(task.taskId);
          if (status !== undefined) task.status = status;
        }
        pending.receipt.finishedAt = this.now().toISOString();
        saveReceipt(pending.paths, pending.receipt);
        writeJournalLine(pending.paths, "finish", "completed", { finishedAt: pending.receipt.finishedAt });
        return {
          mainRoot,
          opId: pending.opId,
          apply: true,
          noop: true,
          tasks: resultTasks,
          journalPath: pending.paths.journal,
          receiptPath: pending.paths.receipt,
        };
      }
      return {
        mainRoot,
        opId: null,
        apply: true,
        noop: true,
        tasks: resultTasks,
        journalPath: null,
        receiptPath: null,
      };
    }

    // 中断续做：沿用未完成回执的操作目录；否则新建。先落预检计划再执行。
    const pending = findPendingReceipt(mainRoot);
    const opId = pending?.opId ?? newOpId();
    const paths = repairPaths(mainRoot, opId);
    if (pending !== null) {
      writeJournalLine(paths, "resume", "planned", { opId, tasks: resultTasks.map((task) => task.taskId) });
    } else {
      writeJournalLine(paths, "precheck", "planned", {
        opId,
        mainRoot,
        tasks: resultTasks.map((task) => ({
          taskId: task.taskId,
          status: task.status,
          oldRoot: task.oldRoot,
          newWorktreePath: task.newWorktreePath,
          actions: task.plannedActions,
        })),
      });
    }
    const receipt: RepairReceipt = {
      schemaVersion: 1,
      opId,
      mainRoot,
      applied: true,
      tasks: receiptForTasks(resultTasks, pending?.receipt ?? null),
      finishedAt: null,
    };
    saveReceipt(paths, receipt);

    const projectLock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: mainRoot }]),
      action: "worktree.repair",
    });
    try {
      const repairedBindings: TaskBinding[] = [];
      for (const plan of plans) {
        const taskResult = plan.result;
        if (!["repairable", "invalid", "conflict", "blocked_active", "blocked_unknown"].includes(taskResult.status)) continue;
        const executed = await this.executeTask(plan, mainRoot, paths, opId);
        Object.assign(taskResult, executed);
        if (executed.status === "repaired") repairedBindings.push(plan.binding);
        const receiptTask = receipt.tasks.find((task) => task.taskId === taskResult.taskId);
        if (receiptTask !== undefined) {
          receiptTask.status = taskResult.status;
          receiptTask.completedSteps = taskResult.appliedActions;
          receiptTask.reason = taskResult.reason;
          receiptTask.newWorktreePath = taskResult.newWorktreePath;
        }
        saveReceipt(paths, receipt);
        writeJournalLine(paths, "result", taskResult.status, {
          taskId: taskResult.taskId,
          reason: taskResult.reason,
          applied: taskResult.appliedActions,
        });
      }

      // 项目级定位归一：所有未阻塞／未冲突任务的 repoRoot → 新主检出；
      // 未选中任务的 worktree 路径字段保持原样，等待各自修复。
      if (repairedBindings.length > 0) {
        const blocked = new Set(blockedTaskIds);
        for (const plan of plans) {
          if (["invalid", "conflict", "blocked_active", "blocked_unknown", "failed"].includes(plan.result.status)) {
            blocked.add(plan.result.taskId);
          }
        }
        await this.sweepRepoRoot(mainRoot, blocked);
      }
    } finally {
      this.locks.release(projectLock);
    }

    const finishedAt = this.now().toISOString();
    receipt.finishedAt = finishedAt;
    saveReceipt(paths, receipt);
    writeJournalLine(paths, "finish", "completed", { finishedAt });
    return {
      mainRoot,
      opId,
      apply: true,
      noop: false,
      tasks: resultTasks,
      journalPath: paths.journal,
      receiptPath: paths.receipt,
    };
  }

  /** 项目级前置：Git 工作区、主检出身份（不在关联 worktree 内运行）。 */
  private assertMainCheckout(mainRoot: string): void {
    const inside = gitSync(["rev-parse", "--is-inside-work-tree"], mainRoot);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      throw new GuardError("git_required", `worktree repair 需要 Git 工作区: ${mainRoot}`);
    }
    const start = resolveProjectStart(mainRoot);
    if (start.linkedWorktree) {
      throw new GuardError(
        "main_checkout_required",
        `worktree repair 只在主检出运行；当前 ${mainRoot} 位于关联 worktree ${start.executionDir}`,
      );
    }
    if (resolve(start.mainRoot) !== resolve(mainRoot)) {
      throw new GuardError(
        "repo_mismatch",
        `主检出身份不符: 当前 ${mainRoot}，Git 主检出 ${start.mainRoot}`,
      );
    }
  }

  /** 只读预检：给出旧／新定位、Git 关联现状、可修复性、计划动作与阻塞。 */
  private precheck(
    binding: TaskBinding,
    bindings: TaskBinding[],
    mainRoot: string,
    checkTaskLocks = true,
    pendingAcceptance: ActivityVerdict | null = null,
  ): PlannedRepair {
    const oldRoot = binding.repoRoot;
    const info = binding.worktree;
    const entries = listWorktreeEntries(mainRoot);
    const base: RepairTaskResult = {
      taskId: binding.taskId,
      status: "ok",
      oldRoot,
      newRoot: mainRoot,
      oldWorktreePath: info?.path ?? null,
      newWorktreePath: info?.path ?? null,
      layout: info?.layout ?? null,
      branch: info?.branch ?? null,
      association: null,
      reason: null,
      plannedActions: [],
      appliedActions: [],
    };
    const plan: PlannedRepair = {
      result: base,
      binding,
      needsGitRepair: false,
      targetWorktreePath: info?.path ?? null,
      registration: null,
      oldRoot,
      oldWorktreePath: info?.path ?? null,
    };

    if (info === undefined) {
      if (resolve(oldRoot) !== resolve(mainRoot)) {
        const activity = combineActivity(
          runActivity(mainRoot, binding.taskId),
          checkTaskLocks
            ? lockActivity(this.locks, [oldRoot, mainRoot], binding.taskId)
            : { status: "none", reason: null },
          pendingAcceptance ?? { status: "none", reason: null },
        );
        if (activity.status === "active") {
          base.status = "blocked_active";
          base.reason = activity.reason;
          return plan;
        }
        if (activity.status === "unknown") {
          base.status = "blocked_unknown";
          base.reason = activity.reason;
          return plan;
        }
        base.status = "repairable";
        base.plannedActions.push(`binding.repoRoot → ${mainRoot}`);
      }
      return plan;
    }

    const rootMoved = resolve(oldRoot) !== resolve(mainRoot);
    if (rootMoved) base.plannedActions.push(`binding.repoRoot → ${mainRoot}`);

    let targetPath: string;
    if (info.layout === "project") {
      const target = projectTargetOf(mainRoot, info);
      if (target.path === null) {
        base.status = "invalid";
        base.reason = target.problem ?? "无法证明新位置";
        return plan;
      }
      targetPath = target.path;
    } else {
      targetPath = info.path;
      if (!existsSync(targetPath) || !isDirectory(targetPath)) {
        base.status = "invalid";
        base.reason = `worktree 路径缺失: ${targetPath}`;
        return plan;
      }
    }
    base.newWorktreePath = targetPath;
    plan.targetWorktreePath = targetPath;

    // 身份：目标目录任务资料的 id 必须等于 taskId；不符是占用冲突，不是可修复项。
    const targetTaskId = taskIdAt(targetPath, binding.relativePath);
    if (targetTaskId === null) {
      base.status = "invalid";
      base.reason = `目标路径任务资料缺失或不可解析: ${join(targetPath, binding.relativePath)}`;
      return plan;
    }
    if (targetTaskId !== binding.taskId) {
      base.status = "conflict";
      base.reason = `新路径任务身份不符: 期望 ${binding.taskId}，实际 ${targetTaskId}`;
      return plan;
    }

    const occupied = targetPathConflict({
      targetWorktreePath: targetPath,
      taskId: binding.taskId,
      bindings,
      entries,
      branch: info.branch,
      mainRoot,
    });
    if (occupied !== null) {
      base.status = "conflict";
      base.reason = occupied;
      return plan;
    }

    const oldConflict = oldPathConflict({
      oldWorktreePath: info.path,
      targetWorktreePath: targetPath,
      mainRoot,
      entries,
      bindings,
      taskId: binding.taskId,
    });
    if (oldConflict !== null) {
      base.status = "conflict";
      base.reason = oldConflict;
      return plan;
    }

    const association = inspectAssociation({
      mainRoot,
      oldRoot,
      path: targetPath,
      branch: info.branch,
      baseline: info.baseline,
      oldWorktreePath: info.path,
      entries,
    });
    base.association = association.state === "valid" ? "valid" : association.conflict ? "foreign" : association.state;
    if (association.problem !== null) base.reason = association.problem;
    if (association.conflict) {
      base.status = "conflict";
      return plan;
    }
    if (association.state === "ambiguous") {
      base.status = "invalid";
      return plan;
    }
    if (association.state === "needs_repair" || association.state === "missing") {
      plan.needsGitRepair = true;
      base.plannedActions.push(`git worktree repair ${targetPath}`);
    }
    if (resolve(targetPath) !== resolve(info.path)) {
      base.plannedActions.push(`binding.worktree.path → ${targetPath}`);
    }

    const registration = registrationOf(info, targetPath);
    plan.registration = registration;
    const needsWork = plan.needsGitRepair || rootMoved || resolve(targetPath) !== resolve(info.path);
    if (!needsWork) {
      base.status = "ok";
      base.reason = null;
      return plan;
    }

    // 活动／未知执行：只阻塞确有修复动作的任务；已一致的任务保持 ok（不介入）。
    const activity = combineActivity(
      runActivity(mainRoot, binding.taskId),
      checkTaskLocks
        ? lockActivity(this.locks, [oldRoot, mainRoot], binding.taskId)
        : { status: "none", reason: null },
      pendingAcceptance ?? { status: "none", reason: null },
    );
    if (activity.status === "active") {
      base.status = "blocked_active";
      base.reason = activity.reason;
      return plan;
    }
    if (activity.status === "unknown") {
      base.status = "blocked_unknown";
      base.reason = activity.reason;
      return plan;
    }
    base.status = "repairable";
    return plan;
  }

  /** 执行单个候选：锁内重读 binding、重核活动后修复 Git 关联、核验、更新 binding 与 Session。 */
  private async executeTask(
    plan: PlannedRepair,
    mainRoot: string,
    paths: RepairPaths,
    opId: string,
  ): Promise<Partial<RepairTaskResult>> {
    const taskId = plan.result.taskId;
    // 任务锁先 inspect 再 acquire：他人存活／未知身份按阻塞，不强行抢占。
    const lockVerdict = lockActivity(this.locks, [plan.oldRoot, mainRoot], taskId);
    if (lockVerdict.status === "active") {
      return { status: "blocked_active", reason: lockVerdict.reason, appliedActions: [] };
    }
    if (lockVerdict.status === "unknown") {
      return { status: "blocked_unknown", reason: lockVerdict.reason, appliedActions: [] };
    }
    let lock;
    try {
      lock = await this.locks.acquire({
        keys: orderKeys([
          { scope: "project", rawKey: mainRoot },
          this.taskLock(mainRoot, taskId),
          ...(resolve(plan.oldRoot) === resolve(mainRoot) ? [] : [this.taskLock(plan.oldRoot, taskId)]),
        ]),
        action: "worktree.repair",
      });
    } catch {
      return { status: "blocked_active", reason: "任务锁被占用", appliedActions: [] };
    }
    const applied: string[] = [];
    try {
      const current = await this.store.bindings.get(taskId);
      if (current === null) {
        return { status: "failed", reason: "锁内重读缺少绑定", appliedActions: applied };
      }
      // 锁内重读：binding 已被其它操作改变时按最新现场重新判定，不覆盖后来输入。
      const pendingAcceptance = await this.pendingAcceptanceActivity(mainRoot);
      const fresh = this.precheck(
        current,
        await this.store.bindings.list(),
        mainRoot,
        false,
        pendingAcceptance.get(taskId) ?? null,
      );
      if (fresh.result.status !== "repairable") {
        return {
          status: fresh.result.status,
          reason: fresh.result.reason,
          newWorktreePath: fresh.result.newWorktreePath,
          association: fresh.result.association,
          plannedActions: fresh.result.plannedActions,
          appliedActions: applied,
        };
      }
      plan = fresh;
      plan.binding = current;

      // 无 worktree 的任务只更新 repoRoot 与受影响 Session；不伪造 worktree 目标。
      if (current.worktree === undefined) {
        const sessionChanges: Array<SessionRecord> = [];
        for (const record of await this.store.sessions.list({ taskId })) {
          const cwd = mapSessionCwd(plan.oldRoot, mainRoot, null, null, record.cwd);
          const sessionFile = mapSessionFile(plan.oldRoot, mainRoot, record.sessionFile);
          if (cwd === record.cwd && sessionFile === record.sessionFile) continue;
          sessionChanges.push({ ...record, cwd, sessionFile });
        }
        await this.store.withTransaction(async () => {
          await this.store.bindings.save({ ...current, repoRoot: mainRoot });
          for (const record of sessionChanges) await this.store.sessions.save(record);
        });
        applied.push("binding");
        if (sessionChanges.length > 0) applied.push(`sessions:${sessionChanges.length}`);
        writeJournalLine(paths, "binding", "applied", {
          taskId,
          repoRoot: mainRoot,
          worktreePath: null,
        });
        writeJournalLine(paths, "sessions", "applied", { taskId, changed: sessionChanges.length });
        return { status: "repaired", reason: null, appliedActions: applied };
      }

      let needsGitRepair = plan.needsGitRepair;
      let targetPath = plan.targetWorktreePath ?? plan.result.newWorktreePath;
      if (targetPath === null) {
        return { status: "failed", reason: "无法确定 worktree 目标路径", appliedActions: applied };
      }

      if (needsGitRepair) {
        writeJournalLine(paths, "git-repair", "planned", { taskId, path: targetPath });
        const repair = gitSync(["worktree", "repair", targetPath], mainRoot);
        writeJournalLine(paths, "git-repair", repair.code === 0 ? "applied" : "failed", {
          taskId,
          path: targetPath,
          exit: repair.code,
          stdout: repair.stdout.trim().slice(0, 8192),
          stderr: repair.stderr.trim().slice(0, 8192),
        });
        if (repair.code !== 0) {
          return {
            status: "failed",
            reason: `git worktree repair 失败: ${repair.stderr.trim() || repair.stdout.trim() || "无输出"}`,
            appliedActions: applied,
          };
        }
        applied.push(`git worktree repair ${targetPath}`);
      } else {
        writeJournalLine(paths, "git-repair", "skipped", { taskId, path: targetPath, reason: "关联已可用，无需 repair" });
      }

      // 修复后重新核验：worktree 在 list 中、分支相符、基线祖先、归属当前主检出。
      const info = plan.registration;
      if (info === null || targetPath === null) {
        return { status: "failed", reason: "缺少登记信息，无法核验", appliedActions: applied };
      }
      const verdict = verifyWorktreeRegistration(mainRoot, { path: targetPath, branch: info.branch });
      const baselineOk = verdict.ok && branchAncestorOk(mainRoot, info.baseline, info.branch);
      writeJournalLine(paths, "verify", verdict.ok && baselineOk ? "applied" : "failed", {
        taskId,
        path: targetPath,
        branch: info.branch,
        baseline: info.baseline,
        problem: verdict.ok ? (baselineOk ? null : "基线不是分支祖先") : verdict.problem,
      });
      if (!verdict.ok || !baselineOk) {
        return {
          status: "failed",
          reason: verdict.ok ? `登记分支 ${info.branch} 不在基线 ${info.baseline} 或其后代` : (verdict.problem ?? "登记核验失败"),
          appliedActions: applied,
        };
      }
      applied.push("verify");

      // 本机定位与受影响 Session 同一事务更新；失败不写半份绑定。
      const oldWorktreePath = plan.oldWorktreePath;
      const newWorktreePath = info.layout === "project" ? targetPath : info.path;
      const repairedAt = this.now().toISOString();
      const nextWorktree: WorktreeInfo = {
        ...info,
        path: newWorktreePath,
        ...(info.relativePath === undefined ? {} : { relativePath: info.relativePath }),
        repairedAt,
        lastRepairOp: opId,
      };
      const next: TaskBinding = {
        ...current,
        repoRoot: mainRoot,
        worktree: nextWorktree,
      };
      const sessionChanges: Array<{ before: SessionRecord; after: SessionRecord }> = [];
      const sessions = await this.store.sessions.list({ taskId });
      for (const record of sessions) {
        const cwd = mapSessionCwd(plan.oldRoot, mainRoot, oldWorktreePath, newWorktreePath, record.cwd);
        const sessionFile = mapSessionFile(plan.oldRoot, mainRoot, record.sessionFile);
        if (cwd === record.cwd && sessionFile === record.sessionFile) continue;
        sessionChanges.push({ before: record, after: { ...record, cwd, sessionFile } });
      }
      await this.store.withTransaction(async () => {
        await this.store.bindings.save(next);
        for (const change of sessionChanges) await this.store.sessions.save(change.after);
      });
      applied.push("binding");
      if (sessionChanges.length > 0) applied.push(`sessions:${sessionChanges.length}`);
      writeJournalLine(paths, "binding", "applied", {
        taskId,
        repoRoot: mainRoot,
        worktreePath: newWorktreePath,
        repairedAt,
      });
      writeJournalLine(paths, "sessions", "applied", { taskId, changed: sessionChanges.length });
      return {
        status: "repaired",
        reason: null,
        newWorktreePath,
        association: "valid",
        appliedActions: applied,
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 已完成 run 的结果待接收：按接收操作回执判断，缺记录按未知。 */
  private async pendingAcceptanceActivity(mainRoot: string): Promise<Map<string, ActivityVerdict>> {
    const pending = new Map<string, ActivityVerdict>();
    const runs = new RunStore(mainRoot);
    for (const runId of runs.listRunIds()) {
      let request;
      let state;
      try {
        request = runs.readRequest(runId);
        state = runs.readState(runId);
      } catch {
        continue;
      }
      if (request === null || state === null || state.state !== "completed") continue;
      let result;
      try {
        result = runs.readResult(runId);
      } catch {
        result = null;
      }
      if (result === null) continue;
      let operation = null;
      let unreadable = false;
      try {
        operation = await this.store.operations.get(request.acceptanceOperationId);
      } catch {
        unreadable = true;
      }
      if (operation?.state === "completed") continue;
      pending.set(request.taskId, unreadable || operation === null
        ? { status: "unknown", reason: `run ${runId} 结果待接收但接收记录不可读` }
        : { status: "active", reason: `run ${runId} 结果待接收` });
    }
    return pending;
  }

  /**
   * 项目级 repoRoot 归一：已修复任务之外的 binding 只在没有阻塞／冲突时更新 repoRoot；
   * worktree 路径字段保持原样，不替未处理任务猜位置。
   */
  private async sweepRepoRoot(mainRoot: string, blocked: Set<string>): Promise<void> {
    await this.store.withTransaction(async () => {
      for (const binding of await this.store.bindings.list()) {
        if (blocked.has(binding.taskId)) continue;
        if (resolve(binding.repoRoot) === resolve(mainRoot)) continue;
        await this.store.bindings.save({ ...binding, repoRoot: mainRoot });
      }
    });
  }
}
