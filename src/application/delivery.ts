/**
 * 交付：把完成的任务归档；项目在 Git 仓库里时再把它的改动提交成一次提交。
 * Git 不是必须的，不在 Git 仓库里时只归档。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { TaskRecord } from "../contracts/task.js";
import { lastPassedReview } from "../domain/progress.js";
import { sha256Text } from "../contracts/primitives.js";
import { currentStatus, renderTaskDocument, renderTaskRecord, type TaskDocument } from "../domain/task.js";
import { moveDirectory, removeCopy } from "../infrastructure/fs.js";
import { gitSync } from "../infrastructure/process.js";
import { loadConfig } from "./project-config.js";
import { cleanArchivedRuns } from "./runtime-cleanup.js";
import { RUNS_DIR } from "./run-prepare.js";
import { withTaskWriteLock } from "./run-control.js";
import { archiveDirOf, readTask, saveTask, scanTasks, type StoredTask, type TaskRefusal } from "./task-store.js";
import { matchingFingerprints, RUNTIME_PREFIX, type WorkspaceSnapshot } from "./workspace.js";
import { mergeAndCleanWorktree, taskWorktree, worktreeBranchProblem, type TaskWorktree, type WorktreeIntegration } from "./worktree.js";

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
    /** 工作区里不属于这个任务的改动路径。 */
    readonly others: readonly string[];
    readonly mergeRisks: { readonly dirty: readonly string[]; readonly overlap: readonly string[] } | null;
  } | null;
  readonly openChildren: readonly { readonly id: string; readonly title: string; readonly status: string }[];
}

export interface DeliveryOptions {
  readonly preview?: boolean;
  readonly authorization?: string;
  readonly message?: string;
  readonly messageFile?: string;
}

export type DeliveryResult = TaskRefusal
  | { kind: "preview"; preview: DeliveryPreview; title: string; taskDir: string; result: string | null;
      message: string | undefined; mergeBranch: string | null }
  | { kind: "rolledBack"; reason: "move" | "commit"; error: string; taskDir: string; rollbackProblems: string[] }
  | { kind: "delivered"; title: string; archiveDir: string; archiveRoot: string; worktree: TaskWorktree | null;
      commit: Exclude<DeliveryCommit, { kind: "refused" }> | null; integration: WorktreeIntegration | null;
      cleanup: ReturnType<typeof cleanArchivedRuns> };

export function deliverTask(root: string, id: string, options: DeliveryOptions): DeliveryResult {
  const action = () => performDelivery(root, id, options);
  try {
    return options.preview ? action() : withTaskWriteLock(root, id, action);
  } catch (error) {
    if (error instanceof DeliveryGitError) return { kind: "refused", problems: [error.message] };
    throw error;
  }
}

