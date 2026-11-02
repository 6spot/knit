/**
 * 独立阶段执行：选会话、构造 Pi 运行时、等待稳定终态、核对实际文件差异并产出不可变 result
 * （DESIGN.md 5.1、5.4–5.6、9.4）。不写 Task／binding；接收由 RunAcceptanceService 负责。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ContextPlan } from "../contracts/context-plan.js";
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
  checkNativeSessionFile,
  decideResume,
  findStageSessionFile,
  isolatedEnv,
  readEntryRange,
  readLeafEntryId,
  type ResumeDecision,
} from "../adapters/pi/index.js";
import { RunStore } from "../infrastructure/run-store.js";
import { procStartTicks, processTreePids, signalProcessTree } from "../infrastructure/process.js";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { LockManager, currentIdentity, type AcquiredLock } from "../infrastructure/locks.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  loadSectionContents,
  parseStageReport,
  validateReportForPhase,
} from "./stage.js";
import { worktreeSignature, type WorktreeSignature } from "./worktree.js";
import { currentEntry } from "./scope.js";

export interface StageRunnerOptions {
  root: string;
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
  promptTimeoutMs?: number;
  /** 取消后等待 agent 自行结束的宽限；超时则终止本次 Pi 进程组。 */
  cancelGraceMs?: number;
  /** 与项目执行锁同源的锁管理器；传入后阶段独占该 Session 锁。 */
  locks?: LockManager;
  /** 校验执行占用；返回非 null 错误码即占用已丢失，立即中止本阶段新动作并失败终止。 */
  lostOwnership?: () => string | null;
  runtimeFactory?: (options: ConstructorParameters<typeof PiAgentRuntime>[0]) => PiAgentRuntime;
}

export interface StageExecution {
  result: RunResultFile;
  session: RunSessionRecord | null;
}

const PI_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"];

/** 启动诊断尾部上限；启动发生在任何 prompt 之前，stderr 不含消息正文，只防超长。 */
const START_DIAGNOSTICS_TAIL_LIMIT = 4_000;

function roleOf(request: RunRequestFile): "implement" | "check" | "advisory" {
  return request.phase === "advisory" ? "advisory" : request.phase;
}

function toolsFor(request: RunRequestFile, plan: ContextPlan): string[] {
  const allowed = plan.toolPolicy.allow.filter((name) => PI_TOOL_NAMES.includes(name));
  if (request.phase === "check" || request.phase === "advisory") {
    return allowed.filter((name) => !["write", "edit"].includes(name));
  }
  return allowed;
}

