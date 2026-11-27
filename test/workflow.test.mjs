import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchema } from "../dist/contracts/primitives.js";
import { TOOL_CAPABILITIES, WORKFLOW_ANCHORS, WORKFLOW_STAGE_ID_REGEX, WorkflowIssueSchema, WorkflowValidationSchema } from "../dist/contracts/workflow.js";
import { DEFAULT_MAX_REPAIR_ROUNDS, parseWorkflow, workflowPrompts } from "../dist/domain/workflow.js";

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

function assertValid(source) {
  const result = parseWorkflow(source);
  assert.notEqual(result.workflow, null, JSON.stringify(result.validation.issues));
  assert.deepEqual(result.validation, { ok: true, issues: [], reason: null });
  return result.workflow;
}

function assertInvalid(source, reason) {
  const result = parseWorkflow(source);
  assert.equal(result.workflow, null, "配置有问题时没有流程定义");
  assert.equal(result.validation.ok, false);
  assert.equal(result.validation.reason, reason);
  assert.ok(result.validation.issues.length > 0, "必须带问题清单");
  for (const issue of result.validation.issues) {
    assert.ok(issue.line >= 1);
    assert.ok(issue.column >= 1);
    assert.match(issue.message, new RegExp(`第 ${issue.line} 行`));
  }
  return result;
}

// ---------------------------------------------------------------------------
// 合法配置

test("示例流程解析出两个环节并保留全部语义字段", () => {
  const workflow = assertValid(SAMPLE_WORKFLOW_YAML);
  assert.equal(workflow.version, 1);
  assert.deepEqual(workflow.anchors, ["discuss", "deliver"]);
  assert.deepEqual(workflow.stages.map((stage) => stage.id), ["implement", "review"]);
  assert.equal(DEFAULT_MAX_REPAIR_ROUNDS, 5);
  assert.equal(workflow.defaultMaxVisits, 5);

  const [implement, review] = workflow.stages;
  assert.deepEqual(implement, {
    id: "implement",
    name: "实现",
    resume: false,
    description: null,
    agent: null,
    model: null,
    thinking: null,
    executors: [{ id: "executor-1", agent: null, model: null, thinking: null, prompt: ".knit/agents/implement.md" }],
    prompt: ".knit/agents/implement.md",
    tools: ["read", "write", "exec"],
    report: {},
    onVerdict: {},
    maxVisits: 5,
  });
  assert.deepEqual(review, {
    id: "review",
    name: "审查",
    resume: false,
    description: null,
    agent: null,
    model: null,
    thinking: null,
    executors: [{ id: "executor-1", agent: null, model: null, thinking: null, prompt: ".knit/agents/review.md" }],
    prompt: ".knit/agents/review.md",
    tools: ["read", "write", "exec"],
    report: { verdict: ["pass", "changes_requested", "blocked"] },
    onVerdict: { changes_requested: "implement", blocked: "review" },
    maxVisits: 5,
  });
});

test("越界与绝对角色路径标出对应环节或执行器的行号", () => {
  const source = `version: 1
stages:
  - id: implement
    prompt: ../outside.md
  - id: review
    tools: [read]
    prompt: /outside.md
    executors:
      - prompt: ../other.md
      - prompt: /other.md
`;
  const result = assertInvalid(source, "invalid_structure");
  assert.deepEqual(result.validation.issues.map(({ path, line }) => [path, line]), [
    ["/stages/0/prompt", 4], ["/stages/1/prompt", 7],
    ["/stages/1/executors/0/prompt", 9], ["/stages/1/executors/1/prompt", 10],
  ]);
});

test("最简阶段使用 id 作为显示名，其余字段取安全缺省", () => {
  const workflow = assertValid("version: 1\nstages:\n  - id: implement\n");
  assert.deepEqual(workflow.stages[0], {
    id: "implement",
    name: "implement",
    resume: false,
    description: null,
    agent: null,
    model: null,
    thinking: null,
    executors: [{ id: "executor-1", agent: null, model: null, thinking: null, prompt: null }],
    prompt: null,
    tools: null,
    report: {},
    onVerdict: {},
    maxVisits: DEFAULT_MAX_REPAIR_ROUNDS,
  });
});

