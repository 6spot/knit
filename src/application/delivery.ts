/**
 * 交付／归档的确定性基础（DESIGN.md 第10节、OPERATIONS.md 第4.1节）。
 * 只使用真实 Git 与文件系统事实；不 stash、不 reset、不改写历史。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync } from "../infrastructure/process.js";
import { GuardError } from "./guard-error.js";
import { porcelainStatusPaths } from "./git-status.js";
import type { AuthorizationSource, DefaultBranch } from "../contracts/delivery.js";
import type { ProjectConfig } from "./config.js";

export type GitResult = { code: number; stdout: string; stderr: string };
export type GitRunner = (args: string[], cwd: string) => GitResult;

export function runGit(root: string, args: string[], git: GitRunner = gitSync): GitResult {
  return git(args, root);
}

export function gitOrThrow(root: string, args: string[], action: string, git: GitRunner = gitSync): string {
  const result = runGit(root, args, git);
  if (result.code !== 0) {
    throw new GuardError("git_failed", `${action}失败: ${result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")}`}`);
  }
  return result.stdout.trim();
}

export function isFullBranch(ref: string): boolean {
  return /^refs\/heads\/[^\s]+$/.test(ref);
}

export function currentBranch(root: string, git: GitRunner = gitSync): string | null {
  const result = runGit(root, ["symbolic-ref", "-q", "HEAD"], git);
  return result.code === 0 ? result.stdout.trim() : null;
}

export function branchExists(root: string, ref: string, git: GitRunner = gitSync): boolean {
  return runGit(root, ["show-ref", "--verify", "--quiet", ref], git).code === 0;
}

/** 默认分支候选：配置完整 ref → 本地 origin/HEAD → unknown；只观察，不授权。 */
export function defaultBranchCandidate(root: string, config: ProjectConfig, git: GitRunner = gitSync): DefaultBranch {
  const configured = config.delivery.defaultBranch;
  if (configured !== undefined) {
    return { ref: configured, source: "config", exists: branchExists(root, configured, git) };
  }
  const symbolic = runGit(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], git);
  if (symbolic.code === 0) {
    const remote = symbolic.stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (remote.startsWith(prefix)) {
      const ref = `refs/heads/${remote.slice(prefix.length)}`;
      return { ref, source: "origin_head", exists: branchExists(root, ref, git) };
    }
  }
  return { ref: null, source: "unknown", exists: false };
}

function workflowSection(text: string, wanted: string | null): { heading: string; body: string } | null {
  const lines = text.split(/\r?\n/);
  const starts: Array<{ index: number; heading: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (match !== null) starts.push({ index, heading: match[1] ?? "" });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const end = starts[i + 1]?.index ?? lines.length;
    const matches = wanted === null ? /交付|授权/.test(start.heading) : start.heading.includes(wanted);
    if (matches) return { heading: start.heading, body: lines.slice(start.index, end).join("\n").trimEnd() };
  }
  return null;
}

/**
 * 授权来源定位。项目策略来源核实文件、章节与摘要；user_reference 只保存调用声明，
 * 不冒充已验证的人类授权（语义判断仍归主 Agent）。
 * 缺省来源为 AGENTS.md：主会话规则与交付约定在受管入口中维护；
 * 调用方可显式给出任意项目相对文件与章节。
 */
