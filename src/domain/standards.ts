/** 内置规范和项目规范的开头声明、正文及按环节选取。 */
import { basename } from "node:path";
import { readHeaderYaml, splitFrontmatter, trimBlankLines } from "./markdown.js";
import { PITFALLS_PATH, pitfallsForStage } from "./pitfalls.js";

export const BUILTIN_STANDARDS = ["delivery.md", "discussion.md", "task-splitting.md", "task-writing.md"] as const;
export const STANDARDS_DIR = ".knit/standards";
export const builtinPath = (file: string) => `knit:standards/${file}`;

/** 旧任务仍可点名 init 曾复制到项目里的通用规范。 */
export function standardReference(path: string): string {
  const file = BUILTIN_STANDARDS.find((name) => path === `${STANDARDS_DIR}/${name}`);
  return file === undefined ? path : builtinPath(file);
}

export interface Standard {
  /** 包内规范标识，或用 `/` 分隔的项目相对路径。 */
  readonly path: string;
  readonly title: string;
  /** 适用的环节；空数组表示不交给任何环节。 */
  readonly stages: readonly string[];
  readonly body: string;
  /** 开头声明的格式问题；有问题时 stages 是空数组，body 是全文。 */
  readonly problems: readonly string[];
}

export function parseStandard(path: string, markdown: string): Standard {
  const parts = splitFrontmatter(markdown);
  const whole = { path, title: basename(path, ".md"), stages: [], body: trimBlankLines(markdown.replaceAll("\r\n", "\n")) };
  if (parts.header === null) {
    return { ...whole, problems: parts.opened ? ["开头声明没有结束：字段之后要再用一行 --- 结束"] : [] };
  }
  const yaml = readHeaderYaml(parts.header, "开头声明");
  if (yaml.problems.length) return { ...whole, problems: yaml.problems };
  const fields = yaml.value ?? {};
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return { ...whole, problems: ["开头声明应当是一组字段，例如 title: 开发规范"] };
  }
  const title = "title" in fields ? fields.title : undefined;
  const stages = "stages" in fields ? fields.stages : undefined;
  const titled = typeof title === "string" && title.trim() !== "";
  const problems = [
    ...Object.keys(fields).filter((key) => key !== "title" && key !== "stages").map((key) => `多了字段 ${key}`),
    ...(title === undefined || titled ? [] : ["字段 title 的值不对：要写一段非空的文字"]),
    ...(stages === undefined || isStageList(stages)
      ? []
      : ["字段 stages 的值不对：要写环节 id 的列表，例如 [implement, review]"]),
  ];
  return {
    path,
    title: titled ? title.trim() : whole.title,
    stages: problems.length === 0 && isStageList(stages) ? stages : [],
    body: problems.length === 0 ? trimBlankLines(parts.body) : whole.body,
    problems,
  };
}

/** 先给内置规范，再给项目规范，各按路径排序。点名清单仍然只选适用分区。 */
export function standardsForStage(standards: readonly Standard[], stage: string, named?: ReadonlySet<string>): Standard[] {
  return standards.flatMap((standard) => {
    if (standard.problems.length) return [];
    if (standard.path === PITFALLS_PATH) {
      const body = pitfallsForStage(standard.body, stage);
      return body ? [{ ...standard, body }] : [];
    }
    return standard.stages.includes(stage) || named?.has(standard.path) ? [standard] : [];
  }).sort((left, right) => {
    const builtinFirst = Number(right.path.startsWith("knit:")) - Number(left.path.startsWith("knit:"));
    if (builtinFirst) return builtinFirst;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

function isStageList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((stage) => typeof stage === "string" && stage !== "");
}
