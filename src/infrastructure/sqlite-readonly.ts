/**
 * 真正只读的 SQLite 打开方式（诊断／GC 预览）。
 * `DatabaseSync(..., {readOnly:true})` 在 WAL 数据库上仍可能创建 -wal／-shm；
 * 无 sidecar 时用 `immutable=1` 直接读主文件；存在 WAL／journal 时复制到临时目录再读，
 * 保证被检查项目的文件条目与字节不被查询改变。
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** 在只读连接上执行回调；连接与临时副本由本函数负责关闭／清理。 */
export function withReadOnlyDatabase<T>(path: string, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(path)) throw new Error(`database missing: ${path}`);
  const suffixes = SIDECARS.filter((suffix) => existsSync(path + suffix));
  if (suffixes.length === 0) {
    const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  // 有未合并的 WAL／hot journal：在私有临时副本上读取，避免创建或改动项目 sidecar。
  const temp = mkdtempSync(join(tmpdir(), "knit-readonly-"));
  const target = join(temp, basename(path));
  try {
    copyFileSync(path, target);
    for (const suffix of suffixes) copyFileSync(path + suffix, target + suffix);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
