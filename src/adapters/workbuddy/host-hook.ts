import { desktopHostHook, record, visibleText } from "../desktop-host-hook.js";

const guidance = [
  "WorkBuddy 是桌面 GUI 主会话宿主，仅通过 Bash 使用 Knit 管理任务与交付（knit task / knit context --use <id> / knit task close / knit deliver）。",
  "实现与独立检查全程使用 WorkBuddy 自身工具与原生子 Agent 完成，不调用 knit run start 派发外部 CLI（WorkBuddy 桌面沙箱会拦截外部执行者子进程；如确需外部执行者，请提示用户在普通终端、Pi 或 Antigravity 中运行 knit run start <id>）。",
].join("\n");

const rejectStartReason = "WorkBuddy 桌面端不支持派发外部 CLI 执行者（桌面沙箱会拦截外部执行者进程）。请直接使用 WorkBuddy 自身工具与原生子 Agent 完成实现和检查，再运行 knit task close 与 knit deliver；如确需外部执行者，请在普通终端、Pi 或 Antigravity 中运行 knit run start。";

function userText(value: unknown): string | undefined {
  const row = record(value);
  if (row?.type !== "message" || row.role !== "user" || hostGenerated(record(row.providerData))) return;
  const parts = typeof row.content === "string" ? [row.content] : Array.isArray(row.content) ? row.content.map(record)
    .flatMap((part) => part?.type === "input_text" && typeof part.text === "string" ? [part.text] : []) : [];
  const visible = parts.map(visibleText);
  if (visible.includes(null)) return;
  // 附件是独立文本块，一个块的残缺标签不能在下一块补全。
  const queries = visible.filter((part): part is string => part !== null && /<\/?user_query\b/i.test(part));
  if (!queries.length) return visible.join("\n");
  return queries.length === 1 ? extractQuery(queries[0]!) : undefined;
}

function extractQuery(text: string): string | undefined {
  const tags = [...text.matchAll(/<\/?user_query\b[^<>]*>?/gi)];
  const [open, close] = tags;
  if (tags.length !== 2 || open?.[0].toLowerCase() !== "<user_query>" || close?.[0].toLowerCase() !== "</user_query>") return;
  return text.slice(open.index + open[0].length, close.index).replace(/^(?:<query_source>[^<]*<\/query_source>(?:\r?\n|$))+/i, "");
}

function hostGenerated(meta: Record<string, unknown> | undefined): boolean {
  return ["isMeta", "skipRun", "isAdditionalData", "isCompactInternal", "isCompacted", "isSummary", "contentFilterNotice"]
    .some((flag) => meta?.[flag] === true) || ["goalStatus", "scheduledTaskTrigger", "hookStatus"].some((key) => meta?.[key] != null) ||
    meta?.agent === "compact" || typeof meta?.compactType === "string" || typeof record(meta?.teammateMessage)?.from === "string";
}

export const workbuddyHostHook = desktopHostHook({ host: "workbuddy", projectDir: "CODEBUDDY_PROJECT_DIR", guidance, rejectStartReason, userText });
