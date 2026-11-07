/**
 * 只读诊断与存储统计（DESIGN.md 第4.1节、TECHNOLOGY.md 第8节）。
 * 不创建目录、不迁移数据库、不写日志；容量只作提示。
 */
import { existsSync, readFileSync, readdirSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig, defaultConfig, schedulerSettingsOf, worktreeSettingsOf, type ProjectConfig } from "./config.js";
import { loadWorkflow } from "./workflow.js";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import { hashKey, normalizeRoot } from "../infrastructure/paths.js";
import { LockManager, heartbeatState, type LockEntry, type LockReclaimRecord } from "../infrastructure/locks.js";
import { withReadOnlyDatabase } from "../infrastructure/sqlite-readonly.js";
import { countGcCandidates } from "./gc.js";
import { parseTaskDocument } from "./task-document.js";

const RUNTIME = ".knit/.runtime";
const DB = join(RUNTIME, "metadata.db");

export interface DiagnosticCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  projectRoot: string;
  protocolVersion: number;
  checks: DiagnosticCheck[];
}

export interface StorageResult {
  projectRoot: string;
  database: {
    path: string;
    exists: boolean;
    bytes: number;
    walBytes: number;
    counts: Record<string, number>;
  };
  tasks: { active: number; archived: number };
  runs: { count: number; bytes: number };
  snapshots: { count: number; bytes: number };
  /** 原生会话目录；不复制正文，只统计占用。 */
  nativeSessions: { count: number; bytes: number };
  diagnostics: { bytes: number };
  /** Git 基线引用只报数量，不与共享对象字节相加。 */
  baselines: { count: number };
  locks: { entries: number; bytes: number };
  /** 引用核验后仍可回收的候选数；只读摘要，不自动清理。 */
  gcCandidates: number;
  limits: { storageWarnBytes: number };
  warnings: string[];
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function treeStats(path: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += fileBytes(child);
      }
    }
  };
  walk(path);
  return { files, bytes };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}

function configOf(root: string): { config: ProjectConfig | null; problem: string | null } {
  const path = join(root, ".knit", "config.json");
  if (!existsSync(path)) return { config: null, problem: "缺少 .knit/config.json" };
  try {
    return { config: parseConfig(readFileSync(path, "utf8")), problem: null };
  } catch (error) {
    return { config: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

function metadataCounts(path: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!existsSync(path)) return counts;
  try {
    return withReadOnlyDatabase(path, (db) => {
      for (const table of ["sessions", "bindings", "operations", "standards_reviews"]) {
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown };
          counts[table] = typeof row.n === "number" ? row.n : Number(row.n ?? 0);
        } catch {
          counts[table] = -1;
        }
      }
      return counts;
    });
  } catch {
    counts.unavailable = -1;
    return counts;
  }
}

/** 未归档已完成任务缺完成凭据：手工改状态的痕迹；只告警，不改业务状态。 */
function completionEvidenceGaps(root: string): string[] {
  const tasksRoot = join(root, ".knit", "tasks");
  const gaps: string[] = [];
  let entries;
  try {
    entries = readdirSync(tasksRoot, { withFileTypes: true });
  } catch {
    return gaps;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const file = join(tasksRoot, entry.name, "task.md");
    if (!existsSync(file)) continue;
    try {
      const document = parseTaskDocument(readFileSync(file, "utf8"), file);
      const facts = document.frontmatter;
      if (facts.status !== "closed" || facts.outcome !== "completed") continue;
      if (!existsSync(join(root, ".knit", ".runtime", "completions", `${facts.id}.json`))) gaps.push(facts.id);
    } catch {
      // task.md 结构问题由列表与读取路径报告，这里不重复。
    }
  }
  return gaps;
}

/**
 * 锁条目是否属于本项目（只读判定，不建目录）：
 * project／task 键以主检出根、`<根>::`、`schedule:<根>` 或本项目 worktree 容器为前缀；
 * session 键按本项目 run 阶段进程记录中的原生 ID，或与本项目锁 owner 同一进程身份判定。
 */
