/** 执行者的后台进程。 */
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWrite } from "../infrastructure/atomic.js";
import { processTable, processTreePids, procStartTicks, recordedProcess, sameProcessStart, signalProcessTree } from "../infrastructure/process.js";
import { RUNS_DIR } from "./run-prepare.js";
import { PANE_FILE } from "./run-session.js";

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

/** 窗格客户端先登记再核对后台进程，取消期间晚启动的客户端不再发送消息。 */
export function registerPane(dir: string): boolean {
  atomicWrite({ path: join(dir, PANE_FILE), data: Buffer.from(`${JSON.stringify({ pid: process.pid, start: procStartTicks(process.pid) }, null, 2)}\n`) });
  return recordedProcess(join(dir, "worker.json")) !== null;
}

/** 等执行者及其后代全部停止；之后才能拍结算快照。 */
export async function stopRunProcesses(root: string, runId: string): Promise<void> {
  await stopProcesses(workerProcesses(root, runId));
  // 窗格客户端可能在后台退出期间才登记，再找一次。
  await stopProcesses(workerProcesses(root, runId));
}

async function stopProcesses(chain: readonly WorkerProcess[]): Promise<void> {
  if (chain[0] === undefined) return;
  signalProcessTree(chain[0].pid, "SIGTERM", chain.map((item) => item.pid));
  const stubborn = await stillAlive(chain, Date.now() + 5000);
  if (stubborn[0] === undefined) return;
  signalProcessTree(stubborn[0].pid, "SIGKILL", stubborn.map((item) => item.pid));
  // 保留原有规则：等到上限仍然结算，不让任务永久卡在执行中。
  await stillAlive(stubborn, Date.now() + 5000);
}

async function stillAlive(processes: readonly WorkerProcess[], deadline: number): Promise<WorkerProcess[]> {
  const alive = aliveAmong(processes);
  if (alive.length === 0 || Date.now() >= deadline) return alive;
  await sleep(100);
  return stillAlive(alive, deadline);
}

/** 其中现在还在的。 */
export function aliveAmong(processes: readonly WorkerProcess[]): WorkerProcess[] {
  const table = processTable();
  return processes.filter((item) => {
    const current = table.get(item.pid)?.startTicks ?? null;
    return item.start !== null && current !== null && sameProcessStart(item.start, current);
  });
}
