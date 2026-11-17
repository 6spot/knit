/**
 * 项目规范：`.knit/standards/` 下的 Markdown，开头声明标题和适用的环节。
 * 只处理文本，不读文件。
 */
import { basename } from "node:path";
import { parseDocument } from "yaml";

export interface Standard {
  /** 项目内的相对路径，用 `/` 分隔。 */
  readonly path: string;
  readonly title: string;
  /** 适用的环节；空数组表示不交给任何环节。 */
  readonly stages: readonly string[];
  readonly body: string;
  /** 开头声明的格式问题；有问题时 stages 是空数组，body 是全文。 */
  readonly problems: readonly string[];
}

export function parseStandard(path: string, markdown: string): Standard {
  const whole = { path, title: basename(path, ".md"), stages: [], body: trimBlankLines(markdown) };
  const match = /^---\n(?:([\s\S]*?)\n)?---(?:\n|$)/.exec(markdown);
  if (match === null) {
    const opened = /^---[ \t]*(?:\n|$)/.test(markdown);
    return { ...whole, problems: opened ? ["开头声明没有结束：字段之后要再用一行 --- 结束"] : [] };
  }
  const yaml = parseDocument(match[1] ?? "");
  if (yaml.errors.length > 0) {
    return { ...whole, problems: yaml.errors.map((error) => `开头声明不是合法的 YAML：${error.message}`) };
  }
  const fields: unknown = yaml.toJS() ?? {};
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return { ...whole, problems: ["开头声明应当是一组字段，例如 title: 开发规范"] };
  }
  const title = "title" in fields ? fields.title : undefined;
  const stages = "stages" in fields ? fields.stages : undefined;
  const titled = typeof title === "string" && title.trim() !== "";
  const problems = [
    ...(title === undefined || titled ? [] : ["字段 title 的值不对：要写一段非空的文字"]),
    ...(stages === undefined || isStageList(stages)
      ? []
      : ["字段 stages 的值不对：要写环节 id 的列表，例如 [implement, review]"]),
  ];
  return {
    path,
    title: titled ? title : whole.title,
    stages: problems.length === 0 && isStageList(stages) ? stages : [],
    body: problems.length === 0 ? trimBlankLines(markdown.slice(match[0].length)) : whole.body,
    problems,
  };
}

/** 适用某个环节的规范，按路径排序。环节可以是流程里的环节 id，也可以是固定的 discuss、deliver。 */
export function standardsForStage(standards: readonly Standard[], stage: string): Standard[] {
  return standards
    .filter((standard) => standard.stages.includes(stage))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function isStageList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((stage) => typeof stage === "string" && stage !== "");
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}
