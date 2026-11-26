/** 任务走到哪了：每次从流程定义和执行记录推出来，不单独保存。只做计算，不读写文件。 */
import { RUNS_DIR } from "../contracts/task.js";
import type { TaskFrontmatter, TaskRecord, TaskRun, TaskStatus } from "../contracts/task.js";
import { DEFAULT_AGENT, WORKFLOW_VERDICT_ANCHOR, type AgentName } from "../contracts/workflow.js";
import type { WorkflowDefinition, WorkflowStage } from "./workflow.js";

/**
 * `close`：所有环节都做完了，交回主会话收尾。
 * `limit`：下一个环节已经到进入次数的上限，`entries` 是已经进入的次数。
 */
export type NextStep =
  | { readonly kind: "running"; readonly stage: Pick<WorkflowStage, "id"> }
  | { readonly kind: "arbitrate"; readonly stage: WorkflowStage; readonly reports: readonly { run: TaskRun; path: string }[] }
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

/** 续聊候选独立于状态推进；违规后不能借更早的记录恢复同一原生会话。 */
export function resumableRun(record: TaskRecord, target: { stage: string; executor?: string; agent: AgentName }): TaskRun | undefined {
  const prior = record.runs.findLast((run) => run.endedAt !== null && run.requirementDigest === record.confirmedDigest &&
    run.stage === target.stage && run.executor === target.executor && (run.agent ?? DEFAULT_AGENT) === target.agent &&
    (run.resumeId || preventsResume(run.failure)));
  return prior?.resumeId && !preventsResume(prior.failure) ? prior : undefined;
}

function preventsResume(failure: string | null): boolean {
  return failure !== null && /(?:^|；)(?:执行者提交了改动|执行者改了受保护的文件|执行清理失败)(?:：|$)/.test(failure);
}

export function batchOf(record: TaskRecord, member: TaskRun | undefined): TaskRun[] {
  if (!member) return [];
  return member.batchId === undefined ? [member] : record.runs.filter((run) => run.batchId === member.batchId);
}

/** 并行批次全员入账后才参与推导，包括需要裁决的失败成员。旧的单执行器失败仍可原地重试。 */
export function completedBatches(record: TaskRecord): TaskRun[][] {
  const batches = Map.groupBy(record.runs.filter((run) => run.requirementDigest === record.confirmedDigest),
    (run) => run.batchId ?? run);
  return [...batches.values()].filter((batch) => batch.every((run) => run.endedAt !== null) &&
    (batch[0]!.batchId !== undefined || batch[0]!.failure === null));
}

export function lastPassedReview(record: TaskRecord): TaskRun | undefined {
  const batch = completedBatches(record).findLast((members) => members.some((run) => run.verdict !== null || run.failure !== null));
  if (!batch?.every((run) => run.failure === null && run.verdict === "pass")) return undefined;
  return batch.reduce((latest, run) => run.endedAt! >= latest.endedAt! ? run : latest);
}

export function stageEntries(record: TaskRecord, stageId: string): number {
  return completedBatches(record).filter(([run], index, batches) => run?.stage === stageId &&
    (run.batchId !== undefined || batches[index - 1]?.[0]?.stage !== stageId)).length;
}

/** 留在原单执行器环节重试不算再次进入。 */
export function dispatchLimit(record: TaskRecord, stage: WorkflowStage, previous?: string): Extract<NextStep, { kind: "limit" }> | null {
  if (stage.maxVisits === null || (stage.id === previous && stage.executors.length === 1)) return null;
  const entries = stageEntries(record, stage.id);
  return entries > stage.maxVisits ? { kind: "limit", stage, entries } : null;
}
export function nextStep(
  workflow: WorkflowDefinition,
  verification: TaskFrontmatter["verification"],
  record: TaskRecord,
): NextStep {
  const active = record.runs.find((run) => run.batchId !== undefined && run.endedAt === null);
  if (active) return { kind: "running", stage: workflow.stages.find((stage) => stage.id === active.stage) ?? { id: active.stage } };
  const batch = completedBatches(record).at(-1) ?? [];
  const last = batch.at(-1);
  const current = workflow.stages.find((stage) => stage.id === last?.stage);
  if (last?.batchId !== undefined) {
    const needsVerdict = current !== undefined && Object.hasOwn(current.report, "verdict");
    // 已经入账的失败和结论在流程编辑后仍属于这一批。
    if (batch.some((run) => run.failure !== null || (run.verdict === null ? needsVerdict : run.verdict !== "pass"))) {
      return {
        kind: "arbitrate",
        stage: workflow.stages.find((stage) => stage.id === current?.onVerdict.changes_requested) ??
          current ?? stageAfter(workflow, verification, undefined) ?? workflow.stages[0]!,
        reports: batch.map((run) => ({ run, path: `${RUNS_DIR}/${run.id}/report.md` })),
      };
    }
  }
  const stage = stageAfter(workflow, verification, last);
  if (stage === undefined) return { kind: "close" };
  return dispatchLimit(record, stage, last?.stage) ?? { kind: "stage", stage };
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
  const verdict = last.batchId === undefined ? last.verdict : null;
  const target = verdict !== null && Object.hasOwn(current.onVerdict, verdict) ? current.onVerdict[verdict] : undefined;
  if (target === WORKFLOW_VERDICT_ANCHOR) return undefined;
  // 结论的去向按流程里的全部环节找，不限于任务要走的。
  if (target !== undefined) return workflow.stages.find((stage) => stage.id === target);
  return workflow.stages.slice(index + 1).find((stage) => walked.includes(stage));
}
