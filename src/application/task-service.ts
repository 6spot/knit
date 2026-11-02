/**
 * TaskService：task new/rename/list/record/ready/update/close 核心命令（DESIGN.md 第4.1节）。
 * 文件权威：task.md（frontmatter + 输入区/记录区）；本机 binding 存 SQLite 元数据库。
 * 占用：目录改名与输入变更用项目执行占用；task record 用任务文件短占用（OPERATIONS.md 第2节）。
 * 业务裁决委托 domain/task.ts；本服务核对事实、执行 IO、写回转移结果。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import {
  inputsDigestOf,
  pendingDraftDigest,
  newTaskId,
  type UpdateKind,
} from "../contracts/task-inputs.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { onInputsUpdated, onPendingResolved, onReady, onComplete, onCloseWithOutcome, onRecordWritten, type TaskTransitionResult } from "../domain/task.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { GuardError } from "./guard-error.js";
import { formalStandardsDigest } from "./standards.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { readWithVersion, atomicWrite } from "../infrastructure/atomic.js";
import { ArgvGitPort, gitSync } from "../infrastructure/process.js";
import type { GitPort } from "../ports/infrastructure.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { parseTaskDocument, renderTaskDocument, withRegions, type TaskDocument } from "./task-document.js";
import { scanCredentials } from "../contracts/credentials.js";

const TASKS_DIR = "tasks";
const ARCHIVE_DIR = "archive";
const TASK_FILE = "task.md";

/** 目录命名：MM-DD-<slug>；重名追加短序号（DESIGN.md 第3.2节）。 */
export function taskDirectoryName(date: Date, slug: string, existingNames: Iterable<string>): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const base = `${mm}-${dd}-${slug}`;
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** task.md 初始模板（DESIGN.md 第3.3节）：输入区板块 + 固定记录区标记。 */
export function renderInitialTaskBody(title: string): { inputsBody: string; progressBody: string } {
  return {
    inputsBody: [
      "# " + title,
      "",
      "## 目标与边界",
      "",
      "<!-- 待讨论确认：目的、范围、约束与必要设计 -->",
      "",
      "## 完成条件",
      "",
      "<!-- 可验证结果与必需验收 -->",
      "",
      "## 输入引用",
      "",
      "<!-- 适用规范、设计材料、代码范围与验证入口 -->",
      "",
    ].join("\n"),
    progressBody: [
      "## 当前位置",
      "",
      "任务已创建，待讨论。",
      "",
      "## 关键经过",
      "",
      "## 结果与验证",
      "",
      "## 运行引用",
      "",
    ].join("\n"),
  };
}

export interface TaskSummary {
  taskId: string;
  title: string;
  status: string;
  phase: string;
  outcome: string | null;
  branch: string | null;
  /** 归档任务为相对 tasks/ 的目录路径；活跃任务为目录名。 */
  relativePath: string;
  archived: boolean;
}

export interface TaskListResult {
  root: string;
  active: TaskSummary[];
  archived: TaskSummary[];
}

export interface TaskNewInput {
  dir: string;
  title: string;
  slug?: string;
  branch?: string | null;
  /** 测试注入；默认本地日期。 */
  now?: Date;
}

export interface TaskNewResult {
  taskId: string;
  root: string;
  relativePath: string;
  title: string;
  branch: string | null;
}

export interface TaskRenameInput {
  dir: string;
  taskId: string;
  newSlug: string;
  /** 等价改名（纯移动）：调用方声明；不等价改名使检查 stale（STATES.md 第8节）。 */
  equivalent: boolean;
}

export interface TaskRenameResult {
  taskId: string;
  from: string;
  to: string;
  equivalent: boolean;
}

export interface TaskAdoptInput {
  dir: string;
  taskId: string;
  /** 完整 refs/heads/... 或 current（取当前本地分支）。 */
  branch: string;
}

export interface TaskAdoptResult {
  taskId: string;
  branch: string;
  previousBranch: string | null;
  adopted: boolean;
  /** 分支变化使旧检查失去交付资格时为 true；历史检查文件仍保留。 */
  checkInvalidated: boolean;
  phase: string;
}

export interface TaskRecordInput {
  dir: string;
  taskId: string;
  body: string;
}

export interface TaskRecordResult {
  taskId: string;
  saved: boolean;
  /** 封存期间明确未保存；sealed=true 时不写文件（STATES.md 第11节）。 */
  sealed?: boolean;
  reason?: string;
}

export interface TaskUpdateInput {
  dir: string;
  taskId: string;
  /** 显式声明输入更新（--kind clarify/change）。 */
  kind?: UpdateKind;
  reason: string;
  content: string;
  /** 活动 run 中只保存草案：调用方以冻结输入事实传入。 */
  runActive: boolean;
  /** 生成本更新的操作 ID（运行中保存草案时必填）；直接更新为 null。 */
  updateOperationId?: string | null;
  /** apply/withdraw 模式：--expect-pending 的草案版本摘要。 */
  expectPending?: string;
  /** 恢复等显式路径更新使用：调用前核对的 task.md 文件 SHA-256。 */
  expectTaskSha256?: string;
  /** --withdraw-pending 的撤回理由（与 expectPending 同用）。 */
  withdrawReason?: string;
  /** apply 时可选的收尾事实；注入 runActivity 时以仓储核实为准。 */
  runsSettled?: boolean;
}

