import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_REPAIR_ROUNDS,
  DEFAULT_WORKFLOW_YAML,
  fallbackWorkflowDefinition,
  parseWorkflow,
} from "../dist/domain/workflow.js";
import {
  TOOL_CAPABILITIES,
  WORKFLOW_ANCHORS,
  WORKFLOW_STAGE_ID_REGEX,
  WorkflowIssueSchema,
  WorkflowModeSchema,
  WorkflowValidationSchema,
} from "../dist/contracts/workflow.js";
import { checkSchema } from "../dist/contracts/schema.js";

function assertValid(source, options) {
  const result = parseWorkflow(source, options);
  assert.equal(result.mode, "config", JSON.stringify(result.validation.issues));
  assert.deepEqual(result.validation, { ok: true, issues: [], reason: null });
  return result.workflow;
}

function assertFallback(source, reason, options) {
  const result = parseWorkflow(source, options);
  assert.equal(result.mode, "fallback");
  assert.equal(result.validation.ok, false);
  assert.equal(result.validation.reason, reason);
  assert.deepEqual(result.workflow.stages, []);
  assert.deepEqual(result.workflow.anchors, WORKFLOW_ANCHORS);
  assert.ok(result.validation.issues.length > 0, "降级必须带问题清单");
  for (const issue of result.validation.issues) {
    assert.ok(issue.line >= 1);
    assert.ok(issue.column >= 1);
    assert.match(issue.message, new RegExp(`第 ${issue.line} 行`));
  }
  return result;
}

// ---------------------------------------------------------------------------
// 合法配置

test("默认模板解析为 config 模式并保留全部语义字段", () => {
  const workflow = assertValid(DEFAULT_WORKFLOW_YAML);
  assert.equal(workflow.version, 1);
  assert.deepEqual(workflow.anchors, ["start", "deliver"]);
  assert.deepEqual(workflow.stages.map((stage) => stage.id), ["implement", "check"]);
  assert.equal(workflow.defaultMaxVisits, DEFAULT_MAX_REPAIR_ROUNDS);

  const [implement, check] = workflow.stages;
  assert.equal(implement.name, "实现");
  assert.equal(implement.description, "按 task.md 完成产出并运行范围验证");
  assert.equal(implement.prompt, ".knit/agents/implement.md");
  assert.deepEqual(implement.tools, ["read", "write", "exec"]);
  assert.deepEqual(implement.report, { changedPaths: "paths", unverified: "string[]" });
  assert.deepEqual(implement.onVerdict, {});
  assert.equal(implement.maxVisits, DEFAULT_MAX_REPAIR_ROUNDS);

  assert.equal(check.name, "检查");
  assert.deepEqual(check.tools, ["read", "exec"]);
  assert.deepEqual(check.report.verdict, ["pass", "changes_requested", "blocked"]);
  assert.equal(check.report.coverage, "string[]");
  assert.equal(check.report.changedPaths, "paths");
  assert.equal(check.report.selfVerified, "bool");
  assert.deepEqual(check.onVerdict, { changes_requested: "implement", blocked: "check" });
  assert.equal(check.maxVisits, DEFAULT_MAX_REPAIR_ROUNDS);
});

test("最简阶段使用 id 作为显示名，其余字段取安全缺省", () => {
  const workflow = assertValid("version: 1\nstages:\n  - id: implement\n");
  assert.deepEqual(workflow.stages[0], {
    id: "implement",
    name: "implement",
    description: null,
    prompt: null,
    tools: null,
    report: {},
    onVerdict: {},
    maxVisits: DEFAULT_MAX_REPAIR_ROUNDS,
  });
});

