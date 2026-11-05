/**
 * run 结果接收（DESIGN.md 5.6、ARCHITECTURE.md 第5节）。
 * 只按固定 acceptanceOperationId 复核 request/result/inputs/scope 后写 Task／binding；
 * 模型报告不直接改 Task，结果文件写入失败也不发布完成。
 */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckFile, RunRequestFile, RunResultFile, ScopeFile, StageReport } from "../contracts/run.js";
import type { ContextPlan } from "../contracts/context-plan.js";
import type { AcceptanceJournal, AcceptanceState } from "../contracts/acceptance.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { parseTaskDocument, renderTaskDocument } from "./task-document.js";
import { inputsDigestOf } from "../contracts/task-inputs.js";
import { locateTaskDocument } from "./task-service.js";
import { entryDrifts, loadScope, mergeScope, scopeEntriesCurrent } from "./scope.js";
import { currentBranch } from "./delivery.js";
import { executionRouteOf } from "./worktree-routing.js";
import { ContextPlanner } from "./context-planner.js";
import { workflowOf } from "./workflow.js";
import { parseConfig, defaultConfig, type ProjectConfig } from "./config.js";
import { isTransitionRefusal, transition, type TaskFacts } from "../domain/task.js";
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
   * 接收结果。调用方已持本 run 的执行目录占用时传 lockHeld=true，避免同进程重复取锁；
   * lockDir 仅供未取得执行目录锁的失败路径显式改用主检出键。
   * 返回 accepted=false 时 operation 置 needs_attention，保留现场供人工核对。
   */
  async accept(input: { dir: string; runId: string; lockHeld?: boolean; lockDir?: string }): Promise<AcceptanceResult> {
    const root = normalizeRoot(input.dir);
    const runs = new RunStore(root);
    const request = runs.readRequest(input.runId);
    if (request === null) throw new InfrastructureError("io_error", `run 不存在: ${input.runId}`);
    // project 锁按请求冻结的执行目录（任务17）；未取锁的失败路径可显式改用主检出键。
    const projectLockKey = input.lockDir ?? request.expected.executionDir ?? root;
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
      const journalStage = runs.readAcceptanceJournal(request.runId)?.target.stage ?? request.phase;
      runs.removeAcceptanceJournal(request.runId);
      return {
        runId: request.runId,
        accepted: true,
        duplicate: true,
        reason: operation.reason ?? null,
        operationId,
        phase: acceptedPhase(request, operation.reason ?? null, journalStage),
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
      : await this.locks.acquire({ keys: orderKeys([{ scope: "project", rawKey: projectLockKey }]), action: "run.accept" });
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
          phase: acceptedPhase(request, currentOperation.reason ?? null, runs.readAcceptanceJournal(request.runId)?.target.stage),
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
    const binding = await this.store.bindings.get(request.taskId);
    if (binding === null) return this.attention(operationId, request, "binding_missing", result);
    // 工作区路由：worktree 生效时任务资料在 worktree；invalid 不回退主检出。
    const route = executionRouteOf(binding, root);
    if (route.state === "invalid") {
      return this.attention(operationId, request, `worktree_invalid:${route.problem ?? "unknown"}`, result);
    }
    const executionDir = route.dir;
    const located = locateTaskDocument(executionDir, request.taskId);
    if (located.archived) return this.attention(operationId, request, "task_archived", result);
    const document = located.document;
    const inputs = runs.readInputs(request.runId);
    if (inputs === null) return this.attention(operationId, request, "inputs_missing", result);

    const role = request.phase === "advisory" ? "advisory" : request.phase;
    const plan = await new ContextPlanner({ store: this.store, now: this.now, randomHex: this.randomHex }).plan({
      dir: executionDir,
      taskId: request.taskId,
      role,
      // 授权规范成果以冻结旧版本参与输入身份；新内容按成果核查（任务037）。
      authorizedStandardPaths: (request.expected.authorizedStandardOutputs ?? []).map((output) => output.path),
      authorizedStandardContents: request.expected.authorizedStandardOutputs ?? [],
    });
    if (
      plan.inputsDigest !== inputs.inputsDigest ||
      plan.standardsDigest !== inputs.standardsDigest ||
      plan.effectiveInputsDigest !== inputs.effectiveInputsDigest
    ) {
      return this.attention(operationId, request, "stale_input", result);
    }
    // worktree 路由下 frontmatter 保留源分支，不作否决依据。
    if (route.state !== "worktree" && document.frontmatter.branch !== request.expected.branch) {
      return this.attention(operationId, request, "branch_changed", result);
    }
    // 结果接收前核对执行目录的实际检出分支；结果待接收期间换分支不接收（任务028）。
    if (request.phase !== "advisory" && request.expected.branch !== null) {
      const liveBranch = currentBranch(executionDir);
      if (liveBranch !== request.expected.branch) {
        return this.attention(operationId, request, "branch_changed", result);
      }
    }

    const scope = loadScope(runs, request.taskId, this.now().toISOString());
    if (request.expected.scopeDigest !== undefined && request.expected.scopeDigest !== null) {
      if (scope.digest !== request.expected.scopeDigest) {
        // 接收检查点可能已写入并入后的 scope，但 binding 等后续步骤失败；
        // 恢复时允许当前 scope 与同一操作的 scopeAfter 吻合，不把半写入误判为外部漂移。
        const journal = runs.readAcceptanceJournal(request.runId);
        const scopeAlreadyApplied =
          journal !== null &&
          journal.operationId === operationId &&
          journal.taskId === request.taskId &&
          journal.scopeAfter.digest === scope.digest;
        if (!scopeAlreadyApplied) return this.attention(operationId, request, "stale_scope", result);
      }
    }

    const report = result.report;
    if (report === null) return this.attention(operationId, request, "report_missing", result);
    const facts: TaskFacts = {
      status: document.frontmatter.status,
      stage: document.frontmatter.stage,
      outcome: document.frontmatter.outcome,
      branch: document.frontmatter.branch,
      pendingKind: binding.pendingDraft === null ? null : binding.pendingDraft.kind,
      verification: document.frontmatter.verification,
      visits: binding.stageVisits ?? {},
      stopReason: binding.stopReason,
    };
    if (facts.pendingKind !== null) return this.attention(operationId, request, "pending_inputs", result);
    // 草案在运行期间保存或撤回后，任务锁定由本接收持有；接收继续按冻结输入收敛（任务029）。
    const acceptTaskLock = await this.locks.acquire({
      keys: [{ scope: "task", rawKey: `${root}::${request.taskId}` }],
      action: "run.accept.stage",
    });
    try {
    return await this.acceptStageLocked(root, executionDir, route.state, runs, request, result, operationId, located, document, binding, inputs, plan, facts, scope, report);
    } finally {
      this.locks.release(acceptTaskLock);
    }
  }

  private async acceptStageLocked(
    root: string,
    executionDir: string,
    routeState: "main" | "worktree",
    runs: RunStore,
    request: RunRequestFile,
    result: RunResultFile,
    operationId: string,
    located: ReturnType<typeof locateTaskDocument>,
    document: ReturnType<typeof parseTaskDocument>,
    binding: TaskBinding,
    inputs: { inputsDigest: string; standardsDigest: string; effectiveInputsDigest: string },
    plan: ContextPlan,
    facts: TaskFacts,
    scope: ScopeFile,
    report: StageReport,
  ): Promise<AcceptanceResult> {
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
      return this.applyJournal(root, executionDir, routeState, runs, request, result, existingJournal);
    }

    const workflow = workflowOf(executionDir);
    if (request.phase === "implement") {
      const next = transition(workflow, facts, { kind: "implementationAccepted" });
      if (isTransitionRefusal(next)) {
        if (next.stopReason !== undefined) {
          await this.store.bindings.save({ ...binding, stopReason: next.stopReason });
        }
        return this.attention(operationId, request, next.reason, result);
      }
      const reported = new Set((report.changedPaths ?? []).map(normalizePath));
      const actual = new Set(result.actualChangedPaths.map(normalizePath));
      if (reported.size !== actual.size || [...actual].some((path) => !reported.has(path))) {
        return this.attention(operationId, request, "changed_paths_mismatch", result);
      }
      if (result.actualEntries !== undefined) {
        // 接收前按当前事实重核发布时指纹：路径、类型、模式和内容，检查窗口的改动不接收（STATES.md 第8节，任务027）。
        for (const entry of result.actualEntries) {
          if (entryDrifts(executionDir, entry)) return this.attention(operationId, request, "scope_changed", result);
        }
      }
      const nextScope = mergeScope(scope, {
        runId: request.runId,
        taskId: request.taskId,
        paths: [...actual],
        root: executionDir,
        now: this.now().toISOString(),
      });
      const target: AcceptanceState = { status: next.status, stage: next.stage, outcome: next.outcome };
      const targetInputsDigest = inputsDigestOf(renderTaskDocument({
        ...document,
        frontmatter: { ...document.frontmatter, ...target },
      }));
      const nextBinding: TaskBinding = {
        ...binding,
        lastRunIds: appendUnique(binding.lastRunIds, request.runId),
        scope: nextScope.entries,
        scopeRunIds: nextScope.runIds,
        stopReason: null,
        stageVisits: next.visits,
        confirmedInputsDigest: targetInputsDigest,
        confirmedStandardsDigest: plan.standardsDigest,
        lastImplement: {
          runId: request.runId,
          inputsDigest: targetInputsDigest,
          scopeDigest: nextScope.digest,
        },
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
      return this.applyJournal(root, executionDir, routeState, runs, request, result, journal);
    }

    // check
    const verdict = report.verdict;
    if (verdict === undefined) return this.attention(operationId, request, "report_verdict_missing", result);
    const actualChangedPaths = [...new Set(result.actualChangedPaths.map(normalizePath))].sort();
    const reportedChangedPaths = (report.changedPaths ?? []).map(normalizePath);
    const reportedSet = new Set(reportedChangedPaths);
    const actualSet = new Set(actualChangedPaths);
    /* 检查者直接修复时报告必须与实际改动一致；无修改时可缺省 changedPaths。 */
    if (
      (actualSet.size > 0 || reportedSet.size > 0) &&
      (reportedSet.size !== actualSet.size || [...actualSet].some((path) => !reportedSet.has(path)))
    ) {
      return this.attention(operationId, request, "changed_paths_mismatch", result);
    }
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
    const next = transition(workflow, facts, { kind: "stageAccepted", verdict });
    if (isTransitionRefusal(next)) {
      if (next.stopReason !== undefined) {
        await this.store.bindings.save({ ...binding, stopReason: next.stopReason });
      }
      return this.attention(operationId, request, next.reason, result);
    }

    // 检查者可在既定范围内修复；先重核发布时指纹，再允许已声明路径变化。
    // 未被检查修改的既有 scope 路径仍须与当前事实一致，外部改动转 scope_changed（STATES.md 第8节）。
    if (result.actualEntries !== undefined) {
      for (const entry of result.actualEntries) {
        if (entryDrifts(executionDir, entry)) return this.attention(operationId, request, "scope_changed", result);
      }
    }
    const untouched = scope.entries.filter((entry) => !actualSet.has(normalizePath(entry.path)));
    if (!scopeEntriesCurrent(executionDir, untouched)) {
      return this.attention(operationId, request, "scope_changed", result);
    }
    // 检查者有实际修改时并入 scope；append 语义保留既有条目与历史 run。
    // 即使结论为 changes_requested，落盘修复仍是真实成果，不能让后续检查看到过期指纹。
    const nextScope =
      actualChangedPaths.length > 0
        ? mergeScope(scope, {
            runId: request.runId,
            taskId: request.taskId,
            paths: actualChangedPaths,
            root: executionDir,
            now: this.now().toISOString(),
          })
        : scope;
    const check: CheckFile = {
      schemaVersion: 1,
      taskId: request.taskId,
      runId: request.runId,
      branch: request.expected.branch,
      verdict,
      report,
      ...(actualChangedPaths.length > 0 ? { changedPaths: actualChangedPaths } : {}),
      ...(report.selfVerified !== undefined ? { selfVerified: report.selfVerified } : {}),
      inputsDigest: inputs.inputsDigest,
      standardsDigest: inputs.standardsDigest,
      effectiveInputsDigest: inputs.effectiveInputsDigest,
      scopeDigest: nextScope.digest,
      recordedAt: this.now().toISOString(),
    };

    let nextBinding: TaskBinding = {
      ...binding,
      lastRunIds: appendUnique(binding.lastRunIds, request.runId),
      lastCheckRunId: request.runId,
      stageVisits: next.visits,
      ...(nextScope.digest !== scope.digest
        ? { scope: nextScope.entries, scopeRunIds: nextScope.runIds }
        : {}),
    };
    if (verdict === "changes_requested") {
      if (nextBinding.repairCycleId === null) {
        nextBinding = { ...nextBinding, stopReason: "repair_not_authorized" };
      } else {
        const maxRounds = this.maxRounds(executionDir);
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
    const target: AcceptanceState = { status: next.status, stage: next.stage, outcome: next.outcome };
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
      scopeAfter: nextScope,
      check,
      reason: `check_${verdict}`,
      verdict,
      createdAt: this.now().toISOString(),
    };
    runs.writeAcceptanceJournal(request.runId, journal);
    return this.applyJournal(root, executionDir, routeState, runs, request, result, journal);
  }

  /**
   * 按检查点幂等收敛。任何当前事实偏离来源或目标都转为 needs_attention 并保留检查点；
   * 不覆盖后来 Task 变更，不把部分写入当成功。
   */
  private async applyJournal(
    root: string,
    executionDir: string,
    routeState: "main" | "worktree",
    runs: RunStore,
    request: RunRequestFile,
    result: RunResultFile,
    journal: AcceptanceJournal,
  ): Promise<AcceptanceResult> {
    // 接收写 Task／binding 前加任务短锁：与草案保存／撤回互斥，不丢失草案、不覆盖 task.md（任务029）。
    const taskLock = await this.locks.acquire({
      keys: [{ scope: "task", rawKey: `${root}::${request.taskId}` }],
      action: "run.accept.stage",
    });
    try {
    return await this.applyJournalLocked(root, executionDir, routeState, runs, request, result, journal);
    } finally {
      this.locks.release(taskLock);
    }
  }

  private async applyJournalLocked(
    root: string,
    executionDir: string,
    routeState: "main" | "worktree",
    runs: RunStore,
    request: RunRequestFile,
    result: RunResultFile,
    journal: AcceptanceJournal,
  ): Promise<AcceptanceResult> {
    try {
      const located = locateTaskDocument(executionDir, request.taskId);
      if (located.archived) return this.attention(journal.operationId, request, "task_archived", result);
      const document = located.document;
      if (routeState !== "worktree" && document.frontmatter.branch !== request.expected.branch) {
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
        phase: journal.target.stage,
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
    transition: { status: TaskFacts["status"]; stage: TaskFacts["stage"]; outcome: TaskFacts["outcome"] },
    binding: TaskBinding,
  ): { document: ReturnType<typeof parseTaskDocument>; binding: TaskBinding } {
    const before = readWithVersion(file);
    if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
    const latest = parseTaskDocument(before.data.toString("utf8"), file);
    if (latest.frontmatter.stage !== document.frontmatter.stage || latest.frontmatter.status !== document.frontmatter.status) {
      throw new InfrastructureError("version_conflict", "接收期间 Task 阶段已变化");
    }
    const updated = {
      ...latest,
      frontmatter: {
        ...latest.frontmatter,
        status: transition.status,
        stage: transition.stage,
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
    stage: document.frontmatter.stage,
    outcome: document.frontmatter.outcome,
  };
}

function sameState(a: AcceptanceState, b: AcceptanceState): boolean {
  return a.status === b.status && a.stage === b.stage && a.outcome === b.outcome;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}
