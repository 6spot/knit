import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { assembleHandoff } from "../dist/application/handoff.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { findTask } from "../dist/application/task-store.js";
import { stageRules } from "../dist/domain/stage-rules.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { readyTask, runProject } from "./helpers/run.mjs";

/** 实现、审查两个环节；`review` 是接在审查环节后面的几行。 */
function workflowWith(review, reviewPrompt = ".knit/agents/review.md") {
  const { workflow, validation } = parseWorkflow(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    name: 实现",
      "    prompt: .knit/agents/implement.md",
      "  - id: review",
      "    name: 审查",
      `    prompt: ${reviewPrompt}`,
      ...review,
      "",
    ].join("\n"),
  );
  assert.deepEqual(validation.issues, []);
  return workflow;
}
const REPORT = [
  "    report:",
  "      verdict: [pass, changes_requested, blocked]",
  "      findings: string[]",
  "      changedPaths: paths",
  "      selfVerified: bool",
  "      note: string",
];
const FIXED = [
  "- 不要提交，也不要切换或新建分支。结束时 HEAD 变了，这次执行记为失败。",
  "- 不要修改这些文件，改了这次执行记为失败：.knit/standards/ 下的文件、.knit/workflow.yaml、.knit/config.json、.knit/agents/implement.md、.knit/agents/review.md。",
  "- 你的最后一条消息就是这个环节的报告，会原样交给下一个环节和用户。",
];

test("没有声明报告字段的环节", () => {
  const workflow = workflowWith(REPORT);

  const rules = stageRules(workflow, workflow.stages[0]);

  assert.equal(rules, ["<rules>", ...FIXED, "</rules>"].join("\n"));
  // 第二条里有 .knit/config.json，所以核对的是没有要 json 代码块的那一条。
  assert.equal(rules.includes("json 代码块"), false);
  assert.equal(rules.replace(".knit/config.json", "").includes("json"), false);
  assert.equal(stageRules(workflow, workflow.stages[0]), rules);
});

test("声明了报告字段的环节", () => {
  const workflow = workflowWith(REPORT);

  assert.equal(
    stageRules(workflow, workflow.stages[1]),
    [
      "<rules>",
      ...FIXED,
      "- 报告的结尾放一个 json 代码块，给出这些字段：",
      "  - verdict：pass、changes_requested、blocked 之一",
      "  - findings：字符串数组",
      "  - changedPaths：路径数组",
      "  - selfVerified：true 或 false",
      "  - note：字符串",
      "</rules>",
    ].join("\n"),
  );

  const shared = workflowWith(REPORT, ".knit/agents/implement.md");
  assert.equal(
    stageRules(shared, shared.stages[1]).split("\n")[2],
    "- 不要修改这些文件，改了这次执行记为失败：.knit/standards/ 下的文件、.knit/workflow.yaml、.knit/config.json、.knit/agents/implement.md。",
  );
});

test("派发时写进系统提示", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const workflow = parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
  const stored = findTask(dir, task.id);
  const expected = assembleHandoff({
    root: dir,
    task: { dir: stored.dir, document: stored.document },
    stage: workflow.stages[0],
    previous: null,
  });

  const { run, problems } = prepareRun({ root: dir, taskId: task.id, workflow, config: loadConfig(dir).config, model: null });

  assert.deepEqual(problems, []);
  assert.equal(
    readFileSync(join(dir, run.dir, "system.md"), "utf8"),
    `${expected.systemPrompt}\n\n${stageRules(workflow, workflow.stages[0])}`,
  );
  assert.equal(readFileSync(join(dir, run.dir, "message.md"), "utf8"), expected.firstMessage);
});
