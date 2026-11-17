/** 任务在「相关资料」里点名的文件和章节。只处理文本，不读文件。 */
import { headingsOf } from "./markdown.js";

export const REFERENCES_HEADING = "## 相关资料";

export interface TaskReference {
  /** 任务里写的路径，相对项目根。 */
  readonly path: string;
  /** `路径#标题` 里的标题；点名整个文件时是 null。 */
  readonly anchor: string | null;
}

/**
 * 「相关资料」一行一项：反引号里是路径，可以带 `#标题`；` — ` 之后是理由，理由里的反引号内容不算。
 * 路径和标题都相同的只留第一次出现的。
 */
export function referencesOf(requirement: string): TaskReference[] {
  const lines = requirement.split("\n");
  const headings = headingsOf(lines).filter((heading) => heading.level <= 2);
  const start = headings.findIndex((heading) => lines[heading.line]?.trimEnd() === REFERENCES_HEADING);
  const heading = headings[start];
  if (heading === undefined) return [];
  return lines
    .slice(heading.line + 1, headings[start + 1]?.line)
    .filter((line) => line.startsWith("- "))
    .flatMap((line) => [...(line.split(" — ")[0] ?? "").matchAll(/`([^`]+)`/g)])
    .map((match) => match[1] ?? "")
    .map((named) => {
      const hash = named.indexOf("#");
      return hash < 0
        ? { path: named, anchor: null }
        : { path: named.slice(0, hash), anchor: named.slice(hash + 1) || null };
    })
    .filter(
      (reference, index, all) =>
        reference.path !== "" &&
        all.findIndex((other) => other.path === reference.path && other.anchor === reference.anchor) === index,
    );
}