function diffSignatures(before: WorktreeSignature, after: WorktreeSignature): string[] {
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  return [...paths].filter((path) => before.entries[path] !== after.entries[path]).sort();
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
  private readonly request: RunRequestFile;
  private readonly plan: ContextPlan;
  private readonly inputs: FrozenInputs;
  private readonly store: MetadataStore;
  private readonly runs: RunStore;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;
  private readonly piExecutable: string;
  private readonly agentDir: string;
  private readonly promptTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly locks: LockManager | null;
  private readonly lostOwnership: (() => string | null) | null;
  private readonly runtimeFactory: NonNullable<StageRunnerOptions["runtimeFactory"]>;

  constructor(options: StageRunnerOptions) {
    this.root = options.root;
    this.request = options.request;
    this.plan = options.plan;
    this.inputs = options.inputs;
    this.store = options.store;
    this.runs = options.runs;
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
    this.piExecutable = options.piExecutable ?? process.env.KNIT_PI_BIN ?? "pi";
    this.agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
    this.promptTimeoutMs = options.promptTimeoutMs ?? 900_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000;
    this.locks = options.locks ?? null;
    this.lostOwnership = options.lostOwnership ?? null;
    this.runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => new PiAgentRuntime(runtimeOptions));
  }

  async execute(): Promise<StageExecution> {
    const role = roleOf(this.request);
    const scope = this.runs.readScope(this.request.taskId);
    const binding = await this.store.bindings.get(this.request.taskId);
    const previousImplement = await this.previousImplementResult(binding?.lastRunIds ?? []);
    const contents = loadSectionContents(this.root, this.plan, binding?.pendingDraft?.content ?? null);
    const systemPrompt = buildSystemPrompt(this.plan, this.request.phase, contents);
    const userPrompt = buildUserPrompt(this.plan, this.request.phase, contents, {
      taskId: this.request.taskId,
      runId: this.request.runId,
      branch: this.request.expected.branch,
      snapshotDir: this.request.phase === "implement" ? join(this.runs.runDir(this.request.runId), "snapshot") : null,
      scope: scope?.entries.map((entry) => entry.path) ?? [],
      previousImplement,
    });

    const session = await this.prepareSession(role);
    let sessionLock: AcquiredLock | null = null;
    let runtime: PiAgentRuntime | null = null;
    let processStartedAt: string | null = null;
    let piPid: number | null = null;
    if (this.locks !== null) {
      try {
        sessionLock = await this.locks.acquire({
          keys: [{ scope: "session", rawKey: `pi:${session.nativeSessionId}` }],
          action: `stage.${role}`,
        });
      } catch (error) {
        const reason = error instanceof InfrastructureError && error.code === "lock_busy" ? "session_lock_busy" : "session_lock_unavailable";
        await this.markSession(session, "opening", reason, false);
        return this.failure(session, reason, null, null, null);
      }
    }
    try {
    const sessionDir = join(this.root, ".knit", ".runtime", "pi-sessions");
    processStartedAt = this.now().toISOString();
    this.writeStageProcess(session, "starting", null, processStartedAt);
    runtime = this.runtimeFactory(
      buildRuntimeOptions(
        {
          executablePath: this.piExecutable,
          provider: this.request.model.provider,
          modelId: this.request.model.model,
          tools: toolsFor(this.request, this.plan),
          cwd: this.root,
          sessionDir,
          appendSystemPrompt: systemPrompt,
          env: isolatedEnv(),
        },
        session.decision,
      ),
    );
    const beforeSignature = worktreeSignature(this.root);
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
    const start = await runtime.start();
    if (!start.ok) {
      const failure = start.failure ?? "unknown";
      await this.markSession(session, "incompatible", `runtime_start_failed:${failure}`, false);
      this.writeStartDiagnostics(failure, start.detail, runtime);
      await runtime.dispose(2_000);
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
    const afterSignature = worktreeSignature(this.root);
    if (afterSignature === null) return this.failure(session, "worktree_unknown", usage, nativeEntries, sessionFile, text);
    const changedPaths = diffSignatures(beforeSignature, afterSignature);
    const protectedPaths = changedPaths.filter((path) => path.startsWith(".knit/"));
    if (protectedPaths.length > 0) {
      return this.failure(session, `protected_path_modified:${protectedPaths.join(",")}`, usage, nativeEntries, sessionFile, text);
    }
    if ((this.request.phase === "check" || this.request.phase === "advisory") && changedPaths.length > 0) {
      return this.failure(
        session,
        `${this.request.phase}_side_effects:${changedPaths.join(",")}`,
        usage,
        nativeEntries,
        sessionFile,
        text,
      );
    }

    const parsed = parseStageReport(text);
    if (parsed.report === null) return this.failure(session, parsed.error ?? "report_invalid", usage, nativeEntries, sessionFile, text);
    const validation = validateReportForPhase(this.request.phase, parsed.report);
    if (!validation.ok) return this.failure(session, validation.reason ?? "report_invalid", usage, nativeEntries, sessionFile, text, parsed.report);

    if (this.request.phase === "implement") {
      const reported = new Set((parsed.report.changedPaths ?? []).map(normalizePath));
      const actual = new Set(changedPaths.map(normalizePath));
      if (reported.size !== actual.size || [...actual].some((path) => !reported.has(path))) {
        return this.failure(session, "changed_paths_mismatch", usage, nativeEntries, sessionFile, text, parsed.report);
      }
    }

    return {
      session: this.sessionRecord(session, nativeReadable, sessionFile),
      result: this.result("completed", parsed.report, usage, nativeEntries, session, text, changedPaths, null),
    };
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

  private writeStageProcess(
    session: PreparedSession,
    state: "starting" | "running" | "exited",
    piPid: number | null,
    startedAt: string,
  ): void {
    const identity = currentIdentity();
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

  private async prepareSession(role: "implement" | "check" | "advisory"): Promise<PreparedSession> {
    const expected = this.request.recovery.nativeSessionId;
    const existing =
      expected === null ? null : await this.store.sessions.get({ client: "pi", nativeSessionId: expected, role });
    const file =
      existing?.sessionFile ?? (expected === null ? null : findStageSessionFile(this.root, expected));
    let decision: ResumeDecision;
    if (existing?.kind === "main") {
      // 主会话原生文件不得被 worker 复用；显式恢复请求也改为新子会话。
      decision = { action: "create_new", nativeSessionId: randomUUID(), reason: "main_session_reuse", check: null };
    } else if (expected === null || this.request.recovery.resume === "new") {
      decision = { action: "create_new", nativeSessionId: randomUUID(), reason: expected === null ? "no_previous_session" : "resume_new_requested", check: null };
    } else {
      decision = await decideResume(expected, file);
    }
    const nativeSessionId = decision.action === "resume" ? decision.nativeSessionId : decision.nativeSessionId;
    const knitSessionId = existing?.knitSessionId ?? newKnitSessionId(this.randomHex);
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
        existing?.source ??
        (decision.action === "create_new" && expected !== null
          ? { kind: "resume_fallback", fromSessionId: null, reason: decision.reason }
          : { kind: "attach", fromSessionId: null, reason: null }),
      taskId: this.request.taskId,
      branch: this.request.expected.branch,
      runId: this.request.runId,
      cwd: this.root,
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
      if (request?.phase !== "implement") continue;
      const result = this.runs.readResult(runId);
      if (result?.state !== "completed") continue;
      return { summary: result.reportSummary, changedPaths: result.actualChangedPaths };
    }
    return null;
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
      actualEntries: actualChangedPaths.map((path) => currentEntry(this.root, path)),
      acceptanceOperationId: this.request.acceptanceOperationId,
      recordedAt: this.now().toISOString(),
      failureReason,
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
        [],
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
  role: "implement" | "check" | "advisory";
  decision: ResumeDecision;
  record: SessionRecord;
  status: SessionRecord["status"];
  nativeReadable: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}
