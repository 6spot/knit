import type { TaskRecord, TaskStatus } from "../contracts/task.js";
import { countedRuns } from "../domain/progress.js";
import { currentStatus, requirementDigest } from "../domain/task-document.js";
import { clarifyStateOf, scenarioStateOf } from "../domain/task-requirements.js";
import { projectRelative } from "../infrastructure/paths.js";
import { archiveTask, readTask, saveTask, type TaskRefusal } from "./task-store.js";
import { cleanCancelledWorktree, taskWorktree, type WorktreeCleanup } from "./worktree.js";

export interface RequirementProblems {
  readonly kind: "invalidRequirement";
  readonly blocking: number;
  readonly blockingItems: readonly string[];
  readonly scenarioIssues: readonly string[];
  readonly missingScenarios: boolean;
}

export function readyTask(root: string, id: string): TaskRefusal | RequirementProblems | { kind: "alreadyReady" } |
  { kind: "ready"; scenarios: number; assumed: number } {
  const loaded = readTask(root, id);
  if (loaded.kind === "refused") return loaded;
  const { stored, document, record } = loaded.task;
  const status = currentStatus(document, record);
  if (status === "ready") return { kind: "alreadyReady" };
  if (status === "active") {
    return { kind: "refused", problems: [`任务正在 ${document.frontmatter.stage} 环节，需求没有变化，不需要重新确认`] };
  }
  if (status !== "draft") return { kind: "refused", problems: [`任务已经结束（${status}）；要继续做就新建一个任务`] };
  const clarify = clarifyStateOf(document.requirement);
  const scenarios = scenarioStateOf(document.requirement);
  const unwritten = document.frontmatter.verification === "independent" && scenarios.scenarios.length === 0;
  if (clarify.blocking > 0 || scenarios.issues.length > 0 || unwritten) {
    return { kind: "invalidRequirement", blocking: clarify.blocking, blockingItems: clarify.blockingItems,
      scenarioIssues: scenarios.issues.map((issue) => issue.message), missingScenarios: unwritten };
  }
  const conflicts = saveTask(root, stored,
    { ...document, frontmatter: { ...document.frontmatter, status: "ready", stage: null } },
    { ...record, confirmedDigest: requirementDigest(document) },
  );
  if (conflicts.length > 0) return { kind: "refused", problems: conflicts };
  return { kind: "ready", scenarios: scenarios.scenarios.length, assumed: clarify.assumed };
}

interface CloseOptions {
  readonly result: string;
  readonly paths: readonly string[];
  readonly reason?: string;
}

export function closeTask(root: string, id: string, options: CloseOptions): TaskRefusal | { kind: "done" } {
  const loaded = readTask(root, id);
  if (loaded.kind === "refused") return loaded;
  const { stored, document, record } = loaded.task;
  const result = options.result.trim();
  if (result === "") return { kind: "refused", problems: ["--result 不能为空：写做成了什么、完成条件是否都满足、怎么验证的"] };
  const refusal = closeRefusal(currentStatus(document, record), id);
  if (refusal !== null) return { kind: "refused", problems: [refusal] };
  const unreviewed = document.frontmatter.verification === "independent" &&
    countedRuns(record).findLast((run) => run.verdict !== null)?.verdict !== "pass";
  if (unreviewed && options.reason === undefined) {
    return { kind: "refused", problems: ["独立审查的任务要在审查通过后才能完成；用户明确要求直接完成时，加 --reason <理由>"] };
  }
  const paths = options.paths.map((path) => ({ path, relative: projectRelative(path) }));
  const problems = paths.filter((item) => item.relative === null).map((item) => `--paths 要写项目内的相对路径：${item.path}`);
  if (problems.length > 0) return { kind: "refused", problems };
  const running = unfinishedRunRefusal(record, id);
  if (running !== null) return running;
  const conflicts = saveTask(root, stored, {
    ...document,
    frontmatter: { ...document.frontmatter, status: "done", stage: null },
    result: unreviewed ? `${result}\n\n没有经过独立审查，直接完成：${options.reason}` : result,
  }, { ...record, changedPaths: [...new Set([...record.changedPaths, ...paths.flatMap((item) => item.relative ?? [])])].sort() });
  return conflicts.length ? { kind: "refused", problems: conflicts } : { kind: "done" };
}

function closeRefusal(status: TaskStatus, id: string): string | null {
  if (status === "ready" || status === "active") return null;
  if (status === "draft") return `需求还没有确认，或确认之后改过；先运行 knit task ready ${id}`;
  if (status === "done") return "任务已经完成；要改总结直接编辑 task.md 的「结果」";
  return `任务已经结束（${status}），不能再记为完成`;
}

function unfinishedRunRefusal(record: TaskRecord, id: string): TaskRefusal | null {
  const running = record.runs.find((run) => run.endedAt === null);
  return running === undefined ? null : {
    kind: "refused", problems: [`任务 ${id} 的执行 ${running.id} 还没有结束；等它结束，或运行 knit run cancel ${id}`],
  };
}

export function cancelTask(root: string, id: string, options: { readonly reason: string }): TaskRefusal |
  { kind: "cancelled"; archiveDir: string; cleanup: WorktreeCleanup } {
  const loaded = readTask(root, id);
  if (loaded.kind === "refused") return loaded;
  const { stored, document, record } = loaded.task;
  const reason = options.reason.trim();
  if (reason === "") return { kind: "refused", problems: ["--reason 不能为空：写为什么不做了"] };
  const status = document.frontmatter.status;
  if (status === "delivered" || status === "cancelled") return { kind: "refused", problems: [`任务已经结束（${status}），不能取消`] };
  const running = unfinishedRunRefusal(record, id);
  if (running !== null) return running;
  const conflicts = saveTask(root, stored, {
    ...document,
    frontmatter: { ...document.frontmatter, status: "cancelled", stage: null },
    result: [...(document.result ? [document.result] : []), `已取消：${reason}`].join("\n\n"),
  }, record);
  if (conflicts.length > 0) return { kind: "refused", problems: conflicts };
  const archiveDir = archiveTask(root, stored);
  return { kind: "cancelled", archiveDir, cleanup: cleanCancelledWorktree(root, taskWorktree(root, stored.dir)) };
}