export function locksForProject<T extends LockEntry>(root: string, entries: T[]): T[] {
  const worktreeRoots = [
    join(root, ".knit", "worktrees") + "/",
    join(homedir(), ".knit", "worktrees", `${basename(root)}-${hashKey(root).slice(0, 8)}`) + "/",
  ];
  const ownsKey = (key: string): boolean =>
    key === root ||
    key.startsWith(`${root}::`) ||
    key === `schedule:${root}` ||
    worktreeRoots.some((prefix) => key.startsWith(prefix));
  const sessionKeys = new Set<string>();
  const runsDir = join(root, RUNTIME, "runs");
  try {
    for (const name of readdirSync(runsDir)) {
      const stage = readJson(join(runsDir, name, "stage-process.json"));
      if (typeof stage?.nativeSessionId === "string") sessionKeys.add(`pi:${stage.nativeSessionId}`);
    }
  } catch {
    // 无 run 记录
  }
  const projectOwners = new Set<string>();
  for (const entry of entries) {
    if (entry.scope !== "session" && entry.key !== null && ownsKey(entry.key) && entry.owner !== null) {
      projectOwners.add(`${entry.owner.machineBootId}\u0000${entry.owner.pid}\u0000${entry.owner.procStartTicks ?? ""}`);
    }
  }
  return entries.filter((entry) => {
    if (entry.key === null) return false;
    if (entry.scope !== "session") return ownsKey(entry.key);
    if (sessionKeys.has(entry.key)) return true;
    const owner = entry.owner;
    return owner !== null && projectOwners.has(`${owner.machineBootId}\u0000${owner.pid}\u0000${owner.procStartTicks ?? ""}`);
  });
}

/** 自动回收记录是否属于本项目：按回收时记录的业务键同规则判定。 */
export function reclaimsForProject(root: string, records: LockReclaimRecord[]): LockReclaimRecord[] {
  const asEntries = records.map((record) => ({
    exists: true, owner: record.previousOwner, processVerdict: "not_alive" as const,
    scope: record.scope, id: record.id, hash: record.id.split("/")[1] ?? "", path: "", key: record.key, record,
  }));
  return locksForProject(root, asEntries).map((entry) => entry.record);
}