test("maxRepairRounds 作为阶段缺省，显式 maxVisits 覆盖它", () => {
  const workflow = assertValid(
    "version: 1\nstages:\n  - id: implement\n  - id: check\n    maxVisits: 7\n",
    { maxRepairRounds: 5 },
  );
  assert.equal(workflow.defaultMaxVisits, 5);
  assert.equal(workflow.stages[0].maxVisits, 5);
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

test("六种能力全部可写，顺序保留", () => {
  const workflow = assertValid(
    `version: 1\nstages:\n  - id: implement\n    tools: [${TOOL_CAPABILITIES.join(", ")}]\n`,
  );
  assert.deepEqual(workflow.stages[0].tools, TOOL_CAPABILITIES);
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
      "stages:",
      "  - id: implement",
      "  - id: check",
      "    report:",
      "      verdict: [pass, changes_requested]",
      "    onVerdict:",
      "      changes_requested: implement",
      "",
    ].join("\n"),
    { maxRepairRounds: 3 },
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

test("按调用方的有效缺省解析回退定义", () => {
  assert.deepEqual(fallbackWorkflowDefinition(4), {
    version: 1,
    anchors: ["start", "deliver"],
    stages: [],
    defaultMaxVisits: 4,
  });
  assert.deepEqual(fallbackWorkflowDefinition(), {
    version: 1,
    anchors: ["start", "deliver"],
    stages: [],
    defaultMaxVisits: DEFAULT_MAX_REPAIR_ROUNDS,
  });
});

// ---------------------------------------------------------------------------
// 非法配置（全部降级为 start → deliver）

test("YAML 语法错误降级，消息与结构带行号", () => {
  const result = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    tools: [read,\n",
    "yaml_parse_error",
  );
  const issue = result.validation.issues[0];
  assert.ok(issue.line >= 4, `实际行号 ${issue.line}`);
  assert.equal(issue.path, "");
});

test("重复 YAML 键按解析错误降级", () => {
  const result = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    id: check\n",
    "yaml_parse_error",
  );
  assert.equal(result.validation.issues[0].line, 4);
});

test("缺少 version 降级并指向根位置", () => {
  const result = assertFallback("stages:\n  - id: implement\n", "unsupported_version");
  assert.equal(result.validation.issues[0].line, 1);
  assert.equal(result.validation.issues[0].path, "/version");
});

test("version 不是 1 降级", () => {
  for (const value of ["2", '"1"']) {
    const result = assertFallback(`version: ${value}\nstages:\n  - id: implement\n`, "unsupported_version");
    assert.equal(result.validation.issues[0].line, 1);
  }
});

test("缺少 stages 与 stages 为空都降级", () => {
  const missing = assertFallback("version: 1\n", "empty_stages");
  assert.equal(missing.validation.issues[0].line, 1);

  const empty = assertFallback("version: 1\nstages: []\n", "empty_stages");
  assert.equal(empty.validation.issues[0].line, 2);
});

test("stages 不是数组时降级", () => {
  const result = assertFallback("version: 1\nstages: {}\n", "invalid_structure");
  assert.equal(result.validation.issues[0].line, 2);
});

test("根节点不是映射时降级", () => {
  for (const source of ["", "just a string\n", "- a\n- b\n"]) {
    const result = assertFallback(source, "invalid_structure");
    assert.equal(result.validation.issues[0].line, 1);
  }
});

test("阶段 id 大写或超长降级", () => {
  const upper = assertFallback("version: 1\nstages:\n  - id: Implement\n", "invalid_stage_id");
  assert.equal(upper.validation.issues[0].line, 3);
  assert.equal(upper.validation.issues[0].path, "/stages/0/id");

  const tooLong = `a${"b".repeat(32)}`;
  const long = assertFallback(`version: 1\nstages:\n  - id: ${tooLong}\n`, "invalid_stage_id");
  assert.equal(long.validation.issues[0].line, 3);
});

test("内置锚点不能作为阶段 id", () => {
  for (const id of WORKFLOW_ANCHORS) {
    const result = assertFallback(`version: 1\nstages:\n  - id: ${id}\n`, "reserved_stage_id");
    assert.equal(result.validation.issues[0].line, 3);
  }
});

test("重复阶段 id 降级并指出重复位置", () => {
  const result = assertFallback(
    "version: 1\nstages:\n  - id: implement\n  - id: implement\n",
    "duplicate_stage_id",
  );
  assert.equal(result.validation.issues[0].line, 4);
  assert.equal(result.validation.issues[0].path, "/stages/1/id");
});

test("缺少阶段 id 降级", () => {
  const result = assertFallback("version: 1\nstages:\n  - name: 实现\n", "invalid_stage_id");
  assert.equal(result.validation.issues[0].line, 3);
});

test("未知能力或 tools 类型错误降级", () => {
  const unknown = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    tools: [read, nope]\n",
    "invalid_tools",
  );
  assert.equal(unknown.validation.issues[0].line, 4);
  assert.equal(unknown.validation.issues[0].path, "/stages/0/tools/1");

  const wrongType = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    tools: read\n",
    "invalid_tools",
  );
  assert.equal(wrongType.validation.issues[0].line, 4);
});

