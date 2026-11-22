/** Knit 共用执行入口：Worktree 中启动客户端，优先窗格、回退后台，最后结算执行。 */
import { join } from "node:path";
import type { AgentLaunch, AgentRegistry } from "../contracts/agent.js";
import type { PaneHost } from "../contracts/pane.js";
import { workflowPrompts, type WorkflowDefinition } from "../domain/workflow.js";
import { finishRun } from "./run-finish.js";
import { runInPane } from "./run-pane.js";
import { RUNS_DIR } from "./run-prepare.js";
import { runAgentSession } from "./run-session.js";
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
  const result =
    (input.paneHost ? await runInPane({ host: input.paneHost, runId: input.runId, launch, agent }) : null) ??
    await runAgentSession({ session: agent.createSession(launch), declared: stage.report, dir: launch.dir });
  return finishRun({ ...input, ...result });
}
