import { readFileSync } from "node:fs";
import type { AgentResult } from "../../contracts/agent.js";

export type AgyObject = Record<string, unknown>;
export const SUBMIT = "KNIT_AGY_SUBMIT";
export const WAITING = "KNIT_AGY_WAITING";
export const BLOCKED = "KNIT_AGY_PERMISSION_BLOCKED";
export const TURN_INSTRUCTIONS = `完成任务时，回复第一行写 ${SUBMIT}，其余行是完整报告。需要用户输入才能继续时，第一行写 ${WAITING} 并说明需要什么。如果必要操作被拒绝，第一行写 ${BLOCKED} 并保留工具返回的原因。`;

export function object(value: unknown): AgyObject | null {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AgyObject : null;
}

export function errorText(value: unknown): string {
  const message = object(value)?.message;
  if (typeof message === "string") return message;
  return typeof value === "string" ? value : "";
}

export function permissionError(message: string): boolean {
  return /permission|access denied|denied by|deny rule|user declined|not authorized|operation not permitted|权限|Knit：/i.test(message);
}

export function resultOf(response: unknown, errors: readonly string[], denied: readonly unknown[], failure = ""): AgentResult | null {
  const text = typeof response === "string" ? response.trim() : "";
  const marker = text.split(/\r?\n/, 1)[0];
  const denial = denied.length === 0 ? [] : [`denied_actions: ${JSON.stringify(denied)}`];
  if (failure) return { report: null, failure: `Antigravity 执行出错：${[failure, ...errors, ...denial].join("；")}` };
  if (marker === WAITING) return null;
  if (marker === BLOCKED || errors.some(permissionError) || denial.length > 0) {
    const detail = [marker === BLOCKED ? text.slice(BLOCKED.length).trim() : "", ...errors, ...denial].filter(Boolean);
    return { report: null, failure: ["Antigravity 权限阻塞", detail.join("；")].filter(Boolean).join("：") };
  }
  return marker === SUBMIT ? { report: text.slice(SUBMIT.length).trimStart(), failure: null } : null;
}

export function transcriptTurn(path: string, cursor: number) {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const rows = lines.slice(cursor).map(object).filter((row) => row !== null);
  const turn = rows.slice(rows.findLastIndex((row) => row.type === "USER_INPUT") + 1);
  return {
    cursor: lines.length,
    response: turn.findLast((row) => row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && typeof row.content === "string")?.content,
    errors: turn.filter((row) => row.status === "ERROR").map((row) => errorText(row.error) || errorText(row.content)).filter(Boolean),
    denied: turn.flatMap((row) => Array.isArray(row.denied_actions) ? row.denied_actions : []),
  };
}
