/**
 * POSIX 进程与 Git argv 基础。
 * 进程身份是进程号加启动标识；只凭进程号判断不了是不是原来那个进程。
 * Git 统一参数数组、项目 cwd、固定环境，不经 shell 拼接。
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, resolve, sep } from "node:path";

/** 只核对 POSIX 可执行文件，不启动客户端。 */
export function findExecutable(name: string): string | null {
  const paths = name.includes(sep) ? [resolve(name)] : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, name));
  return paths.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  }) ?? null;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * 进程启动标识：Linux 读 /proc stat 字段；其它平台回退 ps 表的「lstart|comm」文本
 * （lstart 只精确到秒，追加可执行名降低同秒 PID 复用误判；同平台自洽）。
 */
export function procStartTicks(pid: number): string | null {
  return processIdentities([pid])?.get(pid)?.startTicks ?? null;
}

/** ps 回退身份中 lstart 与可执行名的分隔符；Linux starttime 纯数字，不含此字符。 */
const PS_IDENTITY_SEPARATOR = "|";

/**
 * 比较记录的启动标识与当前读到的启动标识。
 * 两侧都带可执行名时全量比较；任一侧是旧格式（只有 lstart）时只比 lstart，
 * 避免升级前写入的记录因格式不同被误判为 PID 复用。
 */
export function sameProcessStart(recorded: string, current: string): boolean {
  if (recorded === current) return true;
  if (!recorded.includes(PS_IDENTITY_SEPARATOR) || !current.includes(PS_IDENTITY_SEPARATOR)) {
    return recorded.split(PS_IDENTITY_SEPARATOR)[0] === current.split(PS_IDENTITY_SEPARATOR)[0];
  }
  return false;
}

/** POSIX kill(pid, 0) 判活：ESRCH 表示不存在；存活或无权限（EPERM）视为仍存活。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `file` 里登记的进程（`{ pid, start }`）还在时返回它的进程号；文件不存在或者进程不在时是 null。
 * 进程号会被别的进程重新用上，启动标识一样才是原来那个。
 * 仅当启动或核对阶段进程表不可用（例如 macOS 沙箱禁止执行 setuid /bin/ps）导致无法核对启动标识时，
 * 退回 kill(pid, 0) 判活，避免把仍在运行的后台执行者误判为已退出。
 */
export interface WorkerProcess {
  readonly pid: number;
  readonly start: string | null;
}

export function readProcessRegistration(file: string): WorkerProcess | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
      (typeof value.start === "string" || value.start === null) ? { pid: value.pid, start: value.start } : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function recordedProcess(file: string): number | null {
  return registeredPid(readProcessRegistration(file));
}

export function registeredPid(recorded: WorkerProcess | null, identities?: ProcessTable | null): number | null {
  if (!recorded) return null;
  const table = identities === undefined ? processIdentities([recorded.pid]) : identities;
  if (table === null) return pidAlive(recorded.pid) ? recorded.pid : null;
  const current = table.get(recorded.pid)?.startTicks;
  return current != null && (recorded.start === null || sameProcessStart(recorded.start, current)) ? recorded.pid : null;
}

/** Git 固定环境：禁 pager／fsmonitor／textconv，诊断读取不受用户配置干扰。 */
const GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  LC_ALL: "C",
};

/** 同步 Git 调用：参数数组直接传给 git，不经 shell。 */
export function gitSync(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024, input?: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
    maxBuffer,
    input,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}

type ProcessTable = Map<number, { ppid: number; pgid: number; startTicks: string | null }>;

/** 定向查询。空表表示没有匹配的 PID；null 表示 ps 不可用，需要重新判活。 */
export function processIdentities(pids: readonly number[]): ProcessTable | null {
  const live = [...new Set(pids)].filter(pidAlive);
  if (!live.length) return new Map();
  if (process.platform === "linux") {
    const table = readProcStats(live);
    if (table.size || existsSync("/proc/self/stat")) return table;
  }
  return processTablePs(["-p", live.join(","), "-o"]);
}

/** 根进程的后代可能属于其它进程组，查找它们需要整机快照。 */
export function processTable(): ProcessTable {
  if (process.platform === "linux") {
    try {
      return readProcStats(readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number));
    } catch { /* /proc 未挂载时回退 ps。 */ }
  }
  return processTablePs(["-eo"]) ?? new Map();
}

function readProcStats(pids: readonly number[]): ProcessTable {
  const table: ProcessTable = new Map();
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue;
      const ppid = Number(fields[1]);
      const pgid = Number(fields[2]);
      const start = fields[19];
      if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
      table.set(pid, { ppid, pgid, startTicks: typeof start === "string" && /^\d+$/.test(start) ? start : null });
    } catch { /* 进程在读取前退出。 */ }
  }
  return table;
}

