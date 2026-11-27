/**
 * 任务目录的读写：`.knit/tasks/<目录>/` 是进行中的任务，
 * `.knit/tasks/archive/<YYYY-MM>/<目录>/` 是已归档的。
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256Bytes } from "../contracts/primitives.js";
import type { TaskFrontmatter, TaskRecord } from "../contracts/task.js";
import {
  parseTaskDocument,
  parseTaskRecord,
  renderTaskDocument,
  renderTaskRecord,
  taskDocumentMayHaveId,
  unparsedTaskId,
  type TaskDocument,
} from "../domain/task.js";
import { atomicWrite, InfrastructureError, moveDirectory, readWithVersion } from "../infrastructure/fs.js";
import { gitSync } from "../infrastructure/process.js";
import { projectWorktreeRoot, taskWorktree } from "./worktree.js";

export const TASKS_DIR = ".knit/tasks";
export const ARCHIVE_DIR = `${TASKS_DIR}/archive`;
export const TASK_FILE = "task.md";
export const RECORD_FILE = "record.json";

export interface StoredTask {
  readonly storeRoot: string;
  /** 任务目录，相对所在检出根，用 `/` 分隔。 */
  readonly dir: string;
  readonly archived: boolean;
  /** task.md 开头字段里的 id；文档解析不出来时是从 `id:` 那一行直接取的，连这一行都没有时是 null。 */
  readonly id: string | null;
  /** 文件写坏了、解析不出来时是 null，原因在 problems 里。 */
  readonly document: TaskDocument | null;
  readonly record: TaskRecord | null;
  readonly problems: readonly string[];
  /** 两个文件读入时的 SHA-256；record.json 还不存在时是 null。 */
  readonly versions: { readonly task: string; readonly record: string | null };
}

export interface NewTask {
  readonly title: string;
  readonly slug: string;
  readonly verification: TaskFrontmatter["verification"];
  readonly priority: TaskFrontmatter["priority"];
  readonly parent: string | null;
  readonly dependsOn: readonly string[];
}

export type CreateTaskResult =
  | { readonly created: { readonly id: string; readonly title: string; readonly file: string }; readonly problems: readonly [] }
  | { readonly created: null; readonly problems: readonly string[] };

type TaskScope = "active" | "archived" | "all";

/** 默认包含归档；写坏的任务也带着问题列出来，不挡住其它任务。 */
export function scanTasks(root: string, scope: TaskScope = "all"): StoredTask[] {
  return [...storedTasks(root, taskDirectories(root, scope))];
}

export function hasTasks(root: string): boolean {
  for (const entry of taskDirectories(root, "all")) {
    if (readTaskBytes(root, entry.dir) !== null) return true;
  }
  return false;
}

function readTaskBytes(root: string, dir: string, ids?: ReadonlySet<string>): Buffer | null {
  const path = join(root, dir, TASK_FILE);
  if (!existsSync(path)) return null;
  if (ids === undefined) return readFileSync(path);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(2048);
    const prefix = buffer.subarray(0, readSync(fd, buffer));
    const text = prefix.toString("utf8");
    // 结束标记必须连换行一起读到，缓冲区末尾的 --- 可能只是一行的开头。
    if (/^---\r?\n[\s\S]*?\n---\r?\n/.test(text) && !taskDocumentMayHaveId(text, ids)) return null;
    return Buffer.concat([prefix, readFileSync(fd)]);
  } finally {
    closeSync(fd);
  }
}

function* storedTasks(root: string, directories: ReturnType<typeof taskDirectories>, ids?: ReadonlySet<string>): Generator<StoredTask> {
  for (const entry of directories) {
    const taskFile = readTaskBytes(root, entry.dir, ids);
    if (taskFile === null) continue;
    const markdown = taskFile.toString("utf8");
    if (ids !== undefined && !taskDocumentMayHaveId(markdown, ids)) continue;
    const document = parseTaskDocument(markdown);
    // 写坏的任务也要能按 id 找到，命令才说得出它哪里坏了。
    const taskId = document.document?.frontmatter.id ?? unparsedTaskId(markdown);
    if (ids !== undefined && (taskId === null || !ids.has(taskId))) continue;
    const recordFile = readWithVersion(join(root, entry.dir, RECORD_FILE));
    const record = parseTaskRecord(recordFile?.data.toString("utf8") ?? null);
    yield {
      storeRoot: root,
      dir: entry.dir,
      archived: entry.archived,
      id: taskId,
      document: document.document,
      record: record.record,
      problems: [
        ...document.problems.map((problem) => `${TASK_FILE}：${problem}`),
        ...record.problems.map((problem) => `${RECORD_FILE}：${problem}`),
      ],
      versions: { task: sha256Bytes(taskFile), record: recordFile?.sha256 ?? null },
    };
  }
}

