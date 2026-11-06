/**
 * status 只读投影（DESIGN.md 第4.1节、STATES.md 第9节）。
 * 查询不接收结果、不推进阶段、不重派 worker；耗时与活动只作观察。
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { RunStore } from "../infrastructure/run-store.js";
import { LockManager } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { parseTaskDocument } from "./task-document.js";
import { priorityOf, verificationModeOf, type TaskPriority, type VerificationMode } from "../contracts/task-inputs.js";
import type { CompletionFile } from "../contracts/completion.js";
import { listTaskDirectories, locateTaskDocument } from "./task-service.js";
import { dependencyBlockersOf } from "./task-schedule.js";
import { readWithVersion } from "../infrastructure/atomic.js";
import { executionRouteOf } from "./worktree-routing.js";
import { loadWorkflow, workflowStageOf } from "./workflow.js";
import { RunCoordinator, type RunStatusProjection } from "./run-coordinator.js";
import type { TaskBinding } from "../contracts/metadata.js";
import type { RunDiagnosticsFile } from "../contracts/run.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { readFileSync } from "node:fs";

export interface RunHeartbeat {
  at: string;
  verdict: "alive" | "not_alive" | "unknown";
}

export interface RunStatusView extends RunStatusProjection {
  /** 任务标题；任务文档缺失或不可读时为 null（归档任务仍可读到）。 */
  taskTitle: string | null;
  /** 任务目录名去掉日期前缀；任务文档缺失时为 null。 */
  taskSlug: string | null;
  /** 阶段显示名：生效流程中的 name，缺失或降级时退回 phase。 */
  stageName: string;
  elapsedMs: number;
  /** 本 run 的执行目录；主检出路由为主检出根，worktree 路由为 worktree 路径（任务17）。 */
  executionDir: string;
  lastActivityAt: string | null;
  heartbeat: RunHeartbeat | null;
  /** runtime_start_failed 前缀失败时读取的启动诊断（diagnostics.json）；只作辅助证据，其余失败为 null。 */
  startupDiagnostics: RunDiagnosticsFile | null;
}

export interface TaskStatusView {
  taskId: string;
  title: string;
  status: string;
  /** 任务阶段：锚点 start／deliver 或当前流程配置里的阶段 id。 */
  stage: string;
  /** 阶段显示名：生效流程中的 name，缺失或降级时退回 stage。 */
  stageName: string;
  outcome: string | null;
  branch: string | null;
  relativePath: string;
  archived: boolean;
  createdAt: string;
  binding: TaskBinding | null;
  pendingDraft: TaskBinding["pendingDraft"];
  scopeCount: number;
  verification: VerificationMode;
  /** 父任务稳定身份；顶层任务为 null（DESIGN §3.10）。 */
  parent: string | null;
  /** 直接子任务及其结束情况；父子关系由子任务 frontmatter 派生。 */
  children: Array<{ taskId: string; status: string; outcome: string | null }>;
  /** 任务自身优先级；缺省 P2（DESIGN §3.11）。 */
  priority: TaskPriority;
  /** 前置依赖与当前阻塞原因；未满足时实施入口不启动。 */
  dependsOn: string[];
  blocked: Array<{ taskId: string; problem: string; status: string | null; outcome: string | null }>;
  lastCheckRunId: string | null;
  completion: CompletionFile | null;
  runs: RunStatusView[];
  latestRun: RunStatusView | null;
  activeRuns: number;
}

export interface StatusOverview {
  generatedAt: string;
  readOnly: true;
  tasks: Array<{
    taskId: string;
    title: string;
    status: string;
    stage: string;
    stageName: string;
    outcome: string | null;
    relativePath: string;
    archived: boolean;
    activeRuns: number;
  }>;
  activeRuns: RunStatusView[];
}

export interface StatusInput {
  dir: string;
  taskId?: string;
  runId?: string;
  /** 与 run start 使用的锁根一致；默认 ~/.knit/locks。 */
  locksRoot?: string;
}

export class StatusService {
  private readonly store: MetadataStore;
  private readonly now: () => Date;
  private readonly lockRoot: string | undefined;