function processTablePs(selection: string[]): ProcessTable | null {
  const result = spawnSync("ps", [...selection, "pid=,ppid=,pgid=,stat=,lstart=,comm="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.stderr || (result.status !== 0 && result.status !== 1)) return null;
  return parseProcessTablePs(result.stdout ?? "");
}

/**
 * 纯解析入口用于Linux／macOS的ps夹具；身份为标准化lstart文本，有 comm 列时追加「|comm」。
 * lstart 只精确到秒，同秒复用 PID 时可执行名不同即可区分；同名同秒仍无法区分（已知限制）。
 */
export function parseProcessTablePs(output: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of output.split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})(?:\s+(\S.*))?$/.exec(line.trim());
    if (match === null || match[4]!.startsWith("Z")) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    // 维持ps既有lstart文本的单日两列格式，避免同日不同空白产生不同身份。
    const startText = `${match[5]} ${match[6]} ${match[7]!.padStart(2, " ")} ${match[8]} ${match[9]}`;
    const comm = match[10]?.trim() ?? "";
    table.set(pid, { ppid, pgid, startTicks: comm === "" ? startText : `${startText}${PS_IDENTITY_SEPARATOR}${comm}` });
  }
  return table;
}

/** 根进程的完整后代 PID（含根）；只按当前 /proc 或 ps 快照，进程表不可用时退回根进程本身。 */
export function processTreePids(rootPid: number, table = processTable()): number[] {
  if (table.size === 0) return pidAlive(rootPid) ? [rootPid] : [];
  if (!table.has(rootPid)) return [];
  const children = new Map<number, number[]>();
  for (const [pid, item] of table) {
    const list = children.get(item.ppid) ?? [];
    list.push(pid);
    children.set(item.ppid, list);
  }
  const result: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (result.includes(pid)) continue;
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

/**
 * 向根进程及其后代发送信号：优先向各自的进程组发送，再逐个 PID 兜底。
 * 调用方负责先核实根 PID 身份；返回成功发出的 PID 与错误，不把 ESRCH 当失败。
 */
export function signalProcessTree(
  rootPid: number,
  signal: NodeJS.Signals,
  knownPids?: number[],
  table = processTable(),
): { signaled: number[]; errors: string[] } {
  const targets = knownPids ?? processTreePids(rootPid, table);
  const groups = new Set<number>();
  for (const pid of targets) {
    const entry = table.get(pid);
    if (entry !== undefined && entry.pgid > 0) groups.add(entry.pgid);
  }
  if (table.size === 0 && rootPid > 0) groups.add(rootPid);
  const signaled: number[] = [];
  const errors: string[] = [];
  for (const pgid of groups) {
    if (pgid === table.get(process.pid)?.pgid) continue;
    try {
      if (signalProcessGroup(pgid, signal, { exited: !targets.includes(pgid) })) signaled.push(-pgid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") errors.push(`${-pgid}:${code ?? String(error)}`);
    }
  }
  for (const pid of targets) {
    if (table.size > 0 && !table.has(pid)) continue;
    try {
      process.kill(pid, signal);
      signaled.push(pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") errors.push(`${pid}:${code ?? String(error)}`);
    }
  }
  return { signaled, errors };
}

export type SignalFunction = (pid: number, signal: NodeJS.Signals) => unknown;

/** BSD 上只剩僵尸的组也可能返回 EPERM；组长仍归调用方时向组长兜底。 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals, options: { exited: boolean; kill?: SignalFunction }): boolean {
  const kill = options.kill ?? ((target, value) => process.kill(target, value));
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code !== "EPERM") throw error;
    if (options.exited) return false;
  }
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw error;
  }
}

export const MAIN_SESSION_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_OFFLINE"];

export function executorEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  MAIN_SESSION_KEYS.forEach((key) => delete env[key]);
  return env;
}

/** SQLite 的文件锁随进程退出释放，派发、结算和共享钩子按各自的资源路径互斥。 */
export function withFileLock<T>(path: string, timeout: number, action: () => T, busy: () => T, readOnly = false): T {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const Database = process.getBuiltinModule("node:sqlite").DatabaseSync;
  // 清理可能在打开之后回收旧 inode。取得锁后复核，旧连接不能进入业务临界区。
  for (;;) {
    const before = statSync(path, { bigint: true, throwIfNoEntry: false });
    const lock = new Database(path, { timeout, readOnly });
    try {
      if (!before) continue;
      try { lock.exec(readOnly ? "PRAGMA user_version" : "BEGIN EXCLUSIVE"); }
      catch (error) {
        if (error instanceof Error && "errcode" in error && error.errcode === 5) return busy();
        throw error;
      }
      const current = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (before.ino === current?.ino && before.dev === current.dev) return action();
    } finally { lock.close(); }
  }
}
