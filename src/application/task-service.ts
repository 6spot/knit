/**
 * TaskService：task new/rename/list/record/ready/update/close 核心命令（DESIGN.md 第4.1节）。
 * 文件权威：task.md（frontmatter + 输入区/记录区）；本机 binding 存 SQLite 元数据库。
 * 占用：目录改名与输入变更用项目执行占用；task record 用任务文件短占用（OPERATIONS.md 第2节）。
 * 业务裁决委托 domain/task.ts；本服务核对事实、执行 IO、写回转移结果。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, statSync, type BigIntStats } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import {
  DEFAULT_VERIFICATION,
  clarifyStateOf,
  inputsDigestOf,
  pendingDraftDigest,
  newTaskId,
  priorityOf,
  verificationModeOf,
  type TaskPriority,
  type UpdateKind,
  type VerificationMode,
} from "../contracts/task-inputs.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { onParentAssigned, onParentCompletion, parentChainContains, isKnownStage, transition as stageTransition, type Decision, type TaskFacts, type TaskTransition, type TaskTransitionResult } from "../domain/task.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { workflowOf } from "./workflow.js";
import {
  compareSchedule,
  dependencyBlockers,
  dependencyCycle,
  planReorder,
  priorityOrDefault,
  type DependencyBlocker,
  type ReorderPosition,
  type ScheduleEntry,
} from "../domain/schedule.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { GuardError } from "./guard-error.js";
import { formalStandardsDigest } from "./standards.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { currentEntry, scopeDigest, type ScopeEntry } from "./scope.js";
import { readWithVersion, atomicWrite } from "../infrastructure/atomic.js";
import { ArgvGitPort, gitSync } from "../infrastructure/process.js";
import type { GitPort } from "../ports/infrastructure.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { parseTaskDocument, renderTaskDocument, withRegions, type TaskDocument } from "./task-document.js";
import {
  archivedHistoryProblems,
  gitTrackedFiles,
  type TaskHistoryInfo,
  type TaskListProblem,
} from "./task-history.js";
import { PLAN_FILE } from "./task-materials.js";
import {
  listTaskMaterials as listMaterials,
  readTaskMaterial as readMaterial,
  saveTaskMaterial as saveMaterial,
  deleteTaskMaterial as deleteMaterial,
  snapshotTaskMaterials as snapshotMaterials,
} from "./task-materials.js";
import { scanCredentials } from "../contracts/credentials.js";
import { CompletionService } from "./completion-service.js";

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
      "## 待澄清",
      "",
      "<!-- 未决项用固定前缀、必须顶格：- [blocking] 需用户取舍且影响实施的决定（选项与差异）；- [assumed] Agent 假定，待确认。解决后折入目标与完成条件并删除本行，全部解决可删除本区段。 -->",
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
  /** 任务阶段：锚点 start／deliver 或当前流程配置里的阶段 id。 */
  stage: string;
  outcome: string | null;
  branch: string | null;
  /** 完成验证要求；旧记录缺省按 independent 展示。 */
  verification: VerificationMode;
  /** 归档任务为相对 tasks/ 的目录路径；活跃任务为目录名。 */
  relativePath: string;
  archived: boolean;
  /** 仅归档条目：跨机历史分类与判定问题；活跃条目为 null。 */
  history: TaskHistoryInfo | null;
  /** 原始创建时间；调度排序只读它，调整顺序不改写（DESIGN §3.11）。 */
  createdAt: string;
  /** 父任务稳定身份；顶层任务为 null（DESIGN §3.10）。 */
  parent: string | null;
  /** 直接子任务 ID（含已关闭与已归档的子任务）。 */
  children: string[];
  /** 尚未结束（status=open）的直接子任务 ID。 */
  openChildren: string[];
  /** 任务自身优先级；缺省 P2（DESIGN §3.11）。 */
  priority: TaskPriority;
  /** 前置依赖的稳定任务身份。 */
  dependsOn: string[];
  /** 同一优先级内人工调整后的业务顺序；null 表示沿用真实创建先后。 */
  order: number | null;
  /** 未满足的前置依赖；可诊断的启动阻塞原因。 */
  blocked: DependencyBlocker[];
}

export interface TaskListResult {
  root: string;
  active: TaskSummary[];
  archived: TaskSummary[];
  /** list 级诊断：归档解析失败、重复来源、Git 跟踪状态不可判定。 */
  problems: TaskListProblem[];
}

export interface TaskNewInput {
  dir: string;
  title: string;
  slug?: string;
  branch?: string | null;
  /** 创建时确定完成验证要求；缺省 self。 */
  verification?: VerificationMode;
  /** 同时挂接已存在的父任务（稳定身份）；缺省顶层任务。 */
  parent?: string | null;
  /** 任务自身优先级；缺省 P2。 */
  priority?: TaskPriority;
  /** 前置依赖的稳定任务身份；缺省无依赖。 */
  dependsOn?: string[];
  /** 测试注入；默认本地日期。 */
  now?: Date;
}

export interface TaskNewResult {
  taskId: string;
  root: string;
  relativePath: string;
  title: string;
  branch: string | null;
  verification: VerificationMode;
  parent: string | null;
  priority: TaskPriority;
  dependsOn: string[];
}

export interface TaskParentInput {
  dir: string;
  taskId: string;
  /** 目标父任务 ID；null 表示解除关联。 */
  parentId: string | null;
}

export interface TaskParentResult {
  taskId: string;
  parent: string | null;
  previous: string | null;
  /** 变更后该父任务的直接子任务 ID。 */
  children: string[];
}

export interface TaskPriorityInput {
  dir: string;
  taskId: string;
  priority: TaskPriority;
}

export interface TaskPriorityResult {
  taskId: string;
  previous: TaskPriority;
  priority: TaskPriority;
  changed: boolean;
}

export interface TaskDependenciesInput {
  dir: string;
  taskId: string;
  /** 整体替换（提供时忽略 add／remove）。 */
  set?: string[];
  add?: string[];
  remove?: string[];
}

export interface TaskDependenciesResult {
  taskId: string;
  dependsOn: string[];
  previous: string[];
  changed: boolean;
  /** 变更后仍未满足的前置依赖（含用户当前选择导致的阻塞）。 */
  blocked: DependencyBlocker[];
}

export interface TaskOrderInput {
  dir: string;
  taskId: string;
  position: ReorderPosition;
}

export interface TaskOrderResult {
  taskId: string;
  /** 调整后的业务顺序（按执行顺序排列的稳定任务 ID）。 */
  order: string[];
  /** 本次实际写入 order 的目标优先级分组任务 ID。 */
  updated: string[];
}

export interface TaskNextEntry {
  taskId: string;
  title: string;
  priority: TaskPriority;
  /** 依赖是否全部满足；false 时 blocked 给出原因。 */
  executable: boolean;
  blocked: DependencyBlocker[];
  parent: string | null;
  /** 阶段与完成验证，供主会话决定下一步环节。 */
  stage: string;
  verification: VerificationMode;
}

