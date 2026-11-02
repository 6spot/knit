/**
 * deliver／archive 确定性收尾（DESIGN.md 第10–11节、STATES.md 第11节）。
 * 先落盘操作意图与步骤；Git、封存、移动和归档提交分别核验。
 * 模型报告与 worker 报告不参与这里的 Git 事实判断。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { TaskBinding } from "../contracts/metadata.js";
import type {
  AuthorizationSource,
  DeliveryOperation,
  DeliveryRecord,
  DeliveryResult,
  DeliveryStep,
} from "../contracts/delivery.js";
import type { CheckFile } from "../contracts/run.js";
import type { OperationState } from "../contracts/metadata.js";
import { onComplete, type TaskFacts } from "../domain/task.js";
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
import { GuardError } from "./guard-error.js";
import { loadScope } from "./scope.js";
import { StandardsService } from "./standards-service.js";
import { locateTaskDocument } from "./task-service.js";
import { parseTaskDocument, renderTaskDocument, withRegions } from "./task-document.js";
import { parseConfig, defaultConfig, type ProjectConfig } from "./config.js";
import { worktreeSignature, type WorktreeSignature } from "./worktree.js";
import {
  branchExists,
  commitExists,
  commitMessage,
  commitPaths,
  currentBranch,
  defaultBranchCandidate,
  dirtyPaths,
  gitOrThrow,
  isAncestor,
  indexTreeFor,
  isFullBranch,
  policyVersion,
  recheckAuthorization,
  resolveAuthorization,
  sameSet,
  selectedPath,
  stagedSnapshot,
  sameTree,
  treeSnapshot,
  type GitRunner,
} from "./delivery.js";

const SEAL_MARKER = ".knit-sealed";
const TASK_FILE = "task.md";
const RUNTIME_PREFIX = ".knit/.runtime";

export interface DeliveryInput {
  dir: string;
  taskId: string;
  branch: string;
  authorizationRef?: string | null;
  caller?: "cli" | "agent";
  /** 显式重试 needs_attention：先核验已完成效果，不盲目重复提交。 */
  retry?: boolean;
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
  selected: string[];
  defaultBranch: DeliveryResult["defaultBranch"];
  authorization: AuthorizationSource;
  policyVersion: string;
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

  private async run(input: DeliveryInput & { mode: "deliver" | "archive" }): Promise<DeliveryResult> {
    const root = normalizeRoot(input.dir);
    const caller = input.caller ?? "cli";
    const existing = await this.latestOperation(root, input.taskId);
    if (existing?.state === "completed") {
      return this.resultOf(existing, true);
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

    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, input.taskId)]),
      action: input.mode === "deliver" ? "delivery.deliver" : "delivery.archive",
    });
    try {
      const latest = await this.latestOperation(root, input.taskId);
      if (latest?.state === "completed") return this.resultOf(latest, true);
      if (latest?.state === "needs_attention" && input.retry !== true) return this.resultOf(latest, false);
      const operation = latest ?? (await this.createOperation(root, input, caller));
      recheckAuthorization(root, operation.authorization, caller);
      const prepared = await this.prepare(root, input, operation, caller);
      return await this.execute(prepared, operation);
    } finally {
      this.locks.release(lock);
    }
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

  private async createOperation(
    root: string,
    input: DeliveryInput & { mode: "deliver" | "archive" },
    caller: "cli" | "agent",
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
      if (located.document.frontmatter.phase !== "deliver") {
        throw new GuardError("phase_mismatch", `任务不在交付阶段: ${located.document.frontmatter.phase}`);
      }
    } else {
      const status = located.document.frontmatter.status;
      const outcome = located.document.frontmatter.outcome;
      if (status !== "closed" || (outcome !== "cancelled" && outcome !== "superseded")) {
        throw new GuardError("deliver_required", "archive 只归档已取消／被替代的任务；正常完成先走 deliver");
      }
    }
    const config = this.readConfig(root);
    const authorization = resolveAuthorization(root, input.authorizationRef ?? null, caller);
    const defaultBranch = defaultBranchCandidate(root, config, this.git);
    const now = this.now().toISOString();
    const steps: DeliveryStep[] = (input.mode === "deliver"
      ? ["work_commit", "final_record", "seal", "move", "archive_commit"]
      : ["final_record", "seal", "move", "archive_commit"]
    ).map((kind, index) => ({
      stepId: `${index + 1}-${kind}`,
      kind,
      state: "planned" as OperationState,
      before: null,
      after: null,
      evidence: null,
    }));
    const operation: DeliveryOperation = {
      operationId: `op-${this.randomHex(6)}`,
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
      defaultBranch,
      policyVersion: policyVersion(root, config),
      taskPath: relative(root, join(located.dir, TASK_FILE)).split("\\").join("/"),
      // 首次目标固定，跨月恢复也使用同一 archivePath。
      archivePath: this.archivePath(root, located.dir),
      workCommit: null,
      archiveCommit: null,
      sealDigest: null,
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

  private async prepare(
    root: string,
    input: DeliveryInput & { mode: "deliver" | "archive" },
    operation: DeliveryOperation,
    caller: "cli" | "agent",
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
    let check: CheckFile | null = null;
    if (!located.archived && (operation.mode === "deliver" || (operation.mode === "archive" && operation.kind === "delivery.deliver"))) {
      check = await this.validCheck(root, input.taskId, binding, branch);
      if (!runsSettled) throw new GuardError("runs_unsettled", "任务仍有活动／未知运行或待接收结果");
      await this.standardsGate(root, input.taskId);
    } else if (!located.archived) {
      await this.standardsGate(root, input.taskId);
    }

    const scope = loadScope(new RunStore(root), input.taskId, this.now().toISOString());
    const review = await this.store.standardsReviews.latest(input.taskId);
    const selected = new Set<string>([relative(root, taskDir).split("\\").join("/")]);
    for (const entry of scope.entries) selected.add(entry.path);
    for (const target of review?.targets ?? []) selected.add(target);
    if ((review?.targets.length ?? 0) > 0) selected.add(".knit/standards/index.md");
    const selectedPaths = [...selected].filter((path) => path !== RUNTIME_PREFIX && !path.startsWith(`${RUNTIME_PREFIX}/`)).sort();
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
      defaultBranch,
      authorization,
      policyVersion: operation.policyVersion,
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

    // 1. 正常完成收束为 closed/completed；取消／替代已在 task close 完成。
    if (op.mode === "deliver") {
      await this.closeCompleted(prepared.root, op.taskId);
    }

    // 2. 工作提交（仅正常交付）。
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
            this.findOperationCommit(prepared.root, op.operationId, "knit: archive") !== null;
          if (!archiveStarted) {
            const head = gitOrThrow(prepared.root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
            if (head !== oid) return attention("work_commit", "work_commit_head_advanced", { commit: oid, head });
          }
        }
      } else if (op.workCommit !== null) {
        // 上次已产生提交但被 hook 等置 needs_attention：显式重试只核实，不重复提交。
        if (!commitExists(prepared.root, op.workCommit, this.git)) return attention("work_commit", "step_effect_missing");
        if (!commitMessage(prepared.root, op.workCommit, this.git).includes(op.operationId)) {
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

    // 4. 封存固定版本。
    const seal = step("seal");
    if (seal?.state === "completed") {
      const marker = this.readSeal(prepared.taskDir);
      const archiveAlreadyCommitted = step("archive_commit")?.state === "completed" ||
        this.findOperationCommit(prepared.root, op.operationId, "knit: archive") !== null;
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
      if (!commitMessage(prepared.root, op.archiveCommit, this.git).includes(op.operationId)) {
        return attention("archive_commit", "archive_message_mismatch", { commit: op.archiveCommit });
      }
      const head = gitOrThrow(prepared.root, ["rev-parse", "HEAD"], "读取 HEAD", this.git);
      if (head !== op.archiveCommit) return attention("archive_commit", "archive_scope_mismatch", { commit: op.archiveCommit, head });
      const prior = archiveCommit?.evidence ?? {};
      if (prior.before !== undefined) {
        const parent = gitOrThrow(prepared.root, ["rev-parse", `${op.archiveCommit}^`], "读取归档提交父节点", this.git);
        if (parent !== prior.before) return attention("archive_commit", "archive_parent_mismatch", { commit: op.archiveCommit, parent });
      }
      const selected = [op.taskPath.startsWith(".knit/") ? op.taskPath : `.knit/${op.taskPath}`, op.archivePath ?? ""];
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
      const result = await this.archiveCommit(prepared, op, checkpoint);
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

  /** 回执丢失时按唯一操作 ID 在历史中核实已生效提交，不重复提交。 */
  private findOperationCommit(root: string, operationId: string, prefix: string): string | null {
    const result = this.git(["log", "--all", "--format=%H", "--all-match", "--fixed-strings", `--grep=${prefix}`, `--grep=${operationId}`], root);
    if (result.code !== 0) return null;
    for (const oid of result.stdout.split(/\s+/).filter(Boolean)) {
      const message = commitMessage(root, oid, this.git);
      if (message.includes(`${prefix} `) && message.includes(operationId)) return oid;
    }
    return null;
  }

  private async workCommit(prepared: Prepared, op: DeliveryOperation, checkpoint?: (kind: string, evidence: Record<string, string>) => Promise<void>): Promise<{ commit: string | null; evidence: Record<string, string>; attention: string | null }> {
    const root = prepared.root;
    const recovered = this.findOperationCommit(root, op.operationId, "knit: deliver");
    const prior = op.steps.find((item) => item.kind === "work_commit")?.evidence ?? {};
    if (recovered !== null && isAncestor(root, recovered, "HEAD", this.git)) {
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
        if (!sameTree(expectedTree, treeSnapshot(root, recovered, prepared.selected, this.git), prepared.selected)) {
          return { commit: recovered, evidence: { reason: "hook_changed_selected", commit: recovered, recovered: "true" }, attention: "hook_changed_selected" };
        }
      }
      const outside = actual.filter((path) => !selectedPath(path, prepared.selected));
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
    await checkpoint?.("work_commit", { before: beforeHead });
    const beforeStaged = stagedSnapshot(root, this.git);
    const beforeWorktree = this.signature(root);
    const expected = dirtyPaths(root, prepared.selected, this.git);
    if (expected.length === 0) {
      return { commit: null, evidence: { skipped: "true", reason: "no_selected_changes", before: beforeHead }, attention: null };
    }
    const addable = this.addable(root, prepared.selected);
    const stageable = this.stageable(root, addable);
    if (stageable.length > 0) gitOrThrow(root, ["add", "-A", "--", ...stageable], "暂存交付路径", this.git);
    const expectedTree = indexTreeFor(stagedSnapshot(root, this.git), prepared.selected);
    await checkpoint?.("work_commit", {
      before: beforeHead,
      expectedPaths: expected.join("\n"),
      expectedTree: JSON.stringify(expectedTree),
    });
    const message = `knit: deliver ${op.taskId} (${op.operationId})`;
    const commit = runCommit(root, ["commit", "-m", message, "--only", "--", ...addable], this.git);
    const afterHead = gitOrThrow(root, ["rev-parse", "HEAD"], "读取提交后 HEAD", this.git);
    if (commit.code !== 0) {
      if (afterHead !== beforeHead && commitMessage(root, afterHead, this.git).includes(op.operationId)) {
        // 回执丢失但提交已生效：按真实提交继续核对，不重复提交。
      } else {
        return { commit: null, evidence: { reason: "git_commit_failed", stderr: commit.stderr.trim().slice(0, 500) }, attention: "git_commit_failed" };
      }
    }
    if (afterHead === beforeHead) {
      return { commit: null, evidence: { reason: "commit_not_created" }, attention: "commit_not_created" };
    }
    if (!commitMessage(root, afterHead, this.git).includes(op.operationId)) {
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
    if (!sameTree(expectedTree, treeSnapshot(root, afterHead, prepared.selected, this.git), prepared.selected)) {
      return {
        commit: afterHead,
        evidence: { reason: "hook_changed_selected", commit: afterHead, expectedTree: JSON.stringify(expectedTree) },
        attention: "hook_changed_selected",
      };
    }
    const afterStaged = stagedSnapshot(root, this.git);
    const afterWorktree = this.signature(root);
    const stagedChanged = Object.keys({ ...beforeStaged, ...afterStaged }).some(
      (path) => !selectedPath(path, prepared.selected) && beforeStaged[path] !== afterStaged[path],
    );
    const selectedIndexChanged = !sameTree(
      expectedTree,
      indexTreeFor(afterStaged, Object.keys(expectedTree)),
      Object.keys(expectedTree),
    );
    const worktreeChanged = Object.keys({ ...beforeWorktree.entries, ...afterWorktree.entries }).some(
      (path) => !selectedPath(path, prepared.selected) && beforeWorktree.entries[path] !== afterWorktree.entries[path],
    );
    // 提交后选中路径会从脏列表消失；只有提交后仍脏且内容变化才说明 hook 改了选中文件。
    const selectedChanged = Object.keys(afterWorktree.entries).some(
      (path) => selectedPath(path, prepared.selected) && beforeWorktree.entries[path] !== afterWorktree.entries[path],
    );
    const evidence = { commit: afterHead, parent, paths: actual.join("\n") };
    if (stagedChanged || selectedIndexChanged || worktreeChanged || selectedChanged) {
      const reason = stagedChanged || selectedIndexChanged ? "hook_changed_index" : worktreeChanged ? "hook_changed_unrelated" : "hook_changed_selected";
      return { commit: afterHead, evidence: { ...evidence, reason, expectedTree: JSON.stringify(expectedTree) }, attention: reason };
    }
    return { commit: afterHead, evidence, attention: null };
  }

  private async archiveCommit(prepared: Prepared, op: DeliveryOperation, checkpoint?: (kind: string, evidence: Record<string, string>) => Promise<void>): Promise<{ commit: string; evidence: Record<string, string>; attention: string | null }> {
    const root = prepared.root;
    if (op.archivePath === null) return { commit: "", evidence: { reason: "archive_path_missing" }, attention: "archive_path_missing" };
    const recovered = this.findOperationCommit(root, op.operationId, "knit: archive");
    const prior = op.steps.find((item) => item.kind === "archive_commit")?.evidence ?? {};
    if (recovered !== null && isAncestor(root, recovered, "HEAD", this.git)) {
      const actual = commitPaths(root, recovered, this.git);
      const selectedForRecovery = [op.taskPath.startsWith(".knit/") ? op.taskPath : `.knit/${op.taskPath}`, op.archivePath];
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
    const selected = [op.taskPath.startsWith(".knit/") ? op.taskPath : `.knit/${op.taskPath}`, op.archivePath];
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
    if (stageable.length > 0) gitOrThrow(root, ["add", "-A", "--", ...stageable], "暂存归档路径", this.git);
    // 封存标记不是业务资料，不进入归档提交；保持在 index 外。
    runCommit(root, ["reset", "-q", "--", marker], this.git);
    const expectedTree = indexTreeFor(stagedSnapshot(root, this.git), selected);
    if (!existsSync(targetDir)) return { commit: "", evidence: { reason: "archive_target_missing" }, attention: "archive_target_missing" };
    await checkpoint?.("archive_commit", {
      before: beforeHead,
      expectedPaths: expected.join("\n"),
      expectedTree: JSON.stringify(expectedTree),
    });
    const message = `knit: archive ${op.taskId} (${op.operationId})`;
    const commit = runCommit(root, ["commit", "-m", message, "--only", "--", ...addable], this.git);
    const afterHead = gitOrThrow(root, ["rev-parse", "HEAD"], "读取归档提交后 HEAD", this.git);
    if (commit.code !== 0) {
      if (afterHead !== beforeHead && commitMessage(root, afterHead, this.git).includes(op.operationId)) {
        // 回执丢失但提交已生效。
      } else {
        return { commit: "", evidence: { reason: "archive_commit_failed", stderr: commit.stderr.trim().slice(0, 500) }, attention: "archive_commit_failed" };
      }
    }
    if (afterHead === beforeHead) return { commit: "", evidence: { reason: "archive_commit_not_created" }, attention: "archive_commit_not_created" };
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
    const worktreeChanged = Object.keys({ ...beforeWorktree.entries, ...afterWorktree.entries }).some(
      (path) => !selectedPath(path, selected) && beforeWorktree.entries[path] !== afterWorktree.entries[path],
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
    const resultLine = op.mode === "deliver"
      ? `- 结果: 正常交付；检查 ${prepared.check?.runId ?? "unknown"} 通过`
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

  private async validCheck(root: string, taskId: string, binding: TaskBinding, branch: string): Promise<CheckFile> {
    if (binding.lastCheckRunId === null) throw new GuardError("check_missing", "没有可交付的检查");
    const check = new RunStore(root).readCheck(binding.lastCheckRunId);
    if (check === null) throw new GuardError("check_missing", `检查凭据缺失: ${binding.lastCheckRunId}`);
    if (check.verdict !== "pass") throw new GuardError("check_not_passed", `最新检查结论不是 pass: ${check.verdict}`);
    if (check.branch !== branch) throw new GuardError("check_stale", "检查分支与当前交付分支不一致");
    const plan = await new ContextPlanner({ store: this.store, now: this.now, randomHex: this.randomHex }).plan({
      dir: root,
      taskId,
      role: "check",
    });
    if (!plan.ready) throw new GuardError("check_stale", `检查上下文不再 ready: ${plan.blockers.join(",")}`);
    if (
      check.inputsDigest !== plan.inputsDigest ||
      check.standardsDigest !== plan.standardsDigest ||
      check.effectiveInputsDigest !== plan.effectiveInputsDigest
    ) {
      throw new GuardError("check_stale", "检查后输入或正式规范变化");
    }
    if (binding.confirmedInputsDigest !== plan.inputsDigest || binding.confirmedStandardsDigest !== plan.standardsDigest) {
      throw new GuardError("check_stale", "任务冻结摘要与当前输入／规范不一致");
    }
    const scope = loadScope(new RunStore(root), taskId, this.now().toISOString());
    if (check.scopeDigest !== scope.digest) throw new GuardError("check_stale", "检查后成果范围变化");
    return check;
  }

  private async standardsGate(root: string, taskId: string): Promise<void> {
    const service = new StandardsService({ store: this.store, locks: this.locks, now: this.now, randomHex: this.randomHex });
    const pending = await service.pending({ dir: root, taskId });
    if (pending.needsReview) throw new GuardError("standards_review_required", `规范候选待审阅: ${pending.reason}`);
    const review = pending.matchedReview;
    if (review !== null && (review.decision === "applied" || review.decision === "mixed")) {
      const targets = review.targets.map((target) => {
        const path = join(root, target);
        return existsSync(path) ? readFileSync(path, "utf8") : "";
      }).join("\n");
      const required = review.decision === "applied" ? review.candidateIds : review.candidateIds.slice(0, 1);
      for (const candidateId of required) {
        if (!targets.includes(`来源：任务 ${taskId}／候选 ${candidateId}。`)) {
          throw new GuardError("standards_apply_required", `候选 ${candidateId} 已审阅采纳但尚未写入正式规范`);
        }
      }
    }
  }

  private async closeCompleted(root: string, taskId: string): Promise<void> {
    const located = locateTaskDocument(root, taskId);
    const path = join(located.dir, TASK_FILE);
    const before = readWithVersion(path);
    if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${path}`);
    const document = parseTaskDocument(before.data.toString("utf8"), path);
    const facts: TaskFacts = {
      status: document.frontmatter.status,
      phase: document.frontmatter.phase,
      outcome: document.frontmatter.outcome,
      branch: document.frontmatter.branch,
      pendingKind: null,
    };
    if (facts.status === "closed") {
      if (facts.outcome !== "completed") throw new GuardError("task_closed", `任务已结束: ${facts.outcome}`);
      return;
    }
    const transition = onComplete(facts);
    if ("allowed" in transition && transition.allowed === false) throw new GuardError(transition.reason, "任务不能正常完成");
    if (!("phase" in transition)) throw new GuardError("transition_invalid", "完成转移无效");
    const updated = withRegions(document, { frontmatter: { ...document.frontmatter, status: transition.status, phase: transition.phase, outcome: transition.outcome } });
    atomicWrite({ path, data: Buffer.from(renderTaskDocument(updated), "utf8"), expectedSha256: before.sha256, mode: 0o644 });
    const binding = await this.store.bindings.get(taskId);
    if (binding !== null) await this.store.bindings.save({ ...binding, pendingDraft: null });
  }

  private resultOf(op: DeliveryOperation, complete: boolean): DeliveryResult {
    return {
      operationId: op.operationId,
      taskId: op.taskId,
      mode: op.mode,
      state: op.state,
      reason: op.reason,
      branch: op.branch,
      workCommit: op.workCommit,
      archiveCommit: op.archiveCommit,
      archivePath: op.archivePath,
      defaultBranch: op.defaultBranch,
      authorization: op.authorization,
      needsAttention: !complete || op.state === "needs_attention",
    };
  }
}

/** 内部 Git 调用，避免在服务内重复 import 逻辑。 */
function runCommit(root: string, args: string[], git: GitRunner): { code: number; stdout: string; stderr: string } {
  return git(args, root);
}
