import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { executeRun } from "../dist/application/run-execute.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { agents, readyTask, runProject } from "./helpers/run.mjs";

const PASS = '改好了格式。\n\n```json\n{ "verdict": "pass" }\n```';
const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);

/** 假 Pi 的脚本和记录文件放在项目目录之外；返回改脚本的函数和读执行者收到的消息的函数。 */
function fakePi(t) {
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  const saved = { KNIT_FAKE_PI: process.env.KNIT_FAKE_PI, KNIT_FAKE_PI_LOG: process.env.KNIT_FAKE_PI_LOG };
  process.env.KNIT_FAKE_PI = join(outside, "script.json");
  process.env.KNIT_FAKE_PI_LOG = join(outside, "log.jsonl");
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(outside, { recursive: true, force: true });
  });
  return {
    script: (script) => writeFileSync(join(outside, "script.json"), JSON.stringify(script)),
    messages: () =>
      readFileSync(join(outside, "log.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .flatMap((line) => JSON.parse(line).message ?? []),
  };
}
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
const execute = (dir, task, run) =>
  executeRun({ root: dir, taskId: task.id, runId: run.id, workflow: workflowOf(dir), model: run.model, agents });
/** 准备出一次审查执行：先把实现那一次直接记成正常结束。 */
function reviewRun(dir, task) {
  const implement = prepare(dir, task);
  const finished = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: implement.id,
    workflow: workflowOf(dir),
    verdict: null,
    failure: null,
    sessionFile: null,
  });
  assert.deepEqual(finished, []);
  const review = prepare(dir, task);
  assert.equal(review.stage.id, "review");
  return review;
}

test("补报之后读得出就按正常结束", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  pi.script({ texts: ["看过了，没有问题。", PASS] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.deepEqual({ verdict: ended.verdict, failure: ended.failure }, { verdict: "pass", failure: null });
  assert.equal(readFileSync(join(dir, run.dir, "report.md"), "utf8"), PASS);
  assert.deepEqual(pi.messages(), [
    readFileSync(join(dir, run.dir, "message.md"), "utf8"),
    "上一条消息里的报告读不出来：\n- 报告结尾没有能解析的 json 代码块\n" +
      "请只重新输出完整的报告，结尾带上 json 代码块。不要修改文件，不要重新做一遍。",
  ]);
});

test("补报之后仍读不出就记为失败", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  const second = "再说一遍：没有问题。";
  pi.script({ texts: ["看过了，没有问题。", second, PASS] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.equal(ended.failure, "报告读不出来：报告结尾没有能解析的 json 代码块");
  assert.equal(ended.verdict, null);
  assert.equal(readFileSync(join(dir, run.dir, "report.md"), "utf8"), second);
  assert.equal(pi.messages().length, 2);
});

test("读得出时不补报", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);

  // 实现环节没有声明报告字段，只有文字的消息就是报告。
  pi.script({ texts: ["做完了。", PASS] });
  const implement = prepare(dir, task);
  assert.equal(implement.stage.id, "implement");
  assert.deepEqual(await execute(dir, task, implement), []);
  const first = lastRun(dir, task);
  assert.deepEqual({ verdict: first.verdict, failure: first.failure }, { verdict: null, failure: null });
  assert.equal(readFileSync(join(dir, implement.dir, "report.md"), "utf8"), "做完了。");
  assert.equal(pi.messages().length, 1);

  pi.script({ texts: [PASS, "不该用到。"] });
  const review = prepare(dir, task);
  assert.equal(review.stage.id, "review");
  assert.deepEqual(await execute(dir, task, review), []);
  const second = lastRun(dir, task);
  assert.deepEqual({ verdict: second.verdict, failure: second.failure }, { verdict: "pass", failure: null });
  assert.equal(pi.messages().length, 2);
});
