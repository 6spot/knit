/**
 * run 准备与启动（DESIGN.md 第5.6节、ARCHITECTURE.md 第5节）。
 * prepare 只发布 request/launch 意图，不取得执行占用、不写业务资料；
 * worker 认领后自行持锁、重新核实并冻结 inputs，implement 先建立快照。
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { RunLaunchState, RunPhase } from "../contracts/run.js";
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
import { machineBootId, procStartTicks, processTable, processTreePids, signalProcessTree } from "../infrastructure/process.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { ContextPlanner } from "./context-planner.js";
import { GuardError } from "./guard-error.js";
import { locateTaskDocument } from "./task-service.js";
import { loadScope, scopeDigest } from "./scope.js";
import { currentBranch } from "./delivery.js";
import { parseConfig, defaultConfig } from "./config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunAcceptanceService } from "./run-acceptance.js";
import { LockManager } from "../infrastructure/locks.js";

const WORKER_SCRIPT = fileURLToPath(new URL("../worker/knit-worker.js", import.meta.url));

export interface RunCoordinatorOptions {
  store: MetadataStore;
  planner?: ContextPlanner;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  /** 默认当前 Node 执行 dist/worker/knit-worker.js；测试可替换。 */
  workerCommand?: string[];
  confirmTimeoutMs?: number;
  lockRoot?: string;
}

export interface PrepareInput {
  dir: string;
  taskId: string;
  phase: RunPhase;
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
}

export interface RunStatusProjection {
  runId: string;
  taskId: string;
  phase: RunPhase;
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

  constructor(options: RunCoordinatorOptions) {
    this.store = options.store;
    this.planner = options.planner ?? new ContextPlanner({ store: options.store });
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
    this.workerCommand = options.workerCommand ?? [process.execPath, WORKER_SCRIPT];
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 5000;
    this.lockRoot = options.lockRoot ?? null;
  }

