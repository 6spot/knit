/**
 * run 结果接收（DESIGN.md 5.6、ARCHITECTURE.md 第5节）。
 * 只按固定 acceptanceOperationId 复核 request/result/inputs/scope 后写 Task／binding；
 * 模型报告不直接改 Task，结果文件写入失败也不发布完成。
 */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckFile, RunRequestFile, RunResultFile, ScopeFile } from "../contracts/run.js";
import type { AcceptanceJournal, AcceptanceState } from "../contracts/acceptance.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { parseTaskDocument, renderTaskDocument } from "./task-document.js";
import { inputsDigestOf } from "../contracts/task-inputs.js";
import { locateTaskDocument } from "./task-service.js";
import { currentEntry, loadScope, mergeScope, scopeDigest } from "./scope.js";
import { ContextPlanner } from "./context-planner.js";
import { parseConfig, defaultConfig, type ProjectConfig } from "./config.js";
import { onCheckAccepted, onImplementationAccepted, type TaskFacts } from "../domain/task.js";
import { repairDecision } from "../domain/repair.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { sha256Bytes } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { RunStore } from "../infrastructure/run-store.js";
import type { MetadataStore } from "../ports/infrastructure.js";

export interface RunAcceptanceOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

export interface AcceptanceResult {
  runId: string;
  accepted: boolean;
  duplicate: boolean;
  reason: string | null;
  operationId: string;
  phase: string;
  verdict: string | null;
}

