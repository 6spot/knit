import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { commitAll } from "./helpers/git.mjs";
import { agents, readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const fileOf = (dir, task, file) => readFileSync(join(dir, task.dir, file), "utf8");
const lastRun = (dir, task) => JSON.parse(fileOf(dir, task, "record.json")).runs.at(-1);
function prepare(dir, task) {
  const { run, problems } = prepareRun({
    root: dir,
    taskId: task.id,
    workflow: workflowOf(dir),
    config: loadConfig(dir).config,
    model: null,
  });
  assert.deepEqual(problems, []);
  return run;
}
const finish = (dir, task, run, { verdict = null, failure = null, sessionFile = null } = {}) =>
  finishRun({ agents, root: dir, taskId: task.id, runId: run.id, workflow: workflowOf(dir), verdict, failure, sessionFile });
function put(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

test("正常结束时记下结论和改动文件", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  assert.deepEqual(finish(dir, task, prepare(dir, task)), []);
  const run = prepare(dir, task);
  assert.equal(run.stage.id, "review");
  const started = lastRun(dir, task);
  const taskFile = fileOf(dir, task, "task.md");

  put(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");
  put(worktreeOf(dir, task), `${task.dir}/plan.md`, "# 计划\n");
  put(dir, `${run.dir}/worker.log`, "started\n");
  assert.deepEqual(finish(dir, task, run, { verdict: "pass", sessionFile: `${run.dir}/session.jsonl` }), []);

  const ended = lastRun(dir, task);
  assert.ok(!Number.isNaN(Date.parse(ended.endedAt)));
  assert.deepEqual(ended, {
    ...started,
    endedAt: ended.endedAt,
    verdict: "pass",
    failure: null,
    changedPaths: ["src/a.ts"],
    sessionFile: `${run.dir}/session.jsonl`,
  });
  assert.equal(fileOf(dir, task, "task.md"), taskFile);
  assert.match(taskFile, /^status: active$/m);
  assert.match(taskFile, /^stage: review$/m);
});

test("提交了改动或改了受保护的文件时记为失败", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);

  const committed = prepare(dir, task);
  put(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");
  commitAll(worktreeOf(dir, task), "executor commit");
  assert.deepEqual(finish(dir, task, committed, { verdict: "pass" }), []);
  const first = lastRun(dir, task);
  assert.equal(first.verdict, null);
  assert.match(first.failure, /^执行者提交了改动：HEAD 从 [0-9a-f]{7} 变成 [0-9a-f]{7}$/);
  assert.deepEqual(first.changedPaths, ["src/a.ts"]);

  const guarded = prepare(dir, task);
  put(worktreeOf(dir, task), ".knit/standards/development.md", "改过的规范\n");
  put(worktreeOf(dir, task), "src/b.ts", "export const b = 2;\n");
  assert.deepEqual(finish(dir, task, guarded, { verdict: "pass" }), []);
  const second = lastRun(dir, task);
  assert.equal(second.verdict, null);
  assert.equal(second.failure, "执行者改了受保护的文件：.knit/standards/development.md");
  assert.deepEqual(second.changedPaths, [".knit/standards/development.md", "src/b.ts"]);
});

test("调用方给的失败原因照记，结束过的不能再结束", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const run = prepare(dir, task);
  put(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");

  assert.deepEqual(finish(dir, task, run, { verdict: "pass", failure: "已取消" }), []);
  const ended = lastRun(dir, task);
  assert.equal(ended.failure, "已取消");
  assert.equal(ended.verdict, null);
  assert.deepEqual(ended.changedPaths, ["src/a.ts"]);

  const record = fileOf(dir, task, "record.json");
  const problem = `执行 ${run.id} 不在任务 ${task.id} 的记录里，或者已经结束`;
  assert.deepEqual(finish(dir, task, run, { verdict: "pass" }), [problem]);
  assert.deepEqual(finish(dir, task, { id: "r-000000000000" }, { verdict: "pass" }), [
    problem.replace(run.id, "r-000000000000"),
  ]);
  assert.equal(fileOf(dir, task, "record.json"), record);
});
