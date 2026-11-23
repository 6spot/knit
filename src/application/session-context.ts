import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "../contracts/task.js";
import { batchOf, nextStep, sessionStage } from "../domain/progress.js";
import { PITFALLS_PATH } from "../domain/pitfalls.js";
import { standardsForStage } from "../domain/standards.js";
import { currentStatus, type TaskDocument } from "../domain/task-document.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { RUNS_DIR } from "./run-prepare.js";
import { livePane, liveWorker, startingWorker } from "./run-process.js";
import { readSessionFile, readSessionNotice } from "./run-session.js";
import { loadStandards } from "./standards-store.js";
import { readTask, shownTaskDirectory, taskCommit, type TaskRefusal } from "./task-store.js";
import { readWorkflow } from "./workflow-store.js";
import { taskWorktree } from "./worktree.js";

/** context、run status 和 run wait 展示同一份状态。 */
export function buildTaskStatus(root: string, dir: string | null, workflow: WorkflowDefinition, document: TaskDocument, record: TaskRecord, batchId?: string) {
  const status = currentStatus(document, record);
  const active = record.runs.find((run) => run.endedAt === null);
  const member = batchId === undefined ? active ?? record.runs.at(-1) : record.runs.find((run) => run.batchId === batchId);
  const members = batchOf(record, member).map((run) => {
    const runDir = join(root, RUNS_DIR, run.id);
    const path = `${RUNS_DIR}/${run.id}/report.md`;
    return { run, path, sessionNotice: readSessionNotice(runDir), sessionFile: run.endedAt === null ? readSessionFile(runDir) : run.sessionFile,
      report: run.endedAt !== null && existsSync(join(root, path)) ? path : null,
      starting: startingWorker(root, document.frontmatter.id, run),
      pane: run.endedAt === null && livePane(root, run.id) !== null,
      worker: run.endedAt === null && liveWorker(root, run.id) !== null };
  });
  const worktree = dir === null ? null : taskWorktree(root, dir);
  return {
    frontmatter: document.frontmatter, status, members,
    worktree: worktree !== null && existsSync(join(worktree.path, ".git")) ? worktree : null,
    stageName: workflow.stages.find((stage) => stage.id === members[0]?.run.stage)?.name ?? members[0]?.run.stage,
    next: active === undefined && (status === "ready" || status === "active") ? nextStep(workflow, document.frontmatter.verification, record) : null,
    workflow, record,
  };
}

export type SessionTaskStatus = ReturnType<typeof buildTaskStatus>;

export function buildSessionContext(root: string, id?: string) {
  const loaded = id === undefined ? null : readTask(root, id);
  if (loaded?.kind === "refused") return loaded;
  const workflow = loaded === null ? null : readWorkflow(root);
  if (workflow?.workflow === null) return { kind: "refused", problems: workflow.problems } satisfies TaskRefusal;
  const standards = loadStandards(root);
  const discussionStandards = standardsForStage(standards, "discuss");
  if (loaded === null || workflow === null) return { kind: "context", discussion: discussionStandards, task: null } as const;
  const { document, record, stored } = loaded.task;
  const status = buildTaskStatus(root, stored.dir, workflow.workflow, document, record);
  const stage = sessionStage(workflow.workflow, document.frontmatter.verification, record, status.status);
  // 主会话总有讨论规范；避坑清单只出现一次，取所选任务当前环节的分区。
  const discussion = stage === null || stage === "discuss" ? discussionStandards
    : discussionStandards.filter((standard) => standard.path !== PITFALLS_PATH);
  const discussionPaths = new Set(discussion.map((standard) => standard.path));
  const supplement = stage === null || stage === "discuss" ? null : {
    stage, standards: standardsForStage(standards, stage).filter((standard) => !discussionPaths.has(standard.path)),
  };
  return { kind: "context", discussion, task: {
    dir: shownTaskDirectory(loaded.task), commit: taskCommit(loaded.task), status, supplement,
  } } as const;
}
