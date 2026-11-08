/**
 * run 准备与启动（DESIGN.md 第5.6节、ARCHITECTURE.md 第5节）。
 * prepare 只发布 request/launch 意图，不取得执行占用、不写业务资料；
 * worker 认领后自行持锁、重新核实并冻结 inputs，implement 先建立快照。
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { RunLaunchState, RunPhase, RunPresentation, RunPresentationSource } from "../contracts/run.js";
import {
  LaunchRecordSchema,
  RunRequestFileSchema,
  type LaunchRecord,
  type RunRequestFile,
  type RunStageProcess,
  type RunStateFile,
} from "../contracts/run.js";
import { checkSchema } from "../contracts/schema.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { machineBootId, procStartTicks, processTable, processTreePids, sameProcessStart, signalProcessTree } from "../infrastructure/process.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { ContextPlanner } from "./context-planner.js";
import { GuardError } from "./guard-error.js";
import { locateTaskDocument } from "./task-service.js";
import { dependencyBlockersOf } from "./task-schedule.js";
import { assertExecutionRoute, executionRouteOf, mainRootOf } from "./worktree-routing.js";
import { loadScope, scopeDigest } from "./scope.js";
import { currentBranch } from "./delivery.js";
import { parseConfig, defaultConfig, type ExecutionHost } from "./config.js";
import { ensureWorktreeForDispatch, resolveWorktreePolicy, type WorktreePolicy } from "./worktree-automation.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RunAcceptanceService } from "./run-acceptance.js";
import { legalStageList, loadWorkflow, freezeStageDefinition } from "./workflow.js";
import { isDecisionStage } from "../domain/report.js";
import { LockManager, orderKeys, type LockReclaimRecord } from "../infrastructure/locks.js";
import { selectHost, type HostProbe, type HostSelection } from "./host-selection.js";

const WORKER_SCRIPT = fileURLToPath(new URL("../worker/knit-worker.js", import.meta.url));
/** 上一 worker 发布终态后释放租约的交接窗口；只在没有活动 worker 时等待，且不持 state 锁。 */
const LEASE_HANDOFF_WAIT_MS = 2_000;

export interface RunCoordinatorOptions {
  store: MetadataStore;
  planner?: ContextPlanner;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  /** 默认当前 Node 执行 dist/worker/knit-worker.js；测试可替换。 */
  workerCommand?: string[];
  confirmTimeoutMs?: number;
  lockRoot?: string;
  /** 测试或宿主注入；缺省使用 process.env 与真实 RexApi 探测。 */
  env?: NodeJS.ProcessEnv;
  hostProbe?: HostProbe;
}

export interface PrepareInput {
  dir: string;
  /** 当前检出根（任务执行目录）；缺省等于 dir（主检出）。 */
  executionDir?: string;
  taskId: string;
  phase: RunPhase;
  /** 调用级显式选择；缺省按 execution.host（未配置为 auto）解析。 */
  presentation?: RunPresentation;
  /** 已解析的宿主；resume 沿用旧 run 时使用，不再探测。 */
  hostSelection?: HostSelection;
  initiator: {
    client: "pi" | "cli";
    knitSessionId: string | null;
    nativeSessionId: string | null;
    cwd: string;
  };
  model: { runtime: string; provider: string; model: string };
  recovery?: { nativeSessionId: string | null; resume: "prefer" | "new" };
  diagnostics?: boolean;
  /** 实施阶段显式开启新修复周期（用户授权）；仅 implement 可用。 */
  newRepairCycle?: boolean;
  /** 明确授权为成果的正式规范路径（.knit/standards/ 下，任务037）。 */
  authorizedStandardPaths?: string[];
  /** 任务级 worktree 覆盖；缺省按项目 worktree.default。 */
  worktree?: WorktreePolicy;
}

