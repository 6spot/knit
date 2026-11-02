/**
 * 原子发布（TECHNOLOGY.md 第4节）：锁内读取预期版本、写临时、fsync、rename、fsync 目录。
 * 预期版本不匹配时停止，不用重新渲染覆盖后来输入；临时文件同目录，保证同文件系统。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Bytes } from "./fingerprint.js";
import { InfrastructureError } from "./errors.js";

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
