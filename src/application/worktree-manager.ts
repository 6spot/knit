/**
 * knit worktree 命令核心（任务 k-248eafc8fb31；WORKTREE.md 第6.1/6.2/6.6节）。
 * create 从主检出当前已提交 HEAD 建立 `git worktree add -b`，保证 `.knit/worktrees/`
 * 忽略规则生效，binding.worktree 落库；connect 核实既有目录后登记同一结构。
 * binding 的 relativePath／branch 主字段仍指主检出，本模块不改任务 frontmatter。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GuardError } from "./guard-error.js";
import { hashKey, normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync } from "../infrastructure/process.js";
import { porcelainStatusPaths } from "./git-status.js";
import { atomicWrite } from "../infrastructure/atomic.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { locateTaskDocument, TaskGuardError } from "./task-service.js";

/** 项目内布局容器（相对项目根）；忽略规则由 create 前置保证。 */
export const PROJECT_WORKTREES_DIR = join(".knit", "worktrees");
const WORKTREE_DATE = /^(?:\d{2}-\d{2})-/;

export type WorktreeLayout = "project" | "global";

export interface WorktreeInfo {
  layout: WorktreeLayout;
  /** 项目内布局为项目内绝对路径；全局布局为本机绝对位置。 */
  path: string;
  /** 项目内布局的 relativePath 线索（相对项目根）。 */
  relativePath?: string;
  branch: string;
  /** 创建时主检出的已提交基线。 */
  baseline: string;
  createdAt: string;
  registeredAt: string;
  /** 项目／worktree 移动后最近一次成功修复时间（任务 k-d10f8d4c2833）；旧记录缺省。 */
  repairedAt?: string | null;
  /** 最近一次成功修复的操作 ID；旧记录缺省。 */
  lastRepairOp?: string | null;
}

export interface WorktreeCreateResult {
  taskId: string;
  /** true 为本次执行 git worktree add；false 为幂等命中既有登记。 */
  created: boolean;
  /** true 为本次写入 binding.worktree；false 为登记已存在且核实一致。 */
  registered: boolean;
  worktree: WorktreeInfo;
  /** 本次确保忽略规则生效的改动；null 表示全局布局或规则已生效。 */
  gitignore: { updated: boolean; file: string } | null;
  /** 占用命名时加的短序号说明；null 表示首次命名。 */
  naming: { requested: string; used: string; sequence: number } | null;
}

export interface WorktreeConnectResult {
  taskId: string;
  created: false;
  /** true 为本次写入 binding.worktree；false 为登记已存在且核实一致。 */
  registered: boolean;
  worktree: WorktreeInfo;
}

/** -b 接受 refs/heads/ 前缀会双重嵌套（本机 Git 实测），add 前转为短名。 */
function shortBranchName(branch: string): string {
  if (!branch.startsWith("refs/heads/")) {
    throw new TaskGuardError("invalid_branch", `worktree 分支必须是完整 refs/heads/...: ${branch}`);
  }
  return branch.slice("refs/heads/".length);
}

/** slug 取任务目录名去掉 MM-DD 日期前缀。 */
export function worktreeSlugOf(taskDirName: string): string {
  const stripped = taskDirName.replace(WORKTREE_DATE, "");
  return stripped.length > 0 ? stripped : "task";
}

/** 名称被占用时加短序号 -2/-3…；路径与分支用同一确定名。 */
export function withSequence(base: string, taken: Iterable<string>): { name: string; sequence: number } {
  const used = new Set(taken);
  if (!used.has(base)) return { name: base, sequence: 1 };
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return { name: candidate, sequence: n };
  }
}

/** project-key = 主目录 basename + 项目根绝对路径 8 位 hash（WORKTREE.md 6.2）。 */
export function projectKeyOf(root: string): string {
  return `${basename(root)}-${hashKey(root).slice(0, 8)}`;
}