export interface RunStatusProjection {
  runId: string;
  taskId: string;
  phase: RunPhase;
  /** 实际生效的流程模式；旧记录为 null。 */
  workflowMode: "config" | "fallback" | null;
  presentation: RunPresentation;
  presentationSource: RunPresentationSource;
  presentationFallbackReason: string | null;
  /** 请求冻结时的任务分支；用于观察通知不误投切树后的上下文。 */
  branch: string | null;
  initiator: RunRequestFile["initiator"];
  createdAt: string;
  updatedAt: string;
  launchState: RunLaunchState;
  attempts: number;
  state: string;
  prepared: boolean;
  snapshot: RunStateFile["snapshot"];
  /** 任务输入区摘要（与 binding.confirmedInputsDigest 同口径）。 */
  inputsDigest: string | null;
  /** 检查凭据使用的整体身份：任务输入区 + 正式规范。 */
  effectiveInputsDigest: string | null;
  standardsDigest: string | null;
  reason: string | null;
  handle: LaunchRecord["handle"];
  events: number;
  lastEventAt: string | null;
  lastEvent: string | null;
  cancelRequestedAt: string | null;
  cancelReason: string | null;
  stageProcess: RunStageProcess | null;
  stageProcessVerdict: "alive" | "not_alive" | "unknown" | "absent";
  result: import("../contracts/run.js").RunResultFile | null;
  acceptance: { operationId: string; state: string; reason: string | null } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RunCoordinator {
  private readonly store: MetadataStore;
  private readonly planner: ContextPlanner;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;
  private readonly workerCommand: string[];
  private readonly confirmTimeoutMs: number;
  private readonly lockRoot: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hostProbe: HostProbe | undefined;

  constructor(options: RunCoordinatorOptions) {
    this.store = options.store;
    this.planner = options.planner ?? new ContextPlanner({ store: options.store });
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
    this.workerCommand = options.workerCommand ?? [process.execPath, WORKER_SCRIPT];
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 5000;
    this.lockRoot = options.lockRoot ?? null;
    this.env = options.env ?? process.env;
    this.hostProbe = options.hostProbe;
  }

  /**
   * prepare 的短互斥：任务锁 + state 锁（主检出根）；不取工作树租约，worker 运行中其它任务仍可写状态。
   * 串行化同任务的重复 prepare，由锁内 findActive 复用既有 run。
   */
  private acquireForPrepare(locks: LockManager, root: string, taskId: string) {
    const keys = orderKeys([
      { scope: "task" as const, rawKey: `${root}::${taskId}` },
      { scope: "state" as const, rawKey: mainRootOf(root) },
    ]);
    return locks.acquireShort({ keys, action: "run.prepare" });
  }

  /**
   * 创建 run 前只读检查工作树租约：占用时 workspace_busy，不生成 run。
   * 只减少无效 run，不承诺强互斥；最终互斥由 worker 取租约保证。可自动回收的残留视为空闲（worker 取租约时回收）。
   */
  private assertWorkspaceFree(locks: LockManager, executionDir: string): void {
    const status = locks.inspect({ scope: "project", rawKey: executionDir });
    if (!status.exists || locks.reclaimable(status)) return;
    const owner = status.owner === null ? "owner 不可核实" : `action=${status.owner.action} pid=${status.owner.pid}`;
    throw new GuardError(
      "workspace_busy",
      `workspace_busy: 工作树 ${executionDir} 正被占用（${owner}，核实=${status.processVerdict}）；等待其结束后重试，或改到独立 worktree 执行`,
    );
  }

  /**
   * 锁外等待租约交接：上一 worker 发布终态后可能尚在 finally 释放租约。
   * 有活动 worker 时租约是真占用，不等待；不持 state 锁，避免阻塞其它任务写入。
   */
  private async awaitLeaseHandoff(locks: LockManager, root: string, taskId: string): Promise<void> {
    const binding = await this.store.bindings.get(taskId);
    if (binding === null) return;
    const route = executionRouteOf(binding, root);
    if (route.state === "invalid") return;
    const runs = new RunStore(root);
    if (this.hasLiveWorker(runs, route.dir, root)) return;
    const deadline = Date.now() + LEASE_HANDOFF_WAIT_MS;
    while (Date.now() < deadline) {
      const status = locks.inspect({ scope: "project", rawKey: route.dir });
      if (!status.exists || locks.reclaimable(status)) return;
      await sleep(25);
    }
  }

  /** 该执行目录上是否有尚未到达终态的 run；有则租约是真占用，不等交接窗口。 */
  private hasLiveWorker(runs: RunStore, executionDir: string, root: string): boolean {
    return runs.listRunIds().some((runId) => {
      const request = runs.readRequest(runId);
      const state = runs.readState(runId);
      return request !== null && state !== null && ["claimed", "preparing", "running"].includes(state.state) &&
        (request.expected.executionDir ?? root) === executionDir;
    });
  }

  /**
   * 发布不可变请求与启动意图。已有同任务／阶段活动 run 时返回既有对象，
   * 不生成替代 run；ID 在返回前已落盘，调用方无需再次许可。
   */
  async prepare(input: PrepareInput): Promise<{ request: RunRequestFile; launch: LaunchRecord; reused: boolean }> {
    const root = normalizeRoot(input.dir);
    const startDir = normalizeRoot(input.executionDir ?? input.dir);
    const worktreePolicy = resolveWorktreePolicy(this.projectConfig(root), input.worktree ?? null);
    const ensured = await this.ensureWorktreeBeforePrepare({
      root,
      startDir,
      taskId: input.taskId,
      phase: input.phase,
      policy: worktreePolicy,
    });
    // 宿主探测可能启动外部进程，放在短锁之外。
    const selection = await this.resolveHostSelection(root, input);
    const locks = new LockManager(this.lockRoot === null ? {} : { root: this.lockRoot });
    await this.awaitLeaseHandoff(locks, root, input.taskId);
    const lock = await this.acquireForPrepare(locks, root, input.taskId);
    try {
    const binding = await this.store.bindings.get(input.taskId);
    if (binding === null) throw new GuardError("unknown_binding", `任务缺少绑定: ${input.taskId}`);
    // 工作区路由：worktree 生效时任务资料与执行目录都在 worktree；invalid 不回退主检出。
    const route = executionRouteOf(binding, root);
    // 仅本次自动准备或复用已指向 worktree 的活动 run 时，从主检出切到执行目录；
    // 手动建立但未从这里派发的绑定仍要求先 cd 到 worktree（保留既有路由守卫）。
    const activeRequest = this.findActive(new RunStore(root), input.taskId, input.phase)?.request ?? null;
    const autoFromMain = resolve(startDir) === resolve(root) && (
      (ensured.actions.length > 0 && ensured.worktreePath !== null) ||
      (activeRequest?.expected.executionDir !== undefined && activeRequest.expected.executionDir === route.dir)
    );
    const dispatchStartDir = route.state === "worktree" && autoFromMain ? route.dir : startDir;
    assertExecutionRoute(route, dispatchStartDir);
    const executionDir = route.dir;
    let located;
    try {
      located = locateTaskDocument(executionDir, input.taskId);
    } catch {
      throw new GuardError("unknown_task", `任务不存在: ${input.taskId}`);
    }
    if (located.archived) throw new GuardError("task_archived", `任务已归档: ${input.taskId}`);
    // 生效流程先决定阶段是否合法：未知阶段要返回合法清单，不能被 phase_mismatch 掩盖。
    const loaded = loadWorkflow(root);
    const workflowStage = loaded.workflow.stages.find((stage) => stage.id === input.phase) ?? null;
    if (workflowStage === null) {
      // 降级流程没有业务阶段：新 run 必须失败，不能静默用默认 agent 行为执行未知阶段。
      const legal = legalStageList(loaded.workflow, false);
      const note = loaded.mode === "fallback" ? `（配置降级：${loaded.validation.reason}；仅 start → deliver）` : "";
      throw new GuardError("stage_not_in_workflow", `阶段不在生效流程中: ${input.phase}；合法阶段: ${legal}${note}`);
    }
    if (located.document.frontmatter.stage !== input.phase) {
      throw new GuardError(
        "phase_mismatch",
        `任务阶段为 ${located.document.frontmatter.stage}，不能准备 ${input.phase}；合法阶段: ${legalStageList(loaded.workflow, false)}`,
      );
    }
    if (located.document.frontmatter.status !== "open") {
      throw new GuardError("task_not_open", `任务不是 open 状态: ${input.taskId}`);
    }
    // 执行分支：worktree 路由取 worktree 分支（frontmatter 保留源分支 refs/heads/main，不作否决依据）。
    const expectedBranch = route.state === "worktree" ? route.branch : located.document.frontmatter.branch;
    // 运行边界核对实际检出分支：与任务绑定和 request 三方一致才准启动（任务028）。
    if (expectedBranch !== null) {
      const liveBranch = currentBranch(executionDir);
      if (liveBranch === null) {
        throw new GuardError("branch_mismatch", "当前处于 detached HEAD，不能启动绑定分支的阶段");
      }
      if (liveBranch !== expectedBranch) {
        throw new GuardError(
          "branch_mismatch",
          `当前检出分支 ${liveBranch} 与任务执行分支 ${expectedBranch} 不一致；按 task adopt 接管或切回 ${expectedBranch}`,
        );
      }
      if (route.state === "main" && binding.branch !== null && liveBranch !== binding.branch) {
        throw new GuardError(
          "branch_mismatch",
          `当前检出分支 ${liveBranch} 与任务绑定 ${binding.branch} 不一致；按 task adopt 接管或切回 ${binding.branch}`,
        );
      }
    }
    if (binding.pendingDraft !== null) {
      throw new GuardError("pending_inputs", "存在待应用输入，先应用或撤回再启动代码阶段");
    }
    // 生效流程决定阶段语义：有报告枚举的是结论阶段，其余是产出阶段。
    const decisionStage = isDecisionStage(workflowStage);
    // 前置依赖铁律（DESIGN §3.11）：未满足依赖时实施入口不启动，优先级与用户指定都不绕过。
    if (!decisionStage) {
      const blockers = dependencyBlockersOf(executionDir, input.taskId);
      if (blockers.length > 0) {
        const detail = blockers.map((blocker) => `${blocker.taskId}(${blocker.problem})`).join(", ");
        throw new GuardError("dependency_unmet", `前置依赖未满足，不能启动实施: ${detail}`);
      }
    }
    const runs = new RunStore(root);
    // 无可复用 run 时在任何写入前检查租约；活动 run 走复用，收敛死 run 后在创建前再查一次。
    if (activeRequest === null) this.assertWorkspaceFree(locks, executionDir);
    if (!decisionStage) {
      const maxRounds = this.maxRounds(root);
      if (input.newRepairCycle === true) {
        const cycleId = `rep-${this.randomHex(6)}`;
        // 新周期由用户显式授权：同时清空阶段访问计数，允许再次进入回退目标。
        await this.store.bindings.save({ ...binding, repairCycleId: cycleId, repairRounds: 0, stopReason: null, stageVisits: {} });
        binding.repairCycleId = cycleId;
        binding.repairRounds = 0;
        binding.stopReason = null;
        binding.stageVisits = {};
      } else if (binding.stopReason !== null) {
        throw new GuardError("repair_stopped", `修复周期已停止：${binding.stopReason}`);
      } else if (binding.repairCycleId !== null && (binding.repairRounds ?? 0) >= maxRounds) {
        throw new GuardError("repair_round_limit", `修复轮次已达上限 ${maxRounds}；需显式开启新周期`);
      }
    } else if (input.newRepairCycle === true) {
      throw new GuardError("invalid_request", "只有实施阶段可以开启修复周期");
    }
    const plan = await this.planner.plan({
      dir: executionDir,
      taskId: input.taskId,
      stage: input.phase,
      authorizedStandardPaths: input.authorizedStandardPaths,
      // 新请求按当前模式规划：已降级时不套旧阶段提示词；在途 config run 由 worker 按请求模式保留。
      keepLegacyStagePrompt: loaded.mode !== "fallback",
    });
    if (!plan.ready) {
      throw new GuardError("plan_not_ready", `上下文计划未就绪：${plan.blockers.join(", ")}`);
    }
    let active = this.findActive(runs, input.taskId, input.phase);
    // 活动 run 的 worker 被强杀：同一启动周期且 worker 与阶段 Pi 都确认已死、没有结果时，
    // 按 resume 语义收敛旧 run（failed／cancelled）再新建 run，避免复用无进程执行的旧 run。
    let settledRun: RunRequestFile | null = null;
    while (active !== null && this.settleDeadRun(runs, active.request.runId)) {
      settledRun = active.request;
      active = this.findActive(runs, input.taskId, input.phase);
    }
    // 与 resume 一致：未显式指定恢复会话（prefer 且无 nativeSessionId）时续用旧 run 的原生会话，
    // 新阶段取同一 Session 锁时自动回收旧 run 残留的 Session 锁。
    let recovery = input.recovery ?? { nativeSessionId: null, resume: "prefer" as const };
    if (settledRun !== null && recovery.resume === "prefer" && recovery.nativeSessionId === null) {
      const sessions = await this.store.sessions.list({ taskId: settledRun.taskId });
      const prior = sessions.find((session) => session.runId === settledRun.runId);
      const nativeSessionId = prior?.ref.nativeSessionId ?? settledRun.recovery.nativeSessionId;
      if (nativeSessionId !== null) recovery = { nativeSessionId, resume: "prefer" };
    }
    if (active !== null) {
      const activePresentation = active.request.presentation ?? "local";
      if (activePresentation !== selection.host) {
        throw new GuardError(
          "invalid_request",
          `已有活动 run 使用 ${activePresentation} 呈现；先取消或等待其结束后再切换到 ${selection.host}`,
        );
      }
      this.recordReclaims(runs, active.request.runId, lock.reclaimed);
      return { request: active.request, launch: active.launch, reused: true };
    }
    if (settledRun !== null) this.assertWorkspaceFree(locks, executionDir);

    const createdAt = this.now().toISOString();
    const runId = `run-${this.randomHex(6)}`;
    const acceptanceOperationId = `accept-${this.randomHex(6)}`;
    const request: RunRequestFile = {
      schemaVersion: 1,
      protocolVersion: 1,
      runId,
      taskId: input.taskId,
      phase: input.phase,
      workflowMode: loaded.mode,
      worktree: { policy: worktreePolicy.policy, source: worktreePolicy.source },
      stageDefinition: freezeStageDefinition(workflowStage) ?? undefined,
      presentation: selection.host,
      presentationSource: selection.source,
      presentationFallbackReason: selection.fallbackReason,
      purpose: "stage",
      initiator: input.initiator,
      createdAt,
      expected: {
        branch: expectedBranch,
        executionDir,
        inputsDigest: plan.inputsDigest,
        standardsDigest: plan.standardsDigest,
        effectiveInputsDigest: plan.effectiveInputsDigest,
        planId: plan.planId,
        scopeDigest: decisionStage ? scopeDigest(loadScope(runs, input.taskId, createdAt).entries) : null,
        authorizedStandardOutputs: plan.authorizedStandardOutputs,
      },
      model: input.model,
      toolPolicy: plan.toolPolicy,
      recovery,
      acceptanceOperationId,
      diagnostics: { enabled: input.diagnostics ?? false },
    };
    if (!checkSchema(RunRequestFileSchema, request)) {
      throw new InfrastructureError("io_error", "run request 结构不符");
    }
    await this.store.operations.save({
      operationId: acceptanceOperationId,
      kind: "run_acceptance",
      state: "planned",
      reason: `prepare ${input.phase}`,
      recordedAt: createdAt,
    });
    const created = runs.create(request);
    this.recordReclaims(runs, created.request.runId, lock.reclaimed);
    const launch = runs.readLaunch(runId);
    if (launch === null) throw new InfrastructureError("io_error", "launch 未写入");
    return { request: created.request, launch, reused: !created.created };
    } finally {
      locks.release(lock);
    }
  }

  /**
   * 启动本地 worker 并等待认领／准备确认。
   * 已有存活句柄时只观察原运行；句柄已死且未认领时置 failed，不盲目生成替代运行。
   */
  async start(input: { dir: string; runId: string; retry?: boolean; prepareOnly?: boolean }): Promise<{
    launch: LaunchRecord;
    state: RunStateFile | null;
    confirmed: boolean;
    reused: boolean;
  }> {
    const root = normalizeRoot(input.dir);
    const runs = new RunStore(root);
    const request = runs.readRequest(input.runId);
    if (request === null) throw new GuardError("unknown_run", `run 不存在: ${input.runId}`);
    let launch = runs.readLaunch(input.runId);
    if (launch === null) throw new InfrastructureError("io_error", `launch 缺失: ${input.runId}`);

    if (launch.state === "confirmed") {
      return { launch, state: runs.readState(input.runId), confirmed: true, reused: true };
    }
    if (launch.state === "starting") {
      const verdict = this.handleVerdict(launch.handle);
      const state = runs.readState(input.runId);
      if (verdict === "alive" || verdict === "unknown") {
        const waited = await this.waitForPrepared(runs, input.runId, state?.prepared === true ? 0 : this.confirmTimeoutMs);
        if (waited.state?.prepared === true) {
          launch = this.confirm(runs, launch, waited.state);
          return { launch, state: waited.state, confirmed: true, reused: true };
        }
        if (waited.state !== null && ["failed", "completed", "cancelled"].includes(waited.state.state)) {
          launch = this.failLaunch(runs, launch, waited.state.reason ?? "worker_failed");
          return { launch, state: waited.state, confirmed: false, reused: true };
        }
        return { launch, state: waited.state, confirmed: false, reused: true };
      }
      if (verdict === "absent") {
        // 句柄尚未写入就中断：无法定位原实例，不盲目启动第二个 worker。
        launch = this.failLaunch(runs, launch, "handle_missing");
        return { launch, state: runs.readState(input.runId), confirmed: false, reused: true };
      }
      if (verdict === "not_alive") {
        const state = runs.readState(input.runId);
        if (state !== null && state.prepared) {
          launch = this.confirm(runs, launch, state);
          return { launch, state, confirmed: true, reused: true };
        }
        launch = this.failLaunch(runs, launch, state?.reason ?? "worker_exited_before_claim");
        return { launch, state, confirmed: false, reused: true };
      }
    }
    if (launch.state === "failed" && input.retry !== true) {
      return { launch, state: runs.readState(input.runId), confirmed: false, reused: true };
    }

    // planned 或显式重试：先落盘 starting，再启动；句柄写入后仍以 state 为准确认。
    runs.resetForRetry(input.runId);
    const starting: LaunchRecord = {
      ...launch,
      state: "starting",
      attempts: launch.attempts + 1,
      updatedAt: this.now().toISOString(),
      handle: null,
      instance: null,
      lastError: null,
    };
    runs.writeLaunch(input.runId, starting);
    runs.appendEvent(input.runId, { event: "launch_starting", attempt: starting.attempts });
    const args = [...this.workerCommand, "--run", input.runId, "--dir", root];
    if (input.prepareOnly === true) args.push("--prepare-only");
    if (this.lockRoot !== null) args.push("--locks", this.lockRoot);
    const port = new (await import("../infrastructure/process.js")).NodeProcessPort();
    let managed;
    try {
      managed = await port.spawn(args[0] ?? process.execPath, args.slice(1), {
        cwd: root,
        inheritStderr: runs.readRequest(input.runId)?.diagnostics.enabled === true,
        detachStreams: true,
      });
    } catch (error) {
      const failed = this.failLaunch(runs, starting, `spawn_failed: ${error instanceof Error ? error.message : String(error)}`);
      return { launch: failed, state: null, confirmed: false, reused: false };
    }
    const handle = {
      pid: managed.pid,
      bootId: machineBootId(),
      procStartTicks: procStartTicks(managed.pid),
      hostname: hostname(),
      recordedAt: this.now().toISOString(),
    };
    const launched: LaunchRecord = { ...starting, handle, updatedAt: this.now().toISOString() };
    if (!checkSchema(LaunchRecordSchema, launched)) throw new InfrastructureError("io_error", "launch handle 结构不符");
    runs.writeLaunch(input.runId, launched);
    // 读取 stdout/stderr 只用于防止管道背压；内容不进入业务证据。
    void managed.stdout.pipeTo(new WritableStream());
    void managed.stderr.pipeTo(new WritableStream());
    const waited = await this.waitForPrepared(runs, input.runId, this.confirmTimeoutMs);
    if (waited.state?.prepared === true) {
      const confirmed = this.confirm(runs, launched, waited.state);
      return { launch: confirmed, state: waited.state, confirmed: true, reused: false };
    }
    if (waited.state !== null && ["failed", "completed", "cancelled"].includes(waited.state.state)) {
      const failed = this.failLaunch(runs, launched, waited.state.reason ?? "worker_failed");
      return { launch: failed, state: waited.state, confirmed: false, reused: false };
    }
    const verdict = this.handleVerdict(launched.handle);
    if (verdict === "not_alive" && waited.state === null) {
      const failed = this.failLaunch(runs, launched, "worker_exited_before_claim");
      return { launch: failed, state: null, confirmed: false, reused: false };
    }
    return { launch: launched, state: waited.state, confirmed: false, reused: false };
  }

  async status(input: { dir: string; runId: string }): Promise<RunStatusProjection> {
    const runs = new RunStore(normalizeRoot(input.dir));
    const request = runs.readRequest(input.runId);
    if (request === null) throw new GuardError("unknown_run", `run 不存在: ${input.runId}`);
    const launch = runs.readLaunch(input.runId);
    const state = runs.readState(input.runId);
    const inputs = runs.readInputs(input.runId);
    const cancel = runs.readCancel(input.runId);
    const stageProcess = runs.readStageProcess(input.runId);
    let result = null;
    try {
      result = runs.readResult(input.runId);
    } catch {
      // 结果文件损坏／被占用时只读投影不崩溃；事实缺失按 null 报告。
      result = null;
    }
    const operation = await this.store.operations.get(request.acceptanceOperationId);
    const events = runs.readEvents(input.runId);
    const last = events.length === 0 ? null : events[events.length - 1];
    return {
      runId: request.runId,
      taskId: request.taskId,
      phase: request.phase,
      workflowMode: state?.workflowMode ?? result?.workflowMode ?? request.workflowMode ?? null,
      presentation: request.presentation ?? "local",
      presentationSource: request.presentationSource ?? "config",
      presentationFallbackReason: request.presentationFallbackReason ?? null,
      branch: request.expected.branch,
      initiator: request.initiator,
      createdAt: request.createdAt,
      updatedAt: state?.updatedAt ?? launch?.updatedAt ?? request.createdAt,
      launchState: launch?.state ?? "planned",
      attempts: launch?.attempts ?? 0,
      state: state?.state ?? "claimed",
      prepared: state?.prepared ?? false,
      snapshot: state?.snapshot ?? null,
      inputsDigest: inputs?.inputsDigest ?? null,
      effectiveInputsDigest: inputs?.effectiveInputsDigest ?? null,
      standardsDigest: inputs?.standardsDigest ?? null,
      reason: state?.reason ?? launch?.lastError ?? null,
      handle: launch?.handle ?? null,
      events: events.length,
      lastEventAt: typeof last?.at === "string" ? last.at : null,
      lastEvent: typeof last?.event === "string" ? last.event : null,
      cancelRequestedAt: cancel?.requestedAt ?? null,
      cancelReason: cancel?.reason ?? null,
      stageProcess,
      stageProcessVerdict: this.stageProcessVerdict(stageProcess),
      result,
      acceptance:
        operation === null
          ? null
          : { operationId: operation.operationId, state: operation.state, reason: operation.reason ?? null },
    };
  }

  /** 已解析宿主（resume 直接沿用旧选择，不再探测）；显式与已解析值冲突时拒绝。 */
  private async resolveHostSelection(root: string, input: PrepareInput): Promise<HostSelection> {
    if (input.hostSelection !== undefined) {
      if (input.presentation !== undefined && input.presentation !== input.hostSelection.host) {
        throw new GuardError("invalid_request", "显式呈现选择与已解析的宿主不一致");
      }
      return input.hostSelection;
    }
    return await selectHost({
      explicit: input.presentation ?? null,
      config: this.executionHost(root),
      env: this.env,
      probe: this.hostProbe,
    });
  }

  /** 项目配置；缺失按默认，存在但非法如实上抛（doctor 已报告具体字段）。 */
  private projectConfig(root: string): ReturnType<typeof defaultConfig> {
    const path = join(root, ".knit", "config.json");
    if (!existsSync(path)) return defaultConfig();
    return parseConfig(readFileSync(path, "utf8"));
  }

  /**
   * 派发首个配置阶段前的自动准备：只读核对阶段／任务／活动 run，满足条件后调
   * 确保流程（create → handoff → prepare）；失败不落 request，由调用方收到明确原因。
   */
  private async ensureWorktreeBeforePrepare(input: {
    root: string;
    startDir: string;
    taskId: string;
    phase: RunPhase;
    policy: WorktreePolicy;
  }): Promise<Awaited<ReturnType<typeof ensureWorktreeForDispatch>>> {
    const empty = { ensured: false, worktreePath: null, actions: [] as Array<"create" | "handoff" | "prepare"> };
    const binding = await this.store.bindings.get(input.taskId);
    if (binding === null) return empty;
    const route = executionRouteOf(binding, input.root);
    if (route.state === "invalid") return empty;
    let located;
    try {
      located = locateTaskDocument(route.dir, input.taskId);
    } catch {
      return empty;
    }
    if (located.archived) return empty;
    const loaded = loadWorkflow(input.root);
    const first = loaded.workflow.stages[0];
    if (first === undefined || first.id !== input.phase) return empty;
    if (located.document.frontmatter.stage !== input.phase) return empty;
    if (located.document.frontmatter.status !== "open") return empty;
    // 活动 run 的 prepare 会复用原请求，不因这次调用重建环境。
    if (this.findActive(new RunStore(input.root), input.taskId, input.phase) !== null) return empty;
    return await ensureWorktreeForDispatch({
      root: input.root,
      taskId: input.taskId,
      store: this.store,
      policy: input.policy,
      firstStage: true,
      fromMain: resolve(input.startDir) === resolve(input.root),
      locksRoot: this.lockRoot,
    });
  }

  /** execution.host；配置缺失时按未配置（auto）处理，存在但非法时按配置错误报告。 */
  private executionHost(root: string): ExecutionHost | null {
    const path = join(root, ".knit", "config.json");
    if (!existsSync(path)) return null;
    return parseConfig(readFileSync(path, "utf8")).execution.host;
  }

  /** 项目修复轮次上限；配置缺失时用默认值。 */
  private maxRounds(root: string): number {
    try {
      return parseConfig(readFileSync(join(root, ".knit", "config.json"), "utf8")).workflow.maxRepairRounds;
    } catch {
      return defaultConfig().workflow.maxRepairRounds;
    }
  }

  /**
   * 落盘取消意图；worker 在安全点观察。只影响本 run，不作用于后来新 run。
   * 只有确认 worker 与阶段 Pi 都已结束且尚无结果时才直接收敛为 cancelled；
   * 未知存活时保留意图，不猜、不自动强解。显式 terminate 只处理本 run 记录的自有进程组。
   */
  async cancel(input: { dir: string; runId: string; reason?: string | null; terminate?: boolean }): Promise<{
    runId: string;
    requested: boolean;
    state: string;
    reason: string | null;
    workerVerdict: "alive" | "not_alive" | "unknown" | "absent";
    stageVerdict: "alive" | "not_alive" | "unknown" | "absent";
    terminated: boolean;
    terminalized: boolean;
  }> {
    const runs = new RunStore(normalizeRoot(input.dir));
    const request = runs.readRequest(input.runId);
    if (request === null) throw new GuardError("unknown_run", `run 不存在: ${input.runId}`);
    const state = runs.readState(input.runId);
    const launch = runs.readLaunch(input.runId);
    const result = runs.readResult(input.runId);
    const workerVerdict = this.handleVerdict(launch?.handle ?? null);
    let stage = runs.readStageProcess(input.runId);
    let stageVerdict = this.stageProcessVerdict(stage);
    if (state !== null && ["completed", "cancelled", "failed"].includes(state.state)) {
      return { runId: input.runId, requested: false, state: state.state, reason: "already_terminal", workerVerdict, stageVerdict, terminated: false, terminalized: false };
    }
    if (result !== null && result.state === "completed") {
      return { runId: input.runId, requested: false, state: state?.state ?? "running", reason: "result_published", workerVerdict, stageVerdict, terminated: false, terminalized: false };
    }
    runs.writeCancel(input.runId, {
      schemaVersion: 1,
      runId: input.runId,
      operationId: `cancel-${this.randomHex(6)}`,
      token: this.randomHex(16),
      requestedAt: this.now().toISOString(),
      reason: input.reason ?? null,
    });
    runs.appendEvent(input.runId, { event: "cancel_requested", reason: input.reason ?? null });
    let terminated = false;
    if (input.terminate === true && stageVerdict === "alive" && stage !== null && stage.piPid !== null) {
      terminated = await this.terminateStage(stage);
      stage = runs.readStageProcess(input.runId);
      stageVerdict = this.stageProcessVerdict(stage);
    }
    // 取消与完成竞态：已有结果留给 resume 接收；只有明确没有结果且两个执行者都不存活才收敛。
    const current = runs.readState(input.runId);
    let terminalized = false;
    if (current !== null && runs.readResult(input.runId) === null && workerVerdict === "not_alive" && (stageVerdict === "not_alive" || (stage === null && ["prepared", "preparing"].includes(current.state)))) {
      runs.writeState(input.runId, {
        ...current,
        state: "cancelled",
        reason: "cancel_requested_worker_exited",
        updatedAt: this.now().toISOString(),
      });
      runs.appendEvent(input.runId, { event: "cancelled_without_result", workerVerdict, stageVerdict });
      terminalized = true;
    }
    const latest = runs.readState(input.runId);
    return {
      runId: input.runId,
      requested: true,
      state: latest?.state ?? state?.state ?? "claimed",
      reason: terminalized ? null : "cancel_recorded",
      workerVerdict,
      stageVerdict,
      terminated,
      terminalized,
    };
  }

  /** 终止本 run 已核实身份的 Pi 及全部后代（工具可能另建进程组），SIGTERM 后 SIGKILL。 */
  private async terminateStage(stage: RunStageProcess): Promise<boolean> {
    if (stage.piPid === null || this.stageProcessVerdict(stage) !== "alive") return false;
    const tree = processTreePids(stage.piPid);
    if (tree.length === 0) return false;
    signalProcessTree(stage.piPid, "SIGTERM", tree);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (tree.every((pid) => !processTable().has(pid))) return true;
      await sleep(50);
    }
    signalProcessTree(stage.piPid, "SIGKILL", tree);
    await sleep(200);
    return tree.every((pid) => !processTable().has(pid));
  }

