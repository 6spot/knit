/**
 * 运行目录私有权限（OPERATIONS §3：目录 0700、文件 0600，或平台等价 ACL）。
 * mkdir 的 mode 不作用于已存在目录；数据库与其 sidecar 由 SQLite 直接创建，umask 可能放宽。
 * 这里提供幂等的收紧入口：对已有目录与文件也按目标权限修正；失败给出准确错误并保留资料。
 */
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { InfrastructureError } from "./errors.js";

/** 目录私有：不存在则以 0700 创建；已存在则核实并收紧到 0700。 */
export function ensurePrivateDir(path: string): void {
  try {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } else {
      chmodSync(path, 0o700);
    }
  } catch (error) {
    throw new InfrastructureError("io_error", `运行目录无法建立私有权限 0700: ${path}: ${String(error)}`, { path });
  }
}

/** 文件私有：不存在时不动（由调用方原子写 0600）；已存在且非 0600 则收紧。 */
export function enforcePrivateFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) chmodSync(path, 0o600);
  } catch (error) {
    throw new InfrastructureError("io_error", `运行文件无法收紧到 0600: ${path}: ${String(error)}`, { path });
  }
}

/** 运行根及其直接父目录链（.knit/.runtime）保持私有；已存在时逐级收紧。 */
export function ensurePrivateRuntimeRoot(runtimeRoot: string): void {
  ensurePrivateDir(runtimeRoot);
  const parent = dirname(runtimeRoot);
  if (parent.endsWith("/.knit") || parent.endsWith("\\.knit")) ensurePrivateDir(parent);
}

/** 数据库及其 WAL／SHM sidecar 全部收紧到 0600；不存在的 sidecar 跳过。 */
export function enforcePrivateDatabase(databasePath: string): void {
  enforcePrivateFile(databasePath);
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    enforcePrivateFile(sidecar);
  }
}
