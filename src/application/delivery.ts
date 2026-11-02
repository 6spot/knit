/**
 * 交付／归档的确定性基础（DESIGN.md 第10节、OPERATIONS.md 第4.1节）。
 * 只使用真实 Git 与文件系统事实；不 stash、不 reset、不改写历史。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { gitSync } from "../infrastructure/process.js";
import { GuardError } from "./guard-error.js";
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
 * 授权来源定位。workflow 来源核实文件、章节与摘要；user_reference 只保存调用声明，
 * 不冒充已验证的人类授权（语义判断仍归主 Agent）。
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
  let path = ".knit/workflow.md";
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
  const section = workflowSection(text, wanted);
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

/** 当前策略版本：授权来源正文摘要；无 workflow 时用交付配置摘要。 */
export function policyVersion(root: string, config: ProjectConfig): string {
  const workflow = join(root, ".knit", "workflow.md");
  if (existsSync(workflow)) return sha256Text(readFileSync(workflow, "utf8"));
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
  const parts = result.stdout.split("\0");
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    out.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const original = parts[index + 1];
      if (original !== undefined && original !== "") out.push(original);
      index += 1;
    }
  }
  return [...new Set(out)].sort();
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
