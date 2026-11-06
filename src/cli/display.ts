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
