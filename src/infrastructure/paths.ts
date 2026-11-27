/**
 * 路径规范化与稳定键。
 * 项目根先 realpath 解析为稳定键；路径别名解析到同一根。
 * safeJoin 拒绝越界与经父级符号链接逃出项目。
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { InfrastructureError } from "./fs.js";

/** 项目根规范化：必须已存在；别名解析到同一真实路径。 */
export function normalizeRoot(path: string): string {
  return realpathSync(path);
}

/**
 * 任意绝对路径的规范形式：最近存在祖先按 realpath 解析，尚不存在的尾段原样拼回。
 * 用于与 Git 报告的路径（rev-parse 给的是真实路径）比较，
 * 避免 macOS `/var` → `/private/var` 这类符号链接别名被误判为不同目录。
 */
export function canonicalPath(path: string): string {
  const target = resolve(path);
  let existing = target;
  while (!existsSync(existing) && existing !== dirname(existing)) {
    existing = dirname(existing);
  }
  try {
    return join(realpathSync(existing), relative(existing, target));
  } catch {
    return target;
  }
}

/** 两个路径按规范形式是否指向同一位置（符号链接别名视为相同）。 */
export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b) || canonicalPath(a) === canonicalPath(b);
}

/** 稳定摘要键：SHA-256 前 32 个 hex 字符；同一输入恒定，不泄漏原路径。 */
export function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/** 已有路径取真实位置，缺失尾段逐级拼回。悬空链接或无法核实的目录返回 null。 */
export function resolveWithMissingTail(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    const parent = dirname(path);
    const real = parent === path ? null : resolveWithMissingTail(parent);
    if (real === null) return null;
    // 先按磁盘解析父级，再检查末段本身，避免尾随分隔符让 lstat 解引用。
    const candidate = join(real, basename(path));
    return lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink() ? null : candidate;
  }
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
  const realRoot = realpathSync.native(root);
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  const target = resolve(realRoot, relativePath);
  if (target !== realRoot && !target.startsWith(prefix)) {
    throw new InfrastructureError("path_escape", `path escapes project root: ${relativePath}`);
  }
  const realTarget = resolveWithMissingTail(target);
  if (realTarget === null || (realTarget !== realRoot && !realTarget.startsWith(prefix))) {
    throw new InfrastructureError("path_escape", `cannot resolve path within project root: ${relativePath}`);
  }
  return realTarget;
}

/**
 * 项目内的相对路径规整后的写法：用 `/` 分隔，去掉开头的 `./`。
 * 绝对路径和跑出项目根的路径返回 null。只看写法，不看文件在不在。
 */
export function projectRelative(path: string): string | null {
  if (path === "" || path.includes("\0") || isAbsolute(path)) return null;
  const normalized = posix.normalize(path);
  return normalized === ".." || normalized.startsWith("../") ? null : normalized;
}
