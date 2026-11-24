/** 派发后台执行进程、等待记录入账、取消并结算；CLI 和宿主桥接共用。 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRegistry } from "../contracts/agent.js";
import type { TaskRecord } from "../contracts/task.js";
import type { TaskDocument } from "../domain/task-document.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { atomicWrite } from "../infrastructure/fs.js";
import { procStartTicks } from "../infrastructure/process.js";
import { finishRun } from "./run-finish.js";
import { prepareRun, type PreparedRun, type PrepareRunInput, type PrepareRunResult } from "./run-prepare.js";
import { liveWorker, startingWorker, stopRunProcesses } from "./run-process.js";
import { findTask } from "./task-store.js";
import { readWorkflow } from "./workflow-store.js";

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