export function doctor(input: { dir: string; piBin?: string; locksRoot?: string }): DoctorResult {
  const root = normalizeRoot(input.dir);
  const checks: DiagnosticCheck[] = [];
  const add = (name: string, status: DiagnosticCheck["status"], detail: string): void => {
    checks.push({ name, status, detail });
  };
  const configPath = join(root, ".knit", "config.json");
  const config = configOf(root);
  add("config", config.config === null ? "fail" : "ok", config.problem ?? "config.json 可解析");
  if (config.config !== null) {
    const scheduler = schedulerSettingsOf(config.config);
    const worktree = worktreeSettingsOf(config.config);
    add(
      "scheduler",
      "ok",
      `maxConcurrent=${scheduler.maxConcurrent}；maxAttempts=${scheduler.maxAttempts}；worktree.default=${worktree.default}`,
    );
  }
  const workflow = loadWorkflow(root);
  const workflowChain = ["准备", ...workflow.workflow.stages.map((stage) => stage.name), "收尾"].join(" → ");
  add(
    "workflow",
    workflow.mode === "config" ? "ok" : "warn",
    workflow.mode === "config"
      ? `${existsSync(join(root, WORKFLOW_CONFIG_PATH)) ? WORKFLOW_CONFIG_PATH : "缺省模板"}；${workflowChain}`
      : `配置降级：${workflow.validation.reason}；${workflow.validation.issues[0]?.message ?? "问题见 knit workflow validate"}`,
  );
  const manifest = readJson(join(root, RUNTIME, "init-manifest.json"));
  add("init-manifest", manifest === null ? "fail" : manifest.state === "ready" ? "ok" : "warn", manifest === null ? "缺少初始化清单" : `state=${String(manifest.state)}`);
  const installation = readJson(join(root, RUNTIME, "installation.json"));
  const cliEntry = typeof installation?.cliEntry === "string" ? installation.cliEntry : null;
  add("installation", cliEntry !== null && existsSync(cliEntry) ? "ok" : "fail", cliEntry === null ? "缺少 CLI 安装映射" : existsSync(cliEntry) ? cliEntry : `CLI 入口不存在: ${cliEntry}`);
  const bridge = join(root, ".pi", "extensions", "knit.ts");
  add("bridge", existsSync(bridge) ? "ok" : "warn", existsSync(bridge) ? bridge : "未发现 .pi/extensions/knit.ts");
  if (cliEntry !== null) {
    const worker = join(dirname(cliEntry), "..", "worker", "knit-worker.js");
    const schema = join(dirname(cliEntry), "..", "contracts", "bridge-tools.json");
    add("worker", existsSync(worker) ? "ok" : "fail", existsSync(worker) ? worker : `worker 不存在: ${worker}`);
    add("bridge-schema", existsSync(schema) ? "ok" : "fail", existsSync(schema) ? schema : `桥接 schema 不存在: ${schema}`);
  } else {
    add("worker", "fail", "无法定位 worker：缺少 CLI 入口");
    add("bridge-schema", "fail", "无法定位桥接 schema：缺少 CLI 入口");
  }
  const dbPath = join(root, DB);
  add("metadata", existsSync(dbPath) ? "ok" : "warn", existsSync(dbPath) ? dbPath : "元数据库尚未创建（首次写操作会创建）");
  const gitHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8" });
  add("git", gitHead.status === 0 ? "ok" : "warn", gitHead.status === 0 ? gitHead.stdout.trim() : "无可用 HEAD（正式代码阶段与交付需要）");
  const branch = spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: root, encoding: "utf8" });
  add("branch", branch.status === 0 ? "ok" : "warn", branch.status === 0 ? branch.stdout.trim() : "当前不是本地分支");
  const remoteFs = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546]);
  try {
    const type = statfsSync(root).type;
    add("filesystem", remoteFs.has(type) ? "fail" : "ok", remoteFs.has(type) ? `项目根位于已知网络／云同步文件系统 (0x${type.toString(16)})` : "项目根文件系统可本地核实");
  } catch (error) {
    add("filesystem", "warn", `项目根文件系统无法核实: ${String(error)}`);
  }
  const syncRoot = ["Dropbox", "iCloud Drive", "OneDrive", "Google Drive"].find((name) => root.includes(`/${name}/`));
  add("cloud-sync", syncRoot === undefined ? "ok" : "warn", syncRoot === undefined ? "未命中已知云同步根" : `项目位于 ${syncRoot}；活跃 runtime 不应跨机同步`);
  const piBin = input.piBin ?? process.env.KNIT_PI_BIN ?? "pi";
  const piVersion = spawnSync(piBin, ["--version"], { encoding: "utf8", timeout: 5000 });
  add("pi", piVersion.status === 0 ? "ok" : "fail", piVersion.status === 0 ? piVersion.stdout.trim() : `无法运行 ${piBin}`);
  add("protocol", "ok", `protocol=${PROTOCOL_VERSION}；package=${packageVersion()}`);
  const locksRoot = input.locksRoot ?? process.env.KNIT_LOCKS_ROOT ?? join(process.env.HOME ?? "", ".knit", "locks");
  if (!existsSync(locksRoot)) {
    add("locks", "warn", "锁根尚未创建（首次代码阶段会创建）");
  } else {
    try {
      const manager = new LockManager({ root: locksRoot });
      const entries = manager.list();
      const stale = entries.filter((entry) => entry.exists && entry.processVerdict === "not_alive").length;
      const reclaimable = entries.filter((entry) => manager.reclaimable(entry)).length;
      const unknown = entries.filter((entry) => entry.exists && entry.processVerdict === "unknown").length;
      const alive = entries.filter((entry) => entry.processVerdict === "alive").length;
      const staleAfter = config.config?.limits.heartbeatStaleMs ?? defaultConfig().limits.heartbeatStaleMs;
      const nowMs = Date.now();
      const aliveEntries = entries.filter((entry) => entry.processVerdict === "alive" && entry.owner !== null);
      const staleHeartbeat = aliveEntries.filter((entry) => heartbeatState(entry.owner, nowMs, staleAfter) === "stale");
      const freshHeartbeat = aliveEntries.filter((entry) => heartbeatState(entry.owner, nowMs, staleAfter) === "fresh").length;
      const reclaims = reclaimsForProject(root, manager.listReclaimed());
      const lastReclaim = reclaims[0];
      const parts = [
        `总计 ${entries.length}`,
        `alive ${alive}（心跳正常 ${freshHeartbeat}，心跳超 ${staleAfter}ms ${staleHeartbeat.length}${staleHeartbeat.length > 0 ? `: ${staleHeartbeat.map((entry) => entry.id).join(", ")}` : ""}）`,
        `stale ${stale}（下次取锁可自动回收 ${reclaimable}）`,
        `unknown ${unknown}`,
      ];
      if (lastReclaim !== undefined) {
        parts.push(`本项目自动回收 ${reclaims.length} 次，最近 ${lastReclaim.reclaimedAt} ${lastReclaim.id}（原 ${lastReclaim.previousOwner.action} pid=${lastReclaim.previousOwner.pid}）`);
      }
      add(
        "locks",
        entries.length === 0 || (stale === 0 && unknown === 0 && staleHeartbeat.length === 0) ? "ok" : "warn",
        entries.length === 0
          ? `${locksRoot}（无锁记录${lastReclaim === undefined ? "" : `；${parts[parts.length - 1]}`}）`
          : `${locksRoot}；${parts.join("，")}；心跳超时只表示可疑，回收以进程核实为准；` +
            "同一启动周期内确认已死的 owner 由下次取锁自动回收，unknown 需 knit locks 核实后 knit unlock <lock-id> --expect-token <token> [--force]",
      );
    } catch (error) {
      add("locks", "warn", `锁记录无法读取: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const completionGaps = completionEvidenceGaps(root);
  add(
    "completion-evidence",
    completionGaps.length === 0 ? "ok" : "warn",
    completionGaps.length === 0 ? "未归档已完成任务均有完成凭据" : `未归档已完成任务缺完成凭据: ${completionGaps.join(", ")}`,
  );
  return {
    ok: checks.every((check) => check.status !== "fail"),
    projectRoot: root,
    protocolVersion: PROTOCOL_VERSION,
    checks,
  };
}

export function storage(input: { dir: string; locksRoot?: string }): StorageResult {
  const root = normalizeRoot(input.dir);
  const config = configOf(root).config ?? defaultConfig();
  const dbPath = join(root, DB);
  const dbBytes = fileBytes(dbPath);
  const walBytes = fileBytes(`${dbPath}-wal`) + fileBytes(`${dbPath}-shm`);
  const tasksRoot = join(root, ".knit", "tasks");
  let activeTasks = 0;
  let archivedTasks = 0;
  const countTasks = (dir: string, archived: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "archive") {
        countTasks(join(dir, entry.name), true);
      } else if (existsSync(join(dir, entry.name, "task.md"))) {
        if (archived) archivedTasks += 1;
        else activeTasks += 1;
      }
    }
  };
  countTasks(tasksRoot, false);
  const runsRoot = join(root, RUNTIME, "runs");
  let runCount = 0;
  let runBytes = 0;
  let snapshotCount = 0;
  let snapshotBytes = 0;
  try {
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      runCount += 1;
      const runPath = join(runsRoot, entry.name);
      runBytes += treeStats(runPath).bytes;
      const snapshot = join(runPath, "snapshot");
      if (existsSync(snapshot)) {
        snapshotCount += 1;
        snapshotBytes += treeStats(snapshot).bytes;
      }
    }
  } catch {
    // 无 run 目录。
  }
  let nativeCount = 0;
  let nativeBytes = 0;
  for (const dir of ["sessions", "pi-sessions", "native-sessions"]) {
    const path = join(root, RUNTIME, dir);
    if (!existsSync(path)) continue;
    const stats = treeStats(path).files;
    if (stats > 0) {
      nativeCount += stats;
      nativeBytes += treeStats(path).bytes;
    }
  }
  const diagnosticsBytes = treeStats(join(root, RUNTIME, "diagnostics")).bytes;
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/knit/bases"], { cwd: root, encoding: "utf8" });
  const baselines = refs.status === 0 ? refs.stdout.split("\n").filter(Boolean).length : 0;
  const locksRoot = input.locksRoot ?? process.env.KNIT_LOCKS_ROOT ?? join(process.env.HOME ?? "", ".knit", "locks");
  const lockStats = treeStats(locksRoot);
  const total = dbBytes + walBytes + runBytes + nativeBytes + diagnosticsBytes;
  const warnings: string[] = [];
  if (total > config.limits.storageWarnBytes) {
    warnings.push(`Knit 运行资料约 ${total} 字节，超过 storageWarnBytes=${config.limits.storageWarnBytes}`);
  }
  if (!existsSync(dbPath)) warnings.push("元数据库尚未创建；尚无绑定、Session 或操作记录");
  return {
    projectRoot: root,
    database: { path: dbPath, exists: existsSync(dbPath), bytes: dbBytes, walBytes, counts: metadataCounts(dbPath) },
    tasks: { active: activeTasks, archived: archivedTasks },
    runs: { count: runCount, bytes: runBytes },
    snapshots: { count: snapshotCount, bytes: snapshotBytes },
    nativeSessions: { count: nativeCount, bytes: nativeBytes },
    diagnostics: { bytes: diagnosticsBytes },
    baselines: { count: baselines },
    locks: { entries: lockStats.files, bytes: lockStats.bytes },
    gcCandidates: countGcCandidates({ dir: root, ...(input.locksRoot === undefined ? {} : { locksRoot: input.locksRoot }) }),
    limits: { storageWarnBytes: config.limits.storageWarnBytes },
    warnings,
  };
}
