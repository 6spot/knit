/**
 * `knit worktree cleanup` 核心（WORKTREE.md §6.4、DESIGN.md §10/§16.3）。
 *
 * 在显式授权下清理已结束任务的 worktree：缺省只读预览；apply 先整体预检，再持项目锁／
 * 任务锁按固定顺序「先保全、后删除」执行：
 *   保全 worktree 内本任务资料 → 保全受影响 Session 文件 → 删除 worktree →
 *   按请求删除分支 → 清除 binding.worktree → 写回 Session → 回执／journal／operation。
 *
 * 边界：只处理单个任务的 `binding.worktree`；不批量清理、不跑 `knit gc`、不改任务
 * status／phase／outcome、不改历史 run、任务目录与归档、不修改 Git 历史。
 * 回执 `.knit/.runtime/worktree-cleanup/<opId>/receipt.json` 是恢复与审计入口；
 * 未完成回执（finishedAt=null）是中断续做的入口，已完成的删除／复制步骤跳过。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { ensurePrivateDir } from "../infrastructure/private-mode.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync, machineBootId, procStartTicks, sameProcessStart } from "../infrastructure/process.js";
import { LockManager, orderKeys, type LockKey } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { deliveryHooksOf, parseConfig, type ProjectConfig } from "./config.js";
import { hookIsolatedGit, resolveAuthorization } from "./delivery.js";
import type { AuthorizationSource } from "../contracts/delivery.js";
import { porcelainStatusPaths } from "./git-status.js";
import { GuardError } from "./guard-error.js";
import { parseTaskDocument } from "./task-document.js";
import { locateTaskDocument } from "./task-service.js";
import { type WorktreeLayout } from "./worktree-manager.js";
import { resolveProjectStart } from "./worktree-routing.js";
import { assertNotInStageContext } from "./stage-context.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskBinding } from "../contracts/metadata.js";
import type { SessionRecord } from "../contracts/session.js";

/** 回执容器（相对主检出根）；本清理的运行资料不进 worktree。 */
export const CLEANUP_DIR = join(".knit", ".runtime", "worktree-cleanup");
const RECEIPT_FILE = "receipt.json";
const JOURNAL_FILE = "journal.jsonl";
const TASK_FILE = "task.md";
const RUNTIME_DIR = join(".knit", ".runtime");
const PI_SESSIONS_DIR = join(RUNTIME_DIR, "pi-sessions");
const TERMINAL_RUN_STATES = new Set(["completed", "cancelled", "failed"]);
/** 预览状态；apply 另有 removed／partial。 */
export type CleanupStatus =
  | "removable"
  | "removed"
  | "partial"
  | "noop"
  | "blocked_task_open"
  | "blocked_active"
  | "blocked_unknown"
  | "blocked_dirty"
  | "blocked_unmerged"
  | "blocked_locked"
  | "invalid"
  | "failed";

export type CleanupStepState = "planned" | "completed" | "failed" | "skipped";

export interface CleanupStep {
  stepId: string;
  state: CleanupStepState;
  at: string;
  reason: string | null;
}

export interface PreservedEntry {
  /** 相对 preserved 根（POSIX 分隔）。 */
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number | null;
  sha256: string | null;
  linkTarget: string | null;
}

export interface PreservedTaskMaterial {
  sourceDir: string | null;
  targetDir: string | null;
  files: PreservedEntry[];
  totalBytes: number;
  digest: string | null;
}

export interface PreservedSessionFile {
  knitSessionId: string;
  source: string;
  target: string | null;
  sha256: string | null;
  /** 本次实际写入；false 表示目标已存在且摘要一致或来源缺失。 */
  copied: boolean;
  missing: boolean;
  problem: string | null;
}

export interface CleanupSessionChange {
  knitSessionId: string;
  nativeSessionId: string;
  role: string;
  taskId: string | null;
  cwdBefore: string;
  cwdAfter: string;
  sessionFileBefore: string | null;
  sessionFileAfter: string | null;
  action: "copied" | "cwd_only" | "missing" | "unchanged";
  copiedTo: string | null;
  sha256: string | null;
  applied: boolean;
}

export interface CleanupBranchResult {
  requested: boolean;
  /** 完整分支引用；未知时 null。 */
  branch: string | null;
  target: string | null;
  targetSource: "config:delivery.defaultBranch" | "origin/HEAD" | "main-checkout" | null;
  mergeCheck: "merged" | "unmerged" | "unknown" | "absent" | "not_requested";
  proof: string | null;
  discarded: boolean;
  result: "deleted" | "absent" | "skipped" | "failed" | "blocked";
  reason: string | null;
}

export interface CleanupWorktreeFacts {
  layout: WorktreeLayout;
  path: string;
  branch: string;
  relativePath: string | null;
  baseline: string;
}

export interface CleanupDirtySummary {
  entries: number;
  sample: string[];
}

export interface CleanupReceipt {
  schemaVersion: 1;
  opId: string;
  taskId: string;
  mainRoot: string;
  apply: boolean;
  startedAt: string;
  authorizationRef: string | null;
  authorization: AuthorizationSource | null;
  taskStatus: string | null;
  taskOutcome: string | null;
  worktree: CleanupWorktreeFacts | null;
  steps: CleanupStep[];
  preserved: {
    taskMaterial: PreservedTaskMaterial | null;
    sessionFiles: PreservedSessionFile[];
  };
  sessions: CleanupSessionChange[];
  branchDeletion: CleanupBranchResult | null;
  finishedAt: string | null;
}

export interface WorktreeCleanupResult {
  mainRoot: string;
  taskId: string;
  apply: boolean;
  status: CleanupStatus;
  reason: string | null;
  opId: string | null;
  receiptPath: string | null;
  journalPath: string | null;
  authorizationRef: string | null;
  taskStatus: string | null;
  taskOutcome: string | null;
  worktree: CleanupWorktreeFacts | null;
  dirty: CleanupDirtySummary | null;
  branch: CleanupBranchResult | null;
  preserved: {
    taskMaterialDir: string | null;
    taskMaterialFiles: number;
    taskMaterialBytes: number;
    sessionFiles: number;
  } | null;
  sessions: CleanupSessionChange[];
}

export interface WorktreeCleanupOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
  /** 测试注入配置读取；缺省读取 `<mainRoot>/.knit/config.json`。 */
  config?: ProjectConfig | null;
}

export interface WorktreeCleanupInput {
  dir: string;
  taskId: string;
  /** 同时删除任务 worktree 分支（默认保留）。 */
  branch?: boolean;
  /** 分支未合入仍按授权删除（仅 --branch 下有意义）。 */
  discardBranch?: boolean;
  /** 允许删除含未提交／未跟踪／忽略资料的 worktree。 */
  discardChanges?: boolean;
  apply?: boolean;
  authorizationRef?: string | null;
  caller?: "cli" | "agent";
}

interface CleanupPaths {
  dir: string;
  receipt: string;
  journal: string;
}

interface PendingReceipt {
  opId: string;
  receipt: CleanupReceipt;
  paths: CleanupPaths;
}

interface ActivityVerdict {
  status: "none" | "active" | "unknown";
  reason: string | null;
}

interface PlannedSession {
  record: SessionRecord;
  cwdAfter: string;
  sessionFileAfter: string | null;
  copy: PreservedSessionFile | null;
  action: CleanupSessionChange["action"];
}