test("未知报告类型降级", () => {
  const result = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    report:\n      verdict: maybe\n",
    "invalid_report",
  );
  assert.equal(result.validation.issues[0].line, 5);
  assert.equal(result.validation.issues[0].path, "/stages/0/report/verdict");
});

test("空枚举数组与重复枚举值降级", () => {
  const empty = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    report:\n      verdict: []\n",
    "invalid_report",
  );
  assert.equal(empty.validation.issues[0].line, 5);

  const duplicate = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    report:\n      verdict: [pass, pass]\n",
    "duplicate_report_enum",
  );
  assert.equal(duplicate.validation.issues[0].line, 5);
});

test("maxVisits 负数、小数或字符串降级", () => {
  for (const value of ["-1", "1.5", '"2"']) {
    const result = assertFallback(
      `version: 1\nstages:\n  - id: implement\n    maxVisits: ${value}\n`,
      "invalid_max_visits",
    );
    assert.equal(result.validation.issues[0].line, 4);
    assert.equal(result.validation.issues[0].path, "/stages/0/maxVisits");
  }
});

test("onVerdict 目标不存在降级", () => {
  const result = assertFallback(
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

test("onVerdict 不能跳回 start 锚点", () => {
  const result = assertFallback(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    report:",
      "      verdict: [blocked]",
      "    onVerdict:",
      "      blocked: start",
      "",
    ].join("\n"),
    "unknown_on_verdict_target",
  );
  assert.equal(result.validation.issues[0].line, 7);
});

test("onVerdict 键未在 report 枚举中声明时降级", () => {
  const result = assertFallback(
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

test("无上限阶段之间成环时降级", () => {
  const result = assertFallback(
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
  const result = assertFallback(
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

test("缺省上限无效时，无显式 maxVisits 的环降级", () => {
  const result = assertFallback(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    report:",
      "      verdict: [again]",
      "    onVerdict:",
      "      again: implement",
      "",
    ].join("\n"),
    "unbounded_repair_cycle",
    { maxRepairRounds: -1 },
  );
  assert.equal(result.validation.issues[0].line, 3);
});

test("未知阶段字段与未知根字段降级", () => {
  const stageField = assertFallback(
    "version: 1\nstages:\n  - id: implement\n    tpyo: 1\n",
    "invalid_structure",
  );
  assert.equal(stageField.validation.issues[0].line, 4);

  const rootField = assertFallback(
    "version: 1\nstages:\n  - id: implement\nunknown: 1\n",
    "invalid_structure",
  );
  assert.equal(rootField.validation.issues[0].line, 4);
});

test("多个问题时 reason 取最早行号的问题码", () => {
  const result = assertFallback(
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

test("校验结果与运行模式符合 contracts/workflow.ts 的 schema", () => {
  const good = parseWorkflow(DEFAULT_WORKFLOW_YAML);
  assert.ok(checkSchema(WorkflowValidationSchema, good.validation));
  assert.ok(checkSchema(WorkflowModeSchema, good.mode));
  assert.equal(good.validation.reason, null);

  const bad = parseWorkflow("version: 2\nstages:\n  - id: implement\n");
  assert.ok(checkSchema(WorkflowValidationSchema, bad.validation));
  assert.ok(checkSchema(WorkflowModeSchema, bad.mode));
  for (const issue of bad.validation.issues) assert.ok(checkSchema(WorkflowIssueSchema, issue));
  assert.equal(bad.validation.reason, "unsupported_version");
});