function performDelivery(root: string, id: string, options: DeliveryOptions): DeliveryResult {
  if (options.message !== undefined && options.messageFile !== undefined) {
    return { kind: "refused", problems: ["--message 与 --message-file 只能选一个"] };
  }
  const loaded = readTask(root, id);
  if (loaded.kind === "refused") return loaded;
  const { stored, document, record } = loaded.task;
  const status = currentStatus(document, record);
  if (status === "delivered" || status === "cancelled") return { kind: "refused", problems: [`任务 ${id} 已经结束（${status}），不能交付`] };
  if (status !== "done") return { kind: "refused", problems: [`任务 ${id} 还没有完成（${status}）；完成之后再交付：knit task close ${id}`] };
  const checkout = deliveryCheckout(root, stored.dir);
  const { git, worktree } = checkout;
  const branchProblem = worktree === null ? null : worktreeBranchProblem(worktree, "交付");
  if (branchProblem !== null) return { kind: "refused", problems: [branchProblem] };
  const config = loadConfig(root);
  if (config.config === null) return { kind: "refused", problems: config.problems };
  const mergeBranch = worktree !== null && config.config.worktree?.autoMerge === true
    ? gitSync(["branch", "--show-current"], root).stdout.trim() || "HEAD"
    : null;
  const authorization = options.authorization?.trim() ?? "";
  if (!options.preview && authorization === "") {
    return { kind: "refused", problems: ["交付要有用户的授权：加 --authorization <引用>，写明用户是在哪条消息里同意的"] };
  }
  if (!options.preview && git && options.message === undefined && options.messageFile === undefined) {
    return { kind: "refused", problems: ["在 Git 仓库里交付要给提交文案：加 --message <文案> 或 --message-file <文件>"] };
  }
  const file = git ? options.messageFile : undefined;
  if (file !== undefined && !statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return { kind: "refused", problems: [`读不到提交文案：${file}`] };
  }
  const message = git ? (file === undefined ? options.message : readFileSync(file, "utf8"))?.trim() : undefined;
  if (message === "") return { kind: "refused", problems: [`提交文案是空的：${file ?? "--message"}`] };
  if (options.preview) {
    const preview = previewDelivery(root, stored, mergeBranch !== null, checkout);
    return { kind: "preview", preview, title: document.frontmatter.title, taskDir: stored.dir, result: document.result, message, mergeBranch };
  }

  const workspace = worktree?.path ?? root;
  const archiveDir = archiveDirOf(stored);
  const archiveRoot = deliveryArchiveRoot(root, stored.dir, worktree, archiveDir);
  const source = join(root, stored.dir);
  const destination = join(archiveRoot, archiveDir);
  const branchTask = join(workspace, stored.dir);
  const moveBranchTask = worktree !== null && existsSync(branchTask) &&
    (archiveRoot === workspace || !ignored(workspace, `${stored.dir}/task.md`));
  const newArchiveParents = [dirname(destination), join(archiveRoot, ".knit/tasks/archive"),
    join(archiveRoot, ".knit/tasks"), join(archiveRoot, ".knit")].filter((path) => !existsSync(path));
  const originalTask = readFileSync(join(source, "task.md"));
  const originalRecord = stored.versions.record === null ? null : readFileSync(join(source, "record.json"));
  const delivered: TaskDocument = { ...document, frontmatter: { ...document.frontmatter, status: "delivered" } };
  const authorized = { ...record, authorization };
  const conflicts = saveTask(root, stored, delivered, authorized);
  if (conflicts.length) return { kind: "refused", problems: conflicts };

  let backup: string | null = null;
  const rollback = (reason: "move" | "commit", error: unknown, problems: string[] = []): DeliveryResult => {
    const attempt = (step: () => void) => {
      try {
        step();
        return true;
      } catch (failure) {
        problems.push(errorText(failure));
        return false;
      }
    };
    const pathExists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    const atSource = reason === "move" || attempt(() => {
      if (pathExists(source)) throw new Error(`无法将 ${destination} 移回已占用的 ${source}`);
      try {
        moveDirectory(destination, source);
      } catch (failure) {
        throw new Error(`无法将 ${destination} 移回 ${source}：${errorText(failure)}`);
      }
    });
    if (backup !== null) {
      const saved = join(backup, "task");
      if (pathExists(saved)) attempt(() => {
        if (pathExists(branchTask)) throw new Error(`无法将 ${saved} 恢复到已占用的 ${branchTask}`);
        try {
          renameSync(saved, branchTask);
        } catch (failure) {
          throw new Error(`无法将 ${saved} 恢复到 ${branchTask}：${errorText(failure)}`);
        }
      });
      const directory = backup;
      if (!pathExists(saved)) attempt(() => rmdirSync(directory));
    }
    newArchiveParents.forEach((path) => attempt(() => {
      if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
    }));
    if (atSource) attempt(() => {
      const expected = { ...stored, record: authorized, versions: {
        task: sha256Text(renderTaskDocument(delivered)), record: sha256Text(renderTaskRecord(authorized)),
      } };
      const conflicts = saveTask(root, expected, originalTask, originalRecord ?? authorized);
      problems.push(...conflicts);
      if (!conflicts.length && originalRecord === null) unlinkSync(join(source, "record.json"));
    });
    return { kind: "rolledBack", reason, error: errorText(error), taskDir: stored.dir, rollbackProblems: problems };
  };
  try {
    if (moveBranchTask) {
      backup = mkdtempSync(join(dirname(workspace), ".knit-delivery-"));
      renameSync(branchTask, join(backup, "task"));
    }
    mkdirSync(dirname(destination), { recursive: true });
    moveDirectory(source, destination);
  } catch (error) {
    return rollback("move", error);
  }
  const commit = git ? commitDelivery(workspace, {
    taskId: id, taskDir: archiveRoot === workspace ? stored.dir : null, archiveDir,
    recorded: [...recordedPaths(record), ...(moveBranchTask && archiveRoot !== workspace ? [stored.dir] : [])], message: message ?? "",
  }) : null;
  if (commit?.kind === "refused") return rollback("commit", commit.error, commit.rollbackProblems);
  if (backup !== null) removeCopy(backup);
  const integration = worktree !== null && mergeBranch !== null ? mergeAndCleanWorktree(root, worktree, mergeBranch) : null;
  // --abort 会恢复主检出里已入库的旧任务目录；当前记录已经在任务 Worktree 的归档里。
  if (integration?.merged === false && archiveRoot !== root) removeCopy(source);
  const cleanup = cleanArchivedRuns(root, id, record.runs, git, config.config.runtime?.retainDays);
  return { kind: "delivered", title: document.frontmatter.title, archiveDir, archiveRoot: integration?.merged ? root : archiveRoot, worktree, commit, integration, cleanup };
}