interface CleanupPlan {
  mainRoot: string;
  taskId: string;
  status: CleanupStatus;
  reason: string | null;
  binding: TaskBinding;
  info: { path: string; branch: string; layout: WorktreeLayout; relativePath?: string } | null;
  worktreeFacts: CleanupWorktreeFacts | null;
  taskStatus: string | null;
  taskOutcome: string | null;
  taskDirInWorktree: string | null;
  worktreeExists: boolean;
  dirty: CleanupDirtySummary | null;
  branch: CleanupBranchResult | null;
  taskMaterial: PreservedTaskMaterial | null;
  sessions: PlannedSession[];
  resumed: boolean;
}

function newOpId(): string {
  return `op-${randomBytes(6).toString("hex")}`;
}

function cleanupPaths(mainRoot: string, opId: string): CleanupPaths {
  const dir = join(mainRoot, CLEANUP_DIR, opId);
  return { dir, receipt: join(dir, RECEIPT_FILE), journal: join(dir, JOURNAL_FILE) };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function insideDir(dir: string, candidate: string): boolean {
  const rel = relative(resolve(dir), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

function shortBranchName(branch: string): string | null {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : null;
}

interface DetailedWorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  lockReason: string | null;
}

/** `git worktree list --porcelain`：保留 locked 标记（普通解析器只给出路径／分支）。 */
function listWorktreesDetailed(mainRoot: string): {
  ok: boolean;
  entries: DetailedWorktreeEntry[];
  problem: string | null;
} {
  const result = gitSync(["worktree", "list", "--porcelain"], mainRoot);
  if (result.code !== 0) {
    return { ok: false, entries: [], problem: `git worktree list 失败: ${result.stderr.trim() || "无输出"}` };
  }
  const entries: DetailedWorktreeEntry[] = [];
  let current: DetailedWorktreeEntry | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        head: null,
        locked: false,
        lockReason: null,
      };
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current !== null && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
      current.lockReason = line.length > "locked".length ? line.slice("locked ".length).trim() : null;
    }
  }
  if (current !== null) entries.push(current);
  return { ok: true, entries, problem: null };
}

/** binding.relativePath 推出的任务目录（`tasks/<dir>/task.md` 或 `.knit/tasks/...` 两种历史基址）。 */
function taskDirFromBinding(worktreePath: string, relativePath: string): string | null {
  const relDir = dirname(relativePath);
  for (const candidate of [join(worktreePath, ".knit", relDir), join(worktreePath, relDir)]) {
    if (existsSync(join(candidate, TASK_FILE))) return candidate;
  }
  return null;
}

/** 任务 frontmatter 事实；任务资料可能位于 worktree、主检出或清理回执的保全副本。 */
function taskFactsAt(dir: string): { status: string; outcome: string | null } | null {
  const file = join(dir, TASK_FILE);
  try {
    const document = parseTaskDocument(readFileSync(file, "utf8"), file);
    return { status: document.frontmatter.status, outcome: document.frontmatter.outcome };
  } catch {
    return null;
  }
}

function taskFactsInRoot(root: string, taskId: string): { status: string; outcome: string | null; dir: string } | null {
  try {
    const located = locateTaskDocument(root, taskId);
    return {
      status: located.document.frontmatter.status,
      outcome: located.document.frontmatter.outcome,
      dir: located.dir,
    };
  } catch {
    return null;
  }
}

/** 递归枚举任务资料目录；符号链接按目标字符串记录，不展开。 */
function scanTaskMaterial(root: string): PreservedEntry[] {
  const entries: PreservedEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, item.name);
      const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
      if (item.isSymbolicLink()) {
        entries.push({
          path: rel,
          kind: "symlink",
          size: null,
          sha256: null,
          linkTarget: readlinkSync(full),
        });
        continue;
      }
      if (item.isDirectory()) {
        entries.push({ path: rel, kind: "directory", size: null, sha256: null, linkTarget: null });
        walk(full, rel);
        continue;
      }
      if (!item.isFile()) continue;
      const data = readFileSync(full);
      entries.push({
        path: rel,
        kind: "file",
        size: data.byteLength,
        sha256: sha256Bytes(data),
        linkTarget: null,
      });
    }
  };
  walk(root, "");
  return entries;
}

function preservedDigest(entries: PreservedEntry[]): string {
  return sha256Text(JSON.stringify(entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    sha256: entry.sha256,
    linkTarget: entry.linkTarget,
  }))));
}

function preserveTree(sourceRoot: string, targetRoot: string, entries: PreservedEntry[]): void {
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const target = join(targetRoot, entry.path);
    if (entry.kind === "directory") {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
    if (entry.kind === "symlink") {
      symlinkSync(entry.linkTarget ?? "", target);
      continue;
    }
    const source = join(sourceRoot, entry.path);
    copyFileSync(source, target);
    const mode = statSync(source).mode & 0o777;
    chmodSync(target, mode);
  }
}

function verifyPreserved(root: string, entries: PreservedEntry[]): string | null {
  let current: PreservedEntry[];
  try {
    current = scanTaskMaterial(root);
  } catch (error) {
    return `保全副本不可读: ${String(error)}`;
  }
  if (current.length !== entries.length) return "保全副本条目数不符";
  for (let index = 0; index < entries.length; index += 1) {
    const before = entries[index];
    const after = current[index];
    if (before === undefined || after === undefined) return "保全副本条目缺失";
    if (before.path !== after.path || before.kind !== after.kind) return `保全副本路径或类型不符: ${before.path}`;
    if (before.kind === "file" && (before.sha256 !== after.sha256 || before.size !== after.size)) {
      return `保全副本内容不符: ${before.path}`;
    }
    if (before.kind === "symlink" && before.linkTarget !== after.linkTarget) {
      return `保全副本链接不符: ${before.path}`;
    }
  }
  return null;
}

function fileSha256(path: string): string | null {
  try {
    return sha256Bytes(readFileSync(path));
  } catch {
    return null;
  }
}

