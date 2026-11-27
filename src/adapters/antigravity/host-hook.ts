import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hostProjectRoot } from "../../application/project-root.js";
import { object } from "./protocol.js";

function userMessages(path: unknown, cwd: string | undefined): string[] {
  if (typeof path !== "string" || !path) return [];
  try {
    return readFileSync(resolve(cwd ?? ".", path.replace(/^~\//, `${homedir()}/`)), "utf8").split("\n").flatMap((line) => {
      const row = object(line);
      if (row?.type !== "USER_INPUT" || typeof row.content !== "string" ||
          (row.source !== undefined && row.source !== "USER_EXPLICIT" && row.source !== "USER")) return [];
      // 原生转录在用户原话之后附加时间、设置等宿主元数据。
      if (row.content.startsWith("<USER_REQUEST>")) return /^<USER_REQUEST>\r?\n([\s\S]*?)\r?\n<\/USER_REQUEST>(?:\r?\n|$)/.exec(row.content)?.[1] ?? [];
      return row.content;
    });
  } catch {
    return [];
  }
}

export async function agyHostHook(event: string, input: unknown) {
  const payload = object(input);
  const sessionId = payload?.conversationId;
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : undefined;
  if (event === "SessionStart" || event === "PreInvocation") {
    if (typeof sessionId !== "string" || !sessionId) return {};
    const workspaces = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths.filter((path): path is string => typeof path === "string" && !!path) : [];
    const root = hostProjectRoot(...(cwd ? [cwd, ...workspaces] : workspaces));
    if (root === null) return {};
    const { hostContext } = await import("../../application/host-hook.js");
    const text = hostContext(root, { host: "agy", sessionId });
    return text === null ? {} : { injectSteps: [{ systemMessage: { systemMessage: text } }] };
  }
  if (event !== "PreToolUse") return {};
  const tool = object(payload?.toolCall);
  const command = object(tool?.args)?.CommandLine;
  if (tool?.name !== "run_command" || typeof command !== "string") return { decision: "allow" };
  const defaultAgent = !process.env.KNIT_SESSION_AGENT ? 'KNIT_SESSION_AGENT="${KNIT_SESSION_AGENT:-antigravity}"' : undefined;
  const { checkHostCommand } = await import("../../application/host-command.js");
  const { shellQuote } = await import("../../infrastructure/process.js");
  const checked = await checkHostCommand(command, () => userMessages(payload?.transcriptPath, cwd), {
    session: typeof sessionId === "string" && sessionId ? `KNIT_HOST=agy KNIT_HOST_SESSION=${shellQuote(sessionId)}` : undefined,
    start: defaultAgent,
    validateEnv: defaultAgent,
  });
  if (checked.reason) return { decision: "deny", reason: checked.reason };
  return checked.command === command ? { decision: "allow" } : { decision: "allow", overwrite: { CommandLine: checked.command } };
}