export function resolveAuthorization(root: string, ref: string | null, caller: "cli" | "agent"): AuthorizationSource {
  if (ref === null || ref.trim() === "") {
    if (caller === "agent") throw new GuardError("authorization_required", "Agent 代调交付必须声明 authorizationRef");
    return { kind: "explicit_call", ref: null, path: null, section: null, digest: null, verified: false };
  }
  const value = ref.trim();
  if (value.startsWith("user:") || value.startsWith("native:") || value.startsWith("message:")) {
    return { kind: "user_reference", ref: value, path: null, section: null, digest: null, verified: false };
  }
  let path = "AGENTS.md";
  let wanted: string | null = null;
  if (value.startsWith("workflow:")) {
    const rest = value.slice("workflow:".length);
    const hash = rest.indexOf("#");
    if (hash >= 0) {
      path = rest.slice(0, hash) || path;
      wanted = rest.slice(hash + 1) || null;
    } else if (rest !== "") {
      path = rest;
    }
  } else if (value.includes("#")) {
    const hash = value.indexOf("#");
    path = value.slice(0, hash) || path;
    wanted = value.slice(hash + 1) || null;
  } else if (value.startsWith(".knit/") || value.endsWith(".md")) {
    path = value;
  } else {
    return { kind: "user_reference", ref: value, path: null, section: null, digest: null, verified: false };
  }
  const full = join(root, path);
  if (!existsSync(full)) throw new GuardError("authorization_source_missing", `授权来源不存在: ${path}`);
  const text = readFileSync(full, "utf8");
  // 默认来源 AGENTS.md 优先取受管入口整段：它包含交付与授权约定；
  // 没有受管标记时才退回旧的“交付／授权”章节匹配。
  const section =
    wanted === null && path === "AGENTS.md"
      ? (workflowSection(text, "Knit 受管入口") ?? workflowSection(text, null))
      : workflowSection(text, wanted);
  if (section === null) {
    throw new GuardError("authorization_source_missing", `授权来源缺少交付授权章节: ${path}`);
  }
  return {
    kind: "workflow",
    ref: value,
    path,
    section: section.heading,
    digest: sha256Text(section.body),
    verified: true,
  };
}

/** 当前策略版本：授权来源正文摘要；无 AGENTS.md 时用交付配置摘要。 */
export function policyVersion(root: string, config: ProjectConfig): string {
  const agents = join(root, "AGENTS.md");
  if (existsSync(agents)) return sha256Text(readFileSync(agents, "utf8"));
  return sha256Text(JSON.stringify(config.delivery));
}

export function recheckAuthorization(root: string, source: AuthorizationSource, caller: "cli" | "agent"): AuthorizationSource {
  if (source.kind !== "workflow") return source;
  const refreshed = resolveAuthorization(root, source.ref, caller);
  if (refreshed.path !== source.path || refreshed.section !== source.section || refreshed.digest !== source.digest) {
    throw new GuardError("authorization_changed", "授权来源在操作开始后变化，重核后再继续");
  }
  return refreshed;
}

export interface StagedEntry {
  mode: string;
  oid: string;
  stage: string;
}

/** 索引快照：用于证明无关 staged 内容未被提交或改写。 */
export function stagedSnapshot(root: string, git: GitRunner = gitSync): Record<string, string> {
  const result = runGit(root, ["ls-files", "-s", "-z"], git);
  if (result.code !== 0) throw new GuardError("git_failed", `读取 index 失败: ${result.stderr.trim()}`);
  const entries: Record<string, string> = {};
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    entries[path] = `${meta[0] ?? ""} ${meta[1] ?? ""} ${meta[2] ?? ""}`;
  }
  return entries;
}

/** 解析 `git status --porcelain -z`，返回本次选择路径内的脏路径（含 rename 两端）。 */
export function dirtyPaths(
  root: string,
  paths: string[],
  git: GitRunner = gitSync,
): string[] {
  if (paths.length === 0) return [];
  const result = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths], git);
  if (result.code !== 0) throw new GuardError("git_failed", `读取工作区状态失败: ${result.stderr.trim()}`);
  return [...new Set(porcelainStatusPaths(result.stdout))].sort();
}

/** 提交实际范围（name-status -z；rename 保留两端）。 */
export function commitPaths(root: string, oid: string, git: GitRunner = gitSync): string[] {
  const result = runGit(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", oid], git);
  if (result.code !== 0) throw new GuardError("git_failed", `读取提交范围失败: ${result.stderr.trim()}`);
  const parts = result.stdout.split("\0").filter((part) => part !== "");
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[index + 1];
      const newPath = parts[index + 2];
      if (oldPath !== undefined) out.push(oldPath);
      if (newPath !== undefined) out.push(newPath);
      index += 2;
    } else {
      const path = parts[index + 1];
      if (path !== undefined) out.push(path);
      index += 1;
    }
  }
  return [...new Set(out)].sort();
}

export function commitMessage(root: string, oid: string, git: GitRunner = gitSync): string {
  const result = runGit(root, ["show", "-s", "--format=%B", oid], git);
  if (result.code !== 0) throw new GuardError("git_failed", `读取提交信息失败: ${result.stderr.trim()}`);
  return result.stdout;
}

