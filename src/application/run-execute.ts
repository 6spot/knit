/** Knit 共用执行入口：Worktree 中启动客户端，优先窗格、回退后台，最后结算执行。 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentLaunch, AgentRegistry } from "../contracts/agent.js";
import type { PaneHost } from "../contracts/pane.js";
import { workflowPrompts, type WorkflowDefinition } from "../domain/workflow.js";
import { finishRun } from "./run-finish.js";
import { runInPane } from "./run-pane.js";
import { RUNS_DIR } from "./run-prepare.js";
import { PANE_FILE } from "./run-process.js";
import { logSessionMode, PANE_OUTCOME_FILE, readResume, runAgentSession, SESSION_FILE_LOCATOR } from "./run-session.js";
import { findTask } from "./task-store.js";
import { taskWorktree } from "./worktree.js";

export interface ExecuteRunInput<Pane> {
  readonly root: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workflow: WorkflowDefinition;
  readonly model: string | null;
  readonly thinking?: string | null;
  readonly agents: AgentRegistry;
  readonly paneHost?: PaneHost<Pane> | null;
}

/** 返回 finishRun 的结果：问题的列表，空的表示记好了。 */
export async function executeRun<Pane>(input: ExecuteRunInput<Pane>): Promise<string[]> {
  const stored = findTask(input.root, input.taskId);
  const run = stored?.record?.runs.find((item) => item.id === input.runId && item.endedAt === null);
  const stage = input.workflow.stages.find((item) => item.id === run?.stage);
  if (stage === undefined || stored === null || run === undefined) {
    return finishRun({ ...input, verdict: null, failure: "执行的环节不在流程里", sessionFile: null });
  }
  if (run.batchId !== undefined && (stage.tools === null || stage.tools.includes("write"))) {
    return finishRun({ ...input, verdict: null, failure: `并行批次要求只读，当前流程的 ${stage.id} 环节允许写入`, sessionFile: null });
  }
  const launch: AgentLaunch = {
    root: input.root,
    model: input.model,
    thinking: input.thinking ?? null,
    cwd: taskWorktree(input.root, stored.dir).path,
    dir: join(input.root, RUNS_DIR, input.runId),
    capabilities: stage.tools,
    report: stage.report,
    protectedPaths: workflowPrompts(input.workflow),
  };
  const agent = input.agents[run.agent ?? "pi"].createAdapter();
  const execute = async (attempt: AgentLaunch) =>
    (input.paneHost ? await runInPane({ host: input.paneHost, runId: run.id, launch: attempt, agent }) : null) ??
    await runAgentSession({ session: agent.createSession(attempt), resume: attempt.resume, declared: stage.report, dir: attempt.dir });
  const fresh = async (reason?: string) => {
    if (reason) logSessionMode(launch.dir, `已自动回退新会话（${reason}）`);
    return finishRun({ ...input, ...await execute(launch) });
  };
  const resume = readResume(launch.dir);
  if (!resume) return fresh();
  const issue = agent.checkResume ? agent.checkResume(resume.resumeId, launch.cwd) : "客户端不支持恢复";
  if (issue !== null) return fresh(issue);

  logSessionMode(launch.dir, "正在恢复原会话");
  const resumed = await execute({ ...launch, resume });
  if (!resumed.startupFailure) {
    logSessionMode(launch.dir, "续聊原会话");
    return finishRun({ ...input, ...resumed });
  }
  // 两次启动共用执行目录。上一窗格已退出，清除其回执后才可打开新窗格。
  [PANE_FILE, PANE_OUTCOME_FILE, SESSION_FILE_LOCATOR].forEach((file) => rmSync(join(launch.dir, file), { force: true }));
  return fresh(resumed.failure ?? "恢复启动失败");
}