export function insideGit(root: string): boolean {
  return gitSync(["rev-parse", "--is-inside-work-tree"], root).code === 0;
}

/** 只用派发时的位置算法定位，不建 Worktree。 */
export function deliveryWorktree(root: string, taskDir: string): TaskWorktree | null {
  return deliveryCheckout(root, taskDir).worktree;
}

function deliveryCheckout(root: string, taskDir: string) {
  if (!insideGit(root)) return { git: false, worktree: null };
  const worktree = taskWorktree(root, taskDir);
  return { git: true, worktree: existsSync(join(worktree.path, ".git")) ? worktree : null };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DeliveryGitError extends Error {}

function gitError(command: string, result: ReturnType<typeof gitSync>): string {
  return (result.stderr + result.stdout).trimEnd() || `git ${command} 退出码 ${result.code}`;
}

function ignored(root: string, ...paths: string[]): boolean {
  const result = gitSync(["check-ignore", "--", ...paths], root);
  if (result.code === 0 || result.code === 1) return result.code === 0;
  throw new DeliveryGitError(gitError("check-ignore", result));
}

export function deliveryArchiveRoot(root: string, taskDir: string, worktree: TaskWorktree | null, archiveDir = archiveDirOf({ dir: taskDir })): string {
  if (worktree === null) return root;
  return ignored(worktree.path, `${taskDir}/task.md`, `${archiveDir}/task.md`) ? root : worktree.path;
}

/** 这些路径里现在有改动的文件：含新增、删除和没有跟踪的，不含被 Git 忽略的；目录列出里面的文件。 */
export function changedAmong(root: string, paths: readonly string[]): string[] {
  return workspaceChanges(root, paths).files;
}

function workspaceChanges(root: string, paths: readonly string[], forCommit = false): {
  files: string[]; unstageOnly: string[]; submodules: Set<string>; indexChanges: string[];
} {
  const files: string[] = [];
  const unstageOnly: string[] = [];
  const submodules = new Set<string>();
  // 不带路径时 Git 会列出整个工作区。
  const indexChanges: string[] = [];
  if (!paths.length) return { files, unstageOnly, submodules, indexChanges };
  // status 不接受从 stdin 传路径，将过长的查询拆开，合并重叠目录的结果。
  if (paths.length > 1 && Buffer.byteLength(paths.join("\0")) > 64 * 1024) {
    const mid = Math.ceil(paths.length / 2);
    const left = workspaceChanges(root, paths.slice(0, mid), forCommit);
    const right = workspaceChanges(root, paths.slice(mid), forCommit);
    return {
      files: [...new Set([...left.files, ...right.files])].sort(),
      unstageOnly: [...new Set([...left.unstageOnly, ...right.unstageOnly])].sort(),
      submodules: new Set([...left.submodules, ...right.submodules]),
      indexChanges: [...new Set([...left.indexChanges, ...right.indexChanges])],
    };
  }
  const status = gitSync(["--literal-pathspecs", "status", "--porcelain=v2", "-z", "--no-renames", "--ignore-submodules=dirty", "-uall", "--", ...paths], root);
  if (status.code !== 0) throw new DeliveryGitError(gitError("status", status));
  for (const entry of status.stdout.split("\0")) {
    if (entry.startsWith("? ")) files.push(entry.slice(2));
    if (!entry.startsWith("1 ") && !entry.startsWith("u ")) continue;
    // 普通条目和未合并条目的路径分别从第 9 和第 11 字段开始；路径本身可以含空格。
    const fields = entry.split(" ");
    const path = fields.slice(fields[0] === "1" ? 8 : 10).join(" ");
    // 回滚先恢复 HEAD，再用 porcelain v2 的暂存区 mode 和对象 ID 放回用户原有的暂存。
    if (forCommit && fields[0] === "u") throw new DeliveryGitError(`无法提交尚未解决的 Git 冲突：${path}`);
    if (forCommit && fields[1]?.[0] !== ".") indexChanges.push(`${fields[4]} ${fields[7]}\t${path}`);
    if (fields[2]?.startsWith("S")) submodules.add(path);
    // 仅存在于暂存区的新文件已被删或移走（AD）：只撤暂存，不传给 git add / commit --only。
    if (forCommit && fields[0] === "1" && fields[3] === "000000" && fields[5] === "000000") {
      unstageOnly.push(path);
      continue;
    }
    files.push(path);
  }
  return { files: [...new Set(files)].sort(), unstageOnly: [...new Set(unstageOnly)].sort(), submodules, indexChanges };
}

/** 任务记录的改动路径：主会话登记的和各次执行的合在一起。 */
export function recordedPaths(record: TaskRecord): string[] {
  return [...new Set([...record.changedPaths, ...record.runs.flatMap((run) => run.changedPaths)])].sort();
}

/** 交付会做什么；只读。 */
export function previewDelivery(root: string, stored: StoredTask, autoMerge?: boolean, checkout = deliveryCheckout(root, stored.dir)): DeliveryPreview {
  const id = stored.document?.frontmatter.id;
  const openChildren = scanTasks(root, "active").flatMap((task) => {
    const frontmatter = task.document?.frontmatter;
    if (frontmatter === undefined || frontmatter.parent !== id) return [];
    return ["done", "delivered", "cancelled"].includes(frontmatter.status)
      ? []
      : [{ id: frontmatter.id, title: frontmatter.title, status: frontmatter.status }];
  });
  const archiveDir = archiveDirOf(stored);
  if (!checkout.git) return { archiveDir, archiveRoot: root, worktree: null, commit: null, openChildren };
  const worktree = checkout.worktree;
  const workspace = worktree?.path ?? root;

  const runs = stored.record?.runs ?? [];
  const recorded = stored.record === null ? [] : recordedPaths(stored.record);
  const reviewed = new Set(runs.filter((run) => run.verdict !== null).flatMap((run) => run.changedPaths));
  const { files: dirty, submodules } = workspaceChanges(workspace, ["."]);
  const pathspecs = new Set(recorded.map((path) => posix.normalize(path)));
  const dirtyPaths = new Set<string>();
  const files = dirty.filter((path) => {
    // 保留目录的两种登记写法，也让 Git 的根目录路径 . 和 ./ 匹配整个工作区。
    const prefixes = [path];
    for (const slash of path.matchAll(/\//g)) {
      prefixes.push(path.slice(0, slash.index), path.slice(0, slash.index + 1));
    }
    if (submodules.has(path)) prefixes.push(`${path}/`);
    const selected = pathspecs.has(".") || pathspecs.has("./") || prefixes.some((prefix) => pathspecs.has(prefix));
    if (selected) [...prefixes, ".", "./"].forEach((prefix) => dirtyPaths.add(prefix));
    return selected;
  });
  const included = new Set(files);
  // 和完成任务时一样：失败的执行、需求改之前的执行都不算数。
  const lastReview = stored.record === null ? undefined : lastPassedReview(stored.record);
  const passedFile = lastReview ? join(root, RUNS_DIR, lastReview.id, "after.json") : null;
  // 运行时资料可以清掉：那一份不在了就不标。
  const passed =
    passedFile !== null && existsSync(passedFile)
      ? (JSON.parse(readFileSync(passedFile, "utf8")) as WorkspaceSnapshot).files
      : null;
  const matching = passed === null ? null : matchingFingerprints(workspace, files, passed);
  const taskDir = !ignored(workspace, `${stored.dir}/task.md`, `${archiveDir}/task.md`);
  const outsideTask = (path: string) => !path.startsWith(`${stored.dir}/`) && !path.startsWith(RUNTIME_PREFIX);
  return {
    archiveDir,
    archiveRoot: taskDir ? workspace : root,
    worktree,
    commit: {
      files: files.map((path) => ({
        path,
        reviewed: reviewed.has(path),
        changedAfterReview: matching !== null && !matching.has(path),
      })),
      taskDir,
      unchanged: recorded.filter((path) => !dirtyPaths.has(posix.normalize(path))),
      others: dirty.filter((path) => outsideTask(path) && !included.has(path)),
      mergeRisks: worktree !== null && (autoMerge ?? loadConfig(root).config?.worktree?.autoMerge) ? {
        dirty: changedAmong(root, ["."]).filter(outsideTask),
        overlap: mergeOverlap(root, worktree, files, taskDir ? [stored.dir, archiveDir] : []),
      } : null,
    },
    openChildren,
  };
}

function mergeOverlap(root: string, worktree: TaskWorktree, files: readonly string[], taskDirs: readonly string[]): string[] {
  const base = gitSync(["merge-base", "HEAD", worktree.branch], root).stdout.trim();
  if (!base) return [];
  const changedSinceBase = (ref: string) => gitSync(["diff", "--name-only", "--no-renames", "-z", `${base}..${ref}`, "--"], root)
    .stdout.split("\0").filter(Boolean);
  const main = changedSinceBase("HEAD");
  if (!main.length) return [];
  const task = new Set([...files, ...changedSinceBase(worktree.branch)]);
  return main.filter((path) => task.has(path) || (
    taskDirs.some((dir) => path === dir || path.startsWith(`${dir}/`)) &&
    !ignored(worktree.path, path)
  )).sort();
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
  | { readonly kind: "refused"; readonly error: string; readonly files: readonly string[]; readonly rollbackProblems: string[] };

/** 归档之后把这个任务的文件提交成一次提交；别的改动不动，不推送。 */
export function commitDelivery(root: string, input: CommitDeliveryInput): DeliveryCommit {
  // 任务目录已经移走：原目录里跟踪过的文件是删除，归档目录里的是新增。
  const paths = [...input.recorded, ...(input.taskDir === null ? [] : [input.taskDir, input.archiveDir])];
  try {
    return stageAndCommit(root, input, workspaceChanges(root, paths, true));
  } catch (error) {
    if (error instanceof DeliveryGitError) return { kind: "refused", error: error.message, files: [], rollbackProblems: [] };
    throw error;
  }
}

function stageAndCommit(root: string, input: CommitDeliveryInput, changes: ReturnType<typeof workspaceChanges>): DeliveryCommit {
  const { files, unstageOnly, indexChanges } = changes;
  if (files.length === 0) return { kind: "nothing" };
  const head = gitSync(["rev-parse", "--verify", "--quiet", "HEAD"], root);
  if (head.code !== 0 && head.code !== 1) return { kind: "refused", files: [], error: gitError("rev-parse", head), rollbackProblems: [] };
  const gitPaths = (target: readonly string[], ...args: string[]) => gitSync(["--literal-pathspecs", ...args, "--pathspec-from-file=-", "--pathspec-file-nul"],
    root, undefined, `${target.join("\0")}\0`);
  const toUnstage = [...new Set([...files, ...unstageOnly])].sort();
  const unstage = () => head.code === 0 ? gitPaths(toUnstage, "reset", "-q") : gitPaths(toUnstage, "rm", "--cached", "--ignore-unmatch", "-q", "-f");
  const reset = unstage();
  if (reset.code !== 0) return { kind: "refused", error: gitError("unstage", reset), files: [], rollbackProblems: [] };
  const added = gitPaths(files, "add", "-A");
  const committed = added.code === 0 ? gitPaths(files, "commit", "-q", "--only", "-m", `${input.message.trim()}\n\nKnit-Task: ${input.taskId}`) : added;
  if (committed.code !== 0) {
    const rollbackProblems: string[] = [];
    const reset = unstage();
    if (reset.code !== 0) rollbackProblems.push(gitError("unstage", reset));
    if (indexChanges.length) {
      const restored = gitSync(["update-index", "-z", "--index-info"], root, undefined, `${indexChanges.join("\0")}\0`);
      if (restored.code !== 0) rollbackProblems.push(gitError("update-index", restored));
    }
    return { kind: "refused", error: gitError(added.code === 0 ? "commit" : "add", committed), files, rollbackProblems };
  }
  // commit 已经成功。读取失败只报告核对错误，不能撤回已提交的归档。
  const show = gitSync(["show", "--name-only", "--no-renames", "-z", "--format=", "HEAD"], root);
  const log = gitSync(["log", "-1", "--format=%h %s"], root);
  const actual = new Set(show.stdout.split("\0").filter(Boolean));
  const expected = new Set(files);
  return {
    kind: "committed",
    summary: [log.code === 0 ? log.stdout.trim() : `提交已生成，git log 失败：${gitError("log", log)}`,
      ...(show.code === 0 ? [] : [`无法核对提交文件，git show 失败：${gitError("show", show)}`])].join("\n"),
    extra: show.code === 0 ? [...actual].filter((path) => !expected.has(path)).sort() : [],
    missing: show.code === 0 ? files.filter((path) => !actual.has(path)) : [],
  };
}