test("单执行器列表与旧写法解析为相同定义，允许写权限", () => {
  const base = "version: 1\nstages:\n  - id: review\n    tools: all\n";
  const fields = ["agent: pi", "model: p/m", "thinking: high", "prompt: roles/review.md"];
  const legacy = base + fields.map((field) => `    ${field}\n`).join("");
  const listed = base + `    executors:\n      - ${fields.join("\n        ")}\n`;
  assert.deepEqual(assertValid(listed), assertValid(legacy));
  const overridden = assertValid(listed.replace("    executors:", "    prompt: shared.md\n    executors:"));
  assert.deepEqual(workflowPrompts({ ...overridden, stages: overridden.stages.map((stage) => ({ ...stage })) }),
    ["shared.md", "roles/review.md"]);
});

test("maxRepairRounds 作为阶段缺省，显式 maxVisits 覆盖它", () => {
  const workflow = assertValid(
    "version: 1\nmaxRepairRounds: 4\nstages:\n  - id: implement\n  - id: check\n    maxVisits: 7\n",
  );
  assert.equal(workflow.defaultMaxVisits, 4);
  assert.equal(workflow.stages[0].maxVisits, 4);
  assert.equal(workflow.stages[1].maxVisits, 7);
});

test("非回退环节允许显式 maxVisits: null（无上限）", () => {
  const workflow = assertValid("version: 1\nstages:\n  - id: implement\n  - id: check\n    maxVisits: null\n");
  assert.equal(workflow.stages[0].maxVisits, DEFAULT_MAX_REPAIR_ROUNDS);
  assert.equal(workflow.stages[1].maxVisits, null);
});

test("注释不参与解析结果，带注释与不带注释的定义完全相等", () => {
  const plain = [
    "version: 1",
    "stages:",
    "  - id: implement",
    "  - id: check",
    "    report:",
    "      verdict: [pass, changes_requested]",
    "    onVerdict:",
    "      changes_requested: implement",
    "",
  ].join("\n");
  const commented = [
    "# 顶部注释",
    "version: 1 # 行尾注释",
    "stages:",
    "  # 阶段之前的注释",
    "  - id: implement # 阶段行尾",
    "  - id: check",
    "    # 字段之前",
    "    report:",
    "      verdict: [pass, changes_requested] # 枚举注释",
    "    onVerdict:",
    "      changes_requested: implement",
    "",
  ].join("\n");
  assert.deepEqual(parseWorkflow(commented), parseWorkflow(plain));
});

test("五种能力全部可写，顺序保留；task 不再是能力", () => {
  assert.deepEqual(TOOL_CAPABILITIES, ["read", "write", "exec", "external", "network"]);
  const workflow = assertValid(
    `version: 1\nstages:\n  - id: implement\n    tools: [${TOOL_CAPABILITIES.join(", ")}]\n`,
  );
  assert.deepEqual(workflow.stages[0].tools, TOOL_CAPABILITIES);

  const withTask = assertInvalid("version: 1\nstages:\n  - id: implement\n    tools: [read, task]\n", "invalid_tools");
  assert.equal(withTask.validation.issues[0].line, 4);
});

test("report 的五类声明均可解析", () => {
  const workflow = assertValid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    report:",
      "      text: string",
      "      notes: string[]",
      "      files: paths",
      "      verified: bool",
      "      verdict: [pass, blocked]",
      "",
    ].join("\n"),
  );
  assert.deepEqual(workflow.stages[0].report, {
    text: "string",
    notes: "string[]",
    files: "paths",
    verified: "bool",
    verdict: ["pass", "blocked"],
  });
});

test("onVerdict 可前向引用阶段，也可跳到 deliver 锚点", () => {
  const workflow = assertValid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    report:",
      "      verdict: [pass, fail]",
      "    onVerdict:",
      "      pass: check",
      "      fail: deliver",
      "  - id: check",
      "",
    ].join("\n"),
  );
  assert.deepEqual(workflow.stages[0].onVerdict, { pass: "check", fail: "deliver" });
});

