/**
 * run 结果接收（DESIGN.md 5.6、ARCHITECTURE.md 第5节）。
 * 只按固定 acceptanceOperationId 复核 request/result/inputs/scope 后写 Task／binding；
 * 模型报告不直接改 Task，结果文件写入失败也不发布完成。
 */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CheckFile,
  RunRequestFile,
  RunResultFile,
  ScopeFile,
  StageReport,
} from "../contracts/run.js";
import type { ContextPlan } from "../contracts/context-plan.js";
import type { AcceptanceJournal, AcceptanceState } from "../contracts/acceptance.js";
import type { TaskBinding } from "../contracts/metadata.js";
import { parseTaskDocument, renderTaskDocument } from "./task-document.js";
import { inputsDigestOf } from "../contracts/task-inputs.js";
import { locateTaskDocument } from "./task-service.js";
import { entryDrifts, loadScope, mergeScope, scopeEntriesCurrent } from "./scope.js";
import { currentBranch } from "./delivery.js";
import { executionRouteOf, mainRootOf } from "./worktree-routing.js";
import { ContextPlanner } from "./context-planner.js";
import { workflowOf, workflowStageOf } from "./workflow.js";
import {
  isDecisionStage,
  reportBoolean,
  reportCoverageOf,
  reportString,
  reportVerdictOf,
  validateReportForStage,
} from "../domain/report.js";
import type { WorkflowStage } from "../domain/workflow.js";
import { parseConfig, defaultConfig, type ProjectConfig } from "./config.js";
import { isTransitionRefusal, transition, type TaskFacts } from "../domain/task.js";
import { repairDecision } from "../domain/repair.js";
import { stageMayWrite, writeWithoutCapabilityReason } from "../domain/attribution.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { sha256Bytes } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { RunStore } from "../infrastructure/run-store.js";
import { isCredentialIntegrityError } from "../infrastructure/credential-seal.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { GuardError } from "./guard-error.js";
import { consumeResidue, recordResidue, residueFromResult } from "./residue.js";

/** 接收取任务＋state 短锁的最长等待：worker 收尾不应因主会话短写失败。 */
const ACCEPT_LOCK_WAIT_MS = 5_000;

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

