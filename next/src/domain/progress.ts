/** 任务走到哪了：每次从流程定义和执行记录推出来，不单独保存。只做计算，不读写文件。 */
import type { TaskFrontmatter, TaskRecord, TaskRun } from "../contracts/task.js";
import { WORKFLOW_VERDICT_ANCHOR } from "../contracts/workflow.js";
import type { WorkflowDefinition, WorkflowStage } from "./workflow.js";

/** `close`：所有环节都做完了，交回主会话收尾。 */
export type NextStep = { readonly kind: "stage"; readonly stage: WorkflowStage } | { readonly kind: "close" };

/**
 * 算数的执行：已经结束、没有失败、按现在的需求做的。
 * 需求改过并重新确认之后摘要会变，以前的执行就都不算数了。
 */
export function countedRuns(record: TaskRecord): TaskRun[] {
  return record.runs.filter(
    (run) => run.endedAt !== null && run.failure === null && run.requirementDigest === record.confirmedDigest,
  );
}

/** 正在跑的执行不影响结果；有没有执行者在跑由调用方另外判断。 */
export function nextStep(
  workflow: WorkflowDefinition,
  verification: TaskFrontmatter["verification"],
  record: TaskRecord,
): NextStep {
  // 不要求独立审查的任务不进审查环节：声明了 verdict 的环节。
  const walked =
    verification === "independent"
      ? workflow.stages
      : workflow.stages.filter((stage) => !Object.hasOwn(stage.report, "verdict"));
  const last = countedRuns(record).at(-1);
  const index = last === undefined ? -1 : workflow.stages.findIndex((stage) => stage.id === last.stage);
  const current = workflow.stages[index];
  // 没有算数的执行，或者它所在的环节已经不在流程里：从头开始。
  if (last === undefined || current === undefined) return stepTo(walked[0]);
  const target =
    last.verdict !== null && Object.hasOwn(current.onVerdict, last.verdict) ? current.onVerdict[last.verdict] : undefined;
  if (target === WORKFLOW_VERDICT_ANCHOR) return { kind: "close" };
  // 结论的去向按流程里的全部环节找，不限于任务要走的。
  if (target !== undefined) return stepTo(workflow.stages.find((stage) => stage.id === target));
  return stepTo(workflow.stages.slice(index + 1).find((stage) => walked.includes(stage)));
}

function stepTo(stage: WorkflowStage | undefined): NextStep {
  return stage === undefined ? { kind: "close" } : { kind: "stage", stage };
}
