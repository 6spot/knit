import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkHostCommand, hostContext } from "../../application/host-hook.js";
import { shellQuote } from "../../infrastructure/process.js";

const guidance = [
  "WorkBuddy 主会话通过 Bash 调用 Knit。用 knit context --use <id> 选中任务。knit run start <id> 派发后立即返回，执行者和模型由流程选择，缺省执行者为 pi。",
  "用 Bash 的 run_in_background: true 运行 knit run wait <id>，等待任务完成通知。沙箱不支持后台等待或无法自动唤醒时，可用 knit run wait <id> --timeout 60 短等，或告知用户已派发，下一轮会自动刷新选中任务的状态。",
  "若派发受到桌面沙箱的路径或网络限制，可请用户批准本次命令的沙箱豁免，或在终端继续。",
].join("\n");

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
    const text = hostContext([cwd], { host: "workbuddy", sessionId });
    return text === null ? null : { hookSpecificOutput: {
      hookEventName: event === "session-start" ? "SessionStart" : "UserPromptSubmit", additionalContext: `${text}\n\n${guidance}`,
    } };
  }
  const command = record(payload?.tool_input)?.command;
  if (event !== "pre-tool-use" || payload?.tool_name !== "Bash" || typeof command !== "string") return null;
  const checked = await checkHostCommand(command, () => userMessages(payload.transcript_path, cwd), {
    select: typeof sessionId === "string" && sessionId ? `KNIT_HOST=workbuddy KNIT_HOST_SESSION=${shellQuote(sessionId)}` : undefined,
  });
  if (checked.reason) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: checked.reason } };
  return checked.command === command ? null : { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: checked.command } } };
}
