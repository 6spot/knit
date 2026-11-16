/** 执行者的后台进程。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processTable, processTreePids, procStartTicks, sameProcessStart } from "../infrastructure/process.js";
import { RUNS_DIR } from "./run-prepare.js";

/** 一个进程：进程号会被别的进程重新用上，启动标识一样才是原来那个。 */
export interface WorkerProcess {
  readonly pid: number;
  readonly start: string | null;
}

/** 这次执行的后台进程还在时返回它的进程号，不在时是 null。 */
export function liveWorker(root: string, runId: string): number | null {
  const file = join(root, RUNS_DIR, runId, "worker.json");
  if (!existsSync(file)) return null;
  const worker = JSON.parse(readFileSync(file, "utf8")) as { pid: number; start: string | null };
  const current = procStartTicks(worker.pid);
  // 进程号会被别的进程重新用上，启动标识一样才是原来那个。
  return worker.start !== null && current !== null && sameProcessStart(worker.start, current) ? worker.pid : null;
}

/** 后台进程和它所有的后代（它启动的 Pi 在里面），后台进程排在最前；后台进程不在时是空的。 */
export function workerProcesses(root: string, runId: string): WorkerProcess[] {
  const worker = liveWorker(root, runId);
  if (worker === null) return [];
  const table = processTable();
  return processTreePids(worker).map((pid) => ({ pid, start: table.get(pid)?.startTicks ?? null }));
}

/** 其中现在还在的。 */
export function aliveAmong(processes: readonly WorkerProcess[]): WorkerProcess[] {
  const table = processTable();
  return processes.filter((item) => {
    const current = table.get(item.pid)?.startTicks ?? null;
    return item.start !== null && current !== null && sameProcessStart(item.start, current);
  });
}
