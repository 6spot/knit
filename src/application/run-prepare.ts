/**
 * 派发一个环节的第一步：检查能不能派发，把交给执行者的内容和工作区的记录存下来，
 * 在任务的执行记录里登记这一次。不能派发时说明原因，什么都不写。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord, TaskRun } from "../contracts/task.js";
import { WORKFLOW_MODEL_PATTERN } from "../contracts/workflow.js";
import { countedRuns, nextStep, type NextStep } from "../domain/progress.js";
import { stageRules } from "../domain/stage-rules.js";
import { currentStatus, requirementDigest } from "../domain/task-document.js";
import type { WorkflowDefinition, WorkflowStage } from "../domain/workflow.js";
import { gitSync } from "../infrastructure/process.js";
import type { ProjectConfig } from "./config.js";
import { assembleHandoff, type HandoffReport } from "./handoff.js";
import { saveTask, scanTasks } from "./task-store.js";
import { takeSnapshot } from "./workspace.js";

/** 一次执行的目录是 `<RUNS_DIR>/<run-id>`。 */
export const RUNS_DIR = ".knit/.runtime/runs";

export interface PrepareRunInput {
  readonly root: string;
  readonly taskId: string;
  readonly workflow: WorkflowDefinition;
  readonly config: ProjectConfig;
  /** 调用方临时指定的模型（provider/模型）；null 时用流程里这个环节的。 */
  readonly model: string | null;
}

export interface PreparedRun {
  readonly id: string;
  /** 执行目录，相对项目根。 */
  readonly dir: string;
  readonly stage: WorkflowStage;
  /** 最后用的模型。 */
  readonly model: string;
}

export type PrepareRunResult =
  | { readonly run: PreparedRun; readonly problems: readonly [] }
  | { readonly run: null; readonly problems: readonly string[] };

/** 没归档的任务里一次还没结束的执行；同一时间只跑一个执行者，所以最多一个。 */
export function unfinishedRun(root: string): { taskId: string; runId: string } | null {
  for (const task of scanTasks(root)) {
    const run = task.archived ? undefined : task.record?.runs.find((item) => item.endedAt === null);
    if (task.document !== null && run !== undefined) return { taskId: task.document.frontmatter.id, runId: run.id };
  }
  return null;
}

