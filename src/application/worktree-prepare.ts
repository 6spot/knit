/**
 * `knit worktree prepare` 核心（任务 k-e48b7df14115；WORKTREE.md §6.7 公共资料与环境准备）。
 * 仅从主检出执行：按 config.worktree 白名单把公共资料／本机文件复制进已登记 worktree，
 * 再按序执行 postCreate 环境步骤（目标 cwd，spawn shell 语义）。逐项记录来源/目标/
 * 基线指纹（git show <baseline>:<target>）/源内容 sha256/处理结果；目标与基线不同
 * （本地修改）、来源符号链接、路径越界即停止报告。manifest+journal+receipt 写
 * `.knit/.runtime/worktree-prepare/<opId>/`，全部成功后原子更新 binding.worktree 的
 * preparedAt/lastPrepareOp；未完成 op 以 receipt 为断点续做（已复制项按目标 sha256 与
 * manifest 源指纹一致跳过，已成功步骤不盲目重跑），无可做工作时 no-op。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { fileFacts, sha256Bytes } from "../infrastructure/fingerprint.js";
import { gitBufferSync } from "../infrastructure/process.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { ensurePrivateDir } from "../infrastructure/private-mode.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { locateTaskDocument, TaskGuardError } from "./task-service.js";
import { verifyRegisteredWorktree, type WorktreeInfo } from "./worktree-manager.js";
import { executionRouteOf } from "./worktree-routing.js";
import { defaultConfig, parseConfig, worktreeConfigOf, type WorktreeCopyConfig } from "./config.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskBinding } from "../contracts/metadata.js";

/** prepare 回执容器（相对项目根）；运行资料按任务边界不进 worktree。 */
export const PREPARE_DIR = join(".knit", ".runtime", "worktree-prepare");
const RECEIPT_FILE = "receipt.json";
const MANIFEST_FILE = "manifest.json";
const JOURNAL_FILE = "journal.jsonl";
/** journal 内单流输出的保留上限（字节）；超出截断并注明总量。 */
const OUTPUT_LIMIT = 8192;

/** manifest 单项：来源/目标/基线指纹/源内容指纹/处理结果（目录白名单已展开为逐文件）。 */
export interface PrepareManifestEntry {
  /** 相对主项目根的 POSIX 路径。 */
  source: string;
  /** 相对 worktree 根的 POSIX 路径。 */
  target: string;
  /** 基线提交中目标路径的内容指纹；基线无该路径为 null。 */
  baselineSha256: string | null;
  /** 应用时的源内容指纹。 */
  sourceSha256: string;
  /** 源文件模式的八进制字符串（保留可执行位）。 */
  mode: string;
  /** 处理结果：copied 本次写入；skipped 目标已与源指纹一致跳过。 */
  result: "copied" | "skipped" | "planned";
}

/** postCreate 步骤的计划与执行结果。 */
export interface PrepareStepRecord {
  name: string;
  command: string;
  outcome: "pending" | "success" | "failed";
  exit: number | null;
  at: string | null;
}

/** prepare 回执：断点续做的依据与全部成功后的绑定更新凭据。 */
export interface PrepareReceipt {
  schemaVersion: 1;
  opId: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  baseline: string;
  /** manifest.json 的确定性指纹；manifest 重写后随回执一并更新。 */
  manifestSha256: string | null;
  steps: PrepareStepRecord[];
  finishedAt: string | null;
}

export type WorktreePrepareMode = "completed" | "resumed" | "no_op";

export interface WorktreePrepareResult {
  taskId: string;
  opId: string;
  /** "completed" 全新执行成功；"resumed" 从断点续做；"no_op" 已一致或无工作可做。 */
  mode: WorktreePrepareMode;
  worktreePath: string;
  branch: string;
  copied: number;
  skipped: number;
  steps: Array<{ name: string; command: string; outcome: PrepareStepRecord["outcome"]; exit: number | null }>;
  finishedAt: string | null;
}

/**
 * 执行前置检查复用：任务绑定登记的 worktree 是否已完成 prepare（任务13接线阶段启动
 * 拦截与路由）。preparedAt 为非空时间戳即视为当前；未登记或未准备均为 false。
 */
