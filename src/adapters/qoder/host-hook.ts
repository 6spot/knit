import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkHostCommand, hostContext } from "../../application/host-hook.js";
import { shellQuote } from "../../infrastructure/process.js";

const rejectStartReason = "请使用 Qoder 自身工具与原生子 Agent 完成实现和检查。如需通过 knit run start 派发外部执行者，请在普通终端、Pi 或 Antigravity 中运行。";
const guidance = `Qoder 桌面主会话通过 Bash 使用 knit task、knit context --use、knit task close 和 knit deliver 管理任务与交付。${rejectStartReason}`;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function userText(value: unknown): string[] {
  const entry = record(value);
  if (entry?.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true ||
      entry.isVisibleInTranscriptOnly === true || entry.toolUseResult !== undefined) return [];
  if (entry.origin !== undefined && record(entry.origin)?.kind !== "human") return [];
  const mode = record(entry.humanInput)?.mode;
  if (mode !== undefined && mode !== "prompt") return [];
  const message = record(entry.message);
  if (!message || (message.role !== undefined && message.role !== "user")) return [];
  if (typeof message.content === "string") return withoutHostContext(message.content);
  if (!Array.isArray(message.content)) return [];
  const parts = message.content.map(record);
  if (parts.some((part) => part?.type === "tool_result")) return [];
  return withoutHostContext(parts.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n"));
}

function withoutHostContext(text: string): string[] {
  // 奇数段是宿主标签（包括残缺的标签）。只有成对闭合后才继续收集用户正文。
  const parts = text.split(/(<\/?(?:system-reminder|hook_context|loaded_context)\b[^<>]*>?)/i);
  const open: string[] = [];
  const visible: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 0) {
      if (!open.length) visible.push(part);
      continue;
    }
    const tag = /^<(\/?)([\w-]+)(?:\s[^<>]*)?>$/i.exec(part);
    if (!tag) return [];
    const name = tag[2]!.toLowerCase();
    if (tag[1]) {
      if (part.toLowerCase() !== `</${name}>` || open.pop() !== name) return [];
      continue;
    }
    open.push(name);
  }
  return open.length ? [] : [visible.join("")];
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

export async function qoderHostHook(event: string, input: unknown) {
  const payload = record(input);
  const cwd = (typeof payload?.cwd === "string" && payload.cwd) || process.env.QODER_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = payload?.session_id;
  if (event === "session-start" || event === "user-prompt-submit") {
    if (typeof sessionId !== "string" || !sessionId) return null;
    const text = hostContext([cwd], { host: "qoder", sessionId }, guidance);
    return text === null ? null : { hookSpecificOutput: {
      hookEventName: event === "session-start" ? "SessionStart" : "UserPromptSubmit", additionalContext: text,
    } };
  }
  const toolInput = record(payload?.tool_input);
  if (event !== "pre-tool-use" || payload?.tool_name !== "Bash" || typeof toolInput?.command !== "string") return null;
  const checked = await checkHostCommand(toolInput.command, () => userMessages(payload.transcript_path, cwd), {
    session: typeof sessionId === "string" && sessionId ? `KNIT_HOST=qoder KNIT_HOST_SESSION=${shellQuote(sessionId)}` : undefined,
  }, { rejectStartReason });
  if (checked.reason) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: checked.reason } };
  return checked.command === toolInput.command ? null : { hookSpecificOutput: {
    hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: checked.command },
  } };
}
