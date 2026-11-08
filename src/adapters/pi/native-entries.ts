/**
 * 原生会话文件条目定位（只读）。
 * run 只保存原生起止条目引用和本次用量；历史权威在所属客户端。
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { LfFrameDecoder } from "../../contracts/frames.js";

export interface NativeEntryScan {
  problem: null | "unreadable" | "no_session_header";
  /** 首行 session 头之后的条目 id 序列（只收 string id 条目）。 */
  entryIds: string[];
}

export async function scanNativeEntries(filePath: string): Promise<NativeEntryScan> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return { problem: "unreadable", entryIds: [] };
  }
  const decoder = new LfFrameDecoder();
  const frames = decoder.push(new TextEncoder().encode(content));
  const tail = decoder.end();
  const all = tail !== null ? [...frames, tail] : frames;
  const entryIds: string[] = [];
  let sawSession = false;
  for (const frame of all) {
    let record: unknown;
    try {
      record = JSON.parse(frame);
    } catch {
      continue; // 半行或畸形行不参与定位；权威历史仍归客户端。
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as { type?: unknown; id?: unknown };
    if (typed.type === "session") {
      sawSession = true;
      continue;
    }
    if (typeof typed.id === "string" && typed.id !== "") entryIds.push(typed.id);
  }
  if (!sawSession) return { problem: "no_session_header", entryIds: [] };
  return { problem: null, entryIds };
}

/** 当前最末条目 id；空会话或无条目返回 null。 */
export async function readLeafEntryId(filePath: string): Promise<string | null> {
  const scan = await scanNativeEntries(filePath);
  if (scan.problem !== null) return null;
  return scan.entryIds.at(-1) ?? null;
}

/**
 * 本次 run 的条目范围：从 beforeLeaf 之后的第一个条目到当前最末条目。
 * beforeLeaf 为 null 表示从会话开头；没有新条目时两端均为 null（如实）。
 */
export async function readEntryRange(
  filePath: string,
  beforeLeaf: string | null,
): Promise<{ startEntryId: string | null; leafEntryId: string | null }> {
  const scan = await scanNativeEntries(filePath);
  if (scan.problem !== null) return { startEntryId: null, leafEntryId: null };
  const ids = scan.entryIds;
  const leaf = ids.at(-1) ?? null;
  if (beforeLeaf === null) {
    return { startEntryId: ids[0] ?? null, leafEntryId: leaf };
  }
  const startIndex = ids.indexOf(beforeLeaf);
  if (startIndex === -1) {
    // 基准条目已不在文件中（截断或换文件）：范围如实不可定位。
    return { startEntryId: null, leafEntryId: leaf };
  }
  return { startEntryId: ids[startIndex + 1] ?? null, leafEntryId: leaf };
}

/** 有效路径：从叶条目沿 parentId 回溯；条目缺失父链接时该段截止。 */
export interface NativeActivePath {
  problem: null | "unreadable" | "no_session_header";
  leafId: string | null;
  /** 当前有效分支上的条目 id（含叶）。 */
  activeIds: string[];
}

