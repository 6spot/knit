/**
 * 结束一次执行：不管是正常做完、启动失败、被取消还是进程意外退出，都在任务的执行记录里
 * 记下结束时间、结论或失败原因、改动的文件。执行者提交了改动或改了受保护的文件，记为失败。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { RUNS_DIR } from "./run-prepare.js";
import { findTask, saveTask } from "./task-store.js";
import { changesBetween, protectedChanges, takeSnapshot, type WorkspaceSnapshot } from "./workspace.js";
import { taskWorktree } from "./worktree.js";

export interface FinishRunInput {
  readonly root: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workflow: WorkflowDefinition;
  /** 执行者给的结论；环节不要结论时是 null。 */
  readonly verdict: string | null;
  /** 调用方已经知道的失败原因（启动失败、被取消等）；没有时是 null。 */
  readonly failure: string | null;
  readonly sessionFile: string | null;
}

/** 返回问题的列表；空的表示记好了。 */
export function finishRun(input: FinishRunInput): string[] {
  return finishAttempt(input, 3);
}

function finishAttempt(input: FinishRunInput, attemptsLeft: number): string[] {
  const { root, taskId, runId } = input;
  const stored = findTask(root, taskId);
  const run = stored?.record?.runs.find((item) => item.id === runId && item.endedAt === null);
  if (stored == null || stored.document === null || stored.record === null || run === undefined) {
    return [`执行 ${runId} 不在任务 ${taskId} 的记录里，或者已经结束`];
  }
  const beforeFile = join(root, RUNS_DIR, runId, "before.json");
  const after = existsSync(beforeFile) ? takeSnapshot(taskWorktree(root, stored.dir).path) : null;
  const changes =
    after === null
      ? { changedPaths: [], head: null }
      : changesBetween(JSON.parse(readFileSync(beforeFile, "utf8")) as WorkspaceSnapshot, after);
  const guarded = protectedChanges(changes.changedPaths, input.workflow);
  const failure =
    input.failure ??
    (changes.head !== null
      ? `执行者提交了改动：HEAD 从 ${changes.head.before?.slice(0, 7) ?? "没有提交"} 变成 ${changes.head.after?.slice(0, 7) ?? "没有提交"}`
      : guarded.length > 0
        ? `执行者改了受保护的文件：${guarded.join("、")}`
        : null);
  const conflicts = saveTask(root, stored, stored.document, {
    ...stored.record,
    runs: stored.record.runs.map((item) =>
      item === run
        ? {
            ...item,
            endedAt: new Date().toISOString(),
            verdict: failure === null ? input.verdict : null,
            failure,
            // 任务目录在交付时整个提交，不逐个记。
            changedPaths: changes.changedPaths.filter((path) => !path.startsWith(`${stored.dir}/`)),
            sessionFile: input.sessionFile,
          }
        : item,
    ),
  });
  // 审查通过时的工作区留一份：交付预览拿它看哪些文件在审查通过之后又改过。
  if (conflicts.length === 0 && after !== null && failure === null && input.verdict === "pass") {
    writeFileSync(join(root, RUNS_DIR, runId, "after.json"), `${JSON.stringify(after, null, 2)}\n`);
  }
  // 任务文件在读入之后被别人改过时重新读一遍再做。
  return conflicts.length === 0 || attemptsLeft === 1 ? conflicts : finishAttempt(input, attemptsLeft - 1);
}
