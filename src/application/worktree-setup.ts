/** 同步派发持有任务锁。这个子进程负责异步消费 setup 输出和监督命令组。 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { signalProcessGroup } from "../infrastructure/process.js";

const { commands, timeoutSeconds, parent }: { commands: string[]; timeoutSeconds: number | null; parent: number } =
  JSON.parse(readFileSync(0, "utf8"));
const limit = 64 * 1024;
let remaining = limit;
for (const command of commands) {
  const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let tail = Buffer.alloc(0);
  const progress = (chunk: Buffer) => {
    if (remaining > 0) {
      const prefix = chunk.subarray(0, remaining);
      process.stderr.write(prefix);
      remaining -= prefix.length;
      if (!remaining) process.stderr.write("\n准备命令的进度输出已达 64 KiB。\n");
    }
    tail = Buffer.concat([tail, chunk.subarray(-limit)]).subarray(-limit);
  };
  child.stdout.on("data", progress);
  child.stderr.on("data", progress);
  const stop = () => {
    if (!child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    else signalProcessGroup(child.pid, "SIGKILL", { exited: child.exitCode !== null || child.signalCode !== null });
  };
  const deadline = timeoutSeconds == null ? Infinity : Date.now() + timeoutSeconds * 1000;
  let reason = "";
  const interrupt = () => { reason = "准备命令被中断"; stop(); };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const watch = setInterval(() => {
    if (process.ppid !== parent) interrupt();
    if (Date.now() >= deadline) { reason = `准备命令超时（${timeoutSeconds} 秒）`; stop(); }
  }, 100);
  child.once("error", (error) => { reason = error.message; });
  const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearInterval(watch);
  process.off("SIGTERM", interrupt);
  process.off("SIGINT", interrupt);
  if (status !== 0 || reason) {
    process.stdout.write(`准备命令失败：${command}\n退出码：${status ?? -1}${reason ? `（${reason}）` : ""}\n${tail.toString()}`);
    process.exitCode = 1;
    break;
  }
}
