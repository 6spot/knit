/**
 * deliver／archive 确定性收尾（DESIGN.md 第10–11节、STATES.md 第11节）。
 * 先落盘操作意图与步骤；Git、封存、移动和归档提交分别核验。
 * 模型报告与 worker 报告不参与这里的 Git 事实判断。
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { TaskBinding } from "../contracts/metadata.js";
import type {
  AuthorizationSource,
  DeliveryMessage,
  DeliveryOperation,
  DeliveryRecord,
  DeliveryResult,
  DeliveryStep,
  DeliveryWorktreeFollowUp,
} from "../contracts/delivery.js";
import type { CheckFile } from "../contracts/run.js";
import { PROJECT_SCOPE, type StandardsReview } from "../contracts/standards.js";
import type { OperationState } from "../contracts/metadata.js";
import { isTransitionRefusal, transition, type TaskFacts } from "../domain/task.js";
import { checkerChangedPathsOf, verificationLabel } from "../domain/completion.js";
import { workflowOf } from "./workflow.js";
import { CompletionService } from "./completion-service.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { RunStore } from "../infrastructure/run-store.js";
import { gitSync } from "../infrastructure/process.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { ContextPlanner } from "./context-planner.js";
import { runSettled } from "./run-activity.js";
import { GuardError, readIntact } from "./guard-error.js";
import { loadScope, scopeEntriesCurrent } from "./scope.js";
import { assertNotInStageContext } from "./stage-context.js";
import { inspectSealed, sealedJson } from "../infrastructure/credential-seal.js";
import { validateCheckEvidence } from "./check-validation.js";
import { hasChildTasks, locateTaskDocument, markTaskListArchiveChanged } from "./task-service.js";
import { parseTaskDocument, renderTaskDocument, withRegions } from "./task-document.js";
import { deliveryHooksOf, parseConfig, defaultConfig, worktreeSettingsOf, type ProjectConfig } from "./config.js";
import { scanCredentials } from "../contracts/credentials.js";
import { WorktreeMergeService } from "./worktree-merge.js";
import { WorktreeCleanupService } from "./worktree-cleanup.js";
import { worktreeSignature, type WorktreeSignature } from "./worktree.js";
import {
  branchExists,
  commitExists,
  commitMessage,
  commitPaths,
  commitSubject,
  composeCommitMessage,
  currentBranch,
  defaultBranchCandidate,
  dirtyPaths,
  gitOrThrow,
  hookChanges,
  hookIsolatedGit,
  hooksDirOf,
  hooksSnapshot,
  isAncestor,
  indexTreeFor,
  isFullBranch,
  isStageCommit,
  policyVersion,
  readMessageFile,
  recheckAuthorization,
  resolveAuthorization,
  sameSet,
  selectedPath,
  stagedSnapshot,
  sameTree,
  treeSnapshot,
  truncateMessageSubject,
  type DeliveryStage,
  type GitRunner,
  type HookChange,
  type MessageDraft,
} from "./delivery.js";

const SEAL_MARKER = ".knit-sealed";
/** 交付 hooks 基线：上次交付完成时 hooks 目录的快照（带本机 HMAC）；用于列出此后新增或修改的 hook。 */
const HOOKS_BASELINE = join(".knit", ".runtime", "delivery-hooks.json");
const TASK_FILE = "task.md";
const RUNTIME_PREFIX = ".knit/.runtime";

/** 归档提交范围：原任务目录整体，使同目录 plan.md／research 等材料移动后的旧路径删除一并进入提交。 */
function archiveScope(taskPath: string): string {
  const normalized = taskPath.startsWith(".knit/") ? taskPath : `.knit/${taskPath}`;
  return dirname(normalized.split("\\").join("/"));
}

export interface DeliveryInput {
  dir: string;
  taskId: string;
  branch: string;
  authorizationRef?: string | null;
  caller?: "cli" | "agent";
  /** 产物提交文案文件；metadata／archive 不接受文案。 */
  messageFile?: string | null;
  /** 显式重试 needs_attention：先核验已完成效果，不盲目重复提交。 */
  retry?: boolean;
  /** 显式授权本次交付先合入已绑定 worktree；缺省按 delivery.mode 配置。 */
  merge?: boolean;
  /** 显式授权交付后清理 worktree；缺省按 worktree.cleanup 配置。 */
  cleanup?: boolean;
  /**
   * 桥接传入的本会话原生记录：`user:` 授权引用须在其中匹配真实存在的用户消息（按条目 ID 或 sha256 摘要），
   * 否则 authorization_unverified。缺省为直接 CLI 调用，回执标 `caller: cli-unverified`。
   */
  sessionFile?: string | null;
}

/** 交付提交的 hooks 处理与自上次交付以来的 hook 变化（只列出，不阻塞）。 */
export interface DeliveryHooksReport {
  mode: "skip" | "run";
  /** 实际生效的 hooks 目录（含 core.hooksPath）；读取失败为 null。 */
  dir: string | null;
  /** 基线：recorded＝有上次交付快照；none＝尚无；invalid＝签名无效（按无基线列出全部 hook）。 */
  baseline: "recorded" | "none" | "invalid";
  changes: HookChange[];
}

export interface DeliveryPlanMessage {
  source: "agent" | "template";
  subject: string;
  bodyLines: number;
}

export interface DeliveryPlanItem {
  taskId: string;
  taskPath: string;
  artifacts: string[];
  metadata: string[];
  /** 已在 index 中有内容的业务路径；当前实现不能可靠拆分，先报告冲突。 */
  stagedArtifacts: string[];
  /** 用户已暂存且不属于本操作可核实检查点的任务资料。 */
  stagedMetadata: string[];
  status: "ready" | "conflict";
  reason: string | null;
  /** 产物提交文案预览：主会话文案或模板兜底。 */
  message: DeliveryPlanMessage;
  /** 本任务各 run 记录的外部改动与被确认排除的路径（不在 scope、不进产物提交），仅提醒。 */
  externalChanges: string[];
  /** 未处理的失败残留（任务级，不在 scope、不进产物提交），仅提醒。 */
  residue: string[];
}

export interface DeliveryPlan {
  branch: string;
  /** 交付提交的 hooks 策略与自上次交付以来新增或修改的 hook。 */
  hooks: DeliveryHooksReport;
  tasks: DeliveryPlanItem[];
  conflicts: Array<{ path: string; taskIds: string[] }>;
  readOnly: true;
}

export interface DeliveryServiceOptions {
  store: MetadataStore;
  locks?: LockManager;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  git?: GitRunner;
}

interface Prepared {
  root: string;
  taskDir: string;
  taskPath: string;
  taskRelative: string;
  document: ReturnType<typeof parseTaskDocument>;
  binding: TaskBinding;
  config: ProjectConfig;
  branch: string;
  check: CheckFile | null;
  /** 旧操作合并提交范围；新操作按 artifacts／metadata 分开。 */
  selected: string[];
  artifacts: string[];
  metadata: string[];
  defaultBranch: DeliveryResult["defaultBranch"];
  authorization: AuthorizationSource;
  policyVersion: string;
  /** 本次调用已校验的主会话文案；已有持久化文案时忽略新文件。 */
  messageDraft: MessageDraft | null;
  messageIgnored: boolean;
  /** Knit 发起 commit 用的 Git 执行器：delivery.hooks=skip 时带 `-c core.hooksPath=<空目录>`。 */
  commitGit: GitRunner;
}

interface MessageInput {
  draft: MessageDraft | null;
  ignored: boolean;
}

