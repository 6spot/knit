/** Knit 共用执行入口：Worktree 中启动客户端，优先窗格、回退后台，最后结算执行。 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import timers from "node:timers/promises";
import { inspect } from "node:util";
import type { AgentAdapter, AgentLaunch, AgentRegistry, AgentSession, PaneHost, PaneOptions } from "../contracts/agent.js";
import type { ReportFieldType } from "../contracts/workflow.js";
import { reportOutcome, reportRetryMessage, type ReportOutcome } from "../domain/report.js";
import { workflowPrompts, type WorkflowDefinition } from "../domain/workflow.js";
import { recordedProcess } from "../infrastructure/process.js";
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
  const dir = join(input.root, RUNS_DIR, input.runId);
  const outcome = await executeSession(input, dir).catch((error: unknown) => unexpectedFailure(dir, error));
  try {
    return finishRun({ ...input, ...outcome });
  } catch (error) {
    return [unexpectedFailure(dir, error).failure];
  }
}

async function executeSession<Pane>(input: ExecuteRunInput<Pane>, dir: string): Promise<SessionOutcome> {
  const stored = findTask(input.root, input.taskId);
  const run = stored?.record?.runs.find((item) => item.id === input.runId && item.endedAt === null);
  const stage = input.workflow.stages.find((item) => item.id === run?.stage);
  if (stage === undefined || stored === null || run === undefined) {
    return { verdict: null, failure: "执行的环节不在流程里", sessionFile: null, resumeId: null };
  }
  if (run.batchId !== undefined && (stage.tools === null || stage.tools.includes("write"))) {
    return { verdict: null, failure: `并行批次要求只读，当前流程的 ${stage.id} 环节允许写入`, sessionFile: null, resumeId: null };
  }
  const launch: AgentLaunch = {
    root: input.root,
    model: input.model,
    thinking: input.thinking ?? null,
    cwd: taskWorktree(input.root, stored.dir).path,
    dir,
    capabilities: stage.tools,
    report: stage.report,
    protectedPaths: workflowPrompts(input.workflow),
  };
  const agent = input.agents[run.agent ?? "pi"].createAdapter();
  const execute = async (attempt: AgentLaunch) =>
    (input.paneHost ? await runInPane({ host: input.paneHost, runId: run.id, launch: attempt, agent }) : null) ??
    await runAgentSession({ session: agent.createSession(attempt), resume: attempt.resume, declared: stage.report, dir: attempt.dir });
  const fresh = async (reason?: string) => {
    if (reason) {
      logSessionMode(dir, `已自动回退新会话（${reason}）`);
      // 两次尝试共用执行目录，上一会话的回执和清理错误只属于那次尝试。
      [PANE_FILE, PANE_OUTCOME_FILE, SESSION_FILE_LOCATOR, "agy-cleanup-error"].forEach((file) => rmSync(join(dir, file), { force: true }));
    }
    return execute(launch);
  };
  const resume = readResume(launch.dir);
  if (!resume) return fresh();
  const issue = agent.checkResume ? agent.checkResume(resume.resumeId, launch.cwd) : "客户端不支持恢复";
  if (issue !== null) return fresh(issue);

  logSessionMode(launch.dir, "正在恢复原会话");
  const resumed = await execute({ ...launch, resume });
  const startupError = resumed.failure ?? "恢复启动失败";
  if (resumed.startupFailure && !/model not found|unknown model|spawn [^\n]*\b(?:ENOENT|EACCES|ENOEXEC|E2BIG)\b/i.test(startupError)) return fresh(startupError);
  logSessionMode(dir, resumed.startupFailure || startupError.startsWith("执行者启动失败：") ? startupError : "续聊原会话");
  return resumed;
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
  const dir = input.launch.dir;
  try {
    return await executeInPane(input);
  } catch (error) {
    return unexpectedFailure(dir, error);
  }
}

async function executeInPane<Pane>(input: RunInPaneInput<Pane>): Promise<SessionOutcome | null> {
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
  const controller = new AbortController();
  const started = join(dir, PANE_FILE);
  const closed = Promise.resolve().then(() => host.waitClosed(opened.pane, controller.signal));
  try {
    try {
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (!existsSync(started) && Date.now() < deadline && await Promise.race([closed.then(() => false), timers.setTimeout(100, true)]));
      if (existsSync(started)) {
        // rex wait 失联时，客户端也可能已经结束。仍在运行（含等用户输入）的会话没有总时限。
        const clientExit = async () => {
          for await (const _ of timers.setInterval(5_000, undefined, { signal: controller.signal })) {
            if (recordedProcess(started) === null) return;
          }
        };
        await Promise.race([closed, clientExit()]);
      }
    } finally {
      host.close(opened.pane);
    }
    const confirmed = await Promise.race([closed.then(() => true), timers.setTimeout(2_000, false, { signal: controller.signal })]);
    if (!confirmed) {
      logWorkerError(dir, new Error("关闭窗格后等待 rex wait 超时"));
      controller.abort();
    }
  } finally {
    controller.abort();
    await stopPaneProcesses(dir);
  }
  if (!existsSync(started)) {
    if (input.launch.resume) return { verdict: null, failure: "恢复时执行者没有在窗格里开始", startupFailure: true, resumeId: null, sessionFile: null };
    return fallBack("执行者没有在窗格里开始");
  }
  const outcome = join(dir, PANE_OUTCOME_FILE);
  if (!existsSync(outcome)) return { verdict: null, failure: "执行者的窗格关掉了，没有交报告", sessionFile: optionalSessionFile(dir), resumeId: null };
  const result = JSON.parse(readFileSync(outcome, "utf8")) as Partial<SessionOutcome> | null;
  const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
  const resumeId = result?.resumeId ?? null;
  if (!result || !nullableString(result.verdict) || !nullableString(result.failure) || !nullableString(result.sessionFile) ||
      !nullableString(resumeId) || (result.startupFailure !== undefined && result.startupFailure !== true)) {
    throw new Error(`窗格回执格式无效：${outcome}`);
  }
  return { verdict: result.verdict, failure: result.failure, sessionFile: result.sessionFile, resumeId, startupFailure: result.startupFailure };
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

function optionalSessionFile(dir: string): string | null {
  try {
    return readSessionFile(dir);
  } catch {
    return null;
  }
}

export function logSessionMode(dir: string, message: string): void {
  appendFileSync(join(dir, "worker.log"), `会话模式：${message.replace(/\s*\n\s*/g, " ")}\n`);
}

export function readSessionNotice(dir: string): string | undefined {
  const log = join(dir, "worker.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").findLast((line) => line.startsWith("会话模式：")) : undefined;
}

export function logWorkerError(dir: string, error: unknown): void {
  const text = `${error instanceof Error ? inspect(error) : String(error)}\n`;
  try {
    appendFileSync(join(dir, "worker.log"), text);
  } catch {
    process.stderr.write(text);
  }
}

function unexpectedFailure(dir: string, error: unknown) {
  logWorkerError(dir, error);
  return { verdict: null, failure: `执行者出错：${error instanceof Error ? error.message : String(error)}`, sessionFile: null, resumeId: null };
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
    const failure = await input.session.start();
    if (typeof failure === "string") return { verdict: null, failure: `执行者启动失败：${failure}` };
    if (failure) return { verdict: null, failure: `执行者启动失败：${failure.resumeFailure}`, startupFailure: true };
    if (input.resume && input.session.sessionFile) {
      atomicWrite({ path: join(input.dir, SESSION_FILE_LOCATOR), data: Buffer.from(input.session.sessionFile) });
    }
    const first = await askForReport(input.session, input.dir, input.declared, readFileSync(input.resume?.messageFile ?? join(input.dir, "message.md"), "utf8"));
    if (first.outcome !== null) return first.outcome;
    const second = await askForReport(input.session, input.dir, input.declared, reportRetryMessage(first.problems));
    return second.outcome ?? { verdict: null, failure: `报告读不出来：${second.problems.join("；")}` };
  };
  const outcome = await run().catch((error: unknown) => unexpectedFailure(input.dir, error));
  const result = sessionResult(input.dir, input.session, outcome);
  const publish = (value: SessionOutcome) => {
    try {
      input.publish?.(value);
    } catch (error) {
      logWorkerError(input.dir, error);
    }
  };
  publish(result);
  try {
    await input.session.stop();
    return result;
  } catch (error) {
    const stopFailure = unexpectedFailure(input.dir, error).failure;
    const combined: SessionOutcome = {
      ...result,
      verdict: null,
      failure: [result.failure, stopFailure].filter(Boolean).join("；"),
    };
    publish(combined);
    return combined;
  }
}

function sessionResult(
  dir: string,
  session: AgentSession,
  outcome: ReportOutcome & { readonly startupFailure?: true },
): SessionOutcome {
  try {
    return { ...outcome, sessionFile: session.sessionFile, resumeId: session.resumeId ?? null };
  } catch (error) {
    const detail = unexpectedFailure(dir, error).failure;
    return { verdict: null, failure: [outcome.failure, detail].filter(Boolean).join("；"), sessionFile: null, resumeId: null };
  }
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
