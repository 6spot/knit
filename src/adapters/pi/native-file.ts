/**
 * 原生会话文件身份核实（只读）。
 * Pi 将原生记录保存为 JSONL，首行 {type:"session", id, cwd, ...}；
 * 恢复前先核对文件存在与身份，不能只信 CLI 对不存在路径返回成功。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NativeSessionIdentity {
  id: string;
  cwd: string | null;
  version: string | number | null;
}

export interface NativeFileCheck {
  exists: boolean;
  identity: NativeSessionIdentity | null;
  entryCount: number;
  /** 读完整个文件后，是否有上一轮交接及助手回复。 */
  hasConversation?: boolean;
  /** Pi 首轮记录的 Knit 系统提示原文，用于恢复相同的系统上下文。 */
  systemPrompt?: string;
  problem:
    | null
    | "not_a_file"
    | "empty"
    | "no_session_header"
    | "id_mismatch"
    | "invalid_entry"
    | "unreadable";
}

const inspections = new Map<string, { fingerprint: string; result: NativeFileCheck }>();

function firstSessionLine(first: string): NativeSessionIdentity | null {
  try {
    const header = JSON.parse(first) as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string" || header.id === "") {
      return null;
    }
    return {
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : null,
      version: typeof header.version === "string" || typeof header.version === "number" ? header.version : null,
    };
  } catch {
    return null;
  }
}

/** 只读检查：不打开可写会话、不触发原生追加。 */
export async function checkNativeSessionFile(filePath: string, expectedNativeId: string): Promise<NativeFileCheck> {
  return inspectNativeSessionFile(filePath, expectedNativeId);
}

export function inspectNativeSessionFile(
  filePath: string,
  expectedNativeId?: string,
): NativeFileCheck {
  let info;
  try {
    info = statSync(filePath, { bigint: true });
  } catch {
    return { exists: false, identity: null, entryCount: 0, problem: null };
  }
  if (!info.isFile()) {
    return { exists: true, identity: null, entryCount: 0, problem: "not_a_file" };
  }
  const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  const cached = inspections.get(filePath);
  const unchanged = cached?.fingerprint === fingerprint;
  const result = unchanged ? cached.result : readNativeSessionFile(filePath);
  if (!unchanged && result.problem !== "unreadable") {
    inspections.delete(filePath);
    if (inspections.size === 8) inspections.delete(inspections.keys().next().value!);
    inspections.set(filePath, { fingerprint, result });
  }
  const identity = result.identity && { ...result.identity };
  if (identity && expectedNativeId !== undefined && identity.id !== expectedNativeId) {
    return { exists: true, identity, entryCount: 0, problem: "id_mismatch" };
  }
  return { ...result, identity };
}

function readNativeSessionFile(filePath: string): NativeFileCheck {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { exists: true, identity: null, entryCount: 0, problem: "unreadable" };
  }
  const lines = content.trimEnd().split("\n");
  const identity = firstSessionLine(lines[0]!);
  if (identity === null) {
    return { exists: true, identity: null, entryCount: 0, problem: "empty" };
  }
  const history: { user?: true; assistant?: true; systemPrompt?: string } = {};
  try {
    const valid = lines.slice(1).every((line) => {
      const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; sections?: { addendum?: unknown } } } | null;
      if (entry?.type === "message") {
        const role = entry.message?.role;
        if (role === "user" || role === "assistant") history[role] = true;
        const addendum = entry.message?.sections?.addendum;
        if (role === "system" && history.systemPrompt === undefined && typeof addendum === "string") {
          history.systemPrompt = /^<addendum>\n([\s\S]*)\n<\/addendum>$/.exec(addendum)?.[1];
        }
      }
      return typeof entry?.type === "string";
    });
    if (!valid) return { exists: true, identity, entryCount: 0, problem: "invalid_entry" };
  } catch {
    return { exists: true, identity, entryCount: 0, problem: "invalid_entry" };
  }
  return { exists: true, identity, entryCount: lines.length, problem: null, hasConversation: !!(history.user && history.assistant), systemPrompt: history.systemPrompt };
}

/** 同一份 addendum 在 Pi 的原生记录中只出现一次，省略启动参数会让 Pi 清空它。 */
export function piResumeSystemPrompt(file: string, systemFile: string): string {
  const original = inspectNativeSessionFile(file).systemPrompt;
  if (original === undefined || readFileSync(systemFile, "utf8").trim() === original) return systemFile;
  const initialFile = join(dirname(file), "..", "system.md");
  try {
    if (readFileSync(initialFile, "utf8").trim() === original) return initialFile;
  } catch {
    // 单独保存的原生 JSONL 也可用，首轮执行目录可能已经清理。
  }
  return original;
}

export function verifiedPiResumeId(file: string | null, nativeId: string | null): string | null {
  if (!file || !nativeId) return null;
  const check = inspectNativeSessionFile(file, nativeId);
  return check.hasConversation ? file : null;
}

/** Pi 默认会话目录：`--<cwd 去掉首分隔符并替换分隔符>--`（与客户端一致）。 */
export function piSessionDir(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

/**
 * 稳定记录路径查找：Pi 文件名为 `<timestamp>_<sessionId>.jsonl`。
 * 只读目录；未落盘返回 null，不预造文件名冒充已存在。
 */
export function findNativeSessionFile(cwd: string, nativeSessionId: string, agentDir: string): string | null {
  const dir = piSessionDir(cwd, agentDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = `_${nativeSessionId}.jsonl`;
  const match = names.filter((name) => name.endsWith(suffix)).sort().at(-1);
  return match === undefined ? null : join(dir, match);
}

/** 在指定目录按 `<timestamp>_<id>.jsonl` 查找；只读，不预造文件名。 */
export function findSessionFileInDir(dir: string, nativeSessionId: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = `_${nativeSessionId}.jsonl`;
  const match = names.filter((name) => name.endsWith(suffix)).sort().at(-1);
  return match === undefined ? null : join(dir, match);
}

/** 阶段执行使用的稳定项目内目录。 */
export function findStageSessionFile(cwd: string, nativeSessionId: string): string | null {
  return findSessionFileInDir(join(cwd, ".knit", ".runtime", "pi-sessions"), nativeSessionId);
}

/** 主会话默认位置或阶段项目内位置的统一只读查找。 */
export function findStoredSessionFile(cwd: string, nativeSessionId: string, agentDir: string): string | null {
  return findNativeSessionFile(cwd, nativeSessionId, agentDir) ?? findStageSessionFile(cwd, nativeSessionId);
}
