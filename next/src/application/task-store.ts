/**
 * 任务目录的读写：`.knit/tasks/<目录>/` 是进行中的任务，
 * `.knit/tasks/archive/<YYYY-MM>/<目录>/` 是已归档的。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import type { TaskFrontmatter, TaskRecord } from "../contracts/task.js";
import { parseTaskDocument, renderTaskDocument, type TaskDocument } from "../domain/task-document.js";
import { parseTaskRecord, renderTaskRecord } from "../domain/task-record.js";
import { atomicWrite, readWithVersion } from "../infrastructure/atomic.js";

export const TASKS_DIR = ".knit/tasks";
export const ARCHIVE_DIR = `${TASKS_DIR}/archive`;
export const TASK_FILE = "task.md";
export const RECORD_FILE = "record.json";

export interface StoredTask {
  /** 任务目录，相对项目根，用 `/` 分隔。 */
  readonly dir: string;
  readonly archived: boolean;
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
  | { readonly created: { readonly id: string; readonly file: string }; readonly problems: readonly [] }
  | { readonly created: null; readonly problems: readonly string[] };

/** 所有任务，含已归档的。写坏的任务也列出来，带着问题，不挡住其它任务。 */
export function scanTasks(root: string): StoredTask[] {
  return taskDirectories(root).flatMap((entry) => {
    const taskFile = readWithVersion(join(root, entry.dir, TASK_FILE));
    if (taskFile === null) return [];
    const recordFile = readWithVersion(join(root, entry.dir, RECORD_FILE));
    const document = parseTaskDocument(taskFile.data.toString("utf8"));
    const record = parseTaskRecord(recordFile?.data.toString("utf8") ?? null);
    return [
      {
        dir: entry.dir,
        archived: entry.archived,
        document: document.document,
        record: record.record,
        problems: [
          ...document.problems.map((problem) => `${TASK_FILE}：${problem}`),
          ...record.problems.map((problem) => `${RECORD_FILE}：${problem}`),
        ],
        versions: { task: taskFile.sha256, record: recordFile?.sha256 ?? null },
      },
    ];
  });
}

export function findTask(root: string, id: string): StoredTask | null {
  return scanTasks(root).find((task) => task.document?.frontmatter.id === id) ?? null;
}

/** 建目录并写入 task.md；record.json 等第一次有内容要记时再建。 */
export function createTask(root: string, input: NewTask): CreateTaskResult {
  const known = new Set(scanTasks(root).map((task) => task.document?.frontmatter.id));
  const problems = [
    ...(input.parent === null || known.has(input.parent) ? [] : [`--parent 指定的任务不存在：${input.parent}`]),
    ...input.dependsOn.filter((id) => !known.has(id)).map((id) => `--depends-on 指定的任务不存在：${id}`),
  ];
  if (problems.length > 0) return { created: null, problems };

  const now = new Date();
  const slug = input.slug.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  const base = [now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-") + `-${slug}`;
  const taken = new Set(taskDirectories(root).map((entry) => basename(entry.dir)));
  // 候选比已有目录多一个，所以一定有一个没被占用。
  const name = [base, ...Array.from(taken, (_, index) => `${base}-${index + 2}`)].find((candidate) => !taken.has(candidate)) ?? base;
  const dir = `${TASKS_DIR}/${name}`;
  const id = `k-${randomBytes(6).toString("hex")}`;
  // 先建目录：atomicWrite 自己建的目录只有本人能进，而任务目录要入库。
  mkdirSync(join(root, dir), { recursive: true });
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
  return { created: { id, file: `${dir}/${TASK_FILE}` }, problems: [] };
}

/**
 * 把改过的两个文件写回。读入之后有文件被别人改过时不写，返回是哪个文件。
 * 先写 record.json 再写 task.md：中间断掉时状态和确认摘要对不上，任务按 draft 算，重新确认一次即可。
 */
export function saveTask(root: string, stored: StoredTask, document: TaskDocument, record: TaskRecord): string[] {
  const taskFile = join(root, stored.dir, TASK_FILE);
  const recordFile = join(root, stored.dir, RECORD_FILE);
  const changed = [
    ...(readWithVersion(taskFile)?.sha256 === stored.versions.task ? [] : [TASK_FILE]),
    ...((readWithVersion(recordFile)?.sha256 ?? null) === stored.versions.record ? [] : [RECORD_FILE]),
  ];
  if (changed.length > 0) return changed.map((file) => `${stored.dir}/${file} 在读入之后被改过，没有写入；重新运行一次`);
  // 记录没有改动时不写：还没有内容要记的任务不会多出一个空的 record.json。
  if (record !== stored.record) {
    atomicWrite({
      path: recordFile,
      data: Buffer.from(renderTaskRecord(record)),
      expectedSha256: stored.versions.record,
      mode: 0o644,
    });
  }
  atomicWrite({
    path: taskFile,
    data: Buffer.from(renderTaskDocument(document)),
    expectedSha256: stored.versions.task,
    mode: 0o644,
  });
  return [];
}

/** 把任务目录移到当月的归档目录，返回移动后的目录。不提交。 */
export function archiveTask(root: string, stored: StoredTask): string {
  const now = new Date();
  const month = `${ARCHIVE_DIR}/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = `${month}/${basename(stored.dir)}`;
  mkdirSync(join(root, month), { recursive: true });
  renameSync(join(root, stored.dir), join(root, dir));
  return dir;
}

function taskDirectories(root: string): { dir: string; archived: boolean }[] {
  return [
    ...subdirectories(root, TASKS_DIR)
      .filter((dir) => dir !== ARCHIVE_DIR)
      .map((dir) => ({ dir, archived: false })),
    ...subdirectories(root, ARCHIVE_DIR)
      .flatMap((month) => subdirectories(root, month))
      .map((dir) => ({ dir, archived: true })),
  ];
}

function subdirectories(root: string, relative: string): string[] {
  if (!existsSync(join(root, relative))) return [];
  return readdirSync(join(root, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${relative}/${entry.name}`)
    .sort();
}
