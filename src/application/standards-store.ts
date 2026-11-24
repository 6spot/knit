import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PITFALLS_PATH, recordPitfall } from "../domain/pitfalls.js";
import { BUILTIN_STANDARDS, STANDARDS_DIR, builtinPath, parseStandard, standardReference, type Standard } from "../domain/standards.js";
import { atomicWrite, readWithVersion } from "../infrastructure/fs.js";
import { safeJoin } from "../infrastructure/paths.js";
import { withFileLock } from "../infrastructure/process.js";

export { STANDARDS_DIR };

const builtinDirectory = new URL("../../assets/standards/", import.meta.url);

/** 内置规范来自运行中的安装包。两组各按路径排序，项目中的旧副本不参与注入。 */
export function loadStandards(root: string): Standard[] {
  const builtin = BUILTIN_STANDARDS.map((file) =>
    parseStandard(builtinPath(file), readFileSync(new URL(file, builtinDirectory), "utf8")));
  const dir = join(root, STANDARDS_DIR);
  if (!existsSync(dir)) return builtin;
  const project = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => standardReference(path) === path)
    .sort()
    .map((path) => parseStandard(path, readFileSync(join(root, path), "utf8")));
  return [...builtin, ...project];
}

/** 旧版 init 的文件保留给项目核对、迁出定制。 */
export function legacyStandardCopies(root: string): string[] {
  return BUILTIN_STANDARDS.map((name) => `${STANDARDS_DIR}/${name}`).filter((path) => existsSync(join(root, path)));
}

export function savePitfall(root: string, scope: string, title: string, detail: string): void {
  const path = safeJoin(root, PITFALLS_PATH);
  withFileLock(join(root, ".knit/.runtime/locks/pitfalls.lock"), 5000, () => {
    const current = readWithVersion(path);
    const original = current?.data.toString("utf8") ?? "";
    const standard = parseStandard(PITFALLS_PATH, original);
    if (standard.problems.length) throw new Error(standard.problems.join("\n"));
    const updated = recordPitfall(original, scope, title, detail);
    if (updated !== original) atomicWrite({ path, data: Buffer.from(updated), expectedSha256: current?.sha256 ?? null });
  }, () => { throw new Error("避坑清单正在写入，请重试"); });
}