  private stageProcessVerdict(stage: RunStageProcess | null): "alive" | "not_alive" | "unknown" | "absent" {
    if (stage === null) return "absent";
    if (stage.piPid === null) return stage.state === "exited" ? "not_alive" : "unknown";
    return this.identityVerdict(stage.piPid, stage.bootId, stage.procStartTicks);
  }
  /**
   * resume --run：旧执行确认结束后，若结果有效但未接收，先接收且不重跑模型；
   * 已有结果且已接收时不再生成新 run；无结果时用原会话／新会话恢复同一阶段。
   */
  async resume(input: { dir: string; oldRunId: string; executionDir?: string }): Promise<{
    oldRunId: string;
    accepted: boolean;
    resumed: boolean;
    request: RunRequestFile | null;
    launch: LaunchRecord | null;
    reason: string | null;
  }> {
    const root = normalizeRoot(input.dir);
    const runs = new RunStore(root);
    const locks = new LockManager(this.lockRoot === null ? {} : { root: this.lockRoot });
    const old = runs.readRequest(input.oldRunId);
    if (old === null) throw new GuardError("unknown_run", `run 不存在: ${input.oldRunId}`);
    const state = runs.readState(input.oldRunId);
    const launch = runs.readLaunch(input.oldRunId);
    const result = runs.readResult(input.oldRunId);
    if (result === null && state !== null && ["claimed", "preparing", "running"].includes(state.state)) {
      const alive = this.handleVerdict(launch?.handle ?? null);
      // 只有明确证明原句柄已死才允许续做；句柄缺失同样视为未确认结束。
      if (alive !== "not_alive") {
        throw new GuardError("run_active", `旧执行尚未确认结束: ${input.oldRunId}`);
      }
      const stage = runs.readStageProcess(input.oldRunId);
      const stageVerdict = this.stageProcessVerdict(stage);
      // worker 退出后其启动的 Pi／工具可能仍在运行；未确认结束不换新会话兜底。
      if (stageVerdict === "alive" || stageVerdict === "unknown" || (stage === null && ["running", "preparing"].includes(state.state))) {
        throw new GuardError("run_active", `旧阶段的 Pi／工具尚未确认结束: ${input.oldRunId}`);
      }
      // 旧项目锁仍是现场事实：同一启动周期且 owner（含登记的阶段进程）确认已死时，
      // 后续 prepare 取锁会自动回收；其余（alive／unknown）未显式清理前不得由新会话抢先续做。
      const leftover = locks.list().find((entry) => entry.scope === "project" && entry.key === root);
      if (leftover !== undefined && !locks.reclaimable(leftover)) {
        throw new GuardError(
          "run_active",
          `旧执行的项目锁尚未释放: ${input.oldRunId}（${leftover.id}，owner ${leftover.owner?.action ?? "未知"} pid=${leftover.owner?.pid ?? "?"}，核实=${leftover.processVerdict}）；` +
            `确认原进程已停止后 knit unlock ${leftover.id} --expect-token ${leftover.owner?.token ?? "<token>"}${leftover.processVerdict === "not_alive" ? "" : " --force"}`,
        );
      }
      // 已确认 worker 与阶段工具都结束且没有结果：关闭旧活动态，避免 prepare 复用为活动 run。
      this.closeDeadRun(runs, input.oldRunId, state, { workerVerdict: alive, stageVerdict });
    }
    const acceptance = new RunAcceptanceService({ store: this.store, locks, now: this.now, randomHex: this.randomHex });
    if (result !== null) {
      const accepted = await acceptance.accept({ dir: root, runId: input.oldRunId });
      if (!accepted.accepted) {
        return { oldRunId: input.oldRunId, accepted: false, resumed: false, request: null, launch: null, reason: accepted.reason };
      }
      const operation = await this.store.operations.get(old.acceptanceOperationId);
      const latestState = runs.readState(input.oldRunId);
      if (result.state === "completed" && operation?.state === "completed" && latestState !== null && ["completed", "failed", "cancelled"].includes(latestState.state)) {
        return { oldRunId: input.oldRunId, accepted: true, resumed: false, request: null, launch: null, reason: "already_accepted" };
      }
    }
    // 结果缺失或旧 run 未进入终态：以原会话（若已登记）或新会话续做同一阶段。
    let nativeSessionId = old.recovery.nativeSessionId;
    const sessions = await this.store.sessions.list({ taskId: old.taskId });
    const prior = sessions.find((session) => session.runId === input.oldRunId);
    if (prior !== undefined) nativeSessionId = prior.ref.nativeSessionId;
    const prepared = await this.prepare({
      dir: root,
      ...(input.executionDir === undefined ? {} : { executionDir: input.executionDir }),
      taskId: old.taskId,
      phase: old.phase,
      hostSelection: {
        host: old.presentation ?? "local",
        source: old.presentationSource ?? "config",
        fallbackReason: old.presentationFallbackReason ?? null,
      },
      initiator: old.initiator,
      model: old.model,
      recovery: { nativeSessionId, resume: "prefer" },
      ...(old.worktree === undefined
        ? {}
        : { worktree: { policy: old.worktree.policy, source: "resume" as const } }),
    });
    return {
      oldRunId: input.oldRunId,
      accepted: true,
      resumed: true,
      request: prepared.request,
      launch: prepared.launch,
      reason: prepared.reused ? "existing_run" : "resumed",
    };
  }

