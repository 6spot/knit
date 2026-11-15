import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { assembleHandoff } from "../dist/application/handoff.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { findTask } from "../dist/application/task-store.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { readyTask, runProject } from "./helpers/run.mjs";

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const occurrences = (text, part) => text.split(part).length - 1;

/** 准备下一次执行；返回这次执行和它的 message.md。 */
function prepare(dir, task) {
  const { run, problems } = prepareRun({
    root: dir,
    taskId: task.id,
    workflow: workflowOf(dir),
    config: loadConfig(dir).config,
    model: null,
  });
  assert.deepEqual(problems, []);
  return { ...run, message: readFileSync(join(dir, run.dir, "message.md"), "utf8") };
}
/** 写下这次执行的报告，再把它记成正常结束。 */
function finish(dir, task, run, report, verdict = null) {
  writeFileSync(join(dir, run.dir, "report.md"), report);
  const problems = finishRun({
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure: null,
    sessionFile: null,
  });
  assert.deepEqual(problems, []);
}
const block = (tag, stage, run, body) =>
  `<${tag} stage="${stage}" path="${RUNS_DIR}/${run.id}/report.md">\n${body}\n</${tag}>`;

test("返工和再审时两份报告都拿到", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const implement = prepare(dir, task);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  finish(dir, task, implement, "第一次实现的报告。\n");
  const review = prepare(dir, task);
  finish(dir, task, review, "第一轮审查：a 的值不对。\n", "changes_requested");

  const rework = prepare(dir, task);
  assert.equal(rework.stage.id, "implement");
  assert.ok(
    rework.message.endsWith(
      [
        block("previous-report", "review", review, "改动的文件：无\n\n第一轮审查：a 的值不对。"),
        block("own-last-report", "implement", implement, "改动的文件：\n- src/a.ts\n\n第一次实现的报告。"),
      ].join("\n\n"),
    ),
    rework.message,
  );

  writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
  finish(dir, task, rework, "返工的实现报告。\n");
  const again = prepare(dir, task);
  assert.equal(again.stage.id, "review");
  assert.ok(
    again.message.endsWith(
      [
        block("previous-report", "implement", rework, "改动的文件：\n- src/a.ts\n\n返工的实现报告。"),
        block("own-last-report", "review", review, "改动的文件：无\n\n第一轮审查：a 的值不对。"),
      ].join("\n\n"),
    ),
    again.message,
  );
});

test("第一次进入和留在原环节时不多给", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);

  const implement = prepare(dir, task);
  finish(dir, task, implement, "实现的报告。\n");
  const review = prepare(dir, task);
  finish(dir, task, review, "审查卡住了：缺一份资料。\n", "blocked");
  const again = prepare(dir, task);

  assert.equal(again.stage.id, "review");
  for (const message of [implement.message, review.message, again.message]) {
    assert.equal(message.includes("<own-last-report"), false);
  }
  assert.ok(
    again.message.endsWith(block("previous-report", "review", review, "改动的文件：无\n\n审查卡住了：缺一份资料。")),
  );
  assert.equal(occurrences(again.message, "<previous-report"), 1);
  assert.equal(occurrences(again.message, "审查卡住了：缺一份资料。"), 1);
});

test("受字节上限约束，不给时和原来相同", (t) => {
  const dir = runProject(t);
  const stored = findTask(dir, readyTask(dir).id);
  const input = {
    root: dir,
    task: { dir: stored.dir, document: stored.document },
    stage: { id: "review", prompt: ".knit/agents/review.md" },
    previous: { stage: "implement", path: `${RUNS_DIR}/r-2/report.md`, changedPaths: [], text: "实现的报告。" },
    limits: { fileBytes: 200, totalBytes: 100000 },
  };
  const own = { stage: "review", path: `${RUNS_DIR}/r-1/report.md`, changedPaths: [], text: "字".repeat(100) };

  const withOwn = assembleHandoff({ ...input, own });
  assert.match(
    withOwn.firstMessage,
    /<\/previous-report>\n\n<own-last-report stage="review" path="\.knit\/\.runtime\/runs\/r-1\/report\.md">\n这份资料有 \d+ 字节，超过单个文件的上限 200 字节，没有附上；需要时按路径自己读。\n<\/own-last-report>$/,
  );
  assert.equal(withOwn.firstMessage.includes("字字"), false);

  const without = assembleHandoff(input);
  assert.deepEqual(assembleHandoff({ ...input, own: null }), without);
  assert.equal(without.firstMessage.includes("<own-last-report"), false);
  assert.ok(withOwn.firstMessage.startsWith(without.firstMessage));
  assert.equal(withOwn.systemPrompt, without.systemPrompt);
});
