/**
 * 路径规范化与稳定键（OPERATIONS.md 第2节）。
 * 项目根先 realpath 解析为稳定键；路径别名解析到同一根。
 * safeJoin 拒绝越界与经父级符号链接逃出项目。
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { InfrastructureError } from "./errors.js";

/** 项目根规范化：必须已存在；别名解析到同一真实路径。 */
export function normalizeRoot(path: string): string {
  return realpathSync(path);
}

/** 稳定摘要键：SHA-256 前 32 个 hex 字符；同一输入恒定，不泄漏原路径。 */
export function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * 项目内相对路径解析；拒绝绝对路径、NUL、`..` 越界，
 * 并用 realpath 核实既有父目录未通过符号链接逃出项目根。
 */
export function safeJoin(root: string, relativePath: string): string {
  if (relativePath.includes("\0")) {
    throw new InfrastructureError("path_escape", `path contains NUL: ${JSON.stringify(relativePath)}`);
  }
  if (isAbsolute(relativePath)) {
    throw new InfrastructureError("path_escape", `path is absolute: ${relativePath}`);
  }
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, relativePath);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new InfrastructureError("path_escape", `path escapes project root: ${relativePath}`);
  }
  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new InfrastructureError("path_escape", `symlink escapes project root: ${relativePath}`);
    }
    return realTarget;
  }
  // 新文件：核实最近存在祖先未逃逸，避免经父级符号链接写入项目外。
  let existing = dirname(target);
  while (!existsSync(existing) && existing !== dirname(existing)) {
    existing = dirname(existing);
  }
  const realAncestor = realpathSync(existing);
  if (!realAncestor.startsWith(realRoot + sep) && realAncestor !== realRoot) {
    throw new InfrastructureError("path_escape", `parent symlink escapes project root: ${relativePath}`);
  }
  // 重建尚未存在的相对尾段（不含符号链接：这些路径尚不存在）。
  return join(realAncestor, relative(existing, target));
}
