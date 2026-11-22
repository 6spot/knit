import type { Standard } from "../domain/standards.js";
import { renderStandard } from "./handoff.js";
import { arbitrationNotice, limitNotice, RUNS_DIR } from "./run-prepare.js";
import type { buildSessionContext, SessionTaskStatus } from "./session-context.js";

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

function nextLine(task: SessionTaskStatus): string[] {
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
  return [`下一步: 派发${step.stage.name}环节（knit run start ${id}）`];
}

export function statusLines(task: SessionTaskStatus): string[] {
  return [
    `任务: ${task.frontmatter.title}（${task.frontmatter.id}）`,
    `状态: ${task.status === "active" ? `active(${task.frontmatter.stage})` : task.status}`,
    ...(task.worktree === null ? [] : [`Worktree: ${task.worktree.path}（${task.worktree.branch}）`]),
    ...(task.members.length ? task.members.flatMap((member) => [
      ...(member.run.batchId ? [`执行器: ${member.run.executor ?? member.run.id}`, `报告: ${member.path}`] : []),
      ...runLines(task, member),
      ...(member.sessionNotice ? [member.sessionNotice] : []),
    ]) : ["还没有派发过"]),
    ...(task.members.some(({ run }) => run.endedAt === null) ? [] : nextLine(task)),
  ];
}

export function contextLines(context: Extract<ReturnType<typeof buildSessionContext>, { kind: "context" }>): string[] {
  const task = context.task;
  return [
    ...standardLines("discuss", context.discussion),
    ...(task === null ? [] : [...statusLines(task.status), `目录: ${task.dir}`]),
    ...(task?.commit == null ? [] : [`提交: ${task.commit}`]),
    ...(task?.supplement == null ? [] : standardLines(task.supplement.stage, task.supplement.standards)),
  ];
}

function standardLines(stage: string, standards: readonly Standard[]): string[] {
  if (standards.length === 0) return [`规范（${stage} 环节）: 没有`];
  return [`规范（${stage} 环节）:`, standards.map(renderStandard).join("\n\n")];
}
