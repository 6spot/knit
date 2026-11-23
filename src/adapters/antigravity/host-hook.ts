import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { checkSessionTool, hostContext, hostProjectRoot } from "../../application/host-hook.js";
import type { WorkMessage } from "../../application/work-choice.js";
import { shellQuote } from "../../infrastructure/process.js";
import { object } from "./protocol.js";

function messages(path: unknown, cwd: string | undefined): WorkMessage[] {
  if (typeof path !== "string" || !path) return [];
  try {
    const rows = readFileSync(resolve(cwd ?? ".", path.replace(/^~\//, `${homedir()}/`)), "utf8").split("\n").map(object);
    return rows.flatMap<WorkMessage>((row, index) => {
      // GENERIC 结果没有调用编号，只关联紧邻的单条命令。
      if (row?.type === "GENERIC" && row.status === "DONE" && typeof row.content === "string") {
        const previous = rows[index - 1];
        const calls = previous?.type === "PLANNER_RESPONSE" ? previous.tool_calls : undefined;
        const call = Array.isArray(calls) && calls.length === 1 ? object(calls[0]) : null;
        const args = call?.name === "run_command" ? object(call.args) : null;
        const dir = typeof args?.Cwd === "string" ? args.Cwd : cwd;
        if (dir && typeof args?.CommandLine === "string" && /^rg\s+(?:-l|--files-with-matches)\s/.test(args.CommandLine)) {
          const stdout = /Command exited with code 0\.\s+Command output:\r?\n([\s\S]+)$/.exec(row.content)?.[1];
          if (stdout) return [{ role: "search", command: args.CommandLine, cwd: dir, text: stdout }];
        }
      }
      if (row?.type === "PLANNER_RESPONSE" && row.source === "MODEL" && typeof row.content === "string") return [{ role: "assistant", text: row.content } satisfies WorkMessage];
      if (row?.type !== "USER_INPUT" || typeof row.content !== "string" ||
          (row.source !== undefined && row.source !== "USER_EXPLICIT" && row.source !== "USER")) return [];
      // 原生转录在用户原话之后附加时间、设置等宿主元数据。
      const text = row.content.startsWith("<USER_REQUEST>") ? /^<USER_REQUEST>\r?\n([\s\S]*?)\r?\n<\/USER_REQUEST>(?:\r?\n|$)/.exec(row.content)?.[1] : row.content;
      return text === undefined ? [] : [{ role: "user", text }];
    });
  } catch {
    return [];
  }
}

export async function agyHostHook(event: string, input: unknown) {
  const payload = object(input);
  const sessionId = payload?.conversationId;
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : undefined;
  const workspaces = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths.filter((path): path is string => typeof path === "string" && !!path) : [];
  const dirs = cwd ? [cwd, ...workspaces] : workspaces;
  if (event === "SessionStart" || event === "PreInvocation") {
    if (typeof sessionId !== "string" || !sessionId) return {};
    const text = hostContext(dirs, { host: "agy", sessionId });
    return text === null ? {} : { injectSteps: [{ systemMessage: { systemMessage: text } }] };
  }
  if (event !== "PreToolUse") return {};
  const tool = object(payload?.toolCall);
  const args = object(tool?.args) ?? {};
  const command = tool?.name === "run_command" && typeof args.CommandLine === "string" ? args.CommandLine : undefined;
  const target = args.TargetFile ?? args.AbsolutePath ?? args.Path;
  const locations = [args.Cwd, ...dirs, typeof target === "string" ? dirname(target) : null].filter((path): path is string => typeof path === "string" && !!path);
  const root = locations.map(hostProjectRoot).find((path) => path !== null) ?? null;
  const checked = await checkSessionTool(root, typeof sessionId === "string" ? { host: "agy", sessionId } : null,
    String(tool?.name), args, command, () => messages(payload?.transcriptPath, cwd), {
    select: typeof sessionId === "string" && sessionId ? `KNIT_HOST=agy KNIT_HOST_SESSION=${shellQuote(sessionId)}` : undefined,
    start: process.env.KNIT_SESSION_AGENT === undefined ? 'KNIT_SESSION_AGENT="${KNIT_SESSION_AGENT-antigravity}"' : undefined,
  });
  if (checked.reason) return { decision: "deny", reason: checked.reason };
  return checked.command === command ? { decision: "allow" } : { decision: "allow", overwrite: { CommandLine: checked.command } };
}
