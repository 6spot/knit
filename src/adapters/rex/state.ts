/**
 * Rex 阶段 Worker 的文件事实（DESIGN.md 5.7；本任务 design.md S1）。
 *
 * 路径全部落在 run 目录内：
 *   rex.json                 身份关联（sessionId／blockId／layerId／label／socketPath）
 *   rex/manifest.json        启动时冻结的 worker 身份与文件位置
 *   rex/state.json           worker 生命周期状态（idle/running/blocked/completed/aborted/error/closed）
 *   rex/owner.json           worker 单实例锁（pid + token；存活 owner 不被抢占）
 *   rex/prompt.txt           只在启动时注入一次的阶段 prompt
 *   rex/bridge.sock          worker 侧 Unix socket JSON-RPC
 *   rex/results/<rev>.json   每轮 settle 后不可变结果
 *
 * 这些是观察与恢复事实，不替代核心 run 的 state/result；业务终态仍由 StageRunner 复核。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { bool, int, lit, nul, obj, str, union, type Static } from "@earendil-works/pi-schema";
import { checkSchema } from "../../contracts/schema.js";

export const REX_DIR = "rex";
export const REX_ASSOCIATION_FILE = "rex.json";

export const RexStatusSchema = union([
  lit("idle"),
  lit("running"),
  lit("blocked"),
  lit("completed"),
  lit("aborted"),
  lit("error"),
  lit("closed"),
]);
export type RexStatus = Static<typeof RexStatusSchema>;

export const RexOutcomeSchema = union([
  lit("completed"),
  lit("aborted"),
  lit("error"),
]);
export type RexOutcome = Static<typeof RexOutcomeSchema>;

export const RexWorkerManifestSchema = obj({
  schemaVersion: lit(1),
  runId: str({ minLength: 1 }),
  taskId: str({ minLength: 1 }),
  phase: str({ minLength: 1 }),
  sessionId: str({ minLength: 1 }),
  instance: str({ minLength: 1 }),
  label: str({ minLength: 1 }),
  cwd: str({ minLength: 1 }),
  /** run 目录；恢复发现与结果定位都以它为准。 */
  runDirectory: str({ minLength: 1 }),
  /** rex 私有目录（runDirectory/rex）。 */
  directory: str({ minLength: 1 }),
  socketPath: str({ minLength: 1 }),
  promptPath: str({ minLength: 1 }),
  statePath: str({ minLength: 1 }),
  ownerPath: str({ minLength: 1 }),
  /** settle 后是否请求 Pi 关闭；默认由 launcher 决定，阶段默认保持浮窗可查看。 */
  closeOnSettle: bool(),
  createdAt: str({ minLength: 1 }),
});
export type RexWorkerManifest = Static<typeof RexWorkerManifestSchema>;

export const RexWorkerStateSchema = obj({
  schemaVersion: lit(1),
  runId: str({ minLength: 1 }),
  instance: str({ minLength: 1 }),
  status: RexStatusSchema,
  /** 第几轮；steer 在空闲时递增，忙时并入当前轮。 */
  run: int({ minimum: 0 }),
  resultRevision: int({ minimum: 0 }),
  pid: int({ minimum: 1 }),
  sessionFile: union([str({ minLength: 1 }), nul()]),
  runStartLeaf: union([str({ minLength: 1 }), nul()]),
  leafId: union([str({ minLength: 1 }), nul()]),
  block: union([str({ minLength: 1 }), nul()]),
  /** 最近一次被 stop 抑制的轮次；仅用于观察，不改变 agent_settled 的真实 aborted。 */
  suppressedRevision: int({ minimum: 0 }),
  error: union([str(), nul()]),
  updatedAt: str({ minLength: 1 }),
});
export type RexWorkerState = Static<typeof RexWorkerStateSchema>;

export const RexWorkerResultSchema = obj({
  schemaVersion: lit(1),
  runId: str({ minLength: 1 }),
  revision: int({ minimum: 1 }),
  outcome: RexOutcomeSchema,
  text: str(),
  error: union([str(), nul()]),
  sessionFile: union([str({ minLength: 1 }), nul()]),
  leafId: union([str({ minLength: 1 }), nul()]),
  completedAt: str({ minLength: 1 }),
});
export type RexWorkerResult = Static<typeof RexWorkerResultSchema>;

