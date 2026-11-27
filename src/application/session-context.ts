import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "../contracts/task.js";
import { PITFALLS_PATH } from "../domain/pitfalls.js";
import { batchOf, lastPassedReview, nextStep, sessionStage } from "../domain/progress.js";
import { standardsForStage, type Standard } from "../domain/standards.js";
import { currentStatus, type TaskDocument } from "../domain/task.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { renderStandard } from "./handoff.js";
import { loadStandards, readWorkflow } from "./project-config.js";
import { livePane, liveWorker, startingWorker } from "./run-control.js";
import { readSessionFile, readSessionNotice } from "./run-execute.js";
import { arbitrationNotice, limitNotice, RUNS_DIR } from "./run-prepare.js";
import { readTask, shownTaskDirectory, taskCommit, type TaskRefusal } from "./task-store.js";
import { taskWorktree } from "./worktree.js";

/** context、run status 和 run wait 展示同一份状态。 */
export function buildTaskStatus(root: string, dir: string | null, workflow: WorkflowDefinition, document: TaskDocument, record: TaskRecord, batchId?: string) {
  const status = currentStatus(document, record);
  const active = record.runs.find((run) => run.endedAt === null);
  const member = batchId === undefined ? active ?? record.runs.at(-1) : record.runs.find((run) => run.batchId === batchId);
  const members = batchOf(record, member).map((run) => {
    const runDir = join(root, RUNS_DIR, run.id);
    const path = `${RUNS_DIR}/${run.id}/report.md`;
    return { run, path, sessionNotice: readSessionNotice(runDir), sessionFile: run.endedAt === null ? readSessionFile(runDir) : run.sessionFile,
      report: run.endedAt !== null && existsSync(join(root, path)) ? path : null,
      starting: startingWorker(root, document.frontmatter.id, run),
      pane: run.endedAt === null && livePane(root, run.id) !== null,
      worker: run.endedAt === null && liveWorker(root, run.id) !== null };
  });
  const worktree = dir === null ? null : taskWorktree(root, dir);
  return {
    frontmatter: document.frontmatter, status, members,
    worktree: worktree !== null && existsSync(join(worktree.path, ".git")) ? worktree : null,
    stageName: workflow.stages.find((stage) => stage.id === members[0]?.run.stage)?.name ?? members[0]?.run.stage,
    next: active === undefined && (status === "ready" || status === "active") ? nextStep(workflow, document.frontmatter.verification, record) : null,
    workflow, record,
  };
}

export type SessionTaskStatus = ReturnType<typeof buildTaskStatus>;

export function buildSessionContext(root: string, id?: string) {
  const loaded = id === undefined ? null : readTask(root, id);
  if (loaded?.kind === "refused") return loaded;
  const workflow = loaded === null ? null : readWorkflow(root);
  if (workflow?.workflow === null) return { kind: "refused", problems: workflow.problems } satisfies TaskRefusal;
  const standards = loadStandards(root);
  const discussionStandards = standardsForStage(standards, "discuss");
  if (loaded === null || workflow === null) return { kind: "context", discussion: discussionStandards, task: null } as const;
  const { document, record, stored } = loaded.task;
  const status = buildTaskStatus(root, stored.dir, workflow.workflow, document, record);
  const stage = sessionStage(workflow.workflow, document.frontmatter.verification, record, status.status);
  // 主会话总有讨论规范；避坑清单只出现一次，取所选任务当前环节的分区。
  const discussion = stage === null || stage === "discuss" ? discussionStandards
    : discussionStandards.filter((standard) => standard.path !== PITFALLS_PATH);
  const discussionPaths = new Set(discussion.map((standard) => standard.path));
  const supplement = stage === null || stage === "discuss" ? null : {
    stage, standards: standardsForStage(standards, stage).filter((standard) => !discussionPaths.has(standard.path)),
  };
  return { kind: "context", discussion, task: {
    dir: shownTaskDirectory(loaded.task), commit: taskCommit(loaded.task), status, supplement,
  } } as const;
}

function runLines(task: SessionTaskStatus, member: SessionTaskStatus["members"][number]): string[] {
  const run = member.run;
  const dir = `${RUNS_DIR}/${run.id}`;
  const agent = `Agent: ${run.agent ?? "pi"}`;
  if (run.endedAt !== null) {
    return [
      `上一次: ${task.stageName}（${run.id}）`,
      run.failure !== null ? `失败: ${run.failure}` : run.verdict !== null ? `结论: ${run.verdict}` : "结果: 正常结束",
      ...(member.report === null || run.batchId ? [] : [`报告: ${member.report}`]),
      ...(member.sessionNotice && run.sessionFile ? [`会话记录: ${run.sessionFile}`] : []),
      `改动文件: ${run.changedPaths.length} 个`,
      agent,
    ];
  }
  if (member.starting) return [`正在启动: ${task.stageName}（${run.id}）`, agent];
  return !member.worker
    ? [
        `执行 ${run.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${task.frontmatter.id} 记为失败`,
        agent,
        ...(member.pane
          ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格还开着，执行者还在里面；knit run cancel 会把它一起停掉`]
          : []),
      ]
    : [
        `正在跑: ${task.stageName}（${run.id}），开始于 ${run.startedAt}`,
        `会话记录: ${member.sessionFile ?? `${dir}/session/`}`,
        agent,
        ...(member.pane ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格（最小化着）`] : []),
      ];
}