export interface TaskUpdateResult {
  taskId: string;
  applied: "direct" | "pending_saved" | "pending_applied" | "pending_withdrawn";
  phase: string;
  status: string;
  outcome: string | null;
  inputsDigest: string;
  /** 摘要变化事实：应用层据此使检查 stale（STATES.md 第8节）。 */
  digestChanged: boolean;
  pendingDraftDigest: string | null;
}

export interface TaskCloseInput {
  dir: string;
  taskId: string;
  outcome: "completed" | "cancelled" | "superseded";
  /** 调用方已核实的收尾事实：无活动／未知 run、无未核实 Git 效果（STATES.md 第3节）。 */
  runsSettled: boolean;
}

export interface TaskCloseResult {
  taskId: string;
  status: string;
  outcome: string | null;
  phase: string;
  /** 关闭时撤回的未应用草案摘要；留原因记录。 */
  pendingWithdrawn: boolean;
}

export interface TaskRunActivityPort {
  /** 该任务是否存在未收敛 run（活动、未知或结果待接收）。 */
  active(root: string, taskId: string): Promise<boolean>;
  /** 是否所有 run 与验收操作均已收敛。 */
  settled(root: string, taskId: string): Promise<boolean>;
}

export interface TaskServiceOptions {
  store: MetadataStore;
  locks?: LockManager;
  git?: GitPort;
  /** 可选真实 run 仓储；CLI 注入后不信任调用方自报的 runActive/runsSettled。 */
  runActivity?: TaskRunActivityPort;
  /** 测试注入时钟。 */
  now?: () => Date;
  /** 测试注入随机源（任务 ID、操作 token）。 */
  randomHex?: (bytes: number) => string;
}

/** 领域拒绝到协议边界的稳定错误；应用层 catch 后映射 ReasonCode。 */
export class TaskGuardError extends GuardError {
  constructor(guardReason: string, message: string) {
    super(guardReason, message);
    this.name = "TaskGuardError";
  }
}

type TaskTransition = { status: "open" | "closed"; phase: "discuss" | "implement" | "check" | "deliver"; outcome: "completed" | "cancelled" | "superseded" | null };

function guardRejected(result: TaskTransitionResult, what: string): TaskTransition {
  if ("allowed" in result && result.allowed === false) {
    throw new TaskGuardError(result.reason, `${what}被拒绝: ${result.reason}`);
  }
  return result as TaskTransition;
}

/** 写入前凭据扫描：命中暂停副作用，只报告类型与位置，不回显敏感值（DESIGN §5.6，任务032）。 */
function assertNoCredentials(content: string, what: string): void {
  const hits = scanCredentials(content);
  if (hits.length === 0) return;
  const summary = hits.map((hit) => `${hit.type}@行${hit.line}`).join(", ");
  throw new TaskGuardError("credential_scan_hit", `${what}命中常见凭据模式，已暂停写入: ${summary}`);
}

/** tasks/ 根目录（受管任务资料）。 */
export function tasksRootOf(root: string): string {
  return safeJoin(join(root, ".knit"), TASKS_DIR);
}

/** 遍历活跃与归档任务目录；返回相对 tasks/ 的路径。 */
export function listTaskDirectories(root: string): { name: string; archived: boolean }[] {
  const tasksRoot = tasksRootOf(root);
  if (!existsSync(tasksRoot)) return [];
  const result: { name: string; archived: boolean }[] = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== ARCHIVE_DIR && existsSync(join(tasksRoot, entry.name, TASK_FILE))) {
      result.push({ name: entry.name, archived: false });
    }
  }
  const archiveRoot = join(tasksRoot, ARCHIVE_DIR);
  if (existsSync(archiveRoot)) {
    for (const month of readdirSync(archiveRoot, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const monthDir = join(archiveRoot, month.name);
      for (const entry of readdirSync(monthDir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(monthDir, entry.name, TASK_FILE))) {
          result.push({ name: `${ARCHIVE_DIR}/${month.name}/${entry.name}`, archived: true });
        }
      }
    }
  }
  return result;
}

/** 按稳定 ID 定位任务文档；同目录名不等于同任务，ID 以 frontmatter 为准。 */
export function locateTaskDocument(
  root: string,
  taskId: string,
): { dir: string; archived: boolean; document: TaskDocument; raw: Buffer } {
  const tasksRoot = tasksRootOf(root);
  for (const { name, archived } of listTaskDirectories(root)) {
    const dir = join(tasksRoot, name);
    const file = join(dir, TASK_FILE);
    const raw = readWithVersion(file);
    if (raw === null) continue;
    const document = parseTaskDocument(raw.data.toString("utf8"), file);
    if (document.frontmatter.id === taskId) return { dir, archived, document, raw: raw.data };
  }
  throw new InfrastructureError("io_error", `任务不存在: ${taskId}`);
}

const REMOTE_FS_TYPES = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546]);

