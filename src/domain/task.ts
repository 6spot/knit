/**
 * 解析和渲染任务的 `task.md` 与 `record.json`，从需求文本提取相关资料与章节。
 * 需求部分是开头字段之后、`## 结果` 之前的全部内容，交给执行者的和算摘要的都是这一段。
 */
import { parseDocument, stringify } from "yaml";
import { checkSchema, schemaProblems, sha256Text } from "../contracts/primitives.js";
import {
  TaskFrontmatterSchema,
  TaskRecordSchema,
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

const taskFrontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const rawIdLine = /^id:[ \t]*([\w-]+)[ \t]*$/m;

function headerId(header: string): string | null {
  const plain = rawIdLine.exec(header)?.[1] ?? null;
  // 常规文档直接读 ID。显式键或别名键可能改变顶层 id 的值。
  if (plain !== null && !/^(?![A-Za-z][\w-]*:(?:[ \t]|$))[^ \t#\r\n]/m.test(header)) return plain;
  const { value } = readHeaderYaml(header);
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? value.id : plain;
}

export function unparsedTaskId(markdown: string): string | null {
  const header = taskFrontmatter.exec(markdown.replaceAll("\r\n", "\n"))?.[1];
  return header === undefined ? null : headerId(header);
}

export function taskDocumentMayHaveId(markdown: string, ids: ReadonlySet<string>): boolean {
  const id = unparsedTaskId(markdown);
  return id !== null && ids.has(id);
}

export function parseTaskDocument(markdown: string): TaskDocumentParse {
  const normalized = markdown.replaceAll("\r\n", "\n");
  const match = taskFrontmatter.exec(normalized);
  if (match === null) return { document: null, problems: ["没有开头字段：文件要以 --- 开头，字段之后再用一行 --- 结束"] };
  const { frontmatter, problems } = parseTaskFrontmatter(match[1] ?? "");
  if (frontmatter === null) return { document: null, problems };
  const lines = normalized.slice(match[0].length).split("\n");
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

export function taskHeaderFields(markdown: string): TaskFrontmatter | null {
  const header = taskFrontmatter.exec(markdown.replaceAll("\r\n", "\n"))?.[1];
  return header === undefined ? null : parseTaskFrontmatter(header).frontmatter;
}

function readHeaderYaml(header: string): { value: unknown; problems: string[] } {
  const yaml = parseDocument(header);
  if (yaml.errors.length) return { value: null, problems: yaml.errors.map((error) => `开头字段不是合法的 YAML：${error.message}`) };
  try {
    return { value: yaml.toJS({ maxAliasCount: 100 }), problems: [] };
  } catch (error) {
    return { value: null, problems: [`开头字段不是合法的 YAML：${error instanceof Error ? error.message : String(error)}`] };
  }
}

function parseTaskFrontmatter(header: string): {
  frontmatter: TaskFrontmatter | null;
  problems: readonly string[];
} {
  const { value: frontmatter, problems } = readHeaderYaml(header);
  if (problems.length) return { frontmatter: null, problems };
  if (!checkSchema(TaskFrontmatterSchema, frontmatter)) return { frontmatter: null, problems: schemaProblems(TaskFrontmatterSchema, frontmatter) };
  if (frontmatter.status === "active" && frontmatter.stage === null) {
    return { frontmatter: null, problems: ["字段 stage 的值不对：status 是 active 时要写所在环节的 id"] };
  }
  if (frontmatter.status !== "active" && frontmatter.stage !== null) {
    return { frontmatter: null, problems: [`字段 stage 的值不对：status 是 ${frontmatter.status} 时要写 null`] };
  }
  return { frontmatter, problems: [] };
}

function trimSection(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/** `## 结果` 所在的行；写在代码围栏里的不算。没有时是 -1。 */
function resultHeadingLine(lines: readonly string[]): number {
  return headingsOf(lines).find((heading) => lines[heading.line]?.trimEnd() === RESULT_HEADING)?.line ?? -1;
}

export type TaskRecordParse =
  | { readonly record: TaskRecord; readonly problems: readonly [] }
  | { readonly record: null; readonly problems: readonly string[] };

/** `json` 是 `null` 表示文件还不存在，得到一份空记录。 */
export function parseTaskRecord(json: string | null): TaskRecordParse {
  if (json === null) {
    return { record: { confirmedDigest: null, changedPaths: [], runs: [], authorization: null }, problems: [] };
  }
  const value = parseJson(json);
  if (value instanceof SyntaxError) return { record: null, problems: [`不是合法的 JSON：${value.message}`] };
  if (!checkSchema(TaskRecordSchema, value)) return { record: null, problems: schemaProblems(TaskRecordSchema, value) };
  return { record: { ...value, runs: value.runs.map((run) => ({ ...run, resumeId: run.resumeId ?? null })) }, problems: [] };
}

export function renderTaskRecord(record: TaskRecord): string {
  const ordered = {
    confirmedDigest: record.confirmedDigest,
    changedPaths: record.changedPaths,
    runs: record.runs.map((run) => ({
      id: run.id,
      stage: run.stage,
      agent: run.agent,
      batchId: run.batchId,
      executor: run.executor,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      verdict: run.verdict,
      failure: run.failure,
      resumeBlocked: run.resumeBlocked,
      requirementDigest: run.requirementDigest,
      changedPaths: run.changedPaths,
      sessionFile: run.sessionFile,
      resumeId: run.resumeId ?? null,
    })),
    authorization: record.authorization,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return error;
    throw error;
  }
}

export const REFERENCES_HEADING = "## 相关资料";

export interface TaskReference {
  /** 任务里写的路径，相对项目根。 */
  readonly path: string;
  /** `路径#标题` 里的标题；点名整个文件时是 null。 */
  readonly anchor: string | null;
}

/**
 * 「相关资料」一行一项：反引号里是路径，可以带 `#标题`；` — ` 之后是理由，理由里的反引号内容不算。
 * 路径和标题都相同的只留第一次出现的。
 */
export function referencesOf(requirement: string): TaskReference[] {
  const lines = requirement.split("\n");
  const headings = headingsOf(lines).filter((heading) => heading.level <= 2);
  const start = headings.findIndex((heading) => lines[heading.line]?.trimEnd() === REFERENCES_HEADING);
  const heading = headings[start];
  if (heading === undefined) return [];
  return lines
    .slice(heading.line + 1, headings[start + 1]?.line)
    .filter((line) => line.startsWith("- "))
    .flatMap((line) => [...(line.split(" — ")[0] ?? "").matchAll(/`([^`]+)`/g)])
    .map((match) => match[1] ?? "")
    .map((named) => {
      const hash = named.indexOf("#");
      return hash < 0
        ? { path: named, anchor: null }
        : { path: named.slice(0, hash), anchor: named.slice(hash + 1) || null };
    })
    .filter(
      (reference, index, all) =>
        reference.path !== "" &&
        all.findIndex((other) => other.path === reference.path && other.anchor === reference.anchor) === index,
    );
}

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
