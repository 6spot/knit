/**
 * 交付：把完成的任务归档；项目在 Git 仓库里时再把它的改动提交成一次提交。
 * Git 不是必须的，不在 Git 仓库里时只归档。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "../contracts/task.js";
import { countedRuns } from "../domain/progress.js";
import { gitSync } from "../infrastructure/process.js";
import { RUNS_DIR } from "./run-prepare.js";
import { archiveDirOf, scanTasks, type StoredTask } from "./task-store.js";
import { fingerprint, RUNTIME_PREFIX, type WorkspaceSnapshot } from "./workspace.js";

export interface DeliveryPreview {
  /** 归档之后的任务目录。 */
  readonly archiveDir: string;
  /** 项目不在 Git 仓库里时是 null：只归档，不提交。 */
  readonly commit: {
    readonly files: readonly {
      readonly path: string;
      /** 给出过结论的执行改过它。 */
      readonly reviewed: boolean;
      /** 最后一次审查通过之后它又变了：这部分改动审查没有看过。 */
      readonly changedAfterReview: boolean;
    }[];
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

/** 任务记录的改动路径：主会话登记的和各次执行的合在一起。 */
export function recordedPaths(record: TaskRecord): string[] {
  return [...new Set([...record.changedPaths, ...record.runs.flatMap((run) => run.changedPaths)])].sort();
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
  const recorded = stored.record === null ? [] : recordedPaths(stored.record);
  const reviewed = new Set(runs.filter((run) => run.verdict !== null).flatMap((run) => run.changedPaths));
  const files = changedAmong(root, recorded);
  // 和完成任务时一样：失败的执行、需求改之前的执行都不算数。
  const lastReview = stored.record === null ? undefined : countedRuns(stored.record).findLast((run) => run.verdict !== null);
  const passedFile = lastReview?.verdict === "pass" ? join(root, RUNS_DIR, lastReview.id, "after.json") : null;
  // 运行时资料可以清掉：那一份不在了就不标。
  const passed =
    passedFile !== null && existsSync(passedFile)
      ? (JSON.parse(readFileSync(passedFile, "utf8")) as WorkspaceSnapshot).files
      : null;
  return {
    archiveDir,
    commit: {
      files: files.map((path) => ({
        path,
        reviewed: reviewed.has(path),
        changedAfterReview: passed !== null && passed[path] !== fingerprint(root, path),
      })),
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

export interface CommitDeliveryInput {
  readonly taskId: string;
  /** 归档之前的任务目录。 */
  readonly taskDir: string;
  readonly archiveDir: string;
  readonly recorded: readonly string[];
  readonly message: string;
}

export type DeliveryCommit =
  /** `summary` 是提交号加首行；`extra`、`missing` 是提交里比预期多出来和少掉的文件。 */
  | {
      readonly kind: "committed";
      readonly summary: string;
      readonly extra: readonly string[];
      readonly missing: readonly string[];
    }
  | { readonly kind: "nothing" }
  /** Git 没有接受；`error` 是它的标准错误，`files` 是已经暂存的文件。 */
  | { readonly kind: "refused"; readonly error: string; readonly files: readonly string[] };

/** 归档之后把这个任务的文件提交成一次提交；别的改动不动，不推送。 */
export function commitDelivery(root: string, input: CommitDeliveryInput): DeliveryCommit {
  // 任务目录已经移走：原目录里跟踪过的文件是删除，归档目录里的是新增。
  const files = changedAmong(root, [...input.recorded, input.taskDir, input.archiveDir]);
  // 不带路径的 git add -A 会暂存整个工作区。
  if (files.length === 0) return { kind: "nothing" };
  // 已经暂存的删除在工作区和暂存区里都已经没有文件，add 的路径对不上；先撤掉这些路径的暂存，
  // 别的路径的暂存不动。
  const reset = gitSync(["--literal-pathspecs", "reset", "-q", "--", ...files], root);
  if (reset.code !== 0) return { kind: "refused", error: reset.stderr, files };
  const added = gitSync(["--literal-pathspecs", "add", "-A", "--", ...files], root);
  if (added.code !== 0) return { kind: "refused", error: added.stderr, files };
  // --only：原来已经暂存的别的文件不进这次提交。不加 --no-verify，仓库的 hook 照常运行。
  const committed = gitSync(
    [
      "--literal-pathspecs",
      "commit",
      "-q",
      "--only",
      "-m",
      `${input.message.trim()}\n\nKnit-Task: ${input.taskId}`,
      "--",
      ...files,
    ],
    root,
  );
  if (committed.code !== 0) return { kind: "refused", error: committed.stderr, files };
  // hook 可以往提交里加文件，也可以拿掉文件。
  const actual = gitSync(["show", "--name-only", "--no-renames", "-z", "--format=", "HEAD"], root)
    .stdout.split("\0")
    .filter((path) => path !== "")
    .sort();
  return {
    kind: "committed",
    summary: gitSync(["log", "-1", "--format=%h %s"], root).stdout.trim(),
    extra: actual.filter((path) => !files.includes(path)),
    missing: files.filter((path) => !actual.includes(path)),
  };
}
