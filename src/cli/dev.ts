/**
 * M1 开发诊断：仅本次进程的 JSON stderr；白名单字段，不写文件、不参与业务。
 * 不输出路径、凭据、消息正文或原生历史。
 */
import type { Command } from "commander";

const ALLOWED = new Set([
  "command",
  "event",
  "outcome",
  "reasonCode",
  "runId",
  "taskId",
  "operationId",
  "phase",
  "state",
  "prepared",
  "durationMs",
  "exitCode",
  "workerId",
  "snapshotState",
  "reason",
]);

let startedAt: number | null = null;
let startedCommand: string | null = null;
let ended = false;

export function devEnabled(program: Command): boolean {
  return program.opts().dev === true || process.env.KNIT_DEV === "1";
}

export function devEvent(event: string, fields: Record<string, unknown> = {}): void {
  const payload: Record<string, unknown> = { type: "knit.diag", event };
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key) || value === undefined || value === null) continue;
    payload[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  process.stderr.write(JSON.stringify(payload) + "\n");
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current !== null && current.parent !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

export function installDiagnostics(program: Command): void {
  program.hook("preAction", (_thisCommand, actionCommand) => {
    if (!devEnabled(program)) return;
    startedAt = Date.now();
    startedCommand = commandPath(actionCommand);
    ended = false;
    devEvent("command_start", { command: startedCommand });
  });
  program.hook("postAction", (_thisCommand, actionCommand) => {
    if (!devEnabled(program) || startedAt === null || ended) return;
    ended = true;
    devEvent("command_end", {
      command: commandPath(actionCommand),
      exitCode: process.exitCode ?? 0,
      durationMs: Date.now() - startedAt,
    });
  });
  process.on("exit", (code) => {
    if (!devEnabled(program) || startedAt === null || ended) return;
    ended = true;
    devEvent("command_end", {
      command: startedCommand ?? "unknown",
      exitCode: code,
      durationMs: Date.now() - startedAt,
    });
  });
}