  /**
   * prepare 遇到活动 run 时核实其进程：已有结果、未启动或 worker／阶段 Pi 存活／不可核实（含跨启动周期）
   * 都保持复用保护；只有 worker 与阶段 Pi 都确认已死且没有结果时收敛旧 run 并返回 true。
   */
  private settleDeadRun(runs: RunStore, runId: string): boolean {
    if (runs.readResult(runId) !== null) return false;
    const state = runs.readState(runId);
    if (state === null || !["claimed", "preparing", "running"].includes(state.state)) return false;
    const launch = runs.readLaunch(runId);
    if (launch === null || (launch.state !== "confirmed" && launch.state !== "starting")) return false;
    const workerVerdict = this.handleVerdict(launch.handle);
    if (workerVerdict !== "not_alive") return false;
    const stage = runs.readStageProcess(runId);
    const stageVerdict = this.stageProcessVerdict(stage);
    if (stageVerdict === "alive" || stageVerdict === "unknown") return false;
    if (stage === null && ["running", "preparing"].includes(state.state)) return false;
    this.closeDeadRun(runs, runId, state, { workerVerdict, stageVerdict, by: "prepare" });
    return true;
  }

  /** 关闭已确认无进程执行的旧活动 run：有取消请求记 cancelled，否则 failed。 */
  private closeDeadRun(runs: RunStore, runId: string, state: RunStateFile, detail: Record<string, unknown>): void {
    const cancelled = runs.readCancel(runId) !== null;
    runs.writeState(runId, {
      ...state,
      state: cancelled ? "cancelled" : "failed",
      reason: cancelled ? "cancel_requested_worker_exited" : "worker_exited_before_result",
      updatedAt: this.now().toISOString(),
    });
    runs.appendEvent(runId, { event: "recovered_without_result", ...detail });
  }

