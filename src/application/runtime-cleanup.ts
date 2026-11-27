import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNS_DIR, type TaskRun } from "../contracts/task.js";
import { parseTaskDocument, parseTaskRecord, unparsedTaskId } from "../domain/task.js";
import { gitSync, pidAlive, withFileLock } from "../infrastructure/process.js";
import { DEFAULT_RUNTIME_RETAIN_DAYS } from "./project-config.js";
import { ARCHIVE_DIR, RECORD_FILE, TASK_FILE, taskDirectories } from "./task-store.js";

/** 交付已经成功。扫描出错时保留目录，删除过程中出错也要报告已清理的数量。 */
export function cleanArchivedRuns(root: string, currentId: string, currentRuns: readonly TaskRun[], git: boolean,
  retainDays: number | null = DEFAULT_RUNTIME_RETAIN_DAYS) {
  const result = { retainDays, removed: 0, warnings: [] as string[] };
  if (!retainDays) return result;
  try {
    const checkout = realpathSync(root);
    const runs = join(checkout, RUNS_DIR);
    const runtime = dirname(runs);
    const sessions = join(runtime, "host-sessions");
    const cutoff = Date.now() - retainDays * 86_400_000;
    const present = new Set(directoryEntries(runs).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const sessionLocks = new Set(directoryEntries(sessions)
      .filter((entry) => entry.isFile() && /\.(json|lock)$/.test(entry.name) && expiredFile(join(sessions, entry.name), cutoff))
      .map((entry) => join(sessions, entry.name.endsWith(".lock") ? entry.name : `${entry.name}.lock`)));
    const taskLocks = directoryEntries(runtime).filter((entry) => entry.isFile() && /^k-.*\.lock$/.test(entry.name) &&
      entry.name !== `${currentId}.lock` && expiredFile(join(runtime, entry.name), cutoff));
    if (!present.size && !sessionLocks.size && !taskLocks.length) return result;
    if (git || hasGitMarker(checkout)) {
      const paths = gitSync(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], checkout);
      if (paths.code !== 0) throw new Error(`无法确认 Git 主检出：${paths.stderr.trimEnd()}`);
      const [gitDir, commonDir] = paths.stdout.trimEnd().split("\n");
      if (gitDir !== commonDir) return result;
    }
    for (const lock of sessionLocks) {
      removeExpiredFiles(lock, lock.endsWith(".json.lock") ? lock.slice(0, -5) : null, cutoff, result.warnings);
    }
    if (taskLocks.length) {
      const active = new Set(Array.from(taskDirectories(checkout, "active"), (task) => {
        const file = join(checkout, task.dir, TASK_FILE);
        const markdown = readRegularFile(file) ?? "";
        const id = parseTaskDocument(markdown).document?.frontmatter.id ?? unparsedTaskId(markdown);
        if (!id) throw new Error(`${file} 无法确认活跃任务 ID`);
        return id;
      }));
      for (const entry of taskLocks.filter((entry) => !active.has(entry.name.slice(0, -5)))) {
        removeExpiredFiles(join(runtime, entry.name), null, cutoff, result.warnings);
      }
    }
    if (!present.size) return result;
    const archive = join(checkout, ARCHIVE_DIR);
    if (!lstatSync(archive, { throwIfNoEntry: false })) return result;
    if (realpathSync(archive) !== archive) throw new Error(`${ARCHIVE_DIR} 路径含符号链接`);
    const eligible = expiredRunIds(checkout, currentId, currentRuns, cutoff, present);
    for (const id of eligible) {
      const dir = join(runs, id);
      try {
        if (["worker.json", "pane.json"].some((name) => registeredPidAlive(join(dir, name)))) continue;
        rmSync(dir, { recursive: true });
        result.removed++;
      } catch (error) {
        result.warnings.push(`${id}：${String(error)}`);
      }
    }
  } catch (error) {
    result.warnings.push(String(error));
  }
  return result;
}

// 交付允许在非 Git 项目中运行。Git 探测失败但仍有 .git 时，清理前必须核实检出身份。
function hasGitMarker(dir: string): boolean {
  if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false })) return true;
  const parent = dirname(dir);
  return parent !== dir && hasGitMarker(parent);
}

function directoryEntries(path: string) {
  if (!lstatSync(path, { throwIfNoEntry: false })) return [];
  if (realpathSync(path) !== path) throw new Error(`${path} 路径含符号链接`);
  return readdirSync(path, { withFileTypes: true });
}

function expiredFile(path: string, cutoff: number) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() && stat.mtimeMs < cutoff;
}

function removeExpiredFiles(lock: string, session: string | null, cutoff: number, warnings: string[]) {
  try {
    const before = lstatSync(lock, { throwIfNoEntry: false });
    if (before ? !before.isFile() : !session || !expiredFile(session, cutoff)) return;
    withFileLock(lock, 0, () => {
      if (session) {
        const state = lstatSync(session, { throwIfNoEntry: false });
        if (state && (!state.isFile() || state.mtimeMs >= cutoff)) return;
        if (state) unlinkSync(session);
      }
      // 没有配套锁的旧会话也要加锁，成功清理后连同本次创建的锁一起移除。
      if (!before || expiredFile(lock, cutoff)) unlinkSync(lock);
    }, () => {});
  } catch (error) {
    warnings.push(`${lock}：${String(error)}`);
  }
}

function expiredRunIds(root: string, currentId: string, currentRuns: readonly TaskRun[], cutoff: number, present: ReadonlySet<string>) {
  // 本次任务可能只在 Worktree 里归档。重复登记的 ID 无法唯一归属，也一律保留。
  const seen = new Set(currentRuns.map((run) => run.id));
  const eligible = new Set<string>();
  for (const task of taskDirectories(root, "all")) {
    const dir = join(root, task.dir);
    const file = join(dir, RECORD_FILE);
    const parsed = parseTaskRecord(readRegularFile(file));
    if (!parsed.record) throw new Error(`${file}：${parsed.problems.join("，")}`);
    const runs = parsed.record.runs.filter((run) => present.has(run.id));
    if (!runs.length) continue;
    const markdown = task.archived ? readRegularFile(join(dir, TASK_FILE)) : null;
    const owner = markdown === null ? null : parseTaskDocument(markdown).document?.frontmatter;
    const archived = owner && owner.id !== currentId && (owner.status === "cancelled" || owner.status === "delivered");
    for (const run of runs) {
      if (seen.has(run.id)) {
        eligible.delete(run.id);
        continue;
      }
      seen.add(run.id);
      if (!archived || run.endedAt === null) continue;
      const end = new Date(run.endedAt);
      // 写入时使用 toISOString；Date.parse 也接受单个数字或不存在的日期。
      if (end.getTime() < cutoff && end.toISOString() === run.endedAt) eligible.add(run.id);
    }
  }
  return eligible;
}

function readRegularFile(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`${path} 不是普通文件`);
  return readFileSync(path, "utf8");
}

function registeredPidAlive(file: string) {
  const json = readRegularFile(file);
  if (json === null) return false;
  const registration: unknown = JSON.parse(json);
  if (!registration || typeof registration !== "object" || !("pid" in registration) ||
      typeof registration.pid !== "number" || !Number.isInteger(registration.pid) || registration.pid <= 0) {
    throw new Error(`${file} 缺少有效的进程号`);
  }
  // 清理只需证明进程已退出。PID 已被复用时也保留目录，避免枚举整张进程表。
  return pidAlive(registration.pid);
}