test("有限上限的回退边可解析，默认上限来自 maxRepairRounds", () => {
  const workflow = assertValid(
    [
      "version: 1",
      "maxRepairRounds: 3",
      "stages:",
      "  - id: implement",
      "  - id: check",
      "    report:",
      "      verdict: [pass, changes_requested]",
      "    onVerdict:",
      "      changes_requested: implement",
      "",
    ].join("\n"),
  );
  assert.equal(workflow.stages[0].maxVisits, 3);
  assert.equal(workflow.stages[1].maxVisits, 3);
  assert.equal(workflow.stages[1].onVerdict.changes_requested, "implement");
});

test("环上只要有一个有限上限阶段，其他阶段显式 null 仍合法", () => {
  const workflow = assertValid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    maxVisits: null",
      "    report:",
      "      verdict: [again]",
      "    onVerdict:",
      "      again: check",
      "  - id: check",
      "    report:",
      "      verdict: [again]",
      "    onVerdict:",
      "      again: implement",
      "",
    ].join("\n"),
  );
  assert.equal(workflow.stages[0].maxVisits, null);
  assert.equal(workflow.stages[1].maxVisits, DEFAULT_MAX_REPAIR_ROUNDS);
});

test("maxVisits: 0 是合法有限上限", () => {
  const workflow = assertValid("version: 1\nstages:\n  - id: implement\n    maxVisits: 0\n");
  assert.equal(workflow.stages[0].maxVisits, 0);
});

test("空 name 回退到 id", () => {
  const workflow = assertValid('version: 1\nstages:\n  - id: implement\n    name: ""\n');
  assert.equal(workflow.stages[0].name, "implement");
});

test("阶段 id 边界长度为 32 且以字母开头时合法", () => {
  const id = `a${"b".repeat(31)}`;
  assert.equal(id.length, 32);
  assert.ok(WORKFLOW_STAGE_ID_REGEX.test(id));
  const workflow = assertValid(`version: 1\nstages:\n  - id: ${id}\n`);
  assert.equal(workflow.stages[0].id, id);
});

// ---------------------------------------------------------------------------
// 非法配置（都得不到流程定义，只有问题清单）

test("YAML 语法错误被拒绝，消息与结构带行号", () => {
  const result = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    tools: [read,\n",
    "yaml_parse_error",
  );
  const issue = result.validation.issues[0];
  assert.ok(issue.line >= 4, `实际行号 ${issue.line}`);
  assert.equal(issue.path, "");
});

test("重复 YAML 键按解析错误被拒绝", () => {
  const result = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    id: check\n",
    "yaml_parse_error",
  );
  assert.equal(result.validation.issues[0].line, 4);
});

test("缺少 version 被拒绝并指向根位置", () => {
  const result = assertInvalid("stages:\n  - id: implement\n", "unsupported_version");
  assert.equal(result.validation.issues[0].line, 1);
  assert.equal(result.validation.issues[0].path, "/version");
});

test("version 不是 1 被拒绝", () => {
  for (const value of ["2", '"1"']) {
    const result = assertInvalid(`version: ${value}\nstages:\n  - id: implement\n`, "unsupported_version");
    assert.equal(result.validation.issues[0].line, 1);
  }
});

test("缺少 stages 与 stages 为空都被拒绝", () => {
  const missing = assertInvalid("version: 1\n", "empty_stages");
  assert.equal(missing.validation.issues[0].line, 1);

  const empty = assertInvalid("version: 1\nstages: []\n", "empty_stages");
  assert.equal(empty.validation.issues[0].line, 2);
});

test("stages 不是数组时被拒绝", () => {
  const result = assertInvalid("version: 1\nstages: {}\n", "invalid_structure");
  assert.equal(result.validation.issues[0].line, 2);
});

