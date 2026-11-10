/**
 * `knit worktree merge` 核心（WORKTREE.md §6.4／§6.8、DESIGN.md §10.1／§10.3／§16.3）。
 *
 * 把已结束任务 worktree 分支的成果显式授权合入主检出目标分支，并把任务资料与绑定
 * 转交到主检出，使既有 `knit deliver --branch <target>` 可以接续提交与归档。
 *
 * 边界：只在主检出运行；`--into` 与 `--authorization-ref` 缺一不可；不按默认分支猜、
 * 不自动切换／检出分支、不自动解决冲突、不 push／PR／发布、不改写历史、不清理 worktree。
 * 预览只读；apply 先整体预检，再持项目锁与任务锁重跑预检，锁内现场变化不合并。
 * 合入失败的源 worktree／分支与资料原样保留；已成功的合入不回滚，按回执续做剩余步骤。
 * 回执 `.knit/.runtime/worktree-merge/<opId>/receipt.json` 是恢复与审计入口。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { ensurePrivateDir } from "../infrastructure/private-mode.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync, machineBootId, procStartTicks, sameProcessStart } from "../infrastructure/process.js";
import { LockManager, orderKeys, type LockKey } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { hookIsolatedGit, resolveAuthorization } from "./delivery.js";
import { assertNotInStageContext } from "./stage-context.js";
import { defaultConfig, deliveryHooksOf, parseConfig } from "./config.js";
import {
  branchExists,
  commitExists,
  commitMessage,
  currentBranch,
  isAncestor,
  isFullBranch,
  isStageCommit,
} from "./delivery.js";
import type { AuthorizationSource } from "../contracts/delivery.js";
import { porcelainStatusPaths } from "./git-status.js";
import { GuardError } from "./guard-error.js";
import { parseTaskDocument } from "./task-document.js";
import { locateTaskDocument } from "./task-service.js";
import type { WorktreeLayout } from "./worktree-manager.js";
import { resolveProjectStart } from "./worktree-routing.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskBinding } from "../contracts/metadata.js";

/** 回执容器（相对主检出根）；本操作的运行资料不进 worktree。 */
export const MERGE_DIR = join(".knit", ".runtime", "worktree-merge");
const RECEIPT_FILE = "receipt.json";
const JOURNAL_FILE = "journal.jsonl";
const TASK_FILE = "task.md";
const TERMINAL_RUN_STATES = new Set(["completed", "cancelled", "failed"]);

/** 预览状态；apply 另有 merged、partial。 */
export type MergeStatus =
  | "mergeable"
  | "merged"
  | "partial"
  | "noop"
  | "blocked_task_open"
  | "blocked_active"
  | "blocked_unknown"
  | "blocked_dirty"
  | "blocked_target"
  | "blocked_locked"
  | "invalid"
  | "conflict"
  | "failed";

export type MergeStepState = "planned" | "completed" | "failed" | "skipped";

export interface MergeStep {
  stepId: string;
  state: MergeStepState;
  at: string;
  reason: string | null;
}

export interface MergeMaterialEntry {
  /** 相对任务目录的 POSIX 路径。 */
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number | null;
  sha256: string | null;
  linkTarget: string | null;
}

export interface MergeMaterial {
  sourceDir: string | null;
  targetDir: string | null;
  /** copied=本次复制；kept=目标已存在且摘要一致；conflict=内容不同保留两边；absent=无资料。 */
  disposition: "copied" | "kept" | "conflict" | "absent" | null;
  entries: MergeMaterialEntry[];
  totalBytes: number;
  digest: string | null;
}

export interface MergeSourceFacts {
  layout: WorktreeLayout;
  path: string;
  branch: string;
  baseline: string;
  relativePath: string | null;
  /** 源 worktree 内本任务资料目录的绝对路径。 */
  taskDir: string | null;
}

export interface MergeTargetFacts {
  ref: string;
  branch: string;
  currentBranch: string | null;
  beforeHead: string | null;
}

export interface MergeCommitFacts {
  kind: "merge" | "noop" | "recovered";
  beforeHead: string | null;
  afterHead: string | null;
  commit: string | null;
  message: string | null;
  failure: string | null;
  /** 合并失败后是否恢复到原 HEAD 与干净 index。 */
  restored: boolean | null;
}

export interface MergeDocumentFacts {
  path: string | null;
  branchBefore: string | null;
  branchAfter: string | null;
  changed: boolean;
}

export interface MergeBindingFacts {
  branchBefore: string | null;
  branchAfter: string | null;
  activeBefore: boolean;
  activeAfter: boolean;
  mergedAt: string | null;
  lastMergeOp: string | null;
}

export interface MergeDirtySummary {
  entries: number;
  sample: string[];
}

export interface MergeReceipt {
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
  source: MergeSourceFacts | null;
  target: MergeTargetFacts | null;
  merge: MergeCommitFacts | null;
  material: MergeMaterial | null;
  document: MergeDocumentFacts | null;
  binding: MergeBindingFacts | null;
  steps: MergeStep[];
  finishedAt: string | null;
}

export interface WorktreeMergeResult {
  mainRoot: string;
  taskId: string;
  apply: boolean;
  status: MergeStatus;
  reason: string | null;
  opId: string | null;
  receiptPath: string | null;
  journalPath: string | null;
  authorizationRef: string | null;
  authorization: AuthorizationSource | null;
  taskStatus: string | null;
  taskOutcome: string | null;
  source: MergeSourceFacts | null;
  target: MergeTargetFacts | null;
  /** 合入前 HEAD；预览为当前 HEAD。 */
  beforeHead: string | null;
  afterHead: string | null;
  mergeCommit: string | null;
  mergeKind: "merge" | "noop" | "recovered" | null;
  /** 是否还需要产生合入提交（源不是目标祖先）。 */
  mergeRequired: boolean;
  material: MergeMaterial | null;
  document: MergeDocumentFacts | null;
  binding: MergeBindingFacts | null;
  dirty: MergeDirtySummary | null;
  resumed: boolean;
}

export interface WorktreeMergeOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
}

export interface WorktreeMergeInput {
  dir: string;
  taskId: string;
  /** 完整本地目标 refs/heads/...；必须是主检出当前分支。 */
  into: string;
  apply?: boolean;
  authorizationRef?: string | null;
  caller?: "cli" | "agent";
}

interface MergePaths {
  dir: string;
  receipt: string;
  journal: string;
}

interface PendingReceipt {
  opId: string;
  receipt: MergeReceipt;
  paths: MergePaths;
}

interface ActivityVerdict {
  status: "none" | "active" | "unknown";
  reason: string | null;
}

interface MergePlan {
  mainRoot: string;
  taskId: string;
  status: MergeStatus;
  reason: string | null;
  binding: TaskBinding;
  source: MergeSourceFacts | null;
  target: MergeTargetFacts | null;
  taskStatus: string | null;
  taskOutcome: string | null;
  beforeHead: string | null;
  mergeRequired: boolean;
  material: MergeMaterial | null;
  dirty: MergeDirtySummary | null;
  resumed: boolean;
}

