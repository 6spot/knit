/**
 * status 只读投影（DESIGN.md 第4.1节、STATES.md 第9节）。
 * 查询不接收结果、不推进阶段、不重派 worker；耗时与活动只作观察。
 */
import { basename, join, relative } from "node:path";
import { RunStore } from "../infrastructure/run-store.js";
import { LockManager } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { parseTaskDocument } from "./task-document.js";
import { clarifyStateOf, priorityOf, verificationModeOf, type TaskPriority, type VerificationMode } from "../contracts/task-inputs.js";
import type { CompletionFile } from "../contracts/completion.js";
import { listTaskDirectories, locateTaskDocument, taskListOverviewSummaries } from "./task-service.js";
import { dependencyBlockersOf } from "./task-schedule.js";
import { readWithVersion } from "../infrastructure/atomic.js";
import { executionRouteOf } from "./worktree-routing.js";
import { loadWorkflow } from "./workflow.js";
import { workflowStageDisplayName } from "../domain/workflow.js";
import { RunCoordinator, type RunStatusProjection } from "./run-coordinator.js";
import type { TaskBinding } from "../contracts/metadata.js";
import type { RunDiagnosticsFile } from "../contracts/run.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { checkerChangedPathsOf, verificationLabel } from "../domain/completion.js";
import { inputsDigestOf } from "../contracts/task-inputs.js";
import type { WorkflowDefinition } from "../domain/workflow.js";

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
  /** Rex 启动诊断（rex-diagnostics.json）：Rex 启动失败或 auto 回退 local 时的原始错误、块状态与 Rex 侧 stderr；没有为 null。 */
  rexDiagnostics: RunDiagnosticsFile | null;
  /** 待处理结果的下一步；覆盖 needs_attention: stale_input 与 unattributed_paths、检查者修复后的复查，其余为空。 */
  nextActions: string[];
  /** 已发布检查凭据中检查者自行修复的路径；非检查 run 或无修复为空。 */
  checkerChangedPaths: string[];
  /** 检查 run 的验证方式标注；检查者修复过路径时写明修复部分为自检，非检查 run 为 null。 */
  verificationLabel: string | null;
  /** 空报告的实施 run 已接收时为“本轮未产生成果…”，其它为 null（审计 F4）。 */
  noOutputNotice: string | null;
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
  /** task.md「待澄清」计数；blocking > 0 时 `task ready` 拒绝，无区段为 0。 */
  clarify: { blocking: number; assumed: number };
  lastCheckRunId: string | null;
  /** 验证方式标注：最新检查（或完成凭据）带检查者修复时写成「independent（检查者修复 N 个路径，修复部分为自检）」。 */
  verificationLabel: string;
  /** 最新检查凭据中检查者自行修复的路径；非空时 independent 任务完成被 check_self_modified 拒绝。 */
  lastCheckChangedPaths: string[];
  /** 完成验证要求与当前任务卡点的确定性下一步（按优先级取第一条）；已结束且无后续时为 null。 */
  nextAction: TaskNextAction | null;
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

/**
 * 任务级下一步（审计 S2／S3／中等 9）：只读事实推导，同一现场总给同一条。
 * kind 按优先级：binding_missing > run_*（未启动／活动／worker 已退出／待接收）> pending_draft >
 * lock_residue > run_needs_attention > inputs_changed > stage（按当前阶段推进）。
 */
export interface TaskNextAction {
  kind:
    | "binding_missing"
    | "pending_draft"
    | "run_not_started"
    | "run_active"
    | "run_stage_alive"
    | "run_worker_exited"
    | "run_pending_acceptance"
    | "lock_residue"
    | "run_needs_attention"
    | "inputs_changed"
    | "stage";
  /** 一句话原因（含事实依据）。 */
  summary: string;
  /** 可直接执行的命令；尖括号为需要填写的占位。 */
  commands: string[];
  /** 相关 run；无为 null。 */
  runId: string | null;
}

export interface StatusInput {
  dir: string;
  taskId?: string;
  runId?: string;
  /** 与 run start 使用的锁根一致；默认 ~/.knit/locks。 */
  locksRoot?: string;
}

