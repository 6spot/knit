import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseWorkflow } from "../dist/domain/workflow.js";

const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;

/** docs/design/DESIGN.md 第 6.1 节的示例流程。 */
const SAMPLE_WORKFLOW_YAML = `version: 1
stages:
  - id: implement
    name: 实现
    prompt: .knit/agents/implement.md
    tools: [read, write, exec]
  - id: review
    name: 审查
    prompt: .knit/agents/review.md
    tools: [read, write, exec]
    report:
      verdict: [pass, changes_requested, blocked]
    onVerdict:
      changes_requested: implement
      blocked: review
`;

/** 在临时目录里建一个项目；workflow 为 null 时不写流程文件。测试结束时删除。 */
function project(t, workflow) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".knit"));
  if (workflow !== null) writeFileSync(join(dir, ".knit", "workflow.yaml"), workflow);
  return dir;
}

function run(command, dir) {
  return spawnSync(process.execPath, [cli, "workflow", command, "--dir", dir], { encoding: "utf8" });
}

test("配置正确：show 打印流程和两个环节，validate 退出码为 0", (t) => {
  const dir = project(t, SAMPLE_WORKFLOW_YAML);

  const show = run("show", dir);
  assert.equal(show.status, 0, show.stderr);
  const lines = show.stdout.split("\n");
  assert.equal(lines[0], "流程: 讨论 → 实现 → 审查 → 收尾");
  assert.ok(lines.includes("  1. implement（实现）"), show.stdout);
  assert.ok(lines.includes("  2. review（审查）"), show.stdout);
  assert.ok(lines.includes("     角色文件: .knit/agents/review.md"), show.stdout);
  assert.ok(lines.includes("     工具: read、write、exec"), show.stdout);
  assert.ok(lines.includes("     报告字段: verdict(pass|changes_requested|blocked)"), show.stdout);
  assert.ok(lines.includes("     按结论跳转: changes_requested → implement；blocked → review"), show.stdout);
  assert.ok(lines.includes("     进入次数上限: 5"), show.stdout);

  const validate = run("validate", dir);
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(validate.stdout, "配置有效\n流程: 讨论 → 实现 → 审查 → 收尾\n");
});

const parallelWorkflow = `version: 1
stages:
  - id: implement
    tools: all
  - id: review
    tools: [read, exec]
    prompt: .knit/agents/review.md
    executors:
      - id: pi-review
        agent: pi
        model: provider/reviewer
        thinking: minimal
      - agent: antigravity
        model: gemini-reviewer
        thinking: high
`;

test("只读审查可并列两个执行器，按各自的 Agent 展示模型、思考等级和角色文件", (t) => {
  const parsed = parseWorkflow(parallelWorkflow);
  assert.deepEqual(parsed.validation.issues, []);
  const prompt = ".knit/agents/review.md";
  assert.deepEqual(parsed.workflow.stages[1].executors, [
    { id: "pi-review", agent: "pi", model: "provider/reviewer", thinking: "minimal", prompt },
    { id: "executor-2", agent: "antigravity", model: "gemini-reviewer", thinking: "high", prompt },
  ]);
  const dir = project(t, parallelWorkflow + "        prompt: roles/agy.md\n");
  const validate = run("validate", dir);
  assert.equal(validate.status, 0, validate.stderr);
  const show = run("show", dir);
  assert.equal(show.status, 0, show.stderr);
  assert.ok(show.stdout.includes([
    "     执行器: pi-review", `       角色文件: ${prompt}`, "       Agent: pi",
    "       模型: provider/reviewer", "       思考等级: minimal",
    "     执行器: executor-2", "       角色文件: roles/agy.md", "       Agent: antigravity",
    "       模型: gemini-reviewer", "       思考等级: high",
  ].join("\n")), show.stdout);
  assert.doesNotMatch(show.stdout, /执行器: executor-1/);
});