/** `run accept --include/--exclude`：主会话对来源不明路径的确认。 */
export interface AttributionDecision {
  include: string[];
  exclude: string[];
  /** 确认人：CLI 缺省 `cli`，桥接传主会话身份。 */
  confirmedBy: string;
  reason: string | null;
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
   * 接收结果：取任务＋state 短锁（键为主检出根），不取工作树租约，
   * 因此 worker 持租约时可直接接收，外部 run accept 也不被其它执行目录的占用阻塞。
   * 返回 accepted=false 时 operation 置 needs_attention，保留现场供人工核对。
   */
  async accept(input: { dir: string; runId: string; decision?: AttributionDecision }): Promise<AcceptanceResult> {
    const root = normalizeRoot(input.dir);
    const runs = new RunStore(root);
    const request = runs.readRequest(input.runId);
    if (request === null) throw new InfrastructureError("io_error", `run 不存在: ${input.runId}`);
    const decision = input.decision !== undefined && (input.decision.include.length > 0 || input.decision.exclude.length > 0)
      ? input.decision
      : null;
    let result = null;
    try {
      result = runs.readResult(input.runId);
    } catch {
      result = null;
    }
    const operationId = request.acceptanceOperationId;
    const operation = await this.store.operations.get(operationId);
    if (operation?.state === "completed" && decision !== null) {
      throw new GuardError("already_accepted", `run 已完成接收，确认不再生效: ${request.runId}`);
    }
    if (operation?.state === "completed") {
      if (result?.state === "completed") this.reconcileState(runs, request);
      const journalStage = intactJournal(runs, request.runId)?.target.stage;
      runs.removeAcceptanceJournal(request.runId);
      return {
        runId: request.runId,
        accepted: true,
        duplicate: true,
        reason: operation.reason ?? null,
        operationId,
        phase: acceptedPhase(root, request, journalStage),
        verdict: result?.report ? reportString(result.report, "verdict") : null,
      };
    }
    if (result === null) {
      await this.store.operations.save({ operationId, kind: "run.acceptance", state: "needs_attention", reason: "result_missing", recordedAt: this.now().toISOString() });
      return { runId: request.runId, accepted: false, duplicate: false, reason: "result_missing", operationId, phase: request.phase, verdict: null };
    }
    if (result.acceptanceOperationId !== operationId) {
      throw new InfrastructureError("version_conflict", "result 的 acceptanceOperationId 与 request 不一致");
    }

    const lock = await this.locks.acquireShort({
      keys: orderKeys([
        { scope: "task", rawKey: `${root}::${request.taskId}` },
        { scope: "state", rawKey: mainRootOf(root) },
      ]),
      action: "run.accept",
    }, ACCEPT_LOCK_WAIT_MS);
    try {
      // 锁内重读结果与操作：等待期间结果可能才落盘，也可能已被别的接收者完成。
      try {
        result = runs.readResult(input.runId);
      } catch {
        result = null;
      }
      const currentOperation = await this.store.operations.get(operationId);
      if (currentOperation?.state === "completed" && decision !== null) {
        throw new GuardError("already_accepted", `run 已完成接收，确认不再生效: ${request.runId}`);
      }
      if (currentOperation?.state === "completed") {
        if (result?.state === "completed") this.reconcileState(runs, request);
        return {
          runId: request.runId,
          accepted: true,
          duplicate: true,
          reason: currentOperation.reason ?? null,
          operationId,
          phase: acceptedPhase(root, request, intactJournal(runs, request.runId)?.target.stage),
          verdict: result?.report ? reportString(result.report, "verdict") : null,
        };
      }
      if (result === null) {
        await this.attention(operationId, request, "result_missing", null);
        return { runId: request.runId, accepted: false, duplicate: false, reason: "result_missing", operationId, phase: request.phase, verdict: null };
      }
      if (result.acceptanceOperationId !== operationId) {
        throw new InfrastructureError("version_conflict", "result 的 acceptanceOperationId 与 request 不一致");
      }
      // 结果完整性：结果在 run 自有目录，阶段内抢先写入的伪造结果没有本机签名，不接收。
      const integrity = runs.verifyResult(request.runId);
      if (integrity === "credential_tampered" || integrity === "credential_unsigned") {
        return await this.attention(operationId, request, integrity, result);
      }
      // 主会话确认在锁内落盘：与接收互斥，确认与本次接收看到同一份事实；非完成结果在此拒绝。
      if (decision !== null) this.recordDecision(runs, request, decision);
      if (result.state !== "completed") {
        // 失败／取消 run 的实际改动记为任务残留（不进 scope）；下一轮报告列出即声明继承（STATES §8）。
        recordResidue(runs, request.taskId, residueFromResult(result), this.now().toISOString());
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
          verdict: result.report ? reportString(result.report, "verdict") : null,
        };
      }
      const accepted = await this.acceptStage(root, runs, request, result, operationId);
      if (accepted.accepted) this.reconcileState(runs, request);
      else if (accepted.reason === "stale_input") this.settleStale(runs, request);
      return accepted;
    } finally {
      this.locks.release(lock);
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

    const plan = await new ContextPlanner({ store: this.store, now: this.now, randomHex: this.randomHex }).plan({
      dir: executionDir,
      taskId: request.taskId,
      stage: request.phase,
      // 授权规范成果以冻结旧版本参与输入身份；新内容按成果核查（任务037）。
      authorizedStandardPaths: (request.expected.authorizedStandardOutputs ?? []).map((output) => output.path),
      authorizedStandardContents: request.expected.authorizedStandardOutputs ?? [],
      // prepare 冻结的阶段定义：配置降级不改变本 run 的提示词与输入身份。
      stageDefinition: request.stageDefinition,
      // 旧请求没有冻结字段：config 在途 run 保留旧提示词，降级后的新 run 不套提示词。
      keepLegacyStagePrompt: request.workflowMode !== "fallback",
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
    if (request.expected.branch !== null) {
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
        const journal = intactJournal(runs, request.runId);
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
    return await this.acceptStageLocked(root, executionDir, route.state, runs, request, result, operationId, located, document, binding, inputs, plan, facts, scope, report);
  }

  /** 调用方（accept）持任务＋state 短锁：与草案保存／撤回和输入更新互斥。 */
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
    // 检查点带本机 HMAC：阶段内预写或篡改的检查点不按记录收敛（否则会把伪造检查写成凭据）。
    let existingJournal: AcceptanceJournal | null;
    try {
      existingJournal = runs.readAcceptanceJournal(request.runId);
    } catch (error) {
      if (isCredentialIntegrityError(error)) return this.attention(operationId, request, error.guardReason, result);
      throw error;
    }
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
    // prepare 冻结的阶段定义优先：配置在途降级时仍按本 run 的声明校验报告、判断结论与产出。
    // 只有旧请求（无冻结字段）才退回当前流程／旧固定字段兼容。
    const stage = workflowStageOf(workflow, request.phase);
    const effectiveStage =
      request.stageDefinition ?? stage ?? (workflow.stages.length === 0 ? legacyStageOf(request.phase) : null);
    if (effectiveStage === null && workflow.stages.length > 0) {
      return this.attention(operationId, request, "stage_not_in_workflow", result);
    }
    const decision = request.stageDefinition?.decision ?? isDecisionStage(effectiveStage);
    const actualChangedPaths = [...new Set(result.actualChangedPaths.map(normalizePath))].sort();
    // 来源归属（DESIGN §5.3）：新结果按 worker 已核对的 claimedPaths 接收，旧结果仍按“报告＝实际差异”。
    const attribution = result.attribution?.claimedPaths !== undefined ? result.attribution : null;
    const validation = attribution === null
      ? validateReportForStage(effectiveStage, report, actualChangedPaths)
      : validateReportForStage(effectiveStage, report, [], { comparePaths: false });
    if (!validation.ok) {
      return this.attention(operationId, request, validation.reason ?? "report_invalid", result);
    }
    let mergePaths = actualChangedPaths;
    /** 主会话确认并入的来源不明路径：按当前指纹并入，不核发布时指纹。 */
    let confirmedPaths = new Set<string>();
    let residueConsumed: string[] = [];
    if (attribution !== null) {
      const unattributed = attribution.unattributedPaths ?? [];
      const confirmation = unattributed.length > 0 ? runs.readAttributionConfirmation(request.runId) : null;
      const included = new Set(confirmation?.include ?? []);
      const excluded = new Set(confirmation?.exclude ?? []);
      const pending = unattributed.filter((path) => !included.has(path) && !excluded.has(path));
      if (pending.length > 0) {
        return this.attention(operationId, request, `unattributed_paths:${pending.join(",")}`, result);
      }
      confirmedPaths = new Set(unattributed.filter((path) => included.has(path)));
      mergePaths = [...new Set([
        ...(attribution.attributedPaths ?? []),
        ...(attribution.inheritedPaths ?? []),
        ...confirmedPaths,
      ])].sort();
      const residuePaths = new Set((runs.readResidue(request.taskId)?.entries ?? []).map((entry) => entry.path));
      residueConsumed = [...new Set([...mergePaths, ...unattributed.filter((path) => excluded.has(path))])]
        .filter((path) => residuePaths.has(path))
        .sort();
    }
    const mergeSet = new Set(mergePaths);
    const actualSet = mergeSet;
    // 能力与实际不符的接收侧兜底：未声明 write 的阶段不并入任何本 run 改动（worker 收尾已判 failed；
    // 旧结果或外部写入的结果在此拦住）。外部改动不算本 run 写入。
    if (!stageMayWrite(request.toolPolicy)) {
      const external = new Set((result.externalChanges ?? []).map(normalizePath));
      const written = attribution === null
        ? actualChangedPaths.filter((path) => !external.has(path))
        : [...new Set([...(attribution.attributedPaths ?? []), ...(attribution.unattributedPaths ?? []), ...(attribution.inheritedPaths ?? [])])].sort();
      if (written.length > 0) return this.attention(operationId, request, writeWithoutCapabilityReason(written), result);
    }
    // 发布时指纹只核对要并入的路径；外部改动与被排除的路径不属本任务，不因其后续变化拒收。
    const driftEntries = (result.actualEntries ?? []).filter(
      (entry) => attribution === null || (mergeSet.has(normalizePath(entry.path)) && !confirmedPaths.has(normalizePath(entry.path))),
    );

    if (!decision) {
      const next = transition(workflow, facts, { kind: "implementationAccepted" });
      if (isTransitionRefusal(next)) {
        if (next.stopReason !== undefined) {
          await this.store.bindings.save({ ...binding, stopReason: next.stopReason });
        }
        return this.attention(operationId, request, next.reason, result);
      }
      // 接收前按当前事实重核发布时指纹：路径、类型、模式和内容，检查窗口的改动不接收（STATES.md 第8节，任务027）。
      for (const entry of driftEntries) {
        if (entryDrifts(executionDir, entry)) return this.attention(operationId, request, "scope_changed", result);
      }
      const nextScope = mergeScope(scope, {
        runId: request.runId,
        taskId: request.taskId,
        paths: mergePaths,
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
        ...(residueConsumed.length > 0 ? { residueConsumed } : {}),
        createdAt: this.now().toISOString(),
      };
      runs.writeAcceptanceJournal(request.runId, journal);
      return this.applyJournal(root, executionDir, routeState, runs, request, result, journal);
    }

    // 结论阶段：枚举值决定 onVerdict 跳转；未命中走配置顺序下一阶段。
    const verdict = reportVerdictOf(effectiveStage, report);
    if (verdict === null) return this.attention(operationId, request, "report_verdict_missing", result);
    const coverageDeclared =
      effectiveStage !== null && Object.prototype.hasOwnProperty.call(effectiveStage.report, "coverage");
    if (coverageDeclared) {
      const coverage = (reportCoverageOf(effectiveStage, report) ?? []).map(normalizePath);
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
      if (uncovered.length > 0) {
        return this.attention(operationId, request, `check_scope_incomplete:${uncovered.join(",")}`, result);
      }
    }
    const next = transition(workflow, facts, { kind: "stageAccepted", verdict });
    if (isTransitionRefusal(next)) {
      if (next.stopReason !== undefined) {
        await this.store.bindings.save({ ...binding, stopReason: next.stopReason });
      }
      return this.attention(operationId, request, next.reason, result);
    }

    // 检查者可在既定范围内修复；先重核发布时指纹，再允许已声明路径变化。
    // 未被检查修改的既有 scope 路径仍须与当前事实一致，外部改动转 scope_changed（STATES.md 第8节）。
    for (const entry of driftEntries) {
      if (entryDrifts(executionDir, entry)) return this.attention(operationId, request, "scope_changed", result);
    }
    const untouched = scope.entries.filter((entry) => !actualSet.has(normalizePath(entry.path)));
    if (!scopeEntriesCurrent(executionDir, untouched)) {
      return this.attention(operationId, request, "scope_changed", result);
    }
    // 检查者有实际修改时并入 scope；append 语义保留既有条目与历史 run。
    // 即使结论为 changes_requested，落盘修复仍是真实成果，不能让后续检查看到过期指纹。
    const nextScope =
      mergePaths.length > 0
        ? mergeScope(scope, {
            runId: request.runId,
            taskId: request.taskId,
            paths: mergePaths,
            root: executionDir,
            now: this.now().toISOString(),
          })
        : scope;
    const selfVerified = reportBoolean(report, "selfVerified");
    // 检查者本人改过并入 scope 的路径：修复部分只算自检，independent 须再派无改动的 pass 检查才可完成。
    const checkerChangedPaths = mergePaths;
    const check: CheckFile = {
      schemaVersion: 1,
      taskId: request.taskId,
      runId: request.runId,
      branch: request.expected.branch,
      verdict,
      report,
      ...(mergePaths.length > 0 ? { changedPaths: mergePaths } : {}),
      ...(selfVerified !== null ? { selfVerified } : {}),
      ...(checkerChangedPaths.length > 0 ? { checkerChangedPaths } : {}),
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
      ...(residueConsumed.length > 0 ? { residueConsumed } : {}),
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

      let existingCheck: CheckFile | null;
      try {
        existingCheck = runs.readCheck(request.runId);
      } catch (error) {
        // 同名检查凭据已存在但签名无效：不覆盖、不采信，交主会话核对。
        if (isCredentialIntegrityError(error)) return this.attention(journal.operationId, request, error.guardReason, result);
        throw error;
      }
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
      // 并入 scope 或被确认排除的残留从任务残留移除；幂等，重入不重复。
      if ((journal.residueConsumed ?? []).length > 0) {
        consumeResidue(runs, request.taskId, journal.residueConsumed ?? [], this.now().toISOString());
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

  /**
   * 记录主会话对来源不明路径的确认（`run accept --include/--exclude`）：路径必须属于该 run 的来源不明集合，
   * 同一路径不能既并入又排除；与已有确认合并（后来决定覆盖），确认人与原因随记录保存。已完成接收的 run 不再改写。
   */
  private recordDecision(runs: RunStore, request: RunRequestFile, decision: AttributionDecision): void {
    const include = [...new Set(decision.include.map(normalizePath))];
    const exclude = [...new Set(decision.exclude.map(normalizePath))];
    const both = include.filter((path) => exclude.includes(path));
    if (both.length > 0) throw new GuardError("invalid_request", `同一路径不能既 --include 又 --exclude: ${both.join(", ")}`);
    let result: RunResultFile | null = null;
    try {
      result = runs.readResult(request.runId);
    } catch {
      result = null;
    }
    if (result === null || result.state !== "completed") {
      throw new GuardError("result_missing", `run 没有可接收的完成结果: ${request.runId}`);
    }
    const unattributed = new Set(result.attribution?.unattributedPaths ?? []);
    const unknown = [...include, ...exclude].filter((path) => !unattributed.has(path));
    if (unknown.length > 0) {
      const listed = [...unattributed].join(", ") || "无";
      throw new GuardError("path_not_unattributed", `不是该 run 来源不明的路径: ${unknown.join(", ")}（来源不明：${listed}）`);
    }
    const previous = runs.readAttributionConfirmation(request.runId);
    const nextInclude = new Set((previous?.include ?? []).filter((path) => !exclude.includes(path)));
    const nextExclude = new Set((previous?.exclude ?? []).filter((path) => !include.includes(path)));
    for (const path of include) nextInclude.add(path);
    for (const path of exclude) nextExclude.add(path);
    runs.writeAttributionConfirmation(request.runId, {
      schemaVersion: 1,
      runId: request.runId,
      taskId: request.taskId,
      include: [...nextInclude].sort(),
      exclude: [...nextExclude].sort(),
      confirmedBy: decision.confirmedBy,
      reason: decision.reason,
      confirmedAt: this.now().toISOString(),
    });
    runs.appendEvent(request.runId, {
      event: "attribution_confirmed",
      include: include.length,
      exclude: exclude.length,
      confirmedBy: decision.confirmedBy,
    });
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
      verdict: result?.report ? reportString(result.report, "verdict") : null,
    };
  }

  /**
   * stale_input 的出口：结果已发布、输入已变，这个 run 不会再推进任务；未终态时收敛为失败，
   * 使任务不再被它占用（update 不再要求 --run，close／新 run 可继续）。结果与工作区不动。
   * 输入改回后重新接收仍可成功，reconcileState 会把 acceptance_ 失败收敛回 completed。
   */
  private settleStale(runs: RunStore, request: RunRequestFile): void {
    const state = runs.readState(request.runId);
    if (state === null || ["completed", "cancelled", "failed"].includes(state.state)) return;
    runs.writeState(request.runId, { ...state, state: "failed", reason: "acceptance_stale_input", updatedAt: this.now().toISOString() });
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

/** 只取完整性有效的接收检查点；篡改或缺签名按不存在处理（调用方另行判定）。 */
function intactJournal(runs: RunStore, runId: string): AcceptanceJournal | null {
  try {
    return runs.readAcceptanceJournal(runId);
  } catch (error) {
    if (isCredentialIntegrityError(error)) return null;
    throw error;
  }
}

/** 降级流程的旧报告字段兼容：只用于没有冻结阶段定义的旧请求，不参与新 run 流转。 */
function legacyStageOf(phase: string): WorkflowStage | null {
  const base: Omit<WorkflowStage, "id" | "name" | "report" | "onVerdict"> = {
    description: null,
    prompt: null,
    tools: null,
    maxVisits: null,
  };
  if (phase === "implement") {
    return {
      ...base,
      id: "implement",
      name: "实现",
      report: { changedPaths: "paths", unverified: "string[]" },
      onVerdict: {},
    };
  }
  if (phase === "check") {
    return {
      ...base,
      id: "check",
      name: "检查",
      report: {
        verdict: ["pass", "changes_requested", "blocked"],
        coverage: "string[]",
        changedPaths: "paths",
        selfVerified: "bool",
        findings: "string[]",
        unverified: "string[]",
      },
      onVerdict: { changes_requested: "implement", blocked: "check" },
    };
  }
  return null;
}

/** 重复接收的读数：优先检查点目标，其次当前 Task 阶段；找不到任务时退回请求阶段。 */
function acceptedPhase(root: string, request: RunRequestFile, journalPhase?: string): string {
  if (journalPhase !== undefined) return journalPhase;
  try {
    return locateTaskDocument(root, request.taskId).document.frontmatter.stage;
  } catch {
    return request.phase;
  }
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