export function* findArchivedTasks(root: string, ids: Iterable<string>): Generator<StoredTask> {
  const remaining = new Set(ids);
  if (!remaining.size) return;
  for (const task of storedTasks(root, archiveDirectories(root, true), remaining)) {
    if (task.document === null) continue;
    yield task;
    remaining.delete(task.document.frontmatter.id);
    if (!remaining.size) return;
  }
}

export function findTask(root: string, id: string, options: { includeWorktrees?: boolean; requireDocument?: boolean } = {}): StoredTask | null {
  return findTasks(root, [id], options).next().value ?? null;
}

function* findTasks(root: string, ids: Iterable<string>, { includeWorktrees = true, requireDocument = false } = {}): Generator<StoredTask, void> {
  const remaining = new Set(ids);
  if (!remaining.size) return;
  for (const task of storedTasks(root, taskDirectories(root, "all", true), remaining)) {
    if (requireDocument && task.document === null) continue;
    yield task;
    remaining.delete(task.id!);
    if (!remaining.size) return;
  }
  if (!includeWorktrees) return;
  const worktrees = projectWorktreeRoot(root);
  for (const entry of directoryEntries(worktrees)) {
    const checkout = join(worktrees, entry.name);
    if (!entry.isDirectory()) {
      const linkedRepo = entry.isSymbolicLink() ? gitCommonDirectory(checkout) : null;
      if (linkedRepo === null || linkedRepo !== gitCommonDirectory(root)) continue;
    }
    // 其它任务的归档可能随建分支时的 HEAD 一起检出，只读该分支自己的交付。
    for (const task of storedTasks(checkout, archiveDirectories(checkout, true, entry.name), remaining)) {
      if (task.document?.frontmatter.status !== "delivered") continue;
      yield task;
      remaining.delete(task.document.frontmatter.id);
      if (!remaining.size) return;
    }
  }
}

export interface LoadedTask {
  readonly root: string;
  readonly stored: StoredTask;
  readonly document: TaskDocument;
  readonly record: TaskRecord;
}

export function shownTaskDirectory(task: LoadedTask): string {
  return task.root === task.stored.storeRoot ? task.stored.dir : join(task.stored.storeRoot, task.stored.dir);
}

/** 归档被忽略时它留在主检出，交付提交仍可能只在任务分支上。 */
export function taskCommit(task: LoadedTask): string | null {
  if (task.document.frontmatter.status !== "delivered") return null;
  const id = task.document.frontmatter.id;
  const log = (ref: string, skip = 0): string | null => {
    // 正文也可能引用完整的标记行，只有 Git 解析出的文末字段才标识交付提交。
    const [summary, ...taskIds] = gitSync([
      "-c", "trailer.separators=:", "log", "-1", `--skip=${skip}`,
      "--format=%h %s%x00%(trailers:key=Knit-Task,valueonly,separator=%x00)",
      "--basic-regexp", "--grep", `^Knit-Task: ${id}$`, ref, "--",
    ], task.root).stdout.trimEnd().split("\0");
    if (!summary) return null;
    return taskIds.includes(id) ? summary : log(ref, skip + 1);
  };
  return log("HEAD") ?? log(`refs/heads/${taskWorktree(task.root, task.stored.dir).branch}`);
}

export interface TaskRefusal {
  readonly kind: "refused";
  readonly problems: readonly string[];
}