  /** prepare 取锁时自动回收的残留锁写入 run 事件，诊断可查（锁根 reclaimed/ 另有完整记录）。 */
  private recordReclaims(runs: RunStore, runId: string, reclaimed: LockReclaimRecord[] | undefined): void {
    for (const record of reclaimed ?? []) {
      runs.appendEvent(runId, {
        event: "lock_reclaimed",
        lockId: record.id,
        previousAction: record.previousOwner.action,
        previousPid: record.previousOwner.pid,
        archive: record.archive,
      });
    }
  }

  private findActive(
    runs: RunStore,
    taskId: string,
    phase: RunPhase,
  ): { request: RunRequestFile; launch: LaunchRecord } | null {
    for (const runId of runs.listRunIds()) {
      const request = runs.readRequest(runId);
      if (request === null || request.taskId !== taskId || request.phase !== phase) continue;
      const launch = runs.readLaunch(runId);
      if (launch === null || launch.state === "failed") continue;
      const state = runs.readState(runId);
      if (state !== null && ["completed", "cancelled", "failed"].includes(state.state)) continue;
      return { request, launch };
    }
    return null;
  }

  private handleVerdict(handle: LaunchRecord["handle"]): "alive" | "not_alive" | "unknown" | "absent" {
    if (handle === null) return "absent";
    return this.identityVerdict(handle.pid, handle.bootId, handle.procStartTicks);
  }

