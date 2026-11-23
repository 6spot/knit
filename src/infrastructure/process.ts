/**
 * POSIX 进程与 Git argv 基础。
 * 进程身份是进程号加启动标识；只凭进程号判断不了是不是原来那个进程。
 * Git 统一参数数组、项目 cwd、固定环境，不经 shell 拼接。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * 进程启动标识：Linux 读 /proc stat 字段；其它平台回退 ps 表的「lstart|comm」文本
 * （lstart 只精确到秒，追加可执行名降低同秒 PID 复用误判；同平台自洽）。
 */
export function procStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = afterComm.split(" ");
    // stat 全字段第 22 项（1 基）；去掉前两项（pid、comm）后是第 20 项（0 基）。
    const value = fields[19];
    return typeof value === "string" && /^\d+$/.test(value) ? value : null;
  } catch {
    // 非 Linux：/proc 不存在，走 ps 回退。
    return processTable().get(pid)?.startTicks ?? null;
  }
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
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * `file` 里登记的进程（`{ pid, start }`）还在时返回它的进程号；文件不存在或者进程不在时是 null。
 * 进程号会被别的进程重新用上，启动标识一样才是原来那个。
 * 仅当启动或核对阶段进程表不可用（例如 macOS 沙箱禁止执行 setuid /bin/ps）导致无法核对启动标识时，
 * 退回 kill(pid, 0) 判活，避免把仍在运行的后台执行者误判为已退出。
 */
export function recordedProcess(file: string): number | null {
  if (!existsSync(file)) return null;
  const recorded = JSON.parse(readFileSync(file, "utf8")) as { pid: number; start: string | null };
  if (!Number.isInteger(recorded.pid) || recorded.pid <= 0) return null;
  const table = processTable();
  const current = table.get(recorded.pid)?.startTicks ?? null;
  if (recorded.start !== null && current !== null) {
    return sameProcessStart(recorded.start, current) ? recorded.pid : null;
  }
  if (recorded.start === null || table.size === 0) {
    return pidAlive(recorded.pid) ? recorded.pid : null;
  }
  return null;
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
export function gitSync(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}

/**
 * 只读进程表：pid、ppid、进程组与启动标识；解析失败条目跳过。
 * Linux 直接读 /proc；其它平台（macOS 等）回退 `ps -eo`——startTicks 用 lstart 文本，
 * 只要写入与核对在同一平台就保持一致（同一份运行资料不支持跨平台混用）。
 */
export function processTable(): Map<number, { ppid: number; pgid: number; startTicks: string | null }> {
  try {
    const table = new Map<number, { ppid: number; pgid: number; startTicks: string | null }>();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
        const fields = afterComm.split(" ");
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        const start = fields[19];
        if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
        table.set(pid, { ppid, pgid, startTicks: typeof start === "string" && /^\d+$/.test(start) ? start : null });
      } catch {
        // 进程在枚举时退出。
      }
    }
    return table;
  } catch {
    return processTablePs();
  }
}

/** ps 回退进程表（macOS 等）；固定C语言环境，按字段解析而不假设lstart列宽；comm 放最后一列（可含空格）。 */
function processTablePs(): Map<number, { ppid: number; pgid: number; startTicks: string | null }> {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,lstart=,comm="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return new Map();
  return parseProcessTablePs(result.stdout);
}

/**
 * 纯解析入口用于Linux／macOS的ps夹具；身份为标准化lstart文本，有 comm 列时追加「|comm」。
 * lstart 只精确到秒，同秒复用 PID 时可执行名不同即可区分；同名同秒仍无法区分（已知限制）。
 */
export function parseProcessTablePs(output: string): Map<number, { ppid: number; pgid: number; startTicks: string | null }> {
  const table = new Map<number, { ppid: number; pgid: number; startTicks: string | null }>();
  for (const line of output.split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})(?:\s+(\S.*))?$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    // 维持ps既有lstart文本的单日两列格式，避免同日不同空白产生不同身份。
    const startText = `${match[4]} ${match[5]} ${match[6]!.padStart(2, " ")} ${match[7]} ${match[8]}`;
    const comm = match[9]?.trim() ?? "";
    table.set(pid, { ppid, pgid, startTicks: comm === "" ? startText : `${startText}${PS_IDENTITY_SEPARATOR}${comm}` });
  }
  return table;
}

/** 根进程的完整后代 PID（含根）；只按当前 /proc 或 ps 快照，进程表不可用时退回根进程本身。 */
export function processTreePids(rootPid: number): number[] {
  const table = processTable();
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
  knownPids: number[] = processTreePids(rootPid),
): { signaled: number[]; errors: string[] } {
  const table = processTable();
  const groups = new Set<number>();
  for (const pid of knownPids) {
    const entry = table.get(pid);
    if (entry !== undefined && entry.pgid > 0) groups.add(entry.pgid);
  }
  if (table.size === 0 && rootPid > 0) groups.add(rootPid);
  const signaled: number[] = [];
  const errors: string[] = [];
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
      signaled.push(-pgid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") errors.push(`${-pgid}:${code ?? String(error)}`);
    }
  }
  for (const pid of knownPids) {
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
