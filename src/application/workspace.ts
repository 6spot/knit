/**
 * 对比工作区：一次执行改了哪些文件，由派发时和结束时各拍一份记录比出来，不听执行者自己报。
 * 只对比，不恢复；也不区分改动是谁做的。`root` 要是 Git 仓库的顶层目录。
 * 审查通过时拍的那一份留在执行目录里（after.json），交付预览拿它看哪些文件之后又改过。
 */
import { join } from "node:path";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { workflowPrompts, type WorkflowDefinition } from "../domain/workflow.js";
import { fileFacts } from "../infrastructure/fs.js";
import { projectRelative } from "../infrastructure/paths.js";
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
export function fingerprint(root: string, path: string): string {
  try {
    const facts = fileFacts(join(root, path));
    return [facts.kind, facts.mode ?? "-", facts.sha256 ?? "-"].join(" ");
  } catch (error) {
    // 最后一个使用者可能在 lstat 和读取内容之间卸载共享钩子。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT_FINGERPRINT;
    throw error;
  }
}

export function takeSnapshot(root: string): WorkspaceSnapshot {
  const head = gitSync(["rev-parse", "--verify", "--quiet", "HEAD"], root);
  // 已跟踪的文件加上没被忽略的新文件。
  const listed = gitSync(["ls-files", "-tco", "--exclude-standard", "-z"], root);
  if (listed.code !== 0) throw new Error(`git ls-files 失败：${listed.stderr.trim()}`);
  const files: Record<string, string> = {};
  for (const entry of listed.stdout.split("\0")) {
    const path = entry.slice(2);
    if (path === "" || path.startsWith(RUNTIME_PREFIX)) continue;
    const observed = fingerprint(root, path);
    // Git 的 ? 标记未跟踪文件。拍照期间消失的临时文件不应留下一条新增记录。
    if (entry.startsWith("? ") && observed === ABSENT_FINGERPRINT) continue;
    files[path] = observed;
  }
  return { head: head.code === 0 ? head.stdout.trim() : null, files };
}

export function changesBetween(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChanges {
  const changedPaths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((path) => before.files[path] !== after.files[path])
    .sort();
  return { changedPaths, head: before.head === after.head ? null : { before: before.head, after: after.head } };
}

/** `changedPaths` 里执行者不能改的那些：规范、流程、配置，以及流程用到的角色文件。 */
export function protectedChanges(changedPaths: readonly string[], workflow: WorkflowDefinition): string[] {
  const prompts = new Set(workflowPrompts(workflow).map(projectRelative));
  return changedPaths.filter(
    (path) =>
      path.startsWith(`${STANDARDS_DIR}/`) || path === WORKFLOW_CONFIG_PATH || path === CONFIG_PATH || prompts.has(path),
  );
}
