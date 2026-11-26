/**
 * 交付：把完成的任务归档；项目在 Git 仓库里时再把它的改动提交成一次提交。
 * Git 不是必须的，不在 Git 仓库里时只归档。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskRecord } from "../contracts/task.js";
import { lastPassedReview } from "../domain/progress.js";
import { currentStatus } from "../domain/task.js";
import { moveDirectory, removeCopy } from "../infrastructure/fs.js";
import { gitSync } from "../infrastructure/process.js";
import { loadConfig } from "./project-config.js";
import { RUNS_DIR } from "./run-prepare.js";
import { archiveDirOf, findTask, readTask, saveTask, scanTasks, type StoredTask, type TaskRefusal } from "./task-store.js";
import { matchesFingerprint, RUNTIME_PREFIX, type WorkspaceSnapshot } from "./workspace.js";
import { mergeAndCleanWorktree, taskWorktree, type TaskWorktree, type WorktreeIntegration } from "./worktree.js";

export interface DeliveryPreview {
  /** 归档之后的任务目录。 */
  readonly archiveDir: string;
  /** 归档所在检出：任务目录被忽略时仍是主检出。 */
  readonly archiveRoot: string;
  /** 存在任务 Worktree 时在这里提交，否则沿用主检出。 */
  readonly worktree: TaskWorktree | null;
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
  readonly openChildren: readonly { readonly id: string; readonly title: string; readonly status: string }[];
}

export interface DeliveryOptions {
  readonly preview?: boolean;
  readonly authorization?: string;
  readonly messageFile?: string;
}

export type DeliveryResult = TaskRefusal
  | { kind: "preview"; preview: DeliveryPreview; title: string; taskDir: string; result: string | null;
      message: string | undefined; mergeBranch: string | null }
  | { kind: "rolledBack"; reason: "move"; error: unknown }
  | { kind: "rolledBack"; reason: "commit"; error: string; taskDir: string }
  | { kind: "delivered"; title: string; archiveDir: string; archiveRoot: string; worktree: TaskWorktree | null;
      commit: Exclude<DeliveryCommit, { kind: "refused" }> | null; integration: WorktreeIntegration | null };

export function deliverTask(root: string, id: string, options: DeliveryOptions): DeliveryResult {
  const loaded = readTask(root, id);
  if (loaded.kind === "refused") return loaded;
  const { stored, document, record } = loaded.task;
  const status = currentStatus(document, record);
  if (status === "delivered" || status === "cancelled") return { kind: "refused", problems: [`任务 ${id} 已经结束（${status}），不能交付`] };
  if (status !== "done") return { kind: "refused", problems: [`任务 ${id} 还没有完成（${status}）；完成之后再交付：knit task close ${id}`] };
  const worktree = deliveryWorktree(root, stored.dir);
  const config = worktree === null ? null : loadConfig(root);
  if (config?.config === null) return { kind: "refused", problems: config.problems };
  const mergeBranch = config?.config?.worktree?.autoMerge === true
    ? gitSync(["branch", "--show-current"], root).stdout.trim() || "HEAD"
    : null;
  const git = insideGit(root);
  const authorization = options.authorization?.trim() ?? "";
  if (!options.preview && authorization === "") {
    return { kind: "refused", problems: ["交付要有用户的授权：加 --authorization <引用>，写明用户是在哪条消息里同意的"] };
  }
  if (!options.preview && git && options.messageFile === undefined) {
    return { kind: "refused", problems: ["在 Git 仓库里交付要给提交文案：加 --message-file <文件>"] };
  }
  const preview = options.preview ? previewDelivery(root, stored) : null;
  const file = git ? options.messageFile : undefined;
  if (file !== undefined && !statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return { kind: "refused", problems: [`读不到提交文案：${file}`] };
  }
  const message = file === undefined ? undefined : readFileSync(file, "utf8").trim();
  if (preview !== null) {
    return { kind: "preview", preview, title: document.frontmatter.title, taskDir: stored.dir, result: document.result, message, mergeBranch };
  }
  if (git && message === "") return { kind: "refused", problems: [`提交文案是空的：${file}`] };

  const workspace = worktree?.path ?? root;
  const archiveRoot = deliveryArchiveRoot(root, stored.dir, worktree);
  const archiveDir = archiveDirOf(stored);
  const source = join(root, stored.dir);
  const destination = join(archiveRoot, archiveDir);
  const branchTask = join(workspace, stored.dir);
  // 备份与任务分支在同一文件系统，不依赖系统临时目录的位置。
  const backup = worktree !== null && archiveRoot === workspace && existsSync(branchTask)
    ? mkdtempSync(join(workspace, ".knit-delivery-")) : null;
  const newArchiveParents = [dirname(destination), join(archiveRoot, ".knit/tasks/archive"),
    join(archiveRoot, ".knit/tasks"), join(archiveRoot, ".knit")].filter((path) => !existsSync(path));
  const rollback = () => {
    if (!existsSync(source)) moveDirectory(destination, source);
    if (backup !== null) {
      if (existsSync(join(backup, "task"))) renameSync(join(backup, "task"), branchTask);
      rmSync(backup, { recursive: true, force: true });
    }
    newArchiveParents.forEach((path) => {
      if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
    });
    const restored = findTask(root, id);
    if (restored !== null) saveTask(root, restored, document, record);
  };
  const conflicts = saveTask(root, stored,
    { ...document, frontmatter: { ...document.frontmatter, status: "delivered" } }, { ...record, authorization });
  if (conflicts.length > 0) {
    if (backup !== null) rmSync(backup, { recursive: true, force: true });
    return { kind: "refused", problems: conflicts };
  }
  try {
    if (backup !== null) renameSync(branchTask, join(backup, "task"));
    mkdirSync(dirname(destination), { recursive: true });
    moveDirectory(source, destination);
  } catch (error) {
    rollback();
    return { kind: "rolledBack", reason: "move", error };
  }
  const commit = git ? commitDelivery(workspace, {
    taskId: id, taskDir: archiveRoot === workspace ? stored.dir : null, archiveDir,
    recorded: recordedPaths(record), message: message ?? "",
  }) : null;
  if (commit?.kind === "refused") {
    gitSync(["--literal-pathspecs", "reset", "-q", "--", ...commit.files], workspace);
    rollback();
    return { kind: "rolledBack", reason: "commit", error: commit.error, taskDir: stored.dir };
  }
  if (backup !== null) removeCopy(backup);
  const integration = worktree !== null && mergeBranch !== null ? mergeAndCleanWorktree(root, worktree, mergeBranch) : null;
  // --abort 会恢复主检出里已入库的旧任务目录；当前记录已经在任务 Worktree 的归档里。
  if (integration?.merged === false && archiveRoot !== root) removeCopy(source);
  return { kind: "delivered", title: document.frontmatter.title, archiveDir, archiveRoot: integration?.merged ? root : archiveRoot, worktree, commit, integration };
}