export interface TaskNextResult {
  /** 按稳定执行顺序排列的活跃任务（P0→P3，同级按业务顺序／真实创建先后）。 */
  entries: TaskNextEntry[];
  /** 首个可执行任务；全部被阻塞时为 null。 */
  next: string | null;
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

export interface TaskVerificationInput {
  dir: string;
  taskId: string;
  verification: VerificationMode;
  reason?: string | null;
}

export interface TaskVerificationResult {
  taskId: string;
  verification: VerificationMode;
  stage: string;
  changed: boolean;
}

export interface TaskAdoptResult {
  taskId: string;
  branch: string;
  previousBranch: string | null;
  adopted: boolean;
  /** 分支变化使旧检查失去交付资格时为 true；历史检查文件仍保留。 */
  checkInvalidated: boolean;
  stage: string;
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
  stage: string;
  status: string;
  outcome: string | null;
  inputsDigest: string;
  /** 摘要变化事实：应用层据此使检查 stale（STATES.md 第8节）。 */
  digestChanged: boolean;
  pendingDraftDigest: string | null;
}

/** 主会话／用户实施事实：没有 worker run 时用于完成资格核对。 */
export interface TaskImplementInput {
  dir: string;
  taskId: string;
  /** 实际改动路径；至少一条。 */
  paths: string[];
  /** 实际运行的验证；至少一条，否则应改用 task close --force。 */
  validations: string[];
  unverified?: string[];
  summary?: string | null;
  executor?: "main-session" | "user";
}

export interface TaskImplementResult {
  taskId: string;
  executor: "main-session" | "user";
  paths: string[];
  validations: number;
  inputsDigest: string;
  scopeDigest: string;
}

export interface TaskCloseInput {
  dir: string;
  taskId: string;
  outcome: "completed" | "cancelled" | "superseded";
  /** 调用方已核实的收尾事实：无活动／未知 run、无未核实 Git 效果（STATES.md 第3节）。 */
  runsSettled: boolean;
  /**
   * 任务正文所在执行目录根（worktree 路由下为 worktree 路径）；缺省同 dir。
   * 运行记录与完成凭据仍读 evidenceRoot，使 worktree 内关闭能核对主检出中的实施事实。
   */
  executionDir?: string;
  /** 运行记录、完成凭据与 scope 根（主检出）；缺省同 dir。 */
  evidenceRoot?: string;
  /** 完成判断的用户说明；写入完成凭据。 */
  reason?: string | null;
  /** 用户明确强制完成：跳过完成资格证据核对；必须给 reason。 */
  force?: boolean;
}

export interface TaskCloseResult {
  taskId: string;
  status: string;
  outcome: string | null;
  stage: string;
  /** 关闭时撤回的未应用草案摘要；留原因记录。 */
  pendingWithdrawn: boolean;
  /** completed 时写入的验证方式与凭据来源。 */
  verification?: VerificationMode;
  implementRunId?: string | null;
  checkRunId?: string | null;
  /** 强制完成：凭据带 forced 标记与原因。 */
  forced?: boolean;
  unverified?: string[];
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
  /** list 分区读取观测钩子；断言缓存命中不 stat／read 归档 task.md。 */
  onListIo?: (event: TaskListIoEvent) => void;
}

/** 领域拒绝到协议边界的稳定错误；应用层 catch 后映射 ReasonCode。 */
export class TaskGuardError extends GuardError {
  constructor(guardReason: string, message: string) {
    super(guardReason, message);
    this.name = "TaskGuardError";
  }
}

/**
 * ready 结构核对（任务049、k-9197494d2657）：只机械核对可确定性的事实——
 * plan.md 存在（复杂任务已承诺持久规划）但内容为空时拒绝；task.md「待澄清」区段仍有
 * `- [blocking] ` 项时拒绝（无区段、空区段或只有 assumed 放行）。目标占位是否已确认、
 * assumed 是否已确认属主 Agent 语义判断（DESIGN §4.2），不由核心机械拒绝；
 * 可选 design／research 缺失不阻挡。既有 stage 与 ready 入口不变，不新增规划状态机。
 */
function assertReadyStructural(document: TaskDocument, taskDir: string): void {
  const planPath = join(taskDir, PLAN_FILE);
  if (existsSync(planPath) && readFileSync(planPath, "utf8").trim() === "") {
    throw new TaskGuardError("ready_plan_incomplete", "plan.md 为空；复杂任务的实施计划未完成");
  }
  const clarify = clarifyStateOf(document.inputsBody);
  if (clarify.blocking > 0) {
    const items = clarify.blockingItems.map((item) => `「${item}」`).join("；");
    const rest = clarify.blocking - clarify.blockingItems.length;
    const more = rest > 0 ? `；另有 ${rest} 项` : "";
    throw new TaskGuardError(
      "clarify_blocking",
      `「待澄清」仍有 ${clarify.blocking} 项 [blocking] 未决，需用户取舍：${items}${more}。先与用户确认并折入目标与完成条件，或删除已解决项`,
    );
  }
}

function guardRejected<R extends string>(result: Decision<R>, what: string): void;
function guardRejected(result: TaskTransitionResult, what: string): TaskTransition;
function guardRejected(result: Decision<string> | TaskTransitionResult, what: string): TaskTransition | void {
  if ("allowed" in result && result.allowed === false) {
    throw new TaskGuardError(result.reason, `${what}被拒绝: ${result.reason}`);
  }
  return result as TaskTransition;
}

/** 已解析文档的业务事实投影；pendingKind、visits 与 stopReason 由调用方按绑定补齐。 */
function factsOf(document: TaskDocument): TaskFacts {
  return {
    status: document.frontmatter.status,
    stage: document.frontmatter.stage,
    outcome: document.frontmatter.outcome,
    branch: document.frontmatter.branch,
    pendingKind: null,
    verification: verificationModeOf(document.frontmatter),
  };
}

/** 绑定侧的阶段计数与停止原因；旧绑定缺省为空。 */
function stageFactsOf(document: TaskDocument, binding: TaskBinding | null): TaskFacts {
  return {
    ...factsOf(document),
    pendingKind: binding?.pendingDraft?.kind ?? null,
    visits: binding?.stageVisits ?? {},
    stopReason: binding?.stopReason ?? null,
  };
}

/** 阶段值必须可写（锚点或当前生效流程中的阶段）：旧值只读展示，写操作拒绝并提示。 */
function assertStageWritable(workflow: WorkflowDefinition, document: TaskDocument, what: string): void {
  if (isKnownStage(workflow, document.frontmatter.stage)) return;
  throw new TaskGuardError(
    "stage_not_in_workflow",
    `${what}被拒绝：任务阶段值 ${document.frontmatter.stage} 不在当前流程配置中；旧值只读展示，先 task update --kind change 回到 start，或恢复 .knit/workflow.yaml`,
  );
}

/** 调度事实投影：优先级缺省 P2，依赖缺省为空，order 缺省沿用创建先后（DESIGN §3.11）。 */
function scheduleEntryOf(document: TaskDocument, archived: boolean): ScheduleEntry {
  return {
    taskId: document.frontmatter.id,
    priority: priorityOf(document.frontmatter),
    createdAt: document.frontmatter.createdAt,
    order: document.frontmatter.order ?? null,
    dependsOn: document.frontmatter.dependsOn ?? [],
    status: document.frontmatter.status,
    outcome: document.frontmatter.outcome,
    archived,
  };
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

/** list 分区读取的可选观测钩子：测试与诊断据此断言归档侧 stat／read 次数。 */
export interface TaskListIoEvent {
  kind: "stat" | "read";
  path: string;
}

type TaskListProbe = (event: TaskListIoEvent) => void;

type TaskListActiveEntry = { summary: TaskSummary } | { error: { path: string; error: unknown } };
type TaskListArchiveEntry = { summary: TaskSummary } | { problem: TaskListProblem };

/** 活跃／归档两个可独立失效的分区；合并结果只由分区事实派生。 */
interface TaskListPartitions {
  active: { entries: TaskListActiveEntry[] };
  archive: { entries: TaskListArchiveEntry[]; gitProblem: string | null };
}

interface TaskListCacheEntry {
  activeFingerprint: string;
  archiveFingerprint: string;
  active: TaskListPartitions["active"];
  archive: TaskListPartitions["archive"];
  /** 合并结果；仅 status 概览更新分区时为 null，下次 list 再派生。 */
  result: TaskListResult | null;
}

/** 进程内按项目根共享的分区缓存：task list／next 与 status 概览复用同一份事实。 */
const taskListCache = new Map<string, TaskListCacheEntry>();

const TASK_LIST_RUNTIME_DIR = "task-list";
const TASK_LIST_ARCHIVE_MARKER = "archive.invalidation";

function taskListArchiveMarkerPath(root: string): string {
  return join(root, ".knit", ".runtime", TASK_LIST_RUNTIME_DIR, TASK_LIST_ARCHIVE_MARKER);
}

function readTaskListArchiveMarker(root: string): string | null {
  try {
    return readFileSync(taskListArchiveMarkerPath(root), "utf8").trim();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
  }
}

/**
 * Knit 自身归档／还原／改档后写显式失效标记；标记与归档分区指纹一起参与比较，
 * 即使目录 mtime 未变也能让下一次读取重算归档索引（任务 k-3d730c8907b3）。
 * 标记写失败不阻断业务操作：常规目录移动仍会改变月份目录 stat。
 */
export function markTaskListArchiveChanged(root: string, reason: string): void {
  try {
    atomicWrite({
      path: taskListArchiveMarkerPath(root),
      data: Buffer.from(`${new Date().toISOString()}\u0000${reason}\u0000${randomBytes(8).toString("hex")}\n`, "utf8"),
      mode: 0o600,
      createParents: true,
    });
  } catch {
    // 不阻断归档收尾；本次目录结构变化仍由分区指纹覆盖。
  }
  // 同一进程内即使标记写入失败，也先丢弃缓存，下次读取必须重算归档分区。
  try {
    taskListCache.delete(normalizeRoot(root));
  } catch {
    // 根目录不可解析时无可复用缓存。
  }
}

function taskListStat(file: string, probe: TaskListProbe | undefined): BigIntStats {
  probe?.({ kind: "stat", path: file });
  return statSync(file, { bigint: true });
}

function taskListRead(file: string, probe: TaskListProbe | undefined) {
  probe?.({ kind: "read", path: file });
  return readWithVersion(file);
}

function taskListStatFingerprint(stats: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): string {
  return `${stats.dev}\u0000${stats.ino}\u0000${stats.size}\u0000${stats.mtimeNs}`;
}

/**
 * 活跃分区指纹（任务 k-57324c702c9e 原口径）：tasks/ 下除 archive 外每个 task.md 的
 * dev/inode/size/mtimeNs。atomicWrite 经 rename 发布会换 inode；同尺寸同毫秒的就地覆盖也会改变 mtimeNs。
 */
function taskListActiveFingerprint(root: string, probe: TaskListProbe | undefined): string | null {
  const tasksRoot = tasksRootOf(root);
  if (!existsSync(tasksRoot)) return null;
  const parts: string[] = [];
  try {
    const names = readdirSync(tasksRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE_DIR)
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const file = join(tasksRoot, name, TASK_FILE);
      let stats: BigIntStats;
      try {
        stats = taskListStat(file, probe);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return null;
      }
      parts.push(`active/${name}\u0000${taskListStatFingerprint(stats)}`);
    }
    return parts.join("\n");
  } catch {
    return null;
  }
}

/**
 * 归档分区指纹：tasks/archive 与各月份目录的 dev/inode/size/mtimeNs（O(月份)，
 * 不逐条 stat 归档 task.md），并叠加 Knit 自身操作写入的显式失效标记。
 */
function taskListArchiveFingerprint(root: string, probe: TaskListProbe | undefined): string | null {
  const tasksRoot = tasksRootOf(root);
  if (!existsSync(tasksRoot)) return null;
  const marker = readTaskListArchiveMarker(root);
  if (marker === null) return null;
  const parts = [`marker\u0000${marker}`];
  const archiveRoot = join(tasksRoot, ARCHIVE_DIR);
  let archiveStats: BigIntStats;
  try {
    archiveStats = taskListStat(archiveRoot, probe);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      parts.push("archive\u0000absent");
      return parts.join("\n");
    }
    return null;
  }
  parts.push(`archive\u0000${taskListStatFingerprint(archiveStats)}`);
  try {
    const months = readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const month of months) {
      const stats = taskListStat(join(archiveRoot, month), probe);
      parts.push(`month/${month}\u0000${taskListStatFingerprint(stats)}`);
    }
    return parts.join("\n");
  } catch {
    return null;
  }
}