/** 读取当前有效分支；树切换后旧分支条目不在 activeIds 中。 */
export async function readActiveEntryIds(filePath: string): Promise<NativeActivePath> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return { problem: "unreadable", leafId: null, activeIds: [] };
  }
  const decoder = new LfFrameDecoder();
  const frames = decoder.push(new TextEncoder().encode(content));
  const tail = decoder.end();
  const all = tail !== null ? [...frames, tail] : frames;
  const parents = new Map<string, string | null>();
  const order: string[] = [];
  let sawSession = false;
  for (const frame of all) {
    let record: unknown;
    try {
      record = JSON.parse(frame);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as { type?: unknown; id?: unknown; parentId?: unknown };
    if (typed.type === "session") {
      sawSession = true;
      continue;
    }
    if (typeof typed.id !== "string" || typed.id === "") continue;
    parents.set(typed.id, typeof typed.parentId === "string" ? typed.parentId : null);
    order.push(typed.id);
  }
  if (!sawSession) return { problem: "no_session_header", leafId: null, activeIds: [] };
  const leafId = order.at(-1) ?? null;
  const activeIds: string[] = [];
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    activeIds.push(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  activeIds.reverse();
  return { problem: null, leafId, activeIds };
}

/** 专用自定义条目（主会话选择事件）；只读，不修改原生历史。 */
export interface NativeCustomEntry {
  entryId: string;
  parentId: string | null;
  customType: string;
  data: unknown;
}

export interface NativeCustomScan {
  problem: null | "unreadable" | "no_session_header";
  entries: NativeCustomEntry[];
}

export async function readCustomEntries(filePath: string, customType: string): Promise<NativeCustomScan> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return { problem: "unreadable", entries: [] };
  }
  const decoder = new LfFrameDecoder();
  const frames = decoder.push(new TextEncoder().encode(content));
  const tail = decoder.end();
  const all = tail !== null ? [...frames, tail] : frames;
  const entries: NativeCustomEntry[] = [];
  let sawSession = false;
  for (const frame of all) {
    let record: unknown;
    try {
      record = JSON.parse(frame);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as { type?: unknown; id?: unknown; parentId?: unknown; customType?: unknown; data?: unknown };
    if (typed.type === "session") {
      sawSession = true;
      continue;
    }
    if (typed.type !== "custom" || typed.customType !== customType) continue;
    if (typeof typed.id !== "string" || typed.id === "") continue;
    entries.push({
      entryId: typed.id,
      parentId: typeof typed.parentId === "string" ? typed.parentId : null,
      customType,
      data: typed.data ?? null,
    });
  }
  if (!sawSession) return { problem: "no_session_header", entries: [] };
  return { problem: null, entries };
}

/** 条目摘要（只读历史查询）：不含消息正文，避免复制聊天库。 */
export interface NativeEntrySummary {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string | null;
}

/** 原生助手条目用量摘要：按唯一条目 ID 计，不把累计 stats 重复相加。 */
export interface NativeUsageSummary {
  assistantEntries: number;
  usageEntries: number;
  /** input 含 cacheRead/cacheWrite；output 单列。 */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimatedCostUsd: number | null;
  unknownUsageEntries: number;
  unknownCostEntries: number;
}

export interface NativeHistoryScan {
  problem: null | "unreadable" | "no_session_header";
  entries: NativeEntrySummary[];
  usage: NativeUsageSummary | null;
}

