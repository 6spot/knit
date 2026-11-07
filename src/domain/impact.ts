/**
 * 影响路径声明与重叠判定（任务 k-9cd9a63bd5c5；DESIGN §3.11）。
 *
 * 声明只来自 `plan.md` 的固定区段 `## 影响路径`，是动手前的预期，不取代运行时
 * scope 与 Git diff。纯函数：不读文件、不看时钟；无区段／空区段／无法归一化的
 * 条目都按「未知影响」处理，调度器据此让任务独占运行。
 */

export interface ImpactDeclaration {
  /** false 表示未知影响：没有 plan.md、没有区段、区段为空或含非法条目。 */
  known: boolean;
  /** 归一化后的仓库相对路径；已知时非空。 */
  paths: string[];
}

export const UNKNOWN_IMPACT: ImpactDeclaration = Object.freeze({ known: false, paths: Object.freeze([]) as unknown as string[] });

const SECTION_HEADING = /^##\s+影响路径\s*$/;
const NEXT_HEADING = /^##\s+/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * 归一化单条声明：去列表符号、反引号、首尾空白与 `./`，统一斜杠，去掉末尾 `/`。
 * 末尾 `/**`、`/*` 按目录前缀保守展开；展开后仍含 glob 元字符、绝对路径或 `..`
 * 段时返回 null（该任务按未知影响处理，不猜通配范围）。
 */
export function normalizeImpactPath(raw: string): string | null {
  let value = raw.trim();
  value = value.replace(LIST_MARKER, "").trim();
  if (value.startsWith("`") && value.endsWith("`") && value.length >= 2) value = value.slice(1, -1).trim();
  value = value.split("\\").join("/");
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/\*{1,2}$/, "");
  value = value.replace(/\/+$/, "");
  if (value === "" || value.startsWith("/") || value.includes("\0")) return null;
  if (value.split("/").some((segment) => segment === ".." || segment === "")) return null;
  // 不做复杂 glob：剩余通配符无法核实范围，按未知影响处理。
  if (/[*?[\]{}]/.test(value)) return null;
  return value;
}

/**
 * 解析 `## 影响路径` 区段。区段不存在或有内容但全部不可用时返回未知影响；
 * 区段存在且至少一条有效、但混有非法条目时也返回未知影响（不静默丢弃声明）。
 */
export function parseImpactSection(markdown: string | null): ImpactDeclaration {
  if (markdown === null) return UNKNOWN_IMPACT;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (start === -1) return UNKNOWN_IMPACT;
  const rawEntries: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (NEXT_HEADING.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // 区段内的引用／注释不算声明，但也不当作路径。
    if (trimmed.startsWith("<!--") || trimmed.startsWith(">")) continue;
    rawEntries.push(trimmed);
  }
  if (rawEntries.length === 0) return UNKNOWN_IMPACT;
  const paths: string[] = [];
  for (const raw of rawEntries) {
    const normalized = normalizeImpactPath(raw);
    if (normalized === null) return UNKNOWN_IMPACT;
    if (!paths.includes(normalized)) paths.push(normalized);
  }
  return { known: true, paths };
}

/** 按路径段判断前缀重叠：`src/a` 与 `src/a/b.ts` 重叠，`src/ab` 与 `src/a` 不重叠。 */
export function impactPathsOverlap(left: string, right: string): boolean {
  const a = left.split("/");
  const b = right.split("/");
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** 两组声明的重叠项；任一侧未知时由调用方按独占处理，不调用本函数。 */
export function overlappingImpacts(
  left: readonly string[],
  right: readonly string[],
): Array<{ left: string; right: string }> {
  const overlaps: Array<{ left: string; right: string }> = [];
  for (const a of left) {
    for (const b of right) {
      if (impactPathsOverlap(a, b)) overlaps.push({ left: a, right: b });
    }
  }
  return overlaps;
}
