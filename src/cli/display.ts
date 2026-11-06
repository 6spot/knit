/** 人读展示标签：任务标题、短 ID 与阶段显示名；JSON 字段语义不变。 */

/** 短 ID：类型前缀 + 前 6 位（k-8ed2d4、run-f991c4）。 */
export function shortId(id: string): string {
  const dash = id.indexOf("-");
  if (dash === -1) return id;
  return `${id.slice(0, dash + 1)}${id.slice(dash + 1, dash + 7)}`;
}

/** 人读标题上限 20 字，超出加省略号；JSON 保留全文。 */
function truncateTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : title;
}

/** 任务标签：标题优先，缺失退 slug，再缺退短 ID；有标题时短 ID 紧随其后。 */
export function taskLabel(view: {
  taskId: string;
  title?: string | null;
  taskTitle?: string | null;
  taskSlug?: string | null;
}): string {
  const title = (view.taskTitle ?? view.title ?? "").trim();
  if (title !== "") return `「${truncateTitle(title)}」${shortId(view.taskId)}`;
  if (typeof view.taskSlug === "string" && view.taskSlug !== "") return `${view.taskSlug}（${shortId(view.taskId)}）`;
  return shortId(view.taskId);
}

/** 阶段展示：显示名与 id 不同时并列，避免只看到配置 id。 */
export function stageLabel(name: string, id: string, style: "space" | "paren"): string {
  if (name === "" || name === id) return id;
  return style === "space" ? `${name} ${id}` : `${name}（${id}）`;
}

/**
 * 终端显示宽度：CJK／全角与常见 emoji 计 2，组合符计 0。
 * 只用于对齐，不参与任何业务判定。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      width += 2;
    } else if (code >= 0x300 && code <= 0x36f) {
      width += 0;
    } else {
      width += 1;
    }
  }
  return width;
}

/** 按显示宽度右侧补空格到目标列宽；已超宽时原样返回。 */
export function padDisplay(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}