/**
 * needs_attention: stale_input 的出口（STATES.md 第3节）：结果与工作区保留、不计为当前规格的成果，
 * 不提供强制接受；只有按当前输入重新派发一条路。
 */
function staleInputNextActions(
  projection: RunStatusProjection,
  task: { status: string; stage: string } | null,
): string[] {
  if (projection.acceptance?.state !== "needs_attention" || projection.acceptance.reason !== "stale_input") return [];
  const actions = [`运行期间输入已变：结果与工作区已保留，不计为当前规格的成果；核对差异用 git diff 或 knit snapshot show ${projection.runId}`];
  if (task === null || task.status !== "open") return actions;
  if (task.stage === "start") {
    actions.push(`重新确认输入后 knit task ready ${projection.taskId}，再派发新 run`);
  } else if (task.stage !== "deliver") {
    actions.push(`按当前输入派发新 run：knit run prepare --task ${projection.taskId} --stage ${task.stage}，再 knit run start <run-id>`);
  }
  return actions;
}

/**
 * needs_attention: unattributed_paths 的出口（DESIGN §5.3）：来源不明的路径等主会话确认，
 * `run accept --include` 按当前指纹并入 scope，`--exclude` 不进 scope、不进交付。
 */
function unattributedNextActions(projection: RunStatusProjection): string[] {
  const reason = projection.acceptance?.reason ?? null;
  if (projection.acceptance?.state !== "needs_attention" || reason === null || !reason.startsWith("unattributed_paths")) return [];
  const paths = reason.slice("unattributed_paths:".length).split(",").filter((path) => path !== "");
  const listed = paths.length > 0 ? paths.join(" ") : "<path>";
  return [
    `来源不明的改动（非 write／edit 工具写入）：${paths.join(", ") || "见 result.attribution.unattributedPaths"}；核对内容后确认归属`,
    `并入 scope：knit run accept ${projection.runId} --include ${listed} --reason <原因>；排除：knit run accept ${projection.runId} --exclude ${listed} --reason <原因>`,
  ];
}

/**
 * 检查者修复过路径的检查 run（DESIGN §5.1）：修复部分只算自检；independent 任务须再派一次
 * 未改动文件且 pass 的检查，凭据替换后 task close 才不再报 check_self_modified。
 */
function checkerRepairNextActions(projection: RunStatusProjection, paths: string[], verification: VerificationMode | null): string[] {
  if (paths.length === 0) return [];
  const actions = [`检查者修复 ${paths.length} 个路径（${paths.slice(0, 10).join(", ")}${paths.length > 10 ? " 等" : ""}），修复部分为自检，不算独立复核`];
  if ((verification ?? "independent") === "independent") {
    actions.push(`independent 完成前须再派一次未改动文件且 pass 的检查：knit run check --task ${projection.taskId}`);
  }
  return actions;
}

/**
 * 空报告的实施 run 已接收（审计 F4）：报告没有列出任何成果路径，scope 未增加。
 * 只提示不拦；完成时由 empty_scope 守卫要求登记成果或显式声明无产物。
 */
export function noOutputNoticeOf(projection: RunStatusProjection): string | null {
  if (projection.acceptance?.state !== "completed" || projection.acceptance.reason !== "implementation_accepted") return null;
  const result = projection.result;
  if (result === null || result.state !== "completed") return null;
  const claimed = result.attribution?.claimedPaths ?? result.actualChangedPaths;
  return claimed.length === 0 ? "本轮未产生成果：报告未列出改动路径，scope 未增加" : null;
}

function noOutputNextActions(projection: RunStatusProjection, notice: string | null): string[] {
  if (notice === null) return [];
  return [
    `${notice}；产物已在工作区但未归属时用 knit task implement ${projection.taskId} --path <路径> --validation <验证> 登记，确实没有产物时 knit task close ${projection.taskId} --outcome completed --no-artifacts --reason <原因>`,
  ];
}

const TERMINAL_RUN_STATES = new Set(["completed", "cancelled", "failed"]);