function taskSummaryOf(
  document: TaskDocument,
  relativePath: string,
  archived: boolean,
  history: TaskHistoryInfo | null,
): TaskSummary {
  return {
    taskId: document.frontmatter.id,
    title: document.frontmatter.title,
    status: document.frontmatter.status,
    stage: document.frontmatter.stage,
    outcome: document.frontmatter.outcome,
    branch: document.frontmatter.branch,
    verification: verificationModeOf(document.frontmatter),
    relativePath,
    archived,
    history,
    createdAt: document.frontmatter.createdAt,
    parent: document.frontmatter.parent ?? null,
    children: [],
    openChildren: [],
    priority: priorityOf(document.frontmatter),
    dependsOn: document.frontmatter.dependsOn ?? [],
    order: document.frontmatter.order ?? null,
    blocked: [],
  };
}

/** 活跃分区扫描：只读 tasks/ 下未归档任务；解析失败按调用方要求抛错或保留诊断。 */
function buildTaskListActivePartition(
  root: string,
  probe: TaskListProbe | undefined,
  errorMode: "throw" | "collect",
): TaskListPartitions["active"] {
  const tasksRoot = tasksRootOf(root);
  const entries: TaskListActiveEntry[] = [];
  if (!existsSync(tasksRoot)) return { entries };
  const names = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE_DIR)
    .map((entry) => entry.name);
  for (const name of names) {
    const file = join(tasksRoot, name, TASK_FILE);
    const raw = taskListRead(file, probe);
    if (raw === null) continue;
    const relativePath = `${TASKS_DIR}/${name}`;
    let document: TaskDocument;
    try {
      document = parseTaskDocument(raw.data.toString("utf8"), file);
    } catch (error) {
      if (errorMode === "throw") throw error;
      entries.push({ error: { path: `${relativePath}/${TASK_FILE}`, error } });
      continue;
    }
    entries.push({ summary: taskSummaryOf(document, relativePath, false, null) });
  }
  return { entries };
}

/** 归档分区扫描：按月目录收集条目、解析问题与跨机历史分类；成本只在归档分区失效时支付。 */
function buildTaskListArchivePartition(root: string, probe: TaskListProbe | undefined): TaskListPartitions["archive"] {
  const tasksRoot = tasksRootOf(root);
  const entries: TaskListArchiveEntry[] = [];
  const gitCandidates: TaskSummary[] = [];
  if (!existsSync(tasksRoot)) return { entries, gitProblem: null };
  const archiveRoot = join(tasksRoot, ARCHIVE_DIR);
  if (!existsSync(archiveRoot)) return { entries, gitProblem: null };
  const months = readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const month of months) {
    const monthDir = join(archiveRoot, month);
    for (const entry of readdirSync(monthDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(monthDir, entry.name, TASK_FILE);
      const raw = taskListRead(file, probe);
      if (raw === null) continue;
      const relativePath = `${TASKS_DIR}/${ARCHIVE_DIR}/${month}/${entry.name}`;
      let document: TaskDocument;
      try {
        document = parseTaskDocument(raw.data.toString("utf8"), file);
      } catch (error) {
        entries.push({
          problem: {
            path: `${relativePath}/${TASK_FILE}`,
            message: error instanceof Error ? error.message : String(error),
          },
        });
        continue;
      }
      const historyProblems = archivedHistoryProblems(document.frontmatter);
      const summary = taskSummaryOf(document, relativePath, true, {
        kind: historyProblems.length === 0 ? "local-only" : "invalid",
        problems: historyProblems,
      });
      entries.push({ summary });
      if (summary.history?.kind === "local-only") gitCandidates.push(summary);
    }
  }
  let gitProblem: string | null = null;
  if (gitCandidates.length > 0) {
    const tracked = gitTrackedFiles(
      root,
      gitCandidates.map((summary) => `.knit/${summary.relativePath}/${TASK_FILE}`),
    );
    if (!tracked.ok) {
      gitProblem = tracked.problem ?? "Git 跟踪状态不可判定";
      for (const summary of gitCandidates) {
        summary.history = { kind: "local-only", problems: [gitProblem] };
      }
    } else {
      for (const summary of gitCandidates) {
        if (tracked.tracked.has(`.knit/${summary.relativePath}/${TASK_FILE}`)) {
          summary.history = { kind: "git-history", problems: [] };
        }
      }
    }
  }
  return { entries, gitProblem };
}

function throwFirstActiveError(active: TaskListPartitions["active"]): void {
  for (const entry of active.entries) {
    if ("error" in entry) throw entry.error.error;
  }
}