function readConfigOf(mainRoot: string, injected: ProjectConfig | null | undefined): ProjectConfig | null {
  if (injected !== undefined) return injected;
  const path = join(mainRoot, ".knit", "config.json");
  if (!existsSync(path)) return null;
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function originHead(mainRoot: string): string | null {
  const symbolic = gitSync(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], mainRoot);
  const symbolicRef = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  if (symbolicRef !== "" && gitSync(["rev-parse", "--verify", "--quiet", symbolicRef], mainRoot).code === 0) {
    return symbolicRef;
  }
  const resolved = gitSync(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"], mainRoot);
  if (resolved.code === 0 && resolved.stdout.trim() !== "") return resolved.stdout.trim();
  return null;
}

function mainCheckoutBranch(mainRoot: string): string | null {
  const symbolic = gitSync(["symbolic-ref", "-q", "HEAD"], mainRoot);
  if (symbolic.code !== 0 || symbolic.stdout.trim() === "") return null;
  return symbolic.stdout.trim();
}

/**
 * 分支删除计划：目标依次取 config.delivery.defaultBranch → 本地 origin/HEAD → 主检出当前分支；
 * 用 merge-base --is-ancestor 证明已合入。证据与结果都写入回执，不把目标未知当成功。
 */
function planBranch(input: {
  mainRoot: string;
  info: { branch: string };
  config: ProjectConfig | null;
  requested: boolean;
  discardBranch: boolean;
}): CleanupBranchResult | null {
  const { mainRoot, info, config, requested, discardBranch } = input;
  if (!requested) return null;
  const short = shortBranchName(info.branch);
  if (short === null) {
    return {
      requested: true,
      branch: info.branch,
      target: null,
      targetSource: null,
      mergeCheck: "unknown",
      proof: null,
      discarded: false,
      result: "blocked",
      reason: `登记分支不是完整 refs/heads/...: ${info.branch}`,
    };
  }
  const branchExists = gitSync(["rev-parse", "--verify", "--quiet", info.branch], mainRoot).code === 0;
  if (!branchExists) {
    return {
      requested: true,
      branch: info.branch,
      target: null,
      targetSource: null,
      mergeCheck: "absent",
      proof: null,
      discarded: false,
      result: "absent",
      reason: "本地分支已不存在",
    };
  }
  let target: string | null = null;
  let targetSource: CleanupBranchResult["targetSource"] = null;
  const configured = config?.delivery.defaultBranch;
  if (typeof configured === "string" && configured !== "") {
    target = configured;
    targetSource = "config:delivery.defaultBranch";
  } else {
    const origin = originHead(mainRoot);
    if (origin !== null) {
      target = origin;
      targetSource = "origin/HEAD";
    } else {
      const current = mainCheckoutBranch(mainRoot);
      if (current !== null) {
        target = current;
        targetSource = "main-checkout";
      }
    }
  }
  if (target === null) {
    return {
      requested: true,
      branch: info.branch,
      target: null,
      targetSource: null,
      mergeCheck: "unknown",
      proof: null,
      discarded: discardBranch,
      result: discardBranch ? "deleted" : "blocked",
      reason: "无法确定合入目标（config／origin/HEAD／主检出分支均未知）",
    };
  }
  const ancestor = gitSync(["merge-base", "--is-ancestor", info.branch, target], mainRoot);
  const mergeCheck: CleanupBranchResult["mergeCheck"] = ancestor.code === 0 ? "merged" : ancestor.code === 1 ? "unmerged" : "unknown";
  const proof = mergeCheck === "merged"
    ? `merge-base --is-ancestor ${info.branch} ${target}（${targetSource}）`
    : null;
  if (mergeCheck !== "merged" && !discardBranch) {
    return {
      requested: true,
      branch: info.branch,
      target,
      targetSource,
      mergeCheck,
      proof,
      discarded: false,
      result: "blocked",
      reason: mergeCheck === "unmerged"
        ? `分支未合入 ${target}，默认保留；确认丢弃需 --discard-branch`
        : `无法证明分支已合入 ${target}`,
    };
  }
  return {
    requested: true,
    branch: info.branch,
    target,
    targetSource,
    mergeCheck,
    proof,
    discarded: mergeCheck !== "merged",
    result: "deleted",
    reason: mergeCheck === "merged" ? null : `明确丢弃：分支未合入 ${target}`,
  };
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
    if (state.state === "completed") {
      let result;
      try {
        result = runs.readResult(runId);
      } catch {
        result = null;
      }
      if (result === null) {
        unknown = unknown ?? `run ${runId} completed 但 result 缺失或不可读`;
      }
    }
    let stage;
    try {
      stage = runs.readStageProcess(runId);
    } catch {
      unknown = unknown ?? `run ${runId} 阶段进程不可读`;
      continue;
    }
    if (stage !== null && stage.state !== "exited" && stage.piPid === null) {
      return { status: "unknown", reason: `run ${runId} 阶段进程身份未知` };
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

function lockActivity(locks: LockManager, keys: LockKey[]): ActivityVerdict {
  let unknown: string | null = null;
  for (const key of keys) {
    const status = locks.inspect(key);
    if (!status.exists) continue;
    if (status.owner === null || status.processVerdict === "unknown") {
      unknown = unknown ?? `${key.scope} 锁 owner 不可核实: ${key.rawKey}`;
      continue;
    }
    if (status.processVerdict === "alive") {
      return { status: "active", reason: `${key.scope} 锁仍被占用: ${key.rawKey}` };
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

/** 受影响的 Session：cwd 等于或位于待删 worktree 内（不限于本任务）。 */
function affectedSessions(sessions: SessionRecord[], worktreePath: string): SessionRecord[] {
  return sessions.filter((record) => insideDir(worktreePath, record.cwd));
}

/**
 * Session 文件计划：worktree 内文件复制到主检出 pi-sessions（冲突加 Knit ID 前缀），
 * 主检出/其它位置的 sessionFile 只改 cwd；缺失文件如实标 missing，不冒充可恢复。
 */
function planSessions(input: {
  mainRoot: string;
  worktreePath: string;
  sessions: SessionRecord[];
  prior: PreservedSessionFile[];
}): PlannedSession[] {
  const { mainRoot, worktreePath, sessions, prior } = input;
  const sessionsRoot = join(mainRoot, PI_SESSIONS_DIR);
  const reserved = new Set<string>();
  const plans: PlannedSession[] = [];
  for (const record of sessions) {
    const cwdAfter = mainRoot;
    if (record.sessionFile === null) {
      plans.push({
        record,
        cwdAfter,
        sessionFileAfter: null,
        copy: null,
        action: resolve(record.cwd) === resolve(cwdAfter) ? "unchanged" : "cwd_only",
      });
      continue;
    }
    if (!insideDir(worktreePath, record.sessionFile)) {
      plans.push({
        record,
        cwdAfter,
        sessionFileAfter: record.sessionFile,
        copy: null,
        action: resolve(record.cwd) === resolve(cwdAfter) ? "unchanged" : "cwd_only",
      });
      continue;
    }

    const priorCopy = prior.find((item) => item.knitSessionId === record.knitSessionId && item.target !== null
      && item.sha256 !== null && existsSync(item.target) && fileSha256(item.target) === item.sha256);
    const sourceExists = existsSync(record.sessionFile);
    const sourceSha = sourceExists ? fileSha256(record.sessionFile) : null;
    if (!sourceExists || sourceSha === null) {
      if (priorCopy !== undefined && priorCopy.target !== null) {
        plans.push({
          record,
          cwdAfter,
          sessionFileAfter: priorCopy.target,
          copy: { ...priorCopy, missing: false, copied: false },
          action: "copied",
        });
      } else {
        plans.push({
          record,
          cwdAfter,
          sessionFileAfter: null,
          copy: {
            knitSessionId: record.knitSessionId,
            source: record.sessionFile,
            target: null,
            sha256: null,
            copied: false,
            missing: !sourceExists,
            problem: sourceExists ? "Session 文件不可读" : "Session 文件缺失，未复制",
          },
          action: sourceExists ? "cwd_only" : "missing",
        });
      }
      continue;
    }

    const target = chooseSessionTarget(sessionsRoot, record.knitSessionId, record.sessionFile, sourceSha, reserved);
    reserved.add(resolve(target));
    const already = existsSync(target) && fileSha256(target) === sourceSha;
    plans.push({
      record,
      cwdAfter,
      sessionFileAfter: target,
      copy: {
        knitSessionId: record.knitSessionId,
        source: record.sessionFile,
        target,
        sha256: sourceSha,
        copied: false,
        missing: false,
        problem: null,
      },
      action: already && resolve(record.cwd) === resolve(cwdAfter) ? "unchanged" : "copied",
    });
  }
  return plans;
}

/**
 * 目标文件名：同名不存在直接用；同名已存在且内容相同复用；否则加 `<knitSessionId>-` 前缀，
 * 再冲突时追加序号。只做只读判断，实际写入在 apply。
 */
function chooseSessionTarget(root: string, knitSessionId: string, source: string, sha256: string, reserved: Set<string>): string {
  const base = basename(source);
  const usable = (candidate: string): "free" | "same" | "taken" => {
    if (reserved.has(resolve(candidate))) {
      return existsSync(candidate) && fileSha256(candidate) === sha256 ? "same" : "taken";
    }
    if (!existsSync(candidate)) return "free";
    return fileSha256(candidate) === sha256 ? "same" : "taken";
  };
  const direct = join(root, base);
  const directState = usable(direct);
  if (directState !== "taken") return direct;
  const prefixed = join(root, `${knitSessionId}-${base}`);
  if (usable(prefixed) !== "taken") return prefixed;
  for (let index = 2; ; index += 1) {
    const candidate = join(root, `${knitSessionId}-${index}-${base}`);
    if (usable(candidate) !== "taken") return candidate;
  }
}

function isCleanupStep(step: CleanupStep | undefined, state: CleanupStepState): boolean {
  return step !== undefined && step.state === state;
}

function setStep(steps: CleanupStep[], stepId: string, state: CleanupStepState, at: string, reason: string | null = null): void {
  const existing = steps.find((step) => step.stepId === stepId);
  if (existing === undefined) {
    steps.push({ stepId, state, at, reason });
    return;
  }
  existing.state = state;
  existing.at = at;
  existing.reason = reason;
}

function writeJournalLine(paths: CleanupPaths, stepId: string, kind: string, evidence?: Record<string, unknown>): void {
  ensurePrivateDir(paths.dir);
  const line = JSON.stringify({ stepId, kind, at: new Date().toISOString(), ...(evidence ?? {}) }) + "\n";
  const journal = paths.journal;
  if (!existsSync(journal)) writeFileSync(journal, "", { mode: 0o600 });
  const existing = readFileSync(journal, "utf8");
  writeFileSync(journal, existing + line, { mode: 0o600 });
}

function saveReceipt(paths: CleanupPaths, receipt: CleanupReceipt): void {
  ensurePrivateDir(paths.dir);
  atomicWrite({
    path: paths.receipt,
    data: Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
    mode: 0o600,
  });
}

function readReceipt(cleanupRoot: string, opId: string): CleanupReceipt | null {
  const version = readWithVersion(join(cleanupRoot, opId, RECEIPT_FILE));
  if (version === null) return null;
  try {
    return JSON.parse(version.data.toString("utf8")) as CleanupReceipt;
  } catch {
    return null;
  }
}

/** 同一任务的未完成回执；用于中断续做。 */
function findPendingReceipt(mainRoot: string, taskId: string): PendingReceipt | null {
  const root = join(mainRoot, CLEANUP_DIR);
  if (!existsSync(root)) return null;
  let latest: PendingReceipt | null = null;
  for (const name of readdirSync(root).sort()) {
    if (!/^op-[0-9a-f]{12}$/.test(name)) continue;
    const receipt = readReceipt(root, name);
    if (receipt === null || receipt.finishedAt !== null) continue;
    if (receipt.taskId !== taskId) continue;
    if (resolve(receipt.mainRoot) !== resolve(mainRoot)) continue;
    if (latest !== null && (receipt.startedAt ?? "") < (latest.receipt.startedAt ?? "")) continue;
    latest = { opId: name, receipt, paths: cleanupPaths(mainRoot, name) };
  }
  return latest;
}

function emptyResult(mainRoot: string, taskId: string, apply: boolean, authorizationRef: string | null, status: CleanupStatus, reason: string | null): WorktreeCleanupResult {
  return {
    mainRoot,
    taskId,
    apply,
    status,
    reason,
    opId: null,
    receiptPath: null,
    journalPath: null,
    authorizationRef,
    taskStatus: null,
    taskOutcome: null,
    worktree: null,
    dirty: null,
    branch: null,
    preserved: null,
    sessions: [],
  };
}

function resultOf(input: {
  plan: CleanupPlan;
  apply: boolean;
  opId: string | null;
  receiptPath: string | null;
  journalPath: string | null;
  authorizationRef: string | null;
  receipt: CleanupReceipt | null;
}): WorktreeCleanupResult {
  const { plan, receipt } = input;
  const sessions = receipt?.sessions ?? plan.sessions.map((item) => ({
    knitSessionId: item.record.knitSessionId,
    nativeSessionId: item.record.ref.nativeSessionId,
    role: item.record.ref.role,
    taskId: item.record.taskId,
    cwdBefore: item.record.cwd,
    cwdAfter: item.cwdAfter,
    sessionFileBefore: item.record.sessionFile,
    sessionFileAfter: item.sessionFileAfter,
    action: item.action,
    copiedTo: item.copy?.target ?? null,
    sha256: item.copy?.sha256 ?? null,
    applied: false,
  }));
  return {
    mainRoot: plan.mainRoot,
    taskId: plan.taskId,
    apply: input.apply,
    status: plan.status,
    reason: plan.reason,
    opId: input.opId,
    receiptPath: input.receiptPath,
    journalPath: input.journalPath,
    authorizationRef: input.authorizationRef,
    taskStatus: plan.taskStatus,
    taskOutcome: plan.taskOutcome,
    worktree: plan.worktreeFacts,
    dirty: plan.dirty,
    branch: plan.branch,
    preserved: {
      taskMaterialDir: receipt?.preserved.taskMaterial?.targetDir ?? plan.taskMaterial?.targetDir ?? null,
      taskMaterialFiles: receipt?.preserved.taskMaterial?.files.filter((entry) => entry.kind === "file").length
        ?? plan.taskMaterial?.files.filter((entry) => entry.kind === "file").length
        ?? 0,
      taskMaterialBytes: receipt?.preserved.taskMaterial?.totalBytes ?? plan.taskMaterial?.totalBytes ?? 0,
      sessionFiles: receipt?.preserved.sessionFiles.length
        ?? plan.sessions.filter((item) => item.copy !== null).length,
    },
    sessions,
  };
}

export class WorktreeCleanupService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;
  private readonly config: ProjectConfig | null | undefined;

  constructor(options: WorktreeCleanupOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
    this.config = options.config;
  }

  private taskLock(mainRoot: string, taskId: string): LockKey {
    return { scope: "task", rawKey: `${mainRoot}::${taskId}` };
  }

  /** 只读预检或授权执行清理；预览不创建目录、不写 binding／Session、不运行删除。 */
  async cleanup(input: WorktreeCleanupInput): Promise<WorktreeCleanupResult> {
    assertNotInStageContext("worktree cleanup");
    if (input.apply !== true) return await this.cleanupInScope(input);
    // delivery.hooks=skip（缺省）：apply 全程（worktree remove、branch -D 与预检读取）本进程发起的 Git 调用
    // 都带 core.hooksPath=<私有空目录>，reference-transaction、post-index-change 等 hook 不执行。
    const config = readConfigOf(normalizeRoot(resolveProjectStart(input.dir).mainRoot), this.config);
    const isolation = hookIsolatedGit(config === null ? "skip" : deliveryHooksOf(config));
    try {
      return await isolation.scope(() => this.cleanupInScope(input));
    } finally {
      isolation.dispose();
    }
  }

  private async cleanupInScope(input: WorktreeCleanupInput): Promise<WorktreeCleanupResult> {
    const start = resolveProjectStart(input.dir);
    if (start.linkedWorktree) {
      throw new GuardError(
        "main_checkout_required",
        `worktree cleanup 只在主检出运行；当前 ${start.executionDir} 位于关联 worktree`,
      );
    }
    const mainRoot = normalizeRoot(start.mainRoot);
    const apply = input.apply === true;
    const branchRequested = input.branch === true;
    const discardBranch = input.discardBranch === true;
    const discardChanges = input.discardChanges === true;
    if (discardBranch && !branchRequested) {
      throw new GuardError("invalid_request", "--discard-branch 仅在 --branch 下有意义");
    }
    const authorizationRef = typeof input.authorizationRef === "string" ? input.authorizationRef.trim() : "";
    if (apply && authorizationRef === "") {
      throw new GuardError("authorization_required", "worktree cleanup --apply 需要非空 --authorization-ref");
    }
    const caller = input.caller ?? "cli";
    const authorization = apply && authorizationRef !== ""
      ? resolveAuthorization(mainRoot, authorizationRef, caller)
      : null;

    const binding = await this.store.bindings.get(input.taskId);
    if (binding === null) {
      throw new GuardError("unknown_binding", `任务缺少绑定: ${input.taskId}`);
    }
    const pending = findPendingReceipt(mainRoot, input.taskId);
    const plan = await this.buildPlan({
      mainRoot,
      taskId: input.taskId,
      binding,
      pending,
      discardChanges,
      branchRequested,
      discardBranch,
      checkLocks: true,
    });
    if (!apply) {
      return resultOf({
        plan,
        apply: false,
        opId: null,
        receiptPath: null,
        journalPath: null,
        authorizationRef: authorizationRef === "" ? null : authorizationRef,
        receipt: null,
      });
    }
    if (plan.status === "noop") {
      return resultOf({
        plan,
        apply: true,
        opId: null,
        receiptPath: null,
        journalPath: null,
        authorizationRef,
        receipt: null,
      });
    }
    if (plan.status !== "removable") {
      return resultOf({
        plan,
        apply: true,
        opId: null,
        receiptPath: null,
        journalPath: null,
        authorizationRef,
        receipt: null,
      });
    }

    // 整体预检通过后才建立操作目录；先落 planned journal 与未完成回执。
    const opId = pending?.opId ?? newOpId();
    const paths = cleanupPaths(mainRoot, opId);
    const receipt = pending?.receipt ?? {
      schemaVersion: 1 as const,
      opId,
      taskId: input.taskId,
      mainRoot,
      apply: true,
      startedAt: this.now().toISOString(),
      authorizationRef,
      authorization,
      taskStatus: plan.taskStatus,
      taskOutcome: plan.taskOutcome,
      worktree: plan.worktreeFacts,
      steps: [],
      preserved: { taskMaterial: null, sessionFiles: [] },
      sessions: [],
      branchDeletion: null,
      finishedAt: null,
    };
    receipt.authorizationRef = authorizationRef;
    receipt.authorization = authorization;
    receipt.taskStatus = plan.taskStatus;
    receipt.taskOutcome = plan.taskOutcome;
    receipt.worktree = plan.worktreeFacts;
    for (const stepId of ["task-material", "session-files", "worktree", ...(branchRequested ? ["branch"] : []), "binding", "sessions"]) {
      if (!receipt.steps.some((step) => step.stepId === stepId)) {
        receipt.steps.push({ stepId, state: "planned", at: this.now().toISOString(), reason: null });
      }
    }
    saveReceipt(paths, receipt);
    writeJournalLine(paths, "plan", "planned", {
      opId,
      taskId: input.taskId,
      status: plan.status,
      worktree: plan.worktreeFacts,
      branchDeletion: branchRequested,
      discardChanges,
      authorizationRef,
      authorizationKind: authorization?.kind ?? null,
    });

    let lock;
    try {
      lock = await this.locks.acquire({
        keys: orderKeys([{ scope: "project", rawKey: mainRoot }, this.taskLock(mainRoot, input.taskId)]),
        action: "worktree.cleanup",
      });
    } catch {
      const blocked = { ...plan, status: "blocked_active" as const, reason: "项目锁或任务锁被占用" };
      writeJournalLine(paths, "lock", "failed", { reason: blocked.reason });
      await this.writeOperation(opId, "needs_attention", blocked.reason);
      return resultOf({
        plan: blocked,
        apply: true,
        opId,
        receiptPath: paths.receipt,
        journalPath: paths.journal,
        authorizationRef,
        receipt,
      });
    }

    try {
      const currentBinding = await this.store.bindings.get(input.taskId);
      if (currentBinding === null) {
        const failed = { ...plan, status: "failed" as const, reason: "锁内重读缺少绑定" };
        writeJournalLine(paths, "precheck", "failed", { reason: failed.reason });
        await this.writeOperation(opId, "needs_attention", failed.reason);
        return resultOf({
          plan: failed,
          apply: true,
          opId,
          receiptPath: paths.receipt,
          journalPath: paths.journal,
          authorizationRef,
          receipt,
        });
      }
      const fresh = await this.buildPlan({
        mainRoot,
        taskId: input.taskId,
        binding: currentBinding,
        pending: { opId, receipt, paths },
        discardChanges,
        branchRequested,
        discardBranch,
        checkLocks: false,
      });
      // 锁内事实已变化：不删除，按最新阻断状态记录（回执保持未完成，供恢复）。
      if (fresh.status !== "removable") {
        writeJournalLine(paths, "precheck", "failed", { status: fresh.status, reason: fresh.reason });
        receipt.taskStatus = fresh.taskStatus;
        receipt.taskOutcome = fresh.taskOutcome;
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", fresh.reason);
        return resultOf({
          plan: fresh,
          apply: true,
          opId,
          receiptPath: paths.receipt,
          journalPath: paths.journal,
          authorizationRef,
          receipt,
        });
      }
      return await this.execute({
        plan: fresh,
        mainRoot,
        opId,
        paths,
        receipt,
        authorizationRef,
        branchRequested,
        discardChanges,
      });
    } finally {
      this.locks.release(lock);
    }
  }

  /** 锁内执行：先保全、后删除；每步落回执与 journal，失败保留现场。 */
  private async execute(input: {
    plan: CleanupPlan;
    mainRoot: string;
    opId: string;
    paths: CleanupPaths;
    receipt: CleanupReceipt;
    authorizationRef: string;
    branchRequested: boolean;
    discardChanges: boolean;
  }): Promise<WorktreeCleanupResult> {
    const { plan, mainRoot, opId, paths, receipt, authorizationRef, branchRequested } = input;
    const finish = (status: CleanupStatus, reason: string | null): WorktreeCleanupResult => {
      plan.status = status;
      plan.reason = reason;
      return resultOf({
        plan,
        apply: true,
        opId,
        receiptPath: paths.receipt,
        journalPath: paths.journal,
        authorizationRef,
        receipt,
      });
    };

    // 1. 保全任务资料（worktree 内本任务资料目录）。
    const taskStep = receipt.steps.find((step) => step.stepId === "task-material");
    const priorMaterial = receipt.preserved.taskMaterial;
    const priorMaterialOk = priorMaterial?.targetDir !== null && priorMaterial?.targetDir !== undefined
      && existsSync(priorMaterial.targetDir)
      && verifyPreserved(priorMaterial.targetDir, priorMaterial.files) === null;
    if (!plan.worktreeExists) {
      if (priorMaterialOk) {
        setStep(receipt.steps, "task-material", "completed", this.now().toISOString(), "worktree 已删除，沿用已保全副本");
        writeJournalLine(paths, "preserve", "skipped", { target: priorMaterial?.targetDir ?? null, reason: "worktree 已删除" });
      } else {
        setStep(receipt.steps, "task-material", "skipped", this.now().toISOString(), "worktree 已删除且无保全记录");
        writeJournalLine(paths, "preserve", "skipped", { reason: "worktree 已删除且无保全记录" });
      }
    } else if (plan.taskMaterial === null) {
      setStep(receipt.steps, "task-material", "skipped", this.now().toISOString(), "worktree 内无本任务资料目录");
      writeJournalLine(paths, "preserve", "skipped", { reason: "worktree 内无本任务资料目录" });
    } else if (priorMaterialOk && isCleanupStep(taskStep, "completed")) {
      setStep(receipt.steps, "task-material", "completed", this.now().toISOString(), "沿用已核对保全副本");
      writeJournalLine(paths, "preserve", "skipped", { target: priorMaterial?.targetDir ?? null });
    } else {
      const targetDir = join(paths.dir, "preserved", "task-material");
      writeJournalLine(paths, "preserve", "planned", { source: plan.taskMaterial.sourceDir, target: targetDir });
      try {
        ensurePrivateDir(paths.dir);
        if (existsSync(targetDir) && !priorMaterialOk) rmSync(targetDir, { recursive: true, force: true });
        preserveTree(plan.taskMaterial.sourceDir ?? "", targetDir, plan.taskMaterial.files);
        const problem = verifyPreserved(targetDir, plan.taskMaterial.files);
        if (problem !== null) {
          setStep(receipt.steps, "task-material", "failed", this.now().toISOString(), problem);
          writeJournalLine(paths, "preserve", "failed", { target: targetDir, reason: problem });
          saveReceipt(paths, receipt);
          await this.writeOperation(opId, "needs_attention", problem);
          return finish("failed", problem);
        }
        receipt.preserved.taskMaterial = {
          sourceDir: plan.taskMaterial.sourceDir,
          targetDir,
          files: plan.taskMaterial.files,
          totalBytes: plan.taskMaterial.totalBytes,
          digest: plan.taskMaterial.digest,
        };
        setStep(receipt.steps, "task-material", "completed", this.now().toISOString());
        writeJournalLine(paths, "preserve", "applied", {
          target: targetDir,
          files: plan.taskMaterial.files.length,
          bytes: plan.taskMaterial.totalBytes,
          digest: plan.taskMaterial.digest,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setStep(receipt.steps, "task-material", "failed", this.now().toISOString(), reason);
        writeJournalLine(paths, "preserve", "failed", { reason });
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("failed", `任务资料保全失败: ${reason}`);
      }
      saveReceipt(paths, receipt);
    }

    // 2. 保全 Session 文件（不修改记录；只复制到主检出 pi-sessions）。
    const sessionCopies: PreservedSessionFile[] = [];
    for (const planned of plan.sessions) {
      if (planned.copy === null) continue;
      const copy = { ...planned.copy };
      if (copy.missing) {
        sessionCopies.push(copy);
        continue;
      }
      if (copy.problem !== null) {
        setStep(receipt.steps, "session-files", "failed", this.now().toISOString(), copy.problem);
        writeJournalLine(paths, "preserve-sessions", "failed", { source: copy.source, reason: copy.problem });
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", copy.problem);
        return finish("failed", `Session 文件保全失败: ${copy.problem}`);
      }
      const target = copy.target;
      if (target === null) {
        sessionCopies.push(copy);
        continue;
      }
      if (existsSync(target) && fileSha256(target) === copy.sha256) {
        sessionCopies.push(copy);
        continue;
      }
      try {
        ensurePrivateDir(join(mainRoot, PI_SESSIONS_DIR));
        mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
        copyFileSync(copy.source, target);
        chmodSync(target, 0o600);
        const problem = fileSha256(target) === copy.sha256 ? null : "复制后摘要不符";
        if (problem !== null) {
          setStep(receipt.steps, "session-files", "failed", this.now().toISOString(), problem);
          writeJournalLine(paths, "preserve-sessions", "failed", { source: copy.source, target, reason: problem });
          saveReceipt(paths, receipt);
          await this.writeOperation(opId, "needs_attention", problem);
          return finish("failed", `Session 文件保全失败: ${problem}`);
        }
        copy.copied = true;
        sessionCopies.push(copy);
        writeJournalLine(paths, "preserve-sessions", "applied", {
          knitSessionId: copy.knitSessionId,
          source: copy.source,
          target,
          sha256: copy.sha256,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setStep(receipt.steps, "session-files", "failed", this.now().toISOString(), reason);
        writeJournalLine(paths, "preserve-sessions", "failed", { source: copy.source, target, reason });
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("failed", `Session 文件保全失败: ${reason}`);
      }
    }
    if (plan.sessions.length === 0) {
      setStep(receipt.steps, "session-files", "skipped", this.now().toISOString(), "无受影响 Session");
      writeJournalLine(paths, "preserve-sessions", "skipped", { reason: "无受影响 Session" });
    } else {
      setStep(receipt.steps, "session-files", "completed", this.now().toISOString());
      writeJournalLine(paths, "preserve-sessions", "completed", { files: sessionCopies.length });
    }
    receipt.preserved.sessionFiles = sessionCopies;
    saveReceipt(paths, receipt);

    // 3. 删除 worktree。
    if (!plan.worktreeExists) {
      setStep(receipt.steps, "worktree", "completed", this.now().toISOString(), "目录已不存在");
      writeJournalLine(paths, "remove", "skipped", { path: plan.info?.path ?? null, reason: "目录已不存在" });
    } else {
      const path = plan.info?.path ?? "";
      writeJournalLine(paths, "remove", "planned", { path, force: input.discardChanges });
      const args = input.discardChanges
        ? ["worktree", "remove", "--force", path]
        : ["worktree", "remove", path];
      const removed = gitSync(args, mainRoot);
      if (removed.code !== 0 || existsSync(path)) {
        const reason = removed.stderr.trim() || removed.stdout.trim() || "git worktree remove 未完成";
        setStep(receipt.steps, "worktree", "failed", this.now().toISOString(), reason);
        writeJournalLine(paths, "remove", "failed", { path, exit: removed.code, reason });
        receipt.finishedAt = null;
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("failed", `worktree 删除失败: ${reason}`);
      }
      setStep(receipt.steps, "worktree", "completed", this.now().toISOString());
      writeJournalLine(paths, "remove", "applied", { path, exit: removed.code });
    }
    saveReceipt(paths, receipt);

    // 4. 删除分支（仅 --branch；预检已证明合入或已授权丢弃）。
    const branch = plan.branch;
    if (!branchRequested || branch === null) {
      setStep(receipt.steps, "branch", "skipped", this.now().toISOString(), "未请求删除分支");
      writeJournalLine(paths, "branch", "skipped", { reason: "未请求删除分支" });
      receipt.branchDeletion = null;
    } else if (branch.result === "absent") {
      setStep(receipt.steps, "branch", "completed", this.now().toISOString(), "分支已不存在");
      writeJournalLine(paths, "branch", "skipped", { branch: branch.branch, reason: "分支已不存在" });
      // 上次已删除但回执未收束时保留删除证明，不把既有删除降级为「无分支」。
      receipt.branchDeletion = receipt.branchDeletion?.result === "deleted"
        ? receipt.branchDeletion
        : { ...branch, result: "absent" };
    } else {
      const short = branch.branch === null ? null : shortBranchName(branch.branch);
      if (short === null) {
        const reason = `登记分支不是完整 refs/heads/...: ${branch.branch ?? "（无）"}`;
        setStep(receipt.steps, "branch", "failed", this.now().toISOString(), reason);
        writeJournalLine(paths, "branch", "failed", { reason });
        receipt.branchDeletion = { ...branch, result: "failed", reason };
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("partial", reason);
      }
      writeJournalLine(paths, "branch", "planned", { branch: branch.branch, short, discarded: branch.discarded });
      const deleted = gitSync(["branch", "-D", short], mainRoot);
      const gone = branch.branch === null
        ? false
        : gitSync(["rev-parse", "--verify", "--quiet", branch.branch], mainRoot).code !== 0;
      if (deleted.code !== 0 || !gone) {
        const reason = deleted.stderr.trim() || deleted.stdout.trim() || "git branch -D 未完成";
        setStep(receipt.steps, "branch", "failed", this.now().toISOString(), reason);
        writeJournalLine(paths, "branch", "failed", { branch: branch.branch, exit: deleted.code, reason });
        receipt.branchDeletion = { ...branch, result: "failed", reason };
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("partial", `分支删除失败: ${reason}`);
      }
      setStep(receipt.steps, "branch", "completed", this.now().toISOString());
      writeJournalLine(paths, "branch", "applied", { branch: branch.branch, exit: deleted.code, discarded: branch.discarded });
      receipt.branchDeletion = { ...branch, result: "deleted" };
    }
    saveReceipt(paths, receipt);

    // 5. 清除 binding.worktree（保留 repoRoot／branch 等主字段）。
    const current = await this.store.bindings.get(plan.taskId);
    if (current === null) {
      setStep(receipt.steps, "binding", "failed", this.now().toISOString(), "锁内缺少绑定");
      writeJournalLine(paths, "binding", "failed", { reason: "锁内缺少绑定" });
      saveReceipt(paths, receipt);
      await this.writeOperation(opId, "needs_attention", "锁内缺少绑定");
      return finish("partial", "锁内缺少绑定，binding 未清除");
    }
    if (current.worktree === undefined) {
      setStep(receipt.steps, "binding", "completed", this.now().toISOString(), "binding 已无 worktree");
      writeJournalLine(paths, "binding", "skipped", { reason: "binding 已无 worktree" });
    } else {
      try {
        const next = { ...current };
        delete next.worktree;
        await this.store.bindings.save(next);
        setStep(receipt.steps, "binding", "completed", this.now().toISOString());
        writeJournalLine(paths, "binding", "applied", { taskId: plan.taskId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setStep(receipt.steps, "binding", "failed", this.now().toISOString(), reason);
        writeJournalLine(paths, "binding", "failed", { reason });
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("partial", `binding 清除失败: ${reason}`);
      }
    }
    saveReceipt(paths, receipt);

    // 6. 写回 Session 变更（cwd 全部指向主检出；文件复制后改指）。
    const changesById = new Map(receipt.sessions.map((change) => [change.knitSessionId, change]));
    try {
      for (const planned of plan.sessions) {
        const latest = await this.store.sessions.getByKnitId(planned.record.knitSessionId) ?? planned.record;
        const missing = planned.action === "missing";
        const next: SessionRecord = {
          ...latest,
          cwd: planned.cwdAfter,
          sessionFile: planned.sessionFileAfter,
          ...(missing
            ? { status: "missing" as const, nativeReadable: false, reason: "worktree 清理时 Session 文件缺失，无法恢复" }
            : {}),
        };
        const changed = next.cwd !== latest.cwd
          || next.sessionFile !== latest.sessionFile
          || next.status !== latest.status
          || next.nativeReadable !== latest.nativeReadable
          || next.reason !== latest.reason;
        if (changed) await this.store.sessions.save(next);
        changesById.set(planned.record.knitSessionId, {
          knitSessionId: planned.record.knitSessionId,
          nativeSessionId: planned.record.ref.nativeSessionId,
          role: planned.record.ref.role,
          taskId: planned.record.taskId,
          cwdBefore: latest.cwd,
          cwdAfter: planned.cwdAfter,
          sessionFileBefore: latest.sessionFile,
          sessionFileAfter: planned.sessionFileAfter,
          action: planned.action,
          copiedTo: planned.copy?.target ?? null,
          sha256: planned.copy?.sha256 ?? null,
          applied: changed,
        });
      }
      const changes = [...changesById.values()];
      setStep(
        receipt.steps,
        "sessions",
        plan.sessions.length === 0 ? "skipped" : "completed",
        this.now().toISOString(),
        plan.sessions.length === 0 ? "无受影响 Session" : null,
      );
      writeJournalLine(paths, "sessions", "applied", { changed: changes.filter((change) => change.applied).length });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStep(receipt.steps, "sessions", "failed", this.now().toISOString(), reason);
      writeJournalLine(paths, "sessions", "failed", { reason });
      receipt.sessions = [...changesById.values()];
      saveReceipt(paths, receipt);
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", `Session 变更写回失败: ${reason}`);
    }
    receipt.sessions = [...changesById.values()];
    saveReceipt(paths, receipt);

    // 7. 收束回执与 operation。
    const finishedAt = this.now().toISOString();
    try {
      await this.writeOperation(opId, "completed", null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      writeJournalLine(paths, "operation", "failed", { reason });
      saveReceipt(paths, receipt);
      return finish("partial", `operation 记录写入失败: ${reason}`);
    }
    receipt.finishedAt = finishedAt;
    saveReceipt(paths, receipt);
    writeJournalLine(paths, "finish", "completed", { finishedAt });
    return finish("removed", null);
  }

  private async writeOperation(opId: string, state: "completed" | "needs_attention", reason: string | null): Promise<void> {
    await this.store.operations.save({
      operationId: opId,
      kind: "worktree.cleanup",
      state,
      reason,
      recordedAt: this.now().toISOString(),
    });
  }

  /** 只读预检：候选、任务结束、现场一致、活动／未知执行、内容、分支与保全可行性。 */
  private async buildPlan(input: {
    mainRoot: string;
    taskId: string;
    binding: TaskBinding;
    pending: PendingReceipt | null;
    discardChanges: boolean;
    branchRequested: boolean;
    discardBranch: boolean;
    checkLocks: boolean;
  }): Promise<CleanupPlan> {
    const { mainRoot, taskId, binding, pending, discardChanges, branchRequested, discardBranch, checkLocks } = input;
    const info = binding.worktree ?? pending?.receipt.worktree ?? null;
    const config = readConfigOf(mainRoot, this.config);
    const base: CleanupPlan = {
      mainRoot,
      taskId,
      status: "removable",
      reason: null,
      binding,
      info: info === null ? null : {
        path: info.path,
        branch: info.branch,
        layout: info.layout,
        ...(info.relativePath === null || info.relativePath === undefined ? {} : { relativePath: info.relativePath }),
      },
      worktreeFacts: info === null ? null : {
        layout: info.layout,
        path: info.path,
        branch: info.branch,
        relativePath: info.relativePath ?? null,
        baseline: info.baseline,
      },
      taskStatus: null,
      taskOutcome: null,
      taskDirInWorktree: null,
      worktreeExists: false,
      dirty: null,
      branch: null,
      taskMaterial: null,
      sessions: [],
      resumed: pending !== null,
    };
    if (info === null) {
      base.status = "noop";
      base.reason = "任务没有 worktree";
      return base;
    }
    const worktreePath = info.path;
    const exists = existsSync(worktreePath) && isDirectory(worktreePath);
    base.worktreeExists = exists;

    // 任务结束事实：worktree 内优先，其次主检出，最后取回执保全副本。
    const factsInWorktree = exists ? taskFactsInRoot(worktreePath, taskId) : null;
    const factsInMain = taskFactsInRoot(mainRoot, taskId);
    const materialDir = pending?.receipt.preserved.taskMaterial?.targetDir ?? null;
    const factsInPreserved = materialDir !== null ? taskFactsAt(materialDir) : null;
    // worktree 已删除的中断续做：回执保全副本是删除前权威资料的快照，优先于可能过期的主检出副本。
    const taskFacts = factsInWorktree
      ?? (pending !== null ? (factsInPreserved ?? factsInMain) : (factsInMain ?? factsInPreserved));
    base.taskStatus = taskFacts?.status ?? pending?.receipt.taskStatus ?? null;
    base.taskOutcome = taskFacts?.outcome ?? pending?.receipt.taskOutcome ?? null;
    base.taskDirInWorktree = factsInWorktree?.dir
      ?? (exists ? taskDirFromBinding(worktreePath, binding.relativePath) : null);
    if (base.taskStatus === null) {
      base.status = "invalid";
      base.reason = "任务资料缺失或不可解析，无法核实任务已结束";
      return base;
    }
    if (base.taskStatus !== "closed") {
      base.status = "blocked_task_open";
      base.reason = `任务尚未结束（status=${base.taskStatus}）；先关闭任务再清理`;
      return base;
    }

    // 现场一致：目录存在、porcelain 登记、分支相符、归属当前主检出。
    const detailed = listWorktreesDetailed(mainRoot);
    if (exists) {
      if (!detailed.ok) {
        base.status = "invalid";
        base.reason = detailed.problem;
        return base;
      }
      const entry = detailed.entries.find((candidate) => resolve(candidate.path) === resolve(worktreePath));
      if (entry === undefined) {
        base.status = "invalid";
        base.reason = `登记路径未在 git worktree list 中: ${worktreePath}`;
        return base;
      }
      if (entry.branch !== info.branch) {
        base.status = "invalid";
        base.reason = `登记分支不符: 期望 ${info.branch}，实际 ${entry.branch ?? "（detached）"}`;
        return base;
      }
      const start = resolveProjectStart(worktreePath);
      if (!start.linkedWorktree || resolve(start.mainRoot) !== resolve(mainRoot)) {
        base.status = "invalid";
        base.reason = `worktree 归属不符: ${worktreePath} 不属于 ${mainRoot}`;
        return base;
      }
    } else if (pending === null) {
      base.status = "invalid";
      base.reason = `登记路径缺失: ${worktreePath}`;
      return base;
    }

    // 活动／未知执行与锁；未知不冒充死亡。
    const pendingAcceptance = await this.pendingAcceptanceActivity(mainRoot, taskId);
    const lockKeys: LockKey[] = [this.taskLock(mainRoot, taskId)];
    if (resolve(binding.repoRoot) !== resolve(mainRoot)) lockKeys.push(this.taskLock(binding.repoRoot, taskId));
    if (checkLocks) lockKeys.push({ scope: "project", rawKey: mainRoot });
    const activity = combineActivity(
      runActivity(mainRoot, taskId),
      pendingAcceptance,
      checkLocks ? lockActivity(this.locks, lockKeys) : { status: "none", reason: null },
    );
    if (activity.status === "active") {
      base.status = "blocked_active";
      base.reason = activity.reason;
      return base;
    }
    if (activity.status === "unknown") {
      base.status = "blocked_unknown";
      base.reason = activity.reason;
      return base;
    }

    // locked 不可由任何开关越过。
    if (exists) {
      const entry = detailed.entries.find((candidate) => resolve(candidate.path) === resolve(worktreePath));
      if (entry?.locked === true) {
        base.status = "blocked_locked";
        base.reason = `worktree 被 Git 标记 locked${entry.lockReason === null ? "" : `（${entry.lockReason}）`}；先人工解除`;
        return base;
      }
    }

    // 工作区内容：tracked／untracked／ignored 非空默认阻断；--discard-changes 才继续。
    if (exists) {
      const status = gitSync(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"], worktreePath);
      if (status.code !== 0) {
        base.status = "invalid";
        base.reason = `git status 失败: ${status.stderr.trim() || "无输出"}`;
        return base;
      }
      const paths = porcelainStatusPaths(status.stdout);
      if (paths.length > 0) {
        base.dirty = { entries: paths.length, sample: paths.slice(0, 8) };
        if (!discardChanges) {
          base.status = "blocked_dirty";
          base.reason = `worktree 含 ${paths.length} 项未提交／未跟踪／忽略内容；确认丢弃需 --discard-changes`;
          return base;
        }
      }
    }

    // 分支删除计划（仅 --branch）。
    base.branch = planBranch({ mainRoot, info, config, requested: branchRequested, discardBranch });
    if (base.branch !== null && base.branch.result === "blocked") {
      base.status = "blocked_unmerged";
      base.reason = base.branch.reason;
      return base;
    }

    // 保全可行性：任务资料与处于 worktree 的 Session 文件必须可读。
    if (exists) {
      if (base.taskDirInWorktree !== null) {
        try {
          const entries = scanTaskMaterial(base.taskDirInWorktree);
          base.taskMaterial = {
            sourceDir: base.taskDirInWorktree,
            targetDir: null,
            files: entries,
            totalBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
            digest: preservedDigest(entries),
          };
        } catch (error) {
          base.status = "blocked_unknown";
          base.reason = `任务资料不可读: ${error instanceof Error ? error.message : String(error)}`;
          return base;
        }
      }
      const sessions = await this.store.sessions.list();
      const affected = affectedSessions(sessions, worktreePath);
      const planned = planSessions({
        mainRoot,
        worktreePath,
        sessions: affected,
        prior: pending?.receipt.preserved.sessionFiles ?? [],
      });
      const unreadable = planned.find((item) => item.copy !== null && !item.copy.missing
        && item.copy.problem !== null);
      if (unreadable !== undefined) {
        base.status = "blocked_unknown";
        base.reason = `Session 文件不可读: ${unreadable.record.sessionFile ?? "（无）"}`;
        return base;
      }
      base.sessions = planned;
    } else {
      // 目录已删除（中断续做）：以回执事实与现存副本为准，不重删、不误报 invalid。
      base.taskMaterial = pending?.receipt.preserved.taskMaterial ?? null;
      const sessions = await this.store.sessions.list();
      base.sessions = planSessions({
        mainRoot,
        worktreePath,
        sessions: affectedSessions(sessions, worktreePath),
        prior: pending?.receipt.preserved.sessionFiles ?? [],
      });
    }
    base.status = "removable";
    base.reason = pending === null ? null : "按未完成回执续做";
    return base;
  }

  /** 已完成 run 的结果待接收：按接收操作回执判断，缺记录按未知。 */
  private async pendingAcceptanceActivity(mainRoot: string, taskId: string): Promise<ActivityVerdict> {
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
      if (request.taskId !== taskId) continue;
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
      return unreadable
        ? { status: "unknown", reason: `run ${runId} 结果待接收但接收记录不可读` }
        : { status: "active", reason: `run ${runId} 结果待接收` };
    }
    return { status: "none", reason: null };
  }
}

export { emptyResult as cleanupNoopResult };
