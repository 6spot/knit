import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "../contracts/task.js";
import { nextStep, sessionStage } from "../domain/progress.js";
import { standardsForStage } from "../domain/standards.js";
import { currentStatus, type TaskDocument } from "../domain/task-document.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { RUNS_DIR } from "./run-prepare.js";
import { livePane, liveWorker } from "./run-process.js";
import { loadStandards } from "./standards-store.js";
import { readTask, shownTaskDirectory, taskCommit, type TaskRefusal } from "./task-store.js";
import { readWorkflow } from "./workflow-store.js";
import { taskWorktree } from "./worktree.js";

/** context、run status 和 run wait 展示同一份状态。 */
export function buildTaskStatus(root: string, dir: string | null, workflow: WorkflowDefinition, document: TaskDocument, record: TaskRecord) {
  const status = currentStatus(document, record);
  const last = record.runs.at(-1);
  const running = last?.endedAt === null;
  const reportPath = last === undefined || running ? null : `${RUNS_DIR}/${last.id}/report.md`;
  const worktree = dir === null ? null : taskWorktree(root, dir);
  return {
    frontmatter: document.frontmatter, status, last,
    worktree: worktree !== null && existsSync(join(worktree.path, ".git")) ? worktree : null,
    stageName: workflow.stages.find((stage) => stage.id === last?.stage)?.name ?? last?.stage,
    report: reportPath !== null && existsSync(join(root, reportPath)) ? reportPath : null,
    pane: running && livePane(root, last.id) !== null,
    worker: running && liveWorker(root, last.id) !== null,
    next: !running && (status === "ready" || status === "active") ? nextStep(workflow, document.frontmatter.verification, record) : null,
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
  const discussion = standardsForStage(standards, "discuss");
  if (loaded === null || workflow === null) return { kind: "context", discussion, task: null } as const;
  const { document, record, stored } = loaded.task;
  const status = buildTaskStatus(root, stored.dir, workflow.workflow, document, record);
  const stage = sessionStage(workflow.workflow, document.frontmatter.verification, record, status.status);
  const discussionPaths = new Set(discussion.map((standard) => standard.path));
  const supplement = stage === null || stage === "discuss" ? null : {
    stage, standards: standardsForStage(standards, stage).filter((standard) => !discussionPaths.has(standard.path)),
  };
  return { kind: "context", discussion, task: {
    dir: shownTaskDirectory(loaded.task), commit: taskCommit(loaded.task), status, supplement,
  } } as const;
}