interface LoadedTaskListPartitions {
  active: TaskListPartitions["active"];
  archive: TaskListPartitions["archive"];
  cacheEntry: TaskListCacheEntry | null;
}

/**
 * 读取分区缓存：两侧指纹都命中时零文件读取；只有变化的一侧重扫。
 * 指纹不可得或读取前后不一致时不落缓存，避免把旧分区配给新事实。
 */
function loadTaskListPartitions(
  root: string,
  probe: TaskListProbe | undefined,
  activeErrorMode: "throw" | "collect",
): LoadedTaskListPartitions {
  const activeFingerprint = taskListActiveFingerprint(root, probe);
  const archiveFingerprint = taskListArchiveFingerprint(root, probe);
  if (activeFingerprint === null || archiveFingerprint === null) {
    taskListCache.delete(root);
    const active = buildTaskListActivePartition(root, probe, activeErrorMode);
    return { active, archive: buildTaskListArchivePartition(root, probe), cacheEntry: null };
  }
  const cached = taskListCache.get(root);
  const activeReused = cached !== undefined && cached.activeFingerprint === activeFingerprint;
  const archiveReused = cached !== undefined && cached.archiveFingerprint === archiveFingerprint;
  const active = activeReused ? (cached as TaskListCacheEntry).active : buildTaskListActivePartition(root, probe, activeErrorMode);
  if (activeErrorMode === "throw") throwFirstActiveError(active);
  if (activeReused && archiveReused) {
    const entry = cached as TaskListCacheEntry;
    return { active, archive: entry.archive, cacheEntry: entry };
  }
  const archive = archiveReused ? (cached as TaskListCacheEntry).archive : buildTaskListArchivePartition(root, probe);
  const afterActive = taskListActiveFingerprint(root, probe);
  const afterArchive = taskListArchiveFingerprint(root, probe);
  if (afterActive === null || afterArchive === null || afterActive !== activeFingerprint || afterArchive !== archiveFingerprint) {
    taskListCache.delete(root);
    return { active, archive, cacheEntry: null };
  }
  const entry: TaskListCacheEntry = { activeFingerprint, archiveFingerprint, active, archive, result: null };
  taskListCache.set(root, entry);
  return { active, archive, cacheEntry: entry };
}

function cloneTaskSummary(summary: TaskSummary): TaskSummary {
  return {
    ...summary,
    children: [...summary.children],
    openChildren: [...summary.openChildren],
    dependsOn: [...summary.dependsOn],
    blocked: summary.blocked.map((blocker) => ({ ...blocker })),
    history: summary.history === null ? null : { kind: summary.history.kind, problems: [...summary.history.problems] },
  };
}

/** 合并两个分区：父子、调度与阻塞按稳定 ID 统一派生，输出口径与未分区扫描一致。 */
function mergeTaskListPartitions(
  root: string,
  activePart: TaskListPartitions["active"],
  archivePart: TaskListPartitions["archive"],
): TaskListResult {
  const active: TaskSummary[] = [];
  const archived: TaskSummary[] = [];
  const problems: TaskListProblem[] = [];
  const firstSource = new Map<string, string>();
  for (const entry of activePart.entries) {
    if ("error" in entry) throw entry.error.error;
    const summary = cloneTaskSummary(entry.summary);
    const prior = firstSource.get(summary.taskId);
    if (prior !== undefined) {
      problems.push({
        path: `${summary.relativePath}/${TASK_FILE}`,
        message: `重复来源: 任务 ${summary.taskId} 同时出现在 ${prior}/${TASK_FILE} 与 ${summary.relativePath}/${TASK_FILE}`,
      });
    } else {
      firstSource.set(summary.taskId, summary.relativePath);
    }
    active.push(summary);
  }
  for (const entry of archivePart.entries) {
    if ("problem" in entry) {
      problems.push(entry.problem);
      continue;
    }
    const summary = cloneTaskSummary(entry.summary);
    const prior = firstSource.get(summary.taskId);
    if (prior !== undefined) {
      problems.push({
        path: `${summary.relativePath}/${TASK_FILE}`,
        message: `重复来源: 任务 ${summary.taskId} 同时出现在 ${prior}/${TASK_FILE} 与 ${summary.relativePath}/${TASK_FILE}`,
      });
    } else {
      firstSource.set(summary.taskId, summary.relativePath);
    }
    archived.push(summary);
  }
  if (archivePart.gitProblem !== null) {
    problems.push({ path: `.knit/${TASKS_DIR}/${ARCHIVE_DIR}`, message: archivePart.gitProblem });
  }
  // 父子关系按稳定 ID 派生：子任务记 parent，父任务不存重复清单，目录改名不影响关联。
  const byId = new Map<string, TaskSummary>();
  for (const summary of [...active, ...archived]) {
    if (!byId.has(summary.taskId)) byId.set(summary.taskId, summary);
  }
  const childrenOf = new Map<string, string[]>();
  for (const summary of byId.values()) {
    if (summary.parent === null) continue;
    const list = childrenOf.get(summary.parent) ?? [];
    list.push(summary.taskId);
    childrenOf.set(summary.parent, list);
  }
  for (const summary of byId.values()) {
    summary.children = childrenOf.get(summary.taskId) ?? [];
    summary.openChildren = summary.children.filter((childId) => byId.get(childId)?.status === "open");
  }
  // 执行顺序与阻塞在服务层统一派生：CLI、桥接与 run 入口读同一事实，
  // 不从目录名、枚举顺序或各自排序推断（DESIGN §3.11）。
  const schedule = new Map<string, ScheduleEntry>();
  for (const summary of byId.values()) {
    schedule.set(summary.taskId, {
      taskId: summary.taskId,
      priority: summary.priority,
      createdAt: summary.createdAt,
      order: summary.order,
      dependsOn: summary.dependsOn,
      status: summary.status as "open" | "closed",
      outcome: summary.outcome as "completed" | "cancelled" | "superseded" | null,
      archived: summary.archived,
    });
  }
  for (const summary of byId.values()) {
    const entry = schedule.get(summary.taskId) as ScheduleEntry;
    summary.blocked = dependencyBlockers(entry, schedule);
  }
  active.sort((left, right) => compareSchedule(schedule.get(left.taskId) as ScheduleEntry, schedule.get(right.taskId) as ScheduleEntry));
  return { root, active, archived, problems };
}

function freezeTaskListResult(result: TaskListResult): void {
  for (const summary of [...result.active, ...result.archived]) {
    Object.freeze(summary.children);
    Object.freeze(summary.openChildren);
    Object.freeze(summary.dependsOn);
    for (const blocker of summary.blocked) Object.freeze(blocker);
    Object.freeze(summary.blocked);
    if (summary.history !== null) {
      Object.freeze(summary.history.problems);
      Object.freeze(summary.history);
    }
    Object.freeze(summary);
  }
  Object.freeze(result.active);
  Object.freeze(result.archived);
  for (const problem of result.problems) Object.freeze(problem);
  Object.freeze(result.problems);
  Object.freeze(result);
}

/** status 概览复用同一分区缓存；损坏条目跳过，重复 ID 如实列出。 */
export function taskListOverviewSummaries(root: string): { active: TaskSummary[]; archived: TaskSummary[] } {
  const loaded = loadTaskListPartitions(root, undefined, "collect");
  const active: TaskSummary[] = [];
  const archived: TaskSummary[] = [];
  for (const entry of loaded.active.entries) {
    if ("summary" in entry) active.push(entry.summary);
  }
  for (const entry of loaded.archive.entries) {
    if ("summary" in entry) archived.push(entry.summary);
  }
  return { active, archived };
}

