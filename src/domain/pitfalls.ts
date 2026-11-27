import { WORKFLOW_STAGE_ID_PATTERN } from "../contracts/workflow.js";
import { splitFrontmatter, trimBlankLines } from "./markdown.js";
import { headingsOf } from "./task.js";

export const PITFALLS_PATH = ".knit/standards/pitfalls.md";
const stageId = new RegExp(WORKFLOW_STAGE_ID_PATTERN);

/** 空列表代表通用区。分区用流程的环节 id 命名，书写顺序不影响匹配。 */
export function pitfallScope(heading: string): string[] | null {
  if (heading.trim() === "通用") return [];
  const stages = [...new Set(heading.split(/[,，、]/).map((id) => id.trim()))];
  return stages.every((id) => stageId.test(id)) ? stages : null;
}

/** 只认二级标题。围栏里的示例，以及分区之前的说明，都不参与交接。 */
export function pitfallSections(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const headings = headingsOf(lines).filter((heading) => heading.level <= 2);
  return headings.flatMap((heading, index) => {
    if (heading.level !== 2) return [];
    const end = headings[index + 1]?.line ?? lines.length;
    const stages = pitfallScope(heading.text);
    if (!stages) return [];
    const body = trimBlankLines(lines.slice(heading.line + 1, end).join("\n"));
    return [{ heading: heading.text, stages, start: heading.line, end, body }];
  });
}

function covers(stages: readonly string[], requested: readonly string[]): boolean {
  return stages.length === 0 || (requested.length > 0 && requested.every((stage) => stages.includes(stage)));
}

export function pitfallsForStage(markdown: string, stage: string): string {
  return pitfallSections(markdown)
    .filter(({ stages, body }) => body && covers(stages, [stage]))
    .map(({ heading, body }) => `## ${heading}\n\n${body}`)
    .join("\n\n");
}

/** 在适用分区内找到同名条目时补充原文。新增条目落在用户指定的分区。 */
export function recordPitfall(original: string, scope: string, title: string, detail: string): string {
  title = title.trim();
  detail = detail.replace(/\r\n/g, "\n").trim();
  if (!title || /[\r\n]/.test(title)) throw new Error("条目标题要写成一行非空文字");
  const bodyLines = detail.split("\n");
  const headings = headingsOf([...bodyLines, "### end"]);
  if (!detail || headings.at(-1)?.line !== bodyLines.length || headings.slice(0, -1).some(({ level }) => level <= 3)) {
    throw new Error("条目正文不能为空，代码围栏要闭合，正文里的小标题从四级开始");
  }
  const stages = pitfallScope(scope);
  if (!stages) throw new Error("分区要写通用或逗号分隔的环节 id");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const markdown = original || "---\ntitle: 避坑清单\n---\n";
  const parts = splitFrontmatter(markdown);
  if (parts.opened && parts.header === null) throw new Error("开头声明没有结束：字段之后要再用一行 --- 结束");
  const lines = markdown.split(/\r?\n/);
  const headerEnd = lines.length - parts.body.split("\n").length;
  const sections = pitfallSections(parts.body).filter((section) => covers(section.stages, stages));
  const exact = sections.find((section) => section.stages.length === stages.length);
  let end = exact ? headerEnd + exact.end : lines.length;
  const sectionHeading = exact ? "" : `## ${stages.join(", ") || "通用"}\n\n`;
  let addition = `${sectionHeading}### ${title}\n\n${detail}`;
  // 优先补同一分区，其次补通用或同时适用于所请求环节的已有条目。
  for (const section of exact ? [exact, ...sections.filter((other) => other !== exact)] : sections) {
    const start = headerEnd + section.start + 1;
    const entries = headingsOf(lines.slice(start, headerEnd + section.end)).filter(({ level }) => level === 3);
    const index = entries.findIndex((heading) => heading.text === title);
    const existing = entries[index];
    if (!existing) continue;
    const next = entries[index + 1];
    end = next ? start + next.line : headerEnd + section.end;
    const saved = lines.slice(start + existing.line + 1, end).join("\n").trim();
    if (`\n${saved}\n`.includes(`\n${detail}\n`)) return original;
    addition = detail;
    break;
  }
  while (end > 0 && !lines[end - 1]?.trim()) end--;
  const insert = ["", ...addition.split("\n")];
  if (end === lines.length || lines[end]?.trim()) insert.push("");
  lines.splice(end, 0, ...insert);
  return lines.join(newline);
}
