import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deliverTask } from "../dist/application/delivery.js";
import { buildSessionContext } from "../dist/application/session-context.js";
import { cancelTask, closeTask, readyTask } from "../dist/application/task-lifecycle.js";
import { createTask, findTask } from "../dist/application/task-store.js";
import { ensureWorktree, taskWorktree } from "../dist/application/worktree.js";
import { project } from "./helpers/cli.mjs";
import { git } from "./helpers/git.mjs";
import { runProject } from "./helpers/run.mjs";

function draft(root) {
  const result = createTask(root, { title: "应用层用例", slug: "app", verification: "self", priority: "P2", parent: null, dependsOn: [] });
  assert.deepEqual(result.problems, []);
  return result.created.id;
}

test("应用层确认、完成并交付主检出任务，Git 拒绝时恢复原记录且可以重试", (t) => {
  const root = runProject(t);
  const id = draft(root);
  assert.deepEqual(readyTask(root, id), { kind: "ready", scenarios: 0, assumed: 0 });
  assert.deepEqual(readyTask(root, id), { kind: "alreadyReady" });
  assert.deepEqual(closeTask(root, id, { result: "完成", paths: ["code.txt"] }), { kind: "done" });
  writeFileSync(join(root, "code.txt"), "code\n");
  const before = findTask(root, id);
  const messageFile = join(project(t), "message");
  writeFileSync(messageFile, "完成应用层用例\n");
  const hook = join(root, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'hook refusal' >&2\nexit 1\n", { mode: 0o755 });
  const options = { authorization: "user:delivery", messageFile };
  const rejected = deliverTask(root, id, options);
  assert.equal(rejected.kind, "rolledBack");
  assert.equal(rejected.reason, "commit");
  assert.match(rejected.error, /hook refusal\n/);
  assert.equal(rejected.taskDir, before.dir);
  assert.equal(before.document.frontmatter.status, "done");
  assert.equal(before.record.authorization, null);
  assert.deepEqual(findTask(root, id), before);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  rmSync(hook);
  const delivered = deliverTask(root, id, options);
  assert.equal(delivered.kind, "delivered");
  assert.equal(delivered.worktree, null);
  assert.deepEqual(delivered.commit, { kind: "committed", summary: git(root, "log", "-1", "--format=%h %s"), extra: [], missing: [] });
  const archived = findTask(root, id);
  assert.equal(delivered.archiveDir, archived.dir);
  assert.equal(archived.document.frontmatter.status, "delivered");
  assert.equal(archived.record.authorization, options.authorization);
});

test("应用层会话上下文按环节去重，取消归档后返回已删除的 Worktree、分支和丢弃数", (t) => {
  const root = runProject(t);
  const dir = join(root, ".knit/standards");
  mkdirSync(dir);
  writeFileSync(join(dir, "shared.md"), "---\ntitle: 共享\nstages: [discuss, implement]\n---\n正文\n");
  writeFileSync(join(dir, "implement.md"), "---\ntitle: 实现\nstages: [implement]\n---\n正文\n");
  const id = draft(root);
  assert.equal(readyTask(root, id).kind, "ready");
  const context = buildSessionContext(root, id);
  assert.equal(context.kind, "context");
  assert.deepEqual(context.discussion.map((standard) => standard.title), ["讨论规范", "任务拆分规范", "任务编写规范", "共享"]);
  assert.equal(context.task.status.status, "ready");
  assert.equal(context.task.supplement.stage, "implement");
  assert.deepEqual(context.task.supplement.standards.map((standard) => standard.title), ["实现"]);
  const worktree = taskWorktree(root, context.task.dir);
  assert.deepEqual(ensureWorktree(root, worktree).problems, []);
  writeFileSync(join(worktree.path, "a.txt"), "dirty\n");
  const cancelled = cancelTask(root, id, { reason: "不再需要" });
  assert.equal(cancelled.kind, "cancelled");
  assert.deepEqual(cancelled.cleanup, { kind: "removed", worktree, discardedFiles: 1, branch: "deleted" });
  assert.equal(cancelled.archiveDir, findTask(root, id).dir);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(root, "branch", "--list", worktree.branch), "");
});