/** 全局备用根 ~/.knit/worktrees/<project-key>/。 */
export function globalWorktreeRoot(root: string): string {
  return join(homedir(), ".knit", "worktrees", projectKeyOf(root));
}

/** porcelain 输出 → 条目列表；bare／detached 条目 branch 为 null。 */
export function parseWorktreeList(porcelain: string): Array<{ path: string; branch: string | null; head: string | null }> {
  const entries: Array<{ path: string; branch: string | null; head: string | null }> = [];
  let current: { path: string; branch: string | null; head: string | null } | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null };
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

function worktreeList(root: string): Array<{ path: string; branch: string | null; head: string | null }> {
  const result = gitSync(["worktree", "list", "--porcelain"], root);
  if (result.code !== 0) {
    throw new GuardError("git_failed", `git worktree list 失败: ${result.stderr.trim() || "无输出"}`);
  }
  return parseWorktreeList(result.stdout);
}

/** 目标是否位于项目根内（路径别名与符号链接逃逸不视为项目内）。 */
function pathInsideRoot(root: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(root, resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 当前主检出分支；detached 时 null。 */
function mainCheckoutBranch(root: string): string | null {
  const result = gitSync(["symbolic-ref", "-q", "HEAD"], root);
  if (result.code !== 0 || result.stdout.trim() === "") return null;
  return result.stdout.trim();
}

/** 已提交基线：主检出当前 HEAD；不可读时拒绝（不冒充基线）。 */
function mainCheckoutHead(root: string): string {
  const result = gitSync(["rev-parse", "--verify", "HEAD"], root);
  if (result.code !== 0) {
    throw new TaskGuardError("git_head_required", "主检出无可读 HEAD，无法确定 worktree 基线");
  }
  return result.stdout.trim();
}

/**
 * 主检出中当前任务目录之外的未提交／未跟踪改动（ignored 内容不由 status 报告）。
 * 自动创建与手动 create 的脏守卫共用；任务目录本身由 handoff 带走，不计入。
 */
export function dirtyOutsideTask(
  root: string,
  taskDir: string,
  excluded: string[] = [],
): { entries: number; sample: string[] } {
  const result = gitSync(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  if (result.code !== 0) {
    throw new GuardError("git_failed", `读取主检出工作区状态失败: ${result.stderr.trim() || "无输出"}`);
  }
  const taskRelative = relative(root, taskDir).split(sep).join("/");
  const normalized = excluded.map((path) => path.split(sep).join("/").replace(/\/$/, ""));
  const inside = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
  const paths = porcelainStatusPaths(result.stdout)
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path !== taskRelative && !path.startsWith(`${taskRelative}/`))
    // Knit 运行资料、锁与其它关联 worktree 不是业务源码；自动守卫只拦用户改动。
    .filter((path) => !normalized.some((prefix) => prefix !== "" && inside(path, prefix)));
  return { entries: paths.length, sample: paths.slice(0, 8) };
}

/** create 前置：Git 工作区、可读已提交 HEAD、本地分支（基线与忽略规则都依赖主检出）。 */
function assertGitWorktreeEnvironment(root: string): void {
  const inside = gitSync(["rev-parse", "--is-inside-work-tree"], root);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new TaskGuardError("git_required", "worktree 管理需要 Git 工作区");
  }
  mainCheckoutHead(root);
  if (mainCheckoutBranch(root) === null) {
    throw new TaskGuardError("detached_head", "主检出处于 detached HEAD，不能确定 worktree 基线分支");
  }
}

/** 根 .gitignore 与 .knit/.gitignore 是否已有匹配 `.knit/worktrees/` 的规则。 */
export function worktreesIgnored(root: string): boolean {
  return gitSync(["check-ignore", "-q", "--", `${PROJECT_WORKTREES_DIR}/probe/`], root).code === 0;
}

/**
 * 保证 `.knit/worktrees/` 忽略规则生效：已生效时不动任何文件；无匹配规则时
 * 在根 .gitignore 追加一行（缺文件则创建），保留现有规则。
 */
export function ensureWorktreesIgnored(root: string): { updated: boolean; file: string } {
  if (worktreesIgnored(root)) return { updated: false, file: join(root, ".gitignore") };
  const target = join(root, ".gitignore");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
  const content = existing === null || existing.trim() === ""
    ? `/${PROJECT_WORKTREES_DIR}/\n`
    : `${existing.replace(/\n*$/, "\n")}/${PROJECT_WORKTREES_DIR}/\n`;
  // 空文件按缺文件内容处理；已有内容按当前版本追加（原子写核对版本，不覆盖后来输入）。
  atomicWrite({
    path: target,
    data: Buffer.from(content, "utf8"),
    expectedSha256: existing === null ? null : sha256Text(existing),
    mode: 0o644,
  });
  if (!worktreesIgnored(root)) {
    throw new GuardError("gitignore_rule_unavailable", `已写入 ${target} 但 .knit/worktrees/ 仍不被忽略，请检查 Git 忽略配置`);
  }
  return { updated: true, file: target };
}

/** directory 项数；不可读按非空处理（保留现场，不冒充空目录）。 */
function hasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return true;
  }
}

