/**
 * 独立阶段执行：选会话、构造 Pi 运行时、等待稳定终态、核对实际文件差异并产出不可变 result
 * （DESIGN.md 5.1、5.4–5.6、9.4）。不写 Task／binding；接收由 RunAcceptanceService 负责。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ContextPlan, ToolPolicy } from "../contracts/context-plan.js";
import type {
  FrozenInputs,
  ReportIssue,
  RunDiagnosticsFile,
  RunRequestFile,
  RunResultFile,
  RunSessionRecord,
  RunAttribution,
  RunUsage,
  StageReport,
} from "../contracts/run.js";
import { newKnitSessionId, type SessionRecord } from "../contracts/session.js";
import type { AcceptanceScenario } from "../contracts/task-inputs.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import {
  PiAgentRuntime,
  buildRuntimeOptions,
  capabilitySwitches,
  checkNativeSessionFile,
  isolatedEnv,
  decideResume,
  findStageSessionFile,
  readEntryRange,
  readLeafEntryId,
  readToolWriteTargets,
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
  buildReportRetryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  scenariosOfPlan,
  loadSectionContents,
  parseStageReport,
} from "./stage.js";
import { worktreeSignature, type WorktreeSignature } from "./worktree.js";
import {
  captureStageBaseline,
  existingPaths,
  attributedChangedPaths,
  inspectStageBoundary,
  observeWorktreeSince,
  protectedRuntimeReason,
  type BoundaryContext,
  type StageBaseline,
  type StageBaselineSummary,
  type StageBoundaryFacts,
  type IgnoredChange,
} from "./stage-baseline.js";
import { legalStageList, loadWorkflow, workflowStageOf } from "./workflow.js";
import {
  isDecisionStage,
  checkScenarioReport,
  isRetryableReportFailure,
  reportField,
  uncoveredScopePaths,
  validateReportForStage,
} from "../domain/report.js";
import { classifyChangedPaths, stageMayWrite, writeWithoutCapabilityReason } from "../domain/attribution.js";
import { residueFactsOf } from "./residue.js";
import type { WorkflowDefinition, WorkflowStage } from "../domain/workflow.js";
import type { ToolCapability } from "../contracts/workflow.js";
import { currentEntry } from "./scope.js";
import { RexLauncher, type RexExecution, type RexLauncherOptions } from "./rex-launcher.js";
import { STAGE_RUN_ENV } from "./stage-context.js";

/** 阶段进程环境标记：KNIT_RUN（task update 缺省声明）与 KNIT_STAGE_RUN_ID（收尾类命令拒绝）同值。 */
function stageEnv(runId: string): Record<string, string> {
  return { KNIT_RUN: runId, [STAGE_RUN_ENV]: runId };
}

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
  /** 报告校验失败后同一会话补报次数；缺省取项目配置 limits.reportRetries（缺省 1）。 */
  reportRetries?: number;
  /** 与项目执行锁同源的锁管理器；传入后阶段独占该 Session 锁。 */
  locks?: LockManager;  /** 校验执行占用；返回非 null 错误码即占用已丢失，立即中止本阶段新动作并失败终止。 */
  lostOwnership?: () => string | null;
  /** Session 锁心跳间隔；缺省 5 秒，与项目配置 limits.heartbeatIntervalMs 一致。 */
  heartbeatIntervalMs?: number;
  /** 阶段 Pi 进程登记回调（worker 登记到执行目录锁 owner）；null 表示已退出。 */
  onStageProcess?: (pid: number | null) => void;
  /** 基线冻结回调：阶段 Agent 启动前调用，worker 据此写入 run state。 */
  onBaseline?: (baseline: StageBaselineSummary) => void;
  runtimeFactory?: (options: ConstructorParameters<typeof PiAgentRuntime>[0]) => PiAgentRuntime;
  /** 测试注入；缺省创建真实 RexLauncher。 */
  rexLauncherFactory?: (options: RexLauncherOptions) => RexLauncher;
  /**
   * auto 选中 Rex 但 worker 从未报到、本 run 无阶段副作用而回退 local 时调用；
   * worker 据此把实际呈现与回退原因写进 run state（request 不可变）。
   */
  onPresentationFallback?: (presentation: "local", reason: string) => void;
}

/** Rex 分支的结果：正常收敛为执行结果，或要求以 local 重启同一 run（仅 auto 且 worker 从未报到）。 */
type RexStageOutcome = StageExecution | { fallback: string };

/** auto 回退 local 的原因：Rex worker 在启动超时内从未报到（含报到前装配失败）。 */
const REX_FALLBACK_REASON = "rex_worker_not_started";

export interface StageExecution {
  result: RunResultFile;
  session: RunSessionRecord | null;
}

/** 可补报的报告失败：issue 带实际 vs 报告对照，report 为上一轮解析出的报告。 */
interface ReportRetrySignal {
  retry: { issue: ReportIssue; report: StageReport | null };
}

type CompletionEvaluation = StageExecution | ReportRetrySignal;

/** 补报轮的结果：文本、取消／失败／占用丢失，或同一会话的下一轮报告。 */
type ReportRetryTurn =
  | { kind: "text"; text: string; usage: RunUsage; sessionFile?: string | null }
  | { kind: "cancelled"; text: string; usage: RunUsage; sessionFile?: string | null }
  | { kind: "failed"; reason: string; text: string; usage: RunUsage; sessionFile?: string | null }
  | { kind: "ownership_lost"; lost: string; text: string; usage: RunUsage; sessionFile?: string | null };

