/**
 * `task.md`：开头字段、需求部分和结果。只处理文本，不读写文件。
 * 需求部分是开头字段之后、`## 结果` 之前的全部内容，交给执行者的和算摘要的都是这一段。
 */
import { parseDocument, stringify } from "yaml";
import { sha256Text } from "../contracts/digest.js";
import { checkSchema } from "../contracts/schema.js";
import {
  schemaProblems,
  TaskFrontmatterSchema,
  type TaskFrontmatter,
  type TaskRecord,
  type TaskStatus,
} from "../contracts/task.js";

export const RESULT_HEADING = "## 结果";

export interface TaskDocument {
  readonly frontmatter: TaskFrontmatter;
  readonly requirement: string;
  readonly result: string | null;
}

export type TaskDocumentParse =
  | { readonly document: TaskDocument; readonly problems: readonly [] }
  | { readonly document: null; readonly problems: readonly string[] };

export function parseTaskDocument(markdown: string): TaskDocumentParse {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  if (match === null) return invalid(["没有开头字段：文件要以 --- 开头，字段之后再用一行 --- 结束"]);
  const yaml = parseDocument(match[1] ?? "");
  if (yaml.errors.length > 0) return invalid(yaml.errors.map((error) => `开头字段不是合法的 YAML：${error.message}`));
  const frontmatter: unknown = yaml.toJS();
  if (!checkSchema(TaskFrontmatterSchema, frontmatter)) return invalid(schemaProblems(TaskFrontmatterSchema, frontmatter));
  if (frontmatter.status === "active" && frontmatter.stage === null) {
    return invalid(["字段 stage 的值不对：status 是 active 时要写所在环节的 id"]);
  }
  if (frontmatter.status !== "active" && frontmatter.stage !== null) {
    return invalid([`字段 stage 的值不对：status 是 ${frontmatter.status} 时要写 null`]);
  }
  const lines = markdown.slice(match[0].length).split("\n");
  const heading = resultHeadingLine(lines);
  return {
    document: {
      frontmatter,
      requirement: trimSection(lines.slice(0, heading < 0 ? lines.length : heading).join("\n")),
      result: heading < 0 ? null : trimSection(lines.slice(heading + 1).join("\n")),
    },
    problems: [],
  };
}

export function renderTaskDocument(document: TaskDocument): string {
  const source = document.frontmatter;
  const frontmatter = stringify(
    {
      id: source.id,
      title: source.title,
      status: source.status,
      stage: source.stage,
      verification: source.verification,
      parent: source.parent,
      dependsOn: source.dependsOn,
      priority: source.priority,
      createdAt: source.createdAt,
    },
    // 不按宽度折行：长标题保持在一行里。
    { lineWidth: 0 },
  );
  const result = document.result === null ? "" : `\n${RESULT_HEADING}\n\n${document.result}\n`;
  return `---\n${frontmatter}---\n\n${document.requirement}\n${result}`;
}

/** 需求部分的摘要；开头字段和结果的变化不影响它。 */
export function requirementDigest(document: TaskDocument): string {
  return sha256Text(document.requirement);
}

/** 任务现在的状态：确认之后需求被改过的任务按 draft 算，要重新确认。 */
export function currentStatus(document: TaskDocument, record: TaskRecord): TaskStatus {
  const status = document.frontmatter.status;
  if (status !== "ready" && status !== "active") return status;
  return record.confirmedDigest === requirementDigest(document) ? status : "draft";
}

function invalid(problems: readonly string[]): TaskDocumentParse {
  return { document: null, problems };
}

function trimSection(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/** `## 结果` 所在的行；写在代码围栏里的不算。没有时是 -1。 */
function resultHeadingLine(lines: readonly string[]): number {
  return lines.reduce(
    (state, line, index) => {
      if (state.heading >= 0) return state;
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (state.fence !== null) {
        const closes =
          marker !== null &&
          (marker[1] ?? "").startsWith(state.fence) &&
          (marker[2] ?? "").trim() === "";
        return closes ? { fence: null, heading: -1 } : state;
      }
      if (marker !== null) return { fence: marker[1] ?? null, heading: -1 };
      return line.trimEnd() === RESULT_HEADING ? { fence: null, heading: index } : state;
    },
    { fence: null as string | null, heading: -1 },
  ).heading;
}
