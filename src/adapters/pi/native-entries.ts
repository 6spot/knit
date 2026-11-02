/**
 * 原生会话文件条目定位（只读）。
 * run 只保存原生起止条目引用和本次用量；历史权威在所属客户端。
 */
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

export interface NativeHistoryScan {
  problem: null | "unreadable" | "no_session_header";
  entries: NativeEntrySummary[];
}

export async function readEntrySummaries(
  filePath: string,
  limit: number | null = null,
): Promise<NativeHistoryScan> {
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
  const entries: NativeEntrySummary[] = [];
  let sawSession = false;
  for (const frame of all) {
    let record: unknown;
    try {
      record = JSON.parse(frame);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const typed = record as { type?: unknown; id?: unknown; parentId?: unknown; timestamp?: unknown };
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
  }
  if (!sawSession) return { problem: "no_session_header", entries: [] };
  const limited = limit === null ? entries : entries.slice(-Math.max(limit, 0));
  return { problem: null, entries: limited };
}
