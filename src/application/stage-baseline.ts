/**
 * 阶段基线冻结与边界核对（DESIGN §5.1、OPERATIONS §2.1）。
 *
 * worker 启动阶段 Agent 前记录 HEAD／符号引用／index 摘要、工作区签名、敏感区指纹与忽略区目录级摘要；
 * 收尾时以同一规则再取一次：HEAD 移动判失败（阶段内禁止提交），敏感区变化判失败，
 * index 变化与忽略区变化只记录。不是操作系统沙箱：只检测、拒绝接收或如实记录，不拦截 shell。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync } from "../infrastructure/process.js";
import type { IgnoredChange, StageBaselineSummary, StageBoundaryFacts } from "../contracts/run.js";
import { worktreeSignature, type WorktreeSignature } from "./worktree.js";

export type { IgnoredChange, StageBaselineSummary, StageBoundaryFacts };

type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string };

export interface BoundaryContext {
  /** 任务执行目录（主检出或 worktree）。 */
  executionDir: string;
  /** 主检出根：`.knit/.runtime` 所在位置。 */
  root: string;
  runId: string;
  taskId: string;
  /** 忽略区摘要排除的绝对路径（如项目内锁根）。 */
  ignoredExclusions?: string[];
  git?: GitRunner;
}

/** 其它 run 在基线时的分类：active 由其自身 worker 写，settled 的不可变资料受保护。 */
type RunClass = "active" | "settled";

interface ProtectedScan {
  entries: Record<string, string>;
  runs: Record<string, RunClass>;
}

export interface StageBaseline {
  summary: StageBaselineSummary;
  worktree: WorktreeSignature;
  protectedScan: ProtectedScan;
  ignored: Record<string, string>;
}

const RUNTIME_PREFIX = ".knit/.runtime/";
/** settled run 中不可变的权威资料；state／events／launch 仍可能被接收收敛或观察写入。 */
const SETTLED_RUN_FILES = ["request.json", "result.json", "inputs.json", "instructions.json"];
const ACTIVE_RUN_STATES = new Set(["claimed", "preparing", "running"]);
/** failureReason 中最多列出的敏感路径数；完整列表在 result.boundary.protectedPaths。 */
const REASON_PATH_LIMIT = 20;