  /** 短等待项目锁：上一 worker 刚发布终态时可能尚在 finally 释放锁。 */
  private async acquireForPrepare(locks: LockManager, root: string, taskId: string) {
    const keys = [
      { scope: "project" as const, rawKey: root },
      { scope: "task" as const, rawKey: `${root}::${taskId}` },
    ];
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        return await locks.acquire({ keys, action: "run.prepare" });
      } catch (error) {
        if (!(error instanceof InfrastructureError) || error.code !== "lock_busy" || Date.now() >= deadline) throw error;
        await sleep(50);
      }
    }
  }

  /**
   * 发布不可变请求与启动意图。已有同任务／阶段活动 run 时返回既有对象，
   * 不生成替代 run；ID 在返回前已落盘，调用方无需再次许可。
   */
  async prepare(input: PrepareInput): Promise<{ request: RunRequestFile; launch: LaunchRecord; reused: boolean }> {
    const root = normalizeRoot(input.dir);
    const locks = new LockManager(this.lockRoot === null ? {} : { root: this.lockRoot });
    const lock = await this.acquireForPrepare(locks, root, input.taskId);
    try {
    let located;
    try {
      located = locateTaskDocument(root, input.taskId);
    } catch {
      throw new GuardError("unknown_task", `任务不存在: ${input.taskId}`);
    }
    if (located.archived) throw new GuardError("task_archived", `任务已归档: ${input.taskId}`);
    if (input.phase !== "advisory" && located.document.frontmatter.phase !== input.phase) {
      throw new GuardError("phase_mismatch", `任务阶段为 ${located.document.frontmatter.phase}，不能准备 ${input.phase}`);
    }
    if (located.document.frontmatter.status !== "open") {
      throw new GuardError("task_not_open", `任务不是 open 状态: ${input.taskId}`);
    }
    const binding = await this.store.bindings.get(input.taskId);
    if (binding === null) throw new GuardError("unknown_binding", `任务缺少绑定: ${input.taskId}`);
    // 运行边界核对实际检出分支：与任务绑定和 request 三方一致才准启动（任务028）。
    if (input.phase !== "advisory" && located.document.frontmatter.branch !== null) {
      const liveBranch = currentBranch(root);
      if (liveBranch === null) {
        throw new GuardError("branch_mismatch", "当前处于 detached HEAD，不能启动绑定分支的阶段");
      }
      if (liveBranch !== located.document.frontmatter.branch || liveBranch !== binding.branch) {
        throw new GuardError(
          "branch_mismatch",
          `当前检出分支 ${liveBranch} 与任务绑定不一致；按 task adopt 接管或切回 ${located.document.frontmatter.branch}`,
        );
      }
    }
    if (binding.pendingDraft !== null) {
      throw new GuardError("pending_inputs", "存在待应用输入，先应用或撤回再启动代码阶段");
    }
    const runs = new RunStore(root);
    if (input.phase === "implement") {
      const maxRounds = this.maxRounds(root);
      if (input.newRepairCycle === true) {
        const cycleId = `rep-${this.randomHex(6)}`;
        await this.store.bindings.save({ ...binding, repairCycleId: cycleId, repairRounds: 0, stopReason: null });
        binding.repairCycleId = cycleId;
        binding.repairRounds = 0;
        binding.stopReason = null;
      } else if (binding.stopReason !== null) {
        throw new GuardError("repair_stopped", `修复周期已停止：${binding.stopReason}`);
      } else if (binding.repairCycleId !== null && (binding.repairRounds ?? 0) >= maxRounds) {
        throw new GuardError("repair_round_limit", `修复轮次已达上限 ${maxRounds}；需显式开启新周期`);
      }
    } else if (input.newRepairCycle === true) {
      throw new GuardError("invalid_request", "只有实施阶段可以开启修复周期");
    }
    const role = input.phase === "advisory" ? "advisory" : input.phase;
    const plan = await this.planner.plan({ dir: root, taskId: input.taskId, role, authorizedStandardPaths: input.authorizedStandardPaths });
    if (!plan.ready) {
      throw new GuardError("plan_not_ready", `上下文计划未就绪：${plan.blockers.join(", ")}`);
    }
    const active = this.findActive(runs, input.taskId, input.phase);
    if (active !== null) {
      return { request: active.request, launch: active.launch, reused: true };
    }

    const createdAt = this.now().toISOString();
    const runId = `run-${this.randomHex(6)}`;
    const acceptanceOperationId = `accept-${this.randomHex(6)}`;
    const request: RunRequestFile = {
      schemaVersion: 1,
      protocolVersion: 1,
      runId,
      taskId: input.taskId,
      phase: input.phase,
      purpose: input.phase === "advisory" ? "assist" : "stage",
      initiator: input.initiator,
      createdAt,
      expected: {
        branch: located.document.frontmatter.branch,
        inputsDigest: plan.inputsDigest,
        standardsDigest: plan.standardsDigest,
        effectiveInputsDigest: plan.effectiveInputsDigest,
        planId: plan.planId,
        scopeDigest: input.phase === "check" ? scopeDigest(loadScope(runs, input.taskId, createdAt).entries) : null,
        authorizedStandardOutputs: plan.authorizedStandardOutputs,
      },
      model: input.model,
      toolPolicy: plan.toolPolicy,
      recovery: input.recovery ?? { nativeSessionId: null, resume: "prefer" },
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
  async resume(input: { dir: string; oldRunId: string }): Promise<{
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
      // 旧项目锁仍是现场事实；即使句柄已死，未显式清理前不得由新会话抢先续做。
      if (locks.list().some((entry) => entry.scope === "project" && entry.key === root)) {
        throw new GuardError("run_active", `旧执行的项目锁尚未释放: ${input.oldRunId}`);
      }
      // 已确认 worker 与阶段工具都结束且没有结果：关闭旧活动态，避免 prepare 复用为活动 run。
      runs.writeState(input.oldRunId, {
        ...state,
        state: runs.readCancel(input.oldRunId) === null ? "failed" : "cancelled",
        reason: runs.readCancel(input.oldRunId) === null ? "worker_exited_before_result" : "cancel_requested_worker_exited",
        updatedAt: this.now().toISOString(),
      });
      runs.appendEvent(input.oldRunId, { event: "recovered_without_result", workerVerdict: alive, stageVerdict });
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
      taskId: old.taskId,
      phase: old.phase,
      initiator: old.initiator,
      model: old.model,
      recovery: { nativeSessionId, resume: "prefer" },
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
    return ticks === recordedTicks ? "alive" : "not_alive";
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
