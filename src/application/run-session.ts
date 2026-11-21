/** 后台与窗格共用的会话执行：启动、读取报告、在原会话补报一次，然后停止客户端。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "../contracts/agent.js";
import type { ReportFieldType } from "../contracts/workflow.js";
import { type ReportOutcome, reportOutcome, reportRetryMessage } from "../domain/report.js";
import { atomicWrite } from "../infrastructure/atomic.js";

export const PANE_FILE = "pane.json";
export const PANE_OUTCOME_FILE = "outcome.json";

export interface SessionOutcome extends ReportOutcome {
  readonly sessionFile: string | null;
}

export function writePaneOutcome(dir: string, outcome: SessionOutcome): void {
  atomicWrite({ path: join(dir, PANE_OUTCOME_FILE), data: Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`) });
}

export async function runAgentSession(input: {
  readonly session: AgentSession;
  readonly dir: string;
  readonly declared: Readonly<Record<string, ReportFieldType>>;
  /** 窗格必须先发布结果，再退出客户端。 */
  readonly publish?: (outcome: SessionOutcome) => void;
}): Promise<SessionOutcome> {
  const run = async (): Promise<ReportOutcome> => {
    const failure = await input.session.start();
    if (failure !== null) return { verdict: null, failure: `执行者启动失败：${failure}` };
    const first = await askForReport(input.session, input.dir, input.declared, readFileSync(join(input.dir, "message.md"), "utf8"));
    if (first.outcome !== null) return first.outcome;
    const second = await askForReport(input.session, input.dir, input.declared, reportRetryMessage(first.problems));
    return second.outcome ?? { verdict: null, failure: `报告读不出来：${second.problems.join("；")}` };
  };
  return run().then((outcome) => {
    const result = { ...outcome, sessionFile: input.session.sessionFile };
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
  if (result.failure !== null) return { outcome: { verdict: null, failure: result.failure }, problems: [] };
  writeFileSync(join(dir, "report.md"), result.report);
  return reportOutcome(declared, result.report);
}
