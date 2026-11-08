/**
 * Worktree 模式下的多任务调度（任务 k-9cd9a63bd5c5；DESIGN §3.11／§6／§10／§13）。
 *
 * 门槛：项目 `worktree.default` 必须为 on；未开启时不派发、不接收，输出说明。
 * 运行形态：前台一次性批次（--once）或循环（--until-idle），不建常驻守护进程；
 * `schedule:<项目根>` 项目锁保证同一项目同时只有一个调度循环。
 *
 * 就绪集、排序与重叠只从任务事实派生：状态／阶段／依赖来自 task.md，草案与
 * 执行目录来自 binding，活动事实来自 run 仓储，影响路径来自 plan.md 固定区段。
 * 派发复用 `run prepare`／`run start`，接收复用既有 `run accept`（含 onVerdict 与
 * 完成资格），收尾复用 task close／deliver；不另造状态判定或绕过任何守卫。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskBinding } from "../contracts/metadata.js";
import type { RunRequestFile, RunStateFile } from "../contracts/run.js";
import { compareSchedule, dependencyBlockers, priorityOrDefault, type DependencyBlocker, type ScheduleEntry } from "../domain/schedule.js";
import { parseImpactSection, overlappingImpacts, type ImpactDeclaration } from "../domain/impact.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { LockManager } from "../infrastructure/locks.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { GuardError } from "./guard-error.js";
import {
  defaultConfig,
  parseConfig,
  schedulerSettingsOf,
  worktreeSettingsOf,
  type ProjectConfig,
} from "./config.js";
import { RunCoordinator } from "./run-coordinator.js";
import { RunAcceptanceService } from "./run-acceptance.js";
import { RunActivityService } from "./run-activity.js";
import { TaskService, listTaskDirectories, locateTaskDocument, tasksRootOf } from "./task-service.js";
import { parseTaskDocument, type TaskDocument } from "./task-document.js";
import { DeliveryService } from "./delivery-service.js";
import { currentBranch } from "./delivery.js";
import { resolvePhaseModel } from "./model-selection.js";
import { workflowOf } from "./workflow.js";
import { executionRouteOf } from "./worktree-routing.js";
import { runSettled } from "./run-activity.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";

const TASK_FILE = "task.md";
const PLAN_FILE = "plan.md";
const SCHEDULE_LOCK_PREFIX = "schedule:";
const TERMINAL_STATES = new Set(["completed", "cancelled", "failed"]);
/** worktree 模式下未开启门槛时的固定说明；退出 0，不派发、不接收。 */
export const SCHEDULE_DISABLED_MESSAGE = "worktree 模式未开启，未触发调度；按常规逐个执行";

export type ScheduleMode = "once" | "until-idle";

export interface ScheduleInput {
  dir: string;
  mode: ScheduleMode;
  /** 覆盖本轮 maxConcurrent；必须为正整数。 */
  maxConcurrent?: number;
  /** 显式授权来源；覆盖提交／合入／清理的授权缺口。 */
  authorizationRef?: string | null;
  /** SIGINT 等外部停止：只停派发与接收，保留活动 run。 */
  signal?: AbortSignal;
  /** 测试注入：轮询间隔；缺省 2000ms。 */
  pollIntervalMs?: number;
}

export interface ScheduleEvent {
  at: string;
  action: string;
  taskId?: string;
  runId?: string;
  stage?: string;
  reason?: string;
  authorization?: string;
}

export interface ScheduleRunSummary {
  runId: string;
  taskId: string;
  stage: string;
  state: string;
}

export interface ScheduleResult {
  mode: ScheduleMode;
  gate: "enabled" | "disabled";
  message: string | null;
  limits: { maxConcurrent: number; maxAttempts: number };
  interrupted: boolean;
  events: ScheduleEvent[];
  ready: string[];
  skipped: Array<{ taskId: string; reason: string }>;
  dispatched: Array<{ taskId: string; runId: string; stage: string }>;
  accepted: Array<{ taskId: string; runId: string; stage: string | null; verdict: string | null }>;
  closed: string[];
  delivered: string[];
  pendingDelivery: string[];
  needsAttention: Array<{ taskId: string; reason: string }>;
  active: ScheduleRunSummary[];
}

export interface RunSchedulerOptions {
  store: MetadataStore;
  locks?: LockManager;
  /** 锁根目录（测试隔离）；传给派发协调器。 */
  locksRoot?: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  coordinator?: RunCoordinator;
  acceptance?: RunAcceptanceService;
  tasks?: TaskService;
  delivery?: DeliveryService;
}

