import {
  chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { sha256Bytes, sha256Text } from "../contracts/primitives.js";

/**
 * 基础设施错误：携带稳定错误码，调用方按错误码决定怎么报告。
 * 不吞异常、不静默重试。
 */
export type InfrastructureErrorCode = "version_conflict" | "path_escape" | "io_error";

export class InfrastructureError extends Error {
  constructor(
    readonly code: InfrastructureErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InfrastructureError";
  }
}

export interface AtomicWriteRequest {
  path: string;
  data: Uint8Array;
  /** 预期当前 SHA-256；null 表示要求文件尚不存在。提供时当前内容不符即 version_conflict。 */
  expectedSha256?: string | null;
  /** 文件模式（八进制）；默认 0600 私有权限。 */
  mode?: number;
  /** 写前是否创建父目录；默认创建。 */
  createParents?: boolean;
}

function fsyncDir(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r"); // Linux 允许只读打开目录；fsyncSync 同步条目变更
    fsyncSync(fd);
  } catch {
    // 平台不支持目录 fsync 时跳过；rename 在同一目录内，文件 fsync 已保证内容完整
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * 原子写单文件。流程：读当前字节核对预期 → 写临时文件（同目录）→ fsync → rename → 目录同步。
 * 任一步失败保留原文件；rename 前新内容只出现在临时路径。
 * 预期版本不匹配抛 version_conflict，不覆盖后来内容。
 */
export function atomicWrite(request: AtomicWriteRequest): { sha256: string } {
  const target = request.path;
  const expected = request.expectedSha256;
  const currentBytes = existsSync(target) ? readFileSync(target) : null;
  const currentSha = currentBytes ? sha256Bytes(currentBytes) : null;

  if (expected === null && currentBytes !== null) {
    throw new InfrastructureError("version_conflict", `file already exists: ${target}`, { currentSha256: currentSha });
  }
  if (typeof expected === "string" && currentSha !== expected) {
    throw new InfrastructureError("version_conflict", `file changed since expected version: ${target}`, {
      expectedSha256: expected,
      currentSha256: currentSha,
    });
  }

  if (request.createParents !== false) {
    // 逐段 0700 创建：recursive:true 的中间目录 mode 在部分版本不可靠。
    let parent = dirname(target);
    const missing = [];
    while (!existsSync(parent)) {
      missing.unshift(parent);
      const up = dirname(parent);
      if (up === parent) break;
      parent = up;
    }
    for (const segment of missing) mkdirSync(segment, { recursive: false, mode: 0o700 });
  }
  const temp = `${target}.knit-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const mode = request.mode ?? 0o600;
  let tempFd: number | null = null;
  try {
    tempFd = openSync(temp, "wx", mode);
    let offset = 0;
    while (offset < request.data.length) {
      offset += writeSync(tempFd, request.data, offset, request.data.length - offset);
    }
    fsyncSync(tempFd);
  } finally {
    if (tempFd !== null) closeSync(tempFd);
  }
  try {
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // 临时文件清理失败不掩盖原始错误
    }
    throw error;
  }
  fsyncDir(dirname(target));
  return { sha256: sha256Bytes(request.data) };
}

/** 读取文件与当前指纹；不存在返回 null。调用方把指纹作为下次 expectedSha256。 */
export function readWithVersion(path: string): { data: Buffer; sha256: string } | null {
  if (!existsSync(path)) return null;
  const data = readFileSync(path);
  return { data, sha256: sha256Bytes(data) };
}

/** 跨文件系统时先复制完整内容；复制失败不动源，也不留下半份目标。 */
export function moveDirectory(source: string, target: string): void {
  try {
    renameSync(source, target);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EXDEV") throw error;
  }
  const staging = mkdtempSync(join(dirname(target), ".knit-move-"));
  try {
    cpSync(source, join(staging, "task"), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    renameSync(join(staging, "task"), target);
  } finally {
    removeCopy(staging);
  }
  try {
    rmSync(source, { recursive: true });
  } catch (error) {
    // 删除只会使文件缺失；保留尚在的只读文件，用完整目标补回缺失内容。
    cpSync(target, source, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (_source, target) => lstatSync(target, { throwIfNoEntry: false })?.isDirectory() ?? true,
    });
    removeCopy(target);
    throw error;
  }
}

/** 只清理可丢弃的副本：放开只读子目录的权限，不改变源目录或要恢复的备份。 */
export function removeCopy(path: string): void {
  if (!existsSync(path)) return;
  chmodSync(path, statSync(path).mode | 0o700);
  readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .forEach((entry) => removeCopy(join(path, entry.name)));
  rmSync(path, { recursive: true, force: true });
}

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