test("根节点不是映射时被拒绝", () => {
  for (const source of ["", "just a string\n", "- a\n- b\n"]) {
    const result = assertInvalid(source, "invalid_structure");
    assert.equal(result.validation.issues[0].line, 1);
  }
});

test("阶段 id 大写或超长被拒绝", () => {
  const upper = assertInvalid("version: 1\nstages:\n  - id: Implement\n", "invalid_stage_id");
  assert.equal(upper.validation.issues[0].line, 3);
  assert.equal(upper.validation.issues[0].path, "/stages/0/id");

  const tooLong = `a${"b".repeat(32)}`;
  const long = assertInvalid(`version: 1\nstages:\n  - id: ${tooLong}\n`, "invalid_stage_id");
  assert.equal(long.validation.issues[0].line, 3);
});

test("内置锚点不能作为阶段 id", () => {
  for (const id of WORKFLOW_ANCHORS) {
    const result = assertInvalid(`version: 1\nstages:\n  - id: ${id}\n`, "reserved_stage_id");
    assert.equal(result.validation.issues[0].line, 3);
  }
});

test("重复阶段 id 被拒绝并指出重复位置", () => {
  const result = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n  - id: implement\n",
    "duplicate_stage_id",
  );
  assert.equal(result.validation.issues[0].line, 4);
  assert.equal(result.validation.issues[0].path, "/stages/1/id");
});

test("缺少阶段 id 被拒绝", () => {
  const result = assertInvalid("version: 1\nstages:\n  - name: 实现\n", "invalid_stage_id");
  assert.equal(result.validation.issues[0].line, 3);
});

test("未知能力或 tools 类型错误被拒绝", () => {
  const unknown = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    tools: [read, nope]\n",
    "invalid_tools",
  );
  assert.equal(unknown.validation.issues[0].line, 4);
  assert.equal(unknown.validation.issues[0].path, "/stages/0/tools/1");

  const wrongType = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    tools: read\n",
    "invalid_tools",
  );
  assert.equal(wrongType.validation.issues[0].line, 4);
});

test("未知报告类型被拒绝", () => {
  const result = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    report:\n      verdict: maybe\n",
    "invalid_report",
  );
  assert.equal(result.validation.issues[0].line, 5);
  assert.equal(result.validation.issues[0].path, "/stages/0/report/verdict");
});

test("空枚举数组与重复枚举值被拒绝", () => {
  const empty = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    report:\n      verdict: []\n",
    "invalid_report",
  );
  assert.equal(empty.validation.issues[0].line, 5);

  const duplicate = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    report:\n      verdict: [pass, pass]\n",
    "duplicate_report_enum",
  );
  assert.equal(duplicate.validation.issues[0].line, 5);
});

test("maxVisits 负数、小数或字符串被拒绝", () => {
  for (const value of ["-1", "1.5", '"2"']) {
    const result = assertInvalid(
      `version: 1\nstages:\n  - id: implement\n    maxVisits: ${value}\n`,
      "invalid_max_visits",
    );
    assert.equal(result.validation.issues[0].line, 4);
    assert.equal(result.validation.issues[0].path, "/stages/0/maxVisits");
  }
});

test("onVerdict 目标不存在被拒绝", () => {
  const result = assertInvalid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    report:",
      "      verdict: [pass]",
      "    onVerdict:",
      "      pass: missing",
      "",
    ].join("\n"),
    "unknown_on_verdict_target",
  );
  assert.equal(result.validation.issues[0].line, 7);
});

test("onVerdict 不能跳回 discuss 锚点", () => {
  const result = assertInvalid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    report:",
      "      verdict: [blocked]",
      "    onVerdict:",
      "      blocked: discuss",
      "",
    ].join("\n"),
    "unknown_on_verdict_target",
  );
  assert.equal(result.validation.issues[0].line, 7);
});

test("onVerdict 键未在 report 枚举中声明时被拒绝", () => {
  const result = assertInvalid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    onVerdict:",
      "      pass: deliver",
      "",
    ].join("\n"),
    "undeclared_verdict_value",
  );
  assert.equal(result.validation.issues[0].line, 5);
});