/** 显式 --path 的越界与占用核对；项目内目标经符号链接逃逸拒绝，项目外按全局位置允许。 */
function assertPathAvailable(root: string, path: string): string {
  const target = resolve(path);
  if (target === root) {
    throw new TaskGuardError("path_occupied", `目标路径是项目根本身: ${target}`);
  }
  if (pathInsideRoot(root, target)) {
    // safeJoin 拒绝经父级符号链接逃出项目；返回值与预期不一致即存在逃逸。
    const normalized = safeJoin(root, relative(root, target));
    if (normalized !== target) {
      throw new TaskGuardError("path_escape", `目标路径经符号链接越界: ${target}`);
    }
  }
  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw new TaskGuardError("path_occupied", `目标路径已是文件: ${target}`);
  }
  return target;
}

/** 分支已被其它 worktree 检出时返回占用路径；targetPath 为 null 时仅查其它路径。 */
function branchOccupiedBy(root: string, branch: string, targetPath: string | null): string | null {
  for (const entry of worktreeList(root)) {
    if (entry.branch !== branch) continue;
    if (targetPath === null || resolve(entry.path) !== resolve(targetPath)) return entry.path;
  }
  return null;
}

/** binding.worktree 幂等核实：路径存在、porcelain 登记且分支可解析到基线或其后代（prepare 复用同语义）。 */
export function verifyRegisteredWorktree(root: string, info: WorktreeInfo): { ok: boolean; problem: string | null } {
  if (!existsSync(info.path) || !statSync(info.path).isDirectory()) {
    return { ok: false, problem: `登记路径缺失: ${info.path}` };
  }
  const entry = worktreeList(root).find((candidate) => resolve(candidate.path) === resolve(info.path));
  if (entry === undefined) {
    return { ok: false, problem: `登记路径未在 git worktree list 中: ${info.path}` };
  }
  if (entry.branch !== info.branch) {
    return { ok: false, problem: `登记分支不符: 期望 ${info.branch}，实际 ${entry.branch ?? "（detached）"}` };
  }
  if (gitSync(["merge-base", "--is-ancestor", info.baseline, info.branch], root).code !== 0) {
    return { ok: false, problem: `登记分支 ${info.branch} 不在基线 ${info.baseline} 或其后代` };
  }
  return { ok: true, problem: null };
}