export type DispatchMode = "external" | "native";

function nextLine(task: SessionTaskStatus, dispatchMode?: DispatchMode): string[] {
  const id = task.frontmatter.id;
  const status = task.status;
  if (status === "draft") return [`下一步: 先确认需求（knit task ready ${id}）`];
  if (status === "done") return [`下一步: 用户授权后交付（knit deliver ${id}）`];
  const step = task.next;
  if (step === null || step.kind === "running") return [];
  if (step.kind === "arbitrate") return [`下一步: ${arbitrationNotice(id, step).join("\n")}`];
  if (step.kind === "close") return [`下一步: 核对之后运行 knit task close ${id}`];
  if (step.kind === "limit") {
    const [first, ...rest] = limitNotice(id, task.workflow, task.record, step);
    return [`下一步: ${first}`, ...rest];
  }
  if (dispatchMode === "native") {
    const close = `knit task close ${id} --result <总结>`;
    const finish = task.frontmatter.verification === "independent" && lastPassedReview(task.record) === undefined
      ? `原生独立检查通过后，运行 ${close} --reason <原生独立检查说明>`
      : `完成后运行 ${close}`;
    return [`下一步: 使用当前宿主自身工具与原生子 Agent 完成${step.stage.name}环节。${finish}`];
  }
  return [`下一步: 派发${step.stage.name}环节（knit run start ${id}）`];
}

export function statusLines(task: SessionTaskStatus, dispatchMode?: DispatchMode): string[] {
  return [
    `任务: ${task.frontmatter.title}（${task.frontmatter.id}）`,
    `状态: ${task.status === "active" ? `active(${task.frontmatter.stage})` : task.status}`,
    ...(task.worktree === null ? [] : [`Worktree: ${task.worktree.path}（${task.worktree.branch}）`]),
    ...(task.members.length ? task.members.flatMap((member) => [
      ...(member.run.batchId ? [`执行器: ${member.run.executor ?? member.run.id}`, `报告: ${member.path}`] : []),
      ...runLines(task, member),
      ...(member.sessionNotice ? [member.sessionNotice] : []),
    ]) : ["还没有派发过"]),
    ...(task.members.some(({ run }) => run.endedAt === null) ? [] : nextLine(task, dispatchMode)),
  ];
}

type SessionContext = Extract<ReturnType<typeof buildSessionContext>, { kind: "context" }>;

export function contextLines(context: SessionContext): string[] {
  const supplement = context.task?.supplement;
  return [
    ...standardLines("discuss", context.discussion),
    ...taskContextLines(context.task),
    ...(supplement == null ? [] : standardLines(supplement.stage, supplement.standards)),
  ];
}

export function contextBlocks(context: SessionContext, dispatchMode?: DispatchMode) {
  const supplement = context.task?.supplement;
  const pitfalls = (supplement?.standards ?? context.discussion).find((standard) => standard.path === PITFALLS_PATH);
  const supplemental = supplement?.standards.filter((standard) => standard.path !== PITFALLS_PATH) ?? [];
  return {
    discussion: standardLines("discuss", context.discussion.filter((standard) => standard.path !== PITFALLS_PATH)).join("\n"),
    status: taskContextLines(context.task, dispatchMode).join("\n"),
    supplement: supplement != null && supplemental.length > 0 ? standardLines(supplement.stage, supplemental).join("\n") : "",
    pitfalls: pitfalls === undefined ? "" : renderStandard(pitfalls),
  };
}

function taskContextLines(task: SessionContext["task"], dispatchMode?: DispatchMode): string[] {
  return task === null ? [] : [
    ...statusLines(task.status, dispatchMode),
    `目录: ${task.dir}`,
    ...(task.commit === null ? [] : [`提交: ${task.commit}`]),
  ];
}

function standardLines(stage: string, standards: readonly Standard[]): string[] {
  if (standards.length === 0) return [`规范（${stage} 环节）: 没有`];
  return [`规范（${stage} 环节）:`, standards.map(renderStandard).join("\n\n")];
}