test("onVerdict 只从 report.verdict 的枚举取值", () => {
  for (const report of ["{grade: [pass]}", "{grade: [pass], verdict: string}", "{grade: [pass], verdict: [blocked]}"]) {
    const result = assertInvalid(`version: 1\nstages:\n  - id: review\n    report: ${report}\n    onVerdict: {pass: deliver}\n`,
      "undeclared_verdict_value");
    assert.match(result.validation.issues[0].message, /pass.*report\.verdict/);
  }
  assertInvalid("version: 1\nstages:\n  - id: review\n    onVerdict: {}\n", "undeclared_verdict_value");
});

test("无上限阶段之间成环时被拒绝", () => {
  const result = assertInvalid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    maxVisits: null",
      "    report:",
      "      verdict: [again]",
      "    onVerdict:",
      "      again: check",
      "  - id: check",
      "    maxVisits: null",
      "    report:",
      "      verdict: [again]",
      "    onVerdict:",
      "      again: implement",
      "",
    ].join("\n"),
    "unbounded_repair_cycle",
  );
  assert.deepEqual(
    result.validation.issues.map((issue) => issue.path).sort(),
    ["/stages/0/maxVisits", "/stages/1/maxVisits"],
  );
});

test("无上限自环按回退环处理", () => {
  const result = assertInvalid(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    maxVisits: null",
      "    report:",
      "      verdict: [again]",
      "    onVerdict:",
      "      again: implement",
      "",
    ].join("\n"),
    "unbounded_repair_cycle",
  );
  assert.equal(result.validation.issues[0].line, 4);
});

test("文件里的返工上限无效时被拒绝", () => {
  const result = assertInvalid(
    [
      "version: 1",
      "maxRepairRounds: -1",
      "stages:",
      "  - id: implement",
      "    report:",
      "      verdict: [again]",
      "    onVerdict:",
      "      again: implement",
      "",
    ].join("\n"),
    "invalid_max_repair_rounds",
  );
  assert.equal(result.validation.issues[0].line, 2);
});

test("未知阶段字段与未知根字段被拒绝", () => {
  const stageField = assertInvalid(
    "version: 1\nstages:\n  - id: implement\n    tpyo: 1\n",
    "invalid_structure",
  );
  assert.equal(stageField.validation.issues[0].line, 4);

  const rootField = assertInvalid(
    "version: 1\nstages:\n  - id: implement\nunknown: 1\n",
    "invalid_structure",
  );
  assert.equal(rootField.validation.issues[0].line, 4);
});

test("多个问题时 reason 取最早行号的问题码", () => {
  const result = assertInvalid(
    [
      "version: 1",
      "stages:",
      "  - id: Implement",
      "    tools: [read, nope]",
      "",
    ].join("\n"),
    "invalid_stage_id",
  );
  assert.deepEqual(
    result.validation.issues.map((issue) => issue.code),
    ["invalid_stage_id", "invalid_tools"],
  );
  assert.ok(result.validation.issues[0].line < result.validation.issues[1].line);
});

test("校验结果符合 contracts/workflow.ts 的 schema", () => {
  const good = parseWorkflow(SAMPLE_WORKFLOW_YAML);
  assert.ok(checkSchema(WorkflowValidationSchema, good.validation));
  assert.equal(good.validation.reason, null);

  const bad = parseWorkflow("version: 2\nstages:\n  - id: implement\n");
  assert.ok(checkSchema(WorkflowValidationSchema, bad.validation));
  for (const issue of bad.validation.issues) assert.ok(checkSchema(WorkflowIssueSchema, issue));
  assert.equal(bad.validation.reason, "unsupported_version");
  assert.equal(bad.workflow, null);
});

// ---------------------------------------------------------------------------
// tools 的写法（来自 test/stage-contract.test.mjs）

function stagesYaml(toolsLines) {
  return [
    "version: 1",
    "stages:",
    ...toolsLines.flatMap((line, index) => [
      `  - id: s${index}`,
      ...(line === null ? [] : [`    tools: ${line}`]),
    ]),
  ].join("\n");
}

