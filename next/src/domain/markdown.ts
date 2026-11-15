/** Markdown 的标题和章节。只处理文本，不读文件。 */

export interface Heading {
  /** 所在的行，从 0 起。 */
  readonly line: number;
  /** `#` 的个数，1–6。 */
  readonly level: number;
  readonly text: string;
}

/** 文本里的标题；写在代码围栏里的不算。 */
export function headingsOf(lines: readonly string[]): Heading[] {
  return lines.reduce(
    (state, line, index) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (state.fence !== null) {
        const closes =
          marker !== null &&
          (marker[1] ?? "").startsWith(state.fence) &&
          (marker[2] ?? "").trim() === "";
        return closes ? { fence: null, headings: state.headings } : state;
      }
      if (marker !== null) return { fence: marker[1] ?? null, headings: state.headings };
      const heading = /^(#{1,6})\s+(\S.*?)\s*$/.exec(line);
      if (heading === null) return state;
      return {
        fence: null,
        headings: [...state.headings, { line: index, level: (heading[1] ?? "").length, text: heading[2] ?? "" }],
      };
    },
    { fence: null as string | null, headings: [] as Heading[] },
  ).headings;
}

/**
 * 标题对得上 `anchor` 的那一节：从标题行到下一个同级或更高级的标题之前，末尾的空行去掉。
 * 有多个对得上的取第一个，没有时是 null。
 */
export function sectionOf(markdown: string, anchor: string): string | null {
  const lines = markdown.split("\n");
  const headings = headingsOf(lines);
  const start = headings.findIndex((heading) => anchorOf(heading.text) === anchorOf(anchor));
  const found = headings[start];
  if (found === undefined) return null;
  const next = headings.slice(start + 1).find((heading) => heading.level <= found.level);
  return lines.slice(found.line, next?.line).join("\n").trimEnd();
}

/** `5. 交接` 和 `5-交接` 转换之后相同：只留字母、数字、`-`、`_`，空白换成 `-`。 */
function anchorOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}
