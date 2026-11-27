import { desktopHostHook, record, visibleText } from "../desktop-host-hook.js";

const rejectStartReason = "请使用 Qoder 自身工具与原生子 Agent 完成实现和检查。如需通过 knit run start 派发外部执行者，请在普通终端、Pi 或 Antigravity 中运行。";
const guidance = `Qoder 桌面主会话通过 Bash 使用 knit task、knit context --use、knit task close 和 knit deliver 管理任务与交付。${rejectStartReason}`;

function userText(value: unknown): string | null | undefined {
  const entry = record(value);
  if (entry?.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true ||
      entry.isVisibleInTranscriptOnly === true || entry.toolUseResult !== undefined) return;
  if (entry.origin !== undefined && record(entry.origin)?.kind !== "human") return;
  const mode = record(entry.humanInput)?.mode;
  if (mode !== undefined && mode !== "prompt") return;
  const message = record(entry.message);
  if (!message || (message.role !== undefined && message.role !== "user")) return;
  if (typeof message.content === "string") return visibleText(message.content);
  if (!Array.isArray(message.content)) return;
  const parts = message.content.map(record);
  if (parts.some((part) => part?.type === "tool_result")) return;
  return visibleText(parts.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n"));
}

export const qoderHostHook = desktopHostHook({ host: "qoder", projectDir: "QODER_PROJECT_DIR", guidance, rejectStartReason, userText });
