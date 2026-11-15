import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit } from "./helpers/cli.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";

const REFUSED = "独立审查的任务要在审查通过后才能完成；用户明确要求直接完成时，加 --reason <理由>\n";
const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const filesOf = (dir, task) => ["task.md", "record.json"].map((name) => readFileSync(join(dir, task.dir, name), "utf8"));
const close = (dir, task) => knit(dir, "task", "close", task.id, "--result", "做完了");

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
function finish(dir, task, run, { verdict = null, failure = null } = {}) {
  const problems = finishRun({
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure,
    sessionFile: null,
  });
  assert.deepEqual(problems, []);
}
/** 实现正常结束，审查结论 pass。 */
function reviewed(dir, task) {
  finish(dir, task, prepare(dir, task));
  const review = prepare(dir, task);
  assert.equal(review.stage.id, "review");
  finish(dir, task, review, { verdict: "pass" });
}

test("有执行没结束时不能完成或取消", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir, { verification: "self" });
  const run = prepare(dir, task);
  const before = filesOf(dir, task);
  const refusal = `任务 ${task.id} 的执行 ${run.id} 还没有结束；等它结束，或运行 knit run cancel ${task.id}\n`;

  const closed = close(dir, task);
  assert.deepEqual({ code: closed.code, stdout: closed.stdout, stderr: closed.stderr }, { code: 1, stdout: "", stderr: refusal });
  const cancelled = knit(dir, "task", "cancel", task.id, "--reason", "不做了");
  assert.deepEqual(
    { code: cancelled.code, stdout: cancelled.stdout, stderr: cancelled.stderr },
    { code: 1, stdout: "", stderr: refusal },
  );
  assert.deepEqual(filesOf(dir, task), before);
  assert.equal(existsSync(join(dir, ".knit/tasks/archive")), false);

  finish(dir, task, run);
  const done = close(dir, task);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.stdout, `已完成 ${task.id}\n`);
});

test("需求改过之后以前的审查通过不算", (t) => {
  const dir = runProject(t);

  const changed = readyTask(dir);
  reviewed(dir, changed);
  const file = join(dir, changed.dir, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("加一个问候语。", "加一个问候语，带上名字。"));
  assert.equal(knit(dir, "task", "ready", changed.id).code, 0);
  const before = filesOf(dir, changed);
  const refused = close(dir, changed);
  assert.deepEqual({ code: refused.code, stderr: refused.stderr }, { code: 1, stderr: REFUSED });
  assert.deepEqual(filesOf(dir, changed), before);

  const unchanged = readyTask(dir);
  reviewed(dir, unchanged);
  const done = close(dir, unchanged);
  assert.equal(done.code, 0, done.stderr);

  // 最后一次审查是失败的执行，再往前一次是 pass。
  const failedLater = readyTask(dir);
  reviewed(dir, failedLater);
  const record = join(dir, failedLater.dir, "record.json");
  const stored = JSON.parse(readFileSync(record, "utf8"));
  const failed = { ...stored.runs.at(-1), id: "r-000000000000", verdict: null, failure: "执行者中途退出" };
  writeFileSync(record, `${JSON.stringify({ ...stored, runs: [...stored.runs, failed] }, null, 2)}\n`);
  const closed = close(dir, failedLater);
  assert.equal(closed.code, 0, closed.stderr);
});