/** 补报时的 prompt 观察：取消／占用丢失与终态事实，用量为本轮增量。 */
interface PromptObservation {
  settled: boolean;
  aborted: boolean;
  exit: { code: number | null; signal: string | null } | null;
  cancelled: boolean;
  ownershipLost: string | null;
  usage: RunUsage;
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
  "knit_material",
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
  private readonly reportRetryLimit: number;
  /** 本 run 已使用的补报轮数与额外用量；写进 result。 */
  private reportRetriesUsed = 0;
  private reportRetryUsage: RunUsage = { inputTokens: null, outputTokens: null };
  /** 本阶段当前 scope 路径；检查报告 coverage 核对照此判断缺项。 */
  private scopePaths: string[] = [];
  /** 本 run 任务输入里的行为场景；提示、补报与 scenarios 字段核对共用。 */
  private scenarios: AcceptanceScenario[] = [];
  private readonly locks: LockManager | null;
  private readonly lostOwnership: (() => string | null) | null;
  private readonly heartbeatIntervalMs: number;
  private readonly onStageProcess: ((pid: number | null) => void) | null;
  private readonly onBaseline: ((baseline: StageBaselineSummary) => void) | null;
  /** 本次阶段冻结的基线；未进入阶段为 null，结果据此附带基线摘要。 */
  private baseline: StageBaseline | null = null;
  /** 收尾边界核对事实；未走到收尾为 null。 */
  private boundary: StageBoundaryFacts | null = null;
  private ignoredChanges: IgnoredChange[] | null = null;
  /** 本 run 原生会话的起点条目（之前的最末条目；null 为从头）；undefined 表示未能定位，归属按来源不明。 */
  private nativeStartLeaf: string | null | undefined = undefined;
  /** 当前持有的 Session 锁；阶段进程登记与心跳使用。 */
  private activeSessionLock: AcquiredLock | null = null;
  private readonly runtimeFactory: NonNullable<StageRunnerOptions["runtimeFactory"]>;
  private readonly rexLauncherFactory: NonNullable<StageRunnerOptions["rexLauncherFactory"]>;
  private readonly onPresentationFallback: StageRunnerOptions["onPresentationFallback"] | null;
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
    this.reportRetryLimit = options.reportRetries ?? 1;
    this.locks = options.locks ?? null;
    this.lostOwnership = options.lostOwnership ?? null;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.onStageProcess = options.onStageProcess ?? null;
    this.onBaseline = options.onBaseline ?? null;
    this.runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => new PiAgentRuntime(runtimeOptions));
    this.rexLauncherFactory = options.rexLauncherFactory ?? ((launcherOptions) => new RexLauncher(launcherOptions));
    this.onPresentationFallback = options.onPresentationFallback ?? null;
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
    this.scopePaths = scope?.entries.map((entry) => entry.path) ?? [];
    const binding = await this.store.bindings.get(this.request.taskId);
    const previousImplement = await this.previousImplementResult(binding?.lastRunIds ?? []);
    const contents = loadSectionContents(this.executionDir, this.plan, binding?.pendingDraft?.content ?? null);
    this.scenarios = scenariosOfPlan(this.plan, contents);
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
      const rex = await this.executeRexStage(session, systemPrompt, userPrompt, runtimeTools);
      if (!("fallback" in rex)) return rex;
      // auto 回退：worker 从未报到且无阶段副作用，以 local 重启同一 run（同一会话与 Session 锁）。
      this.runs.appendEvent(this.request.runId, { event: "presentation_fallback", from: "rex", to: "local", reason: rex.fallback });
      try {
        this.onPresentationFallback?.("local", rex.fallback);
      } catch {
        // state 写入失败不阻止回退；事件与 rex-diagnostics.json 仍记录事实。
      }
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
          // KNIT_RUN：阶段内经 knit_task 改本任务输入时自动声明本 run（显式 --run 优先）。
          // KNIT_STAGE_RUN_ID：阶段进程标记，核心据此拒绝收尾类命令（stage_context_forbidden）。
          env: isolatedEnv(stageEnv(this.request.runId), { offline: capabilitySwitches(runtimeTools.capabilities).offline }),
        },
        session.decision,
      ),
    );
    const beforeSignature = this.freezeBaseline();
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
            env: isolatedEnv(stageEnv(this.request.runId), { offline: capabilitySwitches(runtimeTools.capabilities).offline }),
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
    // 恢复回退后 runtime 已定型；闭包内的补报轮次必须指向同一个 Pi 进程。
    const stageRuntime = runtime;
    this.writeStageProcess(session, "running", piPid, processStartedAt);
    const sessionFile = stageRuntime.sessionFile;
    const beforeLeaf = sessionFile !== null && existsSync(sessionFile) ? await readLeafEntryId(sessionFile) : null;
    this.nativeStartLeaf = beforeLeaf;
    const first = await this.promptObserved(stageRuntime, userPrompt);
    if (first.ownershipLost !== null) {
      // 丢失占用：立即终止本阶段 Pi 进程组，以 lock_ownership_lost 失败终止，不写回任何推进性结果。
      await this.terminatePiTree(piPid);
      await stageRuntime.dispose(3_000).catch(() => null);
      const sessionFileAfterLost = session.sessionFile ?? findStageSessionFile(this.root, session.nativeSessionId);
      await this.markSession(
        session,
        sessionFileAfterLost !== null ? "available" : "opening",
        `lock_ownership_lost:${first.ownershipLost}`,
        sessionFileAfterLost !== null,
        sessionFileAfterLost,
      );
      return this.failure(
        session,
        `lock_ownership_lost:${first.ownershipLost}`,
        { inputTokens: null, outputTokens: null },
        { startEntryId: null, leafEntryId: null },
        sessionFileAfterLost,
      );
    }
    if (!first.settled && first.cancelled) {
      await this.terminatePiTree(piPid);
      await stageRuntime.dispose(3_000).catch(() => null);
      const sessionFileAfterCancel = session.sessionFile ?? findStageSessionFile(this.root, session.nativeSessionId);
      await this.markSession(session, "available", "cancelled_tool_terminated", sessionFileAfterCancel !== null, sessionFileAfterCancel);
      return this.cancelled(session, "", { inputTokens: null, outputTokens: null }, { startEntryId: null, leafEntryId: null }, sessionFileAfterCancel);
    }
    if (!first.settled) {
      const facts = await this.nativeSessionFacts(session, sessionFile, beforeLeaf);
      const reason = first.exit !== null ? `agent_exited:${first.exit.code ?? first.exit.signal ?? "unknown"}` : "agent_not_settled";
      return this.failure(session, reason, first.usage, facts.nativeEntries, sessionFile);
    }
    if (first.aborted || first.cancelled) {
      const text = await stageRuntime.getLastAssistantText().catch(() => "");
      if (first.cancelled) await this.terminatePiTree(piPid);
      const facts = await this.nativeSessionFacts(session, sessionFile, beforeLeaf);
      return this.cancelled(session, text, first.usage, facts.nativeEntries, sessionFile);
    }

    const firstText = await stageRuntime.getLastAssistantText().catch(() => "");
    return await this.completeWithRetries({
      session,
      beforeSignature,
      sessionFile,
      text: firstText,
      usage: first.usage,
      nativeFacts: (file) => this.nativeSessionFacts(session, file, beforeLeaf),
      resend: async (message) => {
        const turn = await this.promptObserved(stageRuntime, message);
        if (turn.ownershipLost !== null) {
          await this.terminatePiTree(piPid);
          await stageRuntime.dispose(3_000).catch(() => null);
          return { kind: "ownership_lost", lost: turn.ownershipLost, text: "", usage: turn.usage };
        }
        if (!turn.settled) {
          if (turn.cancelled) {
            await this.terminatePiTree(piPid);
            await stageRuntime.dispose(3_000).catch(() => null);
            return { kind: "cancelled", text: "", usage: turn.usage };
          }
          const reason = turn.exit !== null ? `agent_exited:${turn.exit.code ?? turn.exit.signal ?? "unknown"}` : "agent_not_settled";
          return { kind: "failed", reason, text: "", usage: turn.usage };
        }
        if (turn.aborted || turn.cancelled) {
          const text = await stageRuntime.getLastAssistantText().catch(() => "");
          if (turn.cancelled) await this.terminatePiTree(piPid);
          return { kind: "cancelled", text, usage: turn.usage };
        }
        return { kind: "text", text: await stageRuntime.getLastAssistantText().catch(() => ""), usage: turn.usage };
      },
    });
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

  /**
   * 发起一轮 prompt 并等待稳定终态；取消／占用丢失立即 abort，超过宽限未稳定时由调用方终止进程组。
   * 返回本轮增量用量与真实终态，供首轮和补报轮共用（补报不另建模型轮次语义）。
   */
  private async promptObserved(runtime: PiAgentRuntime, message: string): Promise<PromptObservation> {
    const statsBefore = await runtime.getStats();
    let cancelRequested = false;
    let ownershipLost: string | null = null;
    const promptPromise = runtime.prompt(message, this.promptTimeoutMs);
    void promptPromise.catch(() => {});
    const cancelWatch = setInterval(() => {
      if (cancelRequested) return;
      if (this.runs.readCancel(this.request.runId) !== null) {
        cancelRequested = true;
        void runtime.abort().catch(() => {});
      }
    }, 100);
    // 占用丢失同样立即中止：不再执行任何新的工具调用或写回（OPERATIONS.md 第2节）。
    const ownershipWatch = setInterval(() => {
      if (ownershipLost !== null) return;
      const lost = this.lostOwnership?.() ?? null;
      if (lost !== null) {
        ownershipLost = lost;
        void runtime.abort().catch(() => {});
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
    const lost = ownershipLost ?? this.lostOwnership?.() ?? null;
    const statsAfter = await runtime.getStats();
    return {
      settled: settled.settled,
      aborted: settled.aborted,
      exit: settled.exit,
      cancelled: cancelRequested,
      ownershipLost: lost,
      usage: usageDelta(statsBefore, statsAfter),
    };
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

  /** 边界核对上下文：执行目录、主检出 runtime 与项目内锁根排除。 */
  private boundaryContext(): BoundaryContext {
    return {
      executionDir: this.executionDir,
      root: this.root,
      runId: this.request.runId,
      taskId: this.request.taskId,
      ignoredExclusions: existingPaths([this.locks?.rootPath]),
    };
  }

  /**
   * 阶段 Agent 启动前冻结基线（HEAD／符号引用／index 摘要、工作区签名、敏感区与忽略区摘要），
   * 写入 run 状态（经 worker 回调）并留作收尾比对；工作区签名不可得返回 null。
   */
  private freezeBaseline(): WorktreeSignature | null {
    const baseline = captureStageBaseline(this.boundaryContext(), this.now);
    if (baseline === null) return null;
    this.baseline = baseline;
    this.runs.appendEvent(this.request.runId, {
      event: "baseline_frozen",
      head: baseline.summary.head,
      symbolicRef: baseline.summary.symbolicRef,
      indexDigest: baseline.summary.indexDigest,
    });
    try {
      this.onBaseline?.(baseline.summary);
    } catch {
      // state 写入失败不改变阶段执行；基线摘要仍随 result 发布。
    }
    return baseline.worktree;
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
      const external = new Set(result.externalChanges ?? []);
      return { summary: result.reportSummary, changedPaths: result.actualChangedPaths.filter((path) => !external.has(path)) };
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
  ): Promise<RexStageOutcome> {
    const processStartedAt = this.now().toISOString();
    this.writeStageProcess(session, "starting", null, processStartedAt);
    const beforeSignature = this.freezeBaseline();
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
      // 报告可能补报：settle 后保持 worker 存活，由核心决定再补一轮还是关闭浮层。
      closeOnSettle: false,
      onPid: (pid) => {
        piPid = pid;
        if (pid !== null) this.writeStageProcess(session, "running", pid, processStartedAt);
      },
    });
    const beforeLeaf = session.sessionFile !== null && existsSync(session.sessionFile)
      ? await readLeafEntryId(session.sessionFile)
      : null;
    this.nativeStartLeaf = beforeLeaf;
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
      // 保留原始错误：消息与 Rex 侧 stderr／块状态写进 rex-diagnostics.json，摘要写进 result（S7）。
      const message = error instanceof Error ? error.message : String(error);
      await launcher.dispose().catch(() => {});
      this.writeRexDiagnostics(launcher, reason, message);
      if (await this.rexFallbackEligible(launcher, null, session, beforeLeaf, cancelRequested || ownershipLost !== null)) {
        if (typeof launcher.closeLayer === "function") await launcher.closeLayer().catch(() => {});
        this.writeStageProcess(session, "exited", null, processStartedAt);
        return { fallback: REX_FALLBACK_REASON };
      }
      await this.markSession(session, "incompatible", `rex_start_failed:${reason}`, false);
      return this.failure(session, `rex_start_failed:${reason}`, null, null, null, firstLine(message));
    } finally {
      clearInterval(cancelWatch);
      clearInterval(ownershipWatch);
    }

    try {
      if (this.runs.readCancel(this.request.runId) !== null) cancelRequested = true;
      const lostAfter = ownershipLost ?? this.lostOwnership?.() ?? null;
      // worker 从未报到（启动超时或块进程在报到前退出）：先留诊断；auto 且无副作用时以 local 重启。
      const neverReported = this.rexNeverReported(launcher, execution);
      if (neverReported) {
        this.writeRexDiagnostics(launcher, REX_FALLBACK_REASON, execution.failure ?? "worker 未报到");
        if (await this.rexFallbackEligible(launcher, execution, session, beforeLeaf, cancelRequested || lostAfter !== null)) {
          await launcher.terminate().catch(() => {});
          return { fallback: REX_FALLBACK_REASON };
        }
      }
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
      const initialSessionFile = execution.sessionFile ?? session.sessionFile;
      if (!execution.settled) {
        const facts = await this.nativeSessionFacts(session, initialSessionFile, beforeLeaf);
        if (cancelRequested || execution.aborted) {
          return this.cancelled(session, execution.text, execution.usage, facts.nativeEntries, initialSessionFile);
        }
        // 未报到且不回退（显式／配置 rex 或已有副作用）：失败原因带上未报到的事实，详情在 rex-diagnostics.json。
        const failure = neverReported
          ? `rex_start_failed:${REX_FALLBACK_REASON}${execution.failure !== null && execution.failure !== REX_FALLBACK_REASON ? `:${execution.failure}` : ""}`
          : execution.failure ?? "agent_not_settled";
        return this.failure(
          session,
          failure,
          execution.usage,
          facts.nativeEntries,
          initialSessionFile,
          execution.text,
        );
      }
      if (execution.aborted || cancelRequested) {
        const facts = await this.nativeSessionFacts(session, initialSessionFile, beforeLeaf);
        return this.cancelled(session, execution.text, execution.usage, facts.nativeEntries, initialSessionFile);
      }
      if (execution.failure !== null && execution.result?.outcome === "error") {
        const facts = await this.nativeSessionFacts(session, initialSessionFile, beforeLeaf);
        return this.failure(
          session,
          `rex_worker_error:${execution.failure}`,
          execution.usage,
          facts.nativeEntries,
          initialSessionFile,
          execution.text,
        );
      }
      if (this.runs.readCancel(this.request.runId) !== null) cancelRequested = true;
      if (cancelRequested) {
        const facts = await this.nativeSessionFacts(session, initialSessionFile, beforeLeaf);
        return this.cancelled(session, execution.text, execution.usage, facts.nativeEntries, initialSessionFile);
      }
      return await this.completeWithRetries({
        session,
        beforeSignature,
        sessionFile: initialSessionFile,
        text: execution.text,
        usage: execution.usage,
        nativeFacts: (file) => this.nativeSessionFacts(session, file, beforeLeaf),
        resend: async (message) => {
          let retryCancelled = false;
          let retryLost: string | null = null;
          const retryCancelWatch = setInterval(() => {
            if (retryCancelled) return;
            if (this.runs.readCancel(this.request.runId) !== null) {
              retryCancelled = true;
              void launcher.stop().catch(() => {});
            }
          }, 100);
          const retryOwnershipWatch = setInterval(() => {
            if (retryLost !== null) return;
            const lost = this.lostOwnership?.() ?? null;
            if (lost !== null) {
              retryLost = lost;
              void launcher.stop().catch(() => {});
            }
          }, 100);
          let next: RexExecution;
          try {
            next = await launcher.prompt(message);
          } finally {
            clearInterval(retryCancelWatch);
            clearInterval(retryOwnershipWatch);
          }
          if (this.runs.readCancel(this.request.runId) !== null) retryCancelled = true;
          const lost = retryLost ?? this.lostOwnership?.() ?? null;
          if (lost !== null) {
            return { kind: "ownership_lost", lost, text: next.text, usage: next.usage };
          }
          if (!next.settled) {
            if (retryCancelled || next.aborted) {
              return { kind: "cancelled", text: next.text, usage: next.usage };
            }
            return {
              kind: "failed",
              reason: next.failure ?? "agent_not_settled",
              text: next.text,
              usage: next.usage,
              sessionFile: next.sessionFile ?? session.sessionFile,
            };
          }
          if (next.aborted || retryCancelled) {
            return { kind: "cancelled", text: next.text, usage: next.usage };
          }
          if (next.failure !== null && next.result?.outcome === "error") {
            return {
              kind: "failed",
              reason: `rex_worker_error:${next.failure}`,
              text: next.text,
              usage: next.usage,
              sessionFile: next.sessionFile ?? session.sessionFile,
            };
          }
          return {
            kind: "text",
            text: next.text,
            usage: next.usage,
            sessionFile: next.sessionFile ?? session.sessionFile,
          };
        },
      });
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

  /**
   * worker 是否从未报到：启动超时（rex_worker_not_started），或块内进程在写出任何状态前退出。
   * 已报到（bridge／state.json 有过状态）或已有结果的失败不在此列，按原路径收敛。
   */
  private rexNeverReported(launcher: RexLauncher, execution: RexExecution): boolean {
    if (execution.settled || execution.aborted || execution.result !== null) return false;
    const reported = typeof launcher.status === "function" ? launcher.status() : null;
    if (reported !== null) return false;
    return execution.failure === REX_FALLBACK_REASON || execution.failure === "agent_exited";
  }

  /**
   * auto 回退 local 的门槛（任务关键决定）：只有 presentationSource=auto、worker 从未报到、
   * 没有取消／占用丢失，且本 run 无阶段副作用（工作区相对基线无变化、原生会话无新增条目、
   * 无 Rex 结果文件）时才以 local 重启；显式／配置 rex 一律不回退。
   */
  private async rexFallbackEligible(
    launcher: RexLauncher,
    execution: RexExecution | null,
    session: PreparedSession,
    beforeLeaf: string | null,
    interrupted: boolean,
  ): Promise<boolean> {
    if ((this.request.presentationSource ?? "config") !== "auto") return false;
    if (interrupted || this.runs.readCancel(this.request.runId) !== null) return false;
    if (typeof launcher.status === "function" && launcher.status() !== null) return false;
    if (execution !== null && (execution.settled || execution.result !== null)) return false;
    if (this.observedChangedPaths().length > 0) return false;
    const sessionFile = execution?.sessionFile ?? session.sessionFile ?? findStageSessionFile(this.root, session.nativeSessionId);
    if (sessionFile !== null && existsSync(sessionFile)) {
      const leaf = await readLeafEntryId(sessionFile).catch(() => null);
      if (leaf !== beforeLeaf) return false;
    }
    return true;
  }

  /** Rex 启动诊断（rex-diagnostics.json）：原始错误、块状态与 Rex 侧 stderr／屏幕尾部；只作辅助证据。 */
  private writeRexDiagnostics(launcher: RexLauncher, failure: string, message: string): void {
    try {
      const recorded = typeof launcher.diagnostics === "function" ? launcher.diagnostics() : null;
      const diagnostics: RunDiagnosticsFile = {
        schemaVersion: 1,
        runId: this.request.runId,
        taskId: this.request.taskId,
        phase: this.request.phase,
        kind: "rex_start_failed",
        failure: recorded?.failure ?? failure,
        detail: recorded?.detail ?? `${failure}: ${message}`,
        stderrTail: recorded?.output ?? "",
        truncated: recorded?.truncated ?? false,
        recordedAt: this.now().toISOString(),
      };
      this.runs.writeRexDiagnostics(this.request.runId, diagnostics);
    } catch {
      // 诊断写失败不改变失败／回退路径。
    }
  }

  /**
   * 报告校验与 changedPaths 核对；local 与 Rex 共用，避免两条链路分叉。
   * 可补报的报告失败返回 retry 信号，由 completeWithRetries 在同一会话追加纠正提示；
   * 执行、边界、能力或归属失败直接生成终态结果，不能用补报掩盖。
   */
  private evaluateCompleted(
    session: PreparedSession,
    beforeSignature: WorktreeSignature,
    usage: RunUsage,
    nativeEntries: { startEntryId: string | null; leafEntryId: string | null },
    sessionFile: string | null,
    text: string,
    nativeReadable: boolean,
  ): CompletionEvaluation {
    // 边界核对先取事实：HEAD／index／敏感区／忽略区随所有收尾结果发布，供诊断与报告核对。
    const inspection = this.baseline === null ? null : inspectStageBoundary(this.baseline, this.boundaryContext());
    if (inspection !== null) {
      this.boundary = inspection.facts;
      this.ignoredChanges = inspection.ignoredChanges;
      this.runs.appendEvent(this.request.runId, {
        event: "boundary_checked",
        headMoved: inspection.facts.headMoved,
        commits: inspection.facts.commits.length,
        indexChanged: inspection.facts.indexChanged,
        protectedPaths: inspection.facts.protectedPaths.length,
        ignoredChanges: inspection.ignoredChanges.length,
      });
    }
    // 运行中外部换分支：停止后续副作用，保留可核实证据（任务028）。
    if (!liveBranchMatches(this.executionDir, this.request.expected.branch, gitSync)) {
      // 换分支后的差异包含分支间全部差别，不记为任务残留。
      return this.failure(session, "branch_mismatch_after_run", usage, nativeEntries, sessionFile, text, null, []);
    }
    const afterSignature = inspection?.worktree ?? null;
    if (afterSignature === null) return this.failure(session, "worktree_unknown", usage, nativeEntries, sessionFile, text);
    // 改动以“基线提交＋基线脏文件指纹”为准：阶段内提交过的路径也出现在实际差异里。
    // 任务资料（.knit/tasks/**）不计成果：输入变化由摘要在接收时判 stale_input，记录与材料不影响成果。
    const changedPaths = attributedChangedPaths(diffSignatures(beforeSignature, afterSignature));
    const parsed = parseStageReport(text);
    // 阶段内禁止提交：HEAD 移动即失败、保留现场，不接收也不并入 scope；提交列表见 result.boundary.commits。
    if (inspection !== null && inspection.facts.headMoved) {
      return this.failure(session, "head_moved_during_stage", usage, nativeEntries, sessionFile, text, parsed.report, changedPaths);
    }
    // 敏感区（.git hooks／config／info 与 .knit/.runtime 受管资料）阶段前后有变化即拒绝。
    if (inspection !== null && inspection.facts.protectedPaths.length > 0) {
      return this.failure(
        session,
        protectedRuntimeReason(inspection.facts.protectedPaths),
        usage,
        nativeEntries,
        sessionFile,
        text,
        parsed.report,
        changedPaths,
      );
    }
    // 明确授权为成果的正式规范不在 .knit 保护之列；任务资料已剔除；其余 .knit（规范、候选、配置、流程、提示词）仍然拒绝（任务037）。
    const authorizedStandardPaths = new Set((this.request.expected.authorizedStandardOutputs ?? []).map((output) => output.path));
    const protectedPaths = changedPaths.filter(
      (path) => path.startsWith(".knit/") && !authorizedStandardPaths.has(path),
    );
    if (protectedPaths.length > 0) {
      return this.failure(session, `protected_path_modified:${protectedPaths.join(",")}`, usage, nativeEntries, sessionFile, text);
    }
    const actualPaths = [...new Set(changedPaths.map(normalizePath))].sort();
    const pathsField = pathsFieldOf(this.stage);
    if (parsed.report === null) {
      const reason = parsed.error ?? "report_invalid";
      if (isRetryableReportFailure(reason)) {
        return this.reportRetry(reason, null, actualPaths, null, [], `解析／结构错误：${clipText(reason)}`);
      }
      return this.failure(session, reason, usage, nativeEntries, sessionFile, text, null, changedPaths);
    }
    const reportedPaths = reportedPathsOf(parsed.report, pathsField);
    const uncovered = uncoveredScopePaths(this.stage, parsed.report, this.scopePaths);
    // 固定字段、类型与结论先校验；paths 与实际差异的对照交给来源归属（DESIGN §5.3）。
    const shape = validateReportForStage(this.stage, parsed.report, [], { comparePaths: false, scenarios: this.scenarios });
    if (!shape.ok) {
      const reason = shape.reason ?? "report_invalid";
      if (isRetryableReportFailure(reason)) {
        return this.reportRetry(reason, parsed.report, actualPaths, reportedPaths, uncovered, `报告结构错误：${reason}`);
      }
      return this.failure(session, reason, usage, nativeEntries, sessionFile, text, parsed.report, actualPaths);
    }
    const tools = this.toolAttribution(session, sessionFile, actualPaths);
    let reported: string[] | null = reportedPaths;
    if (pathsField === null) {
      // 阶段未声明 paths 字段：没有报告可核对，工具写入的差异即本 run 产出，会话不可读时全部来源不明。
      reported = tools.toolPaths === null ? actualPaths : actualPaths.filter((path) => tools.toolPaths?.includes(path));
    } else if (reported === null && this.stage !== null && !isDecisionStage(this.stage)) {
      // 产出类阶段必须列出 paths（即使本次零 diff）；结论阶段无修改时可缺省。
      return this.reportRetry(
        "report_changed_paths_missing",
        parsed.report,
        actualPaths,
        null,
        uncovered,
        "报告缺少 changedPaths 字段，产出类阶段必须列出实际改动（零 diff 也要显式空数组）。",
      );
    }
    const outcome = classifyChangedPaths({
      actual: actualPaths,
      reported,
      toolPaths: tools.toolPaths,
      residue: residueFactsOf(this.executionDir, this.runs.readResidue(this.request.taskId)),
    });
    const attribution: RunAttribution = {
      source: tools.source,
      toolPaths: tools.toolPaths ?? [],
      claimedPaths: outcome.claimed,
      attributedPaths: outcome.attributed,
      unattributedPaths: outcome.unattributed,
      inheritedPaths: outcome.inherited,
    };
    // 能力与实际不符：阶段未声明 write 却有归属本 run 的改动（exec 即 bash，也能写文件）。
    // 以归属为准：外部改动（未列出且非工具写入，如主会话并发写入）不算本 run 写入；一律失败、保留现场，不提供接纳出口。
    if (!stageMayWrite(this.request.toolPolicy)) {
      const external = new Set(outcome.external);
      const written = actualPaths.filter((path) => !external.has(path));
      if (written.length > 0) {
        return this.failure(
          session,
          writeWithoutCapabilityReason(written),
          usage,
          nativeEntries,
          sessionFile,
          text,
          parsed.report,
          actualPaths,
          { source: attribution.source, toolPaths: attribution.toolPaths },
        );
      }
    }
    if (!outcome.ok) {
      const reason = outcome.reason ?? "report_invalid";
      if (isRetryableReportFailure(reason)) {
        return this.reportRetry(reason, parsed.report, actualPaths, reported, uncovered, `路径归属不通过：${reason}`);
      }
      return this.failure(
        session,
        reason,
        usage,
        nativeEntries,
        sessionFile,
        text,
        parsed.report,
        actualPaths,
        { source: attribution.source, toolPaths: attribution.toolPaths },
      );
    }
    // 逐场景核对（阶段声明 scenarios 且任务有场景时生效）；与接收侧共用规则，避免两处判定分叉。
    const scenarioCheck = checkScenarioReport(this.stage, parsed.report, this.scenarios);
    // 检查报告 coverage 必须逐路径覆盖当前 scope；与接收侧共用规则，避免两处判定分叉。
    if (uncovered.length > 0) {
      const reason = `check_scope_incomplete:${uncovered.join(",")}`;
      // 补报次数有限：coverage 与场景同时有问题时一并指出，原因码仍按 coverage 报。
      const extra = [`coverage 未覆盖 scope 路径：${uncovered.join(", ")}`, ...(scenarioCheck.detail === null ? [] : [scenarioCheck.detail])].join("\n");
      return this.reportRetry(reason, parsed.report, actualPaths, reported, uncovered, extra);
    }
    if (!scenarioCheck.ok) {
      return this.reportRetry(scenarioCheck.reason ?? "report_field_value:scenarios", parsed.report, actualPaths, reported, uncovered, scenarioCheck.detail);
    }
    this.runs.appendEvent(this.request.runId, {
      event: "attribution_checked",
      source: attribution.source,
      attributed: outcome.attributed.length,
      unattributed: outcome.unattributed.length,
      external: outcome.external.length,
      inherited: outcome.inherited.length,
    });

    return {
      session: this.sessionRecord(session, nativeReadable, sessionFile),
      result: this.result("completed", parsed.report, usage, nativeEntries, session, text, actualPaths, null, {
        attribution,
        externalChanges: outcome.external,
        entryPaths: [...actualPaths, ...outcome.inherited],
      }),
    };
  }

  /** 可补报的报告失败信号：带上实际 vs 报告对照，由调用方决定是否还有补报预算。 */
  private reportRetry(
    reason: string,
    report: StageReport | null,
    actualPaths: string[],
    reportedPaths: string[] | null,
    uncoveredPaths: string[],
    extra: string | null,
  ): ReportRetrySignal {
    return {
      retry: {
        report,
        issue: {
          reason,
          actualPaths,
          reportedPaths,
          uncoveredPaths,
          detail: reportIssueDetail({
            actualPaths,
            reportedPaths,
            uncoveredPaths,
            extra,
          }),
        },
      },
    };
  }

  /**
   * 在成功完成阶段工作后处理报告失败：同一会话最多追加 limits.reportRetries 次纠正提示。
   * 补报只重发报告；补报期间出现工作区新改动、HEAD／敏感区变化、取消或占用丢失仍按原语义终止。
   * 执行结果与用量覆盖全部轮次，补报次数与额外用量写进 result。
   */
  private async completeWithRetries(input: {
    session: PreparedSession;
    beforeSignature: WorktreeSignature;
    sessionFile: string | null;
    text: string;
    usage: RunUsage;
    nativeFacts: (sessionFile: string | null) => Promise<{
      nativeEntries: { startEntryId: string | null; leafEntryId: string | null };
      nativeReadable: boolean;
    }>;
    resend: (message: string) => Promise<ReportRetryTurn>;
  }): Promise<StageExecution> {
    let text = input.text;
    let usage = input.usage;
    let sessionFile = input.sessionFile;
    let retryUsage: RunUsage = { inputTokens: 0, outputTokens: 0 };
    for (;;) {
      const facts = await input.nativeFacts(sessionFile);
      const evaluation = this.evaluateCompleted(
        input.session,
        input.beforeSignature,
        usage,
        facts.nativeEntries,
        sessionFile,
        text,
        facts.nativeReadable,
      );
      if (!("retry" in evaluation)) return evaluation;
      const retry = evaluation.retry;
      if (this.reportRetriesUsed >= this.reportRetryLimit) {
        return this.failure(
          input.session,
          retry.issue.reason,
          usage,
          facts.nativeEntries,
          sessionFile,
          text,
          retry.report,
          retry.issue.actualPaths,
          null,
          retry.issue,
        );
      }
      // 补报前冻结一次工作区；期间任何新改动都判失败，避免用补报掩盖二次实施。
      const retryBaseline = worktreeSignature(this.executionDir);
      if (retryBaseline === null) {
        return this.failure(input.session, "worktree_unknown", usage, facts.nativeEntries, sessionFile, text);
      }
      this.runs.appendEvent(this.request.runId, {
        event: "report_retry",
        attempt: this.reportRetriesUsed + 1,
        reason: retry.issue.reason,
        actualPaths: retry.issue.actualPaths,
        reportedPaths: retry.issue.reportedPaths,
        uncoveredPaths: retry.issue.uncoveredPaths,
      });
      let turn: ReportRetryTurn;
      try {
        turn = await input.resend(buildReportRetryPrompt(this.stage, retry.issue, this.scenarios));
        this.reportRetriesUsed += 1;
      } catch (error) {
        // 补报机制本身不可用（如 Rex bridge 断开）时保留原报告失败语义，另留事件说明原因。
        const reason = error instanceof InfrastructureError ? error.code : "report_retry_failed";
        this.runs.appendEvent(this.request.runId, {
          event: "report_retry_unavailable",
          attempt: this.reportRetriesUsed + 1,
          reason,
          detail: clipText(error instanceof Error ? error.message : String(error)),
        });
        const failedFacts = await input.nativeFacts(sessionFile);
        return this.failure(
          input.session,
          retry.issue.reason,
          usage,
          failedFacts.nativeEntries,
          sessionFile,
          text,
          retry.report,
          retry.issue.actualPaths,
          null,
          retry.issue,
        );
      }
      usage = addUsage(usage, turn.usage);
      retryUsage = addUsage(retryUsage, turn.usage);
      this.reportRetryUsage = retryUsage;
      if (turn.sessionFile !== undefined) sessionFile = turn.sessionFile;
      if (turn.kind === "ownership_lost") {
        const lostFacts = await input.nativeFacts(sessionFile);
        return this.failure(
          input.session,
          `lock_ownership_lost:${turn.lost}`,
          usage,
          lostFacts.nativeEntries,
          sessionFile,
          turn.text,
        );
      }
      if (turn.kind === "cancelled") {
        const cancelFacts = await input.nativeFacts(sessionFile);
        return this.cancelled(input.session, turn.text, usage, cancelFacts.nativeEntries, sessionFile);
      }
      if (turn.kind === "failed") {
        const failedFacts = await input.nativeFacts(sessionFile);
        return this.failure(input.session, turn.reason, usage, failedFacts.nativeEntries, sessionFile, turn.text);
      }
      const afterRetry = worktreeSignature(this.executionDir);
      if (afterRetry === null) {
        const failedFacts = await input.nativeFacts(sessionFile);
        return this.failure(input.session, "worktree_unknown", usage, failedFacts.nativeEntries, sessionFile, turn.text);
      }
      // HEAD／runtime 敏感区变化优先按原边界原因失败，不被“补报期间有改动”覆盖。
      const retryBoundary = this.baseline === null ? null : inspectStageBoundary(this.baseline, this.boundaryContext());
      if (retryBoundary !== null) {
        this.boundary = retryBoundary.facts;
        this.ignoredChanges = retryBoundary.ignoredChanges;
        if (retryBoundary.facts.headMoved) {
          const failedFacts = await input.nativeFacts(sessionFile);
          return this.failure(input.session, "head_moved_during_stage", usage, failedFacts.nativeEntries, sessionFile, turn.text, retry.report);
        }
        if (retryBoundary.facts.protectedPaths.length > 0) {
          const failedFacts = await input.nativeFacts(sessionFile);
          return this.failure(
            input.session,
            protectedRuntimeReason(retryBoundary.facts.protectedPaths),
            usage,
            failedFacts.nativeEntries,
            sessionFile,
            turn.text,
            retry.report,
          );
        }
      }
      const retryChanged = diffSignatures(retryBaseline, afterRetry);
      if (retryChanged.length > 0) {
        // 补报期间新改动：报告即使修好也不接收，保留首轮工作与新改动作为残留。
        const failedFacts = await input.nativeFacts(sessionFile);
        return this.failure(
          input.session,
          `report_retry_worktree_changed:${retryChanged.join(",")}`,
          usage,
          failedFacts.nativeEntries,
          sessionFile,
          turn.text,
          retry.report,
        );
      }
      text = turn.text;
    }
  }

  /** 仅按原生文件核对并登记 Session；报告补报多轮后最后一次调用覆盖完整 entry range。 */
  private async nativeSessionFacts(
    session: PreparedSession,
    sessionFile: string | null,
    beforeLeaf: string | null,
  ): Promise<{
    nativeEntries: { startEntryId: string | null; leafEntryId: string | null };
    nativeReadable: boolean;
  }> {
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
    return { nativeEntries, nativeReadable };
  }

  /**
   * 工具调用归属：本 run 原生会话中 write／edit 的目标（项目相对路径）。
   * worktree 执行目录本身隔离，差异全部视为本 run 写入；会话不可读或起点不可定位时返回 null（全部来源不明）。
   */
  private toolAttribution(
    session: PreparedSession,
    sessionFile: string | null,
    actualPaths: string[],
  ): { source: RunAttribution["source"]; toolPaths: string[] | null } {
    if (!sameDir(this.executionDir, this.root)) return { source: "isolated", toolPaths: [...actualPaths] };
    const file = sessionFile ?? session.sessionFile;
    if (file === null || !session.nativeReadable || this.nativeStartLeaf === undefined) {
      return { source: "unavailable", toolPaths: null };
    }
    const scan = readToolWriteTargets(file, this.nativeStartLeaf);
    if (scan.problem !== null) return { source: "unavailable", toolPaths: null };
    const paths = scan.paths
      .map((raw) => projectRelativePath(this.executionDir, raw))
      .filter((path): path is string => path !== null);
    return { source: "native_session", toolPaths: [...new Set(paths)].sort() };
  }

  /** 失败／取消收尾时的实际差异：基线以来的变化（剔除任务资料）；作为任务残留的来源。 */
  private observedChangedPaths(): string[] {
    if (this.baseline === null) return [];
    try {
      const after = observeWorktreeSince(this.baseline, this.boundaryContext());
      if (after === null) return [];
      return [...new Set(attributedChangedPaths(diffSignatures(this.baseline.worktree, after)).map(normalizePath))].sort();
    } catch {
      return [];
    }
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
    extra: {
      attribution?: RunAttribution;
      externalChanges?: string[];
      entryPaths?: string[];
      reportIssue?: ReportIssue;
    } = {},
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
      actualEntries: [...new Set(extra.entryPaths ?? actualChangedPaths)].map((path) => currentEntry(this.executionDir, path, { factsKind: true })),
      acceptanceOperationId: this.request.acceptanceOperationId,
      recordedAt: this.now().toISOString(),
      failureReason,
      branch: this.request.expected.branch,
      workflowMode: this.workflowMode,
      ...(this.baseline === null ? {} : { baseline: this.baseline.summary }),
      ...(this.boundary === null ? {} : { boundary: this.boundary }),
      ...(this.ignoredChanges === null ? {} : { ignoredChanges: this.ignoredChanges }),
      ...(extra.attribution === undefined ? {} : { attribution: extra.attribution }),
      ...(extra.externalChanges === undefined ? {} : { externalChanges: extra.externalChanges }),
      reportRetries: this.reportRetriesUsed,
      ...(this.reportRetriesUsed > 0 ? { reportRetryUsage: this.reportRetryUsage } : {}),
      ...(extra.reportIssue === undefined ? {} : { reportIssue: extra.reportIssue }),
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
    actualChangedPaths: string[] | null = null,
    attribution: RunAttribution | null = null,
    reportIssue: ReportIssue | null = null,
  ): StageExecution {
    const entries = nativeEntries ?? { startEntryId: null, leafEntryId: null };
    // 未给出实际差异时按基线重新观察：失败 run 的改动记为任务残留，供下一轮声明继承（STATES §8）。
    const actual = actualChangedPaths ?? this.observedChangedPaths();
    const facts =
      attribution ??
      (actual.length === 0 ? null : (() => {
        const tools = this.toolAttribution(session, sessionFile, actual);
        return { source: tools.source, toolPaths: tools.toolPaths ?? [] };
      })());
    return {
      session: this.sessionRecord(session, session.nativeReadable, sessionFile ?? session.sessionFile),
      result: this.result(
        "failed",
        report,
        usage ?? { inputTokens: null, outputTokens: null },
        entries,
        session,
        text,
        actual,
        reason,
        {
          ...(facts === null ? {} : { attribution: facts }),
          ...(reportIssue === null ? {} : { reportIssue }),
        },
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
    const actual = this.observedChangedPaths();
    const tools = actual.length === 0 ? null : this.toolAttribution(session, sessionFile, actual);
    return {
      session: this.sessionRecord(session, session.nativeReadable, sessionFile ?? session.sessionFile),
      result: this.result(
        "cancelled",
        null,
        usage,
        nativeEntries,
        session,
        text,
        actual,
        "agent_aborted",
        tools === null ? {} : { attribution: { source: tools.source, toolPaths: tools.toolPaths ?? [] } },
      ),
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

/** 报告 paths 字段的安全读取：只接受字符串数组并剔除任务资料；缺失／类型不符为 null。 */
function reportedPathsOf(report: StageReport, field: string | null): string[] | null {
  if (field === null) return null;
  const value = reportField(report, field);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return [...new Set((value as string[]).map(normalizePath).filter((path) => !path.startsWith(".knit/tasks/")))];
}

/** 报告失败对照文案：实际 vs 报告，再补缺失 coverage、问题场景与解析／结构细节。 */
function reportIssueDetail(input: {
  actualPaths: string[];
  reportedPaths: string[] | null;
  uncoveredPaths: string[];
  extra: string | null;
}): string {
  const list = (paths: string[]): string => (paths.length === 0 ? "（无）" : paths.join(", "));
  return [
    `实际改动路径：${list(input.actualPaths)}`,
    `报告 changedPaths：${input.reportedPaths === null ? "（缺失）" : list(input.reportedPaths)}`,
    ...(input.uncoveredPaths.length === 0
      ? []
      : [`coverage 未覆盖的 scope 路径：${list(input.uncoveredPaths)}`]),
    ...(input.extra === null ? [] : [input.extra]),
  ].join("\n");
}

/** 补报提示中的错误文本截断，避免把超长 JSON 解析错误整段塞回模型。 */
function clipText(text: string, limit = 1_500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断）`;
}

/** 用量相加；任一侧未知时保持 unknown，不把缺失值当 0。 */
function addUsage(left: RunUsage, right: RunUsage): RunUsage {
  const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
  };
}

/** 错误消息首行（写进 result 摘要）；完整内容在 rex-diagnostics.json。 */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? "").slice(0, 500);
}

/** 阶段声明的第一个 paths 字段（通常为 changedPaths）；未声明为 null。 */
function pathsFieldOf(stage: WorkflowStage | null): string | null {
  if (stage === null) return null;
  for (const [field, type] of Object.entries(stage.report)) if (type === "paths") return field;
  return null;
}

/**
 * 工具参数路径 → 执行目录相对路径（与 Pi 解析一致：去 @ 前缀、展开 ~、相对 cwd）；
 * 越出执行目录的返回 null。父目录经别名（符号链接）时按 realpath 再算一次。
 */
function projectRelativePath(dir: string, raw: string): string | null {
  let path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  const absolute = isAbsolute(path) ? resolve(path) : resolve(dir, path);
  let rel = relative(dir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    try {
      rel = relative(dir, join(realpathSync(dirname(absolute)), basename(absolute)));
    } catch {
      return null;
    }
  }
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return normalizePath(rel.split(sep).join("/"));
}
