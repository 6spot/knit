/** 后台与窗格共用的会话执行：启动、读取报告、在原会话补报一次，然后停止客户端。 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentLaunch, AgentSession } from "../contracts/agent.js";
import type { ReportFieldType } from "../contracts/workflow.js";
import { type ReportOutcome, reportOutcome, reportRetryMessage } from "../domain/report.js";
import { atomicWrite } from "../infrastructure/atomic.js";
import { registerPane } from "./run-process.js";

export const PANE_OUTCOME_FILE = "outcome.json";
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

export interface SessionOutcome extends ReportOutcome {
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

export async function runAgentSession(input: {
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