  private identityVerdict(pid: number, bootId: string, recordedTicks: string | null): "alive" | "not_alive" | "unknown" {
    if (bootId !== machineBootId()) return "unknown";
    const ticks = procStartTicks(pid);
    // 无启动身份时再检查PID是否存在；无/proc或读取失败不能冒充死亡。
    if (ticks === null) {
      try {
        process.kill(pid, 0);
        return "unknown";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "not_alive" : "unknown";
      }
    }
    if (recordedTicks === null) return "unknown";
    return sameProcessStart(recordedTicks, ticks) ? "alive" : "not_alive";
  }

  private async waitForPrepared(
    runs: RunStore,
    runId: string,
    timeoutMs: number,
  ): Promise<{ state: RunStateFile | null }> {
    const deadline = Date.now() + timeoutMs;
    let state = runs.readState(runId);
    while (state === null || (!state.prepared && !["failed", "completed", "cancelled"].includes(state.state))) {
      if (Date.now() >= deadline) break;
      await sleep(25);
      state = runs.readState(runId);
    }
    return { state };
  }

  private confirm(runs: RunStore, launch: LaunchRecord, state: RunStateFile): LaunchRecord {
    if (launch.state === "confirmed") return launch;
    const confirmed: LaunchRecord = {
      ...launch,
      state: "confirmed",
      updatedAt: this.now().toISOString(),
      instance: {
        workerId: state.worker.workerId,
        pid: state.worker.pid,
        bootId: state.worker.bootId,
        procStartTicks: state.worker.procStartTicks,
        claimedAt: state.claimedAt,
      },
      lastError: null,
    };
    runs.writeLaunch(launch.runId, confirmed);
    runs.appendEvent(launch.runId, { event: "launch_confirmed", workerId: state.worker.workerId });
    return confirmed;
  }

  private failLaunch(runs: RunStore, launch: LaunchRecord, reason: string): LaunchRecord {
    const failed: LaunchRecord = {
      ...launch,
      state: "failed",
      updatedAt: this.now().toISOString(),
      lastError: reason,
    };
    runs.writeLaunch(launch.runId, failed);
    runs.appendEvent(launch.runId, { event: "launch_failed", reason });
    return failed;
  }
}