test("tools 解析：不写／all／ALL → 全部放开，[] → 全部禁用，非空列表 → 白名单", () => {
  const parsed = parseWorkflow(stagesYaml([null, "all", "ALL", "[]", "[read, exec]"]));
  assert.equal(parsed.validation.ok, true, JSON.stringify(parsed.validation.issues));
  const tools = parsed.workflow.stages.map((stage) => stage.tools);
  assert.equal(tools[0], null, "不写 = 全部放开");
  assert.equal(tools[1], null, "all = 全部放开");
  assert.equal(tools[2], null, "ALL 大小写不敏感");
  assert.deepEqual(tools[3], [], "空数组 = 全部禁用，不再归一为全部放开");
  assert.deepEqual(tools[4], ["read", "exec"], "非空数组仍是白名单");
});

test("tools 解析：列表混入 all、单元素 [all] 与非 all 标量都报 invalid_tools 并带行号", () => {
  for (const [line, expectedLine] of [["[all, read]", 4], ["[read, ALL]", 4], ["[all]", 4], ["everything", 4], ["read", 4]]) {
    const parsed = parseWorkflow(stagesYaml([line]));
    assert.equal(parsed.workflow, null, line);
    assert.equal(parsed.validation.reason, "invalid_tools", line);
    const issue = parsed.validation.issues[0];
    assert.equal(issue.code, "invalid_tools");
    assert.equal(issue.line, expectedLine, line);
    assert.match(issue.message, new RegExp(`^第 ${expectedLine} 行：`));
  }
  const mixed = parseWorkflow(stagesYaml(["[all, read]"]));
  assert.match(mixed.validation.issues[0].message, /不能在能力列表里写 all/);
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

test("并行环节配置错误时，解析器指出具体行号", () => {
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
    if (code === "parallel_stage_requires_readonly_tools") {
      assert.match(issue.message, /必须只读.*不得含 write.*tools: \[read, exec\]/);
    }
    if (code === "invalid_tools") {
      assert.match(issue.message, /只读能力数组/);
      assert.doesNotMatch(issue.message, /tools: all|不写 tools/);
    }
  }
});

test("并行工具分别指出非法能力名和写权限", () => {
  for (const first of ["read", "write"]) {
    const result = parseWorkflow(parallelWorkflow.replace("[read, exec]", `[${first}, invalid]`));
    assert.equal(result.workflow, null);
    const issues = result.validation.issues;
    assert.deepEqual(issues.map(({ path, code }) => [path, code]), [
      ...(first === "write" ? [["/stages/1/tools/0", "parallel_stage_requires_readonly_tools"]] : []),
      ["/stages/1/tools/1", "invalid_tools"],
    ]);
    assert.match(issues.at(-1).message, /含无效能力 "invalid"/);
    assert.doesNotMatch(issues.at(-1).message, /不得含 write/);
  }
});

test("顶层的模型是缺省，环节可以写自己的", () => {
  const withModels = "version: 1\nmodel: p/a\nstages:\n  - id: implement\n  - id: review\n    model: p/b\n";
  const parsed = parseWorkflow(withModels);
  assert.deepEqual(parsed.validation.issues, []);
  assert.equal(parsed.workflow.model, "p/a");
  assert.deepEqual(parsed.workflow.stages.map((stage) => stage.model), [null, "p/b"]);

  const withoutModels = "version: 1\nstages:\n  - id: implement\n  - id: review\n";
  const bare = parseWorkflow(withoutModels);
  assert.equal(bare.validation.ok, true);
  assert.deepEqual(bare.workflow.stages.map((stage) => stage.model), [null, null]);

});

test("返工上限写在流程文件里", () => {
  const limited = "version: 1\nmaxRepairRounds: 2\nstages:\n  - id: implement\n  - id: review\n    maxVisits: 7\n";
  const parsed = parseWorkflow(limited);
  assert.deepEqual(parsed.validation.issues, []);
  assert.equal(parsed.workflow.defaultMaxVisits, 2);
  assert.deepEqual(parsed.workflow.stages.map((stage) => stage.maxVisits), [2, 7]);

  const unset = parseWorkflow("version: 1\nstages:\n  - id: implement\n  - id: review\n    maxVisits: 7\n");
  assert.equal(unset.workflow.defaultMaxVisits, 5);
  assert.deepEqual(unset.workflow.stages.map((stage) => stage.maxVisits), [5, 7]);
});

test("写错时指出行号", () => {
  const cases = [
    ["version: 1\nmodel: nomodel\nstages:\n  - id: implement\n", "invalid_model", 2, "第 2 行：model 要写成 provider/模型"],
    [
      "version: 1\nstages:\n  - id: implement\n  - id: review\n    model: /m\n",
      "invalid_model",
      5,
      "第 5 行：stages[1].model 要写成 provider/模型",
    ],
    [
      "version: 1\nstages:\n  - id: implement\nmaxRepairRounds: -1\n",
      "invalid_max_repair_rounds",
      4,
      "第 4 行：maxRepairRounds 必须是非负整数",
    ],
    [
      "version: 1\nmaxRepairRounds: 1.5\nstages:\n  - id: implement\n",
      "invalid_max_repair_rounds",
      2,
      "第 2 行：maxRepairRounds 必须是非负整数",
    ],
  ];
  for (const [source, code, line, message] of cases) {
    const parsed = parseWorkflow(source);
    assert.equal(parsed.workflow, null, source);
    assert.deepEqual(
      parsed.validation.issues.map((issue) => [issue.code, issue.line, issue.message]),
      [[code, line, message]],
      source,
    );
  }

  // a/b/c 合法：provider 是 a
  assert.equal(parseWorkflow("version: 1\nmodel: a/b/c\nstages:\n  - id: implement\n").workflow.model, "a/b/c");
});

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

test("思考等级由顶层提供缺省，环节的只管本环节", () => {
  const source = "version: 1\nthinking: high\nstages:\n  - id: implement\n  - id: review\n    thinking: off\n  - id: check\n";
  const parsed = parseWorkflow(source);
  assert.deepEqual(parsed.validation.issues, []);
  assert.equal(parsed.workflow.thinking, "high");
  assert.deepEqual(parsed.workflow.stages.map((stage) => stage.thinking), [null, "off", null]);
  const unset = "version: 1\nstages:\n  - id: implement\n  - id: review\n    thinking: high\n";
  assert.deepEqual(parseWorkflow(unset).workflow.stages.map((stage) => stage.thinking), [null, "high"]);

});

LEVELS.forEach((level) => {
  test(`顶层和环节都接受 Pi 思考等级 ${level}`, () => {
    const source = `version: 1\nthinking: ${level}\nstages:\n  - id: implement\n    thinking: ${level}\n`;
    const parsed = parseWorkflow(source);
    assert.deepEqual(parsed.validation.issues, []);
    assert.equal(parsed.workflow.stages[0].thinking, level);
  });
});

["ultra", "HIGH", "false", "42", "null", "[]", "{}", '""'].forEach((value) => {
  [
    { source: `version: 1\nthinking: ${value}\nstages:\n  - id: implement\n`, line: 2, path: "thinking" },
    { source: `version: 1\nstages:\n  - id: implement\n  - id: review\n    thinking: ${value}\n`, line: 5, path: "stages[1].thinking" },
  ].forEach((scenario) => {
    test(`${scenario.path} 写成 ${value} 时指出准确行号`, () => {
      const parsed = parseWorkflow(scenario.source);
      const message = `第 ${scenario.line} 行：${scenario.path} 只允许 off／minimal／low／medium／high／xhigh／max`;
      assert.equal(parsed.workflow, null);
      assert.equal(parsed.validation.reason, "invalid_thinking");
      assert.deepEqual(
        parsed.validation.issues.map((issue) => [issue.code, issue.line, issue.message]),
        [["invalid_thinking", scenario.line, message]],
      );
    });
  });
});