/** 正式任务创建／ready 的 Git 与本地文件系统前置；只读查询不调用。 */
function assertFormalTaskEnvironment(root: string): void {
  try {
    if (REMOTE_FS_TYPES.has(statfsSync(root).type)) {
      throw new TaskGuardError("lock_fs_unsupported", "项目根位于已知网络／云同步文件系统，不能建立正式任务");
    }
  } catch (error) {
    if (error instanceof TaskGuardError) throw error;
    throw new TaskGuardError("lock_fs_unsupported", `无法核实项目根文件系统: ${String(error)}`);
  }
  const inside = gitSync(["rev-parse", "--is-inside-work-tree"], root);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new TaskGuardError("git_required", "正式任务需要 Git 工作区");
  if (gitSync(["rev-parse", "--verify", "HEAD"], root).code !== 0) throw new TaskGuardError("git_head_required", "正式任务需要可读 HEAD");
  if (gitSync(["symbolic-ref", "-q", "HEAD"], root).code !== 0) throw new TaskGuardError("detached_head", "正式任务需要本地分支，不能 detached HEAD");
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
    if (gitSync(["rev-parse", "-q", "--verify", marker], root).code === 0) {
      throw new TaskGuardError("git_operation_in_progress", `Git 仍有未完成操作: ${marker}`);
    }
  }
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    if (existsSync(join(root, ".git", dir))) throw new TaskGuardError("git_operation_in_progress", "Git rebase 尚未完成");
  }
  if (gitSync(["ls-files", "-u"], root).stdout.trim() !== "") throw new TaskGuardError("git_conflict", "Git index 仍有未解决冲突");
  if (gitSync(["ls-files", "--", ".knit/.runtime"], root).stdout.trim() !== "") {
    throw new TaskGuardError("runtime_tracked", ".knit/.runtime 已被 Git 跟踪，先移出跟踪");
  }
}

