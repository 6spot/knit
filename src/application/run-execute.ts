/**
 * 执行一个环节：启动 Pi，把准备好的系统提示和第一条消息交给它，等它做完，
 * 把它的最后一条消息当报告存下来，再记下这次执行的结果。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { PiAgentRuntime, type PiRuntimeOptions } from "../adapters/pi/index.js";
import type { RexHost } from "../adapters/rex/pane.js";
import type { ToolCapability } from "../contracts/workflow.js";
import { modelFailure, type ReportOutcome, reportOutcome, reportRetryMessage } from "../domain/report.js";
import type { WorkflowDefinition, WorkflowStage } from "../domain/workflow.js";
import { finishRun } from "./run-finish.js";
import { runInPane } from "./run-pane.js";
import { RUNS_DIR } from "./run-prepare.js";
import { findTask } from "./task-store.js";

export interface ExecuteRunInput {
  readonly root: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workflow: WorkflowDefinition;
  /** provider/模型。 */
  readonly model: string;
  /** Pi 可执行文件的路径。 */
  readonly piExecutable: string;
  /** 主会话在 Rex 里时给出：执行者在 Rex 的窗格里跑，窗格用不了才在后台跑。 */
  readonly rex?: RexHost | null;
}

/** 环节的能力对出的 Pi 内置工具。 */
const BUILTIN_TOOLS = {
  read: ["read", "grep", "find", "ls"],
  write: ["write", "edit"],
  exec: ["bash"],
} as const;

/** 返回 finishRun 的结果：问题的列表，空的表示记好了。 */
export async function executeRun(input: ExecuteRunInput): Promise<string[]> {
  const { root, taskId, runId, workflow } = input;
  const run = findTask(root, taskId)?.record?.runs.find((item) => item.id === runId && item.endedAt === null);
  const stage = workflow.stages.find((item) => item.id === run?.stage);
  // 记录里没有这次执行时，finishRun 会说明。
  if (stage === undefined) {
    const failure = "执行的环节不在流程里";
    return finishRun({ root, taskId, runId, workflow, verdict: null, failure, sessionFile: null });
  }
  const dir = join(root, RUNS_DIR, runId);
  const slash = input.model.indexOf("/");
  const pi: PiRuntimeOptions = {
    executablePath: input.piExecutable,
    provider: input.model.slice(0, slash),
    modelId: input.model.slice(slash + 1),
    cwd: root,
    sessionDir: join(dir, "session"),
    ...runtimeTools(stage.tools),
  };
  const result =
    (input.rex ? await runInPane({ host: input.rex, root, runId, dir, stage, model: input.model, pi }) : null) ??
    (await runInBackground(pi, stage, dir));
  const session = result.sessionFile === null ? null : relative(root, result.sessionFile);
  return finishRun({
    root,
    taskId,
    runId,
    workflow,
    verdict: result.verdict,
    failure: result.failure,
    // 会话文件在项目里时记相对项目根的路径。
    sessionFile:
      session === null || session.startsWith("..") || isAbsolute(session)
        ? result.sessionFile
        : session.split(sep).join("/"),
  });
}

async function runInBackground(
  pi: PiRuntimeOptions,
  stage: WorkflowStage,
  dir: string,
): Promise<ReportOutcome & { readonly sessionFile: string | null }> {
  const runtime = new PiAgentRuntime({ ...pi, appendSystemPrompt: readFileSync(join(dir, "system.md"), "utf8") });
  const outcome = await runStage(runtime, stage, dir).finally(() => runtime.dispose());
  return { ...outcome, sessionFile: runtime.sessionFile };
}

async function runStage(runtime: PiAgentRuntime, stage: WorkflowStage, dir: string): Promise<ReportOutcome> {
  const failed = (failure: string): ReportOutcome => ({ verdict: null, failure });
  const started = await runtime.start();
  if (!started.ok) return failed(`执行者启动失败：${started.detail}`);
  const first = await askForReport(runtime, stage, dir, readFileSync(join(dir, "message.md"), "utf8"));
  if (first.outcome !== null) return first.outcome;
  // 活已经干完了，只是报告的格式不对：在同一个会话里补报一次，不重做。
  const second = await askForReport(
    runtime,
    stage,
    dir,
    reportRetryMessage(first.problems),
  );
  return second.outcome ?? failed(`报告读不出来：${second.problems.join("；")}`);
}

/**
 * 发一条消息，等执行者做完，把它的最后一条消息存成 report.md 再读。
 * `outcome` 是 null 表示报告读不出来，`problems` 里是原因。
 */
async function askForReport(
  runtime: PiAgentRuntime,
  stage: WorkflowStage,
  dir: string,
  message: string,
): Promise<{ readonly outcome: ReportOutcome | null; readonly problems: readonly string[] }> {
  const failed = (failure: string) => ({ outcome: { verdict: null, failure }, problems: [] });
  const settled = await runtime.prompt(message);
  if (!settled.settled) return failed("执行者中途退出");
  if (settled.aborted) return failed("执行者被中止");
  const modelError = runtime.lastModelError();
  if (modelError !== null) return { outcome: modelFailure(modelError), problems: [] };
  const report = await runtime.getLastAssistantText();
  writeFileSync(join(dir, "report.md"), report);
  return reportOutcome(stage.report, report);
}

/** 环节的 tools 换成 PiAgentRuntime 的工具参数。 */
function runtimeTools(
  capabilities: readonly ToolCapability[] | null,
): Pick<PiRuntimeOptions, "capabilities" | "tools" | "toolAdditions" | "excludeTools"> {
  if (capabilities === null) return { capabilities: null, tools: null };
  const wanted = Object.entries(BUILTIN_TOOLS).flatMap(([capability, names]) =>
    capabilities.includes(capability as ToolCapability) ? [...names] : [],
  );
  if (!capabilities.includes("external")) return { capabilities, tools: wanted };
  // 有 external 时要让扩展的工具保持可见：只增加要的内置工具，排除不要的，不收窄成一张名单。
  return {
    capabilities,
    tools: null,
    toolAdditions: wanted,
    excludeTools: Object.values(BUILTIN_TOOLS)
      .flat()
      .filter((name) => !wanted.includes(name)),
  };
}