interface DetailedWorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  lockReason: string | null;
}

function newOpId(): string {
  return `op-${randomBytes(6).toString("hex")}`;
}

function mergePaths(mainRoot: string, opId: string): MergePaths {
  const dir = join(mainRoot, MERGE_DIR, opId);
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

interface LocatedTask {
  dir: string;
  archived: boolean;
  status: string;
  stage: string;
  outcome: string | null;
  branch: string | null;
}

function locateTask(root: string, taskId: string): LocatedTask | null {
  try {
    const located = locateTaskDocument(root, taskId);
    return {
      dir: located.dir,
      archived: located.archived,
      status: located.document.frontmatter.status,
      stage: located.document.frontmatter.stage,
      outcome: located.document.frontmatter.outcome,
      branch: located.document.frontmatter.branch,
    };
  } catch {
    return null;
  }
}

/**
 * 任务资料目录快照：文件记内容摘要，目录／符号链接按类型与目标记录，不展开链接。
 * 与 worktree-cleanup 的保全扫描保持同一口径，便于逐项核对复制结果。
 */
function scanTaskMaterial(root: string): MergeMaterialEntry[] {
  const entries: MergeMaterialEntry[] = [];
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

function materialDigest(entries: MergeMaterialEntry[]): string {
  return sha256Text(JSON.stringify(entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    sha256: entry.sha256,
    linkTarget: entry.linkTarget,
  }))));
}

function sameMaterial(left: MergeMaterialEntry[], right: MergeMaterialEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return false;
    if (a.path !== b.path || a.kind !== b.kind) return false;
    if (a.kind === "file" && (a.sha256 !== b.sha256 || a.size !== b.size)) return false;
    if (a.kind === "symlink" && a.linkTarget !== b.linkTarget) return false;
  }
  return true;
}

/** 只替换 frontmatter 的 branch 行，正文与其他状态字段原样保留。 */
function replaceTaskBranchLine(text: string, branch: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return null;
  const frontmatter = match[1] ?? "";
  const nextFrontmatter = /^branch:.*$/m.test(frontmatter)
    ? frontmatter.replace(/^branch:.*$/m, () => `branch: ${branch}`)
    : `${frontmatter}\nbranch: ${branch}`;
  const bodyStart = match[0].indexOf(frontmatter);
  const prefix = match[0].slice(0, bodyStart);
  const suffix = match[0].slice(bodyStart + frontmatter.length);
  return `${prefix}${nextFrontmatter}${suffix}${text.slice(match[0].length)}`;
}

/**
 * 任务资料比较。续做时目标 task.md 可能已由本操作改写 branch：此时只要求其他条目
 * 完全一致，task.md 等于源正文替换为回执记录的目标 branch，避免把自身改写当成冲突。
 */
function sameMaterialWithDocument(input: {
  sourceDir: string;
  targetDir: string;
  sourceEntries: MergeMaterialEntry[];
  targetEntries: MergeMaterialEntry[];
  document: MergeDocumentFacts | null;
}): boolean {
  const { sourceDir, targetDir, sourceEntries, targetEntries, document } = input;
  if (sourceEntries.length !== targetEntries.length) return false;
  const rewrittenBranch = document !== null && document.changed && document.branchAfter !== null
    ? document.branchAfter
    : null;
  const allowTaskRewrite = rewrittenBranch !== null
    && document !== null
    && document.path !== null
    && resolve(document.path) === resolve(join(targetDir, TASK_FILE));
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const a = sourceEntries[index];
    const b = targetEntries[index];
    if (a === undefined || b === undefined) return false;
    if (a.path !== b.path || a.kind !== b.kind) return false;
    if (allowTaskRewrite && rewrittenBranch !== null && a.path === TASK_FILE && a.kind === "file") {
      try {
        const sourceText = readFileSync(join(sourceDir, TASK_FILE), "utf8");
        const targetText = readFileSync(join(targetDir, TASK_FILE), "utf8");
        const expected = replaceTaskBranchLine(sourceText, rewrittenBranch);
        if (expected === null || expected !== targetText) return false;
      } catch {
        return false;
      }
      continue;
    }
    if (a.kind === "file" && (a.sha256 !== b.sha256 || a.size !== b.size)) return false;
    if (a.kind === "symlink" && a.linkTarget !== b.linkTarget) return false;
  }
  return true;
}

function copyMaterial(sourceRoot: string, targetRoot: string, entries: MergeMaterialEntry[]): void {
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const target = join(targetRoot, entry.path);
    if (entry.kind === "directory") {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (entry.kind === "symlink") {
      symlinkSync(entry.linkTarget ?? "", target);
      continue;
    }
    const source = join(sourceRoot, entry.path);
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode & 0o777);
  }
}

