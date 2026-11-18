/** 读出报告结尾 json 代码块里的字段：环节在流程里声明了哪些，就核对哪些。只处理文本。 */
import { isReportEnum, type ReportFieldType } from "../contracts/workflow.js";

export type ReportRead =
  | { readonly fields: Record<string, unknown>; readonly problems: readonly [] }
  | { readonly fields: null; readonly problems: readonly string[] };

/**
 * `declared` 是环节的 `report`，`text` 是报告全文。
 * 没有声明字段时不读代码块；没有声明的字段原样留在 `fields` 里。
 */
export function readReport(declared: Readonly<Record<string, ReportFieldType>>, text: string): ReportRead {
  if (Object.keys(declared).length === 0) return { fields: {}, problems: [] };
  const fields = fenceCandidates(text).map(jsonObject).findLast((value) => value !== null);
  if (fields === undefined || fields === null) return { fields: null, problems: ["报告结尾没有能解析的 json 代码块"] };
  const problems = Object.entries(declared).flatMap(([name, type]) => fieldProblem(name, type, fields) ?? []);
  return problems.length > 0 ? { fields: null, problems } : { fields, problems: [] };
}

/** 一次执行的结果：结论（环节不要结论时是 null）或者失败原因。 */
export interface ReportOutcome {
  readonly verdict: string | null;
  readonly failure: string | null;
}

/**
 * 执行者做完一轮之后，从它的最后一条消息得出结果。
 * `outcome` 是 null 表示报告读不出来，`problems` 里是原因，可以要求补报。
 */
export function reportOutcome(
  declared: Readonly<Record<string, ReportFieldType>>,
  text: string,
): { readonly outcome: ReportOutcome | null; readonly problems: readonly string[] } {
  if (text.trim() === "") return { outcome: { verdict: null, failure: "执行者没有给出报告" }, problems: [] };
  const read = readReport(declared, text);
  if (read.fields === null) return { outcome: null, problems: read.problems };
  const verdict = typeof read.fields.verdict === "string" ? read.fields.verdict : null;
  return { outcome: { verdict, failure: null }, problems: [] };
}

/** 模型请求出错、Pi 自己重试之后仍然失败时的结果；`reason` 是模型服务给的原因。 */
export function modelFailure(reason: string | undefined): ReportOutcome {
  return { verdict: null, failure: `执行者出错：${reason?.trim() || "没有给出原因"}` };
}

/** 报告读不出来时发给执行者的消息：在同一个会话里补报一次，不重做。 */
export function reportRetryMessage(problems: readonly string[]): string {
  return [
    "上一条消息里的报告读不出来：",
    ...problems.map((problem) => `- ${problem}`),
    "请只重新输出完整的报告，结尾带上 json 代码块。不要修改文件，不要重新做一遍。",
  ].join("\n");
}

/**
 * 可能是代码块内容的片段：每个标记和它后面相邻的标记、最后一个标记各配一次。
 * JSON 的字符串值里带着 ``` 时，相邻配对会断在中间，要靠和最后一个标记的配对取出来；
 * 片段是不是报告由调用方解析之后判断。开头那一行剩下的部分是语言标注，不算内容。
 */
function fenceCandidates(text: string): string[] {
  const markers = [...text.matchAll(/```/g)].map((match) => match.index);
  return markers.flatMap((open, index) => {
    const lineEnd = text.indexOf("\n", open);
    const start = lineEnd === -1 ? open + 3 : lineEnd + 1;
    return [markers[index + 1], markers.at(-1)]
      .filter((close) => close !== undefined && close > open)
      .map((close) => text.slice(start, close).trim());
  });
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function fieldProblem(name: string, type: ReportFieldType, fields: Record<string, unknown>): string | null {
  if (!Object.hasOwn(fields, name)) return `报告缺少字段 ${name}`;
  const value = fields[name];
  const strings = Array.isArray(value) && value.every((item) => typeof item === "string");
  if (isReportEnum(type)) {
    return typeof value === "string" && type.includes(value) ? null : `报告的字段 ${name} 只能是 ${type.join("、")}`;
  }
  if (type === "string") return typeof value === "string" ? null : `报告的字段 ${name} 应当是字符串`;
  if (type === "string[]") return strings ? null : `报告的字段 ${name} 应当是字符串数组`;
  if (type === "paths") return strings && value.every((item) => item !== "") ? null : `报告的字段 ${name} 应当是路径数组`;
  return typeof value === "boolean" ? null : `报告的字段 ${name} 应当是 true 或 false`;
}
