/**
 * run 恢复与取消的共用 CLI 实现：顶层 `resume`／`cancel --run` 与 `run resume`／`run cancel`
 * 走同一协调器调用、同一 JSON outcome 与同一人读文案，避免两个入口语义漂移。
 * resume 生成新 run 后默认真启动（与 `run implement` 同一 start 流程），`--no-start` 只准备。
 */
import type { Command } from "commander";
import { RunCoordinator } from "../application/run-coordinator.js";
import type { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import type { Outcome } from "../contracts/protocol.js";
import { emit, jsonResponse } from "./output.js";

export type RunResumeResult = Awaited<ReturnType<RunCoordinator["resume"]>>;
export type RunCancelResult = Awaited<ReturnType<RunCoordinator["cancel"]>>;
export type RunStartResult = Awaited<ReturnType<RunCoordinator["start"]>>;
export type RunStatusResult = Awaited<ReturnType<RunCoordinator["status"]>>;

/** resume 的完整结果：新 run 已按 `run implement` 同一 start 流程启动时，launch 为启动后的记录。 */
export interface RunResumeOutcome extends RunResumeResult {
  /** 是否执行了 start；`--no-start` 或未生成新 run 时为 false。 */
  started: boolean;
  /** start 的确认结果；未启动为 null。 */
  confirmed: boolean | null;
  state: RunStartResult["state"] | null;
  /** `--wait` 时新 run 的终态投影。 */
  status?: RunStatusResult;
}

function terminal(state: string): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/**
 * 恢复：结果待同步先接收不重跑；否则用原／新会话续做同一阶段。
 * 生成新 run 后默认立即走与 `run implement` 相同的 start（落盘 starting、启动 worker、等认领确认），
 * 返回 launch 已确认后的状态；`start: false` 保留只准备的旧行为。
 */
export async function resumeRun(input: {
  store: SqliteMetadataStore;
  mainRoot: string;
  executionDir: string;
  runId: string;
  locks?: string | undefined;
  start?: boolean;
  wait?: boolean;
}): Promise<RunResumeOutcome> {
  const coordinator = new RunCoordinator({ store: input.store, ...(input.locks === undefined ? {} : { lockRoot: input.locks }) });
  const resumed = await coordinator.resume({ dir: input.mainRoot, oldRunId: input.runId, executionDir: input.executionDir });
  const outcome: RunResumeOutcome = { ...resumed, started: false, confirmed: null, state: null };
  const runId = resumed.request?.runId ?? null;
  if (input.start === false || !resumed.resumed || runId === null) return outcome;
  const started = await coordinator.start({ dir: input.mainRoot, runId });
  outcome.started = true;
  outcome.confirmed = started.confirmed;
  outcome.launch = started.launch;
  outcome.state = started.state;
  if (input.wait === true) {
    for (;;) {
      const status = await coordinator.status({ dir: input.mainRoot, runId });
      if (terminal(status.state)) {
        outcome.status = status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return outcome;
}

/** 启动失败（launch failed）或接收未完成时由主会话处理。 */
export function resumeOutcome(result: RunResumeOutcome): Outcome {
  if (!result.accepted) return "needs_attention";
  if (result.started && result.launch?.state === "failed") return "needs_attention";
  return "completed";
}

export function resumeText(subject: string, result: RunResumeOutcome): string {
  const head = `${subject}: ${result.accepted ? "已接收" : "待处理"}；${result.resumed ? `新 run ${result.request?.runId}` : result.reason ?? ""}`;
  if (!result.resumed) return head;
  if (!result.started) return `${head}（只准备，未启动；knit run start ${result.request?.runId}）`;
  const launch = `（启动 ${result.launch?.state ?? "未知"}，准备 ${result.state?.prepared === true}${result.launch?.lastError ? `，原因 ${result.launch.lastError}` : ""}）`;
  const final = result.status === undefined ? "" : `；终态 ${result.status.state}`;
  return `${head}${launch}${final}`;
}

export function emitResume(requestId: string, json: boolean, subject: string, result: RunResumeOutcome): void {
  if (json) emit(jsonResponse(requestId, resumeOutcome(result), result));
  else console.log(resumeText(subject, result));
  if (resumeOutcome(result) !== "completed") process.exitCode = 1;
}

/** 两个恢复入口共享的启动选项。 */
export function resumeOptions(command: Command): Command {
  return command
    .option("--no-start", "只准备新 run，不启动 worker（保留旧行为；之后 knit run start <run-id>）")
    .option("--wait", "启动后只观察新 run 直到终态（不接收结果）");
}

/** 取消：落盘意图；已终态返回 requested=false／reason=already_terminal，结果已发布返回 result_published。 */
export async function cancelRun(input: {
  store: SqliteMetadataStore;
  root: string;
  runId: string;
  reason?: string | null;
  terminate?: boolean;
}): Promise<RunCancelResult> {
  const coordinator = new RunCoordinator({ store: input.store });
  return coordinator.cancel({
    dir: input.root,
    runId: input.runId,
    reason: input.reason ?? null,
    terminate: input.terminate === true,
  });
}

/** 新记录取消或 run 已结束都无需再处理；结果已发布但未接收时需要主会话 resume。 */
export function cancelOutcome(result: RunCancelResult): Outcome {
  if (result.requested || result.reason === "already_terminal") return "completed";
  return "needs_attention";
}

export function cancelText(runId: string, result: RunCancelResult): string {
  let head: string;
  if (result.requested) head = "已记录取消意图";
  else if (result.reason === "already_terminal") head = `run 已结束，无需取消（${result.state}）`;
  else if (result.reason === "result_published") head = "结果已发布，未取消；用 knit resume 接收";
  else head = `未新取消（${result.reason ?? result.state}）`;
  return (
    `run ${runId}: ${head}` +
    `；worker=${result.workerVerdict} stage=${result.stageVerdict}` +
    `${result.terminated ? "；已终止阶段进程组" : ""}${result.terminalized ? "；已收敛为 cancelled" : ""}`
  );
}

export function emitCancel(requestId: string, json: boolean, runId: string, result: RunCancelResult): void {
  if (json) emit(jsonResponse(requestId, cancelOutcome(result), result));
  else console.log(cancelText(runId, result));
}

/** 两个取消入口共享的选项。 */
export function cancelOptions(command: Command): Command {
  return command
    .option("--reason <text>", "取消理由")
    .option("--terminate", "worker 已退出但阶段 Pi 记录仍存活时，显式终止该进程组");
}
