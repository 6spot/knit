/**
 * run 资料文件存储（DESIGN.md 第5.6节）。
 * 目录 `.knit/.runtime/runs/<run-id>/`；request/launch 核心写，其余 worker 写。
 * 全部原子替换；events.jsonl 只作观察，不是完成证据。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  FrozenInputsSchema,
  InstructionsFileSchema,
  LaunchRecordSchema,
  RunCancelSchema,
  RunDiagnosticsFileSchema,
  RunRequestFileSchema,
  RunResultFileSchema,
  RunStageProcessSchema,
  RunStateFileSchema,
  ScopeFileSchema,
  CheckFileSchema,
  SnapshotManifestSchema,
  type CheckFile,
  type FrozenInputs,
  type RunCancel,
  type RunDiagnosticsFile,
  type InstructionsFile,
  type LaunchRecord,
  type RunRequestFile,
  type RunResultFile,
  type RunStageProcess,
  type RunStateFile,
  type ScopeFile,
  type SnapshotManifest,
} from "../contracts/run.js";
import { AcceptanceJournalSchema, type AcceptanceJournal } from "../contracts/acceptance.js";
import { atomicWrite, readWithVersion } from "./atomic.js";
import { InfrastructureError } from "./errors.js";
import { normalizeRoot } from "./paths.js";

const RUNS_DIR = join(".knit", ".runtime", "runs");

export interface WorkerIdentity {
  workerId: string;
  pid: number;
  bootId: string;
  procStartTicks: string | null;
  hostname: string;
}

export interface ClaimResult {
  claimed: boolean;
  /** 同一 worker 重入时返回既有事实，不重复准备。 */
  existing: boolean;
  reason?: "already_claimed" | "claim_in_progress" | "state_missing";
  state: RunStateFile | null;
}

function privateDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function parseJson<T>(path: string, schema: TSchema, label: string): T | null {
  const version = readWithVersion(path);
  if (version === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(version.data.toString("utf8"));
  } catch {
    throw new InfrastructureError("io_error", `${label} 不是合法 JSON：${path}`);
  }
  if (!Value.Check(schema, raw)) {
    throw new InfrastructureError("io_error", `${label} 结构不符：${path}`);
  }
  return raw as T;
}

export class RunStore {
  readonly root: string;
  readonly runsRoot: string;

  constructor(root: string) {
    this.root = normalizeRoot(root);
    this.runsRoot = join(this.root, RUNS_DIR);
  }

  runDir(runId: string): string {
    if (!/^run-[0-9a-f]{12}$/.test(runId)) {
      throw new InfrastructureError("io_error", `非法 run ID：${runId}`);
    }
    return join(this.runsRoot, runId);
  }

  exists(runId: string): boolean {
    return existsSync(this.runDir(runId));
  }

  /** 发布不可变 request 与 planned launch；同 runId 重入只返回既有事实。 */
  create(request: RunRequestFile): { created: boolean; request: RunRequestFile } {
    if (!Value.Check(RunRequestFileSchema, request)) {
      throw new InfrastructureError("io_error", "run request 结构不符");
    }
    const dir = this.runDir(request.runId);
    privateDir(this.runsRoot);
    if (existsSync(dir)) {
      const existing = this.readRequest(request.runId);
      if (existing === null) {
        throw new InfrastructureError("io_error", `run 目录已存在但缺少 request：${request.runId}`);
      }
      if (existing.runId !== request.runId || existing.taskId !== request.taskId) {
        throw new InfrastructureError("version_conflict", `run ID 已被不同请求占用：${request.runId}`);
      }
      return { created: false, request: existing };
    }
    privateDir(dir);
    atomicWrite({ path: join(dir, "request.json"), data: Buffer.from(JSON.stringify(request, null, 2) + "\n"), expectedSha256: null, mode: 0o600 });
    const now = request.createdAt;
    const launch: LaunchRecord = {
      schemaVersion: 1,
      runId: request.runId,
      state: "planned",
      attempts: 0,
      requestedAt: now,
      updatedAt: now,
      handle: null,
      instance: null,
      lastError: null,
    };
    this.writeLaunch(request.runId, launch);
    this.appendEvent(request.runId, { event: "request_published", phase: request.phase });
    return { created: true, request };
  }

  readRequest(runId: string): RunRequestFile | null {
    return parseJson<RunRequestFile>(join(this.runDir(runId), "request.json"), RunRequestFileSchema, "request.json");
  }

  readLaunch(runId: string): LaunchRecord | null {
    return parseJson<LaunchRecord>(join(this.runDir(runId), "launch.json"), LaunchRecordSchema, "launch.json");
  }

