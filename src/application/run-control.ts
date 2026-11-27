/** 派发后台执行进程、等待记录入账、取消并结算；CLI 和宿主桥接共用。 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRegistry } from "../contracts/agent.js";
import { RUNS_DIR, TASK_ID_PATTERN, type TaskRecord, type TaskRun } from "../contracts/task.js";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { parseTaskRecord, type TaskDocument } from "../domain/task.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { atomicWrite } from "../infrastructure/fs.js";
import { pidAlive, processIdentities, processTable, processTreePids, procStartTicks, readProcessRegistration, recordedProcess, registeredPid, sameProcessStart, signalProcessGroup, signalProcessTree, withFileLock, type WorkerProcess } from "../infrastructure/process.js";
import { readWorkflow } from "./project-config.js";
import { finishRun } from "./run-finish.js";
import { prepareRun, type PreparedRun, type PrepareRunInput, type PrepareRunResult } from "./run-prepare.js";
import { findTask, readTask, RECORD_FILE, type TaskRefusal } from "./task-store.js";

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
    const command = input.workerCommand(run);
    const path = join(input.root, run.dir, "worker.log");
    const log = openSync(path, "a");
    try {
      const worker = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", log, log], env: workerEnv() });
      worker.once("error", (error) => appendFileSync(path, `${error.message}\n`));
      worker.unref();
      if (worker.pid === undefined) throw new Error(`无法启动 ${command[0]}`);
      const table = processIdentities([worker.pid]);
      const start = table?.get(worker.pid)?.startTicks ?? null;
      if (table !== null && start === null) return;
      try {
        atomicWrite({ path: join(input.root, run.dir, "worker.json"), data: Buffer.from(JSON.stringify({ pid: worker.pid, start })) });
      } catch (error) {
        signalProcessGroup(worker.pid, "SIGKILL", { exited: false });
        throw error;
      }
    } finally { closeSync(log); }
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
  const workflowPath = join(root, WORKFLOW_CONFIG_PATH);
  let loaded = readRunTask(root, taskId);
  let cachedWorkflow: { stamp: string; workflow: WorkflowDefinition } | null = null;
  let watchedBatch = batchId;
  const started = Date.now();
  const workers = new Map<string, { stamp: string; registration: WorkerProcess; checkedAt: number }>();
  for (let attempt = 0; ; attempt++) {
    if (loaded.task === null) return { task: null, problems: loaded.problems, workflow: null };
    const stamp = fileStamp(workflowPath);
    const workflow: ReturnType<typeof readWorkflow> = cachedWorkflow !== null && stamp !== null && stamp === cachedWorkflow.stamp
      ? { workflow: cachedWorkflow.workflow, problems: [] as readonly string[] }
      : readWorkflow(root);
    if (workflow.workflow === null) return { task: null, ...workflow };
    cachedWorkflow = stamp === null ? null : { stamp, workflow: workflow.workflow };
    const running = loaded.task.record.runs.filter((run) => run.endedAt === null &&
      (watchedBatch === undefined || run.batchId === watchedBatch));
    const watched = { workflow: workflow.workflow, batchId: watchedBatch ?? running[0]?.batchId };
    const finished = running.every((run) => {
      const file = join(root, RUNS_DIR, run.id, "worker.json");
      const stamp = fileStamp(file);
      if (stamp === null) return !startingWorker(root, taskId, run);
      const cached = workers.get(run.id);
      const same = cached?.stamp === stamp;
      if (same && Date.now() - started > 30_000 && Date.now() - cached.checkedAt < 5000) return !pidAlive(cached.registration.pid);
      const registration = same ? cached.registration : readProcessRegistration(file);
      if (registeredPid(registration) === null || !registration) return true;
      workers.set(run.id, { stamp, registration, checkedAt: Date.now() });
      return false;
    });
    const remaining = deadline === undefined ? Infinity : deadline - Date.now();
    if (finished || remaining <= 0) {
      const { task, problems } = attempt === 0 && !running.length ? loaded : readRunTask(root, taskId);
      if (task === null) return { task, problems, workflow: null };
      return { task, problems, ...watched, ...(!finished && { timedOut: true }) };
    }
    const interval = options?.pollMs ?? WAIT_POLL_MS[Math.min(attempt, WAIT_POLL_MS.length - 1)]!;
    await sleep(Math.min(interval, remaining));
    const record = readPollingRecord(loaded.recordPath);
    loaded = record === null ? readRunTask(root, taskId) : { ...loaded, task: { ...loaded.task, record } };
    watchedBatch = watched.batchId;
  }
}

function fileStamp(path: string): string | null {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function readPollingRecord(path: string): TaskRecord | null {
  try {
    return parseTaskRecord(readFileSync(path, "utf8")).record;
  } catch { return null; }
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
  const deadline = Date.now() + 5000;
  while (running.some((run) => startingWorker(input.root, input.taskId, run))) {
    if (Date.now() >= deadline) return { cancelled: null, problems: ["等待执行者登记超时，请稍后重试取消"] };
    await sleep(100);
  }
  const batch = running[0]?.batchId;
  const members = !input.runId && batch ? loaded.task.record.runs.filter((run) => run.batchId === batch) : running;
  const table = processTable();
  const stopped = await Promise.all(members.map(async (run) => {
    const worker = run.endedAt === null ? liveWorker(input.root, run.id) : null;
    if (run.endedAt === null) {
      await stopProcesses([worker, livePane(input.root, run.id)], input.graceMs, table);
      await stopProcesses([liveWorker(input.root, run.id), livePane(input.root, run.id)], input.graceMs);
    }
    return { run, workerMissing: worker === null };
  }));
  const results = stopped.map(({ run, workerMissing }) => {
    const current = () => findTask(input.root, input.taskId)?.record?.runs.find((item) => item.id === run.id);
    const before = current();
    const issues = before?.endedAt ? [] : finishRun({ ...input, runId: run.id, verdict: null,
      failure: workerMissing ? "执行进程意外退出" : "已取消", sessionFile: null });
    const ended = before?.endedAt ? before : current();
    const alreadyEnded = Boolean(before?.endedAt || (issues.length && ended?.endedAt));
    return { runId: run.id, workerMissing, alreadyEnded, changedPaths: ended?.changedPaths ?? [], problems: alreadyEnded ? [] : issues };
  });
  const problems = results.flatMap((result) => result.problems);
  return { cancelled: problems.length ? null : results[0]!, runs: results, problems };
}

function readRunTask(root: string, taskId: string) {
  const stored = findTask(root, taskId);
  if (stored === null) return { task: null, problems: [`没有任务 ${taskId}；用 knit task list 查看现有任务`] } as const;
  if (stored.document === null || stored.record === null) return { task: null, problems: stored.problems } as const;
  return { task: { dir: stored.dir, document: stored.document, record: stored.record }, recordPath: join(stored.storeRoot, stored.dir, RECORD_FILE), problems: [] };
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
export type { WorkerProcess };

/** 执行已登记、worker.json 还没发布时，持锁的派发进程仍在启动执行者。 */
export function startingWorker(root: string, taskId: string, run: TaskRun): boolean {
  return run.endedAt === null && !existsSync(join(root, RUNS_DIR, run.id, "worker.json")) &&
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
  return processChains([liveWorker(root, runId), livePane(root, runId)])?.chain ?? [];
}