/** 交付提交的阶段标识；deliver 只用于升级前的旧工作提交。 */
export type DeliveryStage = "artifact" | "metadata" | "archive" | "deliver";

/** 主会话提供的提交文案：首行可读标题 + 正文。 */
export interface MessageDraft {
  subject: string;
  body: string;
}

export interface KnitTrailers {
  task: string;
  operation: string;
  stage: string;
  verification: string | null;
}

export const MAX_MESSAGE_BYTES = 8 * 1024;
export const MAX_MESSAGE_SUBJECT_CODE_POINTS = 72;
export const MAX_MESSAGE_BODY_CODE_POINTS = 4000;

/** 行尾空白与结尾空行归一；保留 CRLF 输入的可读内容。 */
function normalizeMessageText(raw: string): string {
  const lines = raw
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

function codePointLength(value: string): number {
  return [...value].length;
}

/** `k-<id>`／`op-<id>` 以外没有业务词时拒绝纯回执式标题。 */
function subjectOnlyIdentifiers(subject: string): boolean {
  const pattern = /\b(?:k-[0-9a-f]{12}|op-[0-9a-f]+)\b/gi;
  const ids = subject.match(pattern) ?? [];
  if (ids.length === 0) return false;
  const remainder = subject.replace(pattern, "");
  return !/[\p{L}\p{N}]/u.test(remainder);
}

/**
 * 校验并规范化主会话文案（DESIGN §10.2）。只做格式判断，不判断内容真实性。
 * 失败使用稳定原因码：message_empty／message_subject_invalid／message_body_missing／
 * message_too_long／message_trailer_conflict。
 */
export function parseMessageDraft(raw: string): MessageDraft {
  if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) {
    throw new GuardError("message_too_long", `提交文案不得超过 ${MAX_MESSAGE_BYTES / 1024} KB`);
  }
  const text = normalizeMessageText(raw);
  if (text.trim() === "") throw new GuardError("message_empty", "提交文案不能为空");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const subject = lines[0] ?? "";
  if (subject.trim() === "") throw new GuardError("message_subject_invalid", "提交文案首行不能为空");
  if (codePointLength(subject) > MAX_MESSAGE_SUBJECT_CODE_POINTS) {
    throw new GuardError("message_subject_invalid", `提交文案首行不得超过 ${MAX_MESSAGE_SUBJECT_CODE_POINTS} 个字符`);
  }
  if (subject.startsWith("knit: ")) {
    throw new GuardError("message_subject_invalid", "提交文案首行不能使用旧机器格式 knit: 前缀");
  }
  if (subjectOnlyIdentifiers(subject)) {
    throw new GuardError("message_subject_invalid", "提交文案首行不能只含任务或操作 ID");
  }
  if (lines.length < 3 || (lines[1] ?? "").trim() !== "") {
    throw new GuardError("message_body_missing", "提交文案首行与正文之间必须有一个空行，正文不能为空");
  }
  const bodyLines = lines.slice(2);
  const body = bodyLines.join("\n").trimEnd();
  if (body === "") throw new GuardError("message_body_missing", "提交文案正文不能为空");
  if (codePointLength(body) > MAX_MESSAGE_BODY_CODE_POINTS) {
    throw new GuardError("message_too_long", `提交文案正文不得超过 ${MAX_MESSAGE_BODY_CODE_POINTS} 个字符`);
  }
  if (bodyLines.some((line) => line.startsWith("Knit-"))) {
    throw new GuardError("message_trailer_conflict", "提交文案正文不能包含 Knit- 开头的机器字段");
  }
  return { subject, body };
}

/** 读取并校验 UTF-8 文案文件；文件错误也在创建操作前拒绝。 */
export function readMessageFile(path: string): MessageDraft {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    throw new GuardError("message_file_missing", `无法读取提交文案文件: ${path}`);
  }
  if (buffer.byteLength > MAX_MESSAGE_BYTES) {
    throw new GuardError("message_too_long", `提交文案不得超过 ${MAX_MESSAGE_BYTES / 1024} KB`);
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new GuardError("message_encoding_invalid", "提交文案必须是 UTF-8 文本");
  }
  return parseMessageDraft(raw);
}