/** Rex 启动诊断只读；文件缺失或损坏都按 null，不影响状态投影。 */
function rexDiagnosticsOf(root: string, runId: string): RunDiagnosticsFile | null {
  try {
    return new RunStore(root).readRexDiagnostics(runId);
  } catch {
    return null;
  }
}

/** 任务卡点推导所需的只读事实；由 taskStatus 收集后交给纯函数，便于单测。 */
export interface TaskNextActionFacts {
  taskId: string;
  status: string;
  stage: string;
  verification: VerificationMode;
  archived: boolean;
  binding: TaskBinding | null;
  /** 当前 task.md 输入区摘要（与 binding.confirmedInputsDigest 同口径）。 */
  currentInputsDigest: string;
  runs: RunStatusView[];
  /** 本任务执行目录的项目锁残留（owner 已不在或无法核实，且没有活动 run 持有）。 */
  lockResidue: { id: string; token: string | null; verdict: "alive" | "not_alive" | "unknown"; reclaimable: boolean } | null;
  workflow: WorkflowDefinition;
  /** 最新检查凭据带检查者修复路径；independent 须再派一次未改动文件的检查。 */
  checkerRepaired: boolean;
}

function runLabel(run: RunStatusView): string {
  return `${run.runId}（${run.phase}/${run.state}）`;
}

/**
 * 任务级确定性下一步（审计 S2／S3／中等 9）：只看已落盘事实，同一现场总是同一条。
 * 不代替守卫：给出的命令仍由核心按授权／阶段／锁／版本重新核对。
 */