function headOf(dir: string, git: GitRunner): string | null {
  const result = git(["rev-parse", "-q", "--verify", "HEAD^{commit}"], dir);
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

function symbolicRefOf(dir: string, git: GitRunner): string | null {
  const result = git(["symbolic-ref", "-q", "HEAD"], dir);
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

/** index 摘要：`git ls-files -s -z`（模式、对象、stage、路径），不含 stat 缓存。 */
function indexDigestOf(dir: string, git: GitRunner): string | null {
  const result = git(["ls-files", "-s", "-z"], dir);
  return result.code === 0 ? sha256Text(result.stdout) : null;
}

function commonGitDir(dir: string, git: GitRunner): string | null {
  const absolute = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  if (absolute.code === 0 && absolute.stdout.trim() !== "") return absolute.stdout.trim();
  const plain = git(["rev-parse", "--git-common-dir"], dir);
  if (plain.code !== 0 || plain.stdout.trim() === "") return null;
  const value = plain.stdout.trim();
  return isAbsolute(value) ? value : resolve(dir, value);
}

/** 内容指纹（含权限位：给 hook 加执行位也是变化）；用于小体量敏感文件。 */
function contentFact(path: string): string {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (stats.isFile()) return `file:${(stats.mode & 0o7777).toString(8)}:${sha256Bytes(readFileSync(path))}`;
    if (stats.isDirectory()) return "dir";
    return "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

/** stat 指纹：大小、mtime／ctime（纳秒）、inode 与模式；ctime 无法由用户态回拨，成本远低于逐字节摘要。 */
function statFact(path: string): string {
  try {
    const stats = lstatSync(path, { bigint: true });
    const kind = stats.isSymbolicLink() ? "link" : stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other";
    return `${kind}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}:${(stats.mode & 0o7777n).toString(8)}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

/** 递归列出目录内非目录条目（不跟随符号链接）；目录不存在返回空。 */
function walkFiles(dir: string, base = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function gitAreaEntries(commonDir: string | null, out: Record<string, string>): void {
  if (commonDir === null) return;
  out[".git/config"] = contentFact(join(commonDir, "config"));
  for (const area of ["hooks", "info"]) {
    for (const rel of walkFiles(join(commonDir, area))) {
      out[`.git/${area}/${rel}`] = contentFact(join(commonDir, area, rel));
    }
  }
}

function classifyRun(runDir: string): RunClass {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  } catch {
    // 尚无 state（刚 prepare 未认领）或正被写入：由其自身 worker 负责，按活动处理。
    return "active";
  }
  const state = typeof (raw as { state?: unknown }).state === "string" ? (raw as { state: string }).state : null;
  const reason = typeof (raw as { reason?: unknown }).reason === "string" ? (raw as { reason: string }).reason : "";
  if (state === null || ACTIVE_RUN_STATES.has(state)) return "active";
  // 接收失败待重收：接收者仍会写检查凭据与 state，按活动处理。
  if (state === "failed" && reason.startsWith("acceptance_")) return "active";
  return "settled";
}

function runtimeEntries(root: string, ownRunId: string, out: Record<string, string>): Record<string, RunClass> {
  const runtime = join(root, ".knit", ".runtime");
  for (const name of ["installation.json", "init-manifest.json"]) out[`${RUNTIME_PREFIX}${name}`] = contentFact(join(runtime, name));
  for (const area of ["checks", "completions", "implementations"]) {
    for (const rel of walkFiles(join(runtime, area))) out[`${RUNTIME_PREFIX}${area}/${rel}`] = contentFact(join(runtime, area, rel));
  }
  const runs: Record<string, RunClass> = {};
  const runsDir = join(runtime, "runs");
  let names: string[] = [];
  try {
    names = readdirSync(runsDir);
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    if (name === ownRunId) continue;
    const runDir = join(runsDir, name);
    let isDir = false;
    try {
      isDir = lstatSync(runDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      runs[name] = "settled";
      out[`${RUNTIME_PREFIX}runs/${name}`] = contentFact(runDir);
      continue;
    }
    const kind = classifyRun(runDir);
    runs[name] = kind;
    if (kind === "active") continue;
    for (const file of SETTLED_RUN_FILES) out[`${RUNTIME_PREFIX}runs/${name}/${file}`] = statFact(join(runDir, file));
    for (const rel of walkFiles(join(runDir, "snapshot"))) {
      out[`${RUNTIME_PREFIX}runs/${name}/snapshot/${rel}`] = statFact(join(runDir, "snapshot", rel));
    }
  }
  return runs;
}

function protectedScan(context: BoundaryContext, git: GitRunner): ProtectedScan {
  const entries: Record<string, string> = {};
  gitAreaEntries(commonGitDir(context.executionDir, git), entries);
  const runs = runtimeEntries(context.root, context.runId, entries);
  return { entries, runs };
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * 敏感区前后差。并发的合法 Knit 写入按占用归属排除：
 * - 其它活动 run 的目录由其自身 worker 写；它们新建的检查凭据由其接收写入；
 * - 主检出项目占用保护的写入（新 run 目录、其它任务的完成／实施凭据）在本 run 持有该占用时不可能并发发生，
 *   本 run 在 worktree 执行（未持主检出占用）时才视为主会话的并发写入而排除。
 * 本 run 自有目录、会话目录与列表缓存不在扫描范围内。
 */
function protectedChanges(before: ProtectedScan, after: ProtectedScan, context: BoundaryContext): string[] {
  const mainLockHeld = sameDir(context.executionDir, context.root);
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    if (before.entries[key] === after.entries[key]) continue;
    if (key.startsWith(`${RUNTIME_PREFIX}runs/`)) {
      const runId = key.slice(`${RUNTIME_PREFIX}runs/`.length).split("/")[0] ?? "";
      const kind = before.runs[runId];
      if (kind === "active") continue;
      if (kind === undefined && !mainLockHeld) continue;
      if (kind === "settled" && !mainLockHeld && after.runs[runId] === undefined) continue;
      changed.push(key);
      continue;
    }
    if (key.startsWith(`${RUNTIME_PREFIX}checks/`)) {
      if (before.entries[key] === undefined) {
        const name = key.slice(`${RUNTIME_PREFIX}checks/`.length);
        const runId = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
        if (before.runs[runId] === "active") continue;
        if (before.runs[runId] === undefined && after.runs[runId] !== undefined && !mainLockHeld) continue;
      }
      changed.push(key);
      continue;
    }
    const taskFile = /^\.knit\/\.runtime\/(?:completions|implementations)\/([^/]+)\.json$/.exec(key);
    if (taskFile !== null && taskFile[1] !== context.taskId && !mainLockHeld) continue;
    changed.push(key);
  }
  return changed;
}

function ignoredSummary(context: BoundaryContext, git: GitRunner): Record<string, string> {
  const result = git(["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal"], context.executionDir);
  if (result.code !== 0) return {};
  const exclusions = (context.ignoredExclusions ?? [])
    .map((path) => relative(context.executionDir, path).split(sep).join("/"))
    .filter((path) => path !== "" && !path.startsWith(".."));
  const out: Record<string, string> = {};
  for (const record of result.stdout.split("\0")) {
    if (!record.startsWith("!! ")) continue;
    const path = record.slice(3);
    const bare = path.replace(/\/$/, "");
    if (bare === ".knit/.runtime" || bare.startsWith(".knit/.runtime/")) continue;
    if (bare === ".knit/worktrees" || bare.startsWith(".knit/worktrees/")) continue;
    if (exclusions.some((excluded) => bare === excluded || bare.startsWith(`${excluded}/`) || excluded.startsWith(`${bare}/`))) continue;
    out[path] = directoryLevelFact(join(context.executionDir, bare));
  }
  return out;
}

/**
 * 忽略区目录级指纹：条目自身 stat，目录再加直接子项（名称＋stat）摘要。
 * 新增／删除直接子项与替换文件可见；深层文件原地改写不保证可见（不做整目录内容指纹）。
 */
function directoryLevelFact(path: string): string {
  const own = statFact(path);
  if (!own.startsWith("dir:")) return own;
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch {
    return own;
  }
  const children = names.map((name) => `${name}\u0000${statFact(join(path, name))}`).join("\n");
  return `${own}:${sha256Text(children)}`;
}

function diffIgnored(before: Record<string, string>, after: Record<string, string>): IgnoredChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: IgnoredChange[] = [];
  for (const path of [...keys].sort()) {
    const a = before[path];
    const b = after[path];
    if (a === b) continue;
    changes.push({ path, change: a === undefined ? "added" : b === undefined ? "removed" : "modified" });
  }
  return changes;
}

/** 基线提交以来工作区与提交树不同的跟踪路径；阶段内提交过的路径也据此进入实际差异。 */
function pathsSinceBase(dir: string, base: string | null, git: GitRunner): string[] {
  if (base === null) return [];
  const result = git(["diff", "--name-only", "-z", "--no-renames", base, "--"], dir);
  if (result.code !== 0) return [];
  return result.stdout.split("\0").filter((path) => path !== "");
}

/** 记录阶段基线；工作区签名不可得时返回 null（调用方按 worktree_unknown 失败）。 */
export function captureStageBaseline(context: BoundaryContext, now: () => Date = () => new Date()): StageBaseline | null {
  const git = context.git ?? gitSync;
  const worktree = worktreeSignature(context.executionDir, git);
  if (worktree === null) return null;
  return {
    summary: {
      head: headOf(context.executionDir, git),
      symbolicRef: symbolicRefOf(context.executionDir, git),
      indexDigest: indexDigestOf(context.executionDir, git),
      worktreeDigest: worktree.digest,
      capturedAt: now().toISOString(),
    },
    worktree,
    protectedScan: protectedScan(context, git),
    ignored: ignoredSummary(context, git),
  };
}

export interface StageBoundaryInspection {
  /** 收尾工作区签名：基线脏路径、当前 Git 可见改动与基线提交以来的改动路径。 */
  worktree: WorktreeSignature | null;
  facts: StageBoundaryFacts;
  ignoredChanges: IgnoredChange[];
}

/** 收尾核对：同一规则再取一次事实，与基线比较。 */
export function inspectStageBoundary(baseline: StageBaseline, context: BoundaryContext): StageBoundaryInspection {
  const git = context.git ?? gitSync;
  const dir = context.executionDir;
  const head = headOf(dir, git);
  const headMoved = head !== baseline.summary.head;
  let commits: string[] = [];
  if (headMoved && head !== null) {
    const range = baseline.summary.head === null ? [head] : [`${baseline.summary.head}..${head}`];
    const listed = git(["rev-list", ...range], dir);
    if (listed.code === 0) commits = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  }
  const indexDigest = indexDigestOf(dir, git);
  const extra = [...Object.keys(baseline.worktree.entries), ...pathsSinceBase(dir, baseline.summary.head, git)];
  const worktree = worktreeSignature(dir, git, extra);
  return {
    worktree,
    facts: {
      head,
      symbolicRef: symbolicRefOf(dir, git),
      headMoved,
      commits,
      indexDigest,
      indexChanged: indexDigest !== baseline.summary.indexDigest,
      protectedPaths: protectedChanges(baseline.protectedScan, protectedScan(context, git), context),
    },
    ignoredChanges: diffIgnored(baseline.ignored, ignoredSummary(context, git)),
  };
}

/** `protected_runtime_modified:<paths>`；路径过多时截断并注明总数。 */
export function protectedRuntimeReason(paths: string[]): string {
  const shown = paths.slice(0, REASON_PATH_LIMIT);
  const suffix = paths.length > shown.length ? `,…(+${paths.length - shown.length})` : "";
  return `protected_runtime_modified:${shown.join(",")}${suffix}`;
}

/** 项目内锁根等需要排除的绝对路径；不存在的路径不参与。 */
export function existingPaths(paths: Array<string | null | undefined>): string[] {
  return paths.filter((path): path is string => typeof path === "string" && path !== "" && existsSync(path));
}