  writeLaunch(runId: string, launch: LaunchRecord): void {
    if (!Value.Check(LaunchRecordSchema, launch)) {
      throw new InfrastructureError("io_error", "launch 结构不符");
    }
    const path = join(this.runDir(runId), "launch.json");
    const version = readWithVersion(path);
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(launch, null, 2) + "\n"),
      expectedSha256: version?.sha256 ?? null,
      mode: 0o600,
    });
  }

  readState(runId: string): RunStateFile | null {
    return parseJson<RunStateFile>(join(this.runDir(runId), "state.json"), RunStateFileSchema, "state.json");
  }

  writeState(runId: string, state: RunStateFile): void {
    if (!Value.Check(RunStateFileSchema, state)) {
      throw new InfrastructureError("io_error", "state 结构不符");
    }
    const path = join(this.runDir(runId), "state.json");
    const version = readWithVersion(path);
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(state, null, 2) + "\n"),
      expectedSha256: version?.sha256 ?? null,
      mode: 0o600,
    });
  }

  readStageProcess(runId: string): RunStageProcess | null {
    return parseJson<RunStageProcess>(join(this.runDir(runId), "stage-process.json"), RunStageProcessSchema, "stage-process.json");
  }

  writeStageProcess(runId: string, process: RunStageProcess): void {
    if (!Value.Check(RunStageProcessSchema, process)) {
      throw new InfrastructureError("io_error", "stage-process 结构不符");
    }
    const path = join(this.runDir(runId), "stage-process.json");
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(process, null, 2) + "\n"),
      expectedSha256: readWithVersion(path)?.sha256 ?? null,
      mode: 0o600,
    });
  }

  readDiagnostics(runId: string): RunDiagnosticsFile | null {
    return parseJson<RunDiagnosticsFile>(join(this.runDir(runId), "diagnostics.json"), RunDiagnosticsFileSchema, "diagnostics.json");
  }

  /** 辅助证据：写入失败由调用方决定是否忽略，不影响终态判定。 */
  writeDiagnostics(runId: string, diagnostics: RunDiagnosticsFile): void {
    if (!Value.Check(RunDiagnosticsFileSchema, diagnostics)) throw new InfrastructureError("io_error", "diagnostics 结构不符");
    const path = join(this.runDir(runId), "diagnostics.json");
    atomicWrite({ path, data: Buffer.from(JSON.stringify(diagnostics, null, 2) + "\n"), expectedSha256: null, mode: 0o600 });
  }

  readInputs(runId: string): FrozenInputs | null {
    return parseJson<FrozenInputs>(join(this.runDir(runId), "inputs.json"), FrozenInputsSchema, "inputs.json");
  }

  writeInputs(runId: string, inputs: FrozenInputs): void {
    if (!Value.Check(FrozenInputsSchema, inputs)) throw new InfrastructureError("io_error", "inputs 结构不符");
    const path = join(this.runDir(runId), "inputs.json");
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(inputs, null, 2) + "\n"),
      expectedSha256: readWithVersion(path)?.sha256 ?? null,
      mode: 0o600,
    });
  }

  readInstructions(runId: string): InstructionsFile | null {
    return parseJson<InstructionsFile>(join(this.runDir(runId), "instructions.json"), InstructionsFileSchema, "instructions.json");
  }

  writeInstructions(runId: string, instructions: InstructionsFile): void {
    if (!Value.Check(InstructionsFileSchema, instructions)) {
      throw new InfrastructureError("io_error", "instructions 结构不符");
    }
    const path = join(this.runDir(runId), "instructions.json");
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(instructions, null, 2) + "\n"),
      expectedSha256: readWithVersion(path)?.sha256 ?? null,
      mode: 0o600,
    });
  }

  readCancel(runId: string): RunCancel | null {
    return parseJson<RunCancel>(join(this.runDir(runId), "cancel.json"), RunCancelSchema, "cancel.json");
  }

  writeCancel(runId: string, cancel: RunCancel): void {
    if (!Value.Check(RunCancelSchema, cancel)) throw new InfrastructureError("io_error", "cancel 结构不符");
    const path = join(this.runDir(runId), "cancel.json");
    if (existsSync(path)) return;
    atomicWrite({ path, data: Buffer.from(JSON.stringify(cancel, null, 2) + "\n"), expectedSha256: null, mode: 0o600 });
  }

  readResult(runId: string): RunResultFile | null {
    return parseJson<RunResultFile>(join(this.runDir(runId), "result.json"), RunResultFileSchema, "result.json");
  }

  /** 不可变结果：已存在时拒绝覆盖，终态不重写。 */
  writeResult(runId: string, result: RunResultFile): void {
    if (!Value.Check(RunResultFileSchema, result)) throw new InfrastructureError("io_error", "result 结构不符");
    const path = join(this.runDir(runId), "result.json");
    if (existsSync(path)) throw new InfrastructureError("version_conflict", `run 结果已存在: ${runId}`);
    atomicWrite({ path, data: Buffer.from(JSON.stringify(result, null, 2) + "\n"), expectedSha256: null, mode: 0o600 });
  }

  scopePath(taskId: string): string {
    return join(this.root, ".knit", ".runtime", "tasks", taskId, "scope.json");
  }

  readScope(taskId: string): ScopeFile | null {
    return parseJson<ScopeFile>(this.scopePath(taskId), ScopeFileSchema, "scope.json");
  }

  writeScope(taskId: string, scope: ScopeFile): void {
    if (!Value.Check(ScopeFileSchema, scope)) throw new InfrastructureError("io_error", "scope 结构不符");
    const path = this.scopePath(taskId);
    privateDir(join(this.root, ".knit", ".runtime", "tasks", taskId));
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(scope, null, 2) + "\n"),
      expectedSha256: readWithVersion(path)?.sha256 ?? null,
      mode: 0o600,
    });
  }

  checkPath(runId: string): string {
    return join(this.root, ".knit", ".runtime", "checks", `${runId}.json`);
  }

  acceptanceJournalPath(runId: string): string {
    return join(this.runDir(runId), "acceptance.json");
  }

  readAcceptanceJournal(runId: string): AcceptanceJournal | null {
    return parseJson<AcceptanceJournal>(this.acceptanceJournalPath(runId), AcceptanceJournalSchema, "acceptance.json");
  }

  writeAcceptanceJournal(runId: string, journal: AcceptanceJournal): void {
    if (!Value.Check(AcceptanceJournalSchema, journal)) {
      throw new InfrastructureError("io_error", "acceptance.json 结构不符");
    }
    const path = this.acceptanceJournalPath(runId);
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(journal, null, 2) + "\n"),
      expectedSha256: readWithVersion(path)?.sha256 ?? null,
      mode: 0o600,
    });
  }

  removeAcceptanceJournal(runId: string): void {
    rmSync(this.acceptanceJournalPath(runId), { force: true });
  }

  readCheck(runId: string): CheckFile | null {
    return parseJson<CheckFile>(this.checkPath(runId), CheckFileSchema, "check.json");
  }

  /** 检查凭据不可变：同一 run 只发布一次。 */
  writeCheck(runId: string, check: CheckFile): void {
    if (!Value.Check(CheckFileSchema, check)) throw new InfrastructureError("io_error", "check 结构不符");
    const path = this.checkPath(runId);
    if (existsSync(path)) throw new InfrastructureError("version_conflict", `检查凭据已存在: ${runId}`);
    privateDir(join(this.root, ".knit", ".runtime", "checks"));
    atomicWrite({ path, data: Buffer.from(JSON.stringify(check, null, 2) + "\n"), expectedSha256: null, mode: 0o600 });
  }

  readSnapshot(runId: string): SnapshotManifest | null {
    return parseJson<SnapshotManifest>(
      join(this.runDir(runId), "snapshot", "manifest.json"),
      SnapshotManifestSchema,
      "snapshot/manifest.json",
    );
  }

  writeSnapshotManifest(runId: string, manifest: SnapshotManifest, directory = join(this.runDir(runId), "snapshot")): void {
    if (!Value.Check(SnapshotManifestSchema, manifest)) {
      throw new InfrastructureError("io_error", "snapshot manifest 结构不符");
    }
    atomicWrite({
      path: join(directory, "manifest.json"),
      data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
      expectedSha256: null,
      mode: 0o600,
    });
  }

  /**
   * 原子认领：mkdir claim 先到先得；同一 worker 重入返回既有事实。
   * 目录存在但无 state 视为其他 worker 正在准备，不抢跑。
   */
  claim(runId: string, worker: WorkerIdentity): ClaimResult {
    const dir = this.runDir(runId);
    if (!existsSync(join(dir, "request.json"))) {
      throw new InfrastructureError("io_error", `run 不存在或缺少 request：${runId}`);
    }
    const claimDir = join(dir, "claim");
    let claimed = false;
    try {
      mkdirSync(claimDir, { mode: 0o700 });
      claimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = this.readState(runId);
    if (claimed) return { claimed: true, existing: false, state };
    if (state !== null && state.worker.workerId === worker.workerId) {
      return { claimed: true, existing: true, state };
    }
    if (state !== null && (state.prepared || ["completed", "cancelled", "failed"].includes(state.state))) {
      return { claimed: false, existing: false, reason: "already_claimed", state };
    }
    return { claimed: false, existing: false, reason: state === null ? "claim_in_progress" : "already_claimed", state };
  }

  appendEvent(runId: string, event: Record<string, unknown>): void {
    const dir = this.runDir(runId);
    privateDir(dir);
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(join(dir, "events.jsonl"), line, { mode: 0o600 });
  }

  readEvents(runId: string): Record<string, unknown>[] {
    const path = join(this.runDir(runId), "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }

  /** 仅测试／明确重试使用：清空失败快照与认领，不删除 request/launch。 */
  resetForRetry(runId: string): void {
    const dir = this.runDir(runId);
    rmSync(join(dir, "claim"), { recursive: true, force: true });
    rmSync(join(dir, "snapshot"), { recursive: true, force: true });
    for (const name of ["state.json", "inputs.json", "instructions.json", "result.json", "check.json", "cancel.json", "diagnostics.json"]) {
      rmSync(join(dir, name), { force: true });
    }
  }

  listRunIds(): string[] {
    if (!existsSync(this.runsRoot)) return [];
    return readdirSync(this.runsRoot)
      .filter((name) => /^run-[0-9a-f]{12}$/.test(name) && statSync(join(this.runsRoot, name)).isDirectory())
      .sort();
  }
}
