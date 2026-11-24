/** Knit 共用执行入口：Worktree 中启动客户端，优先窗格、回退后台，最后结算执行。 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentAdapter, AgentLaunch, AgentRegistry, AgentSession, PaneHost, PaneOptions } from "../contracts/agent.js";
import type { ReportFieldType } from "../contracts/workflow.js";
import { reportOutcome, reportRetryMessage, type ReportOutcome } from "../domain/report.js";
import { workflowPrompts, type WorkflowDefinition } from "../domain/workflow.js";
import { atomicWrite } from "../infrastructure/fs.js";
import { PANE_FILE, registerPane, stopPaneProcesses } from "./run-control.js";
import { finishRun } from "./run-finish.js";
import { RUNS_DIR } from "./run-prepare.js";
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

/** 窗格开出来之后等执行者开始的时间；本机上 Pi 约 1 秒开始。 */
const START_TIMEOUT_MS = 20_000;

export interface RunInPaneInput<Pane> {
  readonly host: PaneHost<Pane>;
  readonly runId: string;
  readonly launch: AgentLaunch;
  readonly agent: AgentAdapter;
}

/** 返回这次执行的结果；null 表示没能在窗格里开始，原因已经写到标准错误（进 worker.log）。 */
export async function runInPane<Pane>(input: RunInPaneInput<Pane>): Promise<SessionOutcome | null> {
  const host = input.host;
  const dir = input.launch.dir;
  const fallBack = (reason: string): null => {
    process.stderr.write(`Rex 窗格用不了（${reason}），改在后台执行\n`);
    return null;
  };
  const command = input.agent.paneCommand(input.launch);
  if (command === null) return fallBack("客户端不支持窗格执行");
  const opened = openRunPane(host, { label: `knit ${input.runId}`, command, cwd: input.launch.cwd });
  if ("error" in opened) return fallBack(opened.error);
  const closed = host.waitClosed(opened.pane);
  const started = join(dir, PANE_FILE);
  const deadline = Date.now() + START_TIMEOUT_MS;
  // 每 100 毫秒看一次执行者开始了没有；窗格没了就不用等了。
  while (
    !existsSync(started) &&
    Date.now() < deadline &&
    (await Promise.race([closed.then(() => false), sleep(100, true)]))
  );
  // 开始了就等它做完。
  if (existsSync(started)) await closed;
  // 没开始的窗格要关掉：关掉之后执行者不会再开始，回退不会和它撞上。做完的窗格一般已经自己关了，
  // 但程序很快就失败时 Rex 会把它留着。
  host.close(opened.pane);
  await closed;
  if (!existsSync(started)) {
    if (input.launch.resume) return { verdict: null, failure: "恢复时执行者没有在窗格里开始", startupFailure: true, resumeId: null, sessionFile: null };
    return fallBack("执行者没有在窗格里开始");
  }
  await stopPaneProcesses(dir);
  const outcome = join(dir, PANE_OUTCOME_FILE);
  if (!existsSync(outcome)) return { verdict: null, failure: "执行者的窗格关掉了，没有交报告", sessionFile: readSessionFile(dir), resumeId: null };
  return JSON.parse(readFileSync(outcome, "utf8")) as SessionOutcome;
}

