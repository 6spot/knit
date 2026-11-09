/**
 * run 恢复与取消的共用 CLI 实现：顶层 `resume`／`cancel --run` 与 `run resume`／`run cancel`
 * 走同一协调器调用、同一 JSON outcome 与同一人读文案，避免两个入口语义漂移。
 */
import type { Command } from "commander";
import { RunCoordinator } from "../application/run-coordinator.js";
import type { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import type { Outcome } from "../contracts/protocol.js";
import { emit, jsonResponse } from "./output.js";

export type RunResumeResult = Awaited<ReturnType<RunCoordinator["resume"]>>;
export type RunCancelResult = Awaited<ReturnType<RunCoordinator["cancel"]>>;

/** 恢复：结果待同步先接收不重跑；否则用原／新会话续做同一阶段。 */
export async function resumeRun(input: {
  store: SqliteMetadataStore;
  mainRoot: string;
  executionDir: string;
  runId: string;
  locks?: string | undefined;
}): Promise<RunResumeResult> {
  const coordinator = new RunCoordinator({ store: input.store, ...(input.locks === undefined ? {} : { lockRoot: input.locks }) });
  return coordinator.resume({ dir: input.mainRoot, oldRunId: input.runId, executionDir: input.executionDir });
}

export function resumeText(subject: string, result: RunResumeResult): string {
  return `${subject}: ${result.accepted ? "已接收" : "待处理"}；${result.resumed ? `新 run ${result.request?.runId}` : result.reason ?? ""}`;
}

export function emitResume(requestId: string, json: boolean, subject: string, result: RunResumeResult): void {
  if (json) emit(jsonResponse(requestId, "completed", result));
  else console.log(resumeText(subject, result));
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
