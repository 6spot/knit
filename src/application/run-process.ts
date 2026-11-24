/** 执行者的后台进程。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RUNS_DIR, type TaskRun } from "../contracts/task.js";
import { atomicWrite } from "../infrastructure/atomic.js";
import { pidAlive, processTable, processTreePids, procStartTicks, recordedProcess, sameProcessStart, signalProcessTree } from "../infrastructure/process.js";
import { taskRunLockHeld } from "./run-lock.js";

export const PANE_FILE = "pane.json";
export const DEFAULT_STOP_GRACE_MS = 5000;

function stopGraceMs(graceMs?: number): number {
  if (graceMs !== undefined) return graceMs;
  const configured = process.env.KNIT_STOP_GRACE_MS;
  return configured !== undefined && /^[1-9]\d*$/.test(configured) && Number.isSafeInteger(Number(configured))
    ? Number(configured)
    : DEFAULT_STOP_GRACE_MS;
}

/** 一个进程：进程号会被别的进程重新用上，启动标识一样才是原来那个。 */
export interface WorkerProcess {
  readonly pid: number;
  readonly start: string | null;
}

/** 批次已登记、worker.json 还没发布时，持锁的派发进程仍在启动成员。 */
export function startingWorker(root: string, taskId: string, run: TaskRun): boolean {
  return run.batchId !== undefined && run.endedAt === null && !existsSync(join(root, RUNS_DIR, run.id, "worker.json")) &&
    taskRunLockHeld(root, taskId);
}

/** 这次执行的后台进程还在时返回它的进程号，不在时是 null。 */
export function liveWorker(root: string, runId: string): number | null {
  return recordedProcess(join(root, RUNS_DIR, runId, "worker.json"));
}

/** 这次执行的执行者在 Rex 的窗格里跑着时返回窗格里 Pi 的进程号，否则是 null。 */
export function livePane(root: string, runId: string): number | null {
  return recordedProcess(join(root, RUNS_DIR, runId, PANE_FILE));
}

/** 后台和 Rex 窗格及其后代。 */
export function workerProcesses(root: string, runId: string): WorkerProcess[] {
  return processChains([liveWorker(root, runId), livePane(root, runId)]);
}

function processChains(roots: readonly (number | null)[]): WorkerProcess[] {
  const table = processTable();
  return roots.filter((pid) => pid !== null).flatMap(processTreePids).map((pid) => ({ pid, start: table.get(pid)?.startTicks ?? null }));
}

/** Rex 关闭窗格时，进程可能仍在退出。 */
export async function stopPaneProcesses(dir: string, graceMs?: number): Promise<void> {
  const pane = recordedProcess(join(dir, PANE_FILE));
  if (pane !== null) await stopProcesses(processChains([pane]), graceMs);
}

/** 窗格客户端先登记再核对后台进程，取消期间晚启动的客户端不再发送消息。 */
export function registerPane(dir: string): boolean {
  atomicWrite({ path: join(dir, PANE_FILE), data: Buffer.from(`${JSON.stringify({ pid: process.pid, start: procStartTicks(process.pid) }, null, 2)}\n`) });
  return recordedProcess(join(dir, "worker.json")) !== null;
}

/** 等执行者及其后代全部停止；之后才能拍结算快照。 */
export async function stopRunProcesses(root: string, runId: string, graceMs?: number): Promise<void> {
  await stopProcesses(workerProcesses(root, runId), graceMs);
  // 窗格客户端可能在后台退出期间才登记，再找一次。
  await stopProcesses(workerProcesses(root, runId), graceMs);
}

async function stopProcesses(chain: readonly WorkerProcess[], graceMs?: number): Promise<void> {
  if (chain[0] === undefined) return;
  const waitMs = stopGraceMs(graceMs);
  signalProcessTree(chain[0].pid, "SIGTERM", chain.map((item) => item.pid));
  const stubborn = await stillAlive(chain, Date.now() + waitMs);
  if (stubborn[0] === undefined) return;
  signalProcessTree(stubborn[0].pid, "SIGKILL", stubborn.map((item) => item.pid));
  // 保留原有规则：等到上限仍然结算，不让任务永久卡在执行中。
  await stillAlive(stubborn, Date.now() + waitMs);
}

async function stillAlive(processes: readonly WorkerProcess[], deadline: number): Promise<WorkerProcess[]> {
  const alive = aliveAmong(processes);
  if (alive.length === 0 || Date.now() >= deadline) return alive;
  await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  return stillAlive(alive, deadline);
}

/** 其中现在还在的。 */
export function aliveAmong(processes: readonly WorkerProcess[]): WorkerProcess[] {
  const table = processTable();
  return processes.filter((item) => {
    const current = table.get(item.pid)?.startTicks ?? null;
    if (item.start !== null && current !== null) return sameProcessStart(item.start, current);
    if (item.start === null || table.size === 0) return pidAlive(item.pid);
    return false;
  });
}