export class TaskService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly git: GitPort;
  private readonly runActivity: TaskRunActivityPort | null;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.git = options.git ?? new ArgvGitPort();
    this.runActivity = options.runActivity ?? null;
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  }

  /** 任务目录键：稳定 ID（OPERATIONS：任务锁按稳定 ID 定位，移动仍为同一对象）。 */
  private taskLockKey(root: string, taskId: string) {
    return { scope: "task" as const, rawKey: `${root}::${taskId}` };
  }

  private tasksRoot(root: string): string {
    return safeJoin(join(root, ".knit"), TASKS_DIR);
  }

  /** 首次归档月份：归档目标 YYYY-MM 取完成时的本地月份（DESIGN.md 第3.2节）。 */
  private archiveMonth(now: Date): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  /** 遍历活跃与归档任务目录；返回目录相对 tasks/ 的路径。 */
  private taskDirectories(root: string): { name: string; archived: boolean }[] {
    return listTaskDirectories(root);
  }

  /** 按稳定 ID 定位任务目录；读 frontmatter 核对 ID，防目录重名冲突。 */
  private locate(root: string, taskId: string): { dir: string; archived: boolean; document: TaskDocument; raw: Buffer } {
    return locateTaskDocument(root, taskId);
  }

  /**
   * 创建任务：唯一 ID、目录命名冲突短序号、frontmatter + 初始记录、binding 落库。
   * 授权与 Git HEAD／分支核实由调用方（CLI 入口）先行完成（DESIGN.md 第14.1节）。
   */
  async newTask(input: TaskNewInput): Promise<TaskNewResult> {
    const root = normalizeRoot(input.dir);
    assertFormalTaskEnvironment(root);
    const now = input.now ?? this.now();
    const tasksRoot = this.tasksRoot(root);
    if (!existsSync(tasksRoot)) {
      mkdirSync(tasksRoot, { recursive: false, mode: 0o755 });
    }
    const slug = (input.slug ?? "task").replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
    const existing = this.taskDirectories(root).filter((entry) => !entry.archived).map((entry) => entry.name);
    const dirName = taskDirectoryName(now, slug, existing);
    // 身份唯一：在活动与归档全集中核对（同 ID 歧义直接失败，不静默换名）。
    const existingIds = new Set<string>();
    for (const { name } of this.taskDirectories(root)) {
      const file = join(this.tasksRoot(root), name, TASK_FILE);
      if (!existsSync(file)) continue;
      existingIds.add(parseTaskDocument(readFileSync(file, "utf8"), file).frontmatter.id);
    }
    const nextId = () => newTaskId(() => this.randomHex(6));
    let taskId = nextId();
    while (existingIds.has(taskId)) taskId = nextId();
    const dir = join(tasksRoot, dirName);
    mkdirSync(dir, { recursive: false });
    const { inputsBody, progressBody } = renderInitialTaskBody(input.title);
    // 创建前凭据扫描：标题进入任务正文（任务032）。
    assertNoCredentials(renderInitialTaskBody(input.title).inputsBody + input.title, "任务创建");
    const frontmatter = {
      id: taskId,
      status: "open" as const,
      phase: "discuss" as const,
      outcome: null,
      branch: input.branch ?? null,
      createdAt: now.toISOString(),
      title: input.title,
    };
    atomicWrite({
      path: join(dir, TASK_FILE),
      data: Buffer.from(renderTaskDocument({ frontmatter, inputsBody, progressBody, trailingBody: "" }), "utf8"),
      expectedSha256: null,
      mode: 0o644,
    });
    const binding: TaskBinding = {
      taskId,
      repoRoot: root,
      relativePath: `${TASKS_DIR}/${dirName}/${TASK_FILE}`,
      branch: input.branch ?? null,
      lastRunIds: [],
      lastCheckRunId: null,
      repairCycleId: null,
      repairRounds: null,
      stopReason: null,
      confirmedInputsDigest: null,
      confirmedStandardsDigest: null,
      pendingDraft: null,
    };
    await this.store.bindings.save(binding);
    return { taskId, root, relativePath: binding.relativePath, title: input.title, branch: binding.branch };
  }

  /** 任务列表：从任务目录派生（DESIGN.md 第2节）；frontmatter 为权威。 */
  list(input: { dir: string }): TaskListResult {
    const root = normalizeRoot(input.dir);
    const active: TaskSummary[] = [];
    const archived: TaskSummary[] = [];
    for (const { name, archived: isArchived } of this.taskDirectories(root)) {
      const file = join(this.tasksRoot(root), name, TASK_FILE);
      const raw = readWithVersion(file);
      if (raw === null) continue;
      const document = parseTaskDocument(raw.data.toString("utf8"), file);
      const summary: TaskSummary = {
        taskId: document.frontmatter.id,
        title: document.frontmatter.title,
        status: document.frontmatter.status,
        phase: document.frontmatter.phase,
        outcome: document.frontmatter.outcome,
        branch: document.frontmatter.branch,
        relativePath: `${TASKS_DIR}/${name}`,
        archived: isArchived,
      };
      (isArchived ? archived : active).push(summary);
    }
    return { root, active, archived };
  }

  /**
   * task adopt：接管当前可见分支，不切分支、不产生提交授权。
   * 已绑定其它分支时拒绝，避免静默改变执行归属。
   */
  async adopt(input: TaskAdoptInput): Promise<TaskAdoptResult> {
    const root = normalizeRoot(input.dir);
    const current = this.currentBranch(root);
    const branch = input.branch === "current" ? current : input.branch;
    if (!/^refs\/heads\/[^\s]+$/.test(branch)) {
      throw new TaskGuardError("invalid_branch", `接管分支必须是完整 refs/heads/...: ${branch}`);
    }
    if (branch !== current) {
      throw new TaskGuardError("branch_mismatch", `adopt 只接管当前分支 ${current}，不能改绑 ${branch}`);
    }
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.adopt",
    });
    try {
      if (this.currentBranch(root) !== branch) {
        throw new TaskGuardError("branch_mismatch", "接管等待期间项目分支变化，重试 task adopt");
      }
      const located = this.locate(root, input.taskId);
      if (located.archived) throw new TaskGuardError("task_archived", `任务已归档: ${input.taskId}`);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      if (document.frontmatter.status !== "open") {
        throw new TaskGuardError("task_closed", "任务已关闭；取消／替代只做收尾，不通过 adopt 重开");
      }
      if (this.runActivity !== null && !(await this.runActivity.settled(root, input.taskId))) {
        throw new TaskGuardError("runs_unsettled", "接管前须先收敛活动／未知运行与待接收结果");
      }
      const operations = await this.store.operations.list();
      const unverified = operations.find(
        (operation) =>
          operation.kind.startsWith("delivery.") &&
          (operation as { taskId?: string }).taskId === input.taskId &&
          ["planned", "running", "needs_attention"].includes(operation.state),
      );
      if (unverified !== undefined) {
        throw new TaskGuardError("git_effect_unverified", `存在未核实 Git 效果: ${unverified.operationId}`);
      }
      const previous = document.frontmatter.branch;
      const binding = await this.store.bindings.get(input.taskId);
      if (previous === branch) {
        if (binding !== null && binding.branch !== branch) {
          await this.store.bindings.save({ ...binding, branch });
        }
        return {
          taskId: input.taskId,
          branch,
          previousBranch: previous,
          adopted: false,
          checkInvalidated: false,
          phase: document.frontmatter.phase,
        };
      }
      // 纯分支变化只使检查失效；deliver 不再可交付时回 check，discuss/implement/check 保持。
      const nextPhase = document.frontmatter.phase === "deliver" ? "check" : document.frontmatter.phase;
      const updated = withRegions(document, {
        frontmatter: {
          ...document.frontmatter,
          branch,
          phase: nextPhase,
          status: "open",
          outcome: null,
        },
      });
      atomicWrite({
        path: file,
        data: Buffer.from(renderTaskDocument(updated), "utf8"),
        expectedSha256: before.sha256,
        mode: 0o644,
      });
      if (binding !== null) {
        await this.store.bindings.save({ ...binding, branch, lastCheckRunId: null });
      }
      return {
        taskId: input.taskId,
        branch,
        previousBranch: previous,
        adopted: true,
        checkInvalidated: true,
        phase: nextPhase,
      };
    } finally {
      this.locks.release(lock);
    }
  }

  private currentBranch(root: string): string {
    const result = gitSync(["symbolic-ref", "--quiet", "HEAD"], root);
    if (result.code !== 0) {
      throw new TaskGuardError("detached_head", "当前不是本地分支，无法 adopt current");
    }
    return result.stdout.trim();
  }

  /**
   * 改名（目录移动）：项目执行占用 + 任务短锁；按稳定 ID 更新路径线索与绑定。
   * 等价改名不影响检查资格；不等价改名由调用方声明，记录 digestImpact 事实（STATES.md 第8节）。
   */
  async rename(input: TaskRenameInput): Promise<TaskRenameResult> {
    const root = normalizeRoot(input.dir);
    const tasksRoot = this.tasksRoot(root);
    const existing = this.taskDirectories(root);
    const located = this.locate(root, input.taskId);
    const currentName = located.dir.slice(tasksRoot.length + 1);
    const datePart = /^(\d{2}-\d{2})-/.exec(currentName)?.[1];
    if (datePart === null || datePart === undefined) {
      throw new InfrastructureError("io_error", `任务目录名不含 MM-DD 前缀: ${currentName}`);
    }
    const slug = input.newSlug.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new TaskGuardError("invalid_slug", "改名后 slug 为空");
    const others = existing.filter((entry) => entry.name !== currentName).map((entry) => entry.name);
    const newName = taskDirectoryName(
      { getMonth: () => Number(datePart.slice(0, 2)) - 1, getDate: () => Number(datePart.slice(3, 5)) } as unknown as Date,
      slug,
      others,
    );
    if (newName === currentName) {
      return { taskId: input.taskId, from: currentName, to: newName, equivalent: input.equivalent };
    }
    const keys = orderKeys([
      { scope: "project", rawKey: root },
      this.taskLockKey(root, input.taskId),
    ]);
    const lock = await this.locks.acquire({ keys, action: "task.rename" });
    try {
      const target = join(tasksRoot, newName);
      if (existsSync(target)) throw new InfrastructureError("version_conflict", `目标目录已存在: ${newName}`);
      renameSync(located.dir, target);
      const binding = await this.store.bindings.get(input.taskId);
      if (binding !== null && binding.relativePath.includes(currentName)) {
        await this.store.bindings.save({
          ...binding,
          relativePath: binding.relativePath.replace(currentName, newName),
        });
      }
    } finally {
      this.locks.release(lock);
    }
    return { taskId: input.taskId, from: currentName, to: newName, equivalent: input.equivalent };
  }

  /**
   * task record：追加记录区，任务文件短锁内核对版本（STATES.md 第3节）。
   * 封存中明确未保存：sealed=true，不写任务、不留修改。
   */
  async record(input: TaskRecordInput): Promise<TaskRecordResult> {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({ keys: [this.taskLockKey(root, input.taskId)], action: "task.record" });
    try {
      // 锁内定位并重读封存标记：seal 由交付流程持同一任务锁写入，
      // 锁前检查与写入之间的竞态不能把封存后的资料写回原任务。
      const located = this.locate(root, input.taskId);
      const sealed = this.sealedMarker(located.dir);
      if (sealed) {
        return { taskId: input.taskId, saved: false, sealed: true, reason: sealed };
      }
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      const transition = onRecordWritten({
        status: document.frontmatter.status,
        phase: document.frontmatter.phase,
        outcome: document.frontmatter.outcome,
        branch: document.frontmatter.branch,
        pendingKind: null,
      });
      const addition = input.body.trimEnd();
      const progressBody = addition === ""
        ? document.progressBody
        : `${document.progressBody.trimEnd()}\n\n${addition}\n`;
      const updated = withRegions(document, { progressBody, frontmatter: { ...document.frontmatter } });
      const rendered = renderTaskDocument(updated);
      // 记录也可能被复制扩散；写前扫描本次新增正文（任务032）。
      if (addition !== "") assertNoCredentials(addition, "任务记录");
      // 短锁内核对版本：外部改动（expectedSha256 不符）报 version_conflict，不覆盖。
      atomicWrite({ path: file, data: Buffer.from(rendered, "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      return { taskId: input.taskId, saved: true };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 封存标记：归档进行中由 deliver/archive 流程落盘；本服务只读识别。 */
  private sealedMarker(dir: string): string | null {
    const marker = join(dir, ".knit-sealed");
    if (!existsSync(marker)) return null;
    return readFileSync(marker, "utf8").trim() || "sealing";
  }

  /** 读取当前输入摘要与 binding（CLI 与桥接查询用）。 */
  async readInputs(input: { dir: string; taskId: string }): Promise<{
    taskId: string;
    inputsDigest: string;
    pending: { kind: UpdateKind; digest: string; baselineDigest: string; createdAt: string } | null;
    binding: TaskBinding | null;
  }> {
    const root = normalizeRoot(input.dir);
    const located = this.locate(root, input.taskId);
    const file = join(located.dir, TASK_FILE);
    const raw = readFileSync(file, "utf8");
    const binding = await this.store.bindings.get(input.taskId);
    const pending = binding?.pendingDraft ?? null;
    return {
      taskId: input.taskId,
      inputsDigest: inputsDigestOf(raw),
      pending: pending ? { kind: pending.kind, digest: pending.digest, baselineDigest: pending.baselineDigest, createdAt: pending.createdAt } : null,
      binding,
    };
  }

  /**
   * task update：直接更新（--kind）或 apply/withdraw-pending（DESIGN.md 第3.6节）。
   * 直接更新：项目执行占用内写输入区并转移 phase；活动 run 中只保存草案。
   * apply：草案摘要与基线输入均匹配、旧执行已结束；基线变化不覆盖。
   * withdraw：版本摘要匹配、有撤回理由；不作用于后来草案。
   */
  async update(input: TaskUpdateInput): Promise<TaskUpdateResult> {
    if (input.expectPending !== undefined) {
      if (input.kind !== undefined) {
        throw new InfrastructureError("io_error", "--apply-pending/--withdraw-pending 不与 --kind 同用");
      }
      if (input.withdrawReason !== undefined) {
        return this.withdrawPending(input);
      }
      return this.applyPending(input);
    }
    if (input.kind === undefined) {
      throw new InfrastructureError("io_error", "task update 需要 --kind clarify/change 或 --apply-pending/--withdraw-pending");
    }
    const root = normalizeRoot(input.dir);
    const located = this.locate(root, input.taskId);
    const file = join(located.dir, TASK_FILE);
    const before = readWithVersion(file);
    if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
    if (input.expectTaskSha256 !== undefined && input.expectTaskSha256 !== before.sha256) {
      throw new InfrastructureError("version_conflict", "task.md 当前版本与恢复预览不一致，停止");
    }
    const document = parseTaskDocument(before.data.toString("utf8"), file);
    const binding = await this.store.bindings.get(input.taskId);
    const kindInput = input as TaskUpdateInput & { kind: UpdateKind };
    // 活动 run 中只保存草案：仅用任务短锁（稳定 ID），不与 worker 项目执行占用互斥（任务029）。
    const draftLock = await this.locks.acquire({ keys: [this.taskLockKey(root, input.taskId)], action: "task.update.draft" });
    try {
      const runActive = input.runActive || (this.runActivity !== null && await this.runActivity.active(root, input.taskId));
      if (runActive) {
        return await this.saveDraftLocked(root, input.taskId, kindInput, document, binding);
      }
    } finally {
      this.locks.release(draftLock);
    }
    // 非活动 run：直接更新仍需项目执行占用（输入区写回与阶段转移）。
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.update",
    });
    try {
      // 项目锁等待期间输入可能变化：锁内重读，防止覆盖后来更新。
      const latest = readWithVersion(file);
      if (latest === null || latest.sha256 !== before.sha256) {
        const latestDocument = latest === null ? null : parseTaskDocument(latest.data.toString("utf8"), file);
        const latestBinding = await this.store.bindings.get(input.taskId);
        if (latestDocument !== null) {
          const latestActive = input.runActive || (this.runActivity !== null && await this.runActivity.active(root, input.taskId));
          if (latestActive) {
            return await this.saveDraftLocked(root, input.taskId, kindInput, latestDocument, latestBinding);
          }
        }
        const latestVersion = readWithVersion(file);
        if (latestVersion === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
        return await this.updateDirect(root, kindInput, file, latestVersion, located.archived);
      }
      return await this.updateDirect(root, kindInput, file, before, located.archived);
    } finally {
      this.locks.release(lock);
    }
  }

  /** 活动 run 中只保存草案，不改冻结输入（STATES.md：InputsUpdateProposed）；调用方持有任务短锁。 */
  private async saveDraftLocked(
    root: string,
    taskId: string,
    input: TaskUpdateInput & { kind: UpdateKind },
    document: TaskDocument,
    binding: TaskBinding | null,
  ): Promise<TaskUpdateResult> {
    const currentDigest = inputsDigestOf(renderTaskDocument(document));
    if (binding === null) throw new InfrastructureError("io_error", `任务无绑定: ${taskId}`);
    if (binding.pendingDraft !== null) {
      throw new TaskGuardError("pending_draft_exists", "已有待应用草案；先 apply 或 withdraw");
    }
    const draft = {
      kind: input.kind,
      reason: input.reason,
      content: input.content,
      baselineDigest: currentDigest,
      digest: "",
      createdAt: this.now().toISOString(),
    };
    const digest = pendingDraftDigest({ ...draft, updateOperationId: input.updateOperationId ?? null });
    await this.store.bindings.save({ ...binding, pendingDraft: { ...draft, digest } });
    return {
      taskId,
      applied: "pending_saved",
      phase: document.frontmatter.phase,
      status: document.frontmatter.status,
      outcome: document.frontmatter.outcome,
      inputsDigest: currentDigest,
      digestChanged: false,
      pendingDraftDigest: digest,
    };
  }

  /** 非活动 run 的直接更新：写输入区并转移 phase；调用方持有项目＋任务锁。 */
  private async updateDirect(
    root: string,
    input: TaskUpdateInput & { kind: UpdateKind },
    file: string,
    before: { data: Buffer; sha256: string },
    archived: boolean,
  ): Promise<TaskUpdateResult> {
    const document = parseTaskDocument(before.data.toString("utf8"), file);
    const binding = await this.store.bindings.get(input.taskId);
    const prevDigest = binding?.confirmedInputsDigest ?? inputsDigestOf(before.data.toString("utf8"));
    const merged = this.mergeInputs(document, input.content);
    const nextDigest = inputsDigestOf(renderTaskDocument(merged));
    const digestChanged = nextDigest !== prevDigest;
    const transition = guardRejected(onInputsUpdated({
      status: document.frontmatter.status,
      phase: document.frontmatter.phase,
      outcome: document.frontmatter.outcome,
      branch: document.frontmatter.branch,
      pendingKind: binding?.pendingDraft ? binding.pendingDraft.kind : null,
    }, input.kind, digestChanged, archived), "task update");
    const updated = withRegions(document, {
      inputsBody: merged.inputsBody,
      frontmatter: { ...document.frontmatter, status: transition.status, phase: transition.phase, outcome: transition.outcome },
    });
    assertNoCredentials(input.content, "任务输入更新");
    atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
    if (binding !== null) {
      await this.store.bindings.save({
        ...binding,
        pendingDraft: null,
        confirmedInputsDigest: nextDigest,
      });
    }
    return {
      taskId: input.taskId,
      applied: "direct",
      phase: transition.phase,
      status: transition.status,
      outcome: transition.outcome,
      inputsDigest: nextDigest,
      digestChanged,
      pendingDraftDigest: null,
    };
  }

  /** 输入合并策略：替换目标与边界板块之后的正文为更新内容；保留 frontmatter 与记录区。 */
  private mergeInputs(document: TaskDocument, content: string): TaskDocument {
    return withRegions(document, { inputsBody: content });
  }

  /** 应用待应用草案：摘要与基线匹配、旧执行已结束（STATES.md 第3节）。 */
  private async applyPending(input: TaskUpdateInput): Promise<TaskUpdateResult> {
    if (input.expectPending === undefined) throw new InfrastructureError("io_error", "apply 需要 --expect-pending");
    if (input.runsSettled === false) throw new TaskGuardError("runs_unsettled", "应用输入草案前须先收敛活动／未知运行与待接收结果");
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.apply-pending",
    });
    try {
      // 摘要在锁外只是提示；锁内必须重新读取草案与基线，防止撤回后恢复旧草案。
      const located = this.locate(root, input.taskId);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const binding = await this.store.bindings.get(input.taskId);
      if (binding === null) throw new TaskGuardError("no_pending_draft", "没有待应用草案");
      const draft = binding.pendingDraft;
      if (draft === null) throw new TaskGuardError("no_pending_draft", "没有待应用草案");
      if (draft.digest !== input.expectPending) {
        throw new InfrastructureError("version_conflict", "草案版本摘要不匹配（stale_input）；不作用于后来草案");
      }
      if (this.runActivity !== null && !(await this.runActivity.settled(root, input.taskId))) {
        throw new TaskGuardError("runs_unsettled", "应用输入草案前旧执行仍活动、未知或结果待接收");
      }
      const currentDigest = inputsDigestOf(before.data.toString("utf8"));
      if (draft.baselineDigest !== currentDigest) {
        throw new InfrastructureError("version_conflict", "基线输入已变化；重新确认或合并，不覆盖后来输入");
      }
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      const facts = {
        status: document.frontmatter.status,
        phase: document.frontmatter.phase,
        outcome: document.frontmatter.outcome,
        branch: document.frontmatter.branch,
        pendingKind: draft.kind,
      };
      const merged = this.mergeInputs(document, draft.content);
      const nextDigest = inputsDigestOf(renderTaskDocument(merged));
      const transition = guardRejected(onPendingResolved(facts, draft.kind, nextDigest !== draft.baselineDigest, located.archived), "apply pending");
      // 任务030：转移结果与正文一起写入权威任务文件，响应与磁盘一致。
      const updated = withRegions(merged, {
        frontmatter: { ...document.frontmatter, status: transition.status, phase: transition.phase, outcome: transition.outcome },
      });
      assertNoCredentials(draft.content, "应用输入草案");
      atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated)), expectedSha256: before.sha256, mode: 0o644 });
      await this.store.bindings.save({ ...binding, pendingDraft: null, confirmedInputsDigest: nextDigest });
      return {
        taskId: input.taskId,
        applied: "pending_applied",
        phase: transition.phase,
        status: transition.status,
        outcome: transition.outcome,
        inputsDigest: nextDigest,
        digestChanged: nextDigest !== draft.baselineDigest,
        pendingDraftDigest: null,
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 撤回草案：版本摘要匹配、留原因；冻结输入与 phase 不变（STATES.md 第3节）。仅用任务短锁，运行中也可撤回（任务029）。 */
  private async withdrawPending(input: TaskUpdateInput): Promise<TaskUpdateResult> {
    if (input.expectPending === undefined || input.withdrawReason === undefined) {
      throw new InfrastructureError("io_error", "withdraw 需要 --expect-pending 与 --reason");
    }
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({ keys: [this.taskLockKey(root, input.taskId)], action: "task.withdraw-pending" });
    try {
      // 锁内重读草案：后来草案不能被旧摘要撤回。
      const located = this.locate(root, input.taskId);
      const binding = await this.store.bindings.get(input.taskId);
      if (binding === null) throw new TaskGuardError("no_pending_draft", "没有待应用草案");
      const draft = binding.pendingDraft;
      if (draft === null) throw new TaskGuardError("no_pending_draft", "没有待应用草案");
      if (draft.digest !== input.expectPending) {
        throw new InfrastructureError("version_conflict", "草案版本摘要不匹配；不作用于后来草案");
      }
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      // 撤回留操作记录，不写 task.md：活动运行中任务资料受 .knit 保护，写盘会误伤检查前后比对（任务029）。
      await this.store.operations.save({
        operationId: `withdraw-${this.randomHex(6)}`,
        kind: "task.withdraw-pending",
        state: "completed",
        reason: `kind=${draft.kind}; ${input.withdrawReason}`,
        recordedAt: this.now().toISOString(),
      });
      await this.store.bindings.save({ ...binding, pendingDraft: null });
      return {
        taskId: input.taskId,
        applied: "pending_withdrawn",
        phase: document.frontmatter.phase,
        status: document.frontmatter.status,
        outcome: document.frontmatter.outcome,
        inputsDigest: inputsDigestOf(before.data.toString("utf8")),
        digestChanged: false,
        pendingDraftDigest: null,
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * task ready：保存讨论确认（冻结输入与正式规范摘要），discuss → implement。
   * 正式规范摘要单独保存：纯记录与候选变化不使它变化（STATES.md 第8、9节）。
   */
  async ready(input: { dir: string; taskId: string }): Promise<{
    taskId: string;
    phase: string;
    confirmedInputsDigest: string;
    confirmedStandardsDigest: string;
  }> {
    const root = normalizeRoot(input.dir);
    assertFormalTaskEnvironment(root);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.ready",
    });
    try {
      const located = this.locate(root, input.taskId);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      const transition = guardRejected(onReady({
        status: document.frontmatter.status,
        phase: document.frontmatter.phase,
        outcome: document.frontmatter.outcome,
        branch: document.frontmatter.branch,
        pendingKind: null,
      }), "task ready");
      const updated = withRegions(document, {
        frontmatter: { ...document.frontmatter, status: transition.status, phase: transition.phase, outcome: transition.outcome },
      });
      // 冻结的是 ready 后的输入区（含 status/phase 转移），不是转移前版本；
      // 否则后续检查会把刚确认的任务立即判为 stale。
      const confirmedInputsDigest = inputsDigestOf(renderTaskDocument(updated));
      const confirmedStandardsDigest = formalStandardsDigest(root);
      atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      const binding = await this.store.bindings.get(input.taskId);
      if (binding !== null) {
        await this.store.bindings.save({ ...binding, confirmedInputsDigest, confirmedStandardsDigest });
      }
      return { taskId: input.taskId, phase: transition.phase, confirmedInputsDigest, confirmedStandardsDigest };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * task close：业务结束（completed/cancelled/superseded）。
   * 与该任务启动／接收共用短临界区：任务短锁内核对 frontmatter 版本并收敛事实；
   * 未应用草案先撤回留原因，不使草案生效；迟到旧结果不得重开（STATES.md 第3、11节）。
   */
  async close(input: TaskCloseInput): Promise<TaskCloseResult> {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.close",
    });
    try {
      const located = this.locate(root, input.taskId);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      if (!input.runsSettled) {
        throw new TaskGuardError("runs_unsettled", "关闭前须先收敛该任务活动／未知运行与待接收结果");
      }
      if (this.runActivity !== null && !(await this.runActivity.settled(root, input.taskId))) {
        throw new TaskGuardError("runs_unsettled", "关闭时仍有活动／未知运行或待接收结果");
      }
      const facts = {
        status: document.frontmatter.status,
        phase: document.frontmatter.phase,
        outcome: document.frontmatter.outcome,
        branch: document.frontmatter.branch,
        pendingKind: null,
      };
      const transition = guardRejected(
        input.outcome === "completed" ? onComplete(facts) : onCloseWithOutcome(facts, input.outcome),
        "task close",
      );
      // 锁内重读 binding：等待期间可能新增草案；关闭撤回的是当前草案。
      const binding = await this.store.bindings.get(input.taskId);
      const hadPending = binding?.pendingDraft !== null && binding?.pendingDraft !== undefined;
      const updated = withRegions(document, {
        frontmatter: { ...document.frontmatter, status: transition.status, phase: transition.phase, outcome: transition.outcome },
        progressBody: hadPending ? `${document.progressBody}\n### 关闭撤回输入草案\n\n- 时间: ${this.now().toISOString()}\n- 理由: 任务关闭（${input.outcome}），未应用草案不生效\n` : document.progressBody,
      });
      atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      if (binding !== null) {
        await this.store.bindings.save({ ...binding, pendingDraft: null });
      }
      return {
        taskId: input.taskId,
        status: transition.status,
        outcome: transition.outcome,
        phase: transition.phase,
        pendingWithdrawn: hadPending,
      };
    } finally {
      this.locks.release(lock);
    }
  }

}
