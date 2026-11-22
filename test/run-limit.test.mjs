import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit } from "./helpers/cli.mjs";
import { commitAll } from "./helpers/git.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const prepare = (dir, task) =>
  prepareRun({ root: dir, taskId: task.id, workflow: workflowOf(dir), config: loadConfig(dir).config, model: null });

/** 准备下一次执行并把它记成结束；返回这次执行的 id。 */
function runOnce(dir, task, stage, { verdict = null, failure = null } = {}) {
  const { run, problems } = prepare(dir, task);
  assert.deepEqual(problems, []);
  assert.equal(run.stage.id, stage);
  const finished = finishRun({
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure,
    sessionFile: null,
  });
  assert.deepEqual(finished, []);
  return run.id;
}

/**
 * 实现环节的 maxVisits 是 1；任务做过实现、审查（changes_requested）、一次失败的实现、
 * 实现、审查（changes_requested）。返回项目目录、任务、到上限时该给出的那一组行。
 */
function atLimit(t) {
  const dir = runProject(t);
  const file = join(dir, ".knit/workflow.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("    name: 实现\n", "    name: 实现\n    maxVisits: 1\n"));
  commitAll(dir, "limit");
  assert.equal(workflowOf(dir).stages[0].maxVisits, 1);
  const task = readyTask(dir);
  const runs = [
    ["实现", runOnce(dir, task, "implement"), ""],
    ["审查", runOnce(dir, task, "review", { verdict: "changes_requested" }), "changes_requested"],
  ];
  const failed = runOnce(dir, task, "implement", { failure: "执行者中途退出" });
  runs.push(
    ["实现", runOnce(dir, task, "implement"), ""],
    ["审查", runOnce(dir, task, "review", { verdict: "changes_requested" }), "changes_requested"],
  );
  const notice = [
    "实现环节已经进入 2 次，到了上限，不再派发。各轮的报告：",
    ...runs.map(([name, id, verdict]) => `  ${name}（${id}）${verdict}：${RUNS_DIR}/${id}/report.md`),
    "可以走的路：",
    `  1. 主会话直接修，改完运行 knit task close ${task.id} --paths <改动的文件>`,
    "  2. 拆成更小的任务",
    `  3. 需求本身有问题就改需求，再运行 knit task ready ${task.id}；进入次数从头数`,
    `  4. 用户决定带理由接受：knit task close ${task.id} --reason <理由>`,
  ];
  assert.equal(notice.some((line) => line.includes(failed)), false);
  return { dir, task, notice };
}

test("派发被拒绝时列出各轮报告和四条路", (t) => {
  const { dir, task, notice } = atLimit(t);
  const before = readdirSync(join(dir, RUNS_DIR)).sort();

  const refused = knit(dir, "run", "start", task.id);

  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, notice.map((line) => `${line}\n`).join(""));
  assert.equal(notice.length, 10);
  assert.deepEqual(readdirSync(join(dir, RUNS_DIR)).sort(), before);
  assert.equal(before.length, 5);
});

test("run status 的下一步显示同样的内容", (t) => {
  const { dir, task, notice } = atLimit(t);

  const shown = knit(dir, "run", "status", task.id);

  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.endsWith(`改动文件: 0 个\nAgent: pi\n下一步: ${notice.join("\n")}\n`), shown.stdout);
});

test("改需求并重新确认之后可以再派发", (t) => {
  const { dir, task } = atLimit(t);
  const file = join(dir, task.dir, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("加一个问候语。", "加一个问候语，带上名字。"));

  const ready = knit(dir, "task", "ready", task.id);
  assert.equal(ready.code, 0, ready.stderr);
  const shown = knit(dir, "run", "status", task.id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.endsWith(`下一步: 派发实现环节（knit run start ${task.id}）\n`), shown.stdout);

  const { run, problems } = prepare(dir, task);
  assert.deepEqual(problems, []);
  assert.equal(run.stage.id, "implement");
  assert.ok(existsSync(join(dir, run.dir, "message.md")));
});
