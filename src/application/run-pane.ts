/**
 * 在宿主提供的交互窗格里跑执行者。
 * 这是后台执行之外多出来的一层：窗格开不了、执行者没有在里面开始时返回 null，调用方照旧在后台执行。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentAdapter, AgentLaunch, PaneHost, PaneOptions } from "../contracts/agent.js";
import { PANE_FILE, stopPaneProcesses } from "./run-process.js";
import { PANE_OUTCOME_FILE, readSessionFile, type SessionOutcome } from "./run-session.js";

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
