/**
 * local worker 入口（DESIGN.md 第5.6节、OPERATIONS.md 第2节）。
 * 原子认领 request 后按任务执行目录取得 project 执行占用（主检出路由为主检出根，
 * worktree 路由为 worktree 路径；任务17），锁内重新核实绑定路由与预期输入，
 * 冻结 inputs/instructions；implement 在正式代码前建立快照。
 * 阶段模型调用与代码执行由 013 从 prepared 状态继续；本入口不调用模型。
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { RunStateFileSchema, type RunResultFile, type RunStateFile } from "../contracts/run.js";
import { checkSchema } from "../contracts/schema.js";
import { atomicWrite } from "../infrastructure/atomic.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { LockManager, type AcquiredLock } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { currentIdentity } from "../infrastructure/process.js";
import { RunStore, type WorkerIdentity } from "../infrastructure/run-store.js";
import { ContextPlanner } from "../application/context-planner.js";
import { RunAcceptanceService } from "../application/run-acceptance.js";
import { StageRunner, type StageExecution } from "../application/stage-runner.js";
import { SnapshotService } from "../application/snapshot.js";
import { parseConfig } from "../application/config.js";
import { currentBranch } from "../application/delivery.js";
import { locateTaskDocument } from "../application/task-service.js";
import { executionRouteOf } from "../application/worktree-routing.js";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";

interface Args {
  run: string;
  dir: string;
  locks: string | null;
  /** `--max-bytes` 显式覆盖；缺省读取项目 snapshotsMaxBytes。 */
  maxBytes: number | null;
  prepareOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { run: "", dir: ".", locks: null, maxBytes: null, prepareOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--run" && value !== undefined) {
      args.run = value;
      index += 1;
    } else if (flag === "--dir" && value !== undefined) {
      args.dir = value;
      index += 1;
    } else if (flag === "--locks" && value !== undefined) {
      args.locks = value;
      index += 1;
    } else if (flag === "--max-bytes" && value !== undefined) {
      args.maxBytes = Number.parseInt(value, 10);
      index += 1;
    } else if (flag === "--prepare-only") {
      args.prepareOnly = true;
    }
  }
  return args;
}

