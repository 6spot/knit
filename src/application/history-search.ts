/**
 * 按用户查询意愿检索任务历史与证据（DESIGN §12）。
 * 只读：读取当前／归档任务资料、run 记录与 Git 提交，不建索引、不写缓存、不改任务或 Git 状态。
 * 入口只由显式 `knit task search`／`knit_task action=search` 调用；会话初始化、任务切换与状态查询不自动触发。
 * 查询词按 AND 语义（全部出现）匹配文件或提交；单个文件／提交返回一条可核对来源的命中。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GuardError } from "./guard-error.js";
import { parseTaskDocument } from "./task-document.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { gitSync } from "../infrastructure/process.js";

export type HistorySearchScope = "task" | "archive" | "run" | "git";

export const HISTORY_SEARCH_SCOPES: readonly HistorySearchScope[] = ["task", "archive", "run", "git"];

export interface HistorySearchHit {
  kind: HistorySearchScope;
  /** 活动／归档任务命中时的稳定任务 ID；run 记录尽量从 request／result／state 读取；Git 为 null。 */
  taskId: string | null;
  /** 项目相对路径；Git 命中固定为 "git"。 */
  path: string;
  /** 1 起的行号；Git 命中为提交说明中的匹配行，无法定位时为 null。 */
  line: number | null;
  /** 去空白并截断的单行片段。 */
  snippet: string;
  /** path:line、run:<id> 或 commit:<sha>。 */
  ref: string;
}

export interface HistorySearchInput {
  dir: string;
  query: string | readonly string[];
  /** 缺省检索全部范围；可传单个范围或范围列表。 */
  scope?: HistorySearchScope | readonly HistorySearchScope[] | null;
  /** 默认 20，上限 100；超过上限按 100 处理。 */
  limit?: number | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIPPET_LIMIT = 240;
const RUN_ID_PATTERN = /^run-[0-9a-f]{12}$/;
const TASK_ID_PATTERN = /^k-[0-9a-f]{12}$/;

/** 执行一次只读历史检索；无匹配返回空数组，目录／Git 不可用不冒充命中。 */
export function searchHistory(input: HistorySearchInput): HistorySearchHit[] {
  const root = normalizeRoot(input.dir);
  const terms = normalizeQuery(input.query);
  const scopes = normalizeScopes(input.scope);
  const limit = normalizeLimit(input.limit);
  const hits: HistorySearchHit[] = [];

  for (const scope of scopes) {
    if (hits.length >= limit) break;
    switch (scope) {
      case "task":
        collectTaskHits(root, false, terms, limit, hits);
        break;
      case "archive":
        collectTaskHits(root, true, terms, limit, hits);
        break;
      case "run":
        collectRunHits(root, terms, limit, hits);
        break;
      case "git":
        collectGitHits(root, terms, limit, hits);
        break;
    }
  }
  return hits;
}

function normalizeQuery(query: string | readonly string[]): string[] {
  const raw = Array.isArray(query) ? query : [query];
  const terms = raw
    .flatMap((value) => String(value).split(/\s+/))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (terms.length === 0) throw new GuardError("invalid_request", "task search 需要至少一个查询词");
  if (terms.some((term) => term.includes("\0"))) throw new GuardError("invalid_request", "查询词不能包含 NUL");
  return [...new Set(terms)];
}

function normalizeScopes(scope: HistorySearchInput["scope"]): HistorySearchScope[] {
  if (scope === undefined || scope === null) return [...HISTORY_SEARCH_SCOPES];
  const raw = (Array.isArray(scope) ? scope : [scope])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (raw.length === 0) throw new GuardError("invalid_request", "task search 需要有效检索范围");
  const requested = new Set<HistorySearchScope>();
  for (const value of raw) {
    if (!HISTORY_SEARCH_SCOPES.includes(value as HistorySearchScope)) {
      throw new GuardError("invalid_request", `未知检索范围 "${value}"（task、archive、run、git）`);
    }
    requested.add(value as HistorySearchScope);
  }
  // 固定按文档顺序输出，便于重复执行与比较。
  return HISTORY_SEARCH_SCOPES.filter((value) => requested.has(value));
}

function normalizeLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new GuardError("invalid_request", "task search 的 limit 必须为正整数");
  return Math.min(limit, MAX_LIMIT);
}

function collectTaskHits(
  root: string,
  archived: boolean,
  terms: readonly string[],
  limit: number,
  hits: HistorySearchHit[],
): void {
  for (const directory of archived ? archivedTaskDirectories(root) : activeTaskDirectories(root)) {
    if (hits.length >= limit) return;
    const files = taskFiles(root, directory);
    if (files.length === 0) continue;
    const taskFile = files.find((file) => file.endsWith("/task.md"));
    const taskId = taskFile === undefined ? null : taskIdFromFile(join(root, taskFile));
    for (const path of files) {
      if (hits.length >= limit) return;
      const hit = searchTextFile(root, path, terms, taskId, archived ? "archive" : "task");
      if (hit !== null) hits.push(hit);
    }
  }
}

function activeTaskDirectories(root: string): string[] {
  const tasksRoot = join(root, ".knit", "tasks");
  let entries;
  try {
    entries = readdirSync(tasksRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .map((entry) => `.knit/tasks/${entry.name}`)
    .filter((directory) => isFile(join(root, directory, "task.md")))
    .sort();
}

function archivedTaskDirectories(root: string): string[] {
  const archiveRoot = join(root, ".knit", "tasks", "archive");
  const result: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "task.md")) {
      result.push(directory);
      return;
    }
    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      walk(`${directory}/${entry.name}`);
    }
  };
  if (existsSync(archiveRoot)) walk(".knit/tasks/archive");
  return result.sort();
}

function taskFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  for (const name of ["task.md", "plan.md", "design.md"]) {
    const path = `${directory}/${name}`;
    if (isFile(join(root, path))) files.push(path);
  }
  const research = `${directory}/research`;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, current), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  };
  if (existsSync(join(root, research))) walk(research);
  return files;
}

function taskIdFromFile(path: string): string | null {
  const text = readTextFile(path);
  if (text === null) return null;
  try {
    return parseTaskDocument(text, path).frontmatter.id;
  } catch {
    // 归档或外部改写导致的损坏文档仍可检索；只从 frontmatter 取稳定 ID，不据此修复。
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (frontmatter === null) return null;
    return /^id:\s*(k-[0-9a-f]{12})\s*$/m.exec(frontmatter[1] ?? "")?.[1] ?? null;
  }
}

function collectRunHits(root: string, terms: readonly string[], limit: number, hits: HistorySearchHit[]): void {
  const seen = new Set<string>();
  for (const runRoot of [".knit/.runtime/runs", ".knit/runs"]) {
    const absoluteRoot = join(root, runRoot);
    if (!existsSync(absoluteRoot)) continue;
    let entries;
    try {
      entries = readdirSync(absoluteRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((item) => item.isDirectory() && RUN_ID_PATTERN.test(item.name)).sort((left, right) => left.name.localeCompare(right.name))) {
      if (hits.length >= limit) return;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const directory = `${runRoot}/${entry.name}`;
      const taskId = runTaskId(root, directory);
      for (const path of runFiles(root, directory)) {
        if (hits.length >= limit) return;
        const hit = searchTextFile(root, path, terms, taskId, "run", `run:${entry.name}`);
        if (hit !== null) hits.push(hit);
      }
    }
  }
}

function runFiles(root: string, directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isRunEvidenceFile(entry.name))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

function isRunEvidenceFile(name: string): boolean {
  // 不读取 snapshot/（实施对照副本）与 claim（占用凭据），只检索摘要、报告、决策与事件文本。
  return /\.(json|jsonl|md|txt|log)$/i.test(name);
}

function runTaskId(root: string, directory: string): string | null {
  for (const name of ["request.json", "result.json", "state.json", "inputs.json"]) {
    const text = readTextFile(join(root, directory, name));
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text) as { taskId?: unknown };
      if (typeof parsed.taskId === "string" && TASK_ID_PATTERN.test(parsed.taskId)) return parsed.taskId;
    } catch {
      // run 证据损坏时仍可检索其文本，不据此推断任务身份。
    }
  }
  return null;
}

function collectGitHits(root: string, terms: readonly string[], limit: number, hits: HistorySearchHit[]): void {
  const args = [
    "log",
    "--all",
    "--no-color",
    "--encoding=UTF-8",
    "--fixed-strings",
    "--regexp-ignore-case",
    "--all-match",
    ...terms.map((term) => `--grep=${term}`),
    `--max-count=${limit}`,
    "--format=%H%x00%B%x00",
  ];
  const result = gitSync(args, root);
  if (result.code !== 0) return;
  const parts = result.stdout.split("\0");
  for (let index = 0; index + 1 < parts.length && hits.length < limit; index += 2) {
    const sha = (parts[index] ?? "").trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const body = parts[index + 1] ?? "";
    const line = matchingLine(body, terms);
    const hit = historyHit("git", null, "git", line, `commit:${sha}`);
    if (hit !== null) hits.push(hit);
  }
}

function searchTextFile(
  root: string,
  path: string,
  terms: readonly string[],
  taskId: string | null,
  kind: HistorySearchScope,
  ref?: string,
): HistorySearchHit | null {
  const text = readTextFile(join(root, path));
  if (text === null) return null;
  const line = matchingLine(text, terms);
  return line === null ? null : historyHit(kind, taskId, path, line, ref ?? `${path}:${line.number}`);
}

/** 文件级 AND：全部查询词都出现才命中；优先选包含全部词的行，否则选首个包含任一词的行。 */
function matchingLine(text: string, terms: readonly string[]): { number: number; text: string } | null {
  const loweredTerms = terms.map((term) => term.toLocaleLowerCase());
  const lowered = text.toLocaleLowerCase();
  if (!loweredTerms.every((term) => lowered.includes(term))) return null;
  const lines = text.split(/\r?\n/);
  const firstAll = lines.findIndex((line) => loweredTerms.every((term) => line.toLocaleLowerCase().includes(term)));
  const index = firstAll >= 0
    ? firstAll
    : lines.findIndex((line) => loweredTerms.some((term) => line.toLocaleLowerCase().includes(term)));
  if (index < 0) return null;
  return { number: index + 1, text: lines[index] ?? "" };
}

function historyHit(
  kind: HistorySearchScope,
  taskId: string | null,
  path: string,
  line: { number: number; text: string } | null,
  ref: string,
): HistorySearchHit | null {
  if (line === null) return null;
  const snippet = clip(line.text.replace(/\s+/g, " ").trim());
  if (snippet === "") return null;
  return { kind, taskId, path, line: line.number, snippet, ref };
}

function clip(text: string): string {
  return text.length <= SNIPPET_LIMIT ? text : `${text.slice(0, SNIPPET_LIMIT - 1)}…`;
}

function readTextFile(path: string): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    const data = readFileSync(path);
    if (data.includes(0)) return null;
    return data.toString("utf8");
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

