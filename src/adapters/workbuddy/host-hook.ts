import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkHostCommand } from "../../application/host-command.js";
import { shellQuote } from "../../infrastructure/process.js";

const guidance = [
  "WorkBuddy 是桌面 GUI 主会话宿主，仅通过 Bash 使用 Knit 管理任务与交付（knit task / knit context --use <id> / knit task close / knit deliver）。",
  "实现与独立检查全程使用 WorkBuddy 自身工具与原生子 Agent 完成，不调用 knit run start 派发外部 CLI（WorkBuddy 桌面沙箱会拦截外部执行者子进程；如确需外部执行者，请提示用户在普通终端、Pi 或 Antigravity 中运行 knit run start <id>）。",
].join("\n");

const rejectStartReason = "WorkBuddy 桌面端不支持派发外部 CLI 执行者（桌面沙箱会拦截外部执行者进程）。请直接使用 WorkBuddy 自身工具与原生子 Agent 完成实现和检查，再运行 knit task close 与 knit deliver；如确需外部执行者，请在普通终端、Pi 或 Antigravity 中运行 knit run start。";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function userText(value: unknown): string[] {
  const row = record(value);
  if (row?.type !== "message" || row.role !== "user" || hostGenerated(record(row.providerData))) return [];
  const parts = typeof row.content === "string" ? [row.content] : Array.isArray(row.content) ? row.content.map(record)
    .flatMap((part) => part?.type === "input_text" && typeof part.text === "string" ? [part.text] : []) : [];
  const visible = parts.map((part) => part.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, ""));
  if (visible.some((part) => /<\/?system-reminder\b/.test(part))) return [];
  // 桌面端可在同一条消息中另放附件信息，用 user_query 标出用户输入。
  const query = visible.map((part) => /^<user_query>(.*)<\/user_query>$/s.exec(part.trim())?.[1]).find((body) => body !== undefined);
  return [query === undefined ? visible.join("\n") : query.replace(/^(?:<query_source>[^<]*<\/query_source>(?:\r?\n|$))+/, "")];
}

function hostGenerated(meta: Record<string, unknown> | undefined): boolean {
  return ["isMeta", "skipRun", "isAdditionalData", "isCompactInternal", "isCompacted", "isSummary", "contentFilterNotice"]
    .some((flag) => meta?.[flag] === true) || ["goalStatus", "scheduledTaskTrigger", "hookStatus"].some((key) => meta?.[key] != null) ||
    meta?.agent === "compact" || typeof meta?.compactType === "string" || typeof record(meta?.teammateMessage)?.from === "string";
}

function userMessages(path: unknown, cwd: string): string[] {
  if (typeof path !== "string" || !path) return [];
  try {
    return readFileSync(resolve(cwd, path), "utf8").split("\n").filter((line) => line.trim())
      .flatMap((line) => userText(JSON.parse(line)));
  } catch {
    return [];
  }
}

export async function workbuddyHostHook(event: string, input: unknown) {
  const payload = record(input);
  const cwd = (typeof payload?.cwd === "string" && payload.cwd) || process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = payload?.session_id;
  if (event === "session-start" || event === "user-prompt-submit") {
    if (typeof sessionId !== "string" || !sessionId) return null;
    const { hostContext } = await import("../../application/host-hook.js");
    const text = hostContext([cwd], { host: "workbuddy", sessionId }, guidance, "native");
    return text === null ? null : { hookSpecificOutput: {
      hookEventName: event === "session-start" ? "SessionStart" : "UserPromptSubmit", additionalContext: text,
    } };
  }
  const toolInput = record(payload?.tool_input);
  if (event !== "pre-tool-use" || payload?.tool_name !== "Bash" || typeof toolInput?.command !== "string") return null;
  const checked = await checkHostCommand(toolInput.command, () => userMessages(payload.transcript_path, cwd), {
    session: typeof sessionId === "string" && sessionId ? `KNIT_HOST=workbuddy KNIT_HOST_SESSION=${shellQuote(sessionId)}` : undefined,
  }, { rejectStartReason });
  if (checked.reason) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: checked.reason } };
  return checked.command === toolInput.command ? null : { hookSpecificOutput: {
    hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: checked.command },
  } };
}