  constructor(options: { store: MetadataStore; now?: () => Date; locksRoot?: string }) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.lockRoot = options.locksRoot;
  }

  async status(input: StatusInput): Promise<RunStatusView | TaskStatusView | StatusOverview> {
    const root = normalizeRoot(input.dir);
    if (input.runId !== undefined) return this.runStatus(root, input.runId, input.locksRoot);
    if (input.taskId !== undefined) return this.taskStatus(root, input.taskId, input.locksRoot);
    return this.overview(root, input.locksRoot);
  }

  async runStatus(root: string, runId: string, locksRoot?: string): Promise<RunStatusView> {
    const coordinator = new RunCoordinator({ store: this.store, lockRoot: locksRoot ?? this.lockRoot });
    const projection = await coordinator.status({ dir: root, runId });
    const end = projection.state === "completed" || projection.state === "cancelled" || projection.state === "failed"
      ? Date.parse(projection.updatedAt)
      : this.now().getTime();
    const start = Date.parse(projection.createdAt);
    const lastActivityAt = [projection.updatedAt, projection.lastEventAt]
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
    const failureReason = projection.result?.failureReason ?? null;
    const startupDiagnostics =
      failureReason !== null && failureReason.startsWith("runtime_start_failed")
        ? new RunStore(root).readDiagnostics(runId)
        : null;
    // 心跳按本 run 的执行目录观察：worktree 路由的 project 锁不再占用主检出键（任务17）。
    const executionDir = await this.executionDirOf(root, runId);
    const task = this.taskDocumentOf(root, projection.taskId);
    const workflow = loadWorkflow(root).workflow;
    return {
      ...projection,
      taskTitle: task?.title ?? null,
      taskSlug: task?.slug ?? null,
      stageName: workflowStageOf(workflow, projection.phase)?.name ?? projection.phase,
      elapsedMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
      executionDir,
      lastActivityAt,
      heartbeat: this.heartbeat(locksRoot ?? this.lockRoot, executionDir),
      startupDiagnostics,
    };
  }

  async taskStatus(root: string, taskId: string, locksRoot?: string): Promise<TaskStatusView> {
    const located = locateTaskDocument(root, taskId);
    const document = parseTaskDocument(located.raw.toString("utf8"), join(located.dir, "task.md"));
    const workflow = loadWorkflow(root).workflow;
    const binding = await this.store.bindings.get(taskId);
    const runs = await this.taskRuns(root, taskId, locksRoot);
    const children: Array<{ taskId: string; status: string; outcome: string | null }> = [];
    for (const { name } of listTaskDirectories(root)) {
      const file = join(root, ".knit", "tasks", name, "task.md");
      const raw = readWithVersion(file);
      if (raw === null) continue;
      try {
        const child = parseTaskDocument(raw.data.toString("utf8"), file);
        if ((child.frontmatter.parent ?? null) !== taskId) continue;
        children.push({ taskId: child.frontmatter.id, status: child.frontmatter.status, outcome: child.frontmatter.outcome });
      } catch {
        // 损坏的其它任务不阻塞当前任务状态；doctor 另行报告。
      }
    }
    return {
      taskId,
      title: document.frontmatter.title,
      status: document.frontmatter.status,
      stage: document.frontmatter.stage,
      stageName: workflowStageOf(workflow, document.frontmatter.stage)?.name ?? document.frontmatter.stage,
      outcome: document.frontmatter.outcome,
      branch: document.frontmatter.branch,
      relativePath: relative(root, join(located.dir, "task.md")),
      archived: located.archived,
      createdAt: document.frontmatter.createdAt,
      binding,
      pendingDraft: binding?.pendingDraft ?? null,
      scopeCount: binding?.scope?.length ?? 0,
      verification: verificationModeOf(document.frontmatter),
      parent: document.frontmatter.parent ?? null,
      children,
      priority: priorityOf(document.frontmatter),
      dependsOn: document.frontmatter.dependsOn ?? [],
      blocked: dependencyBlockersOf(root, taskId),
      lastCheckRunId: binding?.lastCheckRunId ?? null,
      completion: new RunStore(root).readCompletion(taskId),
      runs,
      latestRun: runs.at(-1) ?? null,
      activeRuns: runs.filter((run) => !["completed", "cancelled", "failed"].includes(run.state)).length,
    };
  }

  async overview(root: string, locksRoot?: string): Promise<StatusOverview> {
    const tasks: StatusOverview["tasks"] = [];
    const workflow = loadWorkflow(root).workflow;
    const runsRoot = new RunStore(root).listRunIds();
    const allRuns: RunStatusView[] = [];
    for (const runId of runsRoot) {
      try {
        allRuns.push(await this.runStatus(root, runId, locksRoot));
      } catch {
        // 损坏或未完成的 run 目录不阻塞概览。
      }
    }
    for (const task of await this.listTasks(root)) {
      const taskRuns = allRuns.filter((run) => run.taskId === task.taskId);
      tasks.push({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        stage: task.stage,
        stageName: workflowStageOf(workflow, task.stage)?.name ?? task.stage,
        outcome: task.outcome,
        relativePath: task.relativePath,
        archived: task.archived,
        activeRuns: taskRuns.filter((run) => !["completed", "cancelled", "failed"].includes(run.state)).length,
      });
    }
    return {
      generatedAt: this.now().toISOString(),
      readOnly: true,
      tasks,
      activeRuns: allRuns.filter((run) => !["completed", "cancelled", "failed"].includes(run.state)),
    };
  }

  private async listTasks(root: string): Promise<Array<{ taskId: string; title: string; status: string; stage: string; outcome: string | null; relativePath: string; archived: boolean }>> {
    // 统一任务发现（listTaskDirectories）：活动 tasks/<name> 与归档 archive/<YYYY-MM>/<name>（任务041）。
    // 损坏任务不阻塞概览；重复 ID 如实列出并按路径区分；不跟随符号链接（只认目录与 task.md）。
    const result: Array<{ taskId: string; title: string; status: string; stage: string; outcome: string | null; relativePath: string; archived: boolean }> = [];
    for (const { name, archived } of listTaskDirectories(root)) {
      const file = join(root, ".knit", "tasks", name, "task.md");
      if (!existsSync(file)) continue;
      try {
        const document = parseTaskDocument(readFileSync(file, "utf8"), file);
        result.push({
          taskId: document.frontmatter.id,
          title: document.frontmatter.title,
          status: document.frontmatter.status,
          stage: document.frontmatter.stage,
          outcome: document.frontmatter.outcome,
          relativePath: `tasks/${name}`,
          archived,
        });
      } catch {
        // 损坏任务不阻塞概览；doctor 另行报告。
      }
    }
    return result;
  }

  /** 只读定位任务文档（含归档）；缺失或损坏按展示缺失处理，不影响 run 状态。 */
  private taskDocumentOf(root: string, taskId: string): { title: string | null; slug: string } | null {
    try {
      const located = locateTaskDocument(root, taskId);
      const document = parseTaskDocument(located.raw.toString("utf8"), join(located.dir, "task.md"));
      const title = document.frontmatter.title.trim();
      return { title: title === "" ? null : title, slug: basename(located.dir).replace(/^\d{2}-\d{2}-/, "") };
    } catch {
      return null;
    }
  }

  private async taskRuns(root: string, taskId: string, locksRoot?: string): Promise<RunStatusView[]> {
    const runs = new RunStore(root).listRunIds();
    const result: RunStatusView[] = [];
    for (const runId of runs) {
      try {
        const view = await this.runStatus(root, runId, locksRoot);
        if (view.taskId === taskId) result.push(view);
      } catch {
        // 忽略不可读 run；doctor 报告存储状态。
      }
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 只读推导 run 的执行目录：优先使用请求冻结的 expected.executionDir（worker 同口径），
   * 旧请求缺省时按绑定路由回退；都不阻塞状态投影。 */
  private async executionDirOf(root: string, runId: string): Promise<string> {
    try {
      const request = new RunStore(root).readRequest(runId);
      if (request === null) return root;
      if (request.expected.executionDir !== undefined && request.expected.executionDir !== null) {
        return request.expected.executionDir;
      }
      const binding = await this.store.bindings.get(request.taskId);
      return executionRouteOf(binding, root).dir;
    } catch {
      return root;
    }
  }

  private heartbeat(locksRoot: string | undefined, executionDir: string): RunHeartbeat | null {
    try {
      const manager = new LockManager(locksRoot === undefined ? {} : { root: locksRoot });
      const status = manager.inspect({ scope: "project", rawKey: executionDir });
      if (status.owner === null) return null;
      return { at: status.owner.heartbeatAt, verdict: status.processVerdict };
    } catch {
      return null;
    }
  }
}
