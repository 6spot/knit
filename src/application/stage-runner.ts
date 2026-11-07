/**
 * 独立阶段执行：选会话、构造 Pi 运行时、等待稳定终态、核对实际文件差异并产出不可变 result
 * （DESIGN.md 5.1、5.4–5.6、9.4）。不写 Task／binding；接收由 RunAcceptanceService 负责。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type { ContextPlan, ToolPolicy } from "../contracts/context-plan.js";
import type {
  FrozenInputs,
  RunDiagnosticsFile,
  RunRequestFile,
  RunResultFile,
  RunSessionRecord,
  RunUsage,
  StageReport,
} from "../contracts/run.js";
import { newKnitSessionId, type SessionRecord } from "../contracts/session.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import {
  PiAgentRuntime,
  buildRuntimeOptions,
  capabilitySwitches,
  checkNativeSessionFile,
  decideResume,
  findStageSessionFile,
  readEntryRange,
  readLeafEntryId,
  type ResumeDecision,
} from "../adapters/pi/index.js";
import { RunStore } from "../infrastructure/run-store.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { procStartTicks, processTreePids, signalProcessTree, gitSync } from "../infrastructure/process.js";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { LockManager, currentIdentity, type AcquiredLock } from "../infrastructure/locks.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  loadSectionContents,
  parseStageReport,
} from "./stage.js";
import { worktreeSignature, type WorktreeSignature } from "./worktree.js";
import { legalStageList, loadWorkflow, workflowStageOf } from "./workflow.js";
import { isDecisionStage, validateReportForStage } from "../domain/report.js";
import type { WorkflowDefinition, WorkflowStage } from "../domain/workflow.js";
import type { ToolCapability } from "../contracts/workflow.js";
import { currentEntry } from "./scope.js";
import { RexLauncher, type RexExecution, type RexLauncherOptions } from "./rex-launcher.js";

export interface StageRunnerOptions {
  root: string;
  /** 任务执行目录（worktree 生效时为 worktree 路径）；缺省等于 root。 */
  executionDir?: string;
  request: RunRequestFile;
  plan: ContextPlan;
  inputs: FrozenInputs;
  store: MetadataStore;
  runs: RunStore;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  /** 本机 Pi 可执行文件；默认 KNIT_PI_BIN 或 PATH 中的 pi。 */
  piExecutable?: string;
  /** Pi 配置根；默认 ~/.pi/agent。 */
  agentDir?: string;
  /** 单个控制／观察请求的超时；不是阶段总时限，缺省无截止（任务034）。 */
  promptTimeoutMs?: number | null;
  /** 取消后等待 agent 自行结束的宽限；超时则终止本次 Pi 进程组。 */
  cancelGraceMs?: number;
  /** 与项目执行锁同源的锁管理器；传入后阶段独占该 Session 锁。 */
  locks?: LockManager;  /** 校验执行占用；返回非 null 错误码即占用已丢失，立即中止本阶段新动作并失败终止。 */
  lostOwnership?: () => string | null;
  /** Session 锁心跳间隔；缺省 5 秒，与项目配置 limits.heartbeatIntervalMs 一致。 */
  heartbeatIntervalMs?: number;
  /** 阶段 Pi 进程登记回调（worker 登记到执行目录锁 owner）；null 表示已退出。 */
  onStageProcess?: (pid: number | null) => void;
  runtimeFactory?: (options: ConstructorParameters<typeof PiAgentRuntime>[0]) => PiAgentRuntime;
  /** 测试注入；缺省创建真实 RexLauncher。 */
  rexLauncherFactory?: (options: RexLauncherOptions) => RexLauncher;
}

export interface StageExecution {
  result: RunResultFile;
  session: RunSessionRecord | null;
}

/** 启动诊断尾部上限；启动发生在任何 prompt 之前，stderr 不含消息正文，只防超长。 */
const START_DIAGNOSTICS_TAIL_LIMIT = 4_000;

/** 阶段声明的 task 能力需要的项目扩展；缺失时明确失败，不静默降级。 */
const KNIT_EXTENSION_PATH = [".pi", "extensions", "knit.ts"] as const;