export function worktreePrepareCurrent(binding: TaskBinding): boolean {
  const worktree = binding.worktree;
  if (worktree === undefined) return false;
  return typeof worktree.preparedAt === "string" && worktree.preparedAt !== "";
}

interface PreparePaths {
  root: string;
  dir: string;
  manifest: string;
  receipt: string;
  journal: string;
}

function preparePaths(root: string, opId: string): PreparePaths {
  const dir = join(root, PREPARE_DIR, opId);
  return {
    root,
    dir,
    manifest: join(dir, MANIFEST_FILE),
    receipt: join(dir, RECEIPT_FILE),
    journal: join(dir, JOURNAL_FILE),
  };
}

/** 操作 ID；回执目录与登记共用一个名称空间。 */
function newOpId(): string {
  return `op-${randomBytes(6).toString("hex")}`;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** 运行数据与 Git 内部路径不进复制（边界：.runtime 属运行资料，.git 防御性排除）。 */
function isExcludedPath(relativePath: string): boolean {
  return relativePath === ".git" || relativePath.startsWith(".git/") ||
    relativePath === join(".knit", ".runtime") || relativePath.startsWith(`${join(".knit", ".runtime")}/`);
}

/** 白名单相对路径核对：相对、不越界、不在排除范围；返回规范相对 POSIX 路径（不解析符号链接）。 */
function validatedRelative(anchor: string, relativePath: string, label: string, insideLabel: string): string {
  if (relativePath === "") {
    throw new TaskGuardError("prepare_conflict", `白名单${label}不能为空路径`);
  }
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new TaskGuardError("prepare_path_escape", `白名单${label}必须是${insideLabel}相对路径: ${relativePath}`);
  }
  const posix = toPosix(relativePath);
  if (isExcludedPath(posix)) {
    throw new TaskGuardError("prepare_path_escape", `白名单${label}不允许指向运行数据或 Git 内部路径: ${posix}`);
  }
  try {
    // 仅做越界与父级符号链接逃逸核对；不采用返回值，避免把来源符号链接解析成目标文件。
    safeJoin(anchor, relativePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskGuardError("prepare_path_escape", `白名单${label}越界或经符号链接逃逸: ${relativePath}: ${message}`);
  }
  return posix;
}

/** 计划中的单个复制项：源字节与指纹在规划期一次性读取，应用阶段不再变化。 */
interface PlannedCopy {
  entry: PrepareManifestEntry;
  bytes: Buffer;
  /** 应用动作：copy 写入；skip 目标已与源指纹一致。 */
  action: "copy" | "skip";
}

/** 基线提交中目标路径的内容指纹；基线缺失该路径为 null（git show 失败按缺席处理）。 */
function baselineSha256Of(root: string, baseline: string, targetPosix: string): string | null {
  const result = gitBufferSync(["show", `${baseline}:${targetPosix}`], root);
  if (result.code !== 0) return null;
  return sha256Bytes(result.stdout);
}

/** 目标现场判定：不存在或与基线一致才可应用源快照；与源一致视为已完成；其余为本地修改。 */
function targetVerdict(input: {
  worktreePath: string;
  target: string;
  baselineSha256: string | null;
  sourceSha256: string;
}): { action: "copy" | "skip"; problem: string | null } {
  const facts = fileFacts(join(input.worktreePath, input.target));
  if (facts.kind === "absent") return { action: "copy", problem: null };
  if (facts.kind === "link") return { action: "copy", problem: "目标路径是符号链接" };
  if (facts.kind === "directory") return { action: "copy", problem: "目标路径是目录" };
  if (input.baselineSha256 !== null && facts.sha256 === input.baselineSha256) return { action: "copy", problem: null };
  if (facts.sha256 === input.sourceSha256) return { action: "skip", problem: null };
  if (input.baselineSha256 === null) return { action: "copy", problem: "目标存在基线之外的文件" };
  return { action: "copy", problem: "目标与基线内容不同（本地修改）" };
}

/** 读取源文件并登记指纹；符号链接与缺失来源即停（白名单条目与目录展开共用）。 */
function planSourceFile(input: {
  root: string;
  worktreePath: string;
  baseline: string;
  sourceRelative: string;
  targetRelative: string;
  planned: Map<string, PlannedCopy>;
}): void {
  const sourceRel = validatedRelative(input.root, input.sourceRelative, "来源", "项目内");
  const targetRel = validatedRelative(input.worktreePath, input.targetRelative, "复制", "worktree 内");
  const sourceFull = join(input.root, sourceRel);
  let stats;
  try {
    stats = lstatSync(sourceFull);
  } catch {
    throw new TaskGuardError("prepare_conflict", `来源缺失，停止复制: ${sourceRel}`);
  }
  if (stats.isSymbolicLink()) {
    throw new TaskGuardError("prepare_conflict", `来源是符号链接，停止复制: ${sourceRel}`);
  }
  if (!stats.isFile()) {
    throw new TaskGuardError("prepare_conflict", `来源不是常规文件: ${sourceRel}`);
  }
  const bytes = readFileSync(sourceFull);
  const entry: PrepareManifestEntry = {
    source: sourceRel,
    target: targetRel,
    baselineSha256: baselineSha256Of(input.root, input.baseline, targetRel),
    sourceSha256: sha256Bytes(bytes),
    mode: stats.mode.toString(8),
    result: "planned",
  };
  const existing = input.planned.get(entry.target);
  if (existing !== undefined) {
    if (existing.entry.source !== entry.source) {
      throw new TaskGuardError("prepare_conflict", `白名单目标重复且来源不同: ${entry.target}（${existing.entry.source} 与 ${entry.source}）`);
    }
    return; // 同一来源重复列入：同一目标只处理一次。
  }
  const verdict = targetVerdict({
    worktreePath: input.worktreePath,
    target: entry.target,
    baselineSha256: entry.baselineSha256,
    sourceSha256: entry.sourceSha256,
  });
  if (verdict.problem !== null) {
    throw new TaskGuardError(
      "prepare_conflict",
      `${verdict.problem}，停止复制并保留两边: 目标 ${entry.target} ← 来源 ${entry.source}`,
    );
  }
  input.planned.set(entry.target, { entry, bytes, action: verdict.action });
}

/** 目录白名单递归展开；展开中遇符号链接即停（不冒充可复制）。 */
function expandDirectory(input: {
  root: string;
  worktreePath: string;
  baseline: string;
  sourceFull: string;
  sourcePrefix: string;
  targetPrefix: string;
  planned: Map<string, PlannedCopy>;
}): void {
  const list = readdirSync(input.sourceFull, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of list) {
    const childSource = input.sourcePrefix === "" ? item.name : `${input.sourcePrefix}/${item.name}`;
    const childTarget = input.targetPrefix === "" ? item.name : `${input.targetPrefix}/${item.name}`;
    if (item.isSymbolicLink()) {
      throw new TaskGuardError("prepare_conflict", `目录展开遇符号链接，停止复制: ${childSource}`);
    }
    if (item.isDirectory()) {
      expandDirectory({
        root: input.root,
        worktreePath: input.worktreePath,
        baseline: input.baseline,
        sourceFull: join(input.sourceFull, item.name),
        sourcePrefix: childSource,
        targetPrefix: childTarget,
        planned: input.planned,
      });
      continue;
    }
    if (!item.isFile()) continue;
    planSourceFile({
      root: input.root,
      worktreePath: input.worktreePath,
      baseline: input.baseline,
      sourceRelative: childSource,
      targetRelative: childTarget,
      planned: input.planned,
    });
  }
}

/** 白名单展开为逐文件计划；来源缺失、符号链接、越界、目标本地修改都在写盘前停止。 */
function planCopies(input: {
  root: string;
  worktreePath: string;
  baseline: string;
  items: WorktreeCopyConfig[];
}): Map<string, PlannedCopy> {
  const planned = new Map<string, PlannedCopy>();
  for (const item of input.items) {
    const sourceRel = validatedRelative(input.root, item.path, "来源", "项目内");
    const sourceFull = join(input.root, sourceRel);
    let stats;
    try {
      stats = lstatSync(sourceFull);
    } catch {
      throw new TaskGuardError("prepare_conflict", `来源缺失，停止复制: ${sourceRel}`);
    }
    if (stats.isSymbolicLink()) {
      throw new TaskGuardError("prepare_conflict", `来源是符号链接，停止复制: ${sourceRel}`);
    }
    const targetRelative = item.target ?? item.path;
    if (stats.isDirectory()) {
      expandDirectory({
        root: input.root,
        worktreePath: input.worktreePath,
        baseline: input.baseline,
        sourceFull,
        sourcePrefix: sourceRel,
        targetPrefix: validatedRelative(input.worktreePath, targetRelative, "复制", "worktree 内"),
        planned,
      });
      continue;
    }
    planSourceFile({
      root: input.root,
      worktreePath: input.worktreePath,
      baseline: input.baseline,
      sourceRelative: sourceRel,
      targetRelative,
      planned,
    });
  }
  return planned;
}

function writeJournalLine(paths: PreparePaths, stepId: string, kind: string, evidence?: Record<string, unknown>): void {
  const line = JSON.stringify({ stepId, kind, at: new Date().toISOString(), ...(evidence ?? {}) }) + "\n";
  ensurePrivateDir(paths.dir);
  if (!existsSync(paths.journal)) writeFileSync(paths.journal, "", { mode: 0o600 });
  const existing = readFileSync(paths.journal, "utf8");
  writeFileSync(paths.journal, existing + line, { mode: 0o600 });
}

function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n…[knit: 输出截断，共 ${text.length} 字节]`;
}

function saveReceipt(paths: PreparePaths, receipt: PrepareReceipt): void {
  ensurePrivateDir(paths.dir);
  atomicWrite({
    path: paths.receipt,
    data: Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
    mode: 0o600,
  });
}

function saveManifest(paths: PreparePaths, entries: PrepareManifestEntry[]): string {
  ensurePrivateDir(paths.dir);
  const written = atomicWrite({
    path: paths.manifest,
    data: Buffer.from(JSON.stringify({ schemaVersion: 1, entries }, null, 2) + "\n"),
    mode: 0o600,
  });
  return written.sha256;
}

function readManifestEntries(paths: PreparePaths): PrepareManifestEntry[] {
  const version = readWithVersion(paths.manifest);
  if (version === null) {
    throw new TaskGuardError("prepare_state_mismatch", `prepare manifest.json 缺失，无法续做: ${paths.manifest}`);
  }
  let parsed: { schemaVersion?: unknown; entries?: unknown };
  try {
    parsed = JSON.parse(version.data.toString("utf8")) as typeof parsed;
  } catch (error) {
    throw new InfrastructureError("io_error", `manifest.json 不是合法 JSON: ${paths.manifest}: ${String(error)}`);
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new InfrastructureError("io_error", `manifest.json 结构不符: ${paths.manifest}`);
  }
  return parsed.entries as PrepareManifestEntry[];
}

interface StepOutput {
  exit: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** postCreate 步骤以目标 worktree 为 cwd 的 shell 语义执行；stdout/stderr 全量收集后截断入 journal。 */
function runShellStep(command: string, cwd: string): Promise<StepOutput> {
  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => rejectStep(new InfrastructureError("io_error", `步骤命令无法启动: ${command}: ${String(error)}`)));
    child.on("exit", (exit, signal) => resolveStep({ exit, signal, stdout, stderr }));
  });
}

/** 同任务全部 prepare 回执；损坏条目跳过（恢复入口按现场报告）。 */
function receiptsForTask(root: string, taskId: string): Array<{ opId: string; receipt: PrepareReceipt; paths: PreparePaths }> {
  const prepareRoot = join(root, PREPARE_DIR);
  if (!existsSync(prepareRoot)) return [];
  const result: Array<{ opId: string; receipt: PrepareReceipt; paths: PreparePaths }> = [];
  for (const name of readdirSync(prepareRoot).sort()) {
    if (!/^op-[0-9a-f]{12}$/.test(name)) continue;
    const paths = preparePaths(root, name);
    const version = readWithVersion(paths.receipt);
    if (version === null) continue;
    let receipt: PrepareReceipt;
    try {
      receipt = JSON.parse(version.data.toString("utf8")) as PrepareReceipt;
    } catch {
      continue;
    }
    if (receipt.taskId !== taskId) continue;
    result.push({ opId: name, receipt, paths });
  }
  return result;
}

function plannedEntries(planned: Iterable<PlannedCopy>): PrepareManifestEntry[] {
  return [...planned].map((item) => item.entry).sort((a, b) => a.target.localeCompare(b.target));
}

export interface WorktreePrepareOptions {
  store: MetadataStore;
  locks?: LockManager;
  /** 测试注入时钟。 */
  now?: () => Date;
}

export class WorktreePrepareService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly now: () => Date;

  constructor(options: WorktreePrepareOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.now = options.now ?? (() => new Date());
  }

  private taskLockKey(root: string, taskId: string) {
    return { scope: "task" as const, rawKey: `${root}::${taskId}` };
  }

  private async withTaskLock<T>(root: string, taskId: string, action: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }, this.taskLockKey(root, taskId)]),
      action,
    });
    try {
      return await fn();
    } finally {
      this.locks.release(lock);
    }
  }

  private async requireBinding(taskId: string): Promise<TaskBinding> {
    const binding = await this.store.bindings.get(taskId);
    if (binding === null) {
      throw new TaskGuardError("unknown_binding", `任务缺少绑定: ${taskId}`);
    }
    return binding;
  }

  /** 读取项目 config.worktree；配置缺失按默认（空白名单、空步骤），解析失败如实上抛。 */
  private readConfig(root: string): ReturnType<typeof worktreeConfigOf> {
    const path = join(root, ".knit", "config.json");
    if (!existsSync(path)) return worktreeConfigOf(defaultConfig());
    return worktreeConfigOf(parseConfig(readFileSync(path, "utf8")));
  }

  /** 已登记 worktree 核实：binding.worktree 存在且现场与登记一致（复用 create/connect 语义）。 */
  private requireWorktree(root: string, binding: TaskBinding): WorktreeInfo {
    const registered = binding.worktree;
    if (registered === undefined) {
      throw new TaskGuardError("unknown_binding", `任务未登记 worktree，先执行 knit worktree create 或 connect: ${binding.taskId}`);
    }
    const verdict = verifyRegisteredWorktree(root, registered);
    if (!verdict.ok) {
      throw new TaskGuardError("worktree_mismatch", `已登记 worktree 与现场不符，先 connect 或清理现场: ${verdict.problem ?? ""}`);
    }
    return registered;
  }

  async prepare(input: { dir: string; taskId: string; rerun?: string }): Promise<WorktreePrepareResult> {
    const root = normalizeRoot(input.dir);
    // 交接后任务资料权威在 worktree：按执行路由定位，不在主检出重复查找。
    const current = await this.requireBinding(input.taskId);
    const located = locateTaskDocument(executionRouteOf(current, root).dir, input.taskId);
    if (located.archived) {
      throw new TaskGuardError("task_archived", `任务已归档: ${input.taskId}`);
    }
    return await this.withTaskLock(root, input.taskId, "worktree.prepare", async () => {
      const binding = await this.requireBinding(input.taskId);
      const worktree = this.requireWorktree(root, binding);

      // 未完成 op 优先：以 receipt 为断点续做；--rerun 仅在该路径有效。
      const pending = receiptsForTask(root, input.taskId).filter((item) => item.receipt.finishedAt === null);
      const latestPending = pending[pending.length - 1];
      if (latestPending !== undefined) {
        if (input.rerun !== undefined) {
          if (!latestPending.receipt.steps.some((step) => step.name === input.rerun)) {
            throw new TaskGuardError(
              "prepare_unknown_step",
              `--rerun 步骤不存在于未完成操作 ${latestPending.opId}: ${input.rerun}；可用步骤: ${latestPending.receipt.steps.map((step) => step.name).join(", ") || "（无）"}`,
            );
          }
        }
        return await this.resumePending(root, input.taskId, worktree, latestPending, input.rerun);
      }

      if (input.rerun !== undefined) {
        throw new TaskGuardError("prepare_no_pending", `无未完成的 prepare 操作，--rerun 仅在续做时有效: ${input.rerun}`);
      }

      // 已成功 prepare 后重跑：无可做工作，报告已一致（不产生新 op，不盲目重跑步骤）。
      const registeredBinding = binding.worktree;
      const preparedAt = registeredBinding?.preparedAt;
      if (registeredBinding !== undefined && typeof preparedAt === "string" && preparedAt !== "") {
        return await this.reportNoOp(root, input.taskId, worktree, registeredBinding.lastPrepareOp ?? null);
      }

      // 收尾崩溃窗口：回执已完成而绑定更新被中断 → 认领匹配的已完成回执恢复 preparedAt，
      // 不另建新 op（另建会盲目重跑已成功步骤）。
      const matching = receiptsForTask(root, input.taskId).filter((item) =>
        item.receipt.finishedAt !== null &&
        resolve(item.receipt.worktreePath) === resolve(worktree.path) &&
        item.receipt.baseline === worktree.baseline);
      const adopted = matching.length > 0 ? matching[matching.length - 1] : undefined;
      if (adopted !== undefined && adopted.receipt.finishedAt !== null) {
        await this.markPrepared(input.taskId, worktree, adopted.receipt.finishedAt, adopted.opId);
        return {
          taskId: input.taskId,
          opId: adopted.opId,
          mode: "no_op" as const,
          worktreePath: worktree.path,
          branch: worktree.branch,
          copied: 0,
          skipped: 0,
          steps: adopted.receipt.steps.map((step) => ({ name: step.name, command: step.command, outcome: step.outcome, exit: step.exit })),
          finishedAt: adopted.receipt.finishedAt,
        };
      }

      return await this.runFresh(root, input.taskId, worktree);
    });
  }

  /** 全新 prepare：规划（全部核对通过才落盘）→ manifest/receipt → 复制与核验 → 步骤 → 绑定。 */
  private async runFresh(root: string, taskId: string, worktree: WorktreeInfo): Promise<WorktreePrepareResult> {
    const config = this.readConfig(root);
    const steps: PrepareStepRecord[] = config.postCreate.map((step, index) => {
      const name = step.name ?? `step-${index + 1}`;
      return { name, command: step.command, outcome: "pending" as const, exit: null, at: null };
    });
    const names = new Set<string>();
    for (const step of steps) {
      if (names.has(step.name)) {
        throw new TaskGuardError("prepare_conflict", `postCreate 步骤名称重复（含缺省序号名）: ${step.name}`);
      }
      names.add(step.name);
    }
    // 规划期完成全部白名单核对；任一冲突在创建 op 前停止，现场不被触碰。
    const planned = planCopies({ root, worktreePath: worktree.path, baseline: worktree.baseline, items: config.copy });

    const opId = newOpId();
    const paths = preparePaths(root, opId);
    ensurePrivateDir(paths.dir);
    writeJournalLine(paths, "plan", "planned", {
      taskId,
      copies: planned.size,
      steps: steps.map((step) => step.name),
      worktree: worktree.path,
      baseline: worktree.baseline,
    });
    // manifest 先落盘（result=planned）：复制中途中断时恢复入口可按指纹识别已完成项。
    const initialEntries = plannedEntries(planned.values()).map((entry) => ({ ...entry }));
    const manifestSha256 = saveManifest(paths, initialEntries);
    const receipt: PrepareReceipt = {
      schemaVersion: 1,
      opId,
      taskId,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseline: worktree.baseline,
      manifestSha256,
      steps,
      finishedAt: null,
    };
    saveReceipt(paths, receipt);

    // 应用：规划期字节快照逐项写入（目标已与源一致按跳过处理），写完重算指纹核验。
    let copied = 0;
    let skipped = 0;
    for (const item of planned.values()) {
      if (item.action === "skip") {
        item.entry.result = "skipped";
        skipped += 1;
        continue;
      }
      this.writeCopy(worktree.path, item.entry, item.bytes);
      item.entry.result = "copied";
      copied += 1;
    }
    const entries = plannedEntries(planned.values());
    this.verifyCopies(worktree.path, entries);
    receipt.manifestSha256 = saveManifest(paths, entries);
    saveReceipt(paths, receipt);
    if (entries.length > 0) {
      writeJournalLine(paths, "copy", "applied", { copied, skipped: entries.length - copied });
      writeJournalLine(paths, "verify", "applied", { count: entries.length });
    }

    const finishedAt = await this.runStepsAndFinish(paths, receipt, worktree, undefined);
    // 空白名单与空步骤：无可做工作，按 no-op 报告已一致（回执与 preparedAt 仍落库供前置检查）。
    const mode: WorktreePrepareMode = planned.size === 0 && steps.length === 0 ? "no_op" : "completed";
    return {
      taskId,
      opId: receipt.opId,
      mode,
      worktreePath: worktree.path,
      branch: worktree.branch,
      copied,
      skipped: entries.length - copied,
      steps: receipt.steps.map((step) => ({ name: step.name, command: step.command, outcome: step.outcome, exit: step.exit })),
      finishedAt,
    };
  }

  /** 中断恢复：以 receipt 为断点，已复制项按指纹跳过，未完成步骤继续，已成功步骤不盲目重跑。 */
  private async resumePending(
    root: string,
    taskId: string,
    worktree: WorktreeInfo,
    pending: { opId: string; receipt: PrepareReceipt; paths: PreparePaths },
    rerun: string | undefined,
  ): Promise<WorktreePrepareResult> {
    const receipt = pending.receipt;
    const paths = pending.paths;
    if (resolve(receipt.worktreePath) !== resolve(worktree.path) || receipt.baseline !== worktree.baseline) {
      throw new TaskGuardError(
        "prepare_state_mismatch",
        `未完成 prepare 回执与当前绑定不符（worktree/基线变化），先人工核实: ${paths.dir}`,
      );
    }
    const entries = readManifestEntries(paths);
    if (entries.length > 0) writeJournalLine(paths, "resume", "planned", { opId: receipt.opId, rerun: rerun ?? null });

    // 逐项按「目标 sha256 == manifest 源指纹」判定已完成；未完成项以当前源内容重做并更新指纹。
    let copied = 0;
    let skipped = 0;
    for (const entry of entries) {
      validatedRelative(worktree.path, entry.target, "复制", "worktree 内");
      const facts = fileFacts(join(worktree.path, entry.target));
      if (facts.kind === "file" && facts.sha256 === entry.sourceSha256) {
        entry.result = "skipped";
        skipped += 1;
        continue;
      }
      validatedRelative(root, entry.source, "来源", "项目内");
      const sourceFull = join(root, entry.source);
      let stats;
      try {
        stats = lstatSync(sourceFull);
      } catch {
        throw new TaskGuardError("prepare_conflict", `来源缺失，停止复制: ${entry.source}`);
      }
      if (stats.isSymbolicLink()) {
        throw new TaskGuardError("prepare_conflict", `来源是符号链接，停止复制: ${entry.source}`);
      }
      if (!stats.isFile()) {
        throw new TaskGuardError("prepare_conflict", `来源不是常规文件: ${entry.source}`);
      }
      const bytes = readFileSync(sourceFull);
      entry.sourceSha256 = sha256Bytes(bytes);
      entry.mode = stats.mode.toString(8);
      const verdict = targetVerdict({
        worktreePath: worktree.path,
        target: entry.target,
        baselineSha256: baselineSha256Of(root, receipt.baseline, entry.target),
        sourceSha256: entry.sourceSha256,
      });
      if (verdict.problem !== null) {
        throw new TaskGuardError(
          "prepare_conflict",
          `${verdict.problem}，停止复制并保留两边: 目标 ${entry.target} ← 来源 ${entry.source}`,
        );
      }
      this.writeCopy(worktree.path, entry, bytes);
      entry.result = "copied";
      copied += 1;
    }
    this.verifyCopies(worktree.path, entries);
    receipt.manifestSha256 = saveManifest(paths, entries);
    saveReceipt(paths, receipt);
    if (entries.length > 0) {
      writeJournalLine(paths, "copy", "applied", { copied, skipped });
      writeJournalLine(paths, "verify", "applied", { count: entries.length });
    }

    const finishedAt = await this.runStepsAndFinish(paths, receipt, worktree, rerun);
    return {
      taskId,
      opId: receipt.opId,
      mode: "resumed",
      worktreePath: worktree.path,
      branch: worktree.branch,
      copied,
      skipped,
      steps: receipt.steps.map((step) => ({ name: step.name, command: step.command, outcome: step.outcome, exit: step.exit })),
      finishedAt,
    };
  }
  /** 已成功后的 no-op 报告：读取最近完成回执作为凭据；回执缺失时按绑定最小报告。 */
  private async reportNoOp(root: string, taskId: string, worktree: WorktreeInfo, lastOpId: string | null): Promise<WorktreePrepareResult> {
    const completed = lastOpId === null ? [] : receiptsForTask(root, taskId).filter((item) => item.receipt.finishedAt !== null && item.opId === lastOpId);
    const latest = completed[completed.length - 1];
    return {
      taskId,
      opId: lastOpId ?? "",
      mode: "no_op",
      worktreePath: worktree.path,
      branch: worktree.branch,
      copied: 0,
      skipped: 0,
      steps: latest === undefined ? [] : latest.receipt.steps.map((step) => ({ name: step.name, command: step.command, outcome: step.outcome, exit: step.exit })),
      finishedAt: latest === undefined ? null : latest.receipt.finishedAt,
    };
  }

  /** 单项写入：父目录 0755，内容原子写并保留源文件模式（复制保留源文件，不动主检出）。 */
  private writeCopy(worktreePath: string, entry: PrepareManifestEntry, bytes: Buffer): void {
    const targetFull = join(worktreePath, entry.target);
    mkdirSync(dirname(targetFull), { recursive: true, mode: 0o755 });
    atomicWrite({ path: targetFull, data: bytes, mode: parseInt(entry.mode, 8) & 0o777 });
  }

  /** 逐项重算目标侧指纹；任一不符即报 io_error（复制不完整，不进入步骤阶段）。 */
  private verifyCopies(worktreePath: string, entries: PrepareManifestEntry[]): void {
    const problems: string[] = [];
    for (const entry of entries) {
      const facts = fileFacts(join(worktreePath, entry.target));
      if (facts.kind !== "file" || facts.sha256 !== entry.sourceSha256) {
        problems.push(`${entry.target}（期望 ${entry.sourceSha256.slice(0, 12)}）`);
      }
    }
    if (problems.length > 0) {
      throw new InfrastructureError("io_error", `复制核验未通过（${problems.length} 项），保留现场待核实: ${problems.slice(0, 5).join("; ")}`);
    }
  }

  /**
   * 步骤执行与收尾：按序跳过已成功步骤（--rerun 指名重跑），每步前先落盘 journal，
   * 失败即停并保留现场；全部成功后回执 finishedAt 并原子更新 binding。
   */
  private async runStepsAndFinish(
    paths: PreparePaths,
    receipt: PrepareReceipt,
    worktree: WorktreeInfo,
    rerun: string | undefined,
  ): Promise<string> {
    const worktreePath = receipt.worktreePath;
    for (const [index, step] of receipt.steps.entries()) {
      if (step.outcome === "success" && step.name !== rerun) continue;
      writeJournalLine(paths, step.name, "planned", { command: step.command, index });
      let output: StepOutput;
      try {
        output = await runShellStep(step.command, worktreePath);
      } catch (error) {
        // 启动失败按失败步骤处理：记录现场后原样上抛，保留已成功步骤与已复制资料。
        writeJournalLine(paths, step.name, "failed", { command: step.command, error: String(error) });
        throw error;
      }
      const succeeded = output.exit === 0;
      step.outcome = succeeded ? "success" : "failed";
      step.exit = output.exit;
      step.at = this.now().toISOString();
      writeJournalLine(paths, step.name, succeeded ? "applied" : "failed", {
        command: step.command,
        exit: output.exit,
        signal: output.signal,
        stdout: truncateOutput(output.stdout),
        stderr: truncateOutput(output.stderr),
      });
      saveReceipt(paths, receipt);
      if (!succeeded) {
        throw new TaskGuardError(
          "prepare_step_failed",
          `postCreate 步骤失败: ${step.name}（exit ${output.exit ?? "signal " + (output.signal ?? "?")}）；已保留目录、已复制资料与已成功步骤。` +
            `回执与 journal: ${paths.dir}；恢复: knit worktree prepare --task ${receipt.taskId}（--rerun ${step.name} 重跑该步）`,
        );
      }
    }
    const finishedAt = this.now().toISOString();
    receipt.finishedAt = finishedAt;
    saveReceipt(paths, receipt);
    writeJournalLine(paths, "finish", "completed", { finishedAt });
    await this.markPrepared(receipt.taskId, worktree, finishedAt, receipt.opId);
    return finishedAt;
  }

  /** 核验成功后的绑定更新：worktree.preparedAt/lastPrepareOp；主字段与 relativePath 不变。 */
  private async markPrepared(taskId: string, worktree: WorktreeInfo, finishedAt: string, opId: string): Promise<void> {
    const current = await this.requireBinding(taskId);
    const next: TaskBinding = {
      ...current,
      worktree: { ...worktree, preparedAt: finishedAt, lastPrepareOp: opId },
    };
    await this.store.bindings.save(next);
  }
}
