/**
 * 工作区路由（任务 k-1910551e4f50；WORKTREE.md §6.3、DESIGN.md §3.5/§9.4）。
 *
 * 根模型：`mainRoot` 是主检出，`.knit/` 元数据库、run 产物、锁与 pi-sessions 的唯一位置；
 * `executionDir` 是任务实际执行目录（worktree 生效时为 worktree 路径，否则等于 mainRoot）。
 * 任务资料以 executionDir 为准；worktree 内不产生 `.knit/.runtime`。
 *
 * 目录或分支异常一律报告 invalid 并给出具体原因，绝不静默回退主检出。
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeRoot } from "../infrastructure/paths.js";
import { gitSync } from "../infrastructure/process.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { GuardError } from "./guard-error.js";
import { parseWorktreeList, type WorktreeInfo, type WorktreeLayout } from "./worktree-manager.js";

/** 解析起点：主检出与当前检出；非 Git 目录两者相同（按 normalizeRoot 原样处理）。 */
export interface ProjectStart {
  /** 主检出：`.knit/` 元数据库、run 产物、锁与 pi-sessions 的唯一位置。 */
  mainRoot: string;
  /** 当前检出根；绑定 worktree 生效时即任务执行目录。 */
  executionDir: string;
  /** true 表示起点位于关联 worktree（--git-dir 与 --git-common-dir 不同）。 */
  linkedWorktree: boolean;
}

/** 执行路由状态：main=主检出；worktree=已交接的 worktree；invalid=登记异常，不回退。 */
export type ExecutionRouteState = "main" | "worktree" | "invalid";

export interface ExecutionRoute {
  state: ExecutionRouteState;
  /** 期望执行目录：main=主检出；worktree/invalid=登记路径（invalid 时供诊断）。 */
  dir: string;
  /** 期望分支：main=binding.branch；worktree/invalid=binding.worktree.branch。 */
  branch: string | null;
  layout: "main" | WorktreeLayout;
  /** 公共资料与环境准备完成（worktree.preparedAt 非空）。 */
  prepared: boolean;
  /** 任务资料已交接、绑定切换为 worktree（worktree.active）。 */
  active: boolean;
  /** invalid 的具体原因；其余为 null。 */
  problem: string | null;
}

interface GitPathResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `git rev-parse` 输出解析：相对路径按调用目录解析（Git 的 cwd 语义）。 */
function revParse(startDir: string, args: string[]): string | null {
  const result: GitPathResult = gitSync(args, startDir);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  if (value === "") return null;
  return isAbsolute(value) ? resolve(value) : resolve(startDir, value);
}

/**
 * 解析起点：`--show-toplevel` 给当前检出根，`--git-common-dir` 给公共 Git 目录。
 * 关联 worktree 的 `--git-dir` 指向 `<main>/.git/worktrees/<name>` 且与 common 不同，
 * 此时 mainRoot=dirname(commonDir)、executionDir=toplevel；主检出与子模块的 gitdir
 * 等于 commonDir，按同一目录处理（避免把子模块误判为 worktree）。
 */
export function resolveProjectStart(startDir: string): ProjectStart {
  const base = normalizeRoot(startDir);
  const top = revParse(base, ["rev-parse", "--show-toplevel"]);
  if (top === null) return { mainRoot: base, executionDir: base, linkedWorktree: false };
  const gitDir = revParse(base, ["rev-parse", "--git-dir"]);
  const commonDir = revParse(base, ["rev-parse", "--git-common-dir"]);
  if (gitDir === null || commonDir === null || resolve(gitDir) === resolve(commonDir)) {
    return { mainRoot: top, executionDir: top, linkedWorktree: false };
  }
  return { mainRoot: dirname(commonDir), executionDir: top, linkedWorktree: true };
}

/** 主检出视图：元数据库、RunStore、锁与 pi-sessions 的根。 */
export function mainRootOf(startDir: string): string {
  return resolveProjectStart(startDir).mainRoot;
}