/** connect 核实：porcelain 含该路径、仓库归属本项目、分支为 refs/heads/…。 */
function verifyConnectTarget(root: string, target: string): { branch: string; head: string } {
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new TaskGuardError("path_occupied", `目标目录不存在或不是目录: ${target}`);
  }
  const inside = gitSync(["rev-parse", "--show-toplevel"], target);
  if (inside.code !== 0) {
    throw new TaskGuardError("repo_mismatch", `目标目录不是 Git 工作区: ${target}`);
  }
  const toplevel = resolve(inside.stdout.trim());
  if (toplevel !== resolve(target)) {
    throw new TaskGuardError("path_occupied", `目标目录不是 worktree 根: ${target}（实际 ${toplevel}）`);
  }
  const entry = worktreeList(root).find((candidate) => resolve(candidate.path) === resolve(target));
  if (entry === undefined) {
    throw new TaskGuardError("repo_mismatch", `目录未在主仓库 git worktree list 中登记: ${target}`);
  }
  if (entry.branch === null || !entry.branch.startsWith("refs/heads/")) {
    throw new TaskGuardError("branch_mismatch", `worktree 未绑定本地分支: ${entry.branch ?? "（detached）"}`);
  }
  const head = gitSync(["rev-parse", "--verify", entry.branch], root);
  if (head.code !== 0) {
    throw new TaskGuardError("branch_mismatch", `分支不可解析: ${entry.branch}`);
  }
  return { branch: entry.branch, head: head.stdout.trim() };
}

/** project 布局容器可用：位于本地可写目录（远程／云同步根改用全局布局）。 */
function projectContainerUsable(root: string): boolean {
  const container = join(root, PROJECT_WORKTREES_DIR);
  if (existsSync(container)) return statSync(container).isDirectory();
  return existsSync(root) && statSync(root).isDirectory();
}

