/**
 * POSIX 进程与 Git argv 基础（TECHNOLOGY.md 第5节）。
 * 进程身份含机器／启动标识、PID starttime 与本次实例信息；旧 PID 不足以判断存活。
 * Git 统一参数数组、项目 cwd、固定环境，不经 shell 拼接。
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { kill as killProcess } from "node:process";
import type { GitPort, ManagedProcess, ProcessPort } from "../ports/infrastructure.js";
import { InfrastructureError } from "./errors.js";

/** 进程启动标识：Linux 读 /proc stat 字段；其它平台回退 ps 表的 lstart 文本（同平台自洽，任务052/B001）。 */
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

export { currentIdentity } from "./locks.js";

/** Git 固定环境：禁 pager／fsmonitor／textconv，诊断读取不受用户配置干扰。 */
const GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  LC_ALL: "C",
};

export class NodeProcessPort implements ProcessPort {
  private readonly exits = new WeakMap<ManagedProcess, Promise<{ exitCode: number | null; signal: string | null }>>();

  spawn(command: string, args: string[], options: { cwd: string; env?: Record<string, string>; inheritStderr?: boolean; detachStreams?: boolean }): Promise<ManagedProcess> {
    const detachedStreams = options.detachStreams === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: detachedStreams
        ? ["ignore", "ignore", options.inheritStderr === true ? "inherit" : "ignore"]
        : ["pipe", "pipe", options.inheritStderr === true ? "inherit" : "pipe"],
      detached: true, // 独立进程组：外层只管理自身启动的进程组
    });
    if (detachedStreams) child.unref();
    const managed: ManagedProcess = {
      pid: child.pid ?? -1,
      stdin: child.stdin === null
        ? new WritableStream<Uint8Array>({ write() {}, close() {}, abort() {} })
        : new WritableStream<Uint8Array>({
            write(chunk) {
              if (!child.stdin!.write(chunk)) {
                return new Promise((resolve) => child.stdin!.once("drain", resolve));
              }
            },
            close() {
              child.stdin!.end();
            },
            abort() {
              child.stdin!.destroy();
            },
          }),
      stdout: child.stdout === null
        ? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })
        : new ReadableStream<Uint8Array>({
            start(controller) {
              child.stdout!.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              child.stdout!.on("end", () => controller.close());
              child.stdout!.on("error", (error) => controller.error(error));
            },
          }),
      stderr: child.stderr! === null
        ? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })
        : new ReadableStream<Uint8Array>({
            start(controller) {
              child.stderr!.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              child.stderr!.on("end", () => controller.close());
              child.stderr!.on("error", (error) => controller.error(error));
            },
          }),
    };
    // 在返回句柄前订阅退出，wait晚于快速退出调用也能取得真实状态；不依赖/proc。
    const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
      child.once("error", reject);
    });
    void exited.catch(() => {}); // spawn错误由wait返回；尚未等待时不产生未处理拒绝。
    this.exits.set(managed, exited);
    return Promise.resolve(managed);
  }

  wait(process: ManagedProcess): Promise<{ exitCode: number | null; signal: string | null }> {
    return this.exits.get(process) ?? Promise.reject(new InfrastructureError("io_error", "unknown process handle"));
  }

  killProcessGroup(process: ManagedProcess, signal: string): Promise<void> {
    try {
      // 负 PID 定位进程组（detached: true 建立的新进程组）；process.kill 不需 child 引用。
      killProcess(-process.pid, signal as NodeJS.Signals);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        throw new InfrastructureError("io_error", `failed to signal process group ${process.pid}`, { cause: String(error) });
      }
    }
    return Promise.resolve();
  }
}

export class ArgvGitPort implements GitPort {
  constructor(private readonly gitExecutable = "git") {}

  run(args: string[], options: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.gitExecutable, args, {
        cwd: options.cwd,
        env: { ...process.env, ...GIT_ENV },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const finish = (code: number | null, signal: string | null) => {
        resolve({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\n[signal ${signal}]` : stderr });
      };
      child.on("exit", finish);
      child.on("error", (error) => {
        resolve({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` });
      });
    });
  }
}

/** 同步 Git 调用：短命令（status/rev-parse）用；产出大输出的用 ArgvGitPort。 */
export function gitSync(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}

/** 读取 Git 原始对象或二进制输出；不能经过 UTF-8 字符串中转。 */
export function gitBufferSync(args: string[], cwd: string, input?: Buffer): { code: number; stdout: Buffer; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: result.stderr === undefined || result.stderr === null ? String(result.error ?? "") : result.stderr.toString("utf8"),
  };
}

/** 本机启动标识：boot_id + hostname；进程身份跨重启不冒充。 */
export function machineBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // 非 Linux（如 macOS）：sysctl -n kern.bootuuid 给出本次启动的稳定 UUID。
    try {
      const uuid = spawnSync("sysctl", ["-n", "kern.bootuuid"], { encoding: "utf8" }).stdout?.trim() ?? "";
      if (uuid !== "") return uuid;
    } catch {
      // 继续用主机名兜底。
    }
    return `unknown-boot-${hostname()}`;
  }
}

/**
 * 只读进程表：pid、ppid、进程组与启动标识；解析失败条目跳过。
 * Linux 直接读 /proc；其它平台（macOS 等）回退 `ps -eo`——startTicks 用 lstart 文本，
 * 只要写入与核对在同一平台就保持一致（跨平台混用同一锁目录不受支持）。
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

/** ps 回退进程表（macOS 等）；固定C语言环境，按字段解析而不假设lstart列宽。 */
function processTablePs(): Map<number, { ppid: number; pgid: number; startTicks: string | null }> {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0 || !result.stdout) return new Map();
  return parseProcessTablePs(result.stdout);
}

/** 纯解析入口用于Linux／macOS的ps夹具；保留标准化lstart文本作为身份。 */
export function parseProcessTablePs(output: string): Map<number, { ppid: number; pgid: number; startTicks: string | null }> {
  const table = new Map<number, { ppid: number; pgid: number; startTicks: string | null }>();
  for (const line of output.split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    // 维持ps既有lstart文本的单日两列格式，避免同日不同空白产生不同身份。
    const startText = `${match[4]} ${match[5]} ${match[6]!.padStart(2, " ")} ${match[7]} ${match[8]}`;
    table.set(pid, { ppid, pgid, startTicks: startText });
  }
  return table;
}

/** 根进程的完整后代 PID（含根）；只按当前 /proc 快照，不做跨机推断。 */
export function processTreePids(rootPid: number): number[] {
  const table = processTable();
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
    if (!table.has(pid)) continue;
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
