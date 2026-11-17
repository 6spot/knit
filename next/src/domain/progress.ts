/** 任务走到哪了：每次从流程定义和执行记录推出来，不单独保存。只做计算，不读写文件。 */
import type { TaskFrontmatter, TaskRecord, TaskRun, TaskStatus } from "../contracts/task.js";
import { WORKFLOW_VERDICT_ANCHOR } from "../contracts/workflow.js";
import type { WorkflowDefinition, WorkflowStage } from "./workflow.js";

/**
 * `close`：所有环节都做完了，交回主会话收尾。
 * `limit`：下一个环节已经到进入次数的上限，`entries` 是已经进入的次数。
 */
export type NextStep =
  | { readonly kind: "stage"; readonly stage: WorkflowStage }
  | { readonly kind: "limit"; readonly stage: WorkflowStage; readonly entries: number }
  | { readonly kind: "close" };

/**
 * 算数的执行：已经结束、没有失败、按现在的需求做的。
 * 需求改过并重新确认之后摘要会变，以前的执行就都不算数了。
 */
export function countedRuns(record: TaskRecord): TaskRun[] {
  return record.runs.filter(
    (run) => run.endedAt !== null && run.failure === null && run.requirementDigest === record.confirmedDigest,
  );
}

/**
 * 这个环节进入过几次：算数的执行按先后排成一串，连着的同一个环节只算一次进入。
 * 留在原环节再做一次、失败之后重新派发，都不算新的进入。
 */
export function stageEntries(record: TaskRecord, stageId: string): number {
  return countedRuns(record).filter((run, index, runs) => run.stage === stageId && runs[index - 1]?.stage !== stageId)
    .length;
}

/** 正在跑的执行不影响结果；有没有执行者在跑由调用方另外判断。 */
export function nextStep(
  workflow: WorkflowDefinition,
  verification: TaskFrontmatter["verification"],
  record: TaskRecord,
): NextStep {
  const last = countedRuns(record).at(-1);
  const stage = stageAfter(workflow, verification, last);
  if (stage === undefined) return { kind: "close" };
  // 留在原环节不是新的进入，不判断上限。
  if (stage.id === last?.stage || stage.maxVisits === null) return { kind: "stage", stage };
  const entries = stageEntries(record, stage.id);
  // maxVisits 是第一次进入之后还能再进入几次。
  return entries > stage.maxVisits ? { kind: "limit", stage, entries } : { kind: "stage", stage };
}

/**
 * 主会话现在该按哪个环节的规范做事；任务已经结束时是 null。
 * `status` 是 `currentStatus` 算出来的状态。
 */
export function sessionStage(
  workflow: WorkflowDefinition,
  verification: TaskFrontmatter["verification"],
  record: TaskRecord,
  status: TaskStatus,
): string | null {
  if (status === "draft") return "discuss";
  if (status === "done") return "deliver";
  if (status !== "ready" && status !== "active") return null;
  const running = record.runs.find((run) => run.endedAt === null);
  if (running !== undefined) return running.stage;
  const step = nextStep(workflow, verification, record);
  // 环节都做完了，等主会话核对和 task close：核对成果只需要需求和交付规范。
  return step.kind === "close" ? "deliver" : step.stage.id;
}

/** 按流程走到的下一个环节；没有就是所有环节都做完了。 */
function stageAfter(
  workflow: WorkflowDefinition,
  verification: TaskFrontmatter["verification"],
  last: TaskRun | undefined,
): WorkflowStage | undefined {
  // 不要求独立审查的任务不进审查环节：声明了 verdict 的环节。
  const walked =
    verification === "independent"
      ? workflow.stages
      : workflow.stages.filter((stage) => !Object.hasOwn(stage.report, "verdict"));
  const index = last === undefined ? -1 : workflow.stages.findIndex((stage) => stage.id === last.stage);
  const current = workflow.stages[index];
  // 没有算数的执行，或者它所在的环节已经不在流程里：从头开始。
  if (last === undefined || current === undefined) return walked[0];
  const target =
    last.verdict !== null && Object.hasOwn(current.onVerdict, last.verdict) ? current.onVerdict[last.verdict] : undefined;
  if (target === WORKFLOW_VERDICT_ANCHOR) return undefined;
  // 结论的去向按流程里的全部环节找，不限于任务要走的。
  if (target !== undefined) return workflow.stages.find((stage) => stage.id === target);
  return workflow.stages.slice(index + 1).find((stage) => walked.includes(stage));
}