function openRunPane<Pane>(host: PaneHost<Pane>, options: PaneOptions): { pane: Pane } | { error: string } {
  try {
    return { pane: host.open(options) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const PANE_OUTCOME_FILE = "outcome.json";
export const SESSION_FILE_LOCATOR = "session-file.txt";

export function readResume(dir: string): AgentLaunch["resume"] {
  const file = join(dir, "resume-id.txt");
  return existsSync(file) ? { resumeId: readFileSync(file, "utf8"), messageFile: join(dir, "resume-message.md") } : undefined;
}

export function readSessionFile(dir: string): string | null {
  const locator = join(dir, SESSION_FILE_LOCATOR);
  return existsSync(locator) ? readFileSync(locator, "utf8") : null;
}

export function logSessionMode(dir: string, message: string): void {
  appendFileSync(join(dir, "worker.log"), `会话模式：${message.replace(/\s*\n\s*/g, " ")}\n`);
}

export function readSessionNotice(dir: string): string | undefined {
  const log = join(dir, "worker.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").findLast((line) => line.startsWith("会话模式：")) : undefined;
}

interface SessionOutcome extends ReportOutcome {
  readonly resumeId: string | null;
  readonly startupFailure?: true;
  readonly sessionFile: string | null;
}

export async function runPaneSession(input: {
  readonly dir: string;
  readonly declared: Readonly<Record<string, ReportFieldType>>;
  readonly createSession: () => AgentSession;
  readonly resume?: AgentLaunch["resume"];
  /** 运行在交互客户端内时，由客户端处理终端信号。后台已经退出时，请它关闭界面。 */
  readonly hostClient?: { shutdown(): void };
}): Promise<void> {
  if (!registerPane(input.dir)) return input.hostClient?.shutdown();
  const session = input.createSession();
  const signals = input.hostClient === undefined ? ["SIGHUP", "SIGTERM"] as const : [];
  const shutDown = () => { void session.stop().finally(() => process.exit(1)); };
  signals.forEach((signal) => process.once(signal, shutDown));
  await runAgentSession({
    session,
    resume: input.resume,
    dir: input.dir,
    declared: input.declared,
    publish: (outcome) => writePaneOutcome(input.dir, outcome),
  }).finally(() => signals.forEach((signal) => process.off(signal, shutDown)));
}

function writePaneOutcome(dir: string, outcome: SessionOutcome): void {
  atomicWrite({ path: join(dir, PANE_OUTCOME_FILE), data: Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`) });
}

async function runAgentSession(input: {
  readonly session: AgentSession;
  readonly resume?: AgentLaunch["resume"];
  readonly dir: string;
  readonly declared: Readonly<Record<string, ReportFieldType>>;
  /** 窗格必须先发布结果，再退出客户端。 */
  readonly publish?: (outcome: SessionOutcome) => void;
}): Promise<SessionOutcome> {
  const run = async (): Promise<ReportOutcome & { readonly startupFailure?: true }> => {
    const failure = await input.session.start().catch((error: unknown) => String(error));
    if (failure !== null) return { verdict: null, failure: `执行者启动失败：${failure}`, startupFailure: true };
    if (input.resume && input.session.sessionFile) {
      atomicWrite({ path: join(input.dir, SESSION_FILE_LOCATOR), data: Buffer.from(input.session.sessionFile) });
    }
    const first = await askForReport(input.session, input.dir, input.declared, readFileSync(input.resume?.messageFile ?? join(input.dir, "message.md"), "utf8"));
    if (first.outcome !== null) return first.outcome;
    const second = await askForReport(input.session, input.dir, input.declared, reportRetryMessage(first.problems));
    return second.outcome ?? { verdict: null, failure: `报告读不出来：${second.problems.join("；")}` };
  };
  return run().then((outcome) => {
    const result = { ...outcome, sessionFile: input.session.sessionFile, resumeId: input.session.resumeId ?? null };
    input.publish?.(result);
    return result;
  }).finally(() => input.session.stop());
}

async function askForReport(
  session: AgentSession,
  dir: string,
  declared: Readonly<Record<string, ReportFieldType>>,
  message: string,
): Promise<{ readonly outcome: ReportOutcome | null; readonly problems: readonly string[] }> {
  const result = await session.prompt(message);
  if (result.failure !== null) return { outcome: { verdict: null, failure: result.failure, ...(result.startupFailure ? { startupFailure: true } : {}) }, problems: [] };
  writeFileSync(join(dir, "report.md"), result.report);
  return reportOutcome(declared, result.report);
}
