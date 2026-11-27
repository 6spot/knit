/**
 * 对比工作区：一次执行改了哪些文件，由派发时和结束时各拍一份记录比出来，不听执行者自己报。
 * 只对比，不恢复；也不区分改动是谁做的。`root` 要是 Git 仓库的顶层目录。
 * 审查通过时拍的那一份留在执行目录里（after.json），交付预览拿它看哪些文件之后又改过。
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { workflowPrompts, type WorkflowDefinition } from "../domain/workflow.js";
import { digestOf, fileFacts, listFiles } from "../infrastructure/fs.js";
import { projectRelative, safeJoin } from "../infrastructure/paths.js";
import { gitSync } from "../infrastructure/process.js";
import { CONFIG_PATH, STANDARDS_DIR } from "./project-config.js";

/** 运行时资料所在的目录：执行过程中程序自己会写，不算改动。 */
export const RUNTIME_PREFIX = ".knit/.runtime/";
const ABSENT_FINGERPRINT = "absent - -";

/** 能直接用 JSON.stringify 存成文件再读回来用。 */
export interface WorkspaceSnapshot {
  /** HEAD 的提交号；仓库还没有提交时是 null。 */
  head: string | null;
  /** 项目内的相对路径（用 / 分隔）到指纹：文件的类型、权限和内容摘要。 */
  files: Record<string, string>;
}

export interface WorkspaceChanges {
  /** 指纹不同的路径，含新增和删除的，按路径排序。 */
  changedPaths: string[];
  /** HEAD 没变时是 null。 */
  head: { before: string | null; after: string | null } | null;
}

/** 一个文件的指纹；`path` 是项目内的相对路径。已跟踪但磁盘上已经删掉的文件，类型是 absent。 */
export function fingerprint(root: string, path: string, gitlink = false): string {
  try {
    const facts = fileFacts(join(root, path));
    if (gitlink && facts.kind === "directory") return submoduleFingerprint(safeJoin(root, path));
    return [facts.kind, facts.mode ?? "-", facts.sha256 ?? "-"].join(" ");
  } catch (error) {
    // 最后一个使用者可能在 lstat 和读取内容之间卸载共享钩子。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT_FINGERPRINT;
    throw error;
  }
}

function submoduleFingerprint(directory: string): string {
  // 显式指定 .git，避免 Git 在子模块没有有效仓库时向上找到父仓库。
  if (!lstatSync(join(directory, ".git"), { throwIfNoEntry: false })) return submoduleWorkFiles(directory, "uninitialized");
  const repository = ["--git-dir=.git", "--work-tree=."];
  const head = gitSync([...repository, "rev-parse", "--verify", "HEAD^{commit}"], directory);
  const status = gitSync([...repository, "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--no-renames", "--untracked-files=all", "--ignore-submodules=none", "-z"], directory);
  if (status.code !== 0) return submoduleWorkFiles(directory, `unreadable ${head.code === 0 ? head.stdout.trim() : "-"}`);
  if (head.code !== 0) return submoduleWorkFiles(directory, "unborn");
  const dirty = status.stdout.split("\0").filter(Boolean).map((entry) => [entry, fingerprint(directory, entry.slice(3))]);
  const state = dirty.length ? createHash("sha256").update(JSON.stringify(dirty)).digest("hex") : "clean";
  return `submodule ${head.stdout.trim()} ${state}`;
}

function submoduleWorkFiles(directory: string, state: string): string {
  const files = listFiles(directory, ".git");
  return Object.keys(files).length ? `submodule ${state} ${digestOf(files)}` : `submodule ${state}`;
}

export function takeSnapshot(root: string, protectedPaths: readonly string[] = [], before?: WorkspaceSnapshot): WorkspaceSnapshot {
  const resolved = gitSync(["rev-parse", "--verify", "--quiet", "HEAD"], root);
  const head = resolved.code === 0 ? resolved.stdout.trim() : null;
  const listed = gitSync(["ls-files", "-v", "--stage", "-z"], root);
  if (listed.code !== 0) throw new Error(`git ls-files 失败：${listed.stderr.trim()}`);
  // gitlink 逐个取指纹，父仓库的 status 无需进入可能已损坏的子仓库。
  const status = gitSync(["-c", "core.filemode=true", "-c", "core.symlinks=true", "-c", "core.fsmonitor=false", "status", "--ignore-submodules=all", "--porcelain=v1", "--no-renames", "--untracked-files=all", "-z"], root);
  if (status.code !== 0) throw new Error(`git status 失败：${status.stderr.trim()}`);
  const states = new Map<string, string>();
  for (const entry of status.stdout.split("\0").filter(Boolean)) {
    const path = entry.slice(3);
    const state = entry.slice(0, 2);
    // git rm --cached 后同一路径可能同时报告 D 和 ??，仍需和 HEAD 的指纹可比。
    if (state === "??" && states.has(path)) continue;
    states.set(path, state);
  }
  // 旧快照只有原始字节指纹，结算时仍用原始字节和它比较。
  const rawPaths = new Set(Object.entries(before?.files ?? {})
    .filter(([, value]) => !value.startsWith("git ") && !value.includes("\0")).map(([path]) => path));
  const roles = new Set(protectedPaths.map((path) => projectRelative(path)?.toLowerCase()));
  const raw = (path: string) => {
    const lower = path.toLowerCase();
    return rawPaths.has(path) || roles.has(lower) || (lower.startsWith(".knit/") && !lower.startsWith(".knit/tasks/archive/"));
  };
  const files: Record<string, string> = Object.create(null);
  const candidates = new Map<string, string>();
  const observed = (path: string, tracked: boolean) => {
    const value = fingerprint(root, path);
    if (tracked && !raw(path) && head !== null) candidates.set(path, value);
    return value;
  };
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [tag, mode, oid, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (path.startsWith(RUNTIME_PREFIX) || Object.hasOwn(files, path)) continue;
    if (mode === "160000") {
      files[path] = fingerprint(root, path, true);
      continue;
    }
    // 非普通索引条目（冲突、skip-worktree、assume-unchanged）仍实际读取。
    const clean = head !== null && tag === "H" && stage === "0" &&
      (mode === "100644" || mode === "100755" || mode === "120000") && !states.has(path) && !raw(path);
    files[path] = clean ? `git ${mode} ${oid}` : observed(path, true);
  }
  for (const [path, state] of states) {
    if (path.startsWith(RUNTIME_PREFIX) || Object.hasOwn(files, path)) continue;
    const value = observed(path, state !== "??");
    if (state === "??" && value === ABSENT_FINGERPRINT) continue;
    files[path] = value;
  }
  if (head !== null) {
    for (const [path, git] of gitFingerprints(root, [...candidates], head.length)) {
      files[path] = `${files[path]}\0${git}`;
    }
  }
  return { head, files: { ...files } };
}

