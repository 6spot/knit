/** 读出项目的全部规范：`.knit/standards/` 下的 Markdown，含子目录里的。 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseStandard, type Standard } from "../domain/standards.js";

export const STANDARDS_DIR = ".knit/standards";

/** 按路径排序；目录不存在时是空数组。 */
export function loadStandards(root: string): Standard[] {
  const dir = join(root, STANDARDS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort()
    .map((file) => parseStandard(`${STANDARDS_DIR}/${file}`, readFileSync(join(dir, file), "utf8")));
}
