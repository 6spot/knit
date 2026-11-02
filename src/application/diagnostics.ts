/**
 * 只读诊断与存储统计（DESIGN.md 第4.1节、TECHNOLOGY.md 第8节）。
 * 不创建目录、不迁移数据库、不写日志；容量只作提示。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig, defaultConfig, type ProjectConfig } from "./config.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { LockManager } from "../infrastructure/locks.js";

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
  locks: { entries: number; bytes: number };
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
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const table of ["sessions", "bindings", "operations", "standards_reviews"]) {
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown };
          counts[table] = typeof row.n === "number" ? row.n : Number(row.n ?? 0);
        } catch {
          counts[table] = -1;
        }
      }
    } finally {
      db.close();
    }
  } catch {
    counts.unavailable = -1;
  }
  return counts;
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
  const piBin = input.piBin ?? process.env.KNIT_PI_BIN ?? "pi";
  const piVersion = spawnSync(piBin, ["--version"], { encoding: "utf8", timeout: 5000 });
  add("pi", piVersion.status === 0 ? "ok" : "fail", piVersion.status === 0 ? piVersion.stdout.trim() : `无法运行 ${piBin}`);
  add("protocol", "ok", `protocol=${PROTOCOL_VERSION}；package=${packageVersion()}`);
  const locksRoot = input.locksRoot ?? process.env.KNIT_LOCKS_ROOT ?? join(process.env.HOME ?? "", ".knit", "locks");
  if (!existsSync(locksRoot)) {
    add("locks", "warn", "锁根尚未创建（首次代码阶段会创建）");
  } else {
    try {
      const entries = new LockManager({ root: locksRoot }).list();
      const stale = entries.filter((entry) => entry.exists && entry.processVerdict === "not_alive").length;
      const unknown = entries.filter((entry) => entry.exists && entry.processVerdict === "unknown").length;
      const alive = entries.filter((entry) => entry.processVerdict === "alive").length;
      const staleAfter = config.config?.limits.heartbeatStaleMs ?? defaultConfig().limits.heartbeatStaleMs;
      const staleHeartbeat = entries.filter((entry) => {
        if (entry.processVerdict !== "alive" || entry.owner === null) return false;
        const at = Date.parse(entry.owner.heartbeatAt);
        return Number.isFinite(at) && Date.now() - at > staleAfter;
      }).length;
      add(
        "locks",
        entries.length === 0 || (stale === 0 && unknown === 0 && staleHeartbeat === 0) ? "ok" : "warn",
        entries.length === 0
          ? `${locksRoot}（无锁记录）`
          : `${locksRoot}；总计 ${entries.length}，alive ${alive}，stale ${stale}，unknown ${unknown}，心跳超 ${staleAfter}ms ${staleHeartbeat}；解锁需 owner token 与 --force 限制`,
      );
    } catch (error) {
      add("locks", "warn", `锁记录无法读取: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
  const locksRoot = input.locksRoot ?? process.env.KNIT_LOCKS_ROOT ?? join(process.env.HOME ?? "", ".knit", "locks");
  const lockStats = treeStats(locksRoot);
  const total = dbBytes + walBytes + runBytes;
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
    locks: { entries: lockStats.files, bytes: lockStats.bytes },
    limits: { storageWarnBytes: config.limits.storageWarnBytes },
    warnings,
  };
}
