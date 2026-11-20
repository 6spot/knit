import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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