export function taskNextAction(facts: TaskNextActionFacts): TaskNextAction | null {
  const id = facts.taskId;
  if (facts.status !== "open" || facts.archived) return null;
  // 无绑定：本机没有确认摘要、scope 与凭据（常见于 clone 后），跨机重建由 k-434714cbbb68 提供。
  if (facts.binding === null) {
    return {
      kind: "binding_missing",
      summary: `任务在本机没有绑定（确认摘要、scope 与凭据是本机事实）；常见于 clone／换机后，参见跨机任务（task rebind）`,
      commands: [`knit task adopt ${id} --branch current`],
      runId: null,
    };
  }
  const binding = facts.binding;
  // 未收敛的 run：按最近一条给出口；未知存活不冒充死亡。
  const pendingRuns = facts.runs.filter((run) => !TERMINAL_RUN_STATES.has(run.state));
  const latestPending = pendingRuns.at(-1) ?? null;
  if (latestPending !== null) {
    const run = latestPending;
    if (run.launchState === "planned" || run.workerVerdict === "absent") {
      return {
        kind: "run_not_started",
        summary: `run ${runLabel(run)} 只准备了、worker 未启动`,
        commands: [`knit run start ${run.runId}`, `knit run cancel ${run.runId} --reason <原因>`],
        runId: run.runId,
      };
    }
    if (run.workerVerdict === "alive" || run.workerVerdict === "unknown" || run.result !== null) {
      if (run.result !== null && run.workerVerdict === "not_alive") {
        return {
          kind: "run_pending_acceptance",
          summary: `run ${runLabel(run)} 已发布结果（${run.result.state}）但未接收`,
          commands: [`knit run accept ${run.runId}`],
          runId: run.runId,
        };
      }
      return {
        kind: "run_active",
        summary: `run ${runLabel(run)} 执行中（worker ${run.workerVerdict}）；使用冻结输入，等它结束或取消`,
        commands: [`knit status --run ${run.runId}`, `knit run cancel ${run.runId} --reason <原因>`],
        runId: run.runId,
      };
    }
    // worker 已确认退出且无结果：阶段 Pi 仍在时先终止，否则 resume 收敛并真启动新 run。
    if (run.stageProcessVerdict === "alive" || run.stageProcessVerdict === "unknown") {
      return {
        kind: "run_stage_alive",
        summary: `run ${runLabel(run)} 的 worker 已退出，但阶段 Pi／工具仍在或无法核实（${run.stageProcessVerdict}）`,
        commands: [`knit run cancel ${run.runId} --terminate --reason <原因>`, `knit run resume ${run.runId}`],
        runId: run.runId,
      };
    }
    return {
      kind: "run_worker_exited",
      summary: `run ${runLabel(run)} 的 worker 已退出且没有结果`,
      commands: [`knit run resume ${run.runId}`],
      runId: run.runId,
    };
  }
  // 终态但接收未完成：结果已发布，接收操作缺失（崩溃在发布与接收之间）。
  const unaccepted = facts.runs.filter((run) => run.result !== null && run.acceptance === null).at(-1) ?? null;
  if (unaccepted !== null) {
    return {
      kind: "run_pending_acceptance",
      summary: `run ${runLabel(unaccepted)} 已发布结果（${unaccepted.result?.state ?? "?"}）但未接收`,
      commands: [`knit run accept ${unaccepted.runId}`],
      runId: unaccepted.runId,
    };
  }
  // 待应用草案：旧执行已收敛后才能应用；优先于锁与阶段推进。
  if (binding.pendingDraft !== null) {
    return {
      kind: "pending_draft",
      summary: `有待应用的 ${binding.pendingDraft.kind} 草案；应用或撤回后再推进`,
      commands: [
        `knit task update ${id} --apply-pending --expect-pending ${binding.pendingDraft.digest}`,
        `knit task update ${id} --withdraw-pending --expect-pending ${binding.pendingDraft.digest} --reason <原因>`,
      ],
      runId: null,
    };
  }
  if (facts.lockResidue !== null) {
    const lock = facts.lockResidue;
    const token = lock.token ?? "<token>";
    return {
      kind: "lock_residue",
      summary: `执行目录锁 ${lock.id} 残留（owner 核实 ${lock.verdict}，无活动 run 持有）${lock.reclaimable ? "；下次取锁会自动回收" : ""}`,
      commands: [
        `knit locks --dir .`,
        `knit unlock ${lock.id} --expect-token ${token}${lock.verdict === "not_alive" ? "" : " --force"}`,
      ],
      runId: null,
    };
  }
  // 最近一个 run 的接收停在 needs_attention：给原因与可用命令（输入已变交给下方统一处理）。
  const latest = facts.runs.at(-1) ?? null;
  const inputsChanged = binding.confirmedInputsDigest !== null && binding.confirmedInputsDigest !== facts.currentInputsDigest;
  if (latest !== null && latest.acceptance?.state === "needs_attention" && latest.acceptance.reason !== "stale_input") {
    const reason = latest.acceptance.reason ?? "unknown";
    const commands = latest.nextActions.length > 0 ? [] : [`knit status --run ${latest.runId}`, `knit run accept ${latest.runId}`];
    if (reason.startsWith("unattributed_paths")) {
      commands.push(
        `knit run accept ${latest.runId} --include <path...> --reason <原因>`,
        `knit run accept ${latest.runId} --exclude <path...> --reason <原因>`,
      );
    }
    return {
      kind: "run_needs_attention",
      summary: `run ${runLabel(latest)} 的接收停在 needs_attention（${reason}）${latest.nextActions.length > 0 ? `；${latest.nextActions.join("；")}` : ""}`,
      commands: [...new Set(commands)],
      runId: latest.runId,
    };
  }
  // 输入已变（含 stale_input）：确认摘要与当前输入不一致时，只能经 task update 重新确认。
  const staleRun = latest !== null && latest.acceptance?.reason === "stale_input" ? latest : null;
  if (inputsChanged || staleRun !== null) {
    const where = facts.stage === "deliver" ? "交付前" : `当前阶段 ${facts.stage}`;
    return {
      kind: "inputs_changed",
      summary: `${where}任务输入与已确认摘要不一致${staleRun !== null ? `（run ${staleRun.runId} 收尾判 stale_input，结果不计为当前规格的成果）` : ""}；补充说明用 clarify（deliver 时回到需要证据的阶段），目标／范围变化用 change（回到 start）`,
      commands: [
        `knit task update ${id} --kind clarify --reason <原因> --file <当前输入区文件>`,
        `knit task update ${id} --kind change --reason <原因> --file <当前输入区文件>`,
      ],
      runId: staleRun?.runId ?? null,
    };
  }
  return stageNextAction(facts);
}