export async function readEntrySummaries(
  filePath: string,
  limit: number | null = null,
): Promise<NativeHistoryScan> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return { problem: "unreadable", entries: [], usage: null };
  }
  const decoder = new LfFrameDecoder();
  const frames = decoder.push(new TextEncoder().encode(content));
  const tail = decoder.end();
  const all = tail !== null ? [...frames, tail] : frames;
  const entries: NativeEntrySummary[] = [];
  const assistantUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }>();
  let sawSession = false;
  for (const frame of all) {
    let record: unknown;
    try {
      record = JSON.parse(frame);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as { type?: unknown; id?: unknown; parentId?: unknown; timestamp?: unknown; message?: unknown };
    if (typed.type === "session") {
      sawSession = true;
      continue;
    }
    if (typeof typed.id !== "string" || typed.id === "") continue;
    entries.push({
      id: typed.id,
      parentId: typeof typed.parentId === "string" ? typed.parentId : null,
      type: typeof typed.type === "string" ? typed.type : "unknown",
      timestamp: typeof typed.timestamp === "string" ? typed.timestamp : null,
    });
    const message = typed.message;
    if (typed.type !== "message" || typeof message !== "object" || message === null) continue;
    const m = message as { role?: unknown; usage?: unknown };
    if (m.role !== "assistant") continue;
    const usage = m.usage;
    if (typeof usage !== "object" || usage === null) {
      assistantUsage.set(typed.id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
      continue;
    }
    const u = usage as Record<string, unknown>;
    const num = (key: string): number => (typeof u[key] === "number" ? (u[key] as number) : 0);
    const cost = typeof u.cost === "object" && u.cost !== null && typeof (u.cost as { total?: unknown }).total === "number"
      ? (u.cost as { total: number }).total
      : null;
    assistantUsage.set(typed.id, {
      input: num("input") + num("cacheRead") + num("cacheWrite"),
      output: num("output"),
      cacheRead: num("cacheRead"),
      cacheWrite: num("cacheWrite"),
      cost,
    });
  }
  if (!sawSession) return { problem: "no_session_header", entries: [], usage: null };
  const limited = limit === null ? entries : entries.slice(-Math.max(limit, 0));
  const values = [...assistantUsage.values()];
  const usage: NativeUsageSummary | null = values.length === 0
    ? null
    : {
        assistantEntries: values.length,
        usageEntries: values.filter((value) => value.cost !== null || value.input + value.output + value.cacheRead + value.cacheWrite > 0).length,
        inputTokens: values.reduce((sum, value) => sum + value.input, 0),
        outputTokens: values.reduce((sum, value) => sum + value.output, 0),
        cacheReadTokens: values.reduce((sum, value) => sum + value.cacheRead, 0),
        cacheWriteTokens: values.reduce((sum, value) => sum + value.cacheWrite, 0),
        estimatedCostUsd: values.every((value) => value.cost !== null) ? values.reduce((sum, value) => sum + (value.cost ?? 0), 0) : null,
        unknownUsageEntries: values.filter((value) => value.cost === null && value.input + value.output + value.cacheRead + value.cacheWrite === 0).length,
        unknownCostEntries: values.filter((value) => value.cost === null).length,
      };
  return { problem: null, entries: limited, usage };
}

/** 改动来源归属只认的文件写入工具（Pi 内置 write／edit，参数 `path`）。 */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

export interface NativeToolWriteScan {
  problem: null | "unreadable" | "no_session_header" | "range_unknown";
  /** 工具参数中的原始路径（未解析）；失败的工具调用（toolResult.isError）不计。 */
  paths: string[];
}

/**
 * 本 run 原生会话中 write／edit 工具调用的目标路径（只读、同步）。
 * 范围为 beforeLeaf 之后的条目；beforeLeaf 为 null 表示从会话开头，已不在文件中时如实报 range_unknown。
 * bash 等其它工具的副作用不在这里，归属由调用方按“来源不明”处理。
 */
export function readToolWriteTargets(filePath: string, beforeLeaf: string | null): NativeToolWriteScan {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { problem: "unreadable", paths: [] };
  }
  const decoder = new LfFrameDecoder();
  const frames = decoder.push(new TextEncoder().encode(content));
  const tail = decoder.end();
  const all = tail !== null ? [...frames, tail] : frames;
  let sawSession = false;
  let inRange = beforeLeaf === null;
  const calls: Array<{ id: string | null; path: string }> = [];
  const failed = new Set<string>();
  for (const frame of all) {
    let record: unknown;
    try {
      record = JSON.parse(frame);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as { type?: unknown; id?: unknown; message?: unknown };
    if (typed.type === "session") {
      sawSession = true;
      continue;
    }
    if (!inRange) {
      if (typed.id === beforeLeaf) inRange = true;
      continue;
    }
    if (typed.type !== "message" || typeof typed.message !== "object" || typed.message === null) continue;
    const message = typed.message as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };
    if (message.role === "toolResult") {
      if (message.isError === true && typeof message.toolCallId === "string") failed.add(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (typeof part !== "object" || part === null) continue;
      const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall" || typeof call.name !== "string" || !FILE_WRITE_TOOLS.has(call.name)) continue;
      const args = call.arguments as { path?: unknown } | undefined;
      if (typeof args?.path !== "string" || args.path === "") continue;
      calls.push({ id: typeof call.id === "string" ? call.id : null, path: args.path });
    }
  }
  if (!sawSession) return { problem: "no_session_header", paths: [] };
  if (!inRange) return { problem: "range_unknown", paths: [] };
  const paths = calls.filter((call) => call.id === null || !failed.has(call.id)).map((call) => call.path);
  return { problem: null, paths: [...new Set(paths)] };
}