/** 普通文件跨干净/脏状态比较时，使用 Git 的内容身份；两边都是脏文件时仍比较原始字节。 */
function gitFingerprints(root: string, entries: readonly [string, string][], oidLength: number): Map<string, string> {
  const links = entries.filter(([, raw]) => raw.startsWith("link ")).map(([path, raw]) => {
    const target = Buffer.from(raw.slice(5, -2));
    const oid = createHash(oidLength === 64 ? "sha256" : "sha1").update(`blob ${target.length}\0`).update(target).digest("hex");
    return [path, `git 120000 ${oid}`] as const;
  });
  const regular = entries.filter(([, raw]) => raw.startsWith("file "));
  // Git 随路径应用 clean 规则。分批传 argv，避免每个脏文件单独启动一个 Git 进程。
  const batchSize = 32;
  const files = Array.from({ length: Math.ceil(regular.length / batchSize) }, (_, index) => {
    const batch = regular.slice(index * batchSize, (index + 1) * batchSize);
    const hashed = gitSync(["hash-object", "--", ...batch.map(([path]) => path)], root);
    if (hashed.code !== 0) throw new Error(`git hash-object 失败：${hashed.stderr.trim()}`);
    const oids = hashed.stdout.trim().split("\n");
    return batch.map(([path, raw], i) => {
      const mode = (Number.parseInt(raw.split(" ")[1]!, 8) & 0o100) !== 0 ? "100755" : "100644";
      return [path, `git ${mode} ${oids[i]}`] as const;
    });
  }).flat();
  return new Map([...links, ...files]);
}

function sameFingerprint(before: string | undefined, after: string | undefined): boolean {
  if (before === after) return true;
  if (typeof before !== "string" || typeof after !== "string") return false;
  const [beforeRaw, beforeGit] = before.split("\0");
  const [afterRaw, afterGit] = after.split("\0");
  if (before.startsWith("git ")) return before === afterGit;
  if (after.startsWith("git ")) return after === beforeGit;
  return beforeRaw === afterRaw;
}

/** 返回当前内容仍符合审查快照的路径。纯字节和混合指纹都按原始字节比对。 */
export function matchingFingerprints(root: string, paths: readonly string[], expected: Readonly<Record<string, string | undefined>>): Set<string> {
  const matching = new Set<string>();
  const candidates: [string, string][] = [];
  for (const path of paths) {
    const value = expected[path];
    if (typeof value !== "string") continue;
    const raw = fingerprint(root, path, value.startsWith("submodule "));
    if (value.startsWith("git ")) {
      candidates.push([path, raw]);
      continue;
    }
    if (sameFingerprint(value, raw)) matching.add(path);
  }
  const first = candidates[0];
  if (first !== undefined) {
    // 一份审查快照里的 Git 对象都来自同一仓库。
    const oidLength = expected[first[0]]!.split(" ")[2]!.length;
    for (const [path, git] of gitFingerprints(root, candidates, oidLength)) {
      if (git === expected[path]) matching.add(path);
    }
  }
  return matching;
}

export function matchesFingerprint(root: string, path: string, expected: string | undefined): boolean {
  return matchingFingerprints(root, [path], { [path]: expected }).has(path);
}

export function changesBetween(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChanges {
  const changedPaths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((path) => !sameFingerprint(before.files[path], after.files[path]))
    .sort();
  return { changedPaths, head: before.head === after.head ? null : { before: before.head, after: after.head } };
}

/** `changedPaths` 里执行者不能改的那些：规范、流程、配置，以及流程用到的角色文件。 */
export function protectedChanges(changedPaths: readonly string[], workflow: WorkflowDefinition): string[] {
  const prompts = new Set(workflowPrompts(workflow).map((path) => projectRelative(path)?.toLowerCase()));
  return changedPaths.filter((path) => {
    const lower = path.toLowerCase();
    return lower.startsWith(`${STANDARDS_DIR}/`) || lower === WORKFLOW_CONFIG_PATH || lower === CONFIG_PATH || prompts.has(lower);
  });
}
