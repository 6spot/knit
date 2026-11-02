/**
 * 文件身份与指纹（TECHNOLOGY.md 第4节）。
 * 文件字节 SHA-256 用于冲突／快照对照；摘要区分业务输入与记录由调用方决定，
 * 本模块只提供字节与结构化清单的确定性指纹。
 * 纯摘要函数在 contracts/digest.ts（无 IO）；这里复用并保持原导出面。
 */
import { lstatSync, readlinkSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sha256Bytes, sha256Text } from "../contracts/digest.js";

export { sha256Bytes, sha256Text } from "../contracts/digest.js";

export interface FileFacts {
  /** 常量 "file"；不存在时整条记为 absent；符号链接记 link，不追踪目标。 */
  kind: "file" | "directory" | "link" | "absent";
  /** 八进制字符串，符号链接为目标字符串（DESIGN §5.3）；目录为 null。 */
  mode: string | null;
  /** 字节指纹；目录、链接与不存在为 null。 */
  sha256: string | null;
  /** 目录为直接子项数，文件为 null；排序稳定。 */
  childCount: number | null;
}

/** 单路径事实；不存在如实 absent，不抛错。符号链接按 lstat 识别为 link，不追踪目标。 */
export function fileFacts(path: string): FileFacts {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { kind: "absent", mode: null, sha256: null, childCount: null };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "link", mode: readlinkSync(path), sha256: null, childCount: null };
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

/** 目录内全部常规文件的相对路径 → FileFacts；符号链接按目标字符串记 link，不含 ignored 过滤（由调用方决定）。 */
export function listFiles(root: string): Record<string, FileFacts> {
  const result: Record<string, FileFacts> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // 符号链接按目标字符串记 link（DESIGN §5.3），不展开目标子树。
        result[relative(root, full).split(sep).join("/")] = {
          kind: "link",
          mode: readlinkSync(full),
          sha256: null,
          childCount: null,
        };
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