function workerIdentity(): WorkerIdentity {
  const identity = currentIdentity();
  return {
    workerId: `w-${randomBytes(6).toString("hex")}`,
    pid: identity.pid,
    bootId: identity.machineBootId,
    procStartTicks: identity.procStartTicks,
    hostname: hostname(),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!/^run-[0-9a-f]{12}$/.test(args.run)) {
    process.stderr.write("knit-worker: 缺少或非法 --run\n");
    return 2;
  }
  const root = normalizeRoot(args.dir);
  const config = parseConfig(readFileSync(join(root, ".knit", "config.json"), "utf8"));
  const maxBytes = args.maxBytes ?? config.limits.snapshotsMaxBytes;
  const store = new RunStore(root);
  const request = store.readRequest(args.run);
  if (request === null) {
    process.stderr.write(`knit-worker: run 不存在: ${args.run}\n`);
    return 2;
  }
  const diag = (event: string, fields: Record<string, unknown> = {}): void => {
    if (!request.diagnostics.enabled) return;
    const allowed: Record<string, unknown> = { type: "knit.worker.diag", event, runId: request.runId, phase: request.phase };
    for (const key of ["state", "prepared", "workerId", "snapshotState", "reason"]) {
      const value = fields[key];
      if (value !== undefined && value !== null) allowed[key] = typeof value === "string" ? value.slice(0, 200) : value;
    }
    process.stderr.write(JSON.stringify(allowed) + "\n");
  };
  const worker = workerIdentity();
  const claim = store.claim(args.run, worker);
  if (!claim.claimed) {
    store.appendEvent(args.run, { event: "claim_rejected", reason: claim.reason, workerId: worker.workerId });
    if (claim.state?.prepared || (claim.state !== null && ["completed", "cancelled", "failed"].includes(claim.state.state))) {
      return 0;
    }
    return 3;
  }
  if (claim.existing) {
    store.appendEvent(args.run, { event: "claim_reentrant", workerId: worker.workerId });
    return 0;
  }

  const now = () => new Date().toISOString();
  const claimedAt = now();
  let state: RunStateFile = {
    schemaVersion: 1,
    runId: request.runId,
    taskId: request.taskId,
    phase: request.phase,
    state: "claimed",
    worker,
    claimedAt,
    updatedAt: claimedAt,
    prepared: false,
    preparedAt: null,
    snapshot: null,
    reason: null,
  };
  const writeState = (next: RunStateFile): void => {
    const updated = { ...next, updatedAt: now() };
    if (!checkSchema(RunStateFileSchema, updated)) {
      throw new InfrastructureError("io_error", "worker state 结构不符");
    }
    state = updated;
    store.writeState(request.runId, updated);
  };
  const failedResult = (reason: string): RunResultFile => ({
    schemaVersion: 1,
    runId: request.runId,
    taskId: request.taskId,
    phase: request.phase,
    state: "failed",
    report: null,
    reportSummary: reason,
    nativeEntries: { startEntryId: null, leafEntryId: null },
    usage: { inputTokens: null, outputTokens: null },
    session: null,
    actualChangedPaths: [],
    acceptanceOperationId: request.acceptanceOperationId,
    recordedAt: now(),
    failureReason: reason,
  });
  const fail = (reason: string): number => {
    diag("worker_failed", { reason });
    writeState({ ...state, state: "failed", reason });
    try {
      store.writeResult(request.runId, failedResult(reason));
    } catch (error) {
      if (!(error instanceof InfrastructureError && error.code === "version_conflict")) throw error;
    }
    store.appendEvent(request.runId, { event: "worker_failed", reason });
    return 1;
  };

  writeState(state);
  diag("claimed", { state: state.state, workerId: worker.workerId });
  store.appendEvent(request.runId, { event: "claimed", workerId: worker.workerId, pid: worker.pid });

  const metadata = new SqliteMetadataStore(join(root, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: args.locks ?? join(homedir(), ".knit", "locks") });
  let lock: AcquiredLock | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let heartbeatError: string | null = null;
  /** 任务执行目录（project 锁键）：主检出路由为主检出根，worktree 路由为 worktree 路径。 */
  let executionDir = root;
  /** 请求冻结的接收执行目录；接收实现以同一键取 project 锁（缺省回退主检出）。 */
  const acceptanceDir = request.expected.executionDir ?? root;
  /**
   * 接收结果。worker 已持与请求一致的执行目录锁时直接复用（lockHeld）；
   * 未取得锁的失败路径用主检出键接收失败事实，避免另一执行目录的占用阻塞。
   */
  const acceptResult = async () => {
    const reuse = lock !== null && resolve(executionDir) === resolve(acceptanceDir);
    return new RunAcceptanceService({ store: metadata, locks }).accept({
      dir: root,
      runId: request.runId,
      lockHeld: reuse,
      ...(reuse ? {} : { lockDir: root }),
    });
  };

  try {
    // 取锁前只读绑定并计算执行目录：不同 worktree 使用不同 project 锁键，可并行；
    // invalid 路由在取锁前失败，不用主检出键掩盖登记异常。
    const plannedBinding = await metadata.bindings.get(request.taskId);
    const plannedRoute = executionRouteOf(plannedBinding, root);
    if (plannedRoute.state === "invalid") return fail(`worktree_invalid:${plannedRoute.problem ?? "unknown"}`);
    executionDir = plannedRoute.dir;
    try {
      lock = await locks.acquire({ keys: [{ scope: "project", rawKey: executionDir }], action: "run.prepare" });
    } catch (error) {
      return fail(error instanceof InfrastructureError && error.code === "lock_busy" ? "lock_busy" : "lock_unavailable");
    }
    store.appendEvent(request.runId, { event: "lock_acquired" });
    heartbeat = setInterval(() => {
      if (lock === null || heartbeatError !== null) return;
      void locks.heartbeat(lock).then(
        () => {},
        (error: unknown) => {
          heartbeatError = error instanceof InfrastructureError ? error.code : "lock_heartbeat_failed";
          store.appendEvent(request.runId, { event: "lock_heartbeat_failed", reason: heartbeatError });
        },
      );
    }, config.limits.heartbeatIntervalMs);
    heartbeat.unref();

    // 锁内重读绑定并重算路由：等待锁期间绑定／执行目录被改动时不在错误目录执行阶段。
    const binding = await metadata.bindings.get(request.taskId);
    if (binding === null) return fail("binding_missing");
    // 工作区路由：worktree 生效时任务资料与阶段 cwd 都在 worktree；失效不回退主检出。
    const route = executionRouteOf(binding, root);
    if (route.state === "invalid") return fail(`worktree_invalid:${route.problem ?? "unknown"}`);
    if (route.state === "worktree" && !route.prepared) return fail("worktree_not_ready");
    if (
      route.state !== plannedRoute.state ||
      resolve(route.dir) !== resolve(executionDir) ||
      route.branch !== plannedRoute.branch
    ) {
      return fail("route_changed");
    }
    if (request.expected.executionDir !== undefined && request.expected.executionDir !== null) {
      if (resolve(request.expected.executionDir) !== resolve(route.dir)) return fail("route_changed");
    }
    // 请求冻结的执行分支必须仍是当前路由分支；worktree 路由下 frontmatter 保留源分支，不作否决依据。
    if (request.expected.branch !== null && route.branch !== null && request.expected.branch !== route.branch) {
      return fail("route_changed");
    }
    executionDir = route.dir;

    let located;
    try {
      located = locateTaskDocument(executionDir, request.taskId);
    } catch {
      return fail("task_missing");
    }
    if (located.archived) return fail("task_archived");
    if (request.phase !== "advisory" && located.document.frontmatter.stage !== request.phase) {
      return fail("phase_mismatch");
    }
    // worktree 路由下 frontmatter 保留源分支，不作否决依据；三方核对改用执行分支。
    if (route.state !== "worktree" && located.document.frontmatter.branch !== request.expected.branch) return fail("branch_mismatch");
    // 执行副作用前核对执行目录的实际检出分支；detached HEAD 同样拒绝（任务028）。
    if (request.phase !== "advisory" && request.expected.branch !== null) {
      const liveBranch = currentBranch(executionDir);
      if (liveBranch !== request.expected.branch) return fail("branch_mismatch");
    }
    if (binding.pendingDraft !== null) return fail("pending_inputs");

    const planner = new ContextPlanner({ store: metadata });
    const role = request.phase === "advisory" ? "advisory" : request.phase;
    const plan = await planner.plan({
      dir: executionDir,
      taskId: request.taskId,
      role,
      authorizedStandardPaths: (request.expected.authorizedStandardOutputs ?? []).map((output) => output.path),
      authorizedStandardContents: request.expected.authorizedStandardOutputs ?? [],
    });
    if (!plan.ready) return fail(`plan_not_ready:${plan.blockers.join(",")}`);
    if (
      plan.inputsDigest !== request.expected.inputsDigest ||
      plan.standardsDigest !== request.expected.standardsDigest ||
      plan.effectiveInputsDigest !== request.expected.effectiveInputsDigest
    ) {
      return fail("request_stale");
    }

    const frozenAt = now();
    store.writeInputs(request.runId, {
      schemaVersion: 1,
      runId: request.runId,
      taskId: request.taskId,
      phase: request.phase,
      frozenAt,
      planId: plan.planId,
      inputsDigest: plan.inputsDigest,
      standardsDigest: plan.standardsDigest,
      effectiveInputsDigest: plan.effectiveInputsDigest,
      taskDocumentDigest: plan.taskDocumentDigest,
      sections: plan.sections.map((section) => ({
        sourceId: section.sourceId,
        kind: section.kind,
        path: section.path,
        digest: section.digest,
        mode: section.mode,
        countsTowardInputs: section.countsTowardInputs,
      })),
      excluded: plan.excluded.map((item) => ({ sourceId: item.sourceId, reason: item.reason })),
      toolPolicy: plan.toolPolicy,
    });
    store.writeInstructions(request.runId, {
      schemaVersion: 1,
      runId: request.runId,
      preparedAt: frozenAt,
      entries: plan.sections.map((section) => ({
        sourceId: section.sourceId,
        scope: section.kind,
        digest: section.digest,
        injection: section.mode,
        path: section.path,
        version: section.digest ?? plan.planId,
      })),
    });
    writeState({ ...state, state: "preparing" });
    store.appendEvent(request.runId, { event: "inputs_frozen", inputsDigest: plan.inputsDigest });

    let snapshot = null;
    if (request.phase === "implement") {
      const result = new SnapshotService().create({ root: executionDir, runId: request.runId, maxBytes, runRoot: root });
      snapshot = {
        state: result.manifest.state,
        digest: result.manifest.digest,
        entries: result.manifest.entries.length,
        reason: result.manifest.reason,
      };
      writeState({ ...state, state: "preparing", snapshot });
      store.appendEvent(request.runId, {
        event: "snapshot_finished",
        state: result.manifest.state,
        reason: result.manifest.reason,
        entries: result.manifest.entries.length,
      });
      if (result.state !== "ready") return fail(`snapshot_${result.reason ?? "failed"}`);
    }

    writeState({ ...state, state: "preparing", prepared: true, preparedAt: now(), snapshot });
    diag("prepared", { state: state.state, prepared: true, snapshotState: snapshot?.state ?? null });
    store.appendEvent(request.runId, { event: "prepared", snapshot: snapshot?.state ?? null });
    if (args.prepareOnly) return 0;

    // 阶段执行与接收：保持执行目录占用直到 result 与 Task 接收完成。
    writeState({ ...state, state: "running" });
    diag("stage_started", { state: state.state });
  store.appendEvent(request.runId, { event: "stage_started", phase: request.phase });
    let execution: StageExecution;
    try {
      execution = await new StageRunner({
        root,
        executionDir,
        request,
        plan,
        inputs: store.readInputs(request.runId) ?? (() => { throw new InfrastructureError("io_error", "inputs 缺失"); })(),
        store: metadata,
        runs: store,
        locks,
        cancelGraceMs: config.limits.cancelGraceMs,
        lostOwnership: () => heartbeatError,
      }).execute();
    } catch (error) {
      const reason = error instanceof InfrastructureError ? error.code : "stage_error";
      store.appendEvent(request.runId, { event: "stage_exception", reason });
      return fail(reason);
    }
    // 心跳已报丢失且回执本身不是 lock_ownership_lost（如阶段自然完成）时，
    // 旧回执不得推进任务：改走 fail；阶段内已按 lock_ownership_lost 失败的直接发布该失败事实。
    if (heartbeatError !== null && execution.result.failureReason?.startsWith("lock_ownership_lost") !== true) {
      return fail(`lock_ownership_lost:${heartbeatError}`);
    }
    if (store.readCancel(request.runId) !== null && execution.result.state === "completed") {
      // 发布完成前观察到取消：保留部分事实，但不进入正常接收。
      execution = {
        ...execution,
        result: {
          ...execution.result,
          state: "cancelled",
          failureReason: "cancel_requested",
        },
      };
    }
    try {
      store.writeResult(request.runId, execution.result);
    } catch (error) {
      const reason = error instanceof InfrastructureError ? error.code : "result_write_failed";
      store.appendEvent(request.runId, { event: "result_write_failed", reason });
      writeState({ ...state, state: "failed", reason: "result_write_failed" });
      return 1;
    }
    diag("result_published", { state: execution.result.state, reason: execution.result.failureReason ?? null });
    store.appendEvent(request.runId, {
      event: "result_published",
      state: execution.result.state,
      verdict: execution.result.report?.verdict ?? null,
    });
    try {
      const acceptance = await acceptResult();
      store.appendEvent(request.runId, {
        event: "acceptance",
        accepted: acceptance.accepted,
        reason: acceptance.reason,
      });
      if (!acceptance.accepted) {
        writeState({ ...state, state: "failed", reason: `acceptance_${acceptance.reason ?? "failed"}` });
        return 1;
      }
    } catch (error) {
      const reason = error instanceof InfrastructureError ? error.code : "acceptance_failed";
      store.appendEvent(request.runId, { event: "acceptance_exception", reason });
      writeState({ ...state, state: "failed", reason: "acceptance_failed" });
      return 1;
    }
    writeState({ ...state, state: execution.result.state, reason: execution.result.failureReason });
    return execution.result.state === "completed" ? 0 : 1;
  } catch (error) {
    const reason = error instanceof InfrastructureError ? error.code : "worker_error";
    store.appendEvent(request.runId, { event: "worker_exception", reason });
    return fail(reason);
  } finally {
    if (state.state === "failed") {
      try {
        await acceptResult();
      } catch {
        // 失败结果已保留；接收失败留给 resume/status 核实，不覆盖原失败事实。
      }
    }
    if (heartbeat !== null) clearInterval(heartbeat);
    if (lock !== null) locks.release(lock);
    metadata.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`knit-worker: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
