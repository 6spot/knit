/** Knit 共用执行入口：Worktree 中启动客户端，优先窗格、回退后台，最后结算执行。 */
import { isAbsolute, join, relative, sep } from "node:path";
import { builtinAgents } from "../adapters/agents.js";
import type { RexHost } from "../adapters/rex/pane.js";
import type { AgentAdapter, AgentLaunch } from "../contracts/agent.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { finishRun } from "./run-finish.js";
import { runInPane } from "./run-pane.js";
import { RUNS_DIR } from "./run-prepare.js";
import { runAgentSession } from "./run-session.js";
import { findTask } from "./task-store.js";
import { taskWorktree } from "./worktree.js";

export interface ExecuteRunInput {
  readonly root: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workflow: WorkflowDefinition;
  readonly model: string | null;
  readonly thinking?: string | null;
  readonly agent?: AgentAdapter;
  readonly rex?: RexHost | null;
}

/** 返回 finishRun 的结果：问题的列表，空的表示记好了。 */
export async function executeRun(input: ExecuteRunInput): Promise<string[]> {
  const stored = findTask(input.root, input.taskId);
  const run = stored?.record?.runs.find((item) => item.id === input.runId && item.endedAt === null);
  const stage = input.workflow.stages.find((item) => item.id === run?.stage);
  if (stage === undefined || stored === null || run === undefined) {
    return finishRun({ ...input, verdict: null, failure: "执行的环节不在流程里", sessionFile: null });
  }
  const launch: AgentLaunch = {
    model: input.model,
    thinking: input.thinking ?? null,
    cwd: taskWorktree(input.root, stored.dir).path,
    dir: join(input.root, RUNS_DIR, input.runId),
    capabilities: stage.tools,
    report: stage.report,
    protectedPaths: input.workflow.stages.flatMap((item) => item.prompt === null ? [] : [item.prompt]),
  };
  const agent = input.agent ?? builtinAgents[run.agent ?? "pi"].createAdapter();
  const result =
    (input.rex ? await runInPane({ host: input.rex, runId: input.runId, launch, agent }) : null) ??
    await runAgentSession({ session: agent.createSession(launch), declared: stage.report, dir: launch.dir });
  const session = result.sessionFile === null ? null : relative(input.root, result.sessionFile);
  return finishRun({
    ...input,
    ...result,
    sessionFile: session === null || session.startsWith("..") || isAbsolute(session)
      ? result.sessionFile
      : session.split(sep).join("/"),
  });
}
