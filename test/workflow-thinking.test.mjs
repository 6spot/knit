import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const workflowCommand = (t, command, source) => {
  const dir = project(t);
  writeFileSync(join(dir, ".knit/workflow.yaml"), source);
  return knit(dir, "workflow", command);
};

test("思考等级由顶层提供缺省，环节的只管本环节，show 显示生效值", (t) => {
  const source = "version: 1\nthinking: high\nstages:\n  - id: implement\n  - id: review\n    thinking: off\n  - id: check\n";
  const parsed = parseWorkflow(source);
  assert.deepEqual(parsed.validation.issues, []);
  assert.equal(parsed.workflow.thinking, "high");
  assert.deepEqual(parsed.workflow.stages.map((stage) => stage.thinking), [null, "off", null]);
  const shown = workflowCommand(t, "show", source);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(
    shown.stdout.split("\n").filter((line) => line.startsWith("     思考等级: ")),
    ["     思考等级: high", "     思考等级: off", "     思考等级: high"],
  );

  const unset = "version: 1\nstages:\n  - id: implement\n  - id: review\n    thinking: high\n";
  assert.deepEqual(parseWorkflow(unset).workflow.stages.map((stage) => stage.thinking), [null, "high"]);
  const bare = workflowCommand(t, "show", unset);
  assert.equal(bare.code, 0, bare.stderr);
  assert.deepEqual(
    bare.stdout.split("\n").filter((line) => line.startsWith("     思考等级: ")),
    ["     思考等级: （没有指定，用主会话的等级）", "     思考等级: high"],
  );
});

test("show 对 Antigravity 同时显示模型和思考等级的 agy 缺省", (t) => {
  const source = "version: 1\nmodel: provider/model\nthinking: off\nstages:\n  - id: review\n    agent: antigravity\n";
  const shown = workflowCommand(t, "show", source);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^     模型: （用 agy 的缺省）$/m);
  assert.match(shown.stdout, /^     思考等级: （用 agy 的缺省）$/m);
});

LEVELS.forEach((level) => {
  test(`顶层和环节都接受 Pi 思考等级 ${level}`, (t) => {
    const source = `version: 1\nthinking: ${level}\nstages:\n  - id: implement\n    thinking: ${level}\n`;
    const parsed = parseWorkflow(source);
    assert.deepEqual(parsed.validation.issues, []);
    assert.equal(parsed.workflow.stages[0].thinking, level);
    const validated = workflowCommand(t, "validate", source);
    assert.equal(validated.code, 0, validated.stderr);
  });
});

["ultra", "HIGH", "false", "42", "null", "[]", "{}", '""'].forEach((value) => {
  [
    { source: `version: 1\nthinking: ${value}\nstages:\n  - id: implement\n`, line: 2, path: "thinking" },
    { source: `version: 1\nstages:\n  - id: implement\n  - id: review\n    thinking: ${value}\n`, line: 5, path: "stages[1].thinking" },
  ].forEach((scenario) => {
    test(`${scenario.path} 写成 ${value} 时 validate 以退出码 1 指出行号`, (t) => {
      const parsed = parseWorkflow(scenario.source);
      const message = `第 ${scenario.line} 行：${scenario.path} 只允许 off／minimal／low／medium／high／xhigh／max`;
      assert.equal(parsed.workflow, null);
      assert.equal(parsed.validation.reason, "invalid_thinking");
      assert.deepEqual(
        parsed.validation.issues.map((issue) => [issue.code, issue.line, issue.message]),
        [["invalid_thinking", scenario.line, message]],
      );
      const validated = workflowCommand(t, "validate", scenario.source);
      assert.equal(validated.code, 1);
      assert.equal(validated.stdout, "");
      assert.equal(validated.stderr, `${message}\n`);
    });
  });
});
