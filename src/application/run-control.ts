/** 派发后台执行进程、等待记录入账、取消并结算；CLI 和宿主桥接共用。 */
import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRegistry } from "../contracts/agent.js";
import type { TaskRecord } from "../contracts/task.js";
import type { TaskDocument } from "../domain/task-document.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { procStartTicks } from "../infrastructure/process.js";
import { finishRun } from "./run-finish.js";
import { prepareRun, type PreparedRun, type PrepareRunInput, type PrepareRunResult } from "./run-prepare.js";
import { liveWorker, stopRunProcesses } from "./run-process.js";
import { findTask } from "./task-store.js";
import { readWorkflow } from "./workflow-store.js";

export function startRun(input: PrepareRunInput & {
  readonly workerCommand: (run: PreparedRun) => readonly string[];
}): PrepareRunResult {
  const prepared = prepareRun(input);
  if (prepared.run === null) return prepared;
  const log = openSync(join(input.root, prepared.run.dir, "worker.log"), "a");
  const command = input.workerCommand(prepared.run);
  const worker = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", log, log] });
  worker.unref();
  closeSync(log);
  writeFileSync(join(input.root, prepared.run.dir, "worker.json"), `${JSON.stringify({
    pid: worker.pid,
    start: worker.pid === undefined ? null : procStartTicks(worker.pid),
  }, null, 2)}\n`);
  return prepared;
}

interface RunTaskResult {
  readonly task: { readonly document: TaskDocument; readonly record: TaskRecord } | null;
  readonly problems: readonly string[];
}

/** 无总超时；后台进程消失时重读记录，正常结束与意外退出都结束等待。 */
export async function waitRun(root: string, taskId: string): Promise<RunTaskResult & { readonly workflow: WorkflowDefinition | null }> {
  const loaded = readRunTask(root, taskId);
  if (loaded.task === null) return { ...loaded, workflow: null };
  const workflow = readWorkflow(root);
  if (workflow.workflow === null) return { task: null, ...workflow };
  const running = loaded.task.record.runs.find((run) => run.endedAt === null);
  if (running === undefined) return { ...loaded, workflow: workflow.workflow };
  if (liveWorker(root, running.id) === null) return { ...readRunTask(root, taskId), workflow: workflow.workflow };
  await sleep(1000);
  return waitRun(root, taskId);
}

export async function cancelRun(input: {
  readonly agents: AgentRegistry;
  readonly root: string;
  readonly taskId: string;
  readonly workflow: WorkflowDefinition;
}): Promise<{
  readonly cancelled: { readonly runId: string; readonly workerMissing: boolean; readonly changedPaths: readonly string[] } | null;
  readonly problems: readonly string[];
}> {
  const loaded = readRunTask(input.root, input.taskId);
  if (loaded.task === null) return { cancelled: null, problems: loaded.problems };
  const running = loaded.task.record.runs.find((run) => run.endedAt === null);
  if (running === undefined) return { cancelled: null, problems: [`任务 ${input.taskId} 没有正在跑的执行`] };
  const workerMissing = liveWorker(input.root, running.id) === null;
  await stopRunProcesses(input.root, running.id);
  const problems = finishRun({
    ...input,
    runId: running.id,
    verdict: null,
    failure: workerMissing ? "执行进程意外退出" : "已取消",
    sessionFile: null,
  });
  if (problems.length > 0) return { cancelled: null, problems };
  return {
    cancelled: {
      runId: running.id,
      workerMissing,
      changedPaths: findTask(input.root, input.taskId)?.record?.runs.find((run) => run.id === running.id)?.changedPaths ?? [],
    },
    problems: [],
  };
}

function readRunTask(root: string, taskId: string): RunTaskResult {
  const stored = findTask(root, taskId);
  if (stored === null) return { task: null, problems: [`没有任务 ${taskId}；用 knit task list 查看现有任务`] };
  if (stored.document === null || stored.record === null) return { task: null, problems: stored.problems };
  return { task: { document: stored.document, record: stored.record }, problems: [] };
}
