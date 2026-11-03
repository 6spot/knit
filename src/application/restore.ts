/**
 * 快照对照与逐路径恢复（DESIGN.md 第13节、OPERATIONS.md 第3节）。
 *
 * 默认只预览；提供 --expect 后才写。选中路径的当前指纹、分支、仓库和
 * index 任一变化即停；不 stash apply、不整仓 reset，也不覆盖 Task 记录。
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, chmodSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Value } from "typebox/value";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { SnapshotEntry, SnapshotManifest } from "../contracts/run.js";
import { RestoreRecordSchema, type RestorePathPlan, type RestorePathState, type RestoreRecord, type RestoreIndexState } from "../contracts/restore.js";
import { inputsDigestOf, verificationModeOf } from "../contracts/task-inputs.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import { gitBufferSync, gitSync } from "../infrastructure/process.js";
import { RunStore } from "../infrastructure/run-store.js";
import { GuardError } from "./guard-error.js";
import { TaskService, locateTaskDocument } from "./task-service.js";
import { parseTaskDocument, renderTaskDocument } from "./task-document.js";

const RESTORE_DIR = join(".knit", ".runtime", "restores");
const TASK_FILE = "task.md";

export interface RestoreServiceOptions {
  store: MetadataStore;
  locks?: LockManager;
  git?: (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };
  gitBuffer?: (args: string[], cwd: string, input?: Buffer) => { code: number; stdout: Buffer; stderr: string };
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

export interface RestoreShowInput {
  dir: string;
  runId: string;
  path?: string;
}

export interface RestoreShowResult {
  runId: string;
  manifest: SnapshotManifest;
  entries: SnapshotEntry[];
}

export interface RestorePreviewInput {
  dir: string;
  runId: string;
  paths: string[];
  index?: boolean;
  removeCreated?: boolean;
}

export interface RestorePlanResult {
  runId: string;
  taskId: string;
  branch: string | null;
  head: string | null;
  snapshotDigest: string;
  plans: RestorePathPlan[];
  index: boolean;
  removeCreated: boolean;
}

export interface RestoreExecuteInput extends RestorePreviewInput {
  /** path -> 当前 worktree 指纹；执行前必须完全匹配。 */
  expect: Record<string, string>;
}

export interface RestoreExecuteResult {
  operationId: string;
  runId: string;
  taskId: string;
  state: "completed" | "needs_attention" | "failed";
  plans: RestorePathPlan[];
  results: RestoreRecord["results"];
  branch: string | null;
  headBefore: string | null;
  headAfter: string | null;
  checkInvalidated: boolean;
  taskInputUpdated: boolean;
  recordPath: string;
}