interface TaskFact {
  taskId: string;
  stage: string;
  status: "open" | "closed";
  outcome: "completed" | "cancelled" | "superseded" | null;
  archived: boolean;
  priority: ScheduleEntry["priority"];
  order: number | null;
  createdAt: string;
  dependsOn: string[];
  binding: TaskBinding | null;
  executionDir: string;
  plan: ImpactDeclaration;
  routeProblem: string | null;
}

interface RunFact {
  runId: string;
  request: RunRequestFile;
  state: RunStateFile | null;
  active: boolean;
}

interface TrackedRun {
  runId: string;
  taskId: string;
  stage: string;
}

interface Reservation {
  taskId: string;
  impact: ImpactDeclaration;
}

interface Evaluation {
  ready: string[];
  skipped: Array<{ taskId: string; reason: string }>;
  baseDispatchable: number;
}

function readConfig(root: string): ProjectConfig {
  const path = join(root, ".knit", "config.json");
  if (!existsSync(path)) return defaultConfig();
  return parseConfig(readFileSync(path, "utf8"));
}

/** 与 DeliveryService 同口径：记录配置文件内容摘要，不把配置当提交授权。 */
function configAuthorizationRef(root: string): string {
  const path = join(root, ".knit", "config.json");
  const digest = existsSync(path) ? sha256Bytes(readFileSync(path)) : sha256Text(JSON.stringify(defaultConfig()));
  return `config:.knit/config.json@${digest}`;
}

