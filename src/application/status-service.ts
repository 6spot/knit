/**
 * status 只读投影（DESIGN.md 第4.1节、STATES.md 第9节）。
 * 查询不接收结果、不推进阶段、不重派 worker；耗时与活动只作观察。
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { RunStore } from "../infrastructure/run-store.js";
import { LockManager } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { parseTaskDocument } from "./task-document.js";
import { locateTaskDocument } from "./task-service.js";
import { RunCoordinator, type RunStatusProjection } from "./run-coordinator.js";
import type { TaskBinding } from "../contracts/metadata.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { readFileSync } from "node:fs";

export interface RunHeartbeat {
  at: string;
  verdict: "alive" | "not_alive" | "unknown";
}

export interface RunStatusView extends RunStatusProjection {
  elapsedMs: number;
  lastActivityAt: string | null;
  heartbeat: RunHeartbeat | null;
}

export interface TaskStatusView {
  taskId: string;
  title: string;
  status: string;
  phase: string;
  outcome: string | null;
  branch: string | null;
  relativePath: string;
  archived: boolean;
  createdAt: string;
  binding: TaskBinding | null;
  pendingDraft: TaskBinding["pendingDraft"];
  scopeCount: number;
  lastCheckRunId: string | null;
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
    phase: string;
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
    return {
      ...projection,
      elapsedMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
      lastActivityAt,
      heartbeat: this.heartbeat(root, locksRoot ?? this.lockRoot),
    };
  }

  async taskStatus(root: string, taskId: string, locksRoot?: string): Promise<TaskStatusView> {
    const located = locateTaskDocument(root, taskId);
    const document = parseTaskDocument(located.raw.toString("utf8"), join(located.dir, "task.md"));
    const binding = await this.store.bindings.get(taskId);
    const runs = await this.taskRuns(root, taskId, locksRoot);
    return {
      taskId,
      title: document.frontmatter.title,
      status: document.frontmatter.status,
      phase: document.frontmatter.phase,
      outcome: document.frontmatter.outcome,
      branch: document.frontmatter.branch,
      relativePath: relative(root, join(located.dir, "task.md")),
      archived: located.archived,
      createdAt: document.frontmatter.createdAt,
      binding,
      pendingDraft: binding?.pendingDraft ?? null,
      scopeCount: binding?.scope?.length ?? 0,
      lastCheckRunId: binding?.lastCheckRunId ?? null,
      runs,
      latestRun: runs.at(-1) ?? null,
      activeRuns: runs.filter((run) => !["completed", "cancelled", "failed"].includes(run.state)).length,
    };
  }

  async overview(root: string, locksRoot?: string): Promise<StatusOverview> {
    const tasks: StatusOverview["tasks"] = [];
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
        phase: task.phase,
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

  private async listTasks(root: string): Promise<Array<{ taskId: string; title: string; status: string; phase: string; outcome: string | null; relativePath: string; archived: boolean }>> {
    const tasksRoot = join(root, ".knit", "tasks");
    if (!existsSync(tasksRoot)) return [];
    const result: Array<{ taskId: string; title: string; status: string; phase: string; outcome: string | null; relativePath: string; archived: boolean }> = [];
    const walk = (dir: string, relative: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "archive") {
          walk(join(dir, entry.name), `${relative}/archive`);
          continue;
        }
        const file = join(dir, entry.name, "task.md");
        if (!existsSync(file)) continue;
        try {
          const document = parseTaskDocument(readFileSync(file, "utf8"), file);
          result.push({
            taskId: document.frontmatter.id,
            title: document.frontmatter.title,
            status: document.frontmatter.status,
            phase: document.frontmatter.phase,
            outcome: document.frontmatter.outcome,
            relativePath: `${relative}/${entry.name}`,
            archived: relative.includes("archive"),
          });
        } catch {
          // 损坏任务不阻塞概览；doctor 另行报告。
        }
      }
    };
    walk(tasksRoot, "tasks");
    return result;
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

  private heartbeat(root: string, locksRoot?: string): RunHeartbeat | null {
    try {
      const manager = new LockManager(locksRoot === undefined ? {} : { root: locksRoot });
      const status = manager.inspect({ scope: "project", rawKey: root });
      if (status.owner === null) return null;
      return { at: status.owner.heartbeatAt, verdict: status.processVerdict };
    } catch {
      return null;
    }
  }
}