function privateDir(path: string): void {
  if (!existsSync(path)) {
    const parts: string[] = [];
    let current = path;
    while (!existsSync(current)) {
      parts.unshift(current);
      const up = dirname(current);
      if (up === current) break;
      current = up;
    }
    for (const part of parts) mkdirSync(part, { mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

function normalizeRelativePath(path: string): string {
  if (path.includes("\0") || isAbsolute(path)) throw new GuardError("path_escape", `非法恢复路径: ${path}`);
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (normalized === "" || normalized === "." || normalized.split("/").includes("..")) {
    throw new GuardError("path_escape", `恢复路径越界: ${path}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/") || normalized === ".knit/.runtime" || normalized.startsWith(".knit/.runtime/")) {
    throw new GuardError("path_escape", `运行目录不可恢复: ${normalized}`);
  }
  return normalized;
}

/** 逐段检查父目录不是符号链接；最终目标本身可以是待替换的链接。 */
function checkedTarget(root: string, relativePath: string): string {
  const path = normalizeRelativePath(relativePath);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) throw new GuardError("path_escape", `恢复路径越界: ${relativePath}`);
  const parent = dirname(target);
  const segments = relative(root, parent).split(sep).filter((part) => part !== "");
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) throw new GuardError("path_escape", `父级目录是符号链接，不能写入: ${relativePath}`);
    if (!stats.isDirectory()) throw new GuardError("path_not_directory", `父级不是目录: ${relativePath}`);
  }
  return target;
}

export function fingerprintOfState(state: RestorePathState): string {
  return state.fingerprint;
}

function worktreeState(root: string, relativePath: string): RestorePathState {
  const target = checkedTarget(root, relativePath);
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return { kind: "absent", fingerprint: "absent", mode: null, size: null };
  }
  if (stats.isSymbolicLink()) {
    const link = readlinkSync(target);
    return { kind: "symlink", fingerprint: `symlink:${sha256Text(link)}`, mode: 0o120000, size: stats.size };
  }
  if (stats.isFile()) {
    const data = readFileSync(target);
    const mode = (stats.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
    // 指纹包含模式：只改执行位也必须被视为当前版本变化。
    return { kind: "file", fingerprint: `file:${sha256Bytes(data)}:${mode}`, mode, size: data.length };
  }
  if (stats.isDirectory()) return { kind: "directory", fingerprint: "directory", mode: null, size: null };
  return { kind: "other", fingerprint: "other", mode: null, size: null };
}

function snapshotState(entry: SnapshotEntry | undefined): RestorePathState {
  if (entry === undefined || entry.absent) return { kind: "absent", fingerprint: "absent", mode: null, size: null };
  if (entry.kind === "symlink") {
    return { kind: "symlink", fingerprint: `symlink:${entry.digest ?? "unknown"}`, mode: 0o120000, size: entry.size };
  }
  if (entry.kind === "submodule") {
    return { kind: "submodule", fingerprint: `submodule:${entry.indexOid ?? "unknown"}`, mode: 0o160000, size: null };
  }
  return { kind: "file", fingerprint: `file:${entry.digest ?? "unknown"}:${entry.mode}`, mode: entry.mode, size: entry.size };
}

interface ParsedIndex {
  present: boolean;
  mode: number | null;
  oid: string | null;
}

function parseIndexRecord(stdout: string): ParsedIndex {
  const record = stdout.split("\0").find((item) => item !== "");
  if (record === undefined) return { present: false, mode: null, oid: null };
  const tab = record.indexOf("\t");
  if (tab < 0) return { present: false, mode: null, oid: null };
  const [mode, oid] = record.slice(0, tab).split(" ");
  if (mode === undefined || oid === undefined) return { present: false, mode: null, oid: null };
  return { present: true, mode: Number.parseInt(mode, 8), oid };
}

function indexState(root: string, path: string, git: (args: string[], cwd: string) => { code: number; stdout: string; stderr: string }): RestoreIndexState {
  const result = git(["ls-files", "-s", "-z", "--", path], root);
  if (result.code !== 0) throw new InfrastructureError("git_unavailable", `读取 index 失败: ${result.stderr.trim()}`);
  return parseIndexRecord(result.stdout);
}

function sameIndex(a: RestoreIndexState, b: RestoreIndexState): boolean {
  return a.present === b.present && a.mode === b.mode && a.oid === b.oid;
}

function snapshotIndexState(entry: SnapshotEntry | undefined): RestoreIndexState {
  if (entry === undefined || entry.indexOid === null || entry.indexOid === undefined) return { present: false, mode: null, oid: null };
  return { present: true, mode: entry.mode, oid: entry.indexOid };
}

function entryMap(manifest: SnapshotManifest): Map<string, SnapshotEntry> {
  return new Map(manifest.entries.map((entry) => [entry.path, entry]));
}

function isTaskPath(path: string): boolean {
  return /^\.knit\/tasks\/(?:archive\/[0-9]{4}-[0-9]{2}\/)?[^/]+\/task\.md$/.test(path);
}

function readSnapshotEntryFile(snapshotDir: string, entry: SnapshotEntry): Buffer {
  if (entry.kind === "symlink") {
    const path = join(snapshotDir, "files", entry.path);
    if (!existsSync(path)) throw new InfrastructureError("io_error", `快照符号链接缺失: ${entry.path}`);
    return Buffer.from(readlinkSync(path), "utf8");
  }
  const path = join(snapshotDir, "files", entry.path);
  if (!existsSync(path)) throw new InfrastructureError("io_error", `快照文件缺失: ${entry.path}`);
  return readFileSync(path);
}

function validatedWorktreeBytes(snapshotDir: string, entry: SnapshotEntry): Buffer {
  const data = readSnapshotEntryFile(snapshotDir, entry);
  const digest = entry.kind === "symlink" ? sha256Text(data.toString("utf8")) : sha256Bytes(data);
  if (entry.digest !== digest) throw new InfrastructureError("io_error", `快照内容摘要不符: ${entry.path}`);
  return data;
}

function validatedIndexBytes(snapshotDir: string, entry: SnapshotEntry): Buffer {
  if (entry.indexDigest === undefined || entry.indexDigest === null) {
    throw new GuardError("snapshot_index_unavailable", `快照没有索引层内容: ${entry.path}`);
  }
  let data: Buffer;
  if (entry.kind === "file" && entry.indexDigest === entry.digest) {
    data = readSnapshotEntryFile(snapshotDir, entry);
  } else if (entry.kind === "symlink" && entry.indexDigest === entry.digest) {
    data = Buffer.from(entry.linkTarget ?? "", "utf8");
  } else {
    const path = join(snapshotDir, "index", entry.path);
    if (!existsSync(path)) throw new InfrastructureError("io_error", `快照 index 内容缺失: ${entry.path}`);
    data = readFileSync(path);
  }
  if (sha256Bytes(data) !== entry.indexDigest) throw new InfrastructureError("io_error", `快照 index 摘要不符: ${entry.path}`);
  return data;
}

function sameWorktree(a: RestorePathState, b: RestorePathState): boolean {
  return a.kind === b.kind && a.fingerprint === b.fingerprint;
}

export class RestoreService {
  private readonly store: MetadataStore;
  private readonly locks: LockManager;
  private readonly git: (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };
  private readonly gitBuffer: (args: string[], cwd: string, input?: Buffer) => { code: number; stdout: Buffer; stderr: string };
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(options: RestoreServiceOptions) {
    this.store = options.store;
    this.locks = options.locks ?? new LockManager();
    this.git = options.git ?? ((args, cwd) => gitSync(args, cwd));
    this.gitBuffer = options.gitBuffer ?? ((args, cwd, input) => gitBufferSync(args, cwd, input));
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
  }

  show(input: RestoreShowInput): RestoreShowResult {
    const root = normalizeRoot(input.dir);
    const store = new RunStore(root);
    const manifest = this.snapshotOf(store, input.runId, false);
    const entries = input.path === undefined ? manifest.entries : manifest.entries.filter((entry) => entry.path === normalizeRelativePath(input.path!));
    return { runId: input.runId, manifest, entries };
  }

  /** 只读预览；不取锁、不构建 restore 记录。 */
  preview(input: RestorePreviewInput): RestorePlanResult {
    const root = normalizeRoot(input.dir);
    const store = new RunStore(root);
    const request = store.readRequest(input.runId);
    if (request === null) throw new GuardError("unknown_run", `run 不存在: ${input.runId}`);
    const manifest = this.snapshotOf(store, input.runId);
    const branch = this.currentBranch(root);
    this.assertRepoAndBranch(root, manifest, branch);
    const plan = this.buildPlans(root, manifest, input, request.taskId);
    return {
      runId: input.runId,
      taskId: request.taskId,
      branch,
      head: this.currentHead(root),
      snapshotDigest: manifest.digest,
      plans: plan.plans,
      index: input.index === true,
      removeCreated: input.removeCreated === true,
    };
  }

  async restore(input: RestoreExecuteInput): Promise<RestoreExecuteResult> {
    const root = normalizeRoot(input.dir);
    const store = new RunStore(root);
    const request = store.readRequest(input.runId);
    if (request === null) throw new GuardError("unknown_run", `run 不存在: ${input.runId}`);
    const manifest = this.snapshotOf(store, input.runId);
    const branch = this.currentBranch(root);
    this.assertRepoAndBranch(root, manifest, branch);
    const plan = this.buildPlans(root, manifest, input, request.taskId);
    this.assertExpected(plan.plans, input.expect);
    const taskPlans = plan.plans.filter((item) => item.guard === "task_input");
    if (taskPlans.length > 0) {
      if (plan.plans.length !== taskPlans.length) throw new GuardError("task_input_restore_mixed", "Task 输入不能与源码路径在同一次 restore 中混合");
      if (input.index === true) throw new GuardError("task_input_index_unsupported", "Task 输入恢复不能指定 --index");
      if (input.removeCreated === true) throw new GuardError("task_input_remove_unsupported", "Task 输入恢复不能删除路径");
      return this.restoreTaskInput(root, store, request.taskId, manifest, plan.plans[0]!, input);
    }
    for (const item of plan.plans) {
      if (item.guard === "unsupported") throw new GuardError("unsupported_path", item.reason ?? `不支持恢复: ${item.path}`);
      if (item.action === "delete" && input.removeCreated !== true) {
        throw new GuardError("remove_created_required", `快照中不存在 ${item.path}；删除后来新建路径需 --remove-created`);
      }
      if (input.index === true && item.snapshotIndex.present) {
        const entry = entryMap(manifest).get(item.path);
        if (entry?.indexDigest === undefined || entry.indexDigest === null) {
          throw new GuardError("snapshot_index_unavailable", `旧快照没有索引层内容: ${item.path}`);
        }
      }
    }

    const binding = await this.store.bindings.get(request.taskId);
    if (binding === null) throw new GuardError("task_not_managed", `任务没有绑定: ${request.taskId}`);
    const taskLocation = locateTaskDocument(root, request.taskId);
    if (taskLocation.archived) throw new GuardError("task_closed", "任务已归档，不自动重开");
    if (taskLocation.document.frontmatter.status !== "open") throw new GuardError("task_closed", "任务已关闭，不恢复源码");

    const operationId = `restore-${this.randomHex(6)}`;
    const recordPath = join(root, RESTORE_DIR, `${operationId}.json`);
    privateDir(dirname(recordPath));
    const headBefore = this.currentHead(root);
    const now = this.now().toISOString();
    let record: RestoreRecord = {
      schemaVersion: 1,
      operationId,
      runId: input.runId,
      taskId: request.taskId,
      state: "running",
      root,
      branch,
      headBefore,
      headAfter: null,
      snapshotDigest: manifest.digest,
      index: input.index === true,
      removeCreated: input.removeCreated === true,
      expect: input.expect,
      plans: plan.plans,
      results: [],
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.writeRecord(recordPath, record);

    const lock = await this.locks.acquire({
      keys: orderKeys([{ scope: "project", rawKey: root }]),
      action: "snapshot.restore",
    });
    try {
      // 锁内重读快照、分支与当前指纹；预览后发生的任何变化都停止。
      const currentManifest = this.snapshotOf(store, input.runId);
      this.assertRepoAndBranch(root, currentManifest, this.currentBranch(root));
      const currentPlan = this.buildPlans(root, currentManifest, input, request.taskId);
      this.assertExpected(currentPlan.plans, input.expect);
      for (let index = 0; index < currentPlan.plans.length; index += 1) {
        const before = plan.plans[index]!;
        const after = currentPlan.plans[index]!;
        if (before.path !== after.path || before.current.fingerprint !== after.current.fingerprint || !sameIndex(before.index, after.index)) {
          throw new GuardError("stale_input", `恢复预览后当前状态变化: ${after.path}`);
        }
      }
      record = { ...record, plans: currentPlan.plans, updatedAt: this.now().toISOString() };
      this.writeRecord(recordPath, record);

      for (const item of currentPlan.plans) {
        const fresh = this.buildPlans(root, currentManifest, { ...input, paths: [item.path], removeCreated: true }, request.taskId).plans[0]!;
        if (fresh.current.fingerprint !== item.current.fingerprint || !sameIndex(fresh.index, item.index)) {
          throw new GuardError("stale_input", `恢复执行前当前状态变化: ${item.path}`);
        }
        if (item.action === "keep" && item.indexAction === "unchanged") {
          record.results.push({ path: item.path, status: "skipped", after: item.current, indexAfter: item.index, reason: "already_matches" });
          this.writeRecord(recordPath, { ...record, updatedAt: this.now().toISOString() });
          continue;
        }
        try {
          if (item.action === "delete") this.deletePath(root, item.path);
          else if (item.action === "restore") this.restoreWorktree(root, currentManifest, item.path);
          if (input.index === true) this.restoreIndex(root, currentManifest, item.path);
          const latest = this.buildPlans(root, currentManifest, { ...input, paths: [item.path], removeCreated: true }, request.taskId).plans[0]!;
          const verified = item.action === "delete"
            ? latest.snapshot.kind === "absent" && latest.current.kind === "absent"
            : sameWorktree(latest.current, latest.snapshot);
          if (!verified) throw new InfrastructureError("io_error", `恢复后指纹不符: ${item.path}`);
          if (input.index === true && !sameIndex(latest.index, latest.snapshotIndex)) {
            throw new InfrastructureError("io_error", `恢复后 index 不符: ${item.path}`);
          }
          record.results.push({ path: item.path, status: "done", after: latest.current, indexAfter: latest.index, reason: null });
        } catch (error) {
          record.results.push({
            path: item.path,
            status: "failed",
            after: worktreeState(root, item.path),
            indexAfter: indexState(root, item.path, this.git),
            reason: error instanceof Error ? error.message : String(error),
          });
          record = { ...record, state: "needs_attention", reason: `path_failed: ${item.path}`, updatedAt: this.now().toISOString() };
          this.writeRecord(recordPath, record);
          throw error;
        }
        this.writeRecord(recordPath, { ...record, updatedAt: this.now().toISOString() });
      }

      const invalidated = await this.invalidateTaskCheck(root, request.taskId);
      record = {
        ...record,
        state: "completed",
        headAfter: this.currentHead(root),
        reason: null,
        updatedAt: this.now().toISOString(),
      };
      this.writeRecord(recordPath, record);
      return {
        operationId,
        runId: input.runId,
        taskId: request.taskId,
        state: "completed",
        plans: currentPlan.plans,
        results: record.results,
        branch,
        headBefore,
        headAfter: record.headAfter,
        checkInvalidated: invalidated,
        taskInputUpdated: false,
        recordPath: relative(root, recordPath),
      };
    } catch (error) {
      const state = record.state === "needs_attention" ? "needs_attention" : "failed";
      record = { ...record, state, reason: error instanceof Error ? error.message : String(error), updatedAt: this.now().toISOString() };
      try {
        this.writeRecord(recordPath, record);
      } catch {
        // 记录失败不掩盖原始错误；调用方仍看到实际错误。
      }
      throw error;
    } finally {
      this.locks.release(lock);
    }
  }

  private snapshotOf(store: RunStore, runId: string, requireReady = true): SnapshotManifest {
    const manifest = store.readSnapshot(runId);
    if (manifest === null) throw new GuardError("snapshot_missing", `run 没有快照: ${runId}`);
    if (requireReady && manifest.state !== "ready") throw new GuardError("snapshot_not_ready", `快照状态为 ${manifest.state}，不能恢复`);
    return manifest;
  }

  private currentBranch(root: string): string | null {
    const result = this.git(["symbolic-ref", "--short", "-q", "HEAD"], root);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  private currentHead(root: string): string | null {
    const result = this.git(["rev-parse", "--verify", "HEAD"], root);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  private assertRepoAndBranch(root: string, manifest: SnapshotManifest, branch: string | null): void {
    const top = this.git(["rev-parse", "--show-toplevel"], root);
    if (top.code !== 0) throw new GuardError("git_unavailable", "当前目录不是 Git 仓库");
    let topPath: string;
    try {
      topPath = normalizeRoot(top.stdout.trim());
    } catch {
      throw new GuardError("repo_mismatch", "无法解析仓库根");
    }
    if (topPath !== root) throw new GuardError("repo_mismatch", "项目根与 Git 仓库根不一致");
    if (manifest.base.branch !== branch) throw new GuardError("branch_changed", `快照分支 ${manifest.base.branch ?? "detached"} 与当前 ${branch ?? "detached"} 不一致`);
  }

  private buildPlans(root: string, manifest: SnapshotManifest, input: RestorePreviewInput, taskId: string): RestorePlanResult {
    if (!Array.isArray(input.paths) || input.paths.length === 0) throw new GuardError("path_required", "restore 需要至少一个 --path");
    const map = entryMap(manifest);
    const plans: RestorePathPlan[] = [];
    const seen = new Set<string>();
    for (const rawPath of input.paths) {
      const path = normalizeRelativePath(rawPath);
      if (seen.has(path)) continue;
      seen.add(path);
      const entry = map.get(path);
      const current = worktreeState(root, path);
      const snapshot = snapshotState(entry);
      const currentIndex = indexState(root, path, this.git);
      const snapIndex = snapshotIndexState(entry);
      const taskInput = isTaskPath(path);
      let guard: RestorePathPlan["guard"] = taskInput ? "task_input" : null;
      let action: RestorePathPlan["action"];
      let reason: string | null = null;
      if (entry?.kind === "submodule") {
        guard = "unsupported";
        action = "keep";
        reason = "子模块需按独立项目处理";
      } else if (entry !== undefined && entry.absent) {
        action = current.kind === "absent" ? "keep" : "delete";
        if (action === "delete") {
          guard = taskInput ? "task_input" : "remove_created_required";
          reason = "快照中该路径为缺失；删除当前文件需 --remove-created";
        }
      } else if (entry === undefined) {
        if (current.kind === "directory") {
          guard = "unsupported";
          action = "keep";
          reason = "快照没有该目录，不能递归删除";
        } else {
          action = current.kind === "absent" ? "keep" : "delete";
          if (action === "delete") {
            guard = "remove_created_required";
            reason = "快照没有该路径；删除当前文件需 --remove-created";
          }
        }
      } else if (sameWorktree(current, snapshot)) {
        action = "keep";
      } else {
        if (current.kind === "directory") {
          guard = "unsupported";
          action = "keep";
          reason = "快照路径是文件／链接，当前是目录，不能自动覆盖";
        } else {
          action = "restore";
        }
      }
      let indexAction: RestorePathPlan["indexAction"] = "ignored";
      if (input.index === true) {
        if (taskInput) indexAction = "ignored";
        else if (!snapIndex.present) indexAction = currentIndex.present ? "remove" : "unchanged";
        else indexAction = sameIndex(currentIndex, snapIndex) ? "unchanged" : "set";
      }
      plans.push({
        path,
        snapshot,
        current,
        index: currentIndex,
        snapshotIndex: snapIndex,
        action,
        indexAction,
        guard,
        reason,
      });
    }
    return {
      runId: manifest.runId,
      taskId,
      branch: manifest.base.branch,
      head: manifest.base.head,
      snapshotDigest: manifest.digest,
      plans,
      index: input.index === true,
      removeCreated: input.removeCreated === true,
    };
  }

  private assertExpected(plans: RestorePathPlan[], expect: Record<string, string>): void {
    for (const plan of plans) {
      const expected = expect[plan.path];
      if (expected === undefined) throw new GuardError("expect_required", `执行恢复需要为 ${plan.path} 提供 --expect <当前指纹>`);
      if (expected !== plan.current.fingerprint) {
        throw new GuardError("stale_input", `当前指纹不匹配 ${plan.path}: 期望 ${expected}，实际 ${plan.current.fingerprint}`);
      }
    }
  }

  private deletePath(root: string, path: string): void {
    const target = checkedTarget(root, path);
    let stats;
    try {
      stats = lstatSync(target);
    } catch {
      throw new GuardError("stale_input", `待删除路径已经不存在: ${path}`);
    }
    if (stats.isDirectory()) throw new GuardError("remove_created_directory", `不能递归删除目录: ${path}`);
    unlinkSync(target);
  }

  private restoreWorktree(root: string, manifest: SnapshotManifest, path: string): void {
    const entry = entryMap(manifest).get(path);
    if (entry === undefined || entry.absent) throw new GuardError("snapshot_missing", `快照没有文件内容: ${path}`);
    const target = checkedTarget(root, path);
    const parent = dirname(target);
    if (!existsSync(parent)) {
      const missing: string[] = [];
      let cursor = parent;
      while (!existsSync(cursor)) {
        missing.unshift(cursor);
        const up = dirname(cursor);
        if (up === cursor) break;
        cursor = up;
      }
      for (const part of missing) mkdirSync(part, { mode: 0o700 });
    }
    const current = worktreeState(root, path);
    if (current.kind === "directory") throw new GuardError("unsupported_path", `当前路径是目录，不能覆盖: ${path}`);
    if (entry.kind === "symlink") {
      const targetValue = entry.linkTarget ?? "";
      if (sha256Text(targetValue) !== entry.digest) throw new InfrastructureError("io_error", `快照链接目标摘要不符: ${path}`);
      const temp = join(parent, `.knit-restore-${process.pid}-${this.randomHex(4)}`);
      try {
        symlinkSync(targetValue, temp);
        renameSync(temp, target);
      } finally {
        if (existsSync(temp)) rmSync(temp, { force: true });
      }
      return;
    }
    const data = validatedWorktreeBytes(join(new RunStore(root).runDir(manifest.runId), "snapshot"), entry);
    const mode = (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
    const currentSha = current.kind === "file" ? sha256Bytes(readFileSync(target)) : null;
    if (current.kind === "file") {
      atomicWrite({ path: target, data, expectedSha256: currentSha, mode, createParents: false });
    } else if (current.kind === "symlink") {
      // 先写临时文件再 rename 覆盖链接；不跟随链接，失败时保留原链接。
      const temp = join(parent, `.knit-restore-${process.pid}-${this.randomHex(4)}`);
      try {
        atomicWrite({ path: temp, data, expectedSha256: null, mode, createParents: false });
        renameSync(temp, target);
      } finally {
        if (existsSync(temp)) rmSync(temp, { force: true });
      }
    } else {
      if (current.kind !== "absent") throw new GuardError("unsupported_path", `当前路径类型不支持: ${path}`);
      atomicWrite({ path: target, data, expectedSha256: null, mode, createParents: false });
    }
  }

  private restoreIndex(root: string, manifest: SnapshotManifest, path: string): void {
    const entry = entryMap(manifest).get(path);
    if (entry === undefined || entry.indexOid === null || entry.indexOid === undefined) {
      const remove = this.git(["update-index", "--force-remove", "--", path], root);
      if (remove.code !== 0) throw new InfrastructureError("io_error", `移除 index 路径失败: ${remove.stderr.trim()}`);
      return;
    }
    const data = validatedIndexBytes(join(new RunStore(root).runDir(manifest.runId), "snapshot"), entry);
    const hashed = this.gitBuffer(["hash-object", "-w", "--stdin"], root, data);
    if (hashed.code !== 0) throw new InfrastructureError("io_error", `写入 index blob 失败: ${hashed.stderr.trim()}`);
    const oid = hashed.stdout.toString("utf8").trim();
    const mode = entry.mode.toString(8).padStart(6, "0");
    const update = this.git(["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`], root);
    if (update.code !== 0) throw new InfrastructureError("io_error", `更新 index 失败: ${update.stderr.trim()}`);
  }

  private async restoreTaskInput(
    root: string,
    store: RunStore,
    taskId: string,
    manifest: SnapshotManifest,
    plan: RestorePathPlan,
    input: RestoreExecuteInput,
  ): Promise<RestoreExecuteResult> {
    const entry = entryMap(manifest).get(plan.path);
    if (entry === undefined || entry.absent || entry.kind !== "file") throw new GuardError("task_input_missing", `快照没有任务输入: ${plan.path}`);
    const data = validatedWorktreeBytes(join(store.runDir(manifest.runId), "snapshot"), entry);
    const snapshotText = data.toString("utf8");
    const snapshotDoc = parseTaskDocument(snapshotText, plan.path);
    if (snapshotDoc.frontmatter.id !== taskId) throw new GuardError("task_identity_changed", "快照任务身份与 run 任务不一致");
    const located = locateTaskDocument(root, taskId);
    const currentPath = relative(root, join(located.dir, TASK_FILE)).replaceAll("\\", "/");
    if (located.archived) throw new GuardError("task_closed", "任务已归档，不自动重开");
    if (currentPath !== plan.path) throw new GuardError("task_path_changed", `任务已移动：${plan.path} → ${currentPath}`);
    if (located.document.frontmatter.status !== "open") throw new GuardError("task_closed", "任务已关闭，不恢复输入");
    const binding = await this.store.bindings.get(taskId);
    if (binding === null) throw new GuardError("task_not_managed", `任务没有绑定: ${taskId}`);

    const operationId = `restore-${this.randomHex(6)}`;
    const recordPath = join(root, RESTORE_DIR, `${operationId}.json`);
    privateDir(dirname(recordPath));
    const now = this.now().toISOString();
    let record: RestoreRecord = {
      schemaVersion: 1,
      operationId,
      runId: input.runId,
      taskId,
      state: "running",
      root,
      branch: this.currentBranch(root),
      headBefore: this.currentHead(root),
      headAfter: null,
      snapshotDigest: manifest.digest,
      index: false,
      removeCreated: false,
      expect: input.expect,
      plans: [plan],
      results: [],
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.writeRecord(recordPath, record);
    try {
      const service = new TaskService({ store: this.store, locks: this.locks });
      const currentFile = readWithVersion(join(located.dir, TASK_FILE));
      if (currentFile === null) throw new InfrastructureError("io_error", `task.md 缺失: ${plan.path}`);
      await service.update({
        dir: root,
        taskId,
        kind: "change",
        reason: `恢复任务输入（快照 ${input.runId}，操作 ${operationId}）`,
        content: snapshotDoc.inputsBody,
        runActive: false,
        updateOperationId: operationId,
        expectTaskSha256: currentFile.sha256,
      });
      const after = worktreeState(root, plan.path);
      const indexAfter = indexState(root, plan.path, this.git);
      record = {
        ...record,
        state: "completed",
        headAfter: this.currentHead(root),
        results: [{ path: plan.path, status: "done", after, indexAfter, reason: "task_update" }],
        updatedAt: this.now().toISOString(),
      };
      this.writeRecord(recordPath, record);
      return {
        operationId,
        runId: input.runId,
        taskId,
        state: "completed",
        plans: [plan],
        results: record.results,
        branch: record.branch,
        headBefore: record.headBefore,
        headAfter: record.headAfter,
        checkInvalidated: true,
        taskInputUpdated: true,
        recordPath: relative(root, recordPath),
      };
    } catch (error) {
      record = { ...record, state: "failed", reason: error instanceof Error ? error.message : String(error), updatedAt: this.now().toISOString() };
      this.writeRecord(recordPath, record);
      throw error;
    }
  }

  /** 源码恢复改变选定目标：旧检查立即失效；deliver 按 verification 回 check（independent）或 implement（self／none）。 */
  private async invalidateTaskCheck(root: string, taskId: string): Promise<boolean> {
    const binding = await this.store.bindings.get(taskId);
    if (binding === null) throw new GuardError("task_not_managed", `任务没有绑定: ${taskId}`);
    const located = locateTaskDocument(root, taskId);
    if (located.archived) throw new GuardError("task_closed", "任务已归档，不自动重开");
    const lock = await this.locks.acquire({
      keys: orderKeys([this.taskLockKey(root, taskId)]),
      action: "snapshot.restore.invalidate-check",
    });
    try {
      const file = join(located.dir, TASK_FILE);
      const before = readWithVersion(file);
      if (before === null) throw new InfrastructureError("io_error", `task.md 缺失: ${file}`);
      const document = parseTaskDocument(before.data.toString("utf8"), file);
      let updated = document;
      if (document.frontmatter.phase === "deliver") {
        const phase = verificationModeOf(document.frontmatter) === "independent" ? "check" : "implement";
        updated = { ...document, frontmatter: { ...document.frontmatter, phase } };
        atomicWrite({ path: file, data: Buffer.from(renderTaskDocument(updated)), expectedSha256: before.sha256, mode: 0o644 });
      }
      await this.store.bindings.save({ ...binding, lastCheckRunId: null, lastImplement: null });
      new RunStore(root).removeCompletion(taskId);
      return true;
    } finally {
      this.locks.release(lock);
    }
  }

  private taskLockKey(root: string, taskId: string): { scope: "task"; rawKey: string } {
    return { scope: "task", rawKey: `${root}::${taskId}` };
  }

  private writeRecord(path: string, record: RestoreRecord): void {
    if (!Value.Check(RestoreRecordSchema, record)) throw new InfrastructureError("io_error", "restore 记录结构不符");
    const version = readWithVersion(path);
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(record, null, 2) + "\n"),
      expectedSha256: version?.sha256 ?? null,
      mode: 0o600,
    });
  }
}

