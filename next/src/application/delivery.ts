/**
 * 交付：把完成的任务归档；项目在 Git 仓库里时再把它的改动提交成一次提交。
 * Git 不是必须的，不在 Git 仓库里时只归档。
 */
import { gitSync } from "../infrastructure/process.js";
import { archiveDirOf, scanTasks, type StoredTask } from "./task-store.js";
import { RUNTIME_PREFIX } from "./workspace.js";

export interface DeliveryPreview {
  /** 归档之后的任务目录。 */
  readonly archiveDir: string;
  /** 项目不在 Git 仓库里时是 null：只归档，不提交。 */
  readonly commit: {
    readonly files: readonly { readonly path: string; readonly reviewed: boolean }[];
    /** 任务目录没有被 Git 忽略，会跟着提交。 */
    readonly taskDir: boolean;
    /** 记录里现在没有改动的路径。 */
    readonly unchanged: readonly string[];
    /** 工作区里不属于这个任务的改动有几处。 */
    readonly others: number;
  } | null;
  readonly openChildren: readonly { readonly id: string; readonly status: string }[];
}

export function insideGit(root: string): boolean {
  return gitSync(["rev-parse", "--is-inside-work-tree"], root).code === 0;
}

/** 这些路径里现在有改动的文件：含新增、删除和没有跟踪的，不含被 Git 忽略的；目录列出里面的文件。 */
export function changedAmong(root: string, paths: readonly string[]): string[] {
  // 不带路径时 Git 会列出整个工作区。
  if (paths.length === 0) return [];
  return gitSync(["--literal-pathspecs", "status", "--porcelain", "-z", "--no-renames", "-uall", "--", ...paths], root)
    .stdout.split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.slice(3))
    .sort();
}

/** 交付会做什么；只读。 */
export function previewDelivery(root: string, stored: StoredTask): DeliveryPreview {
  const id = stored.document?.frontmatter.id;
  const openChildren = scanTasks(root).flatMap((task) => {
    const frontmatter = task.document?.frontmatter;
    if (frontmatter === undefined || frontmatter.parent !== id) return [];
    return ["done", "delivered", "cancelled"].includes(frontmatter.status)
      ? []
      : [{ id: frontmatter.id, status: frontmatter.status }];
  });
  const archiveDir = archiveDirOf(stored);
  if (!insideGit(root)) return { archiveDir, commit: null, openChildren };

  const runs = stored.record?.runs ?? [];
  const recorded = [...new Set([...(stored.record?.changedPaths ?? []), ...runs.flatMap((run) => run.changedPaths)])].sort();
  const reviewed = new Set(runs.filter((run) => run.verdict !== null).flatMap((run) => run.changedPaths));
  const files = changedAmong(root, recorded);
  return {
    archiveDir,
    commit: {
      files: files.map((path) => ({ path, reviewed: reviewed.has(path) })),
      taskDir: gitSync(["check-ignore", "-q", "--", `${stored.dir}/task.md`], root).code !== 0,
      unchanged: recorded.filter(
        (path) => !files.some((file) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`)),
      ),
      others: changedAmong(root, ["."]).filter(
        (path) => !files.includes(path) && !path.startsWith(`${stored.dir}/`) && !path.startsWith(RUNTIME_PREFIX),
      ).length,
    },
    openChildren,
  };
}