function reasonOf(error: unknown): string {
  if (error instanceof GuardError) {
    const guard = error.details?.guardReason;
    if (typeof guard !== "string" || guard === "" || error.message.startsWith(`${guard}:`)) return error.message;
    return `${guard}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class RunScheduler {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly coordinator: RunCoordinator;
  private readonly acceptance: RunAcceptanceService;
  private readonly tasks: TaskService;
  private readonly delivery: DeliveryService;

  constructor(options: RunSchedulerOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.coordinator = options.coordinator ?? new RunCoordinator({
      store: options.store,
      ...(options.locksRoot === undefined || options.locksRoot === null ? {} : { lockRoot: options.locksRoot }),
    });
    this.acceptance = options.acceptance ?? new RunAcceptanceService({ store: options.store, locks: this.locks, now: this.now });
    this.tasks = options.tasks ?? new TaskService({
      store: options.store,
      locks: this.locks,
      now: this.now,
      runActivity: new RunActivityService({ store: options.store }),
    });
    this.delivery = options.delivery ?? new DeliveryService({ store: options.store, locks: this.locks, now: this.now });
  }

  async run(input: ScheduleInput): Promise<ScheduleResult> {
    const root = normalizeRoot(input.dir);
    const config = readConfig(root);
    const worktree = worktreeSettingsOf(config);
    const limits = schedulerSettingsOf(config);
    const maxConcurrent = input.maxConcurrent ?? limits.maxConcurrent;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new GuardError("invalid_request", "--max 必须是正整数");
    }
    const result: ScheduleResult = {
      mode: input.mode,
      gate: worktree.default === "on" ? "enabled" : "disabled",
      message: worktree.default === "on" ? null : SCHEDULE_DISABLED_MESSAGE,
      limits: { ...limits, maxConcurrent },
      interrupted: false,
      events: [],
      ready: [],
      skipped: [],
      dispatched: [],
      accepted: [],
      closed: [],
      delivered: [],
      pendingDelivery: [],
      needsAttention: [],
      active: [],
    };
    if (worktree.default !== "on") return result;

    const lock = await this.locks.acquire({
      keys: [{ scope: "project", rawKey: `${SCHEDULE_LOCK_PREFIX}${root}` }],
      action: "run.schedule",
    });
    // 长循环持有调度锁：按项目心跳间隔更新 owner，避免只读诊断把正常循环当成可疑残留。
    const heartbeat = setInterval(() => {
      void this.locks.heartbeat(lock).catch(() => {
        // 心跳失败不自动换锁或强解；调度循环仍由 SIGINT／完成条件结束。
      });
    }, config.limits.heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      await this.runLoop(root, config, input, maxConcurrent, result);
      result.needsAttention = [...new Map(result.needsAttention.map((item) => [`${item.taskId}\u0000${item.reason}`, item])).values()];
      return result;
    } finally {
      clearInterval(heartbeat);
      this.locks.release(lock);
    }
  }

  private emit(result: ScheduleResult, action: string, fields: Omit<ScheduleEvent, "at" | "action"> = {}): void {
    result.events.push({ at: this.now().toISOString(), action, ...fields });
  }

  private async runLoop(
    root: string,
    config: ProjectConfig,
    input: ScheduleInput,
    maxConcurrent: number,
    result: ScheduleResult,
  ): Promise<void> {
    const attempts = new Map<string, number>();
    const tracked = new Map<string, TrackedRun>();
    const pending = new Set<string>();
    const needsAttention = new Set<string>();
    const announcedSkips = new Set<string>();
    const announcedReady = new Set<string>();
    const closedOut = new Set<string>();
    const reportedAwaiting = new Set<string>();
    const pollIntervalMs = input.pollIntervalMs ?? 2000;
    const authorization = (input.authorizationRef ?? "").trim();
    const configAuto = worktreeSettingsOf(config).deliveryMode === "merge" ||
      worktreeSettingsOf(config).cleanup === "after-merge";
    const configRef = configAuthorizationRef(root);

    this.emit(result, "scheduler_start", {
      reason: `gate=on; maxConcurrent=${maxConcurrent}; mode=${input.mode}`,
      authorization: authorization === "" ? configRef : authorization,
    });

    for (;;) {
      if (input.signal !== undefined && input.signal.aborted) {
        result.interrupted = true;
        break;
      }
      const facts = await this.loadFacts(root);
      const runs = this.loadRuns(root);

      // 接收只处理本调度器派发的 run；外部活动 run 只计入并发与等待事实。
      if (input.mode === "until-idle") {
        await this.acceptTerminal(root, tracked, pending, needsAttention, result);
      }

      // --once 只做一轮计算与派发，不接收、不推进、不自动收尾。
      if (input.mode === "until-idle") {
        const afterAcceptFacts = await this.loadFacts(root);
        await this.closeoutEligible(root, afterAcceptFacts, {
          authorization,
          configAuto,
          configRef,
          closedOut,
          reportedAwaiting,
          needsAttention,
          pendingDelivery: result.pendingDelivery,
          result,
        });
      }

      const dispatchFacts = input.mode === "until-idle" ? await this.loadFacts(root) : facts;
      const dispatchRuns = input.mode === "until-idle" ? this.loadRuns(root) : runs;
      const evaluation = await this.dispatchRound(
        root,
        config,
        dispatchFacts,
        dispatchRuns,
        maxConcurrent,
        attempts,
        tracked,
        pending,
        needsAttention,
        closedOut,
        announcedSkips,
        announcedReady,
        result,
      );

      if (input.mode === "once") break;

      const activeNow = this.activeRunIds(root);
      const effectiveActive = new Set([...activeNow, ...pending]);
      if (input.signal !== undefined && input.signal.aborted) {
        result.interrupted = true;
        break;
      }
      if (effectiveActive.size === 0 && evaluation.baseDispatchable === 0) break;

      await this.sleepUntilAbort(pollIntervalMs, input.signal);
    }

    result.active = this.activeSummaries(root);
    this.emit(result, "scheduler_stop", {
      reason: result.interrupted
        ? `interrupted; active=${result.active.length}`
        : `idle; active=${result.active.length}`,
    });
  }

  /** SIGINT 语义：停止派发／接收，保留活动 run；轮询等待可被立即打断。 */
  private async sleepUntilAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      await this.sleep(ms);
      return;
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 全量任务事实：活跃与归档 task.md 提供状态／阶段／依赖，binding 指向实际
   * 执行目录（worktree active 时读其中正文），plan.md 提供影响路径声明。
   */
  private async loadFacts(root: string): Promise<TaskFact[]> {
    const tasksRoot = tasksRootOf(root);
    const mainDocs = new Map<string, { document: TaskDocument; dir: string; archived: boolean }>();
    const entries = new Map<string, ScheduleEntry>();
    for (const { name, archived } of listTaskDirectories(root)) {
      const dir = join(tasksRoot, name);
      const file = join(dir, TASK_FILE);
      let document: TaskDocument;
      try {
        document = parseTaskDocument(readFileSync(file, "utf8"), file);
      } catch {
        // 损坏的归档条目由 task list／doctor 报告；活跃条目不可解析时停止调度。
        if (archived) continue;
        throw new InfrastructureError("io_error", `任务资料不可解析，调度停止: ${file}`);
      }
      const facts = document.frontmatter;
      entries.set(facts.id, {
        taskId: facts.id,
        priority: priorityOrDefault(facts.priority),
        createdAt: facts.createdAt,
        order: facts.order ?? null,
        dependsOn: facts.dependsOn ?? [],
        status: facts.status,
        outcome: facts.outcome,
        archived,
      });
      if (!archived && !mainDocs.has(facts.id)) mainDocs.set(facts.id, { document, dir, archived });
    }

    const bindings = await this.store.bindings.list();
    const byTask = new Map(bindings.map((binding) => [binding.taskId, binding]));
    const docs = new Map(mainDocs);
    const routeProblems = new Map<string, string>();
    for (const binding of bindings) {
      const info = binding.worktree;
      if (info === undefined || info.active !== true) continue;
      try {
        const located = locateTaskDocument(info.path, binding.taskId);
        if (located.archived) {
          docs.delete(binding.taskId);
          const entry = entries.get(binding.taskId);
          if (entry !== undefined) entries.set(binding.taskId, { ...entry, archived: true });
          continue;
        }
        docs.set(binding.taskId, { document: located.document, dir: located.dir, archived: false });
        const frontmatter = located.document.frontmatter;
        entries.set(frontmatter.id, {
          taskId: frontmatter.id,
          priority: priorityOrDefault(frontmatter.priority),
          createdAt: frontmatter.createdAt,
          order: frontmatter.order ?? null,
          dependsOn: frontmatter.dependsOn ?? [],
          status: frontmatter.status,
          outcome: frontmatter.outcome,
          archived: false,
        });
      } catch (error) {
        // 保留主检出副本并标记路由异常；派发时跳过，不静默回退到错误目录。
        if (docs.has(binding.taskId)) routeProblems.set(binding.taskId, reasonOf(error));
      }
    }

    const facts: TaskFact[] = [];
    for (const [taskId, located] of docs) {
      const document = located.document;
      const binding = byTask.get(taskId) ?? null;
      const info = binding?.worktree;
      const routeProblem = routeProblems.get(taskId) ?? null;
      const activeWorktree = info !== undefined && info.active === true && existsSync(info.path);
      // 已交接但未准备的 worktree 仍有任务正文；派发要从主检出续做 handoff／prepare，
      // 已准备的则直接在 worktree 起点运行后续阶段。
      const preparedWorktree = activeWorktree && info.preparedAt !== undefined && info.preparedAt !== null;
      const executionDir = preparedWorktree && routeProblem === null ? info.path : root;
      const plan = parseImpactSection(this.readPlanText(located.dir, mainDocs.get(taskId)?.dir ?? null));
      const frontmatter = document.frontmatter;
      facts.push({
        taskId,
        stage: frontmatter.stage,
        status: frontmatter.status,
        outcome: frontmatter.outcome,
        archived: located.archived,
        priority: priorityOrDefault(frontmatter.priority),
        order: frontmatter.order ?? null,
        createdAt: frontmatter.createdAt,
        dependsOn: frontmatter.dependsOn ?? [],
        binding,
        executionDir,
        plan,
        routeProblem,
      });
    }
    // 依赖判定用完整索引（含归档）；归档任务本身不进入候选。
    for (const fact of facts) {
      const entry = entries.get(fact.taskId);
      if (entry === undefined) continue;
      (fact as TaskFact & { blockers?: DependencyBlocker[] }).blockers = dependencyBlockers(entry, entries);
    }
    return facts;
  }

  private readPlanText(taskDir: string, mainDir: string | null): string | null {
    for (const dir of [taskDir, mainDir]) {
      if (dir === null) continue;
      try {
        const file = join(dir, PLAN_FILE);
        if (existsSync(file)) return readFileSync(file, "utf8");
      } catch {
        // 读取失败按未知影响处理；不影响任务正文与派发守卫。
      }
    }
    return null;
  }

  /** run 仓储事实：活动（未终态）与收敛（终态且 completed 已接收）分开。 */
  private loadRuns(root: string): RunFact[] {
    const runs = new RunStore(root);
    const facts: RunFact[] = [];
    for (const runId of runs.listRunIds()) {
      const request = runs.readRequest(runId);
      if (request === null) continue;
      const state = runs.readState(runId);
      const launch = runs.readLaunch(runId);
      const active = state !== null
        ? !TERMINAL_STATES.has(state.state)
        : launch !== null && launch.state !== "failed";
      facts.push({ runId, request, state, active });
    }
    return facts;
  }

  private activeRunIds(root: string): Set<string> {
    return new Set(this.loadRuns(root).filter((run) => run.active).map((run) => run.runId));
  }

  private activeSummaries(root: string): ScheduleRunSummary[] {
    return this.loadRuns(root)
      .filter((run) => run.active)
      .map((run) => ({
        runId: run.runId,
        taskId: run.request.taskId,
        stage: run.request.phase,
        state: run.state?.state ?? "prepared",
      }));
  }

  /** 任务是否仍有未收敛 run：含 completed 未接收；用于就绪集与收尾前置。 */
  private async unsettledRunIds(root: string, runs: RunFact[], taskId: string): Promise<RunFact[]> {
    const store = new RunStore(root);
    const unsettled: RunFact[] = [];
    for (const run of runs.filter((candidate) => candidate.request.taskId === taskId)) {
      // 启动失败且从未认领的 run 没有 state，不阻塞同一任务的后续派发。
      if (run.state === null && !run.active) continue;
      if (await runSettled(this.store, store, run.runId, run.request)) continue;
      unsettled.push(run);
    }
    return unsettled;
  }

  private baseEligible(
    fact: TaskFact,
    workflowStages: ReadonlySet<string>,
    needsAttention: ReadonlySet<string>,
  ): string | null {
    if (fact.archived) return "archived";
    if (fact.routeProblem !== null) return `route_invalid:${fact.routeProblem}`;
    if (fact.status !== "open" || fact.outcome !== null) return "not_open";
    if (needsAttention.has(fact.taskId)) return "needs_attention";
    if (fact.binding?.pendingDraft !== null && fact.binding?.pendingDraft !== undefined) return "pending_draft";
    if (fact.stage === "start") return "stage_start";
    if (fact.stage === "deliver") return "stage_deliver";
    if (!workflowStages.has(fact.stage)) return `stage_not_in_workflow:${fact.stage}`;
    return null;
  }

  private async dispatchRound(
    root: string,
    config: ProjectConfig,
    facts: TaskFact[],
    runs: RunFact[],
    maxConcurrent: number,
    attempts: Map<string, number>,
    tracked: Map<string, TrackedRun>,
    pending: Set<string>,
    needsAttention: Set<string>,
    closedOut: Set<string>,
    announcedSkips: Set<string>,
    announcedReady: Set<string>,
    result: ScheduleResult,
  ): Promise<Evaluation> {
    const workflow = workflowOf(root);
    const workflowStages = new Set(workflow.stages.map((stage) => stage.id));
    const limits = schedulerSettingsOf(config);
    const maxAttempts = limits.maxAttempts;
    const activeIds = new Set(runs.filter((run) => run.active).map((run) => run.runId));
    const effectiveActive = new Set([...activeIds, ...pending]);
    const reservations: Reservation[] = [];
    for (const fact of facts) {
      const hasActive = runs.some((run) => run.request.taskId === fact.taskId && run.active);
      const hasWorktree = fact.binding?.worktree !== undefined;
      if (hasActive || hasWorktree) {
        reservations.push({ taskId: fact.taskId, impact: fact.plan });
      }
    }

    const ready: string[] = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];
    let baseDispatchable = 0;
    const candidates = facts
      .filter((fact) => !closedOut.has(fact.taskId))
      .sort((left, right) => compareSchedule(this.entryOf(left), this.entryOf(right)));
    for (const fact of candidates) {
      // 收尾任务由 closeoutEligible 处理；已结束但未归档的任务不是派发候选。
      if (fact.stage === "deliver" || fact.status !== "open" || fact.outcome !== null) continue;
      const baseReason = this.baseEligible(fact, workflowStages, needsAttention);
      if (baseReason !== null) {
        this.recordSkip(fact, baseReason, skipped, announcedSkips, result);
        continue;
      }
      const blockers = ((fact as TaskFact & { blockers?: DependencyBlocker[] }).blockers ?? []);
      if (blockers.length > 0) {
        const reason = `dependency_blocked:${blockers.map((blocker) => `${blocker.taskId}(${blocker.problem})`).join(",")}`;
        this.recordSkip(fact, reason, skipped, announcedSkips, result);
        continue;
      }
      const attemptKey = `${fact.taskId}::${fact.stage}`;
      if ((attempts.get(attemptKey) ?? 0) >= maxAttempts) {
        this.recordSkip(fact, "max_attempts", skipped, announcedSkips, result);
        continue;
      }
      const inFlight = [...tracked.values()].find((run) => run.taskId === fact.taskId);
      if (inFlight !== undefined) {
        this.recordSkip(fact, `active_run:${inFlight.runId}`, skipped, announcedSkips, result);
        continue;
      }
      const unsettled = await this.unsettledRunIds(root, runs, fact.taskId);
      const activeRun = unsettled.find((run) => run.active);
      if (activeRun !== undefined) {
        this.recordSkip(fact, `active_run:${activeRun.runId}`, skipped, announcedSkips, result);
        continue;
      }
      if (unsettled.length > 0) {
        this.recordSkip(fact, `unaccepted_run:${unsettled[0]!.runId}`, skipped, announcedSkips, result);
        continue;
      }

      const others = reservations.filter((reservation) => reservation.taskId !== fact.taskId);
      if (!fact.plan.known) {
        if (effectiveActive.size > 0) {
          this.recordSkip(fact, "unknown_impact_active", skipped, announcedSkips, result);
          continue;
        }
        if (others.length > 0) {
          this.recordSkip(fact, `unknown_impact_reserved:${others[0]!.taskId}`, skipped, announcedSkips, result);
          continue;
        }
      } else {
        const unknownOther = others.find((reservation) => !reservation.impact.known);
        if (unknownOther !== undefined) {
          this.recordSkip(fact, `unknown_impact_block:${unknownOther.taskId}`, skipped, announcedSkips, result);
          continue;
        }
        const overlap = others.find((reservation) =>
          reservation.impact.known && overlappingImpacts(fact.plan.paths, reservation.impact.paths).length > 0,
        );
        if (overlap !== undefined) {
          this.recordSkip(fact, `path_overlap:${overlap.taskId}`, skipped, announcedSkips, result);
          continue;
        }
      }
      baseDispatchable += 1;
      if (!announcedReady.has(`${fact.taskId}:${fact.stage}`)) {
        announcedReady.add(`${fact.taskId}:${fact.stage}`);
        ready.push(fact.taskId);
        this.emit(result, "ready", { taskId: fact.taskId, stage: fact.stage });
      }
      if (effectiveActive.size >= maxConcurrent) {
        this.recordSkip(fact, "concurrency_limit", skipped, announcedSkips, result);
        continue;
      }

      // 计数按任务＋阶段：阶段推进（implement → check）是新的派发需求，不是同阶段重试；
      // 否则缺省 maxAttempts=1 会阻止自动推进，违背调度目标。失败仍由 needsAttention 阻止重派。
      attempts.set(attemptKey, (attempts.get(attemptKey) ?? 0) + 1);
      const dispatch = await this.dispatchOne(root, fact);
      if (!dispatch.ok) {
        needsAttention.add(fact.taskId);
        result.needsAttention.push({ taskId: fact.taskId, reason: dispatch.reason });
        this.emit(result, "dispatch_failed", { taskId: fact.taskId, stage: fact.stage, reason: dispatch.reason });
        continue;
      }
      effectiveActive.add(dispatch.runId);
      pending.add(dispatch.runId);
      tracked.set(dispatch.runId, { runId: dispatch.runId, taskId: fact.taskId, stage: fact.stage });
      result.dispatched.push({ taskId: fact.taskId, runId: dispatch.runId, stage: fact.stage });
      this.emit(result, "dispatch", {
        taskId: fact.taskId,
        runId: dispatch.runId,
        stage: fact.stage,
        reason: dispatch.reused ? "reused" : undefined,
      });
      if (dispatch.launchFailed) {
        pending.delete(dispatch.runId);
        tracked.delete(dispatch.runId);
        needsAttention.add(fact.taskId);
        result.needsAttention.push({ taskId: fact.taskId, reason: "launch_failed" });
        this.emit(result, "run_failed", {
          taskId: fact.taskId,
          runId: dispatch.runId,
          stage: fact.stage,
          reason: "launch_failed",
        });
      }
      // 已派发的任务从本轮候选移除，避免同一轮重复计数与重复派发。
      reservations.push({ taskId: fact.taskId, impact: fact.plan });
    }
    result.ready = [...new Set([...result.ready, ...ready])];
    for (const skip of skipped) {
      if (!result.skipped.some((item) => item.taskId === skip.taskId && item.reason === skip.reason)) {
        result.skipped.push(skip);
      }
    }
    return { ready, skipped, baseDispatchable };
  }

  private entryOf(fact: TaskFact): ScheduleEntry {
    return {
      taskId: fact.taskId,
      priority: fact.priority,
      createdAt: fact.createdAt,
      order: fact.order,
      dependsOn: fact.dependsOn,
      status: fact.status,
      outcome: fact.outcome,
      archived: fact.archived,
    };
  }

  private recordSkip(
    fact: TaskFact,
    reason: string,
    skipped: Array<{ taskId: string; reason: string }>,
    announced: Set<string>,
    result: ScheduleResult,
  ): void {
    skipped.push({ taskId: fact.taskId, reason });
    const key = `${fact.taskId}:${reason}`;
    if (announced.has(key)) return;
    announced.add(key);
    this.emit(result, "skip", { taskId: fact.taskId, stage: fact.stage, reason });
  }

  private async dispatchOne(
    root: string,
    fact: TaskFact,
  ): Promise<{ ok: true; runId: string; reused: boolean; launchFailed: boolean } | { ok: false; reason: string }> {
    try {
      const model = resolvePhaseModel({ dir: root, phase: fact.stage });
      const executionDir = fact.executionDir;
      const prepared = await this.coordinator.prepare({
        dir: root,
        executionDir,
        taskId: fact.taskId,
        phase: fact.stage,
        initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: executionDir },
        model,
        recovery: { nativeSessionId: null, resume: "prefer" },
      });
      const started = await this.coordinator.start({ dir: root, runId: prepared.request.runId });
      return {
        ok: true,
        runId: prepared.request.runId,
        reused: prepared.reused,
        launchFailed: started.launch.state === "failed",
      };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  private async acceptTerminal(
    root: string,
    tracked: Map<string, TrackedRun>,
    pending: Set<string>,
    needsAttention: Set<string>,
    result: ScheduleResult,
  ): Promise<void> {
    for (const [runId, entry] of [...tracked]) {
      let status;
      try {
        status = await this.coordinator.status({ dir: root, runId });
      } catch (error) {
        tracked.delete(runId);
        pending.delete(runId);
        needsAttention.add(entry.taskId);
        result.needsAttention.push({ taskId: entry.taskId, reason: `status_failed:${reasonOf(error)}` });
        this.emit(result, "run_failed", { taskId: entry.taskId, runId, stage: entry.stage, reason: `status_failed:${reasonOf(error)}` });
        continue;
      }
      if (status.launchState === "failed" && !TERMINAL_STATES.has(status.state)) {
        tracked.delete(runId);
        pending.delete(runId);
        needsAttention.add(entry.taskId);
        result.needsAttention.push({ taskId: entry.taskId, reason: "launch_failed" });
        this.emit(result, "run_failed", { taskId: entry.taskId, runId, stage: entry.stage, reason: "launch_failed" });
        continue;
      }
      if (!TERMINAL_STATES.has(status.state)) continue;
      pending.delete(runId);
      tracked.delete(runId);
      if (status.state !== "completed") {
        needsAttention.add(entry.taskId);
        result.needsAttention.push({ taskId: entry.taskId, reason: status.reason ?? status.state });
        this.emit(result, "run_failed", {
          taskId: entry.taskId,
          runId,
          stage: entry.stage,
          reason: status.reason ?? status.state,
        });
        continue;
      }
      try {
        const accepted = await this.acceptance.accept({ dir: root, runId });
        if (!accepted.accepted) {
          needsAttention.add(entry.taskId);
          result.needsAttention.push({ taskId: entry.taskId, reason: accepted.reason ?? "accept_failed" });
          this.emit(result, "accept_failed", {
            taskId: entry.taskId,
            runId,
            stage: entry.stage,
            reason: accepted.reason ?? "accept_failed",
          });
          continue;
        }
        const stage = await this.stageOf(root, entry.taskId);
        result.accepted.push({ taskId: entry.taskId, runId, stage, verdict: accepted.verdict });
        this.emit(result, "accepted", {
          taskId: entry.taskId,
          runId,
          ...(stage === null ? {} : { stage }),
          reason: accepted.verdict ?? accepted.reason ?? undefined,
        });
        if (stage !== null && stage !== entry.stage) {
          this.emit(result, "advanced", { taskId: entry.taskId, stage, reason: `from ${entry.stage}` });
        }
      } catch (error) {
        needsAttention.add(entry.taskId);
        result.needsAttention.push({ taskId: entry.taskId, reason: reasonOf(error) });
        this.emit(result, "accept_failed", {
          taskId: entry.taskId,
          runId,
          stage: entry.stage,
          reason: reasonOf(error),
        });
      }
    }
  }

  private async stageOf(root: string, taskId: string): Promise<string | null> {
    try {
      const binding = await this.store.bindings.get(taskId);
      const route = binding === null ? null : executionRouteOf(binding, root);
      const executionDir = route?.state === "worktree" ? route.dir : root;
      return locateTaskDocument(executionDir, taskId).document.frontmatter.stage;
    } catch {
      return null;
    }
  }

  /**
   * 收尾边界：配置自动合入／清理只授权对应收尾步骤，不授权提交；显式
   * --authorization-ref 覆盖提交／合入／清理。两者都没有时停在 deliver 前。
   */
  private async closeoutEligible(
    root: string,
    facts: TaskFact[],
    context: {
      authorization: string;
      configAuto: boolean;
      configRef: string;
      closedOut: Set<string>;
      reportedAwaiting: Set<string>;
      needsAttention: Set<string>;
      pendingDelivery: string[];
      result: ScheduleResult;
    },
  ): Promise<void> {
    const runs = this.loadRuns(root);
    const settings = worktreeSettingsOf(readConfig(root));
    for (const fact of facts) {
      if (fact.stage !== "deliver" || fact.archived) continue;
      if (fact.routeProblem !== null) {
        context.closedOut.add(fact.taskId);
        context.needsAttention.add(fact.taskId);
        context.result.needsAttention.push({ taskId: fact.taskId, reason: `route_invalid:${fact.routeProblem}` });
        this.emit(context.result, "close_failed", { taskId: fact.taskId, stage: fact.stage, reason: `route_invalid:${fact.routeProblem}` });
        continue;
      }
      const alreadyCompleted = fact.status === "closed" && fact.outcome === "completed";
      if (fact.status === "open" && fact.outcome !== null) continue;
      if (fact.status !== "open" && !alreadyCompleted) continue;
      if (context.closedOut.has(fact.taskId) || context.needsAttention.has(fact.taskId)) continue;
      if (fact.binding?.pendingDraft !== null && fact.binding?.pendingDraft !== undefined) {
        this.emit(context.result, "awaiting_authorization", {
          taskId: fact.taskId,
          stage: fact.stage,
          reason: "pending_draft",
        });
        continue;
      }
      const unsettled = await this.unsettledRunIds(root, runs, fact.taskId);
      if (unsettled.length > 0) continue;

      const explicit = context.authorization !== "";
      if (!explicit && !context.configAuto) {
        context.closedOut.add(fact.taskId);
        context.pendingDelivery.push(fact.taskId);
        if (!context.reportedAwaiting.has(fact.taskId)) {
          context.reportedAwaiting.add(fact.taskId);
          this.emit(context.result, "awaiting_authorization", {
            taskId: fact.taskId,
            stage: fact.stage,
            reason: "delivery_authorization_required",
          });
        }
        continue;
      }

      if (fact.status === "open") {
        try {
          await this.tasks.close({
            dir: root,
            taskId: fact.taskId,
            outcome: "completed",
            runsSettled: true,
            reason: "调度器自动收尾：完成资格由核心核对",
            ...(fact.executionDir === root ? {} : { executionDir: fact.executionDir }),
            evidenceRoot: root,
          });
          context.result.closed.push(fact.taskId);
          this.emit(context.result, "closed", { taskId: fact.taskId, stage: fact.stage });
        } catch (error) {
          context.closedOut.add(fact.taskId);
          context.needsAttention.add(fact.taskId);
          context.result.needsAttention.push({ taskId: fact.taskId, reason: reasonOf(error) });
          this.emit(context.result, "close_failed", { taskId: fact.taskId, stage: fact.stage, reason: reasonOf(error) });
          continue;
        }
      }

      if (!explicit) {
        context.closedOut.add(fact.taskId);
        context.pendingDelivery.push(fact.taskId);
        this.emit(context.result, "pending_delivery_authorization", {
          taskId: fact.taskId,
          stage: fact.stage,
          reason: "config 只授权合入／清理，不授权提交",
          authorization: context.configRef,
        });
        continue;
      }

      const branch = currentBranch(root);
      if (branch === null || !branch.startsWith("refs/heads/")) {
        context.closedOut.add(fact.taskId);
        context.needsAttention.add(fact.taskId);
        context.result.needsAttention.push({ taskId: fact.taskId, reason: "branch_invalid" });
        this.emit(context.result, "deliver_failed", {
          taskId: fact.taskId,
          stage: fact.stage,
          reason: "当前主检出不在完整本地分支，无法交付",
        });
        continue;
      }
      try {
        const delivered = await this.delivery.deliver({
          dir: root,
          taskId: fact.taskId,
          branch,
          authorizationRef: context.authorization,
          caller: "agent",
          retry: true,
          merge: true,
          cleanup: settings.cleanup === "after-merge",
        });
        context.closedOut.add(fact.taskId);
        if (delivered.state === "completed") {
          context.result.delivered.push(fact.taskId);
          const cleanup = delivered.worktree?.cleanup;
          const cleanupPending = delivered.needsAttention === true;
          if (cleanupPending) {
            const reason = cleanup?.reason ?? delivered.reason ?? "cleanup_pending";
            context.needsAttention.add(fact.taskId);
            context.result.needsAttention.push({ taskId: fact.taskId, reason });
          }
          this.emit(context.result, "delivered", {
            taskId: fact.taskId,
            stage: fact.stage,
            authorization: context.authorization,
            reason: cleanupPending ? `cleanup_${cleanup?.status ?? "pending"}: ${cleanup?.reason ?? "保留现场"}` : undefined,
          });
        } else {
          context.needsAttention.add(fact.taskId);
          context.result.needsAttention.push({
            taskId: fact.taskId,
            reason: delivered.reason ?? "delivery_needs_attention",
          });
          this.emit(context.result, "deliver_failed", {
            taskId: fact.taskId,
            stage: fact.stage,
            reason: delivered.reason ?? "delivery_needs_attention",
            authorization: context.authorization,
          });
        }
      } catch (error) {
        context.closedOut.add(fact.taskId);
        context.needsAttention.add(fact.taskId);
        context.result.needsAttention.push({ taskId: fact.taskId, reason: reasonOf(error) });
        this.emit(context.result, "deliver_failed", {
          taskId: fact.taskId,
          stage: fact.stage,
          reason: reasonOf(error),
          authorization: context.authorization,
        });
      }
    }
  }
}
