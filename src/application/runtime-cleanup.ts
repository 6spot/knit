import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNS_DIR, type TaskRun } from "../contracts/task.js";
import { parseTaskDocument, parseTaskRecord } from "../domain/task.js";
import { gitSync, pidAlive } from "../infrastructure/process.js";
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
    if (!lstatSync(runs, { throwIfNoEntry: false })) return result;
    if (realpathSync(runs) !== runs) throw new Error(`${RUNS_DIR} 路径含符号链接`);
    const directories = readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (!directories.length) return result;
    if (git || hasGitMarker(checkout)) {
      const paths = gitSync(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], checkout);
      if (paths.code !== 0) throw new Error(`无法确认 Git 主检出：${paths.stderr.trimEnd()}`);
      const [gitDir, commonDir] = paths.stdout.trimEnd().split("\n");
      if (gitDir !== commonDir) return result;
    }
    const archive = join(checkout, ARCHIVE_DIR);
    if (!lstatSync(archive, { throwIfNoEntry: false })) return result;
    if (realpathSync(archive) !== archive) throw new Error(`${ARCHIVE_DIR} 路径含符号链接`);
    const eligible = expiredRunIds(checkout, currentId, currentRuns, Date.now() - retainDays * 86_400_000);
    for (const entry of directories.filter((entry) => eligible.has(entry.name))) {
      const dir = join(runs, entry.name);
      try {
        if (["worker.json", "pane.json"].some((name) => registeredPidAlive(join(dir, name)))) continue;
        rmSync(dir, { recursive: true });
        result.removed++;
      } catch (error) {
        result.warnings.push(`${entry.name}：${String(error)}`);
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

function expiredRunIds(root: string, currentId: string, currentRuns: readonly TaskRun[], cutoff: number) {
  // 本次任务可能只在 Worktree 里归档。重复登记的 ID 无法唯一归属，也一律保留。
  const seen = new Set(currentRuns.map((run) => run.id));
  const eligible = new Set<string>();
  for (const task of taskDirectories(root, "all")) {
    const dir = join(root, task.dir);
    const file = join(dir, RECORD_FILE);
    const parsed = parseTaskRecord(readRegularFile(file));
    if (!parsed.record) throw new Error(`${file}：${parsed.problems.join("，")}`);
    if (!parsed.record.runs.length) continue;
    const markdown = task.archived ? readRegularFile(join(dir, TASK_FILE)) : null;
    const owner = markdown === null ? null : parseTaskDocument(markdown).document?.frontmatter;
    const archived = owner && owner.id !== currentId && (owner.status === "cancelled" || owner.status === "delivered");
    for (const run of parsed.record.runs) {
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
