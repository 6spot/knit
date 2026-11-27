import { parseDocument } from "yaml";

export function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/** 保留正文的空行。opened 区分无声明和缺少闭合行。 */
export function splitFrontmatter(markdown: string, kind: "task" | "standard" = "standard") {
  const source = markdown.replaceAll("\r\n", "\n");
  // 规范允许空声明；任务必须有字段，紧接开头的第二行 --- 可以是 YAML 文档起始标记。
  const empty = kind === "standard" && /^---\n---(?:\n|$)/.exec(source);
  const match = empty || /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
  return match ? { opened: true, header: match[1] ?? "", body: source.slice(match[0].length) }
    : { opened: /^---[ \t]*(?:\n|$)/.test(source), header: null, body: source };
}

export function readHeaderYaml(header: string, label: string): { value: unknown; problems: string[] } {
  const yaml = parseDocument(header);
  if (yaml.errors.length) return { value: null, problems: yaml.errors.map((error) => `${label}不是合法的 YAML：${error.message}`) };
  try {
    return { value: yaml.toJS({ maxAliasCount: 100 }), problems: [] };
  } catch (error) {
    return { value: null, problems: [`${label}不是合法的 YAML：${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** CommonMark §4.5。返回原行号，闭合围栏只允许空格或制表符作后缀。 */
export function* linesOutsideFences(lines: readonly string[]) {
  const entries = lines.entries();
  const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  for (const entry of entries) {
    const opening = marker.exec(entry[1]);
    if (!opening || (opening[1]!.startsWith("`") && opening[2]!.includes("`"))) {
      yield entry;
      continue;
    }
    for (const [, line] of entries) {
      const closing = marker.exec(line);
      if (closing?.[1]?.startsWith(opening[1]!) && /^[ \t]*$/.test(closing[2]!)) break;
    }
  }
}
