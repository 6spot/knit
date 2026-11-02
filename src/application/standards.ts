/**
 * 正式规范的机械事实：文件集合、内容指纹与索引引用（DESIGN.md 第8、8.2节）。
 * 候选目录不进入正式摘要；记录与候选变化不得使检查失效。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { safeJoin } from "../infrastructure/paths.js";

export const STANDARDS_DIR = ".knit/standards";
export const STANDARDS_INDEX = "index.md";
export const CANDIDATES_DIR = "candidates";

export interface FormalStandardFile {
  /** 项目相对路径（正斜杠），如 .knit/standards/code-style.md。 */
  path: string;
  /** standards/ 内相对路径。 */
  relativePath: string;
  digest: string;
  title: string | null;
}

function standardsRootOf(root: string): string {
  return safeJoin(join(root, ".knit"), "standards");
}

/** 递归收集正式规范文件（排除 candidates/），按相对路径排序。 */
export function formalStandardFiles(root: string): FormalStandardFile[] {
  const standardsRoot = standardsRootOf(root);
  const result: FormalStandardFile[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (dir === standardsRoot && entry.name === CANDIDATES_DIR) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const full = join(dir, entry.name);
        let content: string;
        try {
          if (!statSync(full).isFile()) continue;
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const relativePath = relative(standardsRoot, full).split(sep).join("/");
        result.push({
          path: `${STANDARDS_DIR}/${relativePath}`,
          relativePath,
          digest: sha256Text(content),
          title: firstHeading(content),
        });
      }
    }
  };
  walk(standardsRoot);
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function firstHeading(content: string): string | null {
  for (const line of content.split("\n")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return null;
}

/**
 * 正式规范整体摘要：路径 + 内容指纹排序拼接。
 * 目录缺失时返回空集合摘要，不把“没有规范”与“读取失败”混为一谈。
 */
export function formalStandardsDigest(root: string): string {
  const files = formalStandardFiles(root);
  return sha256Text(files.map((file) => `${file.path}\0${file.digest}`).join("\n"));
}

/**
 * 冻结输入的整体身份：任务输入区 + 正式规范。
 * 检查凭据与后续资格核对用此值；记录、草案与候选不参与（STATES.md 第8节）。
 */
export function effectiveInputsDigest(inputsDigest: string, standardsDigest: string): string {
  return sha256Text(`${inputsDigest}\0${standardsDigest}`);
}

/** 索引中引用的 standards/ 内相对路径（去 ./ 与锚点），用于核对采纳后索引是否已更新。 */
export function indexedStandardPaths(root: string): string[] {
  const indexPath = join(standardsRootOf(root), STANDARDS_INDEX);
  if (!existsSync(indexPath)) return [];
  let text: string;
  try {
    text = readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }
  const paths = new Set<string>();
  const linkPattern = /\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(text)) !== null) {
    const target = (match[1] ?? "").split("#")[0] ?? "";
    if (!target.endsWith(".md")) continue;
    if (/^[a-z]+:/i.test(target)) continue;
    const normalized = posix.normalize(target.replace(/^\.\//, ""));
    if (normalized.startsWith("..")) continue;
    paths.add(normalized);
  }
  return [...paths].sort();
}

/** 目标路径必须是 .knit/standards/ 下的正式 .md，不能指向候选目录或项目外。 */
export function normalizeTargetPath(target: string): string {
  const normalized = posix.normalize(target.replace(/^\.\//, ""));
  if (!normalized.startsWith(`${STANDARDS_DIR}/`)) {
    throw new Error(`目标规范必须位于 ${STANDARDS_DIR}/: ${target}`);
  }
  const relativePath = normalized.slice(STANDARDS_DIR.length + 1);
  if (relativePath === "" || relativePath.startsWith(`${CANDIDATES_DIR}/`) || !relativePath.endsWith(".md")) {
    throw new Error(`目标规范不能是候选或非 Markdown 文件: ${target}`);
  }
  if (relativePath.split("/").includes("..")) {
    throw new Error(`目标规范路径不得越界: ${target}`);
  }
  return normalized;
}