/** 容器内已占用的 worktree 目录名（命名占用判定来源）。 */
function takenWorktreeNames(container: string): string[] {
  if (!existsSync(container)) return [];
  try {
    return readdirSync(container, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export interface WorktreeServiceOptions {
  store: MetadataStore;
  locks?: LockManager;
  /** 测试注入时钟。 */
  now?: () => Date;
}

export class WorktreeService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;

  constructor(options: WorktreeServiceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
  }

  /** 已归档任务拒绝；活动 run 不阻塞（不影响主目录执行）。 */
  private locateOpenTask(root: string, taskId: string): { dirName: string; taskDir: string } {
    const located = locateTaskDocument(root, taskId);
    if (located.archived) {
      throw new TaskGuardError("task_archived", `任务已归档: ${taskId}`);
    }
    return { dirName: basename(located.dir), taskDir: located.dir };
  }

  private taskLockKey(root: string, taskId: string) {
    return { scope: "task" as const, rawKey: `${root}::${taskId}` };
  }

  private async withTaskLock<T>(root: string, taskId: string, action: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, taskId)]),
      action,
    });
    try {
      return await fn();
    } finally {
      this.locks.release(lock);
    }
  }

  private async requireBinding(taskId: string): Promise<TaskBinding> {
    const binding = await this.store.bindings.get(taskId);
    if (binding === null) {
      throw new TaskGuardError("unknown_binding", `任务缺少绑定: ${taskId}`);
    }
    return binding;
  }

  /**
   * create：主检出当前已提交 HEAD 建立新 worktree，忽略规则先行，binding.worktree 落库。
   * 幂等：已登记且核实一致直接返回；失败保留目录与分支并报告实际效果。
   */
  async create(input: {
    dir: string;
    taskId: string;
    path?: string;
    branch?: string;
    global?: boolean;
    /** 手动显式覆盖主检出脏守卫；自动创建路径永不传 true。 */
    allowDirty?: boolean;
    /** 用户入口启用脏守卫；内部服务调用缺省不拦截（测试夹具可保留未提交资料）。 */
    guardDirty?: boolean;
  }): Promise<WorktreeCreateResult> {
    const root = normalizeRoot(input.dir);
    const now = this.now();
    const { dirName, taskDir } = this.locateOpenTask(root, input.taskId);
    assertGitWorktreeEnvironment(root);
    const baseline = mainCheckoutHead(root);
    return await this.withTaskLock(root, input.taskId, "worktree.create", async () => {
      const binding = await this.requireBinding(input.taskId);
      const registered = binding.worktree ?? null;
      if (registered !== null) {
        const verdict = verifyRegisteredWorktree(root, registered);
        if (verdict.ok) {
          return { taskId: input.taskId, created: false, registered: false, worktree: registered, gitignore: null, naming: null };
        }
        throw new TaskGuardError("worktree_mismatch", `已登记 worktree 与现场不符，先 connect 或清理现场: ${verdict.problem ?? ""}`);
      }

      const datePrefix = dirName.match(/^(\d{2})-(\d{2})-/);
      const mm = datePrefix?.[1] ?? String(now.getMonth() + 1).padStart(2, "0");
      const dd = datePrefix?.[2] ?? String(now.getDate()).padStart(2, "0");
      const slug = worktreeSlugOf(dirName);
      const useGlobal = input.global === true || !projectContainerUsable(root);
      const layout: WorktreeLayout = useGlobal ? "global" : "project";
      const container = useGlobal ? globalWorktreeRoot(root) : join(root, PROJECT_WORKTREES_DIR);

      let targetPath: string;
      let branch: string;
      let naming: WorktreeCreateResult["naming"] = null;
      if (input.path !== undefined || input.branch !== undefined) {
        targetPath = assertPathAvailable(root, input.path !== undefined ? resolve(input.path) : join(container, `${mm}-${dd}-${slug}`));
        branch = input.branch ?? `refs/heads/knit/${mm}-${dd}-${slug}`;
      } else {
        // 断点恢复优先：分支按目录名派生，porcelain 中该分支登记在预期默认路径时
        // 属本任务（任务目录名唯一），先前 add 成功但 binding 未写入时接续登记。
        const baseName = `${mm}-${dd}-${slug}`;
        const expectedPath = join(container, baseName);
        const crashed = branchOccupiedBy(root, `refs/heads/knit/${baseName}`, null);
        if (crashed !== null && resolve(crashed) === resolve(expectedPath)) {
          targetPath = crashed;
          branch = `refs/heads/knit/${baseName}`;
        } else {
          const { name, sequence } = withSequence(baseName, takenWorktreeNames(container));
          targetPath = join(container, name);
          branch = `refs/heads/knit/${name}`;
          if (sequence > 1) naming = { requested: baseName, used: name, sequence };
        }
      }
      if (!branch.startsWith("refs/heads/")) {
        throw new TaskGuardError("invalid_branch", `worktree 分支必须是完整 refs/heads/...: ${branch}`);
      }

      const occupied = branchOccupiedBy(root, branch, targetPath);
      if (occupied !== null) {
        throw new TaskGuardError("git_occupied", `分支 ${branch} 已被其它 worktree 检出: ${occupied}`);
      }
      // 断点恢复：路径已存在且已 porcelain 登记（先前 add 成功但 binding 未写入）
      // → 按 connect 语义核实后登记，不重建；非空且未登记才是占用。
      if (existsSync(targetPath) && hasEntries(targetPath)) {
        const recovered = verifyConnectTarget(root, targetPath);
        if (recovered.branch !== branch) {
          throw new TaskGuardError("branch_mismatch", `目标目录已登记为其它分支: ${recovered.branch} ≠ ${branch}`);
        }
        const info: WorktreeInfo = {
          layout,
          path: targetPath,
          branch,
          baseline,
          createdAt: now.toISOString(),
          registeredAt: now.toISOString(),
        };
        if (layout === "project") info.relativePath = relative(root, targetPath);
        await this.saveWorktreeBinding(input.taskId, info);
        return { taskId: input.taskId, created: false, registered: true, worktree: info, gitignore: null, naming };
      }
      // 自动与手动创建共用脏守卫：任务资料之外的未提交内容不会被搬运，先阻断并列出路径。
      // Knit 运行资料、锁、任务目录与其它关联 worktree 是内部数据，不计入业务脏改动。
      if (input.guardDirty === true && input.allowDirty !== true) {
        const excluded = [join(".knit", ".runtime"), join(".knit", "tasks"), join(".knit", ".gitignore"), PROJECT_WORKTREES_DIR];
        const locksRoot = relative(root, resolve(this.locks.rootPath));
        if (locksRoot !== "" && !locksRoot.startsWith("..") && !isAbsolute(locksRoot)) excluded.push(locksRoot);
        for (const entry of worktreeList(root)) {
          const rel = relative(root, resolve(entry.path));
          if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) excluded.push(rel);
        }
        const dirty = dirtyOutsideTask(root, taskDir, excluded);
        if (dirty.entries > 0) {
          throw new TaskGuardError(
            "worktree_dirty_source",
            `主检出在任务目录之外有 ${dirty.entries} 项未提交／未跟踪改动，停止创建 worktree：${dirty.sample.join(", ")}` +
              `${dirty.entries > dirty.sample.length ? " …" : ""}；先提交、stash，或显式 worktree create --allow-dirty`,
          );
        }
      }
      const gitignore = layout === "project" ? ensureWorktreesIgnored(root) : null;
      const add = gitSync(["worktree", "add", "-b", shortBranchName(branch), targetPath, baseline], root);
      if (add.code !== 0) {
        throw new GuardError("git_failed", `git worktree add 失败: ${add.stderr.trim() || add.stdout.trim() || "无输出"}`);
      }
      const info: WorktreeInfo = {
        layout,
        path: targetPath,
        branch,
        baseline,
        createdAt: now.toISOString(),
        registeredAt: now.toISOString(),
      };
      if (layout === "project") info.relativePath = relative(root, targetPath);
      await this.saveWorktreeBinding(input.taskId, info);
      return { taskId: input.taskId, created: true, registered: true, worktree: info, gitignore, naming };
    });
  }

  /** connect：核对已有目录后登记 binding.worktree；不产生 Git 提交、不改主检出。 */
  async connect(input: { dir: string; taskId: string; path: string }): Promise<WorktreeConnectResult> {
    const root = normalizeRoot(input.dir);
    const now = this.now();
    this.locateOpenTask(root, input.taskId);
    const target = resolve(input.path);
    return await this.withTaskLock(root, input.taskId, "worktree.connect", async () => {
      const binding = await this.requireBinding(input.taskId);
      const registered = binding.worktree ?? null;
      if (registered !== null && resolve(registered.path) !== target) {
        throw new TaskGuardError("worktree_mismatch", `任务已登记其它 worktree: ${registered.path}`);
      }
      const verified = verifyConnectTarget(root, target);
      if (registered !== null) {
        if (registered.branch !== verified.branch) {
          throw new TaskGuardError("branch_mismatch", `登记分支不符: 期望 ${registered.branch}，实际 ${verified.branch}`);
        }
        return { taskId: input.taskId, created: false as const, registered: false, worktree: registered };
      }
      const info: WorktreeInfo = {
        layout: pathInsideRoot(root, target) ? "project" : "global",
        path: target,
        branch: verified.branch,
        baseline: verified.head,
        createdAt: now.toISOString(),
        registeredAt: now.toISOString(),
      };
      if (info.layout === "project") info.relativePath = relative(root, target);
      await this.saveWorktreeBinding(input.taskId, info);
      return { taskId: input.taskId, created: false as const, registered: true, worktree: info };
    });
  }

  /** 锁内重读 binding 后整体保存 worktree 登记；元数据故障如实上抛，不写半份绑定。 */
  private async saveWorktreeBinding(taskId: string, info: WorktreeInfo): Promise<void> {
    const current = await this.requireBinding(taskId);
    const next: TaskBinding = { ...current, worktree: info };
    await this.store.bindings.save(next);
  }
}