export class DeliveryService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;
  private readonly git: GitRunner;

  constructor(options: DeliveryServiceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
    this.git = options.git ?? gitSync;
  }

  async deliver(input: DeliveryInput): Promise<DeliveryResult> {
    return this.run({ ...input, mode: "deliver" });
  }

  async archive(input: DeliveryInput): Promise<DeliveryResult> {
    return this.run({ ...input, mode: "archive" });
  }

  /** 只读预检：分类、跨任务同路径冲突和已暂存业务路径；不创建操作、不写 Git。 */
  async plan(inputs: DeliveryInput[]): Promise<DeliveryPlan> {
    if (inputs.length === 0) throw new GuardError("task_required", "至少需要一个任务 ID");
    const root = normalizeRoot(inputs[0]?.dir ?? "");
    const config = this.readConfig(root);
    // hooks 报告在隔离范围外取：范围内 --git-path hooks 会解析到私有空目录。
    const hooks = this.hooksReport(root, config);
    // CLI deliver 先跑预检；其中 diff 等读取会刷新 index 触发 post-index-change，同样按 delivery.hooks 隔离。
    const isolation = hookIsolatedGit(deliveryHooksOf(config));
    try {
      return { ...(await isolation.scope(() => this.planInScope(inputs))), hooks };
    } finally {
      isolation.dispose();
    }
  }

  private async planInScope(inputs: DeliveryInput[]): Promise<Omit<DeliveryPlan, "hooks">> {
    const branch = inputs[0]?.branch ?? "";
    for (const input of inputs) {
      if (input.branch !== branch) throw new GuardError("branch_mismatch", "批量收尾的任务必须使用同一分支");
    }
    const root = normalizeRoot(inputs[0]?.dir ?? "");
    const tasks: DeliveryPlanItem[] = [];
    for (const input of inputs) {
      const located = locateTaskDocument(root, input.taskId);
      const taskPath = relative(root, join(located.dir, TASK_FILE)).split("\\").join("/");
      const classified = await this.classifyPaths(root, input.taskId, located.dir);
      const stagedResult = this.git(["diff", "--cached", "--name-only", "--", ...classified.artifacts], root);
      if (stagedResult.code !== 0) throw new GuardError("git_failed", `读取暂存状态失败: ${stagedResult.stderr.trim()}`);
      const staged = new Set(stagedResult.stdout.split(/\r?\n/).filter(Boolean));
      const stagedArtifacts = classified.artifacts.filter((path) => staged.has(path));
      const operation = await this.latestOperation(root, input.taskId);
      const stagedMetadata = this.metadataStagedConflicts(root, classified.metadata, operation);
      const hasStagedConflict = stagedArtifacts.length > 0 || stagedMetadata.length > 0;
      tasks.push({
        taskId: input.taskId,
        taskPath,
        artifacts: classified.artifacts,
        metadata: classified.metadata,
        stagedArtifacts,
        stagedMetadata,
        status: hasStagedConflict ? "conflict" : "ready",
        reason: hasStagedConflict ? "preexisting_staged" : null,
        message: this.planMessage(located.document, input.taskId, input.messageFile),
        ...this.outsideScopeReminders(root, input.taskId, classified.artifacts),
      });
    }
    const owners = new Map<string, string[]>();
    for (const task of tasks) {
      for (const path of [...task.artifacts, ...task.metadata]) {
        owners.set(path, [...(owners.get(path) ?? []), task.taskId]);
      }
    }
    const conflicts = [...owners.entries()]
      .filter(([, taskIds]) => taskIds.length > 1)
      .map(([path, taskIds]) => ({ path, taskIds }));
    const conflicted = new Set(conflicts.flatMap((entry) => entry.taskIds));
    for (const task of tasks) {
      if (conflicted.has(task.taskId)) {
        task.status = "conflict";
        task.reason = task.reason ?? "path_shared_by_tasks";
      }
    }
    return { branch, tasks, conflicts, readOnly: true };
  }

  private async run(input: DeliveryInput & { mode: "deliver" | "archive" }): Promise<DeliveryResult> {
    assertNotInStageContext(input.mode);
    const root = normalizeRoot(input.dir);
    // hook 变化在交付前取：本次提交前列出自上次交付以来新增或修改的 hook。
    const config = this.readConfig(root);
    const hooks = this.hooksReport(root, config);
    // delivery.hooks=skip（缺省）：整个操作（合入、add／commit／reset、封存归档与交付后清理）在隔离范围内运行，
    // 本进程发起的全部 Git 调用都带 core.hooksPath=<私有空目录>，post-index-change 等 hook 同样不执行。
    const isolation = hookIsolatedGit(deliveryHooksOf(config));
    let result: DeliveryResult;
    try {
      result = await isolation.scope(() => this.runOperation(input));
    } finally {
      isolation.dispose();
    }
    if (result.state === "completed") this.recordHooksBaseline(root);
    return { ...this.withArtifactNotice(root, result), hooks };
  }

  /** 交付 hooks 报告：策略、生效目录与自上次交付基线以来新增／修改的 hook。 */
  private hooksReport(root: string, config: ProjectConfig): DeliveryHooksReport {
    const dir = hooksDirOf(root, this.git);
    const current = hooksSnapshot(dir);
    const baseline = this.readHooksBaseline(root);
    return {
      mode: deliveryHooksOf(config),
      dir,
      baseline: baseline.state,
      changes: hookChanges(baseline.hooks, current),
    };
  }

  private readHooksBaseline(root: string): { state: "recorded" | "none" | "invalid"; hooks: Record<string, string> | null } {
    const path = join(root, HOOKS_BASELINE);
    const version = readWithVersion(path);
    if (version === null) return { state: "none", hooks: null };
    try {
      const inspected = inspectSealed(root, "delivery-hooks", "baseline", JSON.parse(version.data.toString("utf8")));
      const hooks = (inspected.payload as { hooks?: unknown } | null)?.hooks;
      if (inspected.verdict !== "valid" || hooks === null || typeof hooks !== "object") return { state: "invalid", hooks: null };
      return { state: "recorded", hooks: hooks as Record<string, string> };
    } catch {
      return { state: "invalid", hooks: null };
    }
  }

  /** 交付完成后记录 hooks 基线；写入失败不否定已完成的交付。 */
  private recordHooksBaseline(root: string): void {
    try {
      const dir = hooksDirOf(root, this.git);
      const payload = { schemaVersion: 1, hooksDir: dir, hooks: hooksSnapshot(dir), recordedAt: this.now().toISOString() };
      const path = join(root, HOOKS_BASELINE);
      atomicWrite({ path, data: sealedJson(root, "delivery-hooks", "baseline", payload), expectedSha256: readWithVersion(path)?.sha256 ?? null, mode: 0o600 });
    } catch {
      // 基线缺失只会让下次多列出 hook，不影响交付事实。
    }
  }

  /**
   * 无产物提交的交付结果（审计 F4）：正常交付完成而 workCommit 为空时标 noArtifactCommit，
   * 并附完成凭据中的原因；声明无产物与“成果路径没有待提交改动”分开描述。
   */
  private withArtifactNotice(root: string, result: DeliveryResult): DeliveryResult {
    const noArtifactCommit = result.mode === "deliver" && result.state === "completed" && result.workCommit === null;
    if (!noArtifactCommit) return { ...result, noArtifactCommit: false, noArtifactReason: null, noArtifactNotice: null };
    const completion = new RunStore(root).readCompletionIfIntact(result.taskId);
    const declared = completion?.artifacts === "none";
    const reason = (declared ? completion?.noArtifactsReason : null) ??
      (completion?.forced === true ? completion.forcedReason : null) ??
      completion?.reason ??
      null;
    const basis = declared
      ? `完成时声明无产物：${reason ?? "未记录原因"}`
      : `${new CompletionService({ store: this.store, now: this.now }).scopeEmpty(root, result.taskId) ? "未登记成果路径" : "成果路径没有待提交改动"}；完成原因：${reason ?? "未记录"}`;
    return { ...result, noArtifactCommit: true, noArtifactReason: reason, noArtifactNotice: `本次交付没有产物提交（${basis}）` };
  }

  private async runOperation(input: DeliveryInput & { mode: "deliver" | "archive" }): Promise<DeliveryResult> {
    const root = normalizeRoot(input.dir);
    const caller = input.caller ?? "cli";
    const config = this.readConfig(root);
    const existing = await this.latestOperation(root, input.taskId);
    if (existing?.state === "completed") {
      return await this.cleanupAfterDelivery(root, input, config, this.resultOf(existing, true));
    }
    if (existing?.state === "needs_attention" && input.retry !== true) {
      return this.resultOf(existing, false);
    }
    if (existing !== null && existing.mode !== input.mode) {
      // deliver 未完成时 archive 继续同一操作；archive 未完成时 deliver 不另起。
      if (!(existing.mode === "deliver" && input.mode === "archive")) {
        throw new GuardError("operation_conflict", `已有未完成的 ${existing.mode} 操作: ${existing.operationId}`);
      }
    }

    // 合入必须先于交付提交：worktree 路由下任务资料在主检出缺席，且 merge 拒绝已归档任务。
    // 失败在这里直接返回原因，尚未创建交付操作、未写提交。
    const followUp = existing === null ? await this.mergeBeforeDelivery(root, input, config, caller) : null;

    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: input.mode === "deliver" ? "delivery.deliver" : "delivery.archive",
    });
    let result: DeliveryResult | null = null;
    try {
      const latest = await this.latestOperation(root, input.taskId);
      if (latest?.state === "completed") {
        result = this.resultOf(latest, true);
      } else if (latest?.state === "needs_attention" && input.retry !== true) {
        result = this.resultOf(latest, false);
      } else {
        const located = locateTaskDocument(root, input.taskId);
        const classified = await this.classifyPaths(root, input.taskId, located.dir);
        const stagedMetadata = this.metadataStagedConflicts(root, classified.metadata, latest);
        if (stagedMetadata.length > 0) {
          throw new GuardError("preexisting_staged", `任务资料已有用户暂存内容，请先整理index: ${stagedMetadata.join(", ")}`);
        }
        const messageInput = this.messageInputFor(input, latest);
        const operation = latest ?? (await this.createOperation(root, input, caller, messageInput.draft, followUp ?? undefined));
        recheckAuthorization(root, operation.authorization, caller);
        // Knit 发起的提交按 delivery.hooks 隔离用户 hooks：skip（缺省）用私有空目录作 core.hooksPath。
        const isolation = hookIsolatedGit(deliveryHooksOf(config), this.git);
        try {
          const prepared = await this.prepare(root, input, operation, caller, messageInput, isolation.git);
          result = await this.execute(prepared, operation);
        } finally {
          isolation.dispose();
        }
      }
    } finally {
      this.locks.release(lock);
    }
    if (result === null) throw new GuardError("invalid_request", "交付未产生结果");
    return await this.cleanupAfterDelivery(root, input, config, result);
  }

  /** 项目配置中的合入／清理授权引用；记录相对路径与配置内容摘要。 */
  private configAuthorizationRef(root: string): string {
    const path = join(root, ".knit", "config.json");
    const digest = existsSync(path) ? sha256Bytes(readFileSync(path)) : sha256Text(JSON.stringify(defaultConfig()));
    return `config:.knit/config.json@${digest}`;
  }

  /**
   * 交付前的 worktree 串联合入：按 delivery.mode 或显式 --merge 执行既有 merge 步骤。
   * 无 worktree 时合入服务返回 noop 并说明；未授权合入但任务仍在 worktree 时拒绝交付。
   */
  private async mergeBeforeDelivery(
    root: string,
    input: DeliveryInput & { mode: "deliver" | "archive" },
    config: ProjectConfig,
    caller: "cli" | "agent",
  ): Promise<DeliveryWorktreeFollowUp | null> {
    if (input.mode !== "deliver") return null;
    const settings = worktreeSettingsOf(config);
    const info = (await this.store.bindings.get(input.taskId))?.worktree;
    const explicitMerge = input.merge === true;
    const mergeRequested = explicitMerge || settings.deliveryMode === "merge";
    const cleanupRequested = info !== undefined && (input.cleanup === true || settings.cleanup === "after-merge");
    if (explicitMerge && (input.authorizationRef ?? "").trim() === "") {
      throw new GuardError("authorization_required", "显式合入需要非空 --authorization-ref");
    }
    if (input.cleanup === true && (input.authorizationRef ?? "").trim() === "") {
      throw new GuardError("authorization_required", "显式清理需要非空 --authorization-ref");
    }
    if (!mergeRequested) {
      if (info?.active === true) {
        throw new GuardError(
          "worktree_merge_required",
          "任务资料仍在 worktree；配置 delivery.mode=merge 或显式授权合入后再交付（合入必须先于归档）",
        );
      }
      if (info !== undefined) {
        return {
          merge: { status: "noop", reason: "worktree 已转交，无需再次合入", opId: null, commit: null },
          cleanup: cleanupRequested ? undefined : { status: "manual", reason: "未授权清理，保留 worktree", opId: null },
          pending: ["cleanup"],
        };
      }
      return null;
    }
    const authorizationRef = explicitMerge ? input.authorizationRef! : this.configAuthorizationRef(root);
    const merged = await new WorktreeMergeService({ store: this.store, locks: this.locks, now: this.now }).merge({
      dir: root,
      taskId: input.taskId,
      into: input.branch,
      apply: true,
      authorizationRef,
      caller,
    });
    if (merged.status !== "merged" && merged.status !== "noop") {
      throw new GuardError(
        "worktree_merge_blocked",
        `worktree 合入未完成（${merged.status}）：${merged.reason ?? "未知原因"}；未创建交付操作，现场保留`,
      );
    }
    return {
      merge: {
        status: merged.status,
        reason: merged.reason,
        opId: merged.opId,
        commit: merged.mergeCommit,
      },
      cleanup: cleanupRequested || info === undefined
        ? undefined
        : { status: "manual", reason: "未授权清理，保留 worktree", opId: null },
      pending: info === undefined ? [] : ["cleanup"],
    };
  }

  /**
   * 交付成功后的清理：仅 delivery.mode=merge／after-merge 或显式 --cleanup 授权时执行；
   * 失败保留 worktree／分支并记录步骤，不冒充已清理。
   */
  private async cleanupAfterDelivery(
    root: string,
    input: DeliveryInput & { mode: "deliver" | "archive" },
    config: ProjectConfig,
    result: DeliveryResult,
  ): Promise<DeliveryResult> {
    if (input.mode !== "deliver" || result.state !== "completed") return result;
    const operation = await this.latestOperation(root, input.taskId);
    if (operation === null) return result;
    const settings = worktreeSettingsOf(config);
    const info = (await this.store.bindings.get(input.taskId))?.worktree;
    const explicit = input.cleanup === true;
    const manuallyPending = operation.worktree?.cleanup?.status === "manual";
    const requested = explicit || (info !== undefined && settings.cleanup === "after-merge") ||
      (!manuallyPending && operation.worktree?.pending.includes("cleanup") === true);
    if (!requested || info === undefined) {
      return { ...result, worktree: operation.worktree ?? result.worktree ?? null };
    }
    const prior = operation.worktree?.cleanup;
    if (prior !== undefined && (prior.status === "removed" || prior.status === "noop")) {
      return this.resultOf(operation, true);
    }
    const authorizationRef = explicit ? input.authorizationRef ?? "" : this.configAuthorizationRef(root);
    if (authorizationRef.trim() === "") {
      throw new GuardError("authorization_required", "显式清理需要非空 --authorization-ref");
    }
    let cleanupStatus = "failed";
    let cleanupReason: string | null = null;
    let cleanupOpId: string | null = null;
    try {
      const cleaned = await new WorktreeCleanupService({ store: this.store, locks: this.locks, now: this.now }).cleanup({
        dir: root,
        taskId: input.taskId,
        apply: true,
        authorizationRef,
        caller: input.caller ?? "cli",
      });
      cleanupStatus = cleaned.status;
      cleanupReason = cleaned.reason;
      cleanupOpId = cleaned.opId;
    } catch (error) {
      cleanupReason = error instanceof Error ? error.message : String(error);
    }
    const ok = cleanupStatus === "removed" || cleanupStatus === "noop";
    const worktree: DeliveryWorktreeFollowUp = {
      merge: operation.worktree?.merge,
      cleanup: { status: cleanupStatus, reason: cleanupReason, opId: cleanupOpId },
      pending: ok ? [] : ["cleanup"],
    };
    const updated: DeliveryOperation = { ...operation, worktree, updatedAt: this.now().toISOString() };
    await this.store.operations.save(updated);
    const next = this.resultOf(updated, true);
    return { ...next, needsAttention: next.needsAttention || !ok };
  }

  /** 只认同一操作在当前HEAD留下的未完成暂存检查点；部分暂存始终保留给用户。 */
  private metadataStagedConflicts(root: string, metadata: string[], operation: DeliveryOperation | null): string[] {
    if (metadata.length === 0) return [];
    const staged = gitOrThrow(root, ["diff", "--cached", "--name-only", "-z", "--", ...metadata], "读取资料暂存状态", this.git)
      .split("\0").filter(Boolean);
    if (staged.length === 0) return [];
    const unstaged = new Set(gitOrThrow(root, ["diff", "--name-only", "-z", "--", ...metadata], "读取资料工作区差异", this.git).split("\0").filter(Boolean));
    const head = gitOrThrow(root, ["rev-parse", "HEAD"], "读取HEAD", this.git);
    const snapshot = stagedSnapshot(root, this.git);
    const tree = indexTreeFor(snapshot, metadata);
    return staged.filter((path) => {
      if (unstaged.has(path) || (snapshot[path] !== undefined && !snapshot[path]!.endsWith(" 0"))) return true;
      // 删除后的重建项已不在index，git diff不会报告它；包括悬空符号链接。
      if (snapshot[path] === undefined && lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined) return true;
      return !operation?.steps.some((step) => {
        if (step.state === "completed" || step.evidence?.before !== head || !step.evidence.expectedPaths?.split("\n").includes(path)) return false;
        try {
          const expected = JSON.parse(step.evidence.expectedTree ?? "null") as Record<string, string> | null;
          return expected !== null && typeof expected === "object" && !Array.isArray(expected) && expected[path] === tree[path];
        } catch { return false; }
      });
    });
  }

  private taskLockKey(root: string, taskId: string) {
    return { scope: "task" as const, rawKey: `${root}::${taskId}` };
  }

  private async latestOperation(root: string, taskId: string): Promise<DeliveryOperation | null> {
    const all = await this.store.operations.list();
    const candidates = all
      .filter((operation) => operation.kind.startsWith("delivery.") && (operation as Partial<DeliveryOperation>).taskId === taskId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    return (candidates.at(-1) as DeliveryOperation | undefined) ?? null;
  }

  /** --plan 预览：主会话文案与模板兜底都显示来源、首行与正文行数。 */
  private planMessage(
    document: ReturnType<typeof parseTaskDocument>,
    taskId: string,
    messageFile: string | null | undefined,
  ): DeliveryPlanMessage {
    const draft = messageFile === null || messageFile === undefined || messageFile === ""
      ? null
      : readMessageFile(messageFile);
    if (draft !== null) {
      return { source: "agent", subject: draft.subject, bodyLines: draft.body.split("\n").length };
    }
    const verification = document.frontmatter.verification ?? "independent";
    const body = ["结果：completed", `验证：${verification} — 未记录`];
    return {
      source: "template",
      subject: truncateMessageSubject(`${document.frontmatter.title} (${taskId})`),
      bodyLines: body.length,
    };
  }

  /**
   * 新操作在落盘前校验文案；已有持久化文案（或已提交）时忽略新文件并记录证据。
   * 校验失败时尚未创建操作，不产生 Task／index／提交副作用。
   */
  private messageInputFor(
    input: DeliveryInput & { mode: "deliver" | "archive" },
    latest: DeliveryOperation | null,
  ): MessageInput {
    if (input.mode !== "deliver") return { draft: null, ignored: false };
    const supplied = input.messageFile !== null && input.messageFile !== undefined && input.messageFile !== "";
    const artifactCommitted = latest !== null && (
      latest.messages?.artifact !== undefined ||
      latest.workCommit !== null ||
      latest.steps.some((step) => (step.kind === "artifact_commit" || step.kind === "work_commit") && step.state === "completed")
    );
    if (artifactCommitted) {
      return { draft: null, ignored: supplied };
    }
    if (!supplied) return { draft: null, ignored: false };
    return { draft: readMessageFile(input.messageFile!), ignored: false };
  }

  private async createOperation(
    root: string,
    input: DeliveryInput & { mode: "deliver" | "archive" },
    caller: "cli" | "agent",
    messageDraft: MessageDraft | null,
    worktree: DeliveryWorktreeFollowUp | undefined,
  ): Promise<DeliveryOperation> {
    if (!isFullBranch(input.branch)) throw new GuardError("branch_invalid", "--branch 必须是完整 refs/heads/...");
    const located = locateTaskDocument(root, input.taskId);
    if (located.archived) throw new GuardError("task_archived", `任务已归档: ${input.taskId}`);
    if (currentBranch(root, this.git) !== input.branch) {
      throw new GuardError("branch_mismatch", `当前分支不是 ${input.branch}`);
    }
    if (!branchExists(root, input.branch, this.git)) throw new GuardError("branch_missing", `本地分支不存在: ${input.branch}`);
    if (located.document.frontmatter.branch !== input.branch) {
      throw new GuardError("branch_mismatch", `任务分支 ${located.document.frontmatter.branch ?? "null"} 与 --branch 不一致`);
    }
    if (input.mode === "deliver") {
      if (located.document.frontmatter.status === "closed" && located.document.frontmatter.outcome !== "completed") {
        throw new GuardError("task_closed", `任务已结束（${located.document.frontmatter.outcome}），不能正常交付`);
      }
      if (located.document.frontmatter.stage !== "deliver") {
        throw new GuardError("phase_mismatch", `任务不在交付阶段: ${located.document.frontmatter.stage}`);
      }
    } else {
      const status = located.document.frontmatter.status;
      const outcome = located.document.frontmatter.outcome;
      if (status !== "closed" || (outcome !== "cancelled" && outcome !== "superseded")) {
        throw new GuardError("deliver_required", "archive 只归档已取消／被替代的任务；正常完成先走 deliver");
      }
    }
    const config = this.readConfig(root);
    const sessionFile = (input.sessionFile ?? "").trim();
    const authorization = resolveAuthorization(
      root,
      input.authorizationRef ?? null,
      caller,
      sessionFile === "" ? null : { sessionFile },
    );
    const defaultBranch = defaultBranchCandidate(root, config, this.git);
    const now = this.now().toISOString();
    const steps: DeliveryStep[] = (input.mode === "deliver"
      ? ["artifact_commit", "final_record", "metadata_commit", "seal", "move", "archive_commit"]
      : ["final_record", "seal", "move", "archive_commit"]
    ).map((kind, index) => ({
      stepId: `${index + 1}-${kind}`,
      kind,
      state: "planned" as OperationState,
      before: null,
      after: null,
      evidence: null,
    }));
    const operationId = `op-${this.randomHex(6)}`;
    const operation: DeliveryOperation = {
      operationId,
      kind: input.mode === "deliver" ? "delivery.deliver" : "delivery.archive",
      mode: input.mode,
      taskId: input.taskId,
      state: "planned",
      reason: null,
      recordedAt: now,
      updatedAt: now,
      branch: input.branch,
      caller,
      authorizationRef: input.authorizationRef ?? null,
      authorization,
      invocation: sessionFile === "" ? "cli-unverified" as const : "bridge" as const,
      defaultBranch,
      policyVersion: policyVersion(root, config),
      taskPath: relative(root, join(located.dir, TASK_FILE)).split("\\").join("/"),
      // 首次目标固定，跨月恢复也使用同一 archivePath。
      archivePath: this.archivePath(root, located.dir),
      workCommit: null,
      metadataCommit: null,
      archiveCommit: null,
      sealDigest: null,
      ...(messageDraft === null ? {} : {
        messages: {
          artifact: {
            source: "agent" as const,
            text: composeCommitMessage(messageDraft, {
              taskId: input.taskId,
              operationId,
              stage: "artifact",
              verification: located.document.frontmatter.verification ?? "independent",
            }),
          },
        },
      }),
      ...(worktree === undefined ? {} : { worktree }),
      steps,
    };
    await this.store.operations.save(operation);
    return operation;
  }

  private readConfig(root: string): ProjectConfig {
    const path = join(root, ".knit", "config.json");
    if (!existsSync(path)) return defaultConfig();
    return parseConfig(readFileSync(path, "utf8"));
  }

  /**
   * 交付预检提醒（DESIGN §5.3）：外部改动、被确认排除的路径与未处理残留不在 scope，不进产物提交；
   * 列出供用户核对工作区，不阻塞交付。
   */
  private outsideScopeReminders(root: string, taskId: string, artifacts: string[]): { externalChanges: string[]; residue: string[] } {
    const runs = new RunStore(root);
    const inScope = new Set(artifacts);
    const external = new Set<string>();
    for (const runId of runs.listRunIds()) {
      let result = null;
      try {
        result = runs.readResult(runId);
      } catch {
        result = null;
      }
      if (result === null || result.taskId !== taskId) continue;
      for (const path of result.externalChanges ?? []) external.add(path);
      for (const path of runs.readAttributionConfirmation(runId)?.exclude ?? []) external.add(path);
    }
    const residue = (runs.readResidue(taskId)?.entries ?? []).map((entry) => entry.path);
    return {
      externalChanges: [...external].filter((path) => !inScope.has(path)).sort(),
      residue: residue.filter((path) => !inScope.has(path)).sort(),
    };
  }

  /** 业务产物与任务资料分开：任务目录只进 metadata；scope 中其余路径是 artifacts。 */
  private async classifyPaths(
    root: string,
    taskId: string,
    taskDir: string,
  ): Promise<{ artifacts: string[]; metadata: string[]; selected: string[] }> {
    const runs = new RunStore(root);
    const scope = loadScope(runs, taskId, this.now().toISOString());
    // 主会话实施没有 run scope：记录里的路径同样属于业务产物范围。
    const implementation = readIntact(() => runs.readImplementation(taskId));
    const review = await this.reviewForTask(taskId);
    const taskDirRelative = relative(root, taskDir).split("\\").join("/");
    const artifactPaths = [...new Set([
      ...scope.entries.map((entry) => entry.path),
      ...(implementation?.entries.map((entry) => entry.path) ?? []),
    ])]
      .filter((path) => path !== taskDirRelative && !path.startsWith(`${taskDirRelative}/`))
      .filter((path) => path !== RUNTIME_PREFIX && !path.startsWith(`${RUNTIME_PREFIX}/`));
    const artifactSet = new Set(artifactPaths);
    const metadataSet = new Set<string>([taskDirRelative]);
    for (const target of review?.targets ?? []) {
      if (!artifactSet.has(target)) metadataSet.add(target);
    }
    if ((review?.targets.length ?? 0) > 0 && !artifactSet.has(".knit/standards/index.md")) {
      metadataSet.add(".knit/standards/index.md");
    }
    const selected = [...new Set([...artifactPaths, ...metadataSet])]
      .filter((path) => path !== RUNTIME_PREFIX && !path.startsWith(`${RUNTIME_PREFIX}/`))
      .sort();
    return { artifacts: [...artifactSet].sort(), metadata: [...metadataSet].sort(), selected };
  }

  private async prepare(
    root: string,
    input: DeliveryInput & { mode: "deliver" | "archive" },
    operation: DeliveryOperation,
    caller: "cli" | "agent",
    messageInput: MessageInput,
    commitGit: GitRunner = this.git,
  ): Promise<Prepared> {
    if (operation.branch !== input.branch) {
      throw new GuardError("branch_mismatch", `继续操作的分支 ${operation.branch} 与本次 --branch 不一致`);
    }
    if (operation.policyVersion !== policyVersion(root, this.readConfig(root))) {
      throw new GuardError("policy_changed", "交付策略在操作开始后变化，重核后再继续");
    }
    const located = locateTaskDocument(root, input.taskId);
    const taskDir = located.dir;
    const taskPath = join(taskDir, TASK_FILE);
    const taskRelative = relative(root, taskPath).split("\\").join("/");
    const document = located.document;
    const raw = located.raw;
    const binding = await this.store.bindings.get(input.taskId);
    if (binding === null) throw new GuardError("binding_missing", `任务绑定缺失: ${input.taskId}`);
    const config = this.readConfig(root);
    const branch = input.branch;
    if (!isFullBranch(branch)) throw new GuardError("branch_invalid", "--branch 必须是完整 refs/heads/...");
    if (currentBranch(root, this.git) !== branch) {
      throw new GuardError("branch_mismatch", `当前分支不是 ${branch}`);
    }
    if (!branchExists(root, branch, this.git)) throw new GuardError("branch_missing", `本地分支不存在: ${branch}`);
    if (document.frontmatter.branch === null) throw new GuardError("branch_unbound", "任务未绑定分支");
    if (document.frontmatter.branch !== branch) {
      throw new GuardError("branch_mismatch", `任务分支 ${document.frontmatter.branch} 与 --branch 不一致`);
    }
    if (binding.branch !== null && binding.branch !== branch) {
      throw new GuardError("branch_mismatch", `绑定分支 ${binding.branch} 与 --branch 不一致`);
    }
    if (binding.pendingDraft !== null) throw new GuardError("pending_inputs", "存在待应用输入草案，先应用或撤回");

    const runsSettled = await this.runsSettled(root, input.taskId);
    // 限定提交前扫描待写内容与本次实际差异（DESIGN.md §15.1）：未跟踪新文件整体扫描，
    // 已跟踪文件只扫相对 HEAD 的新增行；命中即暂停交付，先于检查资格重核报告（任务032）。
    // 只扫差异避免既有夹具（如扫描器自身的测试样本）反复阻塞后续交付。
    // 扫描范围是产物与资料提交将暂存的全部路径（任务 k-28296c22647a）：scope、主会话实施记录、
    // 采纳的规范目标与任务目录，目录按 git status 展开到实际改动的文件，不只是 scope 条目本身。
    if (!located.archived && (operation.mode === "deliver" || (operation.mode === "archive" && operation.kind === "delivery.deliver"))) {
      const scanPaths = new Set<string>([relative(root, taskDir).split("\\").join("/")]);
      const preScope = loadScope(new RunStore(root), input.taskId, this.now().toISOString());
      for (const entry of preScope.entries) scanPaths.add(entry.path);
      const preClassified = await this.classifyPaths(root, input.taskId, taskDir);
      for (const path of [...preClassified.artifacts, ...preClassified.metadata]) scanPaths.add(path);
      for (const path of dirtyPaths(root, [...scanPaths], this.git)) scanPaths.add(path);
      const scanFailures: string[] = [];
      for (const path of scanPaths) {
        const full = join(root, path);
        if (!existsSync(full)) continue;
        let content: string;
        try {
          const stats = lstatSync(full);
          content = stats.isDirectory() ? "" : readFileSync(full, "utf8");
        } catch {
          continue; // 不可读内容交由 Git 处理；扫描不阻塞无法读取的路径
        }
        const tracked = this.git(["ls-files", "--error-unmatch", "--", path], root).code === 0;
        const text = tracked ? this.addedLinesDiff(root, path) : content;
        const hits = scanCredentials(text);
        if (hits.length > 0) scanFailures.push(`${path}: ${hits.map((hit) => `${hit.type}@新增行${hit.line}`).join(", ")}`);
      }
      if (scanFailures.length > 0) {
        throw new GuardError("credential_scan_hit", `限定提交范围命中常见凭据模式，已暂停交付: ${scanFailures.join("; ")}`);
      }
    }
    let check: CheckFile | null = null;
    const isDeliverOperation = operation.mode === "deliver" || (operation.mode === "archive" && operation.kind === "delivery.deliver");
    if (!located.archived && isDeliverOperation) {
      const completionService = new CompletionService({ store: this.store, now: this.now, randomHex: this.randomHex });
      if (document.frontmatter.status === "closed" && document.frontmatter.outcome === "completed") {
        const completed = await completionService.validate({ root, taskId: input.taskId, document, raw, binding });
        if (!completed.valid) {
          // 旧记录没有 verification 字段：保留既有“有效检查才能正常交付”语义。
          if (document.frontmatter.verification !== undefined) {
            // independent 的完成凭据失效仍以检查资格原因报告，便于调用方按既有语义重查。
            if (document.frontmatter.verification === "independent") {
              check = await this.validCheck(root, input.taskId, binding, branch);
            }
            throw new GuardError(completed.reason, `完成凭据不可用: ${completed.reason}`);
          }
          check = await this.validCheck(root, input.taskId, binding, branch);
        } else if (completed.completion.checkRunId !== null) {
          check = readIntact(() => new RunStore(root).readCheck(completed.completion.checkRunId!));
          if (check === null) throw new GuardError("check_missing", "完成凭据引用的检查凭据缺失");
        }
      } else {
        // independent 保留既有检查资格错误语义；self／none 由完成守卫判断。
        if ((document.frontmatter.verification ?? "independent") === "independent") {
          check = await this.validCheck(root, input.taskId, binding, branch);
          // 与 task close 同一完成守卫：检查者修复过成果的检查不能作为 independent 完成依据（在创建操作前拒绝）。
          if (checkerChangedPathsOf(check).length > 0) {
            throw new GuardError("check_self_modified", `任务不能完成: check_self_modified（检查 ${check.runId} 由检查者修复 ${checkerChangedPathsOf(check).length} 个路径；再派一次未改动文件的 pass 检查）`);
          }
        } else {
          const decision = await completionService.assess({ root, taskId: input.taskId, document, raw, binding, parentTask: hasChildTasks(root, input.taskId) });
          if (decision.allowed === false) throw new GuardError(decision.reason, `任务不能完成: ${decision.reason}`);
          if (decision.checkRunId !== null) {
            check = readIntact(() => new RunStore(root).readCheck(decision.checkRunId!));
            if (check === null) throw new GuardError("check_missing", "当前检查凭据缺失");
          }
        }
      }
      if (!runsSettled) throw new GuardError("runs_unsettled", "任务仍有活动／未知运行或待接收结果");
    }

    const { artifacts, metadata, selected: selectedPaths } = await this.classifyPaths(root, input.taskId, taskDir);
    const defaultBranch = operation.defaultBranch.ref === null || operation.defaultBranch.source === "unknown"
      ? defaultBranchCandidate(root, config, this.git)
      : operation.defaultBranch;
    const authorization = recheckAuthorization(root, operation.authorization, caller);
    return {
      root,
      taskDir,
      taskPath,
      taskRelative,
      document,
      binding,
      config,
      branch,
      check,
      selected: selectedPaths,
      artifacts,
      metadata,
      defaultBranch,
      authorization,
      policyVersion: operation.policyVersion,
      messageDraft: messageInput.draft,
      messageIgnored: messageInput.ignored,
      commitGit,
    };
  }

  private async execute(prepared: Prepared, operation: DeliveryOperation): Promise<DeliveryResult> {
    let op = operation;
    const save = async (update: Partial<DeliveryOperation>) => {
      op = { ...op, ...update, updatedAt: this.now().toISOString() };
      await this.store.operations.save(op);
    };
    const step = (kind: string) => op.steps.find((candidate) => candidate.kind === kind);
    // Git 提交执行前把预期范围／树写入步骤证据；执行者被杀后仍能按真实提交复核。
    const checkpoint = async (kind: string, evidence: Record<string, string>): Promise<void> => {
      const target = step(kind);
      if (target === undefined) return;
      target.evidence = evidence;
      await save(op);
    };
    const attention = async (kind: string, reason: string, evidence: Record<string, string> | null = null): Promise<DeliveryResult> => {
      const target = step(kind);
      if (target !== undefined) {
        target.state = "needs_attention";
        // 保留提交前 checkpoint（expectedPaths／expectedTree／before），
        // 失败原因不能覆盖恢复所需的预期事实。
        target.evidence = { ...(target.evidence ?? {}), ...(evidence ?? {}), reason };
        target.after = target.evidence;
      }
      await save({ state: "needs_attention", reason });
      return this.resultOf(op, false);
    };
    const completeStep = async (kind: string, evidence: Record<string, string>) => {
      const target = step(kind);
      if (target !== undefined) {
        target.state = "completed";
        target.evidence = evidence;
        target.after = evidence;
      }
      await save({ state: op.state === "planned" ? "running" : op.state });
    };
    // 同一阶段只生成一次文案并落盘；重试直接复用，不按当前文件重拟。
    const stageMessage = async (
      stage: "artifact" | "metadata" | "archive",
      build: () => DeliveryMessage,
    ): Promise<string> => {
      const existing = op.messages?.[stage];
      if (existing !== undefined) return existing.text;
      const message = build();
      await save({ messages: { ...(op.messages ?? {}), [stage]: message } });
      return message.text;
    };
    const messageEvidence = (evidence: Record<string, string>): Record<string, string> =>
      prepared.messageIgnored ? { ...evidence, message_ignored_on_retry: "true" } : evidence;

    // 1. 正常完成收束为 closed/completed；取消／替代已在 task close 完成。
    if (op.mode === "deliver") {
      await this.closeCompleted(prepared.root, op.taskId);
    }

    const alreadyArchived = !existsSync(join(prepared.root, op.taskPath));
    // 2. 业务产物提交（仅正常交付）；任务资料在最终记录后单独提交。
    if (op.mode === "deliver") {
      if (step("artifact_commit") !== undefined) {
        if (!alreadyArchived) {
          const message = await stageMessage("artifact", () => this.artifactMessage(prepared, op));
          const artifact = await this.commitSelected(prepared, op, prepared.artifacts, "artifact_commit", "artifact", message, checkpoint);
          if (artifact.commit !== null) await save({ workCommit: artifact.commit });
          else if (artifact.attention === null) await save({ workCommit: null });
          if (artifact.attention !== null) return attention("artifact_commit", artifact.attention, messageEvidence(artifact.evidence));
          await completeStep("artifact_commit", messageEvidence(artifact.evidence));
        }
      } else {
      if (op.mode === "deliver") {
        const work = step("work_commit");
        if (work?.state === "completed") {
          const oid = op.workCommit;
          if (oid === null) {
            const skipped = work.evidence?.skipped === "true";
            const head = gitOrThrow(prepared.root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
            if (!skipped || (work.evidence?.before !== undefined && work.evidence.before !== head)) {
              return attention("work_commit", "step_effect_missing");
            }
          } else if (!commitExists(prepared.root, oid, this.git)) {
            return attention("work_commit", "step_effect_missing");
          } else {
            const archive = step("archive_commit");
            const archiveStarted = archive?.state === "completed" || op.archiveCommit !== null ||
              this.findOperationCommit(prepared.root, op.operationId, "archive") !== null;
            if (!archiveStarted) {
              const head = gitOrThrow(prepared.root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
              if (head !== oid) return attention("work_commit", "work_commit_head_advanced", { commit: oid, head });
            }
          }
        } else if (op.workCommit !== null) {
          // 上次已产生提交但被 hook 等置 needs_attention：显式重试只核实，不重复提交。
          if (!commitExists(prepared.root, op.workCommit, this.git)) return attention("work_commit", "step_effect_missing");
          if (!isStageCommit(commitMessage(prepared.root, op.workCommit, this.git), "deliver", op.operationId)) {
            return attention("work_commit", "commit_message_mismatch", { commit: op.workCommit });
          }
          const head = gitOrThrow(prepared.root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
          if (head !== op.workCommit) return attention("work_commit", "commit_scope_mismatch", { commit: op.workCommit, head });
          const prior = work?.evidence ?? {};
          if (prior.before !== undefined) {
            const parent = gitOrThrow(prepared.root, ["rev-parse", `${op.workCommit}^`], "读取提交父节点", this.git);
            if (parent !== prior.before) return attention("work_commit", "commit_parent_mismatch", { commit: op.workCommit, parent });
          }
          if (prior.expectedPaths !== undefined) {
            const actualPaths = commitPaths(prepared.root, op.workCommit, this.git);
            const expectedPaths = prior.expectedPaths.split("\n").filter(Boolean);
            if (!sameSet(actualPaths, expectedPaths)) {
              return attention("work_commit", "commit_scope_mismatch", { commit: op.workCommit, expected: prior.expectedPaths, actual: actualPaths.join("\n") });
            }
          }
          if (prior.expectedTree !== undefined) {
            let expectedTree: Record<string, string> = {};
            try {
              expectedTree = JSON.parse(prior.expectedTree) as Record<string, string>;
            } catch {
              return attention("work_commit", "commit_verification_unavailable", { commit: op.workCommit });
            }
            if (!sameTree(expectedTree, treeSnapshot(prepared.root, op.workCommit, prepared.selected, this.git), prepared.selected)) {
              return attention("work_commit", "hook_changed_selected", { commit: op.workCommit });
            }
          }
          const scopeDirty = dirtyPaths(prepared.root, prepared.selected.filter((path) => path !== prepared.taskRelative), this.git);
          if (scopeDirty.length > 0) return attention("work_commit", "selected_worktree_dirty", { paths: scopeDirty.join("\n") });
          await completeStep("work_commit", { commit: op.workCommit, recovered: "true" });
        } else {
          const result = await this.workCommit(prepared, op, checkpoint);
          if (result.commit !== null) await save({ workCommit: result.commit });
          if (result.attention !== null) return attention("work_commit", result.attention, result.evidence);
          await completeStep("work_commit", result.evidence);
        }
      }
      }
    }

    // 3. 完整收尾记录（封存前）。
    const record = step("final_record");
    if (record?.state === "completed") {
      if (!this.hasRecord(prepared.taskPath, op.operationId)) return attention("final_record", "step_effect_missing");
    } else {
      if (op.archivePath === null) {
        await save({ archivePath: this.archivePath(prepared.root, prepared.taskDir) });
      }
      const written = this.appendFinalRecord(prepared, op);
      await save({ sealDigest: written.digest });
      await completeStep("final_record", { digest: written.digest });
    }

    // 3.5 任务资料提交（最终记录已写入，业务产物已单独提交）。
    if (op.mode === "deliver" && step("metadata_commit") !== undefined && !alreadyArchived) {
      const message = await stageMessage("metadata", () => this.metadataMessage(prepared, op));
      const metadata = await this.commitSelected(prepared, op, prepared.metadata, "metadata_commit", "metadata", message, checkpoint);
      if (metadata.commit !== null) await save({ metadataCommit: metadata.commit });
      else if (metadata.attention === null) await save({ metadataCommit: null });
      if (metadata.attention !== null) return attention("metadata_commit", metadata.attention, metadata.evidence);
      await completeStep("metadata_commit", metadata.evidence);
      const noteDigest = this.appendMetadataCommitNote(prepared, op);
      if (noteDigest !== null) await save({ sealDigest: noteDigest });
    }

    // 4. 封存固定版本。
    const seal = step("seal");
    if (seal?.state === "completed") {
      const marker = this.readSeal(prepared.taskDir);
      const archiveAlreadyCommitted = step("archive_commit")?.state === "completed" ||
        this.findOperationCommit(prepared.root, op.operationId, "archive") !== null;
      if (marker === null) {
        if (!archiveAlreadyCommitted) return attention("seal", "step_effect_missing");
      } else if (op.sealDigest === null || !marker.includes(op.sealDigest)) {
        return attention("seal", "step_effect_missing");
      }
    } else {
      const currentDigest = sha256Text(readFileSync(prepared.taskPath, "utf8"));
      if (op.sealDigest !== null && op.sealDigest !== currentDigest) {
        return attention("seal", "seal_version_conflict");
      }
      const digest = op.sealDigest ?? currentDigest;
      const marker = join(prepared.taskDir, SEAL_MARKER);
      atomicWrite({
        path: marker,
        data: Buffer.from(JSON.stringify({ operationId: op.operationId, taskId: op.taskId, digest, sealedAt: this.now().toISOString() }) + "\n", "utf8"),
        expectedSha256: null,
        mode: 0o600,
      });
      await save({ sealDigest: digest });
      await completeStep("seal", { digest });
    }

    // 5. 移动到 archive/YYYY-MM/<原目录>；目标由操作首次记录。
    const move = step("move");
    if (move?.state === "completed") {
      if (op.archivePath === null || !existsSync(join(prepared.root, op.archivePath))) {
        return attention("move", "step_effect_missing");
      }
      if (op.taskPath !== op.archivePath && existsSync(join(prepared.root, op.taskPath))) {
        return attention("move", "step_effect_missing");
      }
    } else {
      const archivePath = op.archivePath ?? this.archivePath(prepared.root, prepared.taskDir);
      const target = join(prepared.root, archivePath);
      // op.taskPath 是首次来源；prepared.taskDir 在已移动重入时已经是目标，不能误报冲突。
      const opTaskFull = op.taskPath.startsWith(".knit/") ? join(prepared.root, op.taskPath) : join(prepared.root, ".knit", op.taskPath);
      const sourceDir = dirname(opTaskFull);
      const targetExists = existsSync(target);
      const sourceExists = existsSync(sourceDir);
      if (targetExists && sourceExists && sourceDir !== target) {
        return attention("move", "archive_target_exists", { target: archivePath });
      }
      if (!targetExists) {
        if (!sourceExists) return attention("move", "archive_source_missing", { target: archivePath });
        mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
        renameSync(sourceDir, target);
      }
      const archivedTask = join(target, TASK_FILE);
      if (!existsSync(archivedTask)) return attention("move", "archive_move_unknown", { target: archivePath });
      if (parseTaskDocument(readFileSync(archivedTask, "utf8"), archivedTask).frontmatter.id !== op.taskId) {
        return attention("move", "archive_identity_mismatch", { target: archivePath });
      }
      if (op.sealDigest !== null && sha256Text(readFileSync(archivedTask, "utf8")) !== op.sealDigest) {
        return attention("move", "seal_version_conflict", { target: archivePath });
      }
      // 显式失效标记：不依赖月份目录 mtime 也能让同一进程的列表缓存重算归档索引；
      // 重试进入“目标已存在、步骤未完成”的分支时同样刷新，覆盖上次进程在 move 后中断的窗口。
      markTaskListArchiveChanged(prepared.root, `delivery.move:${op.operationId}`);
      const binding = await this.store.bindings.get(op.taskId);
      if (binding !== null) {
        await this.store.bindings.save({ ...binding, relativePath: relative(prepared.root, archivedTask).split("\\").join("/") });
      }
      await save({ archivePath });
      await completeStep("move", { target: archivePath });
    }

    // 6. 归档提交：旧路径删除 + 新路径新增；不把封存标记提交。
    const archiveCommit = step("archive_commit");
    if (archiveCommit?.state === "completed") {
      if (op.archiveCommit === null || !commitExists(prepared.root, op.archiveCommit, this.git)) return attention("archive_commit", "step_effect_missing");
      if (!isAncestor(prepared.root, op.archiveCommit, "HEAD", this.git)) return attention("archive_commit", "step_effect_missing");
      const head = gitOrThrow(prepared.root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
      if (head !== op.archiveCommit) return attention("archive_commit", "archive_head_advanced", { commit: op.archiveCommit, head });
      this.removeSeal(join(prepared.root, op.archivePath ?? ""));
    } else if (op.archiveCommit !== null) {
      if (!commitExists(prepared.root, op.archiveCommit, this.git)) return attention("archive_commit", "step_effect_missing");
      if (!isStageCommit(commitMessage(prepared.root, op.archiveCommit, this.git), "archive", op.operationId)) {
        return attention("archive_commit", "archive_message_mismatch", { commit: op.archiveCommit });
      }
      const head = gitOrThrow(prepared.root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
      if (head !== op.archiveCommit) return attention("archive_commit", "archive_scope_mismatch", { commit: op.archiveCommit, head });
      const prior = archiveCommit?.evidence ?? {};
      if (prior.before !== undefined) {
        const parent = gitOrThrow(prepared.root, ["rev-parse", `${op.archiveCommit}^`], "读取归档提交父节点", this.git);
        if (parent !== prior.before) return attention("archive_commit", "archive_parent_mismatch", { commit: op.archiveCommit, parent });
      }
      const selected = [archiveScope(op.taskPath), op.archivePath ?? ""];
      const actual = commitPaths(prepared.root, op.archiveCommit, this.git);
      if (prior.expectedPaths !== undefined) {
        const expected = prior.expectedPaths.split("\n").filter(Boolean);
        if (!sameSet(actual, expected)) return attention("archive_commit", "archive_scope_mismatch", { commit: op.archiveCommit, expected: prior.expectedPaths, actual: actual.join("\n") });
      }
      if (prior.expectedTree !== undefined) {
        let expectedTree: Record<string, string> = {};
        try {
          expectedTree = JSON.parse(prior.expectedTree) as Record<string, string>;
        } catch {
          return attention("archive_commit", "archive_verification_unavailable", { commit: op.archiveCommit });
        }
        if (!sameTree(expectedTree, treeSnapshot(prepared.root, op.archiveCommit, selected, this.git), selected)) {
          return attention("archive_commit", "archive_content_mismatch", { commit: op.archiveCommit });
        }
      }
      await completeStep("archive_commit", { commit: op.archiveCommit, recovered: "true" });
      this.removeSeal(join(prepared.root, op.archivePath ?? ""));
    } else {
      const message = await stageMessage("archive", () => this.archiveMessage(prepared, op));
      const result = await this.archiveCommit(prepared, op, message, checkpoint);
      // 未通过核验的候选提交不能写成权威 archiveCommit；否则用户清理额外历史后
      // 会一直指向废弃提交，无法用同一操作恢复。成功时再落盘。
      if (result.attention === null && result.commit !== "") await save({ archiveCommit: result.commit });
      if (result.attention !== null) return attention("archive_commit", result.attention, result.evidence);
      await completeStep("archive_commit", result.evidence);
      this.removeSeal(join(prepared.root, op.archivePath ?? ""));
    }

    await save({ state: "completed", reason: null });
    return this.resultOf(op, true);
  }

  /** 可交给 git add 的路径：存在，或已被跟踪（删除项）。不存在且未跟踪的旧路径跳过。 */
  /** 已从 index 删除的路径再次 add 会报 pathspec；它已在暂存区，只需进入 commit pathspec。 */
  private stageable(root: string, paths: string[]): string[] {
    return paths.filter((path) => existsSync(join(root, path)) || this.git(["ls-files", "--error-unmatch", "--", path], root).code === 0);
  }

  /** 已跟踪路径相对 HEAD 的新增行拼接文本；仅供模式扫描，行号为拼接文本行号。 */
  private addedLinesDiff(root: string, path: string): string {
    const result = this.git(["diff", "HEAD", "--unified=0", "--", path], root);
    if (result.code !== 0) return "";
    const lines: string[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) lines.push(line.slice(1));
    }
    return lines.join("\n");
  }

  private addable(root: string, paths: string[]): string[] {
    return paths.filter((path) => {
      if (existsSync(join(root, path))) return true;
      if (this.git(["ls-files", "--error-unmatch", "--", path], root).code === 0) return true;
      // pre-commit 失败后删除可能已离开 index；仍在 HEAD 的路径必须继续作为删除提交，
      // 目录路径则展开检查其历史受管文件。
      const tree = this.git(["ls-tree", "-r", "--name-only", "HEAD", "--", path], root);
      return tree.code === 0 && tree.stdout.trim() !== "";
    });
  }

  /**
   * 「验证」行的验证方式：检查者修复过路径时写成「independent（检查者修复 N 个路径，修复部分为自检）」，
   * 不输出不带标注的「independent 通过」（审计 F3）。trailer 仍写机器值。
   */
  private verificationLine(prepared: Prepared, op: DeliveryOperation): string {
    const verification = prepared.document.frontmatter.verification ?? "independent";
    const completion = new RunStore(prepared.root).readCompletionIfIntact(op.taskId);
    const checkerPaths = prepared.check !== null
      ? checkerChangedPathsOf(prepared.check)
      : (completion?.checkerChangedPaths ?? []);
    return `${verificationLabel(verification, checkerPaths)} — ${this.verificationBasis(prepared, op)}`;
  }

  /** 验证依据：独立检查 run、主会话实施记录或强制完成原因；缺失写「未记录」。 */
  private verificationBasis(prepared: Prepared, op: DeliveryOperation): string {
    if (prepared.check !== null) return `检查 ${prepared.check.runId} 通过`;
    const completion = new RunStore(prepared.root).readCompletionIfIntact(op.taskId);
    if (completion?.forced === true) {
      return completion.forcedReason === null || completion.forcedReason === undefined || completion.forcedReason === ""
        ? "用户强制完成"
        : `用户强制完成：${completion.forcedReason}`;
    }
    if (completion?.implementedBy === "record") return "主会话实施记录";
    if (completion?.implementRunId !== null && completion?.implementRunId !== undefined) return `实施 ${completion.implementRunId}`;
    return "未记录";
  }

  /** 产物提交：主会话文案优先；无文案时使用事实型模板正文。 */
  private artifactMessage(prepared: Prepared, op: DeliveryOperation): DeliveryMessage {
    const verification = prepared.document.frontmatter.verification ?? "independent";
    if (prepared.messageDraft !== null) {
      return {
        source: "agent",
        text: composeCommitMessage(prepared.messageDraft, {
          taskId: op.taskId,
          operationId: op.operationId,
          stage: "artifact",
          verification,
        }),
      };
    }
    const outcome = op.mode === "deliver" ? "completed" : (prepared.document.frontmatter.outcome ?? "未记录");
    const body = [
      `结果：${outcome}`,
      `验证：${this.verificationLine(prepared, op)}`,
    ].join("\n");
    return {
      source: "template",
      text: composeCommitMessage({
        subject: truncateMessageSubject(`${prepared.document.frontmatter.title} (${op.taskId})`),
        body,
      }, { taskId: op.taskId, operationId: op.operationId, stage: "artifact", verification }),
    };
  }

  /** 任务资料提交：确定性模板，记录结果、验证依据与产物提交引用。 */
  private metadataMessage(prepared: Prepared, op: DeliveryOperation): DeliveryMessage {
    const verification = prepared.document.frontmatter.verification ?? "independent";
    const outcome = op.mode === "deliver" ? "completed" : (prepared.document.frontmatter.outcome ?? "cancelled");
    const completion = new RunStore(prepared.root).readCompletionIfIntact(op.taskId);
    const body = [
      `结果：${outcome}`,
      `验证：${this.verificationLine(prepared, op)}`,
      `产物提交：${shortHash(op.workCommit)}`,
      `资料：任务记录${completion === null ? "" : "、完成凭据"}`,
    ].join("\n");
    return {
      source: "template",
      text: composeCommitMessage({
        subject: truncateMessageSubject(`chore(task): ${prepared.document.frontmatter.title} (${op.taskId})`),
        body,
      }, { taskId: op.taskId, operationId: op.operationId, stage: "metadata", verification }),
    };
  }

  /** 归档提交：确定性模板，记录移动两端与产物／资料提交引用。 */
  private archiveMessage(prepared: Prepared, op: DeliveryOperation): DeliveryMessage {
    const name = basename(dirname(op.taskPath));
    const target = (op.archivePath ?? this.archivePath(prepared.root, prepared.taskDir)).replace(/^\.knit\//, "");
    const body = [
      `移动：tasks/${name} → ${target}`,
      `产物提交：${shortHash(op.workCommit)}`,
      `资料提交：${shortHash(op.metadataCommit ?? null)}`,
    ].join("\n");
    return {
      source: "template",
      text: composeCommitMessage({
        subject: truncateMessageSubject(`chore(task): archive ${name} (${op.taskId})`),
        body,
      }, {
        taskId: op.taskId,
        operationId: op.operationId,
        stage: "archive",
        verification: prepared.document.frontmatter.verification ?? "independent",
      }),
    };
  }

  /** 回执丢失时用操作 ID 缩小候选（新旧格式都含该 ID），再按 trailer／旧前缀定位阶段提交。 */
  private findOperationCommit(root: string, operationId: string, stage: DeliveryStage): string | null {
    const result = this.git(
      ["log", "--all", "--format=%H", "--all-match", "--fixed-strings", `--grep=${operationId}`],
      root,
    );
    if (result.code !== 0) return null;
    for (const oid of result.stdout.split(/\s+/).filter(Boolean)) {
      if (isStageCommit(commitMessage(root, oid, this.git), stage, operationId)) return oid;
    }
    return null;
  }

  /** 产物步骤兼容升级前的 `knit: deliver` 工作提交。 */
  private isOperationCommit(message: string, stage: DeliveryStage, operationId: string): boolean {
    return isStageCommit(message, stage, operationId) ||
      (stage === "artifact" && isStageCommit(message, "deliver", operationId));
  }

  private async workCommit(prepared: Prepared, op: DeliveryOperation, checkpoint?: (kind: string, evidence: Record<string, string>) => Promise<void>): Promise<{ commit: string | null; evidence: Record<string, string>; attention: string | null }> {
    return this.commitSelected(prepared, op, prepared.selected, "work_commit", "deliver", null, checkpoint);
  }

  private async commitSelected(
    prepared: Prepared,
    op: DeliveryOperation,
    selected: string[],
    stepKind: string,
    stage: DeliveryStage,
    message: string | null,
    checkpoint?: (kind: string, evidence: Record<string, string>) => Promise<void>,
  ): Promise<{ commit: string | null; evidence: Record<string, string>; attention: string | null }> {
    const root = prepared.root;
    const stagedMetadata = this.metadataStagedConflicts(root, prepared.metadata, op);
    if (stagedMetadata.length > 0) {
      return { commit: null, evidence: { reason: "preexisting_staged", paths: stagedMetadata.join("\n") }, attention: "preexisting_staged" };
    }
    let recovered = this.findOperationCommit(root, op.operationId, stage);
    // 兼容升级前已产生、message 仍是 knit: deliver 的首次工作提交；仍按当前步骤范围核对。
    if (recovered === null && stepKind === "artifact_commit") {
      recovered = this.findOperationCommit(root, op.operationId, "deliver");
    }
    if (recovered === null && stepKind === "artifact_commit" && op.workCommit !== null) {
      recovered = op.workCommit;
    }
    const prior = op.steps.find((item) => item.kind === stepKind)?.evidence ?? {};
    if (recovered !== null && isAncestor(root, recovered, "HEAD", this.git)) {
      if (!this.isOperationCommit(commitMessage(root, recovered, this.git), stage, op.operationId)) {
        return { commit: recovered, evidence: { reason: "commit_message_mismatch", commit: recovered }, attention: "commit_message_mismatch" };
      }
      const actual = commitPaths(root, recovered, this.git);
      const head = gitOrThrow(root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
      if (head !== recovered) {
        return { commit: recovered, evidence: { reason: "commit_scope_mismatch", commit: recovered, head, recovered: "true" }, attention: "commit_scope_mismatch" };
      }
      if (prior.before !== undefined) {
        const parent = gitOrThrow(root, ["rev-parse", `${recovered}^`], "读取提交父节点", this.git);
        if (parent !== prior.before) {
          return { commit: recovered, evidence: { reason: "commit_parent_mismatch", commit: recovered, parent, recovered: "true" }, attention: "commit_parent_mismatch" };
        }
      }
      if (prior.expectedPaths !== undefined) {
        const expectedPaths = prior.expectedPaths.split("\n").filter(Boolean);
        if (!sameSet(actual, expectedPaths)) {
          return {
            commit: recovered,
            evidence: { reason: "commit_scope_mismatch", commit: recovered, expected: prior.expectedPaths, actual: actual.join("\n"), recovered: "true" },
            attention: "commit_scope_mismatch",
          };
        }
      }
      if (prior.expectedTree !== undefined) {
        let expectedTree: Record<string, string> = {};
        try {
          expectedTree = JSON.parse(prior.expectedTree) as Record<string, string>;
        } catch {
          return { commit: recovered, evidence: { reason: "commit_verification_unavailable", commit: recovered }, attention: "commit_verification_unavailable" };
        }
        if (!sameTree(expectedTree, treeSnapshot(root, recovered, selected, this.git), selected)) {
          return { commit: recovered, evidence: { reason: "hook_changed_selected", commit: recovered, recovered: "true" }, attention: "hook_changed_selected" };
        }
      }
      const outside = actual.filter((path) => !selectedPath(path, selected));
      if (outside.length > 0) {
        return {
          commit: recovered,
          evidence: { reason: "commit_scope_mismatch", commit: recovered, paths: actual.join("\n"), unexpected: outside.join("\n"), recovered: "true" },
          attention: "commit_scope_mismatch",
        };
      }
      return { commit: recovered, evidence: { commit: recovered, paths: actual.join("\n"), recovered: "true" }, attention: null };
    }
    const beforeHead = gitOrThrow(root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
    if (prior.before !== undefined && beforeHead !== prior.before) {
      return { commit: null, evidence: { reason: "commit_unverified", before: prior.before, head: beforeHead }, attention: "commit_unverified" };
    }
    await checkpoint?.(stepKind, { before: beforeHead });
    const beforeStaged = stagedSnapshot(root, this.git);
    const beforeWorktree = this.signature(root);
    const expected = dirtyPaths(root, selected, this.git);
    if (expected.length === 0) {
      return { commit: null, evidence: { skipped: "true", reason: "no_selected_changes", before: beforeHead }, attention: null };
    }
    const addable = this.addable(root, selected);
    const stageable = this.stageable(root, addable);
    if (stageable.length > 0) gitOrThrow(root, ["add", "-A", "--", ...stageable], "暂存交付路径", prepared.commitGit);
    const expectedTree = indexTreeFor(stagedSnapshot(root, this.git), selected);
    await checkpoint?.(stepKind, {
      before: beforeHead,
      expectedPaths: expected.join("\n"),
      expectedTree: JSON.stringify(expectedTree),
    });
    const forced = new RunStore(root).readCompletionIfIntact(op.taskId)?.forced === true;
    // 旧 work_commit 仍用旧单行格式；新阶段使用已持久化的完整文案。
    const messageText = message ?? `knit: ${stage} ${op.taskId} (${op.operationId}${forced ? ", forced" : ""})`;
    const commit = runCommit(root, ["commit", "-m", messageText, "--only", "--", ...addable], prepared.commitGit);
    const afterHead = gitOrThrow(root, ["rev-parse", "HEAD"], "读取提交后 HEAD", this.git);
    if (commit.code !== 0) {
      if (afterHead !== beforeHead && this.isOperationCommit(commitMessage(root, afterHead, this.git), stage, op.operationId)) {
        // 回执丢失但提交已生效：按真实提交继续核对，不重复提交。
      } else {
        return { commit: null, evidence: { reason: "git_commit_failed", stderr: commit.stderr.trim().slice(0, 500) }, attention: "git_commit_failed" };
      }
    }
    if (afterHead === beforeHead) {
      return { commit: null, evidence: { reason: "commit_not_created" }, attention: "commit_not_created" };
    }
    if (!this.isOperationCommit(commitMessage(root, afterHead, this.git), stage, op.operationId)) {
      return { commit: afterHead, evidence: { reason: "commit_message_mismatch", commit: afterHead }, attention: "commit_message_mismatch" };
    }
    const parent = gitOrThrow(root, ["rev-parse", `${afterHead}^`], "读取提交父节点", this.git);
    if (parent !== beforeHead) {
      return { commit: afterHead, evidence: { reason: "commit_parent_mismatch", commit: afterHead, parent }, attention: "commit_parent_mismatch" };
    }
    const actual = commitPaths(root, afterHead, this.git);
    if (!sameSet(actual, expected)) {
      return {
        commit: afterHead,
        evidence: { reason: "commit_scope_mismatch", commit: afterHead, expectedPaths: expected.join("\n"), actual: actual.join("\n") },
        attention: "commit_scope_mismatch",
      };
    }
    if (!sameTree(expectedTree, treeSnapshot(root, afterHead, selected, this.git), selected)) {
      return {
        commit: afterHead,
        evidence: { reason: "hook_changed_selected", commit: afterHead, expectedTree: JSON.stringify(expectedTree) },
        attention: "hook_changed_selected",
      };
    }
    const afterStaged = stagedSnapshot(root, this.git);
    const afterWorktree = this.signature(root);
    const stagedChanged = Object.keys({ ...beforeStaged, ...afterStaged }).some(
      (path) => !selectedPath(path, selected) && beforeStaged[path] !== afterStaged[path],
    );
    const selectedIndexChanged = !sameTree(
      expectedTree,
      indexTreeFor(afterStaged, Object.keys(expectedTree)),
      Object.keys(expectedTree),
    );
    // 任务资料只取短锁，交付窗口内其它会话可并发登记或记录；不当作 hook 副作用。
    const worktreeChanged = Object.keys({ ...beforeWorktree.entries, ...afterWorktree.entries }).some(
      (path) => !selectedPath(path, selected) && !path.startsWith(".knit/tasks/") && beforeWorktree.entries[path] !== afterWorktree.entries[path],
    );
    // 提交后选中路径会从脏列表消失；只有提交后仍脏且内容变化才说明 hook 改了选中文件。
    const selectedChanged = Object.keys(afterWorktree.entries).some(
      (path) => selectedPath(path, selected) && beforeWorktree.entries[path] !== afterWorktree.entries[path],
    );
    const evidence = { commit: afterHead, parent, paths: actual.join("\n") };
    if (stagedChanged || selectedIndexChanged || worktreeChanged || selectedChanged) {
      const reason = stagedChanged || selectedIndexChanged ? "hook_changed_index" : worktreeChanged ? "hook_changed_unrelated" : "hook_changed_selected";
      return { commit: afterHead, evidence: { ...evidence, reason, expectedTree: JSON.stringify(expectedTree) }, attention: reason };
    }
    return { commit: afterHead, evidence, attention: null };
  }

  private async archiveCommit(prepared: Prepared, op: DeliveryOperation, message: string, checkpoint?: (kind: string, evidence: Record<string, string>) => Promise<void>): Promise<{ commit: string; evidence: Record<string, string>; attention: string | null }> {
    const root = prepared.root;
    if (op.archivePath === null) return { commit: "", evidence: { reason: "archive_path_missing" }, attention: "archive_path_missing" };
    const recovered = this.findOperationCommit(root, op.operationId, "archive");
    const prior = op.steps.find((item) => item.kind === "archive_commit")?.evidence ?? {};
    if (recovered !== null && isAncestor(root, recovered, "HEAD", this.git)) {
      const actual = commitPaths(root, recovered, this.git);
      const selectedForRecovery = [archiveScope(op.taskPath), op.archivePath];
      const head = gitOrThrow(root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
      if (head !== recovered) {
        return { commit: recovered, evidence: { reason: "archive_scope_mismatch", commit: recovered, head, recovered: "true" }, attention: "archive_scope_mismatch" };
      }
      if (prior.before !== undefined) {
        const parent = gitOrThrow(root, ["rev-parse", `${recovered}^`], "读取提交父节点", this.git);
        if (parent !== prior.before) {
          return { commit: recovered, evidence: { reason: "archive_parent_mismatch", commit: recovered, parent, recovered: "true" }, attention: "archive_parent_mismatch" };
        }
      }
      if (prior.expectedPaths !== undefined) {
        const expectedPaths = prior.expectedPaths.split("\n").filter(Boolean);
        if (!sameSet(actual, expectedPaths)) {
          return {
            commit: recovered,
            evidence: { reason: "archive_scope_mismatch", commit: recovered, expected: prior.expectedPaths, actual: actual.join("\n"), recovered: "true" },
            attention: "archive_scope_mismatch",
          };
        }
      }
      if (prior.expectedTree !== undefined) {
        let expectedTree: Record<string, string> = {};
        try {
          expectedTree = JSON.parse(prior.expectedTree) as Record<string, string>;
        } catch {
          return { commit: recovered, evidence: { reason: "archive_verification_unavailable", commit: recovered }, attention: "archive_verification_unavailable" };
        }
        if (!sameTree(expectedTree, treeSnapshot(root, recovered, selectedForRecovery, this.git), selectedForRecovery)) {
          return { commit: recovered, evidence: { reason: "archive_content_mismatch", commit: recovered, recovered: "true" }, attention: "archive_content_mismatch" };
        }
      }
      const outside = actual.filter((path) => !selectedPath(path, selectedForRecovery));
      if (outside.length > 0) {
        return {
          commit: recovered,
          evidence: { reason: "archive_scope_mismatch", commit: recovered, paths: actual.join("\n"), unexpected: outside.join("\n"), recovered: "true" },
          attention: "archive_scope_mismatch",
        };
      }
      return { commit: recovered, evidence: { commit: recovered, paths: actual.join("\n"), recovered: "true" }, attention: null };
    }
    const targetDir = join(root, op.archivePath);
    const archivedTask = join(targetDir, TASK_FILE);
    if (op.sealDigest !== null && existsSync(archivedTask) && sha256Text(readFileSync(archivedTask, "utf8")) !== op.sealDigest) {
      return { commit: "", evidence: { reason: "seal_version_conflict" }, attention: "seal_version_conflict" };
    }
    const selected = [archiveScope(op.taskPath), op.archivePath];
    const marker = `${op.archivePath}/${SEAL_MARKER}`;
    const beforeHead = gitOrThrow(root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
    if (prior.before !== undefined && beforeHead !== prior.before) {
      return { commit: "", evidence: { reason: "archive_unverified", before: prior.before, head: beforeHead }, attention: "archive_unverified" };
    }
    await checkpoint?.("archive_commit", { before: beforeHead });
    const beforeStaged = stagedSnapshot(root, this.git);
    const beforeWorktree = this.signature(root);
    const expected = dirtyPaths(root, selected, this.git).filter((path) => path !== marker).sort();
    const addable = this.addable(root, selected);
    const stageable = this.stageable(root, addable);
    if (stageable.length > 0) gitOrThrow(root, ["add", "-A", "--", ...stageable], "暂存归档路径", prepared.commitGit);
    // 封存标记不是业务资料，不进入归档提交；保持在 index 外。
    runCommit(root, ["reset", "-q", "--", marker], prepared.commitGit);
    const expectedTree = indexTreeFor(stagedSnapshot(root, this.git), selected);
    if (!existsSync(targetDir)) return { commit: "", evidence: { reason: "archive_target_missing" }, attention: "archive_target_missing" };
    await checkpoint?.("archive_commit", {
      before: beforeHead,
      expectedPaths: expected.join("\n"),
      expectedTree: JSON.stringify(expectedTree),
    });
    const commit = runCommit(root, ["commit", "-m", message, "--only", "--", ...addable], prepared.commitGit);
    const afterHead = gitOrThrow(root, ["rev-parse", "HEAD"], "读取归档提交后 HEAD", this.git);
    if (commit.code !== 0) {
      if (afterHead !== beforeHead && isStageCommit(commitMessage(root, afterHead, this.git), "archive", op.operationId)) {
        // 回执丢失但提交已生效。
      } else {
        return { commit: "", evidence: { reason: "archive_commit_failed", stderr: commit.stderr.trim().slice(0, 500) }, attention: "archive_commit_failed" };
      }
    }
    if (afterHead === beforeHead) return { commit: "", evidence: { reason: "archive_commit_not_created" }, attention: "archive_commit_not_created" };
    if (!isStageCommit(commitMessage(root, afterHead, this.git), "archive", op.operationId)) {
      return { commit: afterHead, evidence: { reason: "commit_message_mismatch", commit: afterHead }, attention: "commit_message_mismatch" };
    }
    const parent = gitOrThrow(root, ["rev-parse", `${afterHead}^`], "读取归档提交父节点", this.git);
    if (parent !== beforeHead) return { commit: afterHead, evidence: { reason: "archive_parent_mismatch", commit: afterHead }, attention: "archive_parent_mismatch" };
    const actual = commitPaths(root, afterHead, this.git);
    if (!sameSet(actual, expected)) {
      return {
        commit: afterHead,
        evidence: { reason: "archive_scope_mismatch", commit: afterHead, expected: expected.join("\n"), actual: actual.join("\n") },
        attention: "archive_scope_mismatch",
      };
    }
    if (!sameTree(expectedTree, treeSnapshot(root, afterHead, selected, this.git), selected)) {
      return {
        commit: afterHead,
        evidence: { reason: "archive_content_mismatch", commit: afterHead },
        attention: "archive_content_mismatch",
      };
    }
    const afterStaged = stagedSnapshot(root, this.git);
    const afterWorktree = this.signature(root);
    const stagedChanged = Object.keys({ ...beforeStaged, ...afterStaged }).some(
      (path) => !selectedPath(path, selected) && beforeStaged[path] !== afterStaged[path],
    );
    const selectedIndexChanged = !sameTree(
      expectedTree,
      indexTreeFor(afterStaged, Object.keys(expectedTree)),
      Object.keys(expectedTree),
    );
    // 任务资料只取短锁，交付窗口内其它会话可并发登记或记录；不当作 hook 副作用。
    const worktreeChanged = Object.keys({ ...beforeWorktree.entries, ...afterWorktree.entries }).some(
      (path) => !selectedPath(path, selected) && !path.startsWith(".knit/tasks/") && beforeWorktree.entries[path] !== afterWorktree.entries[path],
    );
    const selectedChanged = Object.keys(afterWorktree.entries).some(
      (path) => selectedPath(path, selected) && beforeWorktree.entries[path] !== afterWorktree.entries[path],
    );
    const evidence = { commit: afterHead, parent, paths: actual.join("\n") };
    if (stagedChanged || worktreeChanged || selectedChanged) {
      const reason = stagedChanged ? "hook_changed_index" : worktreeChanged ? "hook_changed_unrelated" : "hook_changed_selected";
      return { commit: afterHead, evidence: { ...evidence, reason }, attention: reason };
    }
    return { commit: afterHead, evidence, attention: null };
  }

  private signature(root: string): WorktreeSignature {
    const signature = worktreeSignature(root, this.git);
    if (signature === null) throw new GuardError("git_failed", "无法读取工作区签名");
    return signature;
  }

  private appendFinalRecord(prepared: Prepared, op: DeliveryOperation): { digest: string } {
    const before = readWithVersion(prepared.taskPath);
    if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${prepared.taskPath}`);
    const document = parseTaskDocument(before.data.toString("utf8"), prepared.taskPath);
    const marker = `<!-- knit:delivery:${op.operationId} -->`;
    if (document.progressBody.includes(marker)) return { digest: sha256Text(before.data.toString("utf8")) };
    const verification = prepared.document.frontmatter.verification ?? "independent";
    const resultLine = op.mode === "deliver"
      ? prepared.check !== null
        ? `- 结果: 正常交付；检查 ${prepared.check.runId} 通过；验证 ${verificationLabel(verification, checkerChangedPathsOf(prepared.check))}`
        : `- 结果: 正常交付；完成验证 ${verification}（无独立检查）`
      : `- 结果: 业务${prepared.document.frontmatter.outcome ?? "结束"}；未提交半成品代码`;
    const append = [
      "",
      "### 交付记录",
      "",
      marker,
      `- 操作: ${op.operationId}`,
      `- 时间: ${this.now().toISOString()}`,
      `- 分支: ${op.branch}`,
      `- 授权来源: ${op.authorizationRef ?? "直接 CLI 显式调用"}`,
      `- 调用: ${op.invocation ?? "cli-unverified"}`,
      `- 工作提交: ${op.workCommit ?? "无"}`,
      resultLine,
      `- 归档目标: ${op.archivePath ?? "待移动"}`,
      "",
    ].join("\n");
    const updated = withRegions(document, { progressBody: `${document.progressBody.trimEnd()}\n${append}` });
    const data = Buffer.from(renderTaskDocument(updated), "utf8");
    atomicWrite({ path: prepared.taskPath, data, expectedSha256: before.sha256, mode: 0o644 });
    return { digest: sha256Bytes(data) };
  }

  /** 在资料提交后补记哈希；该补记随归档提交进入档案，不回写已生成资料提交。 */
  private appendMetadataCommitNote(prepared: Prepared, op: DeliveryOperation): string | null {
    const before = readWithVersion(prepared.taskPath);
    if (before === null) return null;
    const text = before.data.toString("utf8");
    const marker = `<!-- knit:metadata-commit:${op.operationId} -->`;
    if (!existsSync(prepared.taskPath)) return null;
    // 上次已写补记但 sealDigest 未落盘：返回当前摘要，允许重入更新封存版本。
    if (text.includes(marker)) return sha256Bytes(before.data);
    const document = parseTaskDocument(text, prepared.taskPath);
    const append = [
      "",
      "### 任务资料提交记录",
      "",
      marker,
      `- 任务资料提交: ${op.metadataCommit ?? "无"}`,
      `- 归档目标: ${op.archivePath ?? "待移动"}`,
      "",
    ].join("\n");
    const updated = withRegions(document, { progressBody: `${document.progressBody.trimEnd()}\n${append}` });
    const data = Buffer.from(renderTaskDocument(updated), "utf8");
    atomicWrite({
      path: prepared.taskPath,
      data,
      expectedSha256: before.sha256,
      mode: 0o644,
    });
    return sha256Bytes(data);
  }

  private hasRecord(taskPath: string, operationId: string): boolean {
    if (!existsSync(taskPath)) return false;
    return readFileSync(taskPath, "utf8").includes(`<!-- knit:delivery:${operationId} -->`);
  }

  private readSeal(taskDir: string): string | null {
    const marker = join(taskDir, SEAL_MARKER);
    if (!existsSync(marker)) return null;
    return readFileSync(marker, "utf8");
  }

  private removeSeal(taskDir: string): void {
    if (taskDir === "") return;
    try {
      rmSync(join(taskDir, SEAL_MARKER), { force: true });
    } catch {
      // 清理失败只留现场，不否定已完成的归档提交。
    }
  }

  private archivePath(root: string, taskDir: string): string {
    const now = this.now();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return relative(root, join(root, ".knit", "tasks", "archive", month, basename(taskDir))).split("\\").join("/");
  }

  private async runsSettled(root: string, taskId: string): Promise<boolean> {
    const runs = new RunStore(root);
    for (const runId of runs.listRunIds()) {
      const request = runs.readRequest(runId);
      if (request === null || request.taskId !== taskId) continue;
      if (!(await runSettled(this.store, runs, runId, request))) return false;
    }
    return true;
  }

  private async validCheck(root: string, taskId: string, binding: TaskBinding, branch: string | null): Promise<CheckFile> {
    return validateCheckEvidence({
      root,
      store: this.store,
      taskId,
      binding,
      branch,
      now: this.now,
      randomHex: this.randomHex,
    });
  }

  /** 交付分类只把本任务来源的采纳目标并入资料提交；规范处理不是交付前置。 */
  private async reviewForTask(taskId: string): Promise<StandardsReview | null> {
    const legacy = await this.store.standardsReviews.latest(taskId);
    const project = (await this.store.standardsReviews.list(PROJECT_SCOPE))
      .filter((review) => review.sourceTaskId === taskId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0] ?? null;
    if (legacy === null) return project;
    if (project === null) return legacy;
    return project.recordedAt >= legacy.recordedAt ? project : legacy;
  }

  private async closeCompleted(root: string, taskId: string): Promise<void> {
    const located = locateTaskDocument(root, taskId);
    const path = join(located.dir, TASK_FILE);
    const before = readWithVersion(path);
    if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${path}`);
    const document = parseTaskDocument(before.data.toString("utf8"), path);
    if (document.frontmatter.status === "closed") {
      if (document.frontmatter.outcome !== "completed") throw new GuardError("task_closed", `任务已结束: ${document.frontmatter.outcome}`);
      return;
    }
    const binding = await this.store.bindings.get(taskId);
    if (binding === null) throw new GuardError("binding_missing", "任务绑定缺失，无法核对完成资格");
    const completionService = new CompletionService({ store: this.store, now: this.now, randomHex: this.randomHex });
    const decision = await completionService.assess({ root, taskId, document, raw: before.data, binding, parentTask: hasChildTasks(root, taskId) });
    if (decision.allowed === false) throw new GuardError(decision.reason, `任务不能完成: ${decision.reason}`);
    const facts: TaskFacts = {
      status: document.frontmatter.status,
      stage: document.frontmatter.stage,
      outcome: document.frontmatter.outcome,
      branch: document.frontmatter.branch,
      pendingKind: binding.pendingDraft?.kind ?? null,
      verification: document.frontmatter.verification,
      visits: binding.stageVisits ?? {},
      stopReason: binding.stopReason ?? null,
    };
    const completion = transition(workflowOf(root), facts, { kind: "completed" });
    if (isTransitionRefusal(completion)) throw new GuardError(completion.reason, "任务不能正常完成");
    const updated = withRegions(document, {
      frontmatter: { ...document.frontmatter, status: completion.status, stage: completion.stage, outcome: completion.outcome },
    });
    completionService.record({ root, taskId, document, raw: before.data, decision, reason: null });
    try {
      atomicWrite({ path, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
    } catch (error) {
      new RunStore(root).removeCompletion(taskId);
      throw error;
    }
    await this.store.bindings.save({
      ...binding,
      pendingDraft: null,
      stageVisits: completion.visits,
      stopReason: completion.stopReason,
    });
  }

  private resultOf(op: DeliveryOperation, complete: boolean): DeliveryResult {
    const messageOf = (stage: "artifact" | "metadata" | "archive") => {
      const message = op.messages?.[stage];
      return message === undefined
        ? null
        : { source: message.source, subject: commitSubject(message.text) };
    };
    return {
      operationId: op.operationId,
      taskId: op.taskId,
      mode: op.mode,
      state: op.state,
      reason: op.reason,
      branch: op.branch,
      workCommit: op.workCommit,
      metadataCommit: op.metadataCommit ?? null,
      archiveCommit: op.archiveCommit,
      archivePath: op.archivePath,
      defaultBranch: op.defaultBranch,
      authorization: op.authorization,
      caller: op.invocation ?? "cli-unverified",
      worktree: op.worktree ?? null,
      needsAttention: !complete || op.state === "needs_attention",
      messages: {
        artifact: messageOf("artifact"),
        metadata: messageOf("metadata"),
        archive: messageOf("archive"),
      },
    };
  }
}

/** 提交引用短哈希；无提交时明确写「无」。 */
function shortHash(oid: string | null): string {
  return oid === null ? "无" : oid.slice(0, 8);
}

/** 内部 Git 调用，避免在服务内重复 import 逻辑。 */
function runCommit(root: string, args: string[], git: GitRunner): { code: number; stdout: string; stderr: string } {
  return git(args, root);
}