export class RunAcceptanceService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(options: RunAcceptanceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  }

  /**
   * 接收结果。调用方已持项目执行占用时传 lockHeld=true，避免同进程重复取锁。
   * 返回 accepted=false 时 operation 置 needs_attention，保留现场供人工核对。
   */
  async accept(input: { dir: string; runId: string; lockHeld?: boolean }): Promise<AcceptanceResult> {
    const root = normalizeRoot(input.dir);
    const runs = new RunStore(root);
    const request = runs.readRequest(input.runId);
    if (request === null) throw new InfrastructureError("io_error", `run 不存在: ${input.runId}`);
    let result = null;
    try {
      result = runs.readResult(input.runId);
    } catch {
      result = null;
    }
    const operationId = request.acceptanceOperationId;
    const operation = await this.store.operations.get(operationId);
    if (operation?.state === "completed") {
      if (result?.state === "completed") this.reconcileState(runs, request);
      const journalPhase = runs.readAcceptanceJournal(request.runId)?.target.phase ?? request.phase;
      runs.removeAcceptanceJournal(request.runId);
      return {
        runId: request.runId,
        accepted: true,
        duplicate: true,
        reason: operation.reason ?? null,
        operationId,
        phase: acceptedPhase(request, operation.reason ?? null, journalPhase),
        verdict: result?.report?.verdict ?? null,
      };
    }
    if (result === null) {
      await this.store.operations.save({ operationId, kind: "run.acceptance", state: "needs_attention", reason: "result_missing", recordedAt: this.now().toISOString() });
      return { runId: request.runId, accepted: false, duplicate: false, reason: "result_missing", operationId, phase: request.phase, verdict: null };
    }
    if (result.acceptanceOperationId !== operationId) {
      throw new InfrastructureError("version_conflict", "result 的 acceptanceOperationId 与 request 不一致");
    }

    const lock = input.lockHeld === true
      ? null
      : await this.locks.acquire({ keys: orderKeys([{ scope: "project", rawKey: root }]), action: "run.accept" });
    try {
      // 锁内重读结果与操作：等待期间结果可能才落盘，也可能已被别的接收者完成。
      try {
        result = runs.readResult(input.runId);
      } catch {
        result = null;
      }
      const currentOperation = await this.store.operations.get(operationId);
      if (currentOperation?.state === "completed") {
        if (result?.state === "completed") this.reconcileState(runs, request);
        return {
          runId: request.runId,
          accepted: true,
          duplicate: true,
          reason: currentOperation.reason ?? null,
          operationId,
          phase: acceptedPhase(request, currentOperation.reason ?? null, runs.readAcceptanceJournal(request.runId)?.target.phase),
          verdict: result?.report?.verdict ?? null,
        };
      }
      if (result === null) {
        await this.attention(operationId, request, "result_missing", null);
        return { runId: request.runId, accepted: false, duplicate: false, reason: "result_missing", operationId, phase: request.phase, verdict: null };
      }
      if (result.acceptanceOperationId !== operationId) {
        throw new InfrastructureError("version_conflict", "result 的 acceptanceOperationId 与 request 不一致");
      }
      if (result.state !== "completed") {
        await this.store.operations.save({
          operationId,
          kind: "run.acceptance",
          state: "completed",
          reason: `run_${result.state}`,
          recordedAt: this.now().toISOString(),
        });
        return {
          runId: request.runId,
          accepted: true,
          duplicate: false,
          reason: `run_${result.state}`,
          operationId,
          phase: request.phase,
          verdict: result.report?.verdict ?? null,
        };
      }
      if (request.phase === "advisory") {
        await this.store.operations.save({ operationId, kind: "run.acceptance", state: "completed", reason: "advisory", recordedAt: this.now().toISOString() });
        this.reconcileState(runs, request);
        return { runId: request.runId, accepted: true, duplicate: false, reason: "advisory", operationId, phase: request.phase, verdict: null };
      }
      const accepted = await this.acceptStage(root, runs, request, result, operationId);
      if (accepted.accepted) this.reconcileState(runs, request);
      return accepted;
    } finally {
      if (lock !== null) this.locks.release(lock);
    }
  }

  private async acceptStage(
    root: string,
    runs: RunStore,
    request: RunRequestFile,
    result: RunResultFile,
    operationId: string,
  ): Promise<AcceptanceResult> {
    const located = locateTaskDocument(root, request.taskId);
    if (located.archived) return this.attention(operationId, request, "task_archived", result);
    const document = located.document;
    const binding = await this.store.bindings.get(request.taskId);
    if (binding === null) return this.attention(operationId, request, "binding_missing", result);
    const inputs = runs.readInputs(request.runId);
    if (inputs === null) return this.attention(operationId, request, "inputs_missing", result);

    const role = request.phase === "advisory" ? "advisory" : request.phase;
    const plan = await new ContextPlanner({ store: this.store, now: this.now, randomHex: this.randomHex }).plan({
      dir: root,
      taskId: request.taskId,
      role,
    });
    if (
      plan.inputsDigest !== inputs.inputsDigest ||
      plan.standardsDigest !== inputs.standardsDigest ||
      plan.effectiveInputsDigest !== inputs.effectiveInputsDigest
    ) {
      return this.attention(operationId, request, "stale_input", result);
    }
    if (document.frontmatter.branch !== request.expected.branch) {
      return this.attention(operationId, request, "branch_changed", result);
    }

    const scope = loadScope(runs, request.taskId, this.now().toISOString());
    if (request.expected.scopeDigest !== undefined && request.expected.scopeDigest !== null) {
      if (scope.digest !== request.expected.scopeDigest) return this.attention(operationId, request, "stale_scope", result);
    }

    const report = result.report;
    if (report === null) return this.attention(operationId, request, "report_missing", result);
    const facts: TaskFacts = {
      status: document.frontmatter.status,
      phase: document.frontmatter.phase,
      outcome: document.frontmatter.outcome,
      branch: document.frontmatter.branch,
      pendingKind: binding.pendingDraft === null ? null : binding.pendingDraft.kind,
    };
    if (facts.pendingKind !== null) return this.attention(operationId, request, "pending_inputs", result);

    // 已有检查点时先重核输入与规范，再按记录收敛；不重新执行阶段。
    const existingJournal = runs.readAcceptanceJournal(request.runId);
    if (existingJournal !== null) {
      if (existingJournal.operationId !== operationId || existingJournal.taskId !== request.taskId) {
        return this.attention(operationId, request, "acceptance_journal_mismatch", result);
      }
      if (
        inputsDigestOf(located.raw.toString("utf8")) !== existingJournal.inputsDigest ||
        plan.standardsDigest !== existingJournal.standardsDigest ||
        plan.effectiveInputsDigest !== existingJournal.effectiveInputsDigest
      ) {
        return this.attention(operationId, request, "stale_input", result);
      }
      return this.applyJournal(root, runs, request, result, existingJournal);
    }

    if (request.phase === "implement") {
      const transition = onImplementationAccepted(facts);
      if ("allowed" in transition && transition.allowed === false) {
        return this.attention(operationId, request, transition.reason, result);
      }
      if (!("phase" in transition)) return this.attention(operationId, request, "transition_invalid", result);
      const reported = new Set((report.changedPaths ?? []).map(normalizePath));
      const actual = new Set(result.actualChangedPaths.map(normalizePath));
      if (reported.size !== actual.size || [...actual].some((path) => !reported.has(path))) {
        return this.attention(operationId, request, "changed_paths_mismatch", result);
      }
      if (result.actualEntries !== undefined) {
        for (const entry of result.actualEntries) {
          const current = currentEntry(root, entry.path);
          if (current.absent !== entry.absent || current.digest !== entry.digest) {
            return this.attention(operationId, request, "scope_changed", result);
          }
        }
      }
      const nextScope = mergeScope(scope, {
        runId: request.runId,
        taskId: request.taskId,
        paths: [...actual],
        root,
        now: this.now().toISOString(),
      });
      const target: AcceptanceState = { status: transition.status, phase: transition.phase, outcome: transition.outcome };
      const nextBinding: TaskBinding = {
        ...binding,
        lastRunIds: appendUnique(binding.lastRunIds, request.runId),
        scope: nextScope.entries,
        scopeRunIds: nextScope.runIds,
        stopReason: null,
        confirmedInputsDigest: inputsDigestOf(renderTaskDocument({
          ...document,
          frontmatter: { ...document.frontmatter, ...target },
        })),
        confirmedStandardsDigest: plan.standardsDigest,
      };
      const journal: AcceptanceJournal = {
        schemaVersion: 1,
        operationId,
        runId: request.runId,
        taskId: request.taskId,
        sourceTaskSha256: sha256Bytes(located.raw),
        inputsDigest: inputs.inputsDigest,
        standardsDigest: inputs.standardsDigest,
        effectiveInputsDigest: inputs.effectiveInputsDigest,
        source: stateOf(document),
        target,
        bindingBefore: binding,
        bindingAfter: nextBinding,
        scopeBefore: scope,
        scopeAfter: nextScope,
        check: null,
        reason: "implementation_accepted",
        verdict: null,
        createdAt: this.now().toISOString(),
      };
      runs.writeAcceptanceJournal(request.runId, journal);
      return this.applyJournal(root, runs, request, result, journal);
    }

    // check
    const verdict = report.verdict;
    if (verdict === undefined) return this.attention(operationId, request, "report_verdict_missing", result);
    const coverage = (report.coverage ?? []).map(normalizePath);
    // 检查报告常用“路径：说明”形式；路径前缀命中即视为覆盖，不要求逐字相等。
    const uncovered = scope.entries
      .map((entry) => entry.path)
      .filter((path) => {
        const normalized = normalizePath(path);
        return !coverage.some((item) => {
          if (item === normalized) return true;
          if (!item.startsWith(normalized)) return false;
          // 路径后必须是分隔／说明文字；避免 app.txt 命中 app.txt.bak。
          return !/[A-Za-z0-9._/-]/.test(item[normalized.length] ?? "");
        });
      });
    if (uncovered.length > 0) return this.attention(operationId, request, `check_scope_incomplete:${uncovered.join(",")}`, result);
    const transition = onCheckAccepted(facts, verdict);
    if ("allowed" in transition && transition.allowed === false) {
      return this.attention(operationId, request, transition.reason, result);
    }
    if (!("phase" in transition)) return this.attention(operationId, request, "transition_invalid", result);

    const check: CheckFile = {
      schemaVersion: 1,
      taskId: request.taskId,
      runId: request.runId,
      branch: document.frontmatter.branch,
      verdict,
      report,
      inputsDigest: inputs.inputsDigest,
      standardsDigest: inputs.standardsDigest,
      effectiveInputsDigest: inputs.effectiveInputsDigest,
      scopeDigest: scope.digest,
      recordedAt: this.now().toISOString(),
    };

    let nextBinding: TaskBinding = {
      ...binding,
      lastRunIds: appendUnique(binding.lastRunIds, request.runId),
      lastCheckRunId: request.runId,
    };
    if (verdict === "changes_requested") {
      if (nextBinding.repairCycleId === null) {
        nextBinding = { ...nextBinding, stopReason: "repair_not_authorized" };
      } else {
        const maxRounds = this.maxRounds(root);
        const decision = repairDecision(
          {
            repairCycleId: nextBinding.repairCycleId,
            repairRounds: nextBinding.repairRounds,
            stopReason: nextBinding.stopReason,
          },
          { kind: "repairRoundCompleted", repairCycleId: nextBinding.repairCycleId },
          maxRounds,
        );
        if (decision.outcome?.changed === true) {
          const rounds = decision.outcome.repairRounds;
          nextBinding = {
            ...nextBinding,
            repairCycleId: decision.outcome.repairCycleId,
            repairRounds: rounds,
            // 达到上限即写明确停止原因；不等到下一次 prepare 才发现。
            stopReason:
              rounds !== null && rounds >= maxRounds ? "repair_round_limit" : decision.outcome.stopReason,
          };
        }
      }
    } else if (verdict === "blocked") {
      nextBinding = { ...nextBinding, stopReason: "check_blocked" };
    } else {
      nextBinding = { ...nextBinding, stopReason: null };
    }
    const target: AcceptanceState = { status: transition.status, phase: transition.phase, outcome: transition.outcome };
    nextBinding = {
      ...nextBinding,
      confirmedInputsDigest: inputsDigestOf(renderTaskDocument({
        ...document,
        frontmatter: { ...document.frontmatter, ...target },
      })),
      confirmedStandardsDigest: plan.standardsDigest,
    };
    const journal: AcceptanceJournal = {
      schemaVersion: 1,
      operationId,
      runId: request.runId,
      taskId: request.taskId,
      sourceTaskSha256: sha256Bytes(located.raw),
      inputsDigest: inputs.inputsDigest,
      standardsDigest: inputs.standardsDigest,
      effectiveInputsDigest: inputs.effectiveInputsDigest,
      source: stateOf(document),
      target,
      bindingBefore: binding,
      bindingAfter: nextBinding,
      scopeBefore: scope,
      scopeAfter: scope,
      check,
      reason: `check_${verdict}`,
      verdict,
      createdAt: this.now().toISOString(),
    };
    runs.writeAcceptanceJournal(request.runId, journal);
    return this.applyJournal(root, runs, request, result, journal);
  }

  /**
   * 按检查点幂等收敛。任何当前事实偏离来源或目标都转为 needs_attention 并保留检查点；
   * 不覆盖后来 Task 变更，不把部分写入当成功。
   */
  private async applyJournal(
    root: string,
    runs: RunStore,
    request: RunRequestFile,
    result: RunResultFile,
    journal: AcceptanceJournal,
  ): Promise<AcceptanceResult> {
    try {
      const located = locateTaskDocument(root, request.taskId);
      if (located.archived) return this.attention(journal.operationId, request, "task_archived", result);
      const document = located.document;
      if (document.frontmatter.branch !== request.expected.branch) {
        return this.attention(journal.operationId, request, "branch_changed", result);
      }
      const currentState = stateOf(document);
      const isSource = sameState(currentState, journal.source);
      const isTarget = sameState(currentState, journal.target);
      if (!isSource && !isTarget) {
        return this.attention(journal.operationId, request, "task_state_changed", result);
      }
      if (!isSource) {
        // 已写入目标后若输入又被改动，不覆盖新输入。
        if (inputsDigestOf(located.raw.toString("utf8")) !== journal.inputsDigest) {
          return this.attention(journal.operationId, request, "stale_input", result);
        }
      } else if (inputsDigestOf(located.raw.toString("utf8")) !== journal.inputsDigest && sha256Bytes(located.raw) !== journal.sourceTaskSha256) {
        return this.attention(journal.operationId, request, "stale_input", result);
      }

      const binding = await this.store.bindings.get(request.taskId);
      if (binding === null) return this.attention(journal.operationId, request, "binding_missing", result);
      const bindingIsBefore = isDeepStrictEqual(binding, journal.bindingBefore);
      const bindingIsAfter = isDeepStrictEqual(binding, journal.bindingAfter);
      if (!bindingIsBefore && !bindingIsAfter) {
        return this.attention(journal.operationId, request, "binding_changed", result);
      }

      const scope = loadScope(runs, request.taskId, this.now().toISOString());
      const scopeIsBefore = scope.digest === journal.scopeBefore.digest;
      const scopeIsAfter = scope.digest === journal.scopeAfter.digest;
      if (!scopeIsBefore && !scopeIsAfter) {
        return this.attention(journal.operationId, request, "stale_scope", result);
      }

      const existingCheck = runs.readCheck(request.runId);
      if (journal.check !== null && existingCheck !== null && !isDeepStrictEqual(existingCheck, journal.check)) {
        return this.attention(journal.operationId, request, "check_conflict", result);
      }

      if (isSource) {
        this.writeTask(join(located.dir, "task.md"), document, journal.target, journal.bindingAfter);
      }
      if (journal.check !== null && existingCheck === null) {
        runs.writeCheck(request.runId, journal.check);
      }
      if (scope.digest !== journal.scopeAfter.digest) {
        runs.writeScope(request.taskId, journal.scopeAfter);
      }
      if (bindingIsBefore) {
        await this.store.bindings.save(journal.bindingAfter);
      }
      await this.store.operations.save({
        operationId: journal.operationId,
        kind: "run.acceptance",
        state: "completed",
        reason: journal.reason,
        recordedAt: this.now().toISOString(),
      });
      runs.removeAcceptanceJournal(request.runId);
      this.reconcileState(runs, request);
      return {
        runId: request.runId,
        accepted: true,
        duplicate: false,
        reason: journal.reason,
        operationId: journal.operationId,
        phase: journal.target.phase,
        verdict: journal.verdict,
      };
    } catch (error) {
      return this.attention(
        journal.operationId,
        request,
        `acceptance_recovery_failed:${error instanceof Error ? error.message : String(error)}`,
        result,
      );
    }
  }

  private writeTask(
    file: string,
    document: ReturnType<typeof parseTaskDocument>,
    transition: { status: TaskFacts["status"]; phase: TaskFacts["phase"]; outcome: TaskFacts["outcome"] },
    binding: TaskBinding,
  ): { document: ReturnType<typeof parseTaskDocument>; binding: TaskBinding } {
    const before = readWithVersion(file);
    if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
    const latest = parseTaskDocument(before.data.toString("utf8"), file);
    if (latest.frontmatter.phase !== document.frontmatter.phase || latest.frontmatter.status !== document.frontmatter.status) {
      throw new InfrastructureError("version_conflict", "接收期间 Task 阶段已变化");
    }
    const updated = {
      ...latest,
      frontmatter: {
        ...latest.frontmatter,
        status: transition.status,
        phase: transition.phase,
        outcome: transition.outcome,
      },
    };
    atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
    return { document: updated, binding };
  }

  private async attention(
    operationId: string,
    request: RunRequestFile,
    reason: string,
    result: RunResultFile | null,
  ): Promise<AcceptanceResult> {
    await this.store.operations.save({
      operationId,
      kind: "run.acceptance",
      state: "needs_attention",
      reason,
      recordedAt: this.now().toISOString(),
    });
    return {
      runId: request.runId,
      accepted: false,
      duplicate: false,
      reason,
      operationId,
      phase: request.phase,
      verdict: result?.report?.verdict ?? null,
    };
  }

  /** 结果已完成但此前因接收失败置 failed 时，接收成功后收敛为 completed；不覆盖真实执行失败。 */
  private reconcileState(runs: RunStore, request: RunRequestFile): void {
    const state = runs.readState(request.runId);
    if (state === null || state.state === "completed") return;
    // 结果已完成时，未终态或仅接收失败导致的 failed 都收敛为 completed；
    // 真实执行失败（非 acceptance_ 原因）不被覆盖。
    if (state.state === "failed" && (state.reason === null || !state.reason.startsWith("acceptance_"))) return;
    runs.writeState(request.runId, { ...state, state: "completed", reason: null, updatedAt: this.now().toISOString() });
  }

  private maxRounds(root: string): number {
    try {
      const config: ProjectConfig = parseConfig(readFileSync(join(root, ".knit", "config.json"), "utf8"));
      return config.workflow.maxRepairRounds;
    } catch {
      return defaultConfig().workflow.maxRepairRounds;
    }
  }
}

function acceptedPhase(request: RunRequestFile, reason: string | null, journalPhase?: string): string {
  if (journalPhase !== undefined) return journalPhase;
  if (reason === "implementation_accepted") return "check";
  if (reason !== null && reason.startsWith("check_")) return "deliver";
  return request.phase;
}

function stateOf(document: ReturnType<typeof parseTaskDocument>): AcceptanceState {
  return {
    status: document.frontmatter.status,
    phase: document.frontmatter.phase,
    outcome: document.frontmatter.outcome,
  };
}

function sameState(a: AcceptanceState, b: AcceptanceState): boolean {
  return a.status === b.status && a.phase === b.phase && a.outcome === b.outcome;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}
