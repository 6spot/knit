/**
 * 每轮上下文的一次性只读投影（k-0524fc52e81b）：选择、任务状态、规划资料与 nextAction。
 * 桥接每轮只调一次 CLI，超时由桥接侧用上一轮缓存兜底；这里只做读取，不推进业务状态。
 */
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { SessionService } from "./session-service.js";
import { StatusService, type TaskNextAction } from "./status-service.js";
import { listTaskMaterials, type TaskMaterialEntry } from "./task-materials.js";
import { resolveProjectStart } from "./worktree-routing.js";

/** 注入所需的轻量任务视图：不含 run 诊断、凭据与子任务明细。 */
export interface SessionContextTaskView {
  taskId: string;
  title: string;
  status: string;
  stage: string;
  stageName: string;
  outcome: string | null;
  branch: string | null;
  relativePath: string;
  archived: boolean;
  pendingDraft: TaskBinding["pendingDraft"];
  clarify: { blocking: number; assumed: number };
  /** 未到终态的 run；每轮只提示 ID 与状态。 */
  activeRuns: Array<{ runId: string; state: string }>;
}

export interface SessionContextView {
  knitSessionId: string;
  /** 当前生效选择；无选择或选择失效时为 null。 */
  taskId: string | null;
  effective: boolean;
  branch: string | null;
  /** native：当前有效路径上的选择事件；index：仅索引快照。 */
  source: "native" | "index";
  entryRef: string | null;
  reason: string | null;
  task: SessionContextTaskView | null;
  materials: TaskMaterialEntry[];
  nextAction: TaskNextAction | null;
}

const TERMINAL_RUN_STATES = new Set(["completed", "cancelled", "failed"]);

export async function buildSessionContext(input: {
  store: MetadataStore;
  dir: string;
  knitSessionId: string;
}): Promise<SessionContextView> {
  const root = normalizeRoot(input.dir);
  const resolution = await new SessionService({ store: input.store }).resolveSelection(root, input.knitSessionId);
  const taskId =
    resolution.effective === true && typeof resolution.taskId === "string" && resolution.taskId !== ""
      ? resolution.taskId
      : null;
  const base = {
    knitSessionId: resolution.knitSessionId,
    taskId,
    effective: resolution.effective,
    branch: resolution.branch,
    source: resolution.source,
    entryRef: resolution.entryRef,
    reason: resolution.reason,
  } as const;
  if (taskId === null) return { ...base, task: null, materials: [], nextAction: null };
  // 任务资料与元数据库在主检出；worktree 内调用按主检出读取，不新建副本。
  const mainRoot = resolveProjectStart(root).mainRoot;
  const view = await new StatusService({ store: input.store }).taskStatus(mainRoot, taskId);
  return {
    ...base,
    task: {
      taskId: view.taskId,
      title: view.title,
      status: view.status,
      stage: view.stage,
      stageName: view.stageName,
      outcome: view.outcome,
      branch: view.branch,
      relativePath: view.relativePath,
      archived: view.archived,
      pendingDraft: view.pendingDraft,
      clarify: view.clarify,
      activeRuns: view.runs
        .filter((run) => !TERMINAL_RUN_STATES.has(run.state))
        .map((run) => ({ runId: run.runId, state: run.state })),
    },
    materials: listTaskMaterials(mainRoot, taskId),
    nextAction: view.nextAction,
  };
}