export const RexAssociationSchema = obj({
  schemaVersion: lit(1),
  runId: str({ minLength: 1 }),
  sessionId: str({ minLength: 1 }),
  instance: str({ minLength: 1 }),
  blockId: str({ minLength: 1 }),
  layerId: union([str({ minLength: 1 }), nul()]),
  label: str({ minLength: 1 }),
  socketPath: str({ minLength: 1 }),
  createdAt: str({ minLength: 1 }),
  updatedAt: str({ minLength: 1 }),
});
export type RexAssociation = Static<typeof RexAssociationSchema>;

export interface OwnerLockRecord {
  pid: number;
  token: string;
}

export interface RexSessionEntry {
  id: string;
  type: string;
  message?: unknown;
}

/** 阶段目录内稳定路径；调用方只传 run 目录，不自行拼字符串。 */
export function rexDirectory(runDirectory: string): string {
  return join(runDirectory, REX_DIR);
}
export function rexAssociationPath(runDirectory: string): string {
  return join(runDirectory, REX_ASSOCIATION_FILE);
}
export function rexManifestPath(runDirectory: string): string {
  return join(rexDirectory(runDirectory), "manifest.json");
}
export function rexStatePath(runDirectory: string): string {
  return join(rexDirectory(runDirectory), "state.json");
}
export function rexOwnerPath(runDirectory: string): string {
  return join(rexDirectory(runDirectory), "owner.json");
}
export function rexPromptPath(runDirectory: string): string {
  return join(rexDirectory(runDirectory), "prompt.txt");
}
export function rexSocketPath(runDirectory: string): string {
  return join(rexDirectory(runDirectory), "bridge.sock");
}
export function rexResultsDirectory(runDirectory: string): string {
  return join(rexDirectory(runDirectory), "results");
}
export function rexResultPath(runDirectory: string, revision: number): string {
  return join(rexResultsDirectory(runDirectory), `${revision}.json`);
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Rex 状态文件不是合法 JSON：${path}`);
  }
}

function writeJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readValidated<T>(path: string, schema: Parameters<typeof checkSchema>[0], label: string): T | null {
  const raw = readJson(path);
  if (raw === null) return null;
  if (!checkSchema(schema, raw)) throw new Error(`${label} 结构不符：${path}`);
  return raw as T;
}

export function readRexWorkerManifest(path: string): RexWorkerManifest | null {
  return readValidated<RexWorkerManifest>(path, RexWorkerManifestSchema, "Rex manifest");
}

export function writeRexWorkerManifest(path: string, manifest: RexWorkerManifest): void {
  if (!checkSchema(RexWorkerManifestSchema, manifest)) throw new Error("Rex manifest 结构不符");
  writeJson(path, manifest);
}

export function readRexWorkerState(path: string): RexWorkerState | null {
  return readValidated<RexWorkerState>(path, RexWorkerStateSchema, "Rex worker state");
}

export function writeRexWorkerState(path: string, state: RexWorkerState): void {
  if (!checkSchema(RexWorkerStateSchema, state)) throw new Error("Rex worker state 结构不符");
  writeJson(path, state);
}

export function readRexWorkerResult(path: string): RexWorkerResult | null {
  return readValidated<RexWorkerResult>(path, RexWorkerResultSchema, "Rex worker result");
}

export function writeRexWorkerResult(directory: string, result: RexWorkerResult): void {
  if (!checkSchema(RexWorkerResultSchema, result)) throw new Error("Rex worker result 结构不符");
  ensurePrivateDirectory(join(directory, "results"));
  writeJson(join(directory, "results", `${result.revision}.json`), result);
}

/** 取最高 revision 的已发布结果；恢复与等待都以结果文件优先于状态猜测。 */
export function readLatestRexWorkerResult(directory: string): RexWorkerResult | null {
  const results = join(directory, "results");
  if (!existsSync(results)) return null;
  const revisions = readdirSync(results)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => Number.parseInt(name.slice(0, -5), 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((a, b) => b - a);
  for (const revision of revisions) {
    const result = readRexWorkerResult(join(results, `${revision}.json`));
    if (result !== null) return result;
  }
  return null;
}

export function readRexAssociation(path: string): RexAssociation | null {
  return readValidated<RexAssociation>(path, RexAssociationSchema, "Rex 关联");
}

export function writeRexAssociation(path: string, association: RexAssociation): void {
  if (!checkSchema(RexAssociationSchema, association)) throw new Error("Rex 关联结构不符");
  writeJson(path, association);
}

export function readRexPrompt(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeRexPrompt(path: string, prompt: string): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, prompt, { mode: 0o600 });
}

/** 与引用实现一致的保守存活判定：无法确认已退出时不抢 owner。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readOwner(path: string): OwnerLockRecord | null {
  try {
    const raw = readJson(path);
    if (raw === null || typeof raw !== "object") return null;
    const record = raw as Partial<OwnerLockRecord>;
    return typeof record.pid === "number" && typeof record.token === "string"
      ? { pid: record.pid, token: record.token }
      : null;
  } catch {
    // 半写或损坏的 owner 不能证明存活；按陈旧锁尝试接管。
    return null;
  }
}

/**
 * 获取 worker 单实例锁。存活 owner 永远不被抢占；只有缺失／已退出／损坏才重试一次。
 * 返回释放函数；只有 token 仍匹配时才删除，避免误删后来 owner。
 */
export function acquireOwnerLock(path: string): () => void {
  ensurePrivateDirectory(dirname(path));
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(fd);
      }
      return () => {
        if (readOwner(path)?.token === token) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readOwner(path);
      if (owner !== null && isProcessAlive(owner.pid)) {
        throw new Error(`Rex worker 已有存活 owner：${path}`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error(`无法取得 Rex worker owner 锁：${path}`);
}

export function activeRexStatus(status: RexStatus): boolean {
  return status === "running" || status === "blocked";
}

export function terminalRexStatus(status: RexStatus): boolean {
  return status === "completed" || status === "aborted" || status === "error" || status === "closed";
}

/** 从会话分支提取本轮最后一条 assistant 消息并判定 outcome（与参考实现一致）。 */
export function finishRun(
  state: RexWorkerState,
  entries: readonly RexSessionEntry[],
  aborted: boolean,
  leafId: string | null,
): RexWorkerResult {
  const boundary = state.runStartLeaf === null ? -1 : entries.findIndex((entry) => entry.id === state.runStartLeaf);
  const messages = entries
    .slice(boundary + 1)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
      content?: unknown;
    })
    .filter((message) => typeof message === "object" && message !== null);
  const assistant = messages.findLast((message) => message.role === "assistant");
  const failure = assistant?.stopReason === "error" || assistant?.stopReason === "length";
  const outcome: RexOutcome =
    aborted || assistant?.stopReason === "aborted"
      ? "aborted"
      : failure || assistant === undefined
        ? "error"
        : "completed";
  const text = assistantText(assistant?.content);
  const error =
    outcome === "aborted"
      ? "Rex worker run was interrupted"
      : outcome === "error"
        ? assistant?.errorMessage ??
          (assistant === undefined
            ? "Rex worker settled before producing an assistant response"
            : `Rex worker stopped with ${assistant.stopReason ?? "unknown"}`)
        : null;
  const revision = Math.max(1, state.run);
  return {
    schemaVersion: 1,
    runId: state.runId,
    revision,
    outcome,
    text,
    error,
    sessionFile: state.sessionFile,
    leafId,
    completedAt: new Date().toISOString(),
  };
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: string; text?: unknown } =>
        typeof part === "object" && part !== null && "type" in part,
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** 仅测试／显式清理使用：删除整个 rex 私有目录，不碰核心 run 文件。 */
export function removeRexDirectory(runDirectory: string): void {
  rmSync(rexDirectory(runDirectory), { recursive: true, force: true });
  rmSync(rexAssociationPath(runDirectory), { force: true });
}

export function newRexInstance(randomHex: (bytes: number) => string = (bytes) => randomUUID().replace(/-/g, "").slice(0, bytes * 2)): string {
  return `rex-${randomHex(6)}`;
}

export type { Static };

/** 从 bridge 帧或文件内容解析 worker 状态；结构不符返回 null，不冒认。 */
export function parseRexWorkerState(raw: unknown): RexWorkerState | null {
  if (!checkSchema(RexWorkerStateSchema, raw)) return null;
  return raw as RexWorkerState;
}