function processChains(roots: readonly (number | null)[], snapshot?: ReturnType<typeof processTable>) {
  const live = roots.filter((pid) => pid !== null);
  if (!live.length) return null;
  const table = snapshot ?? processTable();
  const chain = live.flatMap((pid) => processTreePids(pid, table)).map((pid) => ({ pid, start: table.get(pid)?.startTicks ?? null }));
  return { chain, table };
}

/** Rex 关闭窗格时，进程可能仍在退出。 */
export async function stopPaneProcesses(dir: string, graceMs?: number): Promise<void> {
  const pane = recordedProcess(join(dir, PANE_FILE));
  if (pane !== null) await stopProcesses([pane], graceMs);
}

/** 窗格客户端先登记再核对后台进程，取消期间晚启动的客户端不再发送消息。 */
export function registerPane(dir: string): boolean {
  atomicWrite({ path: join(dir, PANE_FILE), data: Buffer.from(`${JSON.stringify({ pid: process.pid, start: procStartTicks(process.pid) }, null, 2)}\n`) });
  return recordedProcess(join(dir, "worker.json")) !== null;
}

/** 等执行者及其后代全部停止；之后才能拍结算快照。 */
export async function stopRunProcesses(root: string, runId: string, graceMs?: number): Promise<void> {
  const roots = () => [liveWorker(root, runId), livePane(root, runId)];
  await stopProcesses(roots(), graceMs);
  // 窗格客户端可能在后台退出期间才登记，再找一次。
  await stopProcesses(roots(), graceMs);
}

async function stopProcesses(roots: readonly (number | null)[], graceMs?: number, tableSnapshot?: ReturnType<typeof processTable>): Promise<void> {
  const snapshot = processChains(roots, tableSnapshot);
  if (!snapshot) return;
  const { chain, table } = snapshot;
  if (chain[0] === undefined) return;
  const waitMs = stopGraceMs(graceMs);
  signalProcessTree(chain[0].pid, "SIGTERM", chain.map((item) => item.pid), table);
  const stubborn = await stillAlive(chain, Date.now() + waitMs);
  if (stubborn[0] === undefined) return;
  const pids = stubborn.map((item) => item.pid);
  signalProcessTree(stubborn[0].pid, "SIGKILL", pids, processIdentities([process.pid, ...pids]) ?? new Map());
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
  const live = processes.filter((item) => pidAlive(item.pid));
  if (!live.length) return [];
  const table = processIdentities(live.map((item) => item.pid));
  if (table === null) return live.filter((item) => pidAlive(item.pid));
  return live.filter((item) => {
    const current = table.get(item.pid)?.startTicks;
    return table.has(item.pid) && (item.start === null || (current != null && sameProcessStart(item.start, current)));
  });
}

function taskLockPath(root: string, taskId: string): string {
  return join(root, dirname(RUNS_DIR), `${taskId}.lock`);
}

export function withTaskRunLock<T>(root: string, taskId: string, timeout: number, action: () => T, busy: () => T): T {
  return withFileLock(taskLockPath(root, taskId), timeout, action, busy);
}

export function withTaskWriteLock<T>(root: string, id: string, action: () => T): T | TaskRefusal {
  const valid = new RegExp(TASK_ID_PATTERN).test(id);
  if (!valid || !existsSync(taskLockPath(root, id))) {
    const loaded = readTask(root, id);
    if (loaded.kind === "refused") return loaded;
  }
  return withTaskRunLock<T | TaskRefusal>(root, id, 0, action,
    () => ({ kind: "refused", problems: [`任务 ${id} 正在写入，请稍后重试`] }));
}

export function taskRunLockHeld(root: string, taskId: string): boolean {
  const path = taskLockPath(root, taskId);
  try { return withFileLock(path, 0, () => false, () => true, true); }
  catch (error) {
    if (error instanceof Error && "errcode" in error) {
      if (error.errcode === 14) return false; // SQLITE_CANTOPEN
      if (error.errcode === 26) throw new Error(`任务锁 ${path} 已损坏；确认没有派发和结算进程后移走该文件，再重试`, { cause: error });
    }
    throw error;
  }
}