/** 没有卡点时按当前阶段推进。 */
function stageNextAction(facts: TaskNextActionFacts): TaskNextAction {
  const id = facts.taskId;
  if (facts.stage === "start") {
    return {
      kind: "stage",
      summary: "讨论阶段：确认目标、范围与验收后冻结输入",
      commands: [`knit task ready ${id}`],
      runId: null,
    };
  }
  if (facts.stage === "deliver") {
    if (facts.verification === "independent" && facts.checkerRepaired) {
      return {
        kind: "stage",
        summary: "最新检查由检查者修复过成果（修复部分只算自检）；independent 完成前须再派一次未改动文件的检查",
        commands: [`knit run check --task ${id}`],
        runId: null,
      };
    }
    return {
      kind: "stage",
      summary: "交付阶段：核对完成条件后标记业务完成，再按授权交付",
      commands: [`knit task close ${id} --outcome completed --reason <完成判断>`, `knit deliver ${id} --branch <refs/heads/...> --plan`],
      runId: null,
    };
  }
  const configured = facts.workflow.stages.some((stage) => stage.id === facts.stage);
  return {
    kind: "stage",
    summary: configured ? `当前阶段 ${facts.stage}：派发本阶段 run` : `任务阶段 ${facts.stage} 不在生效流程中；核对 .knit/workflow.yaml 或用 task update --kind change 回到 start`,
    commands: configured
      ? [`knit run prepare --task ${id} --stage ${facts.stage}`, `knit run start <run-id>`]
      : [`knit workflow show`, `knit task update ${id} --kind change --reason <原因> --file <当前输入区文件>`],
    runId: null,
  };
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
    const check = new RunStore(root).readCheckIfIntact(runId);
    const checkerPaths = checkerChangedPathsOf(check);
    const noOutputNotice = noOutputNoticeOf(projection);
    return {
      ...projection,
      taskTitle: task?.title ?? null,
      taskSlug: task?.slug ?? null,
      stageName: workflowStageDisplayName(workflow, projection.phase),
      elapsedMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
      executionDir,
      lastActivityAt,
      heartbeat: this.heartbeat(locksRoot ?? this.lockRoot, executionDir),
      startupDiagnostics,
      rexDiagnostics: rexDiagnosticsOf(root, runId),
      nextActions: [
        ...staleInputNextActions(projection, this.taskStageOf(executionDir, projection.taskId)),
        ...unattributedNextActions(projection),
        ...checkerRepairNextActions(projection, checkerPaths, this.taskVerificationOf(executionDir, projection.taskId)),
        ...noOutputNextActions(projection, noOutputNotice),
      ],
      noOutputNotice,
      checkerChangedPaths: checkerPaths,
      verificationLabel: check === null ? null : verificationLabel(this.taskVerificationOf(executionDir, projection.taskId) ?? "independent", checkerPaths),
    };
  }

  async taskStatus(root: string, taskId: string, locksRoot?: string): Promise<TaskStatusView> {
    const located = locateTaskDocument(root, taskId);
    const document = parseTaskDocument(located.raw.toString("utf8"), join(located.dir, "task.md"));
    const workflow = loadWorkflow(root).workflow;
    const clarify = clarifyStateOf(document.inputsBody);
    const binding = await this.store.bindings.get(taskId);
    const runs = await this.taskRuns(root, taskId, locksRoot);
    const runStore = new RunStore(root);
    // 展示只采信完整性有效的凭据；篡改或旧格式凭据在交付／完成时按原因拒绝。
    const completion = runStore.readCompletionIfIntact(taskId);
    // 只在 independent 时检查者修复影响完成资格；其它模式照实显示但不作标注。
    const lastCheckChangedPaths = binding?.lastCheckRunId ? checkerChangedPathsOf(runStore.readCheckIfIntact(binding.lastCheckRunId)) : [];
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
      stageName: workflowStageDisplayName(workflow, document.frontmatter.stage),
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
      clarify: { blocking: clarify.blocking, assumed: clarify.assumed },
      lastCheckRunId: binding?.lastCheckRunId ?? null,
      verificationLabel: verificationLabel(verificationModeOf(document.frontmatter), lastCheckChangedPaths.length > 0 ? lastCheckChangedPaths : (completion?.checkerChangedPaths ?? [])),
      lastCheckChangedPaths,
      completion,
      runs,
      latestRun: runs.at(-1) ?? null,
      activeRuns: runs.filter((run) => !TERMINAL_RUN_STATES.has(run.state)).length,
      nextAction: taskNextAction({
        taskId,
        status: document.frontmatter.status,
        stage: document.frontmatter.stage,
        verification: verificationModeOf(document.frontmatter),
        archived: located.archived,
        binding,
        currentInputsDigest: inputsDigestOf(located.raw.toString("utf8")),
        runs,
        lockResidue: runs.some((run) => !TERMINAL_RUN_STATES.has(run.state))
          ? null
          : this.lockResidueOf(locksRoot ?? this.lockRoot, executionRouteOf(binding, root).dir),
        workflow,
        checkerRepaired: lastCheckChangedPaths.length > 0,
      }),
    };
  }

  /**
   * 本任务执行目录的项目锁残留：无活动 run 时仍存在的 project 锁。owner 存活且不是 run
   * （如 deliver／restore 正在进行）也一并列出，由命令侧再核对；只读，不回收。
   */
  private lockResidueOf(locksRoot: string | undefined, executionDir: string): TaskNextActionFacts["lockResidue"] {
    try {
      const manager = new LockManager(locksRoot === undefined ? {} : { root: locksRoot });
      const status = manager.inspect({ scope: "project", rawKey: executionDir });
      if (!status.exists) return null;
      // owner 存活时是其它操作正在持有，不是残留。
      if (status.processVerdict === "alive") return null;
      const entry = manager.list().find((item) => item.scope === "project" && item.key === executionDir);
      return {
        id: entry?.id ?? "project/<hash>",
        token: status.owner?.token ?? null,
        verdict: status.processVerdict,
        reclaimable: manager.reclaimable(status),
      };
    } catch {
      return null;
    }
  }

  async overview(root: string, locksRoot?: string): Promise<StatusOverview> {
    const normalizedRoot = normalizeRoot(root);
    const tasks: StatusOverview["tasks"] = [];
    const workflow = loadWorkflow(normalizedRoot).workflow;
    const runsRoot = new RunStore(normalizedRoot).listRunIds();
    const allRuns: RunStatusView[] = [];
    for (const runId of runsRoot) {
      try {
        allRuns.push(await this.runStatus(normalizedRoot, runId, locksRoot));
      } catch {
        // 损坏或未完成的 run 目录不阻塞概览。
      }
    }
    for (const task of await this.listTasks(normalizedRoot)) {
      const taskRuns = allRuns.filter((run) => run.taskId === task.taskId);
      tasks.push({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        stage: task.stage,
        stageName: workflowStageDisplayName(workflow, task.stage),
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
    // 与 task list／next 共用同一分区缓存（任务 k-3d730c8907b3）：活跃与归档按指纹复用；
    // 损坏任务仍跳过、重复 ID 如实列出，概览输出口径不变（任务041）。
    const summaries = taskListOverviewSummaries(root);
    return [...summaries.active, ...summaries.archived].map((summary) => ({
      taskId: summary.taskId,
      title: summary.title,
      status: summary.status,
      stage: summary.stage,
      outcome: summary.outcome,
      relativePath: summary.relativePath,
      archived: summary.archived,
    }));
  }

  /** 只读取任务完成验证要求；缺失或损坏时为 null。 */
  private taskVerificationOf(root: string, taskId: string): VerificationMode | null {
    try {
      return verificationModeOf(locateTaskDocument(root, taskId).document.frontmatter);
    } catch {
      return null;
    }
  }

  /** 只读取任务当前业务位置；缺失或损坏时为 null，不影响 run 状态。 */
  private taskStageOf(root: string, taskId: string): { status: string; stage: string } | null {
    try {
      const { frontmatter } = locateTaskDocument(root, taskId).document;
      return { status: frontmatter.status, stage: frontmatter.stage };
    } catch {
      return null;
    }
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