/** 目录相等：别名解析后比较；路径已不存在时退到词法比较（不因现场缺失改变恢复判断）。 */
function sameDir(a: string, b: string): boolean {
  try {
    return normalizeRoot(a) === normalizeRoot(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

interface StageRuntimeTools {
  tools: string[] | null;
  toolAdditions: string[];
  excludeTools: string[];
  capabilities: readonly ToolCapability[] | null;
  extensionPaths: string[];
}

const BUILTIN_TOOL_NAMES = ["read", "grep", "find", "ls", "write", "edit", "bash", "powershell"];
const KNIT_TOOL_NAMES = [
  "knit_task",
  "knit_context",
  "knit_run",
  "knit_deliver",
  "knit_standards",
  "knit_workflow",
];

/** 工具能力 → `--tools` 与扩展路径；capabilities 为 null 表示全部放开。 */
function stageRuntimeTools(policy: ToolPolicy, executionDir: string): StageRuntimeTools {
  const capabilities = policy.capabilities;
  if (capabilities === null) {
    return {
      tools: null,
      toolAdditions: [],
      excludeTools: [],
      capabilities: null,
      extensionPaths: [],
    };
  }
  const list = capabilities ?? [];
  const extensionPaths: string[] = [];
  if (list.includes("task")) {
    const extensionPath = resolve(executionDir, ...KNIT_EXTENSION_PATH);
    if (!existsSync(extensionPath)) {
      throw new InfrastructureError(
        "tool_capability_unavailable",
        `阶段声明了 task 能力，但项目扩展不存在: ${extensionPath}`,
      );
    }
    extensionPaths.push(extensionPath);
  }
  if (list.includes("external")) {
    // external 要让未知扩展工具保持可见：用只增项 + 明确排除内置工具，而不是 allowlist。
    const wanted = new Set(policy.allow);
    const additions = BUILTIN_TOOL_NAMES.filter((name) => wanted.has(name));
    if (list.includes("task")) additions.push(...KNIT_TOOL_NAMES);
    const excludeTools = BUILTIN_TOOL_NAMES.filter((name) => !wanted.has(name));
    return {
      tools: null,
      toolAdditions: additions,
      excludeTools,
      capabilities: list,
      extensionPaths,
    };
  }
  return {
    tools: policy.allow,
    toolAdditions: [],
    excludeTools: [],
    capabilities: list,
    extensionPaths,
  };
}

function diffSignatures(before: WorktreeSignature, after: WorktreeSignature): string[] {
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  return [...paths].filter((path) => before.entries[path] !== after.entries[path]).sort();
}

/** 运行中分支核对：预期完整 ref 与实际 HEAD 一致；detached／不匹配都算偏离（任务028）。 */
export function liveBranchMatches(root: string, expected: string | null, git: (args: string[], cwd: string) => { code: number; stdout: string }): boolean {
  if (expected === null) return true;
  const result = git(["symbolic-ref", "-q", "HEAD"], root);
  return result.code === 0 && result.stdout.trim() === expected;
}

function usageDelta(before: Record<string, unknown> | null, after: Record<string, unknown> | null): RunUsage {
  const tokens = (value: Record<string, unknown> | null): Record<string, number> | null => {
    if (value === null || typeof value.tokens !== "object" || value.tokens === null) return null;
    const raw = value.tokens as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [key, item] of Object.entries(raw)) if (typeof item === "number") result[key] = item;
    return result;
  };
  const a = tokens(before);
  const b = tokens(after);
  if (a === null || b === null) return { inputTokens: null, outputTokens: null };
  const input = (b.input ?? 0) - (a.input ?? 0);
  const cacheRead = (b.cacheRead ?? 0) - (a.cacheRead ?? 0);
  const cacheWrite = (b.cacheWrite ?? 0) - (a.cacheWrite ?? 0);
  const output = (b.output ?? 0) - (a.output ?? 0);
  return {
    inputTokens: Math.max(0, input) + Math.max(0, cacheRead) + Math.max(0, cacheWrite),
    outputTokens: Math.max(0, output),
  };
}

export class StageRunner {
  private readonly root: string;
  private readonly executionDir: string;
  private readonly request: RunRequestFile;
  private readonly plan: ContextPlan;
  private readonly inputs: FrozenInputs;
  private readonly store: MetadataStore;
  private readonly runs: RunStore;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;
  private readonly piExecutable: string;
  private readonly agentDir: string;
  private readonly promptTimeoutMs: number | null;
  private readonly cancelGraceMs: number;
  private readonly locks: LockManager | null;
  private readonly lostOwnership: (() => string | null) | null;
  private readonly heartbeatIntervalMs: number;
  private readonly onStageProcess: ((pid: number | null) => void) | null;
  /** 当前持有的 Session 锁；阶段进程登记与心跳使用。 */
  private activeSessionLock: AcquiredLock | null = null;
  private readonly runtimeFactory: NonNullable<StageRunnerOptions["runtimeFactory"]>;
  private readonly rexLauncherFactory: NonNullable<StageRunnerOptions["rexLauncherFactory"]>;
  private readonly workflow: WorkflowDefinition;
  private readonly workflowMode: "config" | "fallback";
  private readonly stage: WorkflowStage | null;

  constructor(options: StageRunnerOptions) {
    this.root = options.root;
    this.executionDir = normalizeRoot(options.executionDir ?? options.root);
    this.request = options.request;
    this.plan = options.plan;
    this.inputs = options.inputs;
    this.store = options.store;
    this.runs = options.runs;
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
    this.piExecutable = options.piExecutable ?? process.env.KNIT_PI_BIN ?? "pi";
    this.agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
    // 阶段无固定总时限（OPERATIONS §4、DESIGN §5.9）：只有显式取消、占用丢失、控制请求超时收敛（任务034）。
    this.promptTimeoutMs = options.promptTimeoutMs ?? null;
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000;
    this.locks = options.locks ?? null;
    this.lostOwnership = options.lostOwnership ?? null;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.onStageProcess = options.onStageProcess ?? null;
    this.runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => new PiAgentRuntime(runtimeOptions));
    this.rexLauncherFactory = options.rexLauncherFactory ?? ((launcherOptions) => new RexLauncher(launcherOptions));
    const loaded = loadWorkflow(this.executionDir);
    this.workflow = loaded.workflow;
    this.workflowMode = loaded.mode;
    // prepare 冻结的阶段定义优先：配置在途降级不改变本 run 的报告语义与提示词。
    this.stage = options.request.stageDefinition ?? workflowStageOf(this.workflow, this.request.phase);
  }

  async execute(): Promise<StageExecution> {
    const stageId = this.request.phase;
    if (this.stage === null && this.workflow.stages.length > 0) {
      throw new InfrastructureError("stage_not_in_workflow", `阶段不在生效流程中: ${stageId}；合法阶段: ${legalStageList(this.workflow, false)}`);
    }
    const workStage =
      this.request.stageDefinition !== undefined
        ? !this.request.stageDefinition.decision
        : this.stage !== null
          ? !isDecisionStage(this.stage)
          : stageId !== "check";
    const scope = this.runs.readScope(this.request.taskId);
    const binding = await this.store.bindings.get(this.request.taskId);
    const previousImplement = await this.previousImplementResult(binding?.lastRunIds ?? []);
    const contents = loadSectionContents(this.executionDir, this.plan, binding?.pendingDraft?.content ?? null);
    const systemPrompt = buildSystemPrompt(this.plan, this.stage, contents);
    const userPrompt = buildUserPrompt(this.plan, this.stage, contents, {
      taskId: this.request.taskId,
      runId: this.request.runId,
      branch: this.request.expected.branch,
      snapshotDir: workStage ? join(this.runs.runDir(this.request.runId), "snapshot") : null,
      scope: scope?.entries.map((entry) => entry.path) ?? [],
      previousImplement,
    });

    const runtimeTools = stageRuntimeTools(this.request.toolPolicy, this.executionDir);
    let session: PreparedSession = await this.prepareSession(stageId);
    let sessionLock: AcquiredLock | null = null;
    let runtime: PiAgentRuntime | null = null;
    let processStartedAt: string | null = null;
    let piPid: number | null = null;
    if (this.locks !== null) {
      const locks = this.locks;
      const acquireSessionLock = () => locks.acquire({
        keys: [{ scope: "session", rawKey: `pi:${session.nativeSessionId}` }],
        action: `stage.${stageId}`,
      });
      try {
        sessionLock = await acquireSessionLock();
      } catch (firstError) {
        let failure: unknown = firstError;
        // 锁根被外部删除时，owner 写入可能落在已消失的目录；短暂重试后由心跳核实占用是否真的丢失。
        if ((firstError as NodeJS.ErrnoException).code === "ENOENT") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          try {
            sessionLock = await acquireSessionLock();
          } catch (retryError) {
            failure = retryError;
          }
        }
        if (sessionLock === null) {
          const lost = this.lostOwnership?.() ?? null;
          const reason =
            lost !== null
              ? `lock_ownership_lost:${lost}`
              : failure instanceof InfrastructureError && failure.code === "lock_busy"
                ? "session_lock_busy"
                : "session_lock_unavailable";
          await this.markSession(session, "opening", reason, false);
          return this.failure(session, reason, null, null, null);
        }
      }
    }
    this.activeSessionLock = sessionLock;
    for (const record of sessionLock?.reclaimed ?? []) {
      this.runs.appendEvent(this.request.runId, {
        event: "lock_reclaimed",
        lockId: record.id,
        previousAction: record.previousOwner.action,
        previousPid: record.previousOwner.pid,
        archive: record.archive,
      });
    }
    // Session 锁随阶段长期持有：按心跳间隔刷新 heartbeatAt；失败只记事件，占用核实仍以进程身份为准。
    const sessionHeartbeat = setInterval(() => {
      const lock = this.activeSessionLock;
      if (lock === null || this.locks === null) return;
      void this.locks.heartbeat(lock).catch((error: unknown) => {
        this.runs.appendEvent(this.request.runId, {
          event: "session_lock_heartbeat_failed",
          reason: error instanceof InfrastructureError ? error.code : "lock_heartbeat_failed",
        });
      });
    }, this.heartbeatIntervalMs);
    sessionHeartbeat.unref?.();
    try {
    if (this.request.presentation === "rex") {
      return await this.executeRexStage(session, systemPrompt, userPrompt, runtimeTools);
    }
    const sessionDir = join(this.root, ".knit", ".runtime", "pi-sessions");
    processStartedAt = this.now().toISOString();
    this.writeStageProcess(session, "starting", null, processStartedAt);
    runtime = this.runtimeFactory(
      buildRuntimeOptions(
        {
          executablePath: this.piExecutable,
          provider: this.request.model.provider,
          modelId: this.request.model.model,
          tools: runtimeTools.tools,
          toolAdditions: runtimeTools.toolAdditions,
          excludeTools: runtimeTools.excludeTools,
          capabilities: runtimeTools.capabilities,
          extensionPaths: runtimeTools.extensionPaths,
          cwd: this.executionDir,
          sessionDir,
          appendSystemPrompt: systemPrompt,
        },
        session.decision,
      ),
    );
    const beforeSignature = worktreeSignature(this.executionDir);
    if (beforeSignature === null) {
      await runtime.dispose(1_000);
      return this.failure(session, "worktree_unknown", null, null, null);
    }

    if (this.runs.readCancel(this.request.runId) !== null) {
      await runtime.dispose(2_000);
      return this.cancelled(session, "", { inputTokens: null, outputTokens: null }, { startEntryId: null, leafEntryId: null }, null);
    }
    const lostBeforeStart = this.lostOwnership?.() ?? null;
    if (lostBeforeStart !== null) {
      // 占用已丢失：不发起任何新的模型调用，直接走失败路径。
      await this.markSession(session, "opening", `lock_ownership_lost:${lostBeforeStart}`, false);
      await runtime.dispose(2_000).catch(() => null);
      return this.failure(session, `lock_ownership_lost:${lostBeforeStart}`, null, null, null);
    }
    // 副作用前最后核对实际检出分支；prepare 后、启动前换分支在此拒绝（任务028）。
    if (!liveBranchMatches(this.executionDir, this.request.expected.branch, gitSync)) {
      await this.markSession(session, "opening", "branch_mismatch_at_start", false);
      await runtime.dispose(2_000).catch(() => null);
      return this.failure(session, "branch_mismatch_at_start", null, null, null);
    }
    let start = await runtime.start();
    // prefer 恢复失败沿原客户端新建：保持项目占用与会话锁语义不变，切到预分配新原生 ID（任务035）。
    // 仅身份/恢复类失败可重建；模型配置错误重试无意义，直接失败。
    if (
      !start.ok &&
      session.decision.action === "resume" &&
      ["session_identity_mismatch", "connection_closed", "no_session_state"].includes(start.failure ?? "")
    ) {
      await runtime.dispose(2_000).catch(() => null);
      const fallbackReason = `resume_fallback:${start.failure}`;
      const fallbackDecision: ResumeDecision = {
        action: "create_new",
        nativeSessionId: randomUUID(),
        reason: fallbackReason,
        check: session.decision.action === "resume" ? session.decision.check : null,
      };
      const fallbackSession = await this.rebuildSessionRecord(session, fallbackDecision);
      session = fallbackSession.session;
      // 旧会话锁先释放再切换；新锁拿不到则按会话占用失败终止，不与其它 run 共用对象。
      if (sessionLock !== null && this.locks !== null) this.locks.release(sessionLock);
      sessionLock = fallbackSession.sessionLock;
      this.activeSessionLock = sessionLock;
      if (this.locks !== null && sessionLock === null) {
        await runtime.dispose(1_000).catch(() => null);
        return this.failure(session, "session_lock_unavailable", null, null, null);
      }
      runtime = this.runtimeFactory(
        buildRuntimeOptions(
          {
            executablePath: this.piExecutable,
            provider: this.request.model.provider,
            modelId: this.request.model.model,
            tools: runtimeTools.tools,
            toolAdditions: runtimeTools.toolAdditions,
            excludeTools: runtimeTools.excludeTools,
            capabilities: runtimeTools.capabilities,
            extensionPaths: runtimeTools.extensionPaths,
            cwd: this.executionDir,
            sessionDir,
            appendSystemPrompt: systemPrompt,
          },
          fallbackDecision,
        ),
      );
      this.writeStageProcess(session, "starting", null, processStartedAt ?? this.now().toISOString());
      start = await runtime.start();
    }
    if (!start.ok) {
      const failure = start.failure ?? "unknown";
      await this.markSession(session, "incompatible", `runtime_start_failed:${failure}`, false);
      // 先终止并等 stderr 收敛再读尾部：set_model 拒绝时响应可能早于 stderr 数据到达。
      await runtime.dispose(2_000).catch(() => null);
      this.writeStartDiagnostics(failure, start.detail, runtime);
      return this.failure(session, `runtime_start_failed:${failure}`, null, null, null);
    }
    piPid = runtime.processId;
    this.writeStageProcess(session, "running", piPid, processStartedAt);
    const sessionFile = runtime.sessionFile;
    const beforeLeaf = sessionFile !== null && existsSync(sessionFile) ? await readLeafEntryId(sessionFile) : null;
    const statsBefore = await runtime.getStats();
    let cancelRequested = false;
    let ownershipLost: string | null = null;
    const promptPromise = runtime.prompt(userPrompt, this.promptTimeoutMs);
    void promptPromise.catch(() => {});
    const cancelWatch = setInterval(() => {
      if (cancelRequested) return;
      if (this.runs.readCancel(this.request.runId) !== null) {
        cancelRequested = true;
        void runtime?.abort().catch(() => {});
      }
    }, 100);
    // 占用丢失同样立即中止：不再执行任何新的工具调用或写回（OPERATIONS.md 第2节）。
    const ownershipWatch = setInterval(() => {
      if (ownershipLost !== null) return;
      const lost = this.lostOwnership?.() ?? null;
      if (lost !== null) {
        ownershipLost = lost;
        void runtime?.abort().catch(() => {});
      }
    }, 100);
    // 取消不是只看 RPC ack：超过宽限仍未稳定则终止本次 Pi 进程组，并留下真实终态。
    let stopDeadline = false;
    const cancelDeadline = (async () => {
      while (!cancelRequested && ownershipLost === null && !stopDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!cancelRequested && ownershipLost === null) return { settled: false, aborted: false, exit: null };
      await new Promise((resolve) => setTimeout(resolve, this.cancelGraceMs));
      return { settled: false, aborted: true, exit: null };
    })();
    const settled = await Promise.race([promptPromise, cancelDeadline]);
    stopDeadline = true;
    clearInterval(cancelWatch);
    clearInterval(ownershipWatch);
    if (this.runs.readCancel(this.request.runId) !== null) cancelRequested = true;
    const lostDuringPrompt = ownershipLost ?? this.lostOwnership?.() ?? null;
    if (lostDuringPrompt !== null) {
      // 丢失占用：立即终止本阶段 Pi 进程组，以 lock_ownership_lost 失败终止，不写回任何推进性结果。
      await this.terminatePiTree(piPid);
      await runtime.dispose(3_000).catch(() => null);
      const sessionFileAfterLost = session.sessionFile ?? findStageSessionFile(this.root, session.nativeSessionId);
      await this.markSession(
        session,
        sessionFileAfterLost !== null ? "available" : "opening",
        `lock_ownership_lost:${lostDuringPrompt}`,
        sessionFileAfterLost !== null,
        sessionFileAfterLost,
      );
      return this.failure(
        session,
        `lock_ownership_lost:${lostDuringPrompt}`,
        { inputTokens: null, outputTokens: null },
        { startEntryId: null, leafEntryId: null },
        sessionFileAfterLost,
      );
    }
    if (!settled.settled && cancelRequested) {
      await this.terminatePiTree(piPid);
      await runtime.dispose(3_000).catch(() => null);
      const sessionFileAfterCancel = session.sessionFile ?? findStageSessionFile(this.root, session.nativeSessionId);
      await this.markSession(session, "available", "cancelled_tool_terminated", sessionFileAfterCancel !== null, sessionFileAfterCancel);
      return this.cancelled(session, "", { inputTokens: null, outputTokens: null }, { startEntryId: null, leafEntryId: null }, sessionFileAfterCancel);
    }
    const statsAfter = await runtime.getStats();
    const usage = usageDelta(statsBefore, statsAfter);
    let nativeEntries = { startEntryId: null as string | null, leafEntryId: null as string | null };
    let nativeReadable = false;
    if (sessionFile !== null) {
      const check = await checkNativeSessionFile(sessionFile, session.nativeSessionId);
      nativeReadable = check.exists && check.problem === null;
      if (nativeReadable) {
        nativeEntries = await readEntryRange(sessionFile, beforeLeaf);
        await this.markSession(session, "available", null, true, sessionFile);
      } else {
        await this.markSession(session, "opening", "native_file_not_persisted", false, sessionFile);
      }
    } else {
      await this.markSession(session, "opening", "native_file_not_persisted", false, null);
    }

    if (!settled.settled) {
      await runtime.dispose(3_000);
      const reason = settled.exit !== null ? `agent_exited:${settled.exit.code ?? settled.exit.signal ?? "unknown"}` : "agent_not_settled";
      return this.failure(session, reason, usage, nativeEntries, sessionFile);
    }
    if (settled.aborted || cancelRequested) {
      const text = await runtime.getLastAssistantText().catch(() => "");
      if (cancelRequested) await this.terminatePiTree(piPid);
      await runtime.dispose(3_000);
      return this.cancelled(session, text, usage, nativeEntries, sessionFile);
    }

    const text = await runtime.getLastAssistantText().catch(() => "");
    await runtime.dispose(3_000);
    return this.finalizeCompleted(session, beforeSignature, usage, nativeEntries, sessionFile, text, nativeReadable);
    } finally {
      if (runtime !== null) await runtime.dispose(1_000).catch(() => null);
      if (processStartedAt !== null) {
        try {
          const stillAlive = piPid !== null && procStartTicks(piPid) !== null;
          this.writeStageProcess(session, stillAlive ? "running" : "exited", piPid, processStartedAt);
        } catch {
          // 退出记录失败不覆盖已经产生的执行结果；现场仍可由 stage-process 旧版本与进程表核实。
        }
      }
      clearInterval(sessionHeartbeat);
      this.activeSessionLock = null;
      if (sessionLock !== null && this.locks !== null) this.locks.release(sessionLock);
    }
  }

  /** 取消时清理本阶段 Pi 的完整后代树；工具可能自建进程组，不能只杀 Pi 组。 */
  private async terminatePiTree(piPid: number | null): Promise<void> {
    if (piPid === null) return;
    const tree = processTreePids(piPid);
    if (tree.length === 0) return;
    signalProcessTree(piPid, "SIGTERM", tree);
    await new Promise((resolve) => setTimeout(resolve, 500));
    signalProcessTree(piPid, "SIGKILL", tree);
  }

  /** 启动失败诊断（DESIGN.md 5.6）：只作辅助证据，不作权威回执、不参与状态机。 */
  private writeStartDiagnostics(failure: string, detail: string, runtime: PiAgentRuntime): void {
    try {
      const stderr = runtime.stderrDiagnostics;
      const tail = stderr.tail.trim();
      const clipped = tail.length > START_DIAGNOSTICS_TAIL_LIMIT ? tail.slice(-START_DIAGNOSTICS_TAIL_LIMIT) : tail;
      const diagnostics: RunDiagnosticsFile = {
        schemaVersion: 1,
        runId: this.request.runId,
        taskId: this.request.taskId,
        phase: this.request.phase,
        kind: "runtime_start_failed",
        failure,
        detail,
        stderrTail: clipped,
        truncated: stderr.truncated || tail.length > clipped.length,
        recordedAt: this.now().toISOString(),
      };
      this.runs.writeDiagnostics(this.request.runId, diagnostics);
    } catch {
      // 诊断写失败不改变既有失败路径；failureReason 与 result 仍是唯一权威。
    }
  }

  /**
   * 把阶段 Pi 登记到 Session 锁与（经回调）执行目录锁 owner：worker 被强杀而 Pi 仍在时，
   * 自动回收据此拒绝回收。登记失败不改变阶段结果，残留时仍需人工核实。
   */
  private registerStageProcess(pid: number | null): void {
    if (this.activeSessionLock !== null && this.locks !== null) {
      try {
        this.locks.attachProcess(this.activeSessionLock, pid);
      } catch {
        // 版本冲突或 owner 丢失：心跳路径会报告占用异常
      }
    }
    try {
      this.onStageProcess?.(pid);
    } catch {
      // 同上
    }
  }

  private writeStageProcess(
    session: PreparedSession,
    state: "starting" | "running" | "exited",
    piPid: number | null,
    startedAt: string,
  ): void {
    const identity = currentIdentity();
    this.registerStageProcess(state === "running" ? piPid : null);
    this.runs.writeStageProcess(this.request.runId, {
      schemaVersion: 1,
      runId: this.request.runId,
      taskId: this.request.taskId,
      phase: this.request.phase,
      state,
      workerPid: identity.pid,
      piPid,
      bootId: identity.machineBootId,
      procStartTicks: piPid === null ? null : procStartTicks(piPid),
      hostname: hostname(),
      nativeSessionId: session.nativeSessionId,
      knitSessionId: session.knitSessionId,
      startedAt,
      recordedAt: this.now().toISOString(),
    });
  }

  private async prepareSession(role: string): Promise<PreparedSession> {
    const expected = this.request.recovery.nativeSessionId;
    const existing =
      expected === null ? null : await this.store.sessions.get({ client: "pi", nativeSessionId: expected, role });
    const file =
      existing?.sessionFile ?? (expected === null ? null : findStageSessionFile(this.root, expected));
    let decision: ResumeDecision;
    if (existing?.kind === "main") {
      // 主会话原生文件不得被 worker 复用；显式恢复请求也改为新子会话。
      decision = { action: "create_new", nativeSessionId: randomUUID(), reason: "main_session_reuse", check: null };
    } else if (existing !== null && !sameDir(existing.cwd, this.executionDir)) {
      // 执行目录变化（主检出 ↔ worktree）：旧会话 cwd 不一致，按 resume=prefer 回退新会话续做。
      decision = { action: "create_new", nativeSessionId: randomUUID(), reason: "cwd_mismatch", check: null };
    } else if (expected === null || this.request.recovery.resume === "new") {
      decision = { action: "create_new", nativeSessionId: randomUUID(), reason: expected === null ? "no_previous_session" : "resume_new_requested", check: null };
    } else {
      decision = await decideResume(expected, file);
    }
    const nativeSessionId = decision.action === "resume" ? decision.nativeSessionId : decision.nativeSessionId;
    // 执行目录变化回退新会话时使用独立 Knit Session ID，不覆盖旧会话对象。
    const knitSessionId =
      existing !== null && decision.action === "create_new" && decision.reason === "cwd_mismatch"
        ? newKnitSessionId(this.randomHex)
        : existing?.knitSessionId ?? newKnitSessionId(this.randomHex);
    const now = this.now().toISOString();
    const parentSessionId = this.request.initiator.knitSessionId;
    const record: SessionRecord = {
      knitSessionId,
      protocolVersion: PROTOCOL_VERSION,
      ref: { client: "pi", nativeSessionId, role },
      kind: "sub",
      status: "opening",
      sessionFile: decision.action === "resume" ? decision.sessionFile : null,
      parentSessionId,
      source:
        existing !== null && decision.action === "create_new" && decision.reason === "cwd_mismatch"
          ? { kind: "resume_fallback", fromSessionId: existing.knitSessionId, reason: "cwd_mismatch" }
          : existing?.source ??
            (decision.action === "create_new" && expected !== null
              ? { kind: "resume_fallback", fromSessionId: null, reason: decision.reason }
              : { kind: "attach", fromSessionId: null, reason: null }),
      taskId: this.request.taskId,
      branch: this.request.expected.branch,
      runId: this.request.runId,
      cwd: this.executionDir,
      checkpoint: null,
      selection: null,
      reason: decision.action === "create_new" ? decision.reason : null,
      lastVerifiedAt: now,
      nativeReadable: false,
      relatedRunState: null,
      recordedAt: existing?.recordedAt ?? now,
    };
    await this.store.sessions.save(record);
    return {
      knitSessionId,
      nativeSessionId,
      sessionFile: record.sessionFile,
      role,
      decision,
      record,
      status: "opening",
      nativeReadable: false,
    };
  }

  /**
   * 恢复失败后按新决策重建会话记录：独立 knitSessionId（不与旧对象共用稳定身份），
   * 来源关联旧会话，不覆盖旧引用；会话锁切换到新原生 ID（任务035）。
   */
  private async rebuildSessionRecord(
    session: PreparedSession,
    decision: ResumeDecision & { reason: string },
  ): Promise<{ session: PreparedSession; sessionLock: AcquiredLock | null }> {
    const now = this.now().toISOString();
    const oldRecord = session.record;
    // 旧会话标记为 incompatible，保留原引用与来源，不删除。
    await this.markSession(session, "incompatible", `superseded_by_fallback:${decision.reason}`, oldRecord.nativeReadable);
    const knitSessionId = newKnitSessionId(this.randomHex);
    const record: SessionRecord = {
      knitSessionId,
      protocolVersion: PROTOCOL_VERSION,
      ref: { client: "pi", nativeSessionId: decision.nativeSessionId, role: session.role },
      kind: "sub",
      status: "opening",
      sessionFile: null,
      parentSessionId: oldRecord.parentSessionId,
      source: { kind: "resume_fallback", fromSessionId: oldRecord.knitSessionId, reason: decision.reason },
      taskId: oldRecord.taskId,
      branch: oldRecord.branch,
      runId: this.request.runId,
      cwd: this.executionDir,
      checkpoint: null,
      selection: null,
      reason: decision.reason,
      lastVerifiedAt: now,
      nativeReadable: false,
      relatedRunState: null,
      recordedAt: now,
    };
    await this.store.sessions.save(record);
    let newLock: AcquiredLock | null = null;
    if (this.locks !== null) {
      newLock = await this.locks.acquire({
        keys: [{ scope: "session", rawKey: `pi:${decision.nativeSessionId}` }],
        action: `stage.${session.role}`,
      });
    }
    const next: PreparedSession = {
      knitSessionId,
      nativeSessionId: decision.nativeSessionId,
      sessionFile: null,
      role: session.role,
      decision,
      record,
      status: "opening",
      nativeReadable: false,
    };
    return { session: next, sessionLock: newLock };
  }

  private async markSession(
    session: PreparedSession,
    status: SessionRecord["status"],
    reason: string | null,
    nativeReadable: boolean,
    sessionFile: string | null = session.sessionFile,
  ): Promise<void> {
    session.status = status;
    session.nativeReadable = nativeReadable;
    session.sessionFile = sessionFile;
    await this.store.sessions.save({
      ...session.record,
      status,
      reason,
      nativeReadable,
      sessionFile,
      lastVerifiedAt: this.now().toISOString(),
    });
  }

  private sessionRecord(session: PreparedSession, nativeReadable: boolean, sessionFile: string | null): RunSessionRecord {
    return {
      knitSessionId: session.knitSessionId,
      nativeSessionId: session.nativeSessionId,
      sessionFile,
      role: session.role,
      status: session.status,
      resumeAction: session.decision.action,
      resumeReason: session.decision.action === "create_new" ? session.decision.reason : null,
      nativeReadable,
    };
  }

  private async previousImplementResult(runIds: string[]): Promise<{ summary: string | null; changedPaths: string[] } | null> {
    for (const runId of [...runIds].reverse()) {
      const request = this.runs.readRequest(runId);
      if (request === null) continue;
      // 旧 run 也按 prepare 冻结的阶段定义判断：配置在途降级后，
      // 自定义实施阶段仍要作为“上一实施结果”进入本 run 的用户提示。
      const stage = request.stageDefinition ?? workflowStageOf(this.workflow, request.phase);
      const workStage = stage === null
        ? request.phase === "implement"
        : request.stageDefinition !== undefined
          ? !request.stageDefinition.decision
          : !isDecisionStage(stage);
      if (!workStage) continue;
      const result = this.runs.readResult(runId);
      if (result?.state !== "completed") continue;
      return { summary: result.reportSummary, changedPaths: result.actualChangedPaths };
    }
    return null;
  }

  /**
   * Rex 分支：输入/快照已由 worker 冻结；这里只替换运行时呈现，之后仍回到同一
   * 报告校验、changedPaths 核对与 result 发布路径。不写核心 state/result 之外的事实。
   */
  private async executeRexStage(
    session: PreparedSession,
    systemPrompt: string,
    userPrompt: string,
    runtimeTools: StageRuntimeTools,
  ): Promise<StageExecution> {
    const processStartedAt = this.now().toISOString();
    this.writeStageProcess(session, "starting", null, processStartedAt);
    const beforeSignature = worktreeSignature(this.executionDir);
    if (beforeSignature === null) {
      await this.markSession(session, "opening", "worktree_unknown", false);
      return this.failure(session, "worktree_unknown", null, null, null);
    }
    if (this.runs.readCancel(this.request.runId) !== null) {
      return this.cancelled(session, "", { inputTokens: null, outputTokens: null }, { startEntryId: null, leafEntryId: null }, session.sessionFile);
    }
    const lostBeforeStart = this.lostOwnership?.() ?? null;
    if (lostBeforeStart !== null) {
      await this.markSession(session, "opening", `lock_ownership_lost:${lostBeforeStart}`, false);
      return this.failure(session, `lock_ownership_lost:${lostBeforeStart}`, null, null, null);
    }
    if (!liveBranchMatches(this.executionDir, this.request.expected.branch, gitSync)) {
      await this.markSession(session, "opening", "branch_mismatch_at_start", false);
      return this.failure(session, "branch_mismatch_at_start", null, null, null);
    }

    const sessionDir = join(this.root, ".knit", ".runtime", "pi-sessions");
    let piPid: number | null = null;
    const launcher = this.rexLauncherFactory({
      root: this.root,
      runId: this.request.runId,
      taskId: this.request.taskId,
      phase: this.request.phase,
      sessionId: session.nativeSessionId,
      sessionFile: session.sessionFile,
      provider: this.request.model.provider,
      modelId: this.request.model.model,
      tools: runtimeTools.tools,
      toolAdditions: runtimeTools.toolAdditions,
      excludeTools: runtimeTools.excludeTools,
      capabilities: runtimeTools.capabilities,
      toolExtensionPaths: runtimeTools.extensionPaths,
      systemPrompt,
      userPrompt,
      cwd: this.executionDir,
      sessionDir,
      executablePath: this.piExecutable,
      // 不把 StageRunner 的默认目录硬塞给 Rex shell；保留宿主显式配置。
      agentDir: process.env.PI_CODING_AGENT_DIR ?? undefined,
      cancelGraceMs: this.cancelGraceMs,
      onPid: (pid) => {
        piPid = pid;
        if (pid !== null) this.writeStageProcess(session, "running", pid, processStartedAt);
      },
    });
    const beforeLeaf = session.sessionFile !== null && existsSync(session.sessionFile)
      ? await readLeafEntryId(session.sessionFile)
      : null;
    let cancelRequested = false;
    let ownershipLost: string | null = null;
    const cancelWatch = setInterval(() => {
      if (cancelRequested) return;
      if (this.runs.readCancel(this.request.runId) !== null) {
        cancelRequested = true;
        void launcher.stop().catch(() => {});
      }
    }, 100);
    const ownershipWatch = setInterval(() => {
      if (ownershipLost !== null) return;
      const lost = this.lostOwnership?.() ?? null;
      if (lost !== null) {
        ownershipLost = lost;
        void launcher.stop().catch(() => {});
      }
    }, 100);

    let execution: RexExecution | null = null;
    try {
      execution = await launcher.execute();
    } catch (error) {
      const reason = error instanceof InfrastructureError ? error.code : "rex_launcher_error";
      await launcher.dispose().catch(() => {});
      await this.markSession(session, "incompatible", `rex_start_failed:${reason}`, false);
      return this.failure(session, `rex_start_failed:${reason}`, null, null, null);
    } finally {
      clearInterval(cancelWatch);
      clearInterval(ownershipWatch);
    }

    try {
      if (this.runs.readCancel(this.request.runId) !== null) cancelRequested = true;
      const lostAfter = ownershipLost ?? this.lostOwnership?.() ?? null;
      if (lostAfter !== null) {
        await launcher.terminate().catch(() => {});
        const sessionFileAfter = execution.sessionFile ?? session.sessionFile ?? findStageSessionFile(this.root, session.nativeSessionId);
        await this.markSession(
          session,
          sessionFileAfter !== null ? "available" : "opening",
          `lock_ownership_lost:${lostAfter}`,
          sessionFileAfter !== null,
          sessionFileAfter,
        );
        return this.failure(
          session,
          `lock_ownership_lost:${lostAfter}`,
          execution.usage,
          { startEntryId: null, leafEntryId: null },
          sessionFileAfter,
          execution.text,
        );
      }

      // 与 local 分支一致：先核实原生引用并更新 Session，再按真实终态收敛；
      // 取消/失败仍保留可读的原生文件引用。
      const finalSessionFile = execution.sessionFile ?? session.sessionFile;
      const nativeEntries = { startEntryId: null as string | null, leafEntryId: null as string | null };
      let nativeReadable = false;
      if (finalSessionFile !== null) {
        const check = await checkNativeSessionFile(finalSessionFile, session.nativeSessionId);
        nativeReadable = check.exists && check.problem === null;
        if (nativeReadable) {
          const range = await readEntryRange(finalSessionFile, beforeLeaf);
          nativeEntries.startEntryId = range.startEntryId;
          nativeEntries.leafEntryId = range.leafEntryId;
          await this.markSession(session, "available", null, true, finalSessionFile);
        } else {
          await this.markSession(session, "opening", "native_file_not_persisted", false, finalSessionFile);
        }
      } else {
        await this.markSession(session, "opening", "native_file_not_persisted", false, null);
      }

      if (!execution.settled) {
        if (cancelRequested || execution.aborted) {
          return this.cancelled(session, execution.text, execution.usage, nativeEntries, finalSessionFile);
        }
        return this.failure(
          session,
          execution.failure ?? "agent_not_settled",
          execution.usage,
          nativeEntries,
          finalSessionFile,
          execution.text,
        );
      }
      if (execution.aborted || cancelRequested) {
        return this.cancelled(session, execution.text, execution.usage, nativeEntries, finalSessionFile);
      }
      if (execution.failure !== null && execution.result?.outcome === "error") {
        return this.failure(
          session,
          `rex_worker_error:${execution.failure}`,
          execution.usage,
          nativeEntries,
          finalSessionFile,
          execution.text,
        );
      }
      if (this.runs.readCancel(this.request.runId) !== null) cancelRequested = true;
      if (cancelRequested) {
        return this.cancelled(session, execution.text, execution.usage, nativeEntries, finalSessionFile);
      }
      return this.finalizeCompleted(
        session,
        beforeSignature,
        execution.usage,
        nativeEntries,
        finalSessionFile,
        execution.text,
        nativeReadable,
      );
    } finally {
      // 终态统一收口：completed／aborted／error 与恢复发现路径都在此关闭本次浮层；
      // terminate() 已关闭时 closeLayer() 幂等跳过，关闭失败不改变已落盘结果。
      if (typeof launcher.closeLayer === "function") await launcher.closeLayer().catch(() => {});
      await launcher.dispose().catch(() => {});
      const pid = execution?.pid ?? piPid;
      try {
        const stillAlive = pid !== null && procStartTicks(pid) !== null;
        this.writeStageProcess(session, stillAlive ? "running" : "exited", pid, processStartedAt);
      } catch {
        // 退出记录失败不覆盖已产生的执行结果。
      }
    }
  }

  /** 报告校验与 changedPaths 核对；local 与 Rex 共用，避免两条链路分叉。 */
  private finalizeCompleted(
    session: PreparedSession,
    beforeSignature: WorktreeSignature,
    usage: RunUsage,
    nativeEntries: { startEntryId: string | null; leafEntryId: string | null },
    sessionFile: string | null,
    text: string,
    nativeReadable: boolean,
  ): StageExecution {
    // 运行中外部换分支：停止后续副作用，保留可核实证据（任务028）。
    if (!liveBranchMatches(this.executionDir, this.request.expected.branch, gitSync)) {
      return this.failure(session, "branch_mismatch_after_run", usage, nativeEntries, sessionFile, text);
    }
    const afterSignature = worktreeSignature(this.executionDir);
    if (afterSignature === null) return this.failure(session, "worktree_unknown", usage, nativeEntries, sessionFile, text);
    const changedPaths = diffSignatures(beforeSignature, afterSignature);
    // 明确授权为成果的正式规范不在 .knit 保护之列；其余 .knit 元数据、候选与未授权规范仍然拒绝（任务037）。
    const authorizedStandardPaths = new Set((this.request.expected.authorizedStandardOutputs ?? []).map((output) => output.path));
    const protectedPaths = changedPaths.filter(
      (path) => path.startsWith(".knit/") && !authorizedStandardPaths.has(path),
    );
    if (protectedPaths.length > 0) {
      return this.failure(session, `protected_path_modified:${protectedPaths.join(",")}`, usage, nativeEntries, sessionFile, text);
    }
    const parsed = parseStageReport(text);
    if (parsed.report === null) return this.failure(session, parsed.error ?? "report_invalid", usage, nativeEntries, sessionFile, text);
    const validation = validateReportForStage(this.stage, parsed.report, changedPaths);
    if (!validation.ok) {
      const actualPaths = [...new Set(changedPaths.map(normalizePath))].sort();
      return this.failure(
        session,
        validation.reason ?? "report_invalid",
        usage,
        nativeEntries,
        sessionFile,
        text,
        parsed.report,
        actualPaths,
      );
    }

    return {
      session: this.sessionRecord(session, nativeReadable, sessionFile),
      result: this.result("completed", parsed.report, usage, nativeEntries, session, text, changedPaths, null),
    };
  }

  private result(
    state: "completed" | "cancelled" | "failed",
    report: StageReport | null,
    usage: RunUsage,
    nativeEntries: { startEntryId: string | null; leafEntryId: string | null },
    session: PreparedSession,
    summary: string,
    actualChangedPaths: string[],
    failureReason: string | null,
  ): RunResultFile {
    return {
      schemaVersion: 1,
      runId: this.request.runId,
      taskId: this.request.taskId,
      phase: this.request.phase,
      state,
      report,
      reportSummary: report?.summary ?? (summary.trim() === "" ? null : summary.trim()),
      nativeEntries,
      usage,
      session: this.sessionRecord(session, session.nativeReadable, session.sessionFile),
      actualChangedPaths,
      actualEntries: actualChangedPaths.map((path) => currentEntry(this.executionDir, path, { factsKind: true })),
      acceptanceOperationId: this.request.acceptanceOperationId,
      recordedAt: this.now().toISOString(),
      failureReason,
      branch: this.request.expected.branch,
      workflowMode: this.workflowMode,
    };
  }

  private failure(
    session: PreparedSession,
    reason: string,
    usage: RunUsage | null,
    nativeEntries: { startEntryId: string | null; leafEntryId: string | null } | null,
    sessionFile: string | null,
    text = "",
    report: StageReport | null = null,
    actualChangedPaths: string[] = [],
  ): StageExecution {
    const entries = nativeEntries ?? { startEntryId: null, leafEntryId: null };
    return {
      session: this.sessionRecord(session, session.nativeReadable, sessionFile ?? session.sessionFile),
      result: this.result(
        "failed",
        report,
        usage ?? { inputTokens: null, outputTokens: null },
        entries,
        session,
        text,
        actualChangedPaths,
        reason,
      ),
    };
  }

  private cancelled(
    session: PreparedSession,
    text: string,
    usage: RunUsage,
    nativeEntries: { startEntryId: string | null; leafEntryId: string | null },
    sessionFile: string | null,
  ): StageExecution {
    return {
      session: this.sessionRecord(session, session.nativeReadable, sessionFile ?? session.sessionFile),
      result: this.result("cancelled", null, usage, nativeEntries, session, text, [], "agent_aborted"),
    };
  }
}

interface PreparedSession {
  knitSessionId: string;
  nativeSessionId: string;
  sessionFile: string | null;
  role: string;
  decision: ResumeDecision;
  record: SessionRecord;
  status: SessionRecord["status"];
  nativeReadable: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}
