/** 从环节声明生成报告规则，并核对报告结尾 json 代码块里的字段。 */
import { isReportEnum, type ReportFieldType } from "../contracts/workflow.js";
import { workflowPrompts, type WorkflowDefinition, type WorkflowStage } from "./workflow.js";

const SCALAR_WORDING = {
  string: "字符串",
  "string[]": "字符串数组",
  paths: "路径数组",
  bool: "true 或 false",
} as const;

/** 接在系统提示末尾的一段；同样的输入得到逐字相同的输出。 */
export function stageRules(workflow: WorkflowDefinition, stage: WorkflowStage): string {
  // 和结束一次执行时核对的受保护文件是同一批。
  const guarded = [
    ".knit/standards/ 下的文件",
    ".knit/workflow.yaml",
    ".knit/config.json",
    ...workflowPrompts(workflow),
  ];
  const fields = Object.entries(stage.report);
  return [
    "<rules>",
    "- 不要提交，也不要切换或新建分支。结束时 HEAD 变了，这次执行记为失败。",
    ...(stage.executors.length > 1 ? ["- 本批次的执行者共用 Worktree。请只读检查，把需要的修改写进报告，交给主会话汇总。"] : []),
    `- 不要修改这些文件，改了这次执行记为失败：${guarded.join("、")}。`,
    "- 你的最后一条消息就是这个环节的报告，会原样交给下一个环节和用户。",
    ...(fields.length === 0
      ? []
      : [
          "- 报告的结尾放一个 json 代码块，给出这些字段：",
          ...fields.map(([name, type]) => `  - ${name}：${wordingOf(type)}`),
        ]),
    "</rules>",
  ].join("\n");
}

function wordingOf(type: ReportFieldType): string {
  return isReportEnum(type) ? `${type.join("、")} 之一` : SCALAR_WORDING[type];
}

export type ReportRead =
  | { readonly fields: Record<string, unknown>; readonly problems: readonly [] }
  | { readonly fields: null; readonly problems: readonly string[] };

/**
 * `declared` 是环节的 `report`，`text` 是报告全文。
 * 没有声明字段时不读代码块；没有声明的字段原样留在 `fields` 里。
 */
export function readReport(declared: Readonly<Record<string, ReportFieldType>>, text: string): ReportRead {
  if (Object.keys(declared).length === 0) return { fields: {}, problems: [] };
  const block = lastFenceContent(text);
  const fields = block === null ? null : jsonObject(block);
  if (fields === null) return { fields: null, problems: ["报告结尾没有能解析的 json 代码块"] };
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
  if (text.trim() === "") return { outcome: null, problems: ["执行者没有给出报告"] };
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

/** 只认独占一行的闭围栏，JSON 字符串中的围栏和转义换行均保留为内容。 */
function lastFenceContent(text: string): string | null {
  let open: RegExpExecArray | undefined;
  let end: number | undefined;
  for (const marker of text.matchAll(/(?:^|\n)( {0,3})(`{3,}|~{3,})([^\n]*)/g)) {
    const [, indent, fence, info] = marker;
    if (open && end === undefined) {
      if (fence!.startsWith(open[2]!) && /^[ \t]*\r?$/.test(info!)) end = marker.index;
      continue;
    }
    if (indent || (fence![0] === "`" && info!.includes("`"))) continue;
    open = marker;
    end = undefined;
  }
  return open === undefined || end === undefined ? null : text.slice(open.index + open[0].length, end);
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
