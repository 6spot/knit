import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hostProjectRoot } from "../application/project-root.js";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function visibleText(text: string): string | null {
  const parts = text.split(/(<\/?(?:system-reminder|hook_context|loaded_context)\b[^<>]*>?)/i);
  const open: string[] = [];
  const visible: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 0) {
      if (!open.length) visible.push(part);
      continue;
    }
    const tag = /^<(\/?)([\w-]+)(?:\s[^<>]*)?>$/i.exec(part);
    if (!tag) return null;
    const name = tag[2]!.toLowerCase();
    if (tag[1]) {
      if (part.toLowerCase() !== `</${name}>` || open.pop() !== name) return null;
      continue;
    }
    open.push(name);
  }
  return open.length ? null : visible.join("");
}

interface DesktopHost {
  host: string;
  projectDir: string;
  guidance: string;
  rejectStartReason: string;
  userText(row: unknown): string | null | undefined;
}

function userMessages(path: unknown, cwd: string, host: DesktopHost): string[] {
  if (typeof path !== "string" || !path) return [];
  const file = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
  try {
    return readFileSync(file, "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return host.userText(JSON.parse(line)) ?? [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function desktopHostHook(host: DesktopHost) {
  return async (event: string, input: unknown) => {
    const payload = record(input);
    const cwd = (typeof payload?.cwd === "string" && payload.cwd) || process.env[host.projectDir] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionId = payload?.session_id;
    if (event === "session-start" || event === "user-prompt-submit") {
      if (typeof sessionId !== "string" || !sessionId) return null;
      const root = hostProjectRoot(cwd);
      if (root === null) return null;
      const { hostContext } = await import("../application/host-hook.js");
      const text = hostContext(root, { host: host.host, sessionId }, host.guidance, "native");
      return text === null ? null : { hookSpecificOutput: {
        hookEventName: event === "session-start" ? "SessionStart" : "UserPromptSubmit", additionalContext: text,
      } };
    }
    const toolInput = record(payload?.tool_input);
    if (event !== "pre-tool-use" || payload?.tool_name !== "Bash" || typeof toolInput?.command !== "string") return null;
    const { checkHostCommand } = await import("../application/host-command.js");
    const { shellQuote } = await import("../infrastructure/process.js");
    const checked = await checkHostCommand(toolInput.command, () => userMessages(payload.transcript_path, cwd, host), {
      session: typeof sessionId === "string" && sessionId ? `KNIT_HOST=${host.host} KNIT_HOST_SESSION=${shellQuote(sessionId)}` : undefined,
    }, { rejectStartReason: host.rejectStartReason });
    if (checked.reason) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: checked.reason } };
    return checked.command === toolInput.command ? null : { hookSpecificOutput: {
      hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: checked.command },
    } };
  };
}