function verifyMaterial(root: string, expected: MergeMaterialEntry[]): string | null {
  let current: MergeMaterialEntry[];
  try {
    current = scanTaskMaterial(root);
  } catch (error) {
    return `任务资料副本不可读: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!sameMaterial(expected, current)) return "任务资料副本与源摘要不符";
  return null;
}

function materialSummary(sourceDir: string | null, targetDir: string | null, entries: MergeMaterialEntry[], disposition: MergeMaterial["disposition"]): MergeMaterial {
  return {
    sourceDir,
    targetDir,
    disposition,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    digest: entries.length === 0 ? null : materialDigest(entries),
  };
}

function setStep(steps: MergeStep[], stepId: string, state: MergeStepState, at: string, reason: string | null = null): void {
  const existing = steps.find((step) => step.stepId === stepId);
  if (existing === undefined) {
    steps.push({ stepId, state, at, reason });
    return;
  }
  existing.state = state;
  existing.at = at;
  existing.reason = reason;
}

function writeJournalLine(paths: MergePaths, stepId: string, kind: string, evidence?: Record<string, unknown>): void {
  ensurePrivateDir(paths.dir);
  const line = JSON.stringify({ stepId, kind, at: new Date().toISOString(), ...(evidence ?? {}) }) + "\n";
  const journal = paths.journal;
  if (!existsSync(journal)) writeFileSync(journal, "", { mode: 0o600 });
  writeFileSync(journal, readFileSync(journal, "utf8") + line, { mode: 0o600 });
}

function saveReceipt(paths: MergePaths, receipt: MergeReceipt): void {
  ensurePrivateDir(paths.dir);
  atomicWrite({
    path: paths.receipt,
    data: Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
    mode: 0o600,
  });
}

function readReceipt(mergeRoot: string, opId: string): MergeReceipt | null {
  const version = readWithVersion(join(mergeRoot, opId, RECEIPT_FILE));
  if (version === null) return null;
  try {
    return JSON.parse(version.data.toString("utf8")) as MergeReceipt;
  } catch {
    return null;
  }
}

/** 同一任务的未完成回执；用于中断续做。 */
function findPendingReceipt(mainRoot: string, taskId: string): PendingReceipt | null {
  const root = join(mainRoot, MERGE_DIR);
  if (!existsSync(root)) return null;
  let latest: PendingReceipt | null = null;
  for (const name of readdirSync(root).sort()) {
    if (!/^op-[0-9a-f]{12}$/.test(name)) continue;
    const receipt = readReceipt(root, name);
    if (receipt === null || receipt.finishedAt !== null) continue;
    if (receipt.taskId !== taskId) continue;
    if (resolve(receipt.mainRoot) !== resolve(mainRoot)) continue;
    if (latest !== null && (receipt.startedAt ?? "") < (latest.receipt.startedAt ?? "")) continue;
    latest = { opId: name, receipt, paths: mergePaths(mainRoot, name) };
  }
  return latest;
}

function emptyResult(input: {
  mainRoot: string;
  taskId: string;
  apply: boolean;
  authorizationRef: string | null;
  status: MergeStatus;
  reason: string | null;
}): WorktreeMergeResult {
  return {
    mainRoot: input.mainRoot,
    taskId: input.taskId,
    apply: input.apply,
    status: input.status,
    reason: input.reason,
    opId: null,
    receiptPath: null,
    journalPath: null,
    authorizationRef: input.authorizationRef,
    authorization: null,
    taskStatus: null,
    taskOutcome: null,
    source: null,
    target: null,
    beforeHead: null,
    afterHead: null,
    mergeCommit: null,
    mergeKind: null,
    mergeRequired: false,
    material: null,
    document: null,
    binding: null,
    dirty: null,
    resumed: false,
  };
}

function resultOf(input: {
  plan: MergePlan;
  apply: boolean;
  opId: string | null;
  receiptPath: string | null;
  journalPath: string | null;
  authorizationRef: string | null;
  authorization: AuthorizationSource | null;
  receipt: MergeReceipt | null;
}): WorktreeMergeResult {
  const { plan, receipt } = input;
  const merge = receipt?.merge ?? null;
  const material = receipt?.material ?? plan.material;
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
    authorization: input.authorization,
    taskStatus: plan.taskStatus,
    taskOutcome: plan.taskOutcome,
    source: plan.source,
    target: plan.target,
    beforeHead: merge?.beforeHead ?? plan.beforeHead,
    afterHead: merge?.afterHead ?? null,
    mergeCommit: merge?.commit ?? null,
    mergeKind: merge?.kind ?? null,
    mergeRequired: plan.mergeRequired,
    material,
    document: receipt?.document ?? null,
    binding: receipt?.binding ?? null,
    dirty: plan.dirty,
    resumed: plan.resumed,
  };
}

function ancestorState(root: string, ancestor: string, descendant: string): "yes" | "no" | "unknown" {
  const result = gitSync(["merge-base", "--is-ancestor", ancestor, descendant], root);
  if (result.code === 0) return "yes";
  if (result.code === 1) return "no";
  return "unknown";
}

function mergeMessage(taskId: string, opId: string): string {
  return `knit: merge ${taskId} (${opId})`;
}

/** 回执丢失时按唯一操作 ID 与真实提交 message 核实已生效的合入。 */
function findMergeCommit(mainRoot: string, taskId: string, opId: string): string | null {
  const message = mergeMessage(taskId, opId);
  const result = gitSync(["log", "--all", "--format=%H", "--fixed-strings", `--grep=${message}`], mainRoot);
  if (result.code !== 0) return null;
  for (const oid of result.stdout.split(/\s+/).filter(Boolean)) {
    if (!commitExists(mainRoot, oid)) continue;
    // 与交付阶段共用 trailer／旧前缀识别，避免两套 message 判定漂移。
    if (!isStageCommit(commitMessage(mainRoot, oid), "merge", opId)) continue;
    if (!isAncestor(mainRoot, oid, "HEAD")) continue;
    return oid;
  }
  return null;
}

function verifiedMergeCommit(mainRoot: string, taskId: string, opId: string): string | null {
  return findMergeCommit(mainRoot, taskId, opId);
}

/** 回执完全丢失时的兜底：只认 message 形如 `knit: merge <taskId> (` 且已在当前 HEAD 历史中的提交。 */
function findTaskMergeCommit(mainRoot: string, taskId: string): string | null {
  const prefix = `knit: merge ${taskId} (`;
  const result = gitSync(["log", "--all", "--format=%H", "--fixed-strings", `--grep=${prefix}`], mainRoot);
  if (result.code !== 0) return null;
  for (const oid of result.stdout.split(/\s+/).filter(Boolean)) {
    if (!commitExists(mainRoot, oid)) continue;
    if (!commitMessage(mainRoot, oid).startsWith(prefix)) continue;
    if (!isAncestor(mainRoot, oid, "HEAD")) continue;
    return oid;
  }
  return null;
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

/**
 * 任务正文 branch 只在 frontmatter 行内改写，正文、记录区以及 status／stage／outcome
 * 原样保留；写后回读核对。
 */
function rewriteTaskBranch(file: string, branch: string): {
  branchBefore: string | null;
  branchAfter: string;
  changed: boolean;
  status: string;
  stage: string;
  outcome: string | null;
} {
  const version = readWithVersion(file);
  if (version === null) throw new Error(`task.md 缺失: ${file}`);
  const text = version.data.toString("utf8");
  const document = parseTaskDocument(text, file);
  const branchBefore = document.frontmatter.branch;
  const status = document.frontmatter.status;
  const stage = document.frontmatter.stage;
  const outcome = document.frontmatter.outcome;
  if (branchBefore === branch) {
    return { branchBefore, branchAfter: branch, changed: false, status, stage, outcome };
  }
  const nextText = replaceTaskBranchLine(text, branch);
  if (nextText === null) throw new Error(`task.md 缺少 frontmatter: ${file}`);
  atomicWrite({
    path: file,
    data: Buffer.from(nextText, "utf8"),
    expectedSha256: version.sha256,
    mode: 0o644,
  });
  const after = parseTaskDocument(readFileSync(file, "utf8"), file);
  if (after.frontmatter.branch !== branch) throw new Error("task.md branch 回读不一致");
  if (after.frontmatter.status !== status || after.frontmatter.stage !== stage || after.frontmatter.outcome !== outcome) {
    throw new Error("task.md 状态字段在 branch 更新时发生变化");
  }
  return { branchBefore, branchAfter: after.frontmatter.branch, changed: true, status, stage, outcome };
}

export class WorktreeMergeService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;

  constructor(options: WorktreeMergeOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
  }

  private taskLock(mainRoot: string, taskId: string): LockKey {
    return { scope: "task", rawKey: `${mainRoot}::${taskId}` };
  }

  /** 只读预检或授权合入；预览不创建目录、不写 binding／任务正文、不运行 git merge。 */
  async merge(input: WorktreeMergeInput): Promise<WorktreeMergeResult> {
    if (input.apply !== true) return await this.mergeInScope(input);
    // delivery.hooks=skip（缺省）：apply 全程（预检刷新 index 的 diff、合入、merge --abort、资料转交）
    // 本进程发起的全部 Git 调用都带 core.hooksPath=<私有空目录>，post-index-change 等 hook 不执行。
    const start = resolveProjectStart(input.dir);
    const isolation = hookIsolatedGit(mergeHooksMode(normalizeRoot(start.mainRoot)), gitSync);
    try {
      return await isolation.scope(() => this.mergeInScope(input));
    } finally {
      isolation.dispose();
    }
  }

  private async mergeInScope(input: WorktreeMergeInput): Promise<WorktreeMergeResult> {
    const start = resolveProjectStart(input.dir);
    if (start.linkedWorktree) {
      throw new GuardError(
        "main_checkout_required",
        `main_checkout_required: worktree merge 只在主检出运行；当前 ${start.executionDir} 位于关联 worktree`,
      );
    }
    const mainRoot = normalizeRoot(start.mainRoot);
    const apply = input.apply === true;
    if (apply) assertNotInStageContext("worktree merge --apply");
    const into = typeof input.into === "string" ? input.into.trim() : "";
    if (!isFullBranch(into)) {
      throw new GuardError("branch_invalid", "branch_invalid: --into 必须是完整本地 refs/heads/...");
    }
    const authorizationRef = typeof input.authorizationRef === "string" ? input.authorizationRef.trim() : "";
    if (apply && authorizationRef === "") {
      throw new GuardError("authorization_required", "authorization_required: worktree merge --apply 需要非空 --authorization-ref");
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
      into,
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
        authorization: null,
        receipt: null,
      });
    }
    if (plan.status !== "mergeable") {
      return resultOf({
        plan,
        apply: true,
        opId: pending?.opId ?? null,
        receiptPath: pending?.paths.receipt ?? null,
        journalPath: pending?.paths.journal ?? null,
        authorizationRef,
        authorization,
        receipt: pending?.receipt ?? null,
      });
    }

    // 整体预检通过后才建立操作目录；先落 planned journal 与未完成回执。
    const opId = pending?.opId ?? newOpId();
    const paths = mergePaths(mainRoot, opId);
    const receipt: MergeReceipt = pending?.receipt ?? {
      schemaVersion: 1 as const,
      opId,
      taskId: input.taskId,
      mainRoot,
      apply: true,
      startedAt: this.now().toISOString(),
      authorizationRef,
      authorization,
      taskStatus: null,
      taskOutcome: null,
      source: null,
      target: null,
      merge: null,
      material: null,
      document: null,
      binding: null,
      steps: [],
      finishedAt: null,
    };
    receipt.authorizationRef = authorizationRef;
    receipt.authorization = authorization;
    receipt.taskStatus = plan.taskStatus;
    receipt.taskOutcome = plan.taskOutcome;
    receipt.source = plan.source;
    receipt.target = plan.target;
    for (const stepId of ["merge", "transfer", "document", "binding"]) {
      if (!receipt.steps.some((step) => step.stepId === stepId)) {
        receipt.steps.push({ stepId, state: "planned", at: this.now().toISOString(), reason: null });
      }
    }
    saveReceipt(paths, receipt);
    writeJournalLine(paths, "plan", "planned", {
      opId,
      taskId: input.taskId,
      target: plan.target,
      source: plan.source,
      mergeRequired: plan.mergeRequired,
      authorizationRef,
      authorizationKind: authorization?.kind ?? null,
    });

    let lock;
    try {
      lock = await this.locks.acquire({
        keys: orderKeys([{ scope: "project", rawKey: mainRoot }, this.taskLock(mainRoot, input.taskId)]),
        action: "worktree.merge",
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
        authorization,
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
          authorization,
          receipt,
        });
      }
      const fresh = await this.buildPlan({
        mainRoot,
        taskId: input.taskId,
        binding: currentBinding,
        pending: { opId, receipt, paths },
        into,
        checkLocks: false,
      });
      // 本次新操作不是续做；合成 pending 只用于锁内复用同一回执事实。
      fresh.resumed = pending !== null;
      if (fresh.status !== "mergeable") {
        writeJournalLine(paths, "precheck", "failed", { status: fresh.status, reason: fresh.reason });
        receipt.taskStatus = fresh.taskStatus;
        receipt.taskOutcome = fresh.taskOutcome;
        receipt.source = fresh.source;
        receipt.target = fresh.target;
        saveReceipt(paths, receipt);
        await this.writeOperation(opId, "needs_attention", fresh.reason);
        return resultOf({
          plan: fresh,
          apply: true,
          opId,
          receiptPath: paths.receipt,
          journalPath: paths.journal,
          authorizationRef,
          authorization,
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
        authorization,
        into,
      });
    } finally {
      this.locks.release(lock);
    }
  }

  /** 锁内执行：合入 → 转交任务资料 → 改写任务正文 branch → 转交 binding。 */
  private async execute(input: {
    plan: MergePlan;
    mainRoot: string;
    opId: string;
    paths: MergePaths;
    receipt: MergeReceipt;
    authorizationRef: string;
    authorization: AuthorizationSource | null;
    into: string;
  }): Promise<WorktreeMergeResult> {
    const { plan, mainRoot, opId, paths, receipt, authorizationRef, authorization, into } = input;
    const finish = (status: MergeStatus, reason: string | null): WorktreeMergeResult => {
      plan.status = status;
      plan.reason = reason;
      return resultOf({
        plan,
        apply: true,
        opId,
        receiptPath: paths.receipt,
        journalPath: paths.journal,
        authorizationRef,
        authorization,
        receipt,
      });
    };
    const record = (): void => saveReceipt(paths, receipt);

    // 1. 合入（源已是目标祖先时不产生提交）。
    let merge = receipt.merge;
    const recovered = verifiedMergeCommit(mainRoot, plan.taskId, opId);
    const receiptCommit = receipt.merge?.commit ?? null;
    const recordedCommit = recovered
      ?? (receiptCommit !== null && commitExists(mainRoot, receiptCommit)
        && isStageCommit(commitMessage(mainRoot, receiptCommit), "merge", opId)
        && isAncestor(mainRoot, receiptCommit, "HEAD")
        ? receiptCommit
        : null);
    if (recordedCommit !== null && isAncestor(mainRoot, plan.source?.branch ?? "", "HEAD")) {
      const parentResult = gitSync(["rev-parse", `${recordedCommit}^1`], mainRoot);
      const beforeHead = receipt.merge?.beforeHead
        ?? (parentResult.code === 0 ? parentResult.stdout.trim() : null);
      const head = gitSync(["rev-parse", "HEAD"], mainRoot).stdout.trim();
      merge = {
        kind: "recovered",
        beforeHead,
        afterHead: head,
        commit: recordedCommit,
        message: mergeMessage(plan.taskId, opId),
        failure: null,
        restored: null,
      };
      setStep(receipt.steps, "merge", "completed", this.now().toISOString(), "已核实的合入提交，不重复合入");
      writeJournalLine(paths, "merge", "skipped", { commit: recordedCommit, kind: "recovered" });
    } else if (!plan.mergeRequired) {
      const head = gitSync(["rev-parse", "HEAD"], mainRoot).stdout.trim();
      const prior = receipt.merge?.commit ?? findTaskMergeCommit(mainRoot, plan.taskId);
      if (prior !== null && commitExists(mainRoot, prior) && isAncestor(mainRoot, prior, "HEAD")) {
        const parentResult = gitSync(["rev-parse", `${prior}^1`], mainRoot);
        merge = {
          kind: "recovered",
          beforeHead: receipt.merge?.beforeHead ?? (parentResult.code === 0 ? parentResult.stdout.trim() : null),
          afterHead: head,
          commit: prior,
          message: receipt.merge?.message ?? mergeMessage(plan.taskId, opId),
          failure: null,
          restored: null,
        };
        setStep(receipt.steps, "merge", "completed", this.now().toISOString(), "按已有合入提交恢复，不重复合入");
        writeJournalLine(paths, "merge", "skipped", { commit: prior, kind: "recovered" });
      } else {
        merge = {
          kind: receipt.merge?.kind === "merge" || receipt.merge?.kind === "recovered" ? receipt.merge.kind : "noop",
          beforeHead: receipt.merge?.beforeHead ?? head,
          afterHead: head,
          commit: receipt.merge?.commit ?? null,
          message: receipt.merge?.message ?? null,
          failure: null,
          restored: null,
        };
        setStep(receipt.steps, "merge", "skipped", this.now().toISOString(), "源分支已是目标祖先");
        writeJournalLine(paths, "merge", "skipped", { kind: merge.kind, head });
      }
    } else {
      const sourceBranch = plan.source?.branch ?? "";
      const before = gitSync(["rev-parse", "HEAD"], mainRoot);
      if (before.code !== 0) {
        const reason = `读取目标 HEAD 失败: ${before.stderr.trim() || "无输出"}`;
        merge = {
          kind: "merge",
          beforeHead: null,
          afterHead: null,
          commit: null,
          message: mergeMessage(plan.taskId, opId),
          failure: reason,
          restored: null,
        };
        setStep(receipt.steps, "merge", "failed", this.now().toISOString(), reason);
        receipt.merge = merge;
        record();
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("failed", reason);
      }
      const beforeHead = before.stdout.trim();
      const message = mergeMessage(plan.taskId, opId);
      writeJournalLine(paths, "merge", "planned", { sourceBranch, into, beforeHead, message });
      // Knit 发起的合入提交与交付提交同口径隔离用户 hooks（delivery.hooks，缺省 skip）；
      // execute 已在隔离范围内（merge() 对 apply 全程建立），这里的显式前置保留为合入命令本身的证据。
      const isolation = hookIsolatedGit(mergeHooksMode(mainRoot), gitSync);
      let result;
      try {
        result = isolation.git(["merge", "--no-ff", "-m", message, sourceBranch], mainRoot);
      } finally {
        isolation.dispose();
      }
      const after = gitSync(["rev-parse", "HEAD"], mainRoot);
      const afterHead = after.code === 0 ? after.stdout.trim() : null;
      const commitCreated = afterHead !== null && afterHead !== beforeHead
        && isStageCommit(commitMessage(mainRoot, afterHead), "merge", opId);
      if (result.code === 0 || commitCreated) {
        if (afterHead === null) {
          const reason = "合入后无法读取 HEAD";
          merge = {
            kind: "merge",
            beforeHead,
            afterHead: null,
            commit: null,
            message,
            failure: reason,
            restored: null,
          };
          setStep(receipt.steps, "merge", "failed", this.now().toISOString(), reason);
          receipt.merge = merge;
          record();
          await this.writeOperation(opId, "needs_attention", reason);
          return finish("failed", reason);
        }
        if (afterHead === beforeHead) {
          // 预检后源分支已变为祖先：按 noop 记录，不虚构提交。
          merge = {
            kind: "noop",
            beforeHead,
            afterHead,
            commit: null,
            message,
            failure: null,
            restored: null,
          };
          setStep(receipt.steps, "merge", "skipped", this.now().toISOString(), "git merge 报告无需合入");
          writeJournalLine(paths, "merge", "skipped", { kind: "noop", head: afterHead });
        } else {
          const parent = gitSync(["rev-parse", `${afterHead}^1`], mainRoot);
          const parentOid = parent.code === 0 ? parent.stdout.trim() : null;
          const sourceAncestor = plan.source === null
            ? "unknown"
            : ancestorState(mainRoot, plan.source.branch, "HEAD");
          if (!isStageCommit(commitMessage(mainRoot, afterHead), "merge", opId) || parentOid !== beforeHead || sourceAncestor !== "yes") {
            const reason = "合入提交核验不符（message／父节点／祖先关系）";
            merge = {
              kind: "merge",
              beforeHead,
              afterHead,
              commit: afterHead,
              message,
              failure: reason,
              restored: null,
            };
            setStep(receipt.steps, "merge", "failed", this.now().toISOString(), reason);
            receipt.merge = merge;
            record();
            await this.writeOperation(opId, "needs_attention", reason);
            return finish("failed", reason);
          }
          merge = {
            kind: result.code === 0 ? "merge" : "recovered",
            beforeHead,
            afterHead,
            commit: afterHead,
            message,
            failure: null,
            restored: null,
          };
          setStep(receipt.steps, "merge", "completed", this.now().toISOString());
          writeJournalLine(paths, "merge", "applied", { commit: afterHead, parent: parentOid, sourceBranch });
        }
      } else {
        // 合入失败：有 MERGE_HEAD 则 abort，恢复原 HEAD；源 worktree／分支保留。
        const mergeHead = gitSync(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], mainRoot);
        const hadMergeHead = mergeHead.code === 0;
        let abortReason: string | null = null;
        if (hadMergeHead) {
          // 在隔离范围内：gitSync 自动前置 core.hooksPath，abort 重写 index 不触发 post-index-change。
          const abort = gitSync(["merge", "--abort"], mainRoot);
          if (abort.code !== 0) abortReason = abort.stderr.trim() || abort.stdout.trim() || "git merge --abort 未完成";
        }
        const restoredHead = gitSync(["rev-parse", "HEAD"], mainRoot);
        const restoredIndex = gitSync(["diff", "--cached", "--name-only", "-z"], mainRoot);
        const residualMergeHead = gitSync(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], mainRoot);
        const indexRestored = restoredIndex.code === 0
          && restoredIndex.stdout.split("\0").filter(Boolean).length === 0;
        const restored = restoredHead.code === 0
          && restoredHead.stdout.trim() === beforeHead
          && indexRestored
          && residualMergeHead.code !== 0;
        const output = `${result.stdout}\n${result.stderr}`;
        const conflict = hadMergeHead || /CONFLICT|would be overwritten|untracked working tree/i.test(output);
        const reasonText = abortReason
          ?? (restored
            ? (conflict ? "合入冲突，已 abort 并恢复原 HEAD" : "git merge 失败，已恢复原 HEAD")
            : "git merge 失败且现场未恢复到原 HEAD");
        merge = {
          kind: "merge",
          beforeHead,
          afterHead: restoredHead.code === 0 ? restoredHead.stdout.trim() : null,
          commit: null,
          message,
          failure: `${reasonText}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}`,
          restored,
        };
        setStep(receipt.steps, "merge", "failed", this.now().toISOString(), reasonText);
        receipt.merge = merge;
        record();
        writeJournalLine(paths, "merge", "failed", {
          beforeHead,
          afterHead: merge.afterHead,
          restored,
          conflict,
          exit: result.code,
          reason: reasonText,
        });
        await this.writeOperation(opId, "needs_attention", reasonText);
        return finish(abortReason !== null || !restored ? "failed" : (conflict ? "conflict" : "failed"), reasonText);
      }
    }
    receipt.merge = merge;
    record();

    // 2. 转交任务资料：不存在则复制并逐项核对；相同保留；不同保留两边并 partial。
    const sourceDir = plan.material?.sourceDir ?? null;
    const targetDir = plan.material?.targetDir ?? null;
    if (sourceDir === null || targetDir === null) {
      const reason = "源任务资料目录缺失，无法转交";
      setStep(receipt.steps, "transfer", "failed", this.now().toISOString(), reason);
      receipt.material = receipt.material ?? materialSummary(sourceDir, targetDir, [], "absent");
      record();
      writeJournalLine(paths, "transfer", "failed", { reason });
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", reason);
    }
    let entries: MergeMaterialEntry[];
    try {
      entries = scanTaskMaterial(sourceDir);
    } catch (error) {
      const reason = `源任务资料不可读: ${error instanceof Error ? error.message : String(error)}`;
      setStep(receipt.steps, "transfer", "failed", this.now().toISOString(), reason);
      record();
      writeJournalLine(paths, "transfer", "failed", { reason });
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", reason);
    }
    const targetExists = existsSync(targetDir);
    if (targetExists) {
      if (!isDirectory(targetDir)) {
        const reason = `主检出任务资料路径已存在且不是目录: ${targetDir}`;
        setStep(receipt.steps, "transfer", "failed", this.now().toISOString(), reason);
        receipt.material = materialSummary(sourceDir, targetDir, entries, "conflict");
        record();
        writeJournalLine(paths, "transfer", "failed", { reason });
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("partial", reason);
      }
      let targetEntries: MergeMaterialEntry[];
      try {
        targetEntries = scanTaskMaterial(targetDir);
      } catch (error) {
        const reason = `主检出任务资料不可读: ${error instanceof Error ? error.message : String(error)}`;
        setStep(receipt.steps, "transfer", "failed", this.now().toISOString(), reason);
        record();
        writeJournalLine(paths, "transfer", "failed", { reason });
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("partial", reason);
      }
      if (sameMaterialWithDocument({
        sourceDir,
        targetDir,
        sourceEntries: entries,
        targetEntries,
        document: receipt.document,
      })) {
        receipt.material = materialSummary(sourceDir, targetDir, entries, "kept");
        setStep(receipt.steps, "transfer", "completed", this.now().toISOString(), "目标资料已存在且摘要一致");
        writeJournalLine(paths, "transfer", "skipped", { targetDir, files: entries.length, digest: receipt.material.digest });
      } else {
        const reason = `主检出已存在本任务资料且内容不同，保留两边: ${targetDir}`;
        receipt.material = materialSummary(sourceDir, targetDir, entries, "conflict");
        setStep(receipt.steps, "transfer", "failed", this.now().toISOString(), reason);
        record();
        writeJournalLine(paths, "transfer", "failed", { reason, targetDir });
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("partial", reason);
      }
    } else {
      writeJournalLine(paths, "transfer", "planned", { sourceDir, targetDir, files: entries.length });
      try {
        copyMaterial(sourceDir, targetDir, entries);
        const problem = verifyMaterial(targetDir, entries);
        if (problem !== null) throw new Error(problem);
        receipt.material = materialSummary(sourceDir, targetDir, entries, "copied");
        setStep(receipt.steps, "transfer", "completed", this.now().toISOString());
        writeJournalLine(paths, "transfer", "applied", {
          targetDir,
          files: entries.filter((entry) => entry.kind === "file").length,
          digest: receipt.material.digest,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setStep(receipt.steps, "transfer", "failed", this.now().toISOString(), reason);
        record();
        writeJournalLine(paths, "transfer", "failed", { reason, targetDir });
        await this.writeOperation(opId, "needs_attention", reason);
        return finish("partial", `任务资料转交失败: ${reason}`);
      }
    }
    record();

    // 3. 任务正文 branch 改为目标分支（不改 status／stage／outcome／正文）。
    const targetTaskFile = join(targetDir, TASK_FILE);
    if (!existsSync(targetTaskFile)) {
      const reason = `任务资料缺少 task.md: ${targetTaskFile}`;
      setStep(receipt.steps, "document", "failed", this.now().toISOString(), reason);
      record();
      writeJournalLine(paths, "document", "failed", { reason });
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", reason);
    }
    try {
      const rewritten = rewriteTaskBranch(targetTaskFile, into);
      receipt.document = {
        path: targetTaskFile,
        branchBefore: rewritten.branchBefore,
        branchAfter: rewritten.branchAfter,
        changed: rewritten.changed,
      };
      setStep(receipt.steps, "document", "completed", this.now().toISOString());
      writeJournalLine(paths, "document", "applied", {
        path: targetTaskFile,
        branchBefore: rewritten.branchBefore,
        branchAfter: rewritten.branchAfter,
        changed: rewritten.changed,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStep(receipt.steps, "document", "failed", this.now().toISOString(), reason);
      record();
      writeJournalLine(paths, "document", "failed", { reason });
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", `任务正文 branch 更新失败: ${reason}`);
    }
    record();

    // 4. binding 转交：branch=目标；worktree.active=false；保留路径／分支等线索。
    const currentBinding = await this.store.bindings.get(plan.taskId);
    if (currentBinding === null) {
      const reason = "锁内缺少绑定，binding 未转交";
      setStep(receipt.steps, "binding", "failed", this.now().toISOString(), reason);
      record();
      writeJournalLine(paths, "binding", "failed", { reason });
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", reason);
    }
    if (currentBinding.worktree === undefined) {
      const reason = "binding 缺少 worktree 登记，无法转交";
      setStep(receipt.steps, "binding", "failed", this.now().toISOString(), reason);
      record();
      writeJournalLine(paths, "binding", "failed", { reason });
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", reason);
    }
    const mergedAt = receipt.binding?.mergedAt ?? receipt.startedAt;
    const worktree = {
      ...currentBinding.worktree,
      active: false,
      mergedAt,
      lastMergeOp: opId,
    };
    const next: TaskBinding = { ...currentBinding, branch: into, worktree };
    try {
      await this.store.bindings.save(next);
      const readback = await this.store.bindings.get(plan.taskId);
      if (readback === null || readback.branch !== into || readback.worktree?.active !== false
        || readback.worktree?.mergedAt !== mergedAt || readback.worktree?.lastMergeOp !== opId) {
        throw new Error("binding 回读不一致");
      }
      receipt.binding = {
        branchBefore: currentBinding.branch,
        branchAfter: into,
        activeBefore: currentBinding.worktree.active === true,
        activeAfter: false,
        mergedAt,
        lastMergeOp: opId,
      };
      setStep(receipt.steps, "binding", "completed", this.now().toISOString());
      writeJournalLine(paths, "binding", "applied", {
        branchBefore: currentBinding.branch,
        branchAfter: into,
        mergedAt,
        lastMergeOp: opId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStep(receipt.steps, "binding", "failed", this.now().toISOString(), reason);
      record();
      writeJournalLine(paths, "binding", "failed", { reason });
      await this.writeOperation(opId, "needs_attention", reason);
      return finish("partial", `binding 转交失败: ${reason}`);
    }
    record();

    // 5. 收束回执与 operation。
    try {
      await this.writeOperation(opId, "completed", null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      writeJournalLine(paths, "operation", "failed", { reason });
      record();
      return finish("partial", `operation 记录写入失败: ${reason}`);
    }
    receipt.finishedAt = this.now().toISOString();
    record();
    writeJournalLine(paths, "finish", "completed", { finishedAt: receipt.finishedAt });
    return finish("merged", null);
  }

  private async writeOperation(opId: string, state: "completed" | "needs_attention", reason: string | null): Promise<void> {
    await this.store.operations.save({
      operationId: opId,
      kind: "worktree.merge",
      state,
      reason,
      recordedAt: this.now().toISOString(),
    });
  }

  /** 只读预检：任务结束、现场一致、源 dirty、目标、活动／未知执行、资料与合入可行性。 */
  private async buildPlan(input: {
    mainRoot: string;
    taskId: string;
    binding: TaskBinding;
    pending: PendingReceipt | null;
    into: string;
    checkLocks: boolean;
  }): Promise<MergePlan> {
    const { mainRoot, taskId, binding, pending, into, checkLocks } = input;
    const info = binding.worktree ?? null;
    const base: MergePlan = {
      mainRoot,
      taskId,
      status: "mergeable",
      reason: null,
      binding,
      source: null,
      target: null,
      taskStatus: null,
      taskOutcome: null,
      beforeHead: null,
      mergeRequired: false,
      material: null,
      dirty: null,
      resumed: pending !== null,
    };
    if (info === null) {
      base.status = "noop";
      base.reason = "任务没有 worktree";
      return base;
    }
    if (info.active !== true && pending === null) {
      base.status = "noop";
      base.reason = "worktree 已转交，无需再次合入";
      return base;
    }
    if (pending !== null && pending.receipt.target !== null && pending.receipt.target.ref !== into) {
      base.status = "invalid";
      base.reason = `存在目标为 ${pending.receipt.target.ref} 的未完成合入回执，与本次 --into 不一致`;
      return base;
    }

    const mainLocated = locateTask(mainRoot, taskId);
    if (mainLocated?.archived === true) {
      base.status = "invalid";
      base.reason = "任务已归档，无需合入";
      return base;
    }

    const worktreePath = info.path;
    const exists = existsSync(worktreePath) && isDirectory(worktreePath);
    if (!exists) {
      base.status = "invalid";
      base.reason = `登记路径缺失: ${worktreePath}`;
      return base;
    }
    const sourceLocated = locateTask(worktreePath, taskId);
    if (sourceLocated?.archived === true) {
      base.status = "invalid";
      base.reason = "任务已归档，无需合入";
      return base;
    }
    const facts = sourceLocated ?? mainLocated;
    base.taskStatus = facts?.status ?? pending?.receipt.taskStatus ?? null;
    base.taskOutcome = facts?.outcome ?? pending?.receipt.taskOutcome ?? null;
    if (base.taskStatus === null) {
      base.status = "invalid";
      base.reason = "任务资料缺失或不可解析，无法核实任务已结束";
      return base;
    }
    if (base.taskStatus !== "closed" || base.taskOutcome !== "completed") {
      base.status = "blocked_task_open";
      base.reason = `任务未按完成结束（status=${base.taskStatus}, outcome=${base.taskOutcome ?? "null"}）；先完成并关闭任务`;
      return base;
    }

    // 现场一致：porcelain 登记、分支相符、归属当前主检出。
    const detailed = listWorktreesDetailed(mainRoot);
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
    const worktreeStart = resolveProjectStart(worktreePath);
    if (!worktreeStart.linkedWorktree || resolve(worktreeStart.mainRoot) !== resolve(mainRoot)) {
      base.status = "invalid";
      base.reason = `worktree 归属不符: ${worktreePath} 不属于 ${mainRoot}`;
      return base;
    }
    if (entry.locked) {
      base.status = "blocked_locked";
      base.reason = `worktree 被 Git 标记 locked${entry.lockReason === null ? "" : `（${entry.lockReason}）`}；先人工解除`;
      return base;
    }

    const sourceDir = sourceLocated?.dir ?? null;
    if (sourceDir === null) {
      base.status = "blocked_unknown";
      base.reason = "源 worktree 内缺少本任务资料目录，无法转交";
      return base;
    }
    if (!insideDir(worktreePath, sourceDir)) {
      base.status = "invalid";
      base.reason = `源任务资料目录不在 worktree 内: ${sourceDir}`;
      return base;
    }
    const sourceRelative = posixPath(relative(worktreePath, sourceDir));
    base.source = {
      layout: info.layout,
      path: worktreePath,
      branch: info.branch,
      baseline: info.baseline,
      relativePath: info.relativePath ?? null,
      taskDir: sourceDir,
    };

    // 源工作区：任务资料目录之外的 tracked／untracked 改动阻断；ignored 允许。
    const status = gitSync(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktreePath);
    if (status.code !== 0) {
      base.status = "invalid";
      base.reason = `源 worktree git status 失败: ${status.stderr.trim() || "无输出"}`;
      return base;
    }
    const changed = porcelainStatusPaths(status.stdout).map((path) => posixPath(path));
    const outside = changed.filter((path) => path !== sourceRelative && !path.startsWith(`${sourceRelative}/`));
    if (outside.length > 0) {
      base.dirty = { entries: outside.length, sample: outside.slice(0, 8) };
      base.status = "blocked_dirty";
      base.reason = `源 worktree 在任务资料目录之外有 ${outside.length} 项未提交／未跟踪改动：${outside.slice(0, 8).join(", ")}`;
      return base;
    }

    // 目标：存在、是主检出当前分支、未被其它 worktree 检出、index 与 tracked 工作区清洁。
    const headResult = gitSync(["rev-parse", "--verify", "HEAD"], mainRoot);
    const beforeHead = headResult.code === 0 ? headResult.stdout.trim() : null;
    base.beforeHead = beforeHead;
    base.target = {
      ref: into,
      branch: into,
      currentBranch: currentBranch(mainRoot),
      beforeHead,
    };
    if (!branchExists(mainRoot, into)) {
      base.status = "blocked_target";
      base.reason = `目标分支不存在: ${into}`;
      return base;
    }
    if (base.target.currentBranch !== into) {
      base.status = "blocked_target";
      base.reason = `目标必须是主检出当前分支；当前 ${base.target.currentBranch ?? "（detached）"}，不自动切换`;
      return base;
    }
    if (beforeHead === null) {
      base.status = "blocked_target";
      base.reason = "主检出 HEAD 不可读";
      return base;
    }
    const occupying = detailed.entries.find((candidate) => candidate.branch === into
      && resolve(candidate.path) !== resolve(mainRoot));
    if (occupying !== undefined) {
      base.status = "blocked_target";
      base.reason = `目标分支已被其它 worktree 检出: ${occupying.path}`;
      return base;
    }
    const mergeHead = gitSync(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], mainRoot);
    if (mergeHead.code === 0) {
      base.status = "blocked_target";
      base.reason = "主检出仍有未完成的 merge（MERGE_HEAD 存在）";
      return base;
    }
    const staged = gitSync(["diff", "--cached", "--name-only", "-z"], mainRoot);
    if (staged.code !== 0) {
      base.status = "blocked_target";
      base.reason = `读取目标 index 失败: ${staged.stderr.trim() || "无输出"}`;
      return base;
    }
    const stagedPaths = staged.stdout.split("\0").filter(Boolean);
    if (stagedPaths.length > 0) {
      base.status = "blocked_target";
      base.reason = `目标 index 已有暂存内容: ${stagedPaths.slice(0, 8).join(", ")}`;
      return base;
    }
    const unstaged = gitSync(["diff", "--name-only", "-z"], mainRoot);
    if (unstaged.code !== 0) {
      base.status = "blocked_dirty";
      base.reason = `读取目标工作区失败: ${unstaged.stderr.trim() || "无输出"}`;
      return base;
    }
    const trackedChanges = unstaged.stdout.split("\0").filter(Boolean);
    if (trackedChanges.length > 0) {
      base.dirty = { entries: trackedChanges.length, sample: trackedChanges.slice(0, 8) };
      base.status = "blocked_dirty";
      base.reason = `目标 tracked 工作区有 ${trackedChanges.length} 项修改: ${trackedChanges.slice(0, 8).join(", ")}`;
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

    // 资料可转交：主检出同路径不存在或内容相同；不同保留两边并 conflict。
    const targetDir = join(mainRoot, relative(worktreePath, sourceDir));
    let entries: MergeMaterialEntry[];
    try {
      entries = scanTaskMaterial(sourceDir);
    } catch (error) {
      base.status = "blocked_unknown";
      base.reason = `源任务资料不可读: ${error instanceof Error ? error.message : String(error)}`;
      return base;
    }
    if (existsSync(targetDir)) {
      if (!isDirectory(targetDir)) {
        base.material = materialSummary(sourceDir, targetDir, entries, "conflict");
        base.status = "conflict";
        base.reason = `主检出任务资料路径已存在且不是目录: ${targetDir}`;
        return base;
      }
      let targetEntries: MergeMaterialEntry[];
      try {
        targetEntries = scanTaskMaterial(targetDir);
      } catch (error) {
        base.status = "blocked_unknown";
        base.reason = `主检出任务资料不可读: ${error instanceof Error ? error.message : String(error)}`;
        return base;
      }
      if (!sameMaterialWithDocument({
        sourceDir,
        targetDir,
        sourceEntries: entries,
        targetEntries,
        document: pending?.receipt.document ?? null,
      })) {
        base.material = materialSummary(sourceDir, targetDir, entries, "conflict");
        base.status = "conflict";
        base.reason = `主检出已存在本任务资料且内容不同（保留两边）: ${targetDir}`;
        return base;
      }
      base.material = materialSummary(sourceDir, targetDir, entries, "kept");
    } else {
      base.material = materialSummary(sourceDir, targetDir, entries, "copied");
    }

    // 合入可行性：源分支存在于本地、源与目标不同、merge-base 可读。
    if (!isFullBranch(info.branch)) {
      base.status = "invalid";
      base.reason = `登记源分支不是完整 refs/heads/...: ${info.branch}`;
      return base;
    }
    if (info.branch === into) {
      base.status = "invalid";
      base.reason = "源分支与目标分支相同，无需合入";
      return base;
    }
    if (!branchExists(mainRoot, info.branch)) {
      base.status = "invalid";
      base.reason = `源分支本地不存在: ${info.branch}`;
      return base;
    }
    const mergeBase = gitSync(["merge-base", info.branch, into], mainRoot);
    if (mergeBase.code !== 0 || mergeBase.stdout.trim() === "") {
      base.status = "invalid";
      base.reason = `无法读取 ${info.branch} 与 ${into} 的 merge-base`;
      return base;
    }
    const ancestor = ancestorState(mainRoot, info.branch, into);
    if (ancestor === "unknown") {
      base.status = "invalid";
      base.reason = `无法判断源分支是否已合入 ${into}`;
      return base;
    }
    base.mergeRequired = ancestor === "no";
    base.status = "mergeable";
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

/** 无本机元数据库或无候选时的只读结果；不创建运行目录。 */
export function mergeNoopResult(
  mainRoot: string,
  taskId: string,
  apply: boolean,
  authorizationRef: string | null,
  status: MergeStatus = "noop",
  reason: string | null = "任务没有 worktree",
): WorktreeMergeResult {
  return emptyResult({ mainRoot, taskId, apply, authorizationRef, status, reason });
}

/** 合入提交的 hooks 策略：读主检出配置；配置不可读按缺省 skip。 */
function mergeHooksMode(mainRoot: string): "skip" | "run" {
  try {
    return deliveryHooksOf(parseConfig(readFileSync(join(mainRoot, ".knit", "config.json"), "utf8")));
  } catch {
    return deliveryHooksOf(defaultConfig());
  }
}