/** 首行按码点截断到 72 字符以内，保证模板标题可读。 */
export function truncateMessageSubject(subject: string): string {
  const chars = [...subject];
  if (chars.length <= MAX_MESSAGE_SUBJECT_CODE_POINTS) return subject;
  return `${chars.slice(0, MAX_MESSAGE_SUBJECT_CODE_POINTS - 1).join("")}…`;
}

/** 拼装最终提交说明：人读首行／正文在前，机器 trailer 在末尾。 */
export function composeCommitMessage(
  draft: MessageDraft,
  facts: { taskId: string; operationId: string; stage: DeliveryStage; verification: string },
): string {
  return [
    draft.subject,
    "",
    draft.body.trimEnd(),
    "",
    `Knit-Task: ${facts.taskId}`,
    `Knit-Operation: ${facts.operationId}`,
    `Knit-Stage: ${facts.stage}`,
    `Knit-Verification: ${facts.verification}`,
  ].join("\n") + "\n";
}

/** 解析提交说明中的 Knit trailer；缺少 Task／Operation／Stage 时返回 null。 */
export function readKnitTrailers(message: string): KnitTrailers | null {
  const found = new Map<string, string>();
  for (const line of message.split(/\r?\n/)) {
    const match = /^Knit-(Task|Operation|Stage|Verification): (.+)$/.exec(line);
    if (match === null) continue;
    found.set(match[1] ?? "", match[2] ?? "");
  }
  const task = found.get("Task");
  const operation = found.get("Operation");
  const stage = found.get("Stage");
  if (task === undefined || operation === undefined || stage === undefined) return null;
  return { task, operation, stage, verification: found.get("Verification") ?? null };
}

/** 按 trailer 判定阶段提交；无 trailer 时回退旧格式 `knit: <stage> ...`。 */
export function isStageCommit(message: string, stage: string, operationId: string): boolean {
  const trailers = readKnitTrailers(message);
  if (trailers !== null) return trailers.stage === stage && trailers.operation === operationId;
  return message
    .split(/\r?\n/)
    .some((line) => line.startsWith(`knit: ${stage} `) && line.includes(operationId));
}

/** 取提交说明首行；用于交付结果与 --plan 展示文案来源。 */
export function commitSubject(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? "";
}

export function commitExists(root: string, oid: string, git: GitRunner = gitSync): boolean {
  return runGit(root, ["cat-file", "-e", `${oid}^{commit}`], git).code === 0;
}

export function isAncestor(root: string, ancestor: string, descendant: string, git: GitRunner = gitSync): boolean {
  return runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant], git).code === 0;
}

export function sameSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function selectedPath(path: string, selected: string[]): boolean {
  return selected.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/** 指定提交树内的模式／对象类型／blob OID；用于核对 hook 是否改了实际提交内容。 */
export function treeSnapshot(
  root: string,
  commit: string,
  paths: string[],
  git: GitRunner = gitSync,
): Record<string, string> {
  const result = runGit(root, ["ls-tree", "-r", "-z", commit, "--", ...paths], git);
  if (result.code !== 0) throw new GuardError("git_failed", `读取提交树失败: ${result.stderr.trim()}`);
  const entries: Record<string, string> = {};
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    entries[path] = `${meta[0] ?? ""} ${meta[1] ?? ""} ${meta[2] ?? ""}`;
  }
  return entries;
}

/** 从 index 快照提取选定路径的 mode／blob（忽略 stage 列）。 */
export function indexTreeFor(
  staged: Record<string, string>,
  selected: string[],
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [path, value] of Object.entries(staged)) {
    if (!selectedPath(path, selected)) continue;
    const [mode, oid] = value.split(" ");
    if (mode !== undefined && oid !== undefined) entries[path] = `${mode} blob ${oid}`;
  }
  return entries;
}

/** 比较提交树与预期 index 条目；路径集合或 mode／blob 任一不同都不等价。 */
export function sameTree(
  expected: Record<string, string>,
  actual: Record<string, string>,
  selected: string[],
): boolean {
  const expectedSelected = Object.fromEntries(
    Object.entries(expected).filter(([path]) => selectedPath(path, selected)),
  );
  const keys = new Set([...Object.keys(expectedSelected), ...Object.keys(actual)]);
  return [...keys].every((path) => expectedSelected[path] === actual[path]);
}