test("并行环节配置错误时，解析器和 validate 定位到同一行", (t) => {
  const tools = "    tools: [read, exec]\n";
  const cases = [
    [tools, "    tools: [read, write, exec]\n", "parallel_stage_requires_readonly_tools", 6],
    [tools, "    tools:\n      - read\n      - write\n", "parallel_stage_requires_readonly_tools", 8],
    [tools, "", "parallel_stage_requires_readonly_tools", 5],
    [tools, "    tools: ALL\n", "parallel_stage_requires_readonly_tools", 6],
    [tools, "    tools: [all]\n", "invalid_tools", 6],
    [tools, "    tools: read\n", "invalid_tools", 6],
    ...["agent: pi", "model: p/m", "thinking: high"].map((field) =>
      [tools, `${tools}    ${field}\n`, "conflicting_executor_fields", 7]),
    ["- agent: antigravity", "- id: pi-review\n        agent: antigravity", "duplicate_executor_id", 13],
    ["id: pi-review", "id: executor-2", "duplicate_executor_id", 13],
    ["id: pi-review", "id: Bad", "invalid_executor_id", 9],
    ["model: provider/reviewer", "model: invalid", "invalid_model", 11],
    ["model: gemini-reviewer", "model: p/m", "invalid_model", 14],
    ["thinking: high", "thinking: off", "invalid_thinking", 15],
    ["agent: pi", "agent: unknown", "invalid_agent", 10],
    [parallelWorkflow.slice(parallelWorkflow.indexOf("executors:")), "executors: []\n", "invalid_executors", 8],
  ];
  for (const [original, replacement, code, line] of cases) {
    const source = parallelWorkflow.replace(original, replacement);
    const parsed = parseWorkflow(source);
    assert.equal(parsed.workflow, null, source);
    assert.equal(parsed.validation.reason, code, source);
    const [issue] = parsed.validation.issues;
    assert.equal(issue.line, line, issue.message);
    const validate = run("validate", project(t, source));
    assert.equal(validate.status, 1, source);
    assert.equal(validate.stderr, `${issue.message}\n`);
    if (code === "parallel_stage_requires_readonly_tools" || code === "invalid_tools") {
      assert.match(issue.message, /必须只读.*不得含 write.*tools: \[read, exec\]/);
      assert.doesNotMatch(issue.message, /tools: all|不写 tools/);
    }
  }
});

test("并行环节的工具、顶层冲突与执行器字段错误按源文件行序一并报告", (t) => {
  const source = parallelWorkflow
    .replace("tools: [read, exec]", "tools: [read, write]\n    model: p/m")
    .replace("id: pi-review", "id: Pi")
    .replace("model: provider/reviewer", "model: invalid");
  const parsed = parseWorkflow(source);
  assert.equal(parsed.workflow, null);
  assert.deepEqual(parsed.validation.issues.map((issue) => [issue.code, issue.line]), [
    ["parallel_stage_requires_readonly_tools", 6],
    ["conflicting_executor_fields", 7],
    ["invalid_executor_id", 10],
    ["invalid_model", 12],
  ]);
  const validate = run("validate", project(t, source));
  assert.equal(validate.status, 1);
  assert.equal(validate.stderr, parsed.validation.issues.map((issue) => `${issue.message}\n`).join(""));
});

test("配置有问题：两个命令都在标准错误里给出行号，退出码为 1，不打印流程", (t) => {
  const dir = project(t, "version: 1\nstages:\n  - id: Bad\n");
  for (const command of ["validate", "show"]) {
    const result = run(command, dir);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /^第 3 行：/, command);
    assert.equal(result.stdout, "", command);
  }
});

test("流程文件不存在：两个命令都说明文件不存在并提示 knit init，退出码为 1", (t) => {
  const dir = project(t, null);
  for (const command of ["validate", "show"]) {
    const result = run(command, dir);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /\.knit\/workflow\.yaml 不存在/, command);
    assert.match(result.stderr, /knit init/, command);
    assert.equal(result.stdout, "", command);
  }
});