export function readTask(root: string, id: string): { kind: "loaded"; task: LoadedTask } | TaskRefusal {
  const stored = findTask(root, id);
  if (stored === null) return { kind: "refused", problems: [`没有任务 ${id}；用 knit task list 查看现有任务`] };
  if (stored.document === null || stored.record === null) return { kind: "refused", problems: stored.problems };
  return { kind: "loaded", task: { root, stored, document: stored.document, record: stored.record } };
}

/** 建目录并写入 task.md；record.json 等第一次有内容要记时再建。 */
export function createTask(root: string, input: NewTask): CreateTaskResult {
  const references = input.parent === null ? input.dependsOn : [input.parent, ...input.dependsOn];
  const known = new Set([...findTasks(root, references)].flatMap((task) => task.document?.frontmatter.id ?? []));
  const problems = [
    ...(input.parent === null || known.has(input.parent) ? [] : [`--parent 指定的任务不存在：${input.parent}`]),
    ...input.dependsOn.filter((id) => !known.has(id)).map((id) => `--depends-on 指定的任务不存在：${id}`),
  ];
  if (problems.length > 0) return { created: null, problems };

  const now = new Date();
  const slug = input.slug.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  const base = [now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-") + `-${slug}`;
  const refs = gitSync(["for-each-ref", "--format=%(refname:lstrip=3)", "refs/heads/knit/"], root);
  if (refs.code !== 0 && (existsSync(join(root, ".git")) || gitCommonDirectory(root) !== null)) {
    return { created: null, problems: [`无法读取本地任务分支：${refs.stderr.trimEnd()}`] };
  }
  mkdirSync(join(root, TASKS_DIR), { recursive: true });
  const name = claimTaskName(root, base, refs.stdout.split("\n").filter(Boolean));
  const dir = `${TASKS_DIR}/${name}`;
  const id = `k-${randomBytes(6).toString("hex")}`;
  atomicWrite({
    path: join(root, dir, TASK_FILE),
    data: Buffer.from(
      renderTaskDocument({
        frontmatter: {
          id,
          title: input.title,
          status: "draft",
          stage: null,
          verification: input.verification,
          parent: input.parent,
          dependsOn: [...input.dependsOn],
          priority: input.priority,
          createdAt: now.toISOString(),
        },
        requirement: "## 目标与范围\n\n## 完成条件\n\n## 待澄清\n\n## 相关资料",
        result: null,
      }),
    ),
    expectedSha256: null,
    mode: 0o644,
  });
  return { created: { id, title: input.title, file: `${dir}/${TASK_FILE}` }, problems: [] };
}

function claimTaskName(root: string, base: string, refs: readonly string[]) {
  const directories = [
    join(root, TASKS_DIR),
    ...directoryNames(join(root, ARCHIVE_DIR)).map((month) => join(root, ARCHIVE_DIR, month)),
    projectWorktreeRoot(root),
  ];
  const branches = refs.map((ref) => ref.split("/", 1)[0]!);
  const taken = new Set([...directories.flatMap((dir) => directoryEntries(dir).map((entry) => entry.name)), ...branches]);
  // 打包后的引用按精确拼写查找，后来写的松散引用却可能遮住它。用已有的 HEAD 文件判断引用库的大小写。
  const gitDir = branches.length > 0 ? gitCommonDirectory(root) : null;
  const foldedBranches = new Set(gitDir !== null && existsSync(join(gitDir, "head")) ? branches.map((name) => name.toLowerCase()) : []);
  for (let suffix = 1; ; suffix++) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    if (taken.has(name) || foldedBranches.has(name.toLowerCase()) || directories.slice(1).some((dir) =>
      lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined)) continue;
    try {
      mkdirSync(join(root, TASKS_DIR, name));
      return name;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}

function gitCommonDirectory(root: string): string | null {
  return gitSync(["rev-parse", "--path-format=absolute", "--git-common-dir"], root).stdout.trimEnd() || null;
}

/**
 * 把改过的两个文件写回。读入之后有文件被别人改过时不写，返回是哪个文件。
 * 先写 record.json 再写 task.md。后者遇到版本冲突时，用刚写入的版本撤回前者。
 */
export function saveTask(root: string, stored: StoredTask, document: TaskDocument | Buffer | null, record: TaskRecord | Buffer): string[] {
  if (root !== stored.storeRoot) return [`任务已在 Worktree 归档，只能读取：${join(stored.storeRoot, stored.dir)}`];
  const taskFile = join(root, stored.dir, TASK_FILE);
  const recordFile = join(root, stored.dir, RECORD_FILE);
  const taskSha = readWithVersion(taskFile)?.sha256;
  const previousRecord = readWithVersion(recordFile);
  const changed = [
    ...(taskSha === stored.versions.task ? [] : [TASK_FILE]),
    ...((previousRecord?.sha256 ?? null) === stored.versions.record ? [] : [RECORD_FILE]),
  ];
  const conflict = (file: string) => `${stored.dir}/${file} 在读入之后被改过，没有写入；重新运行一次`;
  if (changed.length > 0) return changed.map(conflict);
  // 未改动的记录跳过写入，也无需在文档冲突时回滚。
  const writtenRecord = record === stored.record ? undefined
    : writeTaskFile(recordFile, Buffer.isBuffer(record) ? record : Buffer.from(renderTaskRecord(record)), stored.versions.record);
  if (writtenRecord === null) return [conflict(RECORD_FILE)];
  const conflicts: string[] = [];
  try {
    if (document === null || writeTaskFile(taskFile, Buffer.isBuffer(document) ? document : Buffer.from(renderTaskDocument(document)), stored.versions.task)) return [];
    conflicts.push(conflict(TASK_FILE));
  } catch (error) {
    conflicts.push(error instanceof Error ? error.message : String(error));
  }
  if (writtenRecord === undefined) return conflicts;
  if (previousRecord !== null) {
    if (!writeTaskFile(recordFile, previousRecord.data, writtenRecord.sha256)) conflicts.push(conflict(RECORD_FILE));
    return conflicts;
  }
  const currentRecord = readWithVersion(recordFile);
  if (currentRecord === null) return conflicts;
  if (currentRecord.sha256 !== writtenRecord.sha256) return [...conflicts, conflict(RECORD_FILE)];
  unlinkSync(recordFile);
  return conflicts;
}

function writeTaskFile(path: string, data: Buffer, expectedSha256: string | null) {
  try {
    return atomicWrite({ path, data, expectedSha256, mode: 0o644 });
  } catch (error) {
    if (error instanceof InfrastructureError && error.code === "version_conflict") return null;
    throw error;
  }
}

/** 这个任务现在归档的话会在哪个目录：当月的归档目录加原目录名。 */
export function archiveDirOf(stored: Pick<StoredTask, "dir">): string {
  const now = new Date();
  return `${ARCHIVE_DIR}/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(stored.dir)}`;
}

/** 把任务目录移到目标检出当月的归档目录，返回移动后的相对目录。不提交。 */
export function archiveTask(root: string, stored: StoredTask, targetRoot = root): string {
  const dir = archiveDirOf(stored);
  mkdirSync(dirname(join(targetRoot, dir)), { recursive: true });
  moveDirectory(join(root, stored.dir), join(targetRoot, dir));
  return dir;
}

export function* taskDirectories(root: string, scope: TaskScope, newestFirst = false) {
  if (scope !== "archived") {
    for (const name of directoryNames(join(root, TASKS_DIR))) {
      if (name !== "archive") yield { dir: `${TASKS_DIR}/${name}`, archived: false };
    }
  }
  if (scope !== "active") yield* archiveDirectories(root, newestFirst);
}

function* archiveDirectories(root: string, newestFirst: boolean, taskName?: string) {
  const months = directoryNames(join(root, ARCHIVE_DIR));
  for (const month of newestFirst ? months.reverse() : months) {
    const monthDir = `${ARCHIVE_DIR}/${month}`;
    const names = taskName === undefined ? directoryNames(join(root, monthDir)) : [taskName];
    for (const name of names) yield { dir: `${monthDir}/${name}`, archived: true };
  }
}

function directoryEntries(path: string) {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(path, { withFileTypes: true }) : [];
}

function directoryNames(path: string): string[] {
  return directoryEntries(path)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