/** 按稳定 ID 定位任务文档；同目录名不等于同任务，ID 以 frontmatter 为准。 */
export function locateTaskDocument(
  root: string,
  taskId: string,
): { dir: string; archived: boolean; document: TaskDocument; raw: Buffer } {
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw new TaskGuardError("invalid_request", "任务 ID 不能为空");
  }
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
  private readonly onListIo: ((event: TaskListIoEvent) => void) | undefined;

  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.git = options.git ?? new ArgvGitPort();
    this.runActivity = options.runActivity ?? null;
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
    this.onListIo = options.onListIo;
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
    if (typeof taskId !== "string" || taskId.trim() === "") {
      throw new TaskGuardError("invalid_request", "任务 ID 不能为空");
    }
    return locateTaskDocument(root, taskId);
  }

  /**
   * 全量任务文档索引（DESIGN §3.10）：父子关系与成环检测按稳定 ID，不按目录名推断。
   * 同一 ID 多个来源时保留首个，重复来源由 list 报告。
   */
  private taskIndex(root: string): Map<string, { archived: boolean; dir: string; document: TaskDocument }> {
    const index = new Map<string, { archived: boolean; dir: string; document: TaskDocument }>();
    for (const { name, archived } of this.taskDirectories(root)) {
      const dir = join(this.tasksRoot(root), name);
      const raw = readWithVersion(join(dir, TASK_FILE));
      if (raw === null) continue;
      const document = parseTaskDocument(raw.data.toString("utf8"), join(dir, TASK_FILE));
      if (!index.has(document.frontmatter.id)) index.set(document.frontmatter.id, { archived, dir, document });
    }
    return index;
  }

  /**
   * 挂接或解除父任务（DESIGN §3.10）：只改子任务 frontmatter.parent，
   * 不使输入摘要或检查资格失效；解除关联不需额外授权，挂接需结构核对。
   */
  async setParent(input: TaskParentInput): Promise<TaskParentResult> {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.parent",
    });
    try {
      const index = this.taskIndex(root);
      const located = this.locate(root, input.taskId);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      const previous = document.frontmatter.parent ?? null;
      // 归档即封存：关系变更只能在活动任务上进行，避免改动已归档资料。
      if (located.archived) throw new TaskGuardError("child_archived", "已归档任务不能再变更父子关系");
      if (input.parentId !== null) {
        const parent = index.get(input.parentId);
        guardRejected(
          onParentAssigned({
            child: factsOf(document),
            childArchived: located.archived,
            parentKnown: parent !== undefined,
            parent: parent === undefined ? null : factsOf(parent.document),
            parentArchived: parent?.archived ?? false,
            cycle:
              input.parentId === input.taskId ||
              (parent !== undefined && parentChainContains(this.parentMap(index), input.parentId, input.taskId)),
          }),
          "task parent",
        );
      }
      if (previous !== input.parentId) {
        assertStageWritable(workflowOf(root), document, "task parent");
        const updated = withRegions(document, { frontmatter: { ...document.frontmatter, parent: input.parentId } });
        atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      }
      const children: string[] = [];
      if (input.parentId !== null) {
        for (const [entryId, entry] of index) {
          // 本任务的索引副本仍是旧值；按写入后的关系计算。
          const effectiveParent: string | null = entryId === input.taskId ? input.parentId : entry.document.frontmatter.parent ?? null;
          if (effectiveParent === input.parentId) children.push(entryId);
        }
      }
      return { taskId: input.taskId, parent: input.parentId, previous, children };
    } finally {
      this.locks.release(lock);
    }
  }

  /** 当前工程内“任务 ID → 父任务 ID”快照；用于沿链拒绝成环。 */
  private parentMap(index: Map<string, { document: TaskDocument }>): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const [taskId, entry] of index) map.set(taskId, entry.document.frontmatter.parent ?? null);
    return map;
  }

  /** 调度事实快照：覆盖活跃与归档任务，按稳定 ID 去重（重复 ID 保留首个）。 */
  private scheduleIndex(root: string): Map<string, ScheduleEntry> {
    const out = new Map<string, ScheduleEntry>();
    for (const [taskId, entry] of this.taskIndex(root)) {
      out.set(taskId, scheduleEntryOf(entry.document, entry.archived));
    }
    return out;
  }

  /**
   * 依赖结构核对：引用必须存在、不能依赖自己、不能成环。
   * 依赖的完成状态不在结构核对里拒绝——未完成或取消属于可诊断的启动阻塞，
   * 列表、task next 与执行入口给出一致原因（DESIGN §3.11）。
   */
  private assertDependencies(taskId: string, dependsOn: readonly string[], index: Map<string, ScheduleEntry>): void {
    for (const dependencyId of dependsOn) {
      if (dependencyId === taskId) {
        throw new TaskGuardError("dependency_self", `任务不能依赖自身: ${taskId}`);
      }
      if (!index.has(dependencyId)) {
        throw new TaskGuardError("dependency_missing", `前置依赖不存在: ${dependencyId}`);
      }
    }
    const graph = new Map<string, readonly string[]>();
    for (const [id, entry] of index) graph.set(id, entry.dependsOn);
    graph.set(taskId, dependsOn);
    const cycle = dependencyCycle(graph, taskId);
    if (cycle !== null) {
      throw new TaskGuardError("dependency_cycle", `前置依赖成环: ${cycle.join(" → ")}`);
    }
  }

  /** task priority：改任务自身优先级；只动调度事实，不使已确认输入或检查失效。 */
  async setPriority(input: TaskPriorityInput): Promise<TaskPriorityResult> {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.priority",
    });
    try {
      const located = this.locate(root, input.taskId);
      if (located.archived) throw new TaskGuardError("task_archived", `任务已归档: ${input.taskId}`);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      const previous = priorityOf(document.frontmatter);
      if (previous !== input.priority) {
        assertStageWritable(workflowOf(root), document, "task priority");
        const updated = withRegions(document, { frontmatter: { ...document.frontmatter, priority: input.priority } });
        atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      }
      return { taskId: input.taskId, previous, priority: input.priority, changed: previous !== input.priority };
    } finally {
      this.locks.release(lock);
    }
  }

  /** task depends：设置前置依赖；未完成依赖保留为可诊断阻塞，不在此静默移除。 */
  async setDependencies(input: TaskDependenciesInput): Promise<TaskDependenciesResult> {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.depends",
    });
    try {
      const located = this.locate(root, input.taskId);
      if (located.archived) throw new TaskGuardError("task_archived", `任务已归档: ${input.taskId}`);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      const previous = document.frontmatter.dependsOn ?? [];
      let next: string[];
      if (input.set !== undefined) {
        next = input.set;
      } else {
        const added = input.add ?? [];
        const removed = new Set(input.remove ?? []);
        next = [...previous.filter((id) => !removed.has(id)), ...added.filter((id) => !previous.includes(id))];
      }
      next = [...new Set(next)];
      const index = this.scheduleIndex(root);
      this.assertDependencies(input.taskId, next, index);
      const changed = next.length !== previous.length || next.some((id, at) => previous[at] !== id);
      if (changed) {
        assertStageWritable(workflowOf(root), document, "task depends");
        const updated = withRegions(document, { frontmatter: { ...document.frontmatter, dependsOn: next } });
        atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      }
      index.set(input.taskId, { ...(index.get(input.taskId) ?? scheduleEntryOf(document, false)), dependsOn: next });
      const blocked = dependencyBlockers(index.get(input.taskId) as ScheduleEntry, index);
      return { taskId: input.taskId, dependsOn: next, previous, changed, blocked };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * task order：只在目标优先级分组内调整业务顺序；写入该分组的 order 编号，
   * 不修改任何 createdAt，目录改名与其它调度事实不变。
   */
  async reorder(input: TaskOrderInput): Promise<TaskOrderResult> {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({ keys: orderKeys([{ scope: "project", rawKey: root }]), action: "task.order" });
    try {
      const entries = this.scheduleIndex(root);
      const planned = planReorder([...entries.values()], input.taskId, input.position);
      if ("allowed" in planned) {
        const detail = planned.reason === "order_reference_priority_mismatch"
          ? "参照任务与目标不在同一优先级；跨优先级先后由 priority 决定，不能由 task order 改写"
          : planned.reason;
        throw new TaskGuardError(planned.reason, `调整执行顺序被拒绝: ${detail}`);
      }
      const updated: string[] = [];
      const workflow = workflowOf(root);
      for (const { taskId, order } of planned.orders) {
        const entry = entries.get(taskId);
        if (entry === undefined || entry.order === order) continue;
        const located = this.locate(root, taskId);
        const file = join(located.dir, TASK_FILE);
        const before = readWithVersion(file);
        if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
        const document = parseTaskDocument(before.data.toString("utf8"), file);
        assertStageWritable(workflow, document, "task order");
        const next = withRegions(document, { frontmatter: { ...document.frontmatter, order } });
        atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(next), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
        updated.push(taskId);
      }
      // 返回真实执行顺序（优先级 → 业务顺序），而不是写入顺序号时的物理列表。
      const after = new Map(entries);
      for (const { taskId, order } of planned.orders) {
        const entry = after.get(taskId);
        if (entry !== undefined) after.set(taskId, { ...entry, order });
      }
      const order = [...after.values()]
        .filter((entry) => entry.status === "open")
        .sort(compareSchedule)
        .map((entry) => entry.taskId);
      return { taskId: input.taskId, order, updated };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * task next：执行入口的只读视图。列表与主会话派发共用同一排序与阻塞判定，
   * 已结束或未满足前置依赖的任务不进入可执行集合（DESIGN §3.11）。
   */
  next(input: { dir: string }): TaskNextResult {
    const result = this.list({ dir: input.dir });
    const entries = result.active
      .filter((summary) => summary.status === "open")
      .map((summary) => ({
        taskId: summary.taskId,
        title: summary.title,
        priority: summary.priority,
        executable: summary.blocked.length === 0,
        blocked: summary.blocked,
        parent: summary.parent,
        stage: summary.stage,
        verification: summary.verification,
      }));
    return { entries, next: entries.find((entry) => entry.executable)?.taskId ?? null };
  }

  /**
   * 创建任务：唯一 ID、目录命名冲突短序号、frontmatter + 初始记录、binding 落库。
   * 授权与 Git HEAD／分支核实由调用方（CLI 入口）先行完成（DESIGN.md 第14.1节）。
   */
  async newTask(input: TaskNewInput): Promise<TaskNewResult> {
    const root = normalizeRoot(input.dir);
    assertFormalTaskEnvironment(root);
    // 与 close／setParent 共用项目锁：创建挂接与父任务完成扫描不交错。
    const lock = await this.locks.acquire({ keys: orderKeys([{ scope: "project", rawKey: root }]), action: "task.new" });
    try {
      return await this.createTask(root, input);
    } finally {
      this.locks.release(lock);
    }
  }

  /** newTask 的项目锁内实现；环境核实与授权由调用方先行完成。 */
  private async createTask(root: string, input: TaskNewInput): Promise<TaskNewResult> {
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
    const parentId = input.parent ?? null;
    const priority = input.priority ?? "P2";
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    if (parentId !== null) {
      // 父任务必须已存在、未归档且未结束；创建子任务不改变父任务的内容。
      const index = this.taskIndex(root);
      const parent = index.get(parentId);
      guardRejected(
        onParentAssigned({
          child: { status: "open", stage: "start", outcome: null, branch: null, pendingKind: null },
          childArchived: false,
          parentKnown: parent !== undefined,
          parent: parent === undefined ? null : factsOf(parent.document),
          parentArchived: parent?.archived ?? false,
          cycle: false,
        }),
        "task new --parent",
      );
    }
    if (dependsOn.length > 0) {
      // 依赖以稳定 ID 引用已存在任务；新建任务只可能成环于自身，仍统一核对。
      this.assertDependencies(taskId, dependsOn, this.scheduleIndex(root));
    }
    mkdirSync(dir, { recursive: false });
    const { inputsBody, progressBody } = renderInitialTaskBody(input.title);
    // 创建前凭据扫描：标题进入任务正文（任务032）。
    assertNoCredentials(renderInitialTaskBody(input.title).inputsBody + input.title, "任务创建");
    const verification = input.verification ?? DEFAULT_VERIFICATION;
    const frontmatter = {
      id: taskId,
      status: "open" as const,
      stage: "start" as const,
      outcome: null,
      branch: input.branch ?? null,
      verification,
      parent: parentId,
      priority,
      dependsOn,
      order: null,
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
    return { taskId, root, relativePath: binding.relativePath, title: input.title, branch: binding.branch, verification, parent: input.parent ?? null, priority, dependsOn };
  }

  /**
   * 任务列表：从任务目录派生（DESIGN.md 第2节）；frontmatter 为权威。
   * 活跃与归档按分区指纹记账：缓存命中时归档侧只做 O(月份) 目录 stat，
   * 不 stat／read 任何归档 task.md；只重算指纹变化的分区（任务 k-3d730c8907b3）。
   * 命中时返回缓存结果的浅拷贝；数组与条目已冻结，调用方不能污染缓存。
   */
  list(input: { dir: string }): TaskListResult {
    const root = normalizeRoot(input.dir);
    const loaded = loadTaskListPartitions(root, this.onListIo, "throw");
    if (loaded.cacheEntry !== null && loaded.cacheEntry.result !== null) {
      return { ...loaded.cacheEntry.result };
    }
    const result = mergeTaskListPartitions(root, loaded.active, loaded.archive);
    if (loaded.cacheEntry !== null) {
      freezeTaskListResult(result);
      loaded.cacheEntry.result = result;
    }
    return result;
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
      const workflow = workflowOf(root);
      if (previous === branch) {
        assertStageWritable(workflow, document, "task adopt");
        if (binding !== null && binding.branch !== branch) {
          await this.store.bindings.save({ ...binding, branch });
        } else if (binding === null) {
          // frontmatter 已绑当前分支但运行时绑定行缺失（如历史登记任务）：
          // adopt 补齐绑定行，使 run/deliver 等运行链路可用；不改变分支，不宣称 adopted。
          await this.store.bindings.save({
            taskId: input.taskId,
            repoRoot: root,
            relativePath: `${TASKS_DIR}/${basename(located.dir)}/${TASK_FILE}`,
            branch,
            lastRunIds: [],
            lastCheckRunId: null,
            repairCycleId: null,
            repairRounds: null,
            stopReason: null,
            confirmedInputsDigest: null,
            confirmedStandardsDigest: null,
            pendingDraft: null,
          });
        }
        return {
          taskId: input.taskId,
          branch,
          previousBranch: previous,
          adopted: false,
          checkInvalidated: false,
          stage: document.frontmatter.stage,
        };
      }
      // 纯分支变化只使检查失效；deliver 不再可交付时回到最后工作阶段，其余阶段保持。
      const transition = guardRejected(
        stageTransition(workflow, stageFactsOf(document, binding), { kind: "adopted" }),
        "task adopt",
      );
      const updated = withRegions(document, {
        frontmatter: {
          ...document.frontmatter,
          branch,
          status: transition.status,
          stage: transition.stage,
          outcome: transition.outcome,
        },
      });
      atomicWrite({
        path: file,
        data: Buffer.from(renderTaskDocument(updated), "utf8"),
        expectedSha256: before.sha256,
        mode: 0o644,
      });
      if (binding !== null) {
        await this.store.bindings.save({
          ...binding,
          branch,
          lastCheckRunId: null,
          lastImplement: null,
          stageVisits: transition.visits,
          stopReason: transition.stopReason,
        });
      }
      new RunStore(root).removeCompletion(input.taskId);
      new RunStore(root).removeImplementation(input.taskId);
      return {
        taskId: input.taskId,
        branch,
        previousBranch: previous,
        adopted: true,
        checkInvalidated: true,
        stage: transition.stage,
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * 设置完成验证要求：只在讨论阶段，作为任务输入的一部分。
   * 已进入实施/检查后先走 change 更新回讨论，避免静默改写已冻结要求。
   */
  async setVerification(input: TaskVerificationInput): Promise<TaskVerificationResult> {
    const root = normalizeRoot(input.dir);
    if (!["none", "self", "independent"].includes(input.verification)) {
      throw new TaskGuardError("invalid_verification", `未知验证要求: ${input.verification}`);
    }
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.verification",
    });
    try {
      const located = this.locate(root, input.taskId);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      const workflow = workflowOf(root);
      if (document.frontmatter.status !== "open") throw new TaskGuardError("task_not_open", "已结束任务不能修改验证要求");
      if (document.frontmatter.stage !== "start") {
        throw new TaskGuardError("phase_mismatch", "验证要求只能在讨论阶段设置；先 task update --kind change 回到讨论");
      }
      assertStageWritable(workflow, document, "task verification");
      const current = verificationModeOf(document.frontmatter);
      if (current === input.verification) {
        return { taskId: input.taskId, verification: current, stage: document.frontmatter.stage, changed: false };
      }
      const note = input.reason?.trim() ? `；理由: ${input.reason.trim()}` : "";
      const updated = withRegions(document, {
        frontmatter: { ...document.frontmatter, verification: input.verification },
        progressBody: `${document.progressBody.trimEnd()}\n\n### 验证要求调整\n\n- 时间: ${this.now().toISOString()}\n- 方式: ${current} → ${input.verification}${note}\n`,
      });
      atomicWrite({
        path: file,
        data: Buffer.from(renderTaskDocument(updated), "utf8"),
        expectedSha256: before.sha256,
        mode: 0o644,
      });
      const binding = await this.store.bindings.get(input.taskId);
      if (binding !== null) {
        await this.store.bindings.save({
          ...binding,
          lastCheckRunId: null,
          lastImplement: null,
        });
      }
      new RunStore(root).removeCompletion(input.taskId);
      new RunStore(root).removeImplementation(input.taskId);
      return { taskId: input.taskId, verification: input.verification, stage: document.frontmatter.stage, changed: true };
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
      if (!input.equivalent) {
        new RunStore(root).removeCompletion(input.taskId);
        new RunStore(root).removeImplementation(input.taskId);
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
      const workflow = workflowOf(root);
      assertStageWritable(workflow, document, "task record");
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

  /** 任务规划资料：列表／读取／保存／删除／冻结快照（DESIGN §3.4–3.6，任务045）。 */
  async listMaterials(input: { dir: string; taskId: string }) {
    const root = normalizeRoot(input.dir);
    this.locate(root, input.taskId);
    return listMaterials(root, input.taskId);
  }

  async readMaterial(input: { dir: string; taskId: string; path: string }) {
    const root = normalizeRoot(input.dir);
    this.locate(root, input.taskId);
    return readMaterial(root, input.taskId, input.path);
  }

  async saveMaterial(input: { dir: string; taskId: string; path: string; content: string; expectDigest?: string | null }) {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({ keys: [this.taskLockKey(root, input.taskId)], action: "task.material.save" });
    try {
      this.locate(root, input.taskId);
      return saveMaterial(root, input.taskId, { path: input.path, content: input.content, expectDigest: input.expectDigest });
    } finally {
      this.locks.release(lock);
    }
  }

  async deleteMaterial(input: { dir: string; taskId: string; path: string }) {
    const root = normalizeRoot(input.dir);
    const lock = await this.locks.acquire({ keys: [this.taskLockKey(root, input.taskId)], action: "task.material.delete" });
    try {
      this.locate(root, input.taskId);
      return deleteMaterial(root, input.taskId, input.path);
    } finally {
      this.locks.release(lock);
    }
  }

  async materialSnapshot(input: { dir: string; taskId: string }) {
    const root = normalizeRoot(input.dir);
    this.locate(root, input.taskId);
    return snapshotMaterials(root, input.taskId);
  }

  /**
   * task update：直接更新（--kind）或 apply/withdraw-pending（DESIGN.md 第3.8节）。
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
      stage: document.frontmatter.stage,
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
    const workflow = workflowOf(root);
    const prevDigest = binding?.confirmedInputsDigest ?? inputsDigestOf(before.data.toString("utf8"));
    const merged = this.mergeInputs(document, input.content);
    const nextDigest = inputsDigestOf(renderTaskDocument(merged));
    const digestChanged = nextDigest !== prevDigest;
    const transition = guardRejected(
      stageTransition(workflow, stageFactsOf(document, binding), { kind: "inputsUpdated", updateKind: input.kind, digestChanged, archived }),
      "task update",
    );
    const updated = withRegions(document, {
      inputsBody: merged.inputsBody,
      frontmatter: { ...document.frontmatter, status: transition.status, stage: transition.stage, outcome: transition.outcome },
    });
    assertNoCredentials(input.content, "任务输入更新");
    atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
    if (binding !== null) {
      await this.store.bindings.save({
        ...binding,
        pendingDraft: null,
        confirmedInputsDigest: nextDigest,
        stageVisits: transition.visits,
        stopReason: transition.stopReason,
      });
    }
    if (digestChanged || input.kind === "change" || document.frontmatter.status === "closed") {
      new RunStore(root).removeCompletion(input.taskId);
      new RunStore(root).removeImplementation(input.taskId);
    }
    return {
      taskId: input.taskId,
      applied: "direct",
      stage: transition.stage,
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
      const workflow = workflowOf(root);
      const facts = stageFactsOf(document, binding);
      facts.pendingKind = draft.kind;
      const merged = this.mergeInputs(document, draft.content);
      const nextDigest = inputsDigestOf(renderTaskDocument(merged));
      const transition = guardRejected(
        stageTransition(workflow, facts, {
          kind: "pendingResolved",
          updateKind: draft.kind,
          digestChanged: nextDigest !== draft.baselineDigest,
          archived: located.archived,
        }),
        "apply pending",
      );
      // 任务030：转移结果与正文一起写入权威任务文件，响应与磁盘一致。
      const updated = withRegions(merged, {
        frontmatter: { ...document.frontmatter, status: transition.status, stage: transition.stage, outcome: transition.outcome },
      });
      assertNoCredentials(draft.content, "应用输入草案");
      atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated)), expectedSha256: before.sha256, mode: 0o644 });
      await this.store.bindings.save({
        ...binding,
        pendingDraft: null,
        confirmedInputsDigest: nextDigest,
        stageVisits: transition.visits,
        stopReason: transition.stopReason,
      });
      new RunStore(root).removeCompletion(input.taskId);
      new RunStore(root).removeImplementation(input.taskId);
      return {
        taskId: input.taskId,
        applied: "pending_applied",
        stage: transition.stage,
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
        stage: document.frontmatter.stage,
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
    stage: string;
    confirmedInputsDigest: string;
    confirmedStandardsDigest: string;
  }> {
    if (typeof input.taskId !== "string" || input.taskId.trim() === "") {
      throw new TaskGuardError("invalid_request", "task ready 需要任务 ID");
    }
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
      // 实施前结构核对（DESIGN §4.2，任务049）：必需输入齐备；已承诺规划（plan.md 存在）的
      // 复杂任务须有实际计划内容。可选文件缺失不阻挡简单任务；语义判断属主 Agent。
      assertReadyStructural(document, located.dir);
      // 前置依赖铁律（DESIGN §3.11）：未满足依赖时不能进入实施，不依赖提示词提醒。
      const schedule = this.scheduleIndex(root);
      const entry = schedule.get(input.taskId) ?? scheduleEntryOf(document, false);
      const blockers = dependencyBlockers(entry, schedule);
      if (blockers.length > 0) {
        const detail = blockers.map((blocker) => `${blocker.taskId}(${blocker.problem})`).join(", ");
        throw new TaskGuardError("dependency_unmet", `前置依赖未满足，不能进入实施: ${detail}`);
      }
      const transition = guardRejected(
        stageTransition(workflowOf(root), stageFactsOf(document, await this.store.bindings.get(input.taskId)), { kind: "ready" }),
        "task ready",
      );
      const updated = withRegions(document, {
        frontmatter: { ...document.frontmatter, status: transition.status, stage: transition.stage, outcome: transition.outcome },
      });
      // 冻结的是 ready 后的输入区（含 status/stage 转移），不是转移前版本；
      // 否则后续检查会把刚确认的任务立即判为 stale。
      const confirmedInputsDigest = inputsDigestOf(renderTaskDocument(updated));
      const confirmedStandardsDigest = formalStandardsDigest(root);
      atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      const binding = await this.store.bindings.get(input.taskId);
      if (binding !== null) {
        await this.store.bindings.save({
          ...binding,
          confirmedInputsDigest,
          confirmedStandardsDigest,
          stageVisits: transition.visits,
          stopReason: transition.stopReason,
        });
      }
      new RunStore(root).removeCompletion(input.taskId);
      new RunStore(root).removeImplementation(input.taskId);
      return { taskId: input.taskId, stage: transition.stage, confirmedInputsDigest, confirmedStandardsDigest };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * task implement：记录主会话或用户实施事实（DESIGN §3.8）。
   * 没有 worker run 时，完成资格以本记录代替实施 run：输入摘要 + 成果路径指纹 + 实际验证。
   * 记录只在任务锁内写；输入变化、ready 或重新讨论后旧记录失效并被清理。
   */
  async implement(input: TaskImplementInput): Promise<TaskImplementResult> {
    const root = normalizeRoot(input.dir);
    const paths = [...new Set(input.paths.map((path) => path.trim()).filter((path) => path !== ""))];
    if (paths.length === 0) throw new TaskGuardError("invalid_request", "至少给出一个 --path（实际改动路径）");
    const validations = input.validations.map((line) => line.trim()).filter((line) => line !== "");
    if (validations.length === 0) {
      throw new TaskGuardError("invalid_request", "至少给出一条 --validation；没有验证请改用 task close --force");
    }
    const executor = input.executor ?? "main-session";
    assertFormalTaskEnvironment(root);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.implement",
    });
    try {
      const located = this.locate(root, input.taskId);
      if (located.archived) throw new TaskGuardError("task_archived", "已归档任务不能再记录实施事实");
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      if (document.frontmatter.status !== "open") throw new TaskGuardError("task_not_open", "已结束任务不能记录实施事实");
      const binding = await this.store.bindings.get(input.taskId);
      if (binding !== null && binding.pendingDraft !== null) {
        throw new TaskGuardError("pending_draft_exists", "存在未应用输入草案，先应用或撤回再记录实施");
      }
      const entries: ScopeEntry[] = paths.map((path) => {
        safeJoin(root, path);
        return currentEntry(root, path, { factsKind: true });
      });
      const digest = scopeDigest(entries);
      new RunStore(root).writeImplementation(input.taskId, {
        schemaVersion: 1,
        taskId: input.taskId,
        executor,
        inputsDigest: inputsDigestOf(before.data.toString("utf8")),
        entries,
        scopeDigest: digest,
        validations,
        unverified: (input.unverified ?? []).map((line) => line.trim()).filter((line) => line !== ""),
        summary: input.summary ?? null,
        recordedAt: this.now().toISOString(),
      });
      return {
        taskId: input.taskId,
        executor,
        paths,
        validations: validations.length,
        inputsDigest: inputsDigestOf(before.data.toString("utf8")),
        scopeDigest: digest,
      };
    } finally {
      this.locks.release(lock);
    }
  }

  /**
   * task close：业务结束（completed/cancelled/superseded）。
   * 与该任务启动／接收共用短临界区：任务短锁内核对 frontmatter 版本并收敛事实；
   * completed 先核对完成资格，存在未应用草案则拒绝；取消／替代撤回草案并留原因。
   * 迟到旧结果不得重开（STATES.md 第3、11节）。
   */
  async close(input: TaskCloseInput): Promise<TaskCloseResult> {
    const root = normalizeRoot(input.dir);
    const executionRoot = normalizeRoot(input.executionDir ?? input.dir);
    const evidenceRoot = normalizeRoot(input.evidenceRoot ?? input.dir);
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: "task.close",
    });
    try {
      const located = this.locate(executionRoot, input.taskId);
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      if (!input.runsSettled) {
        throw new TaskGuardError("runs_unsettled", "关闭前须先收敛该任务活动／未知运行与待接收结果");
      }
      if (this.runActivity !== null && !(await this.runActivity.settled(evidenceRoot, input.taskId))) {
        throw new TaskGuardError("runs_unsettled", "关闭时仍有活动／未知运行或待接收结果");
      }
      const binding = await this.store.bindings.get(input.taskId);
      if (binding === null) throw new TaskGuardError("binding_missing", "任务绑定缺失，无法核对完成资格");
      // 父任务总体验收（DESIGN §3.10）：子任务全部结束后仍需主会话给出验收依据，
      // 子任务完成本身不自动使父任务可完成。
      if (input.outcome === "completed") {
        const children = [...this.taskIndex(evidenceRoot).values()].filter(
          (entry) => entry.document.frontmatter.parent === input.taskId,
        );
        if (children.length > 0) {
          const openChildren = children
            .filter((entry) => entry.document.frontmatter.status === "open")
            .map((entry) => entry.document.frontmatter.id);
          guardRejected(onParentCompletion({ openChildren, reason: input.reason ?? null }), "task close");
        }
      }
      const pendingKind = binding.pendingDraft?.kind ?? null;
      const facts = stageFactsOf(document, binding);
      facts.pendingKind = pendingKind;
      const workflow = workflowOf(executionRoot);
      const completionService = new CompletionService({ store: this.store, now: this.now, randomHex: this.randomHex });
      const verification = verificationModeOf(document.frontmatter);
      if (input.force === true) {
        if (input.outcome !== "completed") {
          throw new TaskGuardError("invalid_request", "--force 只能与 --outcome completed 同用");
        }
        if (verification === "independent") {
          throw new TaskGuardError("invalid_request", "independent 验证不能用 --force 跳过正式检查");
        }
        if ((input.reason ?? "").trim() === "") {
          throw new TaskGuardError("invalid_request", "强制完成必须给出 --reason，写入完成凭据");
        }
      }
      const completion = input.outcome === "completed"
        ? input.force === true
          ? {
              allowed: true as const,
              mode: verification,
              implementedBy: "forced" as const,
              implementRunId: binding.lastImplement?.runId ?? null,
              checkRunId: null,
              unverified: ["用户强制完成：未核对实施记录与正式检查"],
              forcedReason: input.reason ?? null,
            }
          : await completionService.assess({
              root: evidenceRoot,
              executionDir: executionRoot,
              taskId: input.taskId,
              document,
              raw: before.data,
              binding,
            })
        : null;
      if (completion !== null && completion.allowed === false) {
        throw new TaskGuardError(completion.reason, `任务不能完成: ${completion.reason}`);
      }
      const transition = guardRejected(
        input.outcome === "completed"
          ? stageTransition(workflow, facts, { kind: "completed" })
          : stageTransition(workflow, facts, { kind: "closed", outcome: input.outcome }),
        "task close",
      );
      const hadPending = binding.pendingDraft !== null;
      const updated = withRegions(document, {
        frontmatter: { ...document.frontmatter, status: transition.status, stage: transition.stage, outcome: transition.outcome },
        progressBody: hadPending
          ? `${document.progressBody}\n### 关闭撤回输入草案\n\n- 时间: ${this.now().toISOString()}\n- 理由: 任务关闭（${input.outcome}），未应用草案不生效\n`
          : document.progressBody,
      });
      let recorded = false;
      try {
        if (completion !== null && completion.allowed === true) {
          completionService.record({
            root: evidenceRoot,
            taskId: input.taskId,
            document,
            raw: before.data,
            decision: completion,
            reason: input.reason ?? null,
          });
          recorded = true;
        }
        atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
      } catch (error) {
        if (recorded) new RunStore(evidenceRoot).removeCompletion(input.taskId);
        throw error;
      }
      if (binding !== null) {
        await this.store.bindings.save({
          ...binding,
          pendingDraft: null,
          stageVisits: transition.visits,
          stopReason: transition.stopReason,
        });
      }
      if (input.outcome !== "completed") {
        new RunStore(evidenceRoot).removeCompletion(input.taskId);
        new RunStore(evidenceRoot).removeImplementation(input.taskId);
      }
      return {
        taskId: input.taskId,
        status: transition.status,
        outcome: transition.outcome,
        stage: transition.stage,
        pendingWithdrawn: hadPending,
        ...(completion !== null && completion.allowed === true
          ? {
              verification: completion.mode,
              implementRunId: completion.implementRunId,
              checkRunId: completion.checkRunId,
              forced: completion.implementedBy === "forced",
              unverified: completion.unverified,
            }
          : {}),
      };
    } finally {
      this.locks.release(lock);
    }
  }

}
