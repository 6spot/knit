/**
 * 结束一次执行：不管是正常做完、启动失败、被取消还是进程意外退出，都在任务的执行记录里
 * 记下结束时间、结论或失败原因、改动的文件。执行者提交了改动或改了受保护的文件，记为失败。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentRegistry } from "../contracts/agent.js";
import { batchOf } from "../domain/progress.js";
import { workflowPrompts, type WorkflowDefinition } from "../domain/workflow.js";
import { atomicWrite } from "../infrastructure/fs.js";
import { withTaskRunLock } from "./run-control.js";
import { RUNS_DIR } from "./run-prepare.js";
import { logWorkerError, readSessionFile } from "./run-execute.js";
import { findTask, saveTask } from "./task-store.js";
import { changesBetween, fingerprint, protectedChanges, takeSnapshot, type WorkspaceSnapshot } from "./workspace.js";
import { taskWorktree } from "./worktree.js";

export interface FinishRunInput {
  readonly agents: AgentRegistry;
  readonly root: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workflow: WorkflowDefinition;
  /** 执行者给的结论；环节不要结论时是 null。 */
  readonly verdict: string | null;
  /** 调用方已经知道的失败原因（启动失败、被取消等）；没有时是 null。 */
  readonly failure: string | null;
  readonly sessionFile: string | null;
  readonly resumeId?: string | null;
}

/** 返回问题的列表；空的表示记好了。 */
export function finishRun(input: FinishRunInput): string[] {
  return finishAttempt(input, 3);
}

function finishAttempt(input: FinishRunInput, attemptsLeft: number, previousCleanupFailure?: string | null): string[] {
  const { root, taskId, runId } = input;
  const stored = findTask(root, taskId);
  const run = stored?.record?.runs.find((item) => item.id === runId && item.endedAt === null);
  if (stored == null || stored.document === null || stored.record === null || run === undefined) {
    return [`执行 ${runId} 不在任务 ${taskId} 的记录里，或者已经结束`];
  }
  const cwd = taskWorktree(root, stored.dir).path;
  const dir = join(root, RUNS_DIR, runId);
  const cleanupFailure = previousCleanupFailure === undefined
    ? cleanRun(input.agents[run.agent ?? "pi"], cwd, dir)
    : previousCleanupFailure;
  const beforeFile = join(dir, "before.json");
  const before = existsSync(beforeFile) ? JSON.parse(readFileSync(beforeFile, "utf8")) as WorkspaceSnapshot : null;
  const after = before === null ? null : takeSnapshot(cwd, workflowPrompts(input.workflow), before);
  if (after && run.batchId) {
    for (const member of batchOf(stored.record, run)) {
      const memberDir = join(root, RUNS_DIR, member.id);
      for (const [path, copy] of Object.entries(input.agents[member.agent ?? "pi"].workspaceCopies ?? {})) {
        if (after.files[path] !== undefined && existsSync(join(memberDir, copy)) && after.files[path] === fingerprint(memberDir, copy)) {
          delete after.files[path];
        }
      }
    }
  }
  const changes =
    before === null || after === null
      ? { changedPaths: [], head: null }
      : changesBetween(before, after);
  const guarded = protectedChanges(changes.changedPaths, input.workflow);
  const violation = changes.head !== null
    ? `执行者提交了改动：HEAD 从 ${changes.head.before?.slice(0, 7) ?? "没有提交"} 变成 ${changes.head.after?.slice(0, 7) ?? "没有提交"}`
    : guarded.length > 0
      ? `执行者改了受保护的文件：${guarded.join("、")}`
      : null;
  const session = (() => {
    try {
      return { file: input.sessionFile ?? readSessionFile(dir), error: null };
    } catch (error) {
      logWorkerError(dir, error);
      return { file: null, error: `读取会话路径失败：${String(error)}` };
    }
  })();
  const failure = [input.failure, violation, cleanupFailure, session.error].filter(Boolean).join("；") || null;
  const declared = input.workflow.stages.find((stage) => stage.id === run.stage)?.report;
  const verdict = failure === null && input.verdict && declared && Object.hasOwn(declared, "verdict") ? input.verdict : null;
  const persist = () => {
    const latest = findTask(root, taskId);
    if (!latest?.document || !latest.record?.runs.some((item) => item.id === runId && item.endedAt === null)) {
      return [`执行 ${runId} 不在任务 ${taskId} 的记录里，或者已经结束`];
    }
    // 等待者一旦读到 pass 就能开始交付预览，先发布它会读取的快照。
    if (after !== null && verdict === "pass") {
      atomicWrite({ path: join(dir, "after.json"), data: Buffer.from(`${JSON.stringify(after, null, 2)}\n`) });
    }
    return saveTask(root, latest, null, {
      ...latest.record,
      runs: latest.record.runs.map((item) =>
        item.id === runId
        ? {
            ...item,
            endedAt: new Date().toISOString(),
            verdict,
            failure,
            ...(violation !== null || cleanupFailure !== null ? { resumeBlocked: true } : {}),
            // 任务目录在交付时整个提交，不逐个记。
            changedPaths: changes.changedPaths.filter((path) => !path.startsWith(`${stored.dir}/`)),
            resumeId: input.resumeId ?? null,
            sessionFile: recordedSessionPath(root, session.file),
          }
          : item,
      ),
    });
  };
  const conflicts = withTaskRunLock(root, taskId, 5000, persist,
    () => [`任务 ${taskId} 正在写入执行记录，请稍后重试`]);
  // 任务文件在读入之后被别人改过时重新读一遍再做。
  return conflicts.length === 0 || attemptsLeft === 1 ? conflicts : finishAttempt(input, attemptsLeft - 1, cleanupFailure);
}

function cleanRun(agent: AgentRegistry[keyof AgentRegistry], cwd: string, dir: string): string | null {
  try {
    agent.cleanRun?.(cwd, dir);
    return null;
  } catch (error) {
    return `执行清理失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function recordedSessionPath(root: string, file: string | null): string | null {
  if (file === null || !isAbsolute(file)) return file;
  const path = relative(root, file);
  return path.startsWith("..") || isAbsolute(path) ? file : path.split(sep).join("/");
}