export function insideGit(root: string): boolean {
  return gitSync(["rev-parse", "--is-inside-work-tree"], root).code === 0;
}

/** 只用派发时的位置算法定位，不建 Worktree。 */
export function deliveryWorktree(root: string, taskDir: string): TaskWorktree | null {
  if (!insideGit(root)) return null;
  const worktree = taskWorktree(root, taskDir);
  return existsSync(join(worktree.path, ".git")) ? worktree : null;
}

/** 被 Git 忽略的任务目录留在主检出归档，不随任务分支提交。 */
export function deliveryArchiveRoot(root: string, taskDir: string, worktree: TaskWorktree | null): string {
  if (worktree === null) return root;
  return gitSync(["check-ignore", "-q", "--", `${taskDir}/task.md`], worktree.path).code === 0 ? root : worktree.path;
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
  const openChildren = scanTasks(root, "active").flatMap((task) => {
    const frontmatter = task.document?.frontmatter;
    if (frontmatter === undefined || frontmatter.parent !== id) return [];
    return ["done", "delivered", "cancelled"].includes(frontmatter.status)
      ? []
      : [{ id: frontmatter.id, title: frontmatter.title, status: frontmatter.status }];
  });
  const archiveDir = archiveDirOf(stored);
  if (!insideGit(root)) return { archiveDir, archiveRoot: root, worktree: null, commit: null, openChildren };
  const worktree = deliveryWorktree(root, stored.dir);
  const workspace = worktree?.path ?? root;

  const runs = stored.record?.runs ?? [];
  const recorded = stored.record === null ? [] : recordedPaths(stored.record);
  const reviewed = new Set(runs.filter((run) => run.verdict !== null).flatMap((run) => run.changedPaths));
  const files = changedAmong(workspace, recorded);
  // 和完成任务时一样：失败的执行、需求改之前的执行都不算数。
  const lastReview = stored.record === null ? undefined : lastPassedReview(stored.record);
  const passedFile = lastReview ? join(root, RUNS_DIR, lastReview.id, "after.json") : null;
  // 运行时资料可以清掉：那一份不在了就不标。
  const passed =
    passedFile !== null && existsSync(passedFile)
      ? (JSON.parse(readFileSync(passedFile, "utf8")) as WorkspaceSnapshot).files
      : null;
  return {
    archiveDir,
    archiveRoot: deliveryArchiveRoot(root, stored.dir, worktree),
    worktree,
    commit: {
      files: files.map((path) => ({
        path,
        reviewed: reviewed.has(path),
        changedAfterReview: passed !== null && !matchesFingerprint(workspace, path, passed[path]),
      })),
      taskDir: gitSync(["check-ignore", "-q", "--", `${stored.dir}/task.md`], workspace).code !== 0,
      unchanged: recorded.filter(
        (path) => !files.some((file) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`)),
      ),
      others: changedAmong(workspace, ["."]).filter(
        (path) => !files.includes(path) && !path.startsWith(`${stored.dir}/`) && !path.startsWith(RUNTIME_PREFIX),
      ).length,
    },
    openChildren,
  };
}

export interface CommitDeliveryInput {
  readonly taskId: string;
  /** 归档之前的任务目录；归档留在另一个检出时是 null，不提交目录。 */
  readonly taskDir: string | null;
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
  const files = changedAmong(root, [...input.recorded, ...(input.taskDir === null ? [] : [input.taskDir, input.archiveDir])]);
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