export function prepareRun(input: PrepareRunInput): PrepareRunResult {
  const { root, taskId } = input;
  const refuse = (...problems: string[]): PrepareRunResult => ({ run: null, problems });
  const tasks = scanTasks(root);
  const stored = tasks.find((task) => task.id === taskId);
  if (stored === undefined) return refuse(`没有任务 ${taskId}；用 knit task list 查看现有任务`);
  const { document, record } = stored;
  if (document === null || record === null) return refuse(...stored.problems);
  if (gitSync(["rev-parse", "--is-inside-work-tree"], root).code !== 0) {
    return refuse("这个目录不在 Git 仓库里，不能派发执行者");
  }
  const status = currentStatus(document, record);
  if (status === "draft") return refuse(`需求还没有确认，或确认之后改过；先运行 knit task ready ${taskId}`);
  if (status !== "ready" && status !== "active") return refuse(`任务已经结束（${status}），不能再派发`);
  // 依赖的任务已经归档的也算在内。
  const waiting = document.frontmatter.dependsOn.flatMap((id) => {
    const dependency = tasks.find((task) => task.document?.frontmatter.id === id)?.document?.frontmatter.status;
    if (dependency === undefined) return [`依赖的任务不存在：${id}`];
    return dependency === "done" || dependency === "delivered" ? [] : [`依赖的任务还没有完成：${id}（${dependency}）`];
  });
  if (waiting.length > 0) return refuse(...waiting);
  const running = unfinishedRun(root);
  if (running !== null) {
    return refuse(
      `任务 ${running.taskId} 的执行 ${running.runId} 还没有结束；等它结束，或运行 knit run cancel ${running.taskId}`,
    );
  }
  const step = nextStep(input.workflow, document.frontmatter.verification, record);
  if (step.kind === "close") return refuse(`所有环节都做完了；核对之后运行 knit task close ${taskId}`);
  if (step.kind === "limit") return refuse(...limitNotice(taskId, input.workflow, record, step));
  const stage = step.stage;
  const model = input.model ?? stage.model;
  if (model === null) {
    return refuse("没有指定执行者的模型：在 .knit/workflow.yaml 里写 model，或加 --model provider/模型");
  }
  if (!new RegExp(WORKFLOW_MODEL_PATTERN).test(model)) return refuse(`--model 要写成 provider/模型：${model}`);

  const counted = countedRuns(record);
  const last = counted.at(-1);
  // 再次进入这个环节时带上它自己上一次的报告；留在原环节再做时那就是上一个环节的报告，不重复给。
  const own = counted.findLast((run) => run.stage === stage.id);
  const handoff = assembleHandoff({
    root,
    task: { dir: stored.dir, document },
    stage,
    previous: last === undefined ? null : reportOf(root, last),
    own: own === undefined || own === last ? null : reportOf(root, own),
    limits: input.config.handoff,
  });
  if (handoff.problems.length > 0) return refuse(...handoff.problems);

  const id = `r-${randomBytes(6).toString("hex")}`;
  const conflicts = saveTask(
    root,
    stored,
    { ...document, frontmatter: { ...document.frontmatter, status: "active", stage: stage.id } },
    {
      ...record,
      runs: [
        ...record.runs,
        {
          id,
          stage: stage.id,
          startedAt: new Date().toISOString(),
          endedAt: null,
          verdict: null,
          failure: null,
          requirementDigest: requirementDigest(document),
          changedPaths: [],
          sessionFile: null,
        },
      ],
    },
  );
  if (conflicts.length > 0) return refuse(...conflicts);

  const dir = `${RUNS_DIR}/${id}`;
  mkdirSync(join(root, dir), { recursive: true });
  // 规则不计入交接的字节上限。
  writeFileSync(join(root, dir, "system.md"), `${handoff.systemPrompt}\n\n${stageRules(input.workflow, stage)}`);
  writeFileSync(join(root, dir, "message.md"), handoff.firstMessage);
  // 在写回任务之后拍：任务自己的两个文件的变化不会算成执行者的改动。
  writeFileSync(join(root, dir, "before.json"), `${JSON.stringify(takeSnapshot(root), null, 2)}\n`);
  return { run: { id, dir, stage, model }, problems: [] };
}

/**
 * 返工到了上限时交回主会话的话：各轮报告在哪里，可以走哪几条路。
 * 不读报告的内容，不生成汇总。
 */
export function limitNotice(
  taskId: string,
  workflow: WorkflowDefinition,
  record: TaskRecord,
  step: Extract<NextStep, { kind: "limit" }>,
): string[] {
  const nameOf = (stageId: string) => workflow.stages.find((stage) => stage.id === stageId)?.name ?? stageId;
  return [
    `${step.stage.name}环节已经进入 ${step.entries} 次，到了上限，不再派发。各轮的报告：`,
    ...countedRuns(record).map(
      (run) => `  ${nameOf(run.stage)}（${run.id}）${run.verdict ?? ""}：${RUNS_DIR}/${run.id}/report.md`,
    ),
    "可以走的路：",
    `  1. 主会话直接修，改完运行 knit task close ${taskId} --paths <改动的文件>`,
    "  2. 拆成更小的任务",
    `  3. 需求本身有问题就改需求，再运行 knit task ready ${taskId}；进入次数从头数`,
    `  4. 用户决定带理由接受：knit task close ${taskId} --reason <理由>`,
  ];
}

/** 一次执行的报告，交接时用。 */
function reportOf(root: string, run: TaskRun): HandoffReport {
  const path = `${RUNS_DIR}/${run.id}/report.md`;
  return {
    stage: run.stage,
    path,
    changedPaths: run.changedPaths,
    text: existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "报告原文不在这台机器上。",
  };
}
