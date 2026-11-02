/**
 * 文件身份与指纹（TECHNOLOGY.md 第4节）。
 * 文件字节 SHA-256 用于冲突／快照对照；摘要区分业务输入与记录由调用方决定，
 * 本模块只提供字节与结构化清单的确定性指纹。
 */
import { createHash } from "node:crypto";
import { statSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 字节指纹：sha256 hex；用于原子写预期版本与快照对照。 */
export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

export interface FileFacts {
  /** 常量 "file"；不存在时整条记为 absent。 */
  kind: "file" | "directory" | "absent";
  /** 十进制字符串，避免 JSON 数字精度差异；目录为 null。 */
  mode: string | null;
  /** 字节指纹；目录与不存在为 null。 */
  sha256: string | null;
  /** 目录为直接子项数，文件为 null；排序稳定。 */
  childCount: number | null;
}

/** 单路径事实；不存在如实 absent，不抛错。 */
export function fileFacts(path: string): FileFacts {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { kind: "absent", mode: null, sha256: null, childCount: null };
  }
  if (stats.isDirectory()) {
    return { kind: "directory", mode: null, sha256: null, childCount: readdirSync(path).length };
  }
  return { kind: "file", mode: stats.mode.toString(8), sha256: sha256Bytes(readFileSync(path)), childCount: null };
}

/**
 * 结构化清单指纹：对键值对做确定性 JSON 序列化后取 SHA-256。
 * 键顺序无关；用于 inputs/scope 摘要等由调用方构造的映射。
 */
export function digestOf(entries: Record<string, unknown>): string {
  const sorted = Object.keys(entries)
    .sort()
    .map((key) => [key, entries[key]]);
  return sha256Text(JSON.stringify(sorted));
}

/** 目录内全部常规文件的相对路径 → FileFacts；不含符号链接目标，不含 ignored 过滤（由调用方决定）。 */
export function listFiles(root: string): Record<string, FileFacts> {
  const result: Record<string, FileFacts> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        result[relative(root, full).split(sep).join("/")] = { kind: "absent", mode: null, sha256: null, childCount: null };
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        result[relative(root, full).split(sep).join("/")] = fileFacts(full);
      }
    }
  };
  walk(root);
  return result;
}
