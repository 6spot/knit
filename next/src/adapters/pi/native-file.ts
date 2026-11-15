/**
 * 原生会话文件身份核实（只读）。
 * Pi 将原生记录保存为 JSONL，首行 {type:"session", id, cwd, ...}；
 * 恢复前先核对文件存在与身份，不能只信 CLI 对不存在路径返回成功。
 */
import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { LfFrameDecoder } from "../../contracts/frames.js";

export interface NativeSessionIdentity {
  id: string;
  cwd: string | null;
  version: string | number | null;
}

export interface NativeFileCheck {
  exists: boolean;
  identity: NativeSessionIdentity | null;
  entryCount: number;
  problem:
    | null
    | "not_a_file"
    | "empty"
    | "no_session_header"
    | "id_mismatch"
    | "unreadable";
}

function firstSessionLine(content: string): NativeSessionIdentity | null {
  const decoder = new LfFrameDecoder();
  const [first] = decoder.push(new TextEncoder().encode(content));
  if (first === undefined) return null;
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
export async function checkNativeSessionFile(
  filePath: string,
  expectedNativeId: string,
): Promise<NativeFileCheck> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return { exists: false, identity: null, entryCount: 0, problem: null };
  }
  if (!info.isFile()) {
    return { exists: true, identity: null, entryCount: 0, problem: "not_a_file" };
  }
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return { exists: true, identity: null, entryCount: 0, problem: "unreadable" };
  }
  const identity = firstSessionLine(content);
  if (identity === null) {
    return { exists: true, identity: null, entryCount: 0, problem: "empty" };
  }
  if (identity.id !== expectedNativeId) {
    return { exists: true, identity, entryCount: 0, problem: "id_mismatch" };
  }
  const entryCount = content.split("\n").filter((line) => line.trim() !== "").length;
  return { exists: true, identity, entryCount, problem: null };
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
