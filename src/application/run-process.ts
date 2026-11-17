/** 执行者的后台进程。 */
import { join } from "node:path";
import { PANE_FILE } from "../adapters/pi/pane-worker.js";
import { processTable, processTreePids, recordedProcess, sameProcessStart } from "../infrastructure/process.js";
import { RUNS_DIR } from "./run-prepare.js";

/** 一个进程：进程号会被别的进程重新用上，启动标识一样才是原来那个。 */
export interface WorkerProcess {
  readonly pid: number;
  readonly start: string | null;
}

/** 这次执行的后台进程还在时返回它的进程号，不在时是 null。 */
export function liveWorker(root: string, runId: string): number | null {
  return recordedProcess(join(root, RUNS_DIR, runId, "worker.json"));
}

/** 这次执行的执行者在 Rex 的窗格里跑着时返回窗格里 Pi 的进程号，否则是 null。 */
export function livePane(root: string, runId: string): number | null {
  return recordedProcess(join(root, RUNS_DIR, runId, PANE_FILE));
}

/**
 * 这次执行还在的全部进程：后台进程和它的后代（它启动的 Pi 在里面），再加上 Rex 窗格里的 Pi 和它的后代
 * （窗格里的 Pi 是 Rex 启动的，不是后台进程的后代）。都不在时是空的。
 */
export function workerProcesses(root: string, runId: string): WorkerProcess[] {
  const roots = [liveWorker(root, runId), livePane(root, runId)].filter((pid) => pid !== null);
  const table = processTable();
  return roots.flatMap(processTreePids).map((pid) => ({ pid, start: table.get(pid)?.startTicks ?? null }));
}

/** 其中现在还在的。 */
export function aliveAmong(processes: readonly WorkerProcess[]): WorkerProcess[] {
  const table = processTable();
  return processes.filter((item) => {
    const current = table.get(item.pid)?.startTicks ?? null;
    return item.start !== null && current !== null && sameProcessStart(item.start, current);
  });
}