function listWorktrees(mainRoot: string): {
  ok: boolean;
  entries: Array<{ path: string; branch: string | null; head: string | null }>;
  problem: string | null;
} {
  const result = gitSync(["worktree", "list", "--porcelain"], mainRoot);
  if (result.code !== 0) {
    return {
      ok: false,
      entries: [],
      problem: `git worktree list 失败: ${result.stderr.trim() || "无输出"}`,
    };
  }
  return { ok: true, entries: parseWorktreeList(result.stdout), problem: null };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 核实登记：目录存在、在 `git worktree list --porcelain` 中、分支相符、归属当前主检出。
 * 只报告事实，不修改现场；问题文本直接进入 invalid 原因。
 */
export function verifyWorktreeRegistration(
  mainRoot: string,
  info: Pick<WorktreeInfo, "path" | "branch">,
): { ok: boolean; problem: string | null } {
  const root = normalizeRoot(mainRoot);
  if (!existsSync(info.path) || !isDirectory(info.path)) {
    return { ok: false, problem: `登记路径缺失: ${info.path}` };
  }
  const list = listWorktrees(root);
  if (!list.ok) return { ok: false, problem: list.problem };
  const entry = list.entries.find((candidate) => resolve(candidate.path) === resolve(info.path));
  if (entry === undefined) {
    return { ok: false, problem: `登记路径未在 git worktree list 中: ${info.path}` };
  }
  if (entry.branch !== info.branch) {
    return {
      ok: false,
      problem: `登记分支不符: 期望 ${info.branch}，实际 ${entry.branch ?? "（detached）"}`,
    };
  }
  const start = resolveProjectStart(info.path);
  if (!start.linkedWorktree || resolve(start.mainRoot) !== resolve(root)) {
    return { ok: false, problem: `worktree 归属不符: ${info.path} 不属于 ${root}` };
  }
  return { ok: true, problem: null };
}

/** worktree 准备状态：preparedAt 为非空时间戳即视为当前（与 worktree prepare 前置检查同口径）。 */
function preparedOf(binding: TaskBinding): boolean {
  const preparedAt = binding.worktree?.preparedAt;
  return typeof preparedAt === "string" && preparedAt !== "";
}

/**
 * 任务执行路由：绑定 worktree 已交接（active）时以 worktree 为执行目录并核实现场；
 * 否则在主检出执行。invalid 携带具体 problem，调用方不得回退主检出。
 */
export function executionRouteOf(binding: TaskBinding | null, mainRoot: string): ExecutionRoute {
  const root = normalizeRoot(mainRoot);
  const info = binding?.worktree;
  if (binding === null || info === undefined || info.active !== true) {
    return {
      state: "main",
      dir: root,
      branch: binding?.branch ?? null,
      layout: "main",
      prepared: false,
      active: false,
      problem: null,
    };
  }
  const prepared = preparedOf(binding);
  const verdict = verifyWorktreeRegistration(root, info);
  if (!verdict.ok) {
    return {
      state: "invalid",
      dir: info.path,
      branch: info.branch,
      layout: info.layout,
      prepared,
      active: true,
      problem: verdict.problem,
    };
  }
  return {
    state: "worktree",
    dir: info.path,
    branch: info.branch,
    layout: info.layout,
    prepared,
    active: true,
    problem: null,
  };
}

/** 起点是否位于目录内（路径别名不视为项目外）。 */
function insideDir(dir: string, candidate: string): boolean {
  const rel = relative(resolve(dir), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 派发前核对：invalid 报 `worktree_invalid:<原因>`（不回退主检出）；
 * worktree 路由要求起点在该目录（否则 `execution_dir_mismatch`）且已完成 prepare
 * （否则 `worktree_not_ready`）。
 */
export function assertExecutionRoute(route: ExecutionRoute, startDir: string): void {
  if (route.state === "invalid") {
    throw new GuardError(
      "worktree_invalid",
      `worktree_invalid:${route.problem ?? "未知原因"}（登记路径 ${route.dir}）；不回退主检出，先核实现场或重新 connect`,
    );
  }
  if (route.state !== "worktree") return;
  if (!insideDir(route.dir, normalizeRoot(startDir))) {
    throw new GuardError(
      "execution_dir_mismatch",
      `execution_dir_mismatch: 任务资料与执行目录在 ${route.dir}，当前 ${startDir}；请 cd 到实际执行目录后重试`,
    );
  }
  if (!route.prepared) {
    throw new GuardError(
      "worktree_not_ready",
      `worktree_not_ready: ${route.dir} 尚未完成公共资料与环境准备；先运行 knit worktree prepare --task <taskId>`,
    );
  }
}
