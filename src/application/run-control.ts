/** 派发后台执行进程、等待记录入账、取消并结算；CLI 和宿主桥接共用。 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRegistry } from "../contracts/agent.js";
import { RUNS_DIR, type TaskRecord, type TaskRun } from "../contracts/task.js";
import type { TaskDocument } from "../domain/task.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { atomicWrite } from "../infrastructure/fs.js";
import { pidAlive, processTable, processTreePids, procStartTicks, recordedProcess, sameProcessStart, signalProcessTree, withFileLock } from "../infrastructure/process.js";
import { readWorkflow } from "./project-config.js";
import { finishRun } from "./run-finish.js";
import { prepareRun, type PreparedRun, type PrepareRunInput, type PrepareRunResult } from "./run-prepare.js";
import { findTask } from "./task-store.js";

const EPHEMERAL_HOST_SANDBOX_ENV = [
  "CODEBUDDY_BROKERED_FS_HOOK_ENABLED",
  "CODEBUDDY_SAFE_DELETE_SANDBOX",
  "CODEBUDDY_SAFE_DELETE_BIN_DIR",
  "CODEBUDDY_SAFE_DELETE_BULK_GUARD",
  "CODEBUDDY_SAFE_DELETE_BROKER_DELETE",
  "CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR",
  "CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD",
  "SANDBOX_CENTER_IPC_ADDRESS",
] as const;

const EPHEMERAL_NODE_SHIM = /sandbox-center-runtime-kit|node-language-shim|node-brokered-fs-shim|node-safe-delete-shim/;

/** 清理宿主单次 Bash 沙箱注入的临时 broker 环境变量，避免 detached 执行者在命令返回后崩溃或超时。 */
function workerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of EPHEMERAL_HOST_SANDBOX_ENV) delete env[key];
  if (typeof env.NODE_OPTIONS === "string" && EPHEMERAL_NODE_SHIM.test(env.NODE_OPTIONS)) delete env.NODE_OPTIONS;
  return env;
}

export function startRun(input: PrepareRunInput & {
  readonly workerCommand: (run: PreparedRun) => readonly string[];
}): PrepareRunResult {
  return prepareRun(input, (run) => {
    const log = openSync(join(input.root, run.dir, "worker.log"), "a");
    const command = input.workerCommand(run);
    const worker = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", log, log], env: workerEnv() });
    worker.unref();
    closeSync(log);
    atomicWrite({
      path: join(input.root, run.dir, "worker.json"),
      data: Buffer.from(`${JSON.stringify({
        pid: worker.pid,
        start: worker.pid === undefined ? null : procStartTicks(worker.pid),
      }, null, 2)}\n`),
    });
  });
}

interface RunTaskResult {
  readonly task: { readonly dir: string; readonly document: TaskDocument; readonly record: TaskRecord } | null;
  readonly problems: readonly string[];
}

const WAIT_POLL_MS = [50, 100, 200, 500, 1000] as const;

type WaitRunResult = RunTaskResult & {
  readonly timedOut?: boolean;
  readonly workflow: WorkflowDefinition | null;
  readonly batchId?: string;
};

/** 每次轮询沿用原批次和截止时间。没有截止时间时等到结束或进程消失。 */
export async function waitRun(
  root: string,
  taskId: string,
  batchId?: string,
  deadline?: number,
  options?: { readonly pollMs?: number },
): Promise<WaitRunResult> {
  const poll = async (watchedBatch: string | undefined, attempt: number): Promise<WaitRunResult> => {
    const loaded = readRunTask(root, taskId);
    if (loaded.task === null) return { ...loaded, workflow: null };
    const workflow = readWorkflow(root);
    if (workflow.workflow === null) return { task: null, ...workflow };
    const running = loaded.task.record.runs.filter((run) => run.endedAt === null &&
      (watchedBatch === undefined || run.batchId === watchedBatch));
    const watched = { workflow: workflow.workflow, batchId: watchedBatch ?? running[0]?.batchId };
    if (!running.length) return { ...loaded, ...watched };
    if (running.every((run) => !startingWorker(root, taskId, run) && liveWorker(root, run.id) === null)) {
      return { ...readRunTask(root, taskId), ...watched };
    }
    const remaining = deadline === undefined ? Infinity : deadline - Date.now();
    if (remaining <= 0) return { ...loaded, ...watched, timedOut: true };
    const interval = options?.pollMs ?? WAIT_POLL_MS[Math.min(attempt, WAIT_POLL_MS.length - 1)]!;
    await sleep(Math.min(interval, remaining));
    return poll(watched.batchId, attempt + 1);
  };
  return poll(batchId, 0);
}

export async function cancelRun(input: {
  readonly agents: AgentRegistry;
  readonly root: string;
  readonly taskId: string;
  readonly workflow: WorkflowDefinition;
  readonly runId?: string;
  readonly graceMs?: number;
}) {
  const loaded = readRunTask(input.root, input.taskId);
  if (loaded.task === null) return { cancelled: null, problems: loaded.problems };
  const running = loaded.task.record.runs.filter((run) => run.endedAt === null && (input.runId === undefined || run.id === input.runId));
  if (running.length === 0) return { cancelled: null, problems: [`任务 ${input.taskId} 没有正在跑的执行${input.runId ? ` ${input.runId}` : ""}`] };
  while (running.some((run) => startingWorker(input.root, input.taskId, run))) await sleep(100);
  const results = await Promise.all(running.map(async (run) => {
    const workerMissing = liveWorker(input.root, run.id) === null;
    await stopRunProcesses(input.root, run.id, input.graceMs);
    const problems = finishRun({ ...input, runId: run.id, verdict: null,
      failure: workerMissing ? "执行进程意外退出" : "已取消", sessionFile: null });
    const ended = findTask(input.root, input.taskId)?.record?.runs.find((item) => item.id === run.id);
    return { runId: run.id, workerMissing, changedPaths: ended?.changedPaths ?? [], problems };
  }));
  const problems = results.flatMap((result) => result.problems);
  return { cancelled: problems.length ? null : results[0]!, runs: results, problems };
}

function readRunTask(root: string, taskId: string): RunTaskResult {
  const stored = findTask(root, taskId);
  if (stored === null) return { task: null, problems: [`没有任务 ${taskId}；用 knit task list 查看现有任务`] };
  if (stored.document === null || stored.record === null) return { task: null, problems: stored.problems };
  return { task: { dir: stored.dir, document: stored.document, record: stored.record }, problems: [] };
}

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

function taskLockPath(root: string, taskId: string): string {
  return join(root, dirname(RUNS_DIR), `${taskId}.lock`);
}

export function withTaskRunLock<T>(root: string, taskId: string, timeout: number, action: () => T, busy: () => T): T {
  return withFileLock(taskLockPath(root, taskId), timeout, action, busy);
}

export function taskRunLockHeld(root: string, taskId: string): boolean {
  const path = taskLockPath(root, taskId);
  return existsSync(path) && withFileLock(path, 0, () => false, () => true, true);
}
