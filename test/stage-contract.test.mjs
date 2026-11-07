/**
 * 阶段报告声明校验、顶部提示行与能力→Pi 参数（P3／P4）单元测试。
 * 不启动真实模型；参数构造与纯校验直接核对。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs, isolatedEnv } from "../dist/adapters/pi/runtime.js";
import {
  DEFAULT_WORKFLOW_YAML,
  fallbackWorkflowDefinition,
  parseWorkflow,
} from "../dist/domain/workflow.js";
import {
  isDecisionStage,
  reportVerdictOf,
  validateReportForStage,
} from "../dist/domain/report.js";
import { stageBriefOf } from "../dist/application/workflow.js";
import { buildUserPrompt, reportTemplateOf } from "../dist/application/stage.js";

const BASE = {
  executablePath: "pi",
  provider: "p",
  modelId: "m",
  cwd: "/repo",
  sessionDir: "/repo/.knit/.runtime/pi-sessions",
  sessionId: "native-1",
};

function argsOf(extra) {
  return buildPiArgs({ ...BASE, ...extra });
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("能力→Pi 参数：缺省收紧，external 放开扩展／MCP／技能，network 放开离线", () => {
  const restrictive = argsOf({ capabilities: ["read"], tools: ["read", "grep", "find", "ls"] });
  assert.ok(restrictive.includes("--offline"));
  assert.ok(restrictive.includes("--no-mcp"));
  assert.ok(restrictive.includes("--no-skills"));
  assert.ok(restrictive.includes("--no-extensions"));
  assert.equal(valueOf(restrictive, "--tools"), "read,grep,find,ls");

  const external = argsOf({
    capabilities: ["read", "external"],
    tools: null,
    toolAdditions: ["read", "grep", "find", "ls"],
    excludeTools: ["write", "edit", "bash", "powershell"],
  });
  assert.ok(external.includes("--offline"), "external 不自动放开网络");
  assert.equal(external.includes("--no-mcp"), false);
  assert.equal(external.includes("--no-skills"), false);
  assert.equal(external.includes("--no-extensions"), false);
  // external 用只增项保留未知扩展工具，再用 exclude 限制内置工具。
  assert.equal(valueOf(external, "--tools"), "+read,+grep,+find,+ls");
  assert.equal(valueOf(external, "--exclude-tools"), "write,edit,bash,powershell");

  const network = argsOf({ capabilities: ["network"], tools: ["bash"] });
  assert.equal(network.includes("--offline"), false);
  assert.ok(network.includes("--no-mcp"));
  const env = isolatedEnv({}, { offline: false });
  assert.equal("PI_OFFLINE" in env, false, "network 时环境不注入 PI_OFFLINE");
});

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
    assert.equal(parsed.mode, "fallback", line);
    assert.equal(parsed.validation.reason, "invalid_tools", line);
    const issue = parsed.validation.issues[0];
    assert.equal(issue.code, "invalid_tools");
    assert.equal(issue.line, expectedLine, line);
    assert.match(issue.message, new RegExp(`^第 ${expectedLine} 行：`));
  }
  const mixed = parseWorkflow(stagesYaml(["[all, read]"]));
  assert.match(mixed.validation.issues[0].message, /不能在能力列表里写 all/);
});

test("能力→Pi 参数：空能力全部禁用（--no-tools，离线并禁用扩展／MCP／技能）", () => {
  const disabled = argsOf({ capabilities: [], tools: [] });
  for (const flag of ["--no-tools", "--offline", "--no-mcp", "--no-skills", "--no-extensions"]) {
    assert.equal(disabled.includes(flag), true, `全部禁用应带 ${flag}`);
  }
  assert.equal(disabled.includes("--tools"), false);

  // all 与不写一样：不传 --tools／--no-tools。
  const parsed = parseWorkflow(stagesYaml(["all"]));
  const unrestricted = argsOf({ capabilities: parsed.workflow.stages[0].tools, tools: null });
  assert.equal(unrestricted.includes("--no-tools"), false);
  assert.equal(unrestricted.includes("--tools"), false);
  assert.equal(unrestricted.includes("--offline"), false);
});

test("能力→Pi 参数：未写 tools 表示全部放开；task 显式加载项目扩展", () => {
  const all = argsOf({ capabilities: null, tools: null });
  for (const flag of ["--offline", "--no-mcp", "--no-skills", "--no-extensions", "--no-tools"]) {
    assert.equal(all.includes(flag), false, `全部放开不应带 ${flag}`);
  }
  assert.equal(all.includes("--tools"), false);

  const task = argsOf({
    capabilities: ["task"],
    tools: ["knit_*"],
    extensionPaths: ["/repo/.pi/extensions/knit.ts"],
  });
  assert.equal(valueOf(task, "--tools"), "knit_*");
  assert.equal(task.includes("--no-extensions"), true, "未声明 external 仍关闭自动发现");
  const extensionIndex = task.indexOf("--extension");
  assert.notEqual(extensionIndex, -1);
  assert.equal(task[extensionIndex + 1], "/repo/.pi/extensions/knit.ts");
});

test("报告按阶段声明校验：paths 严格、枚举必填、未声明字段不参与判定", () => {
  const workflow = parseWorkflow(DEFAULT_WORKFLOW_YAML).workflow;
  const implement = workflow.stages.find((stage) => stage.id === "implement");
  const check = workflow.stages.find((stage) => stage.id === "check");
  assert.ok(implement && check);

  assert.equal(isDecisionStage(implement), false);
  assert.equal(isDecisionStage(check), true);

  assert.deepEqual(validateReportForStage(implement, { summary: "x", changedPaths: ["a.txt"] }, ["a.txt"]), {
    ok: true,
    reason: null,
  });
  assert.deepEqual(validateReportForStage(implement, { summary: "x" }, []), {
    ok: false,
    reason: "report_changed_paths_missing",
  });
  assert.deepEqual(validateReportForStage(implement, { summary: "x", changedPaths: ["b.txt"] }, ["a.txt"]), {
    ok: false,
    reason: "changed_paths_mismatch:a.txt",
  });
  // 未声明字段不阻断；声明字段类型仍严格。
  assert.equal(validateReportForStage(implement, { summary: "x", changedPaths: ["a"], extra: 1 }, ["a"]).ok, true);
  assert.equal(
    validateReportForStage(implement, { summary: "x", changedPaths: ["a"], unverified: "no" }, ["a"]).reason,
    "report_field_type:unverified:string[]",
  );

  assert.equal(validateReportForStage(check, { summary: "x", verdict: "pass", coverage: ["a"] }, []).ok, true);
  assert.equal(validateReportForStage(check, { summary: "x" }, []).reason, "report_verdict_missing");
  assert.equal(validateReportForStage(check, { summary: "x", verdict: "nope" }, []).reason, "report_field_value:verdict");
  assert.equal(reportVerdictOf(check, { summary: "x", verdict: "changes_requested" }), "changes_requested");

  const template = JSON.parse(reportTemplateOf(check));
  assert.deepEqual(template.coverage, ["src/app.ts：核对内容"], "coverage 示例展示单路径加核对内容");
  assert.equal(template.selfVerified, true, "报告模板中的布尔字段必须是布尔");
  assert.equal(template.verdict, "pass", "枚举示例使用首个合法值");

  // 结论阶段的用户提示明确 coverage 每项一路径；合并多项会被接收拒绝。
  const prompt = buildUserPrompt(
    { role: "check", stageBrief: null, sections: [] },
    check,
    {},
    { taskId: "k-aaaaaaaaaaaa", runId: "run-1", branch: "refs/heads/main", snapshotDir: null, scope: ["a.txt"], previousImplement: null },
  );
  assert.match(prompt, /coverage 每项一个路径（可写成「路径：核对内容」），不要合并多项；scope 中每个路径都要单独出现，否则接收会以 check_scope_incomplete 拒绝。/);
  assert.match(prompt, /"src\/app\.ts：核对内容"/);
});

test("顶部提示行使用 name／description 渲染流程、本步目标与完成条件", () => {
  const workflow = parseWorkflow(DEFAULT_WORKFLOW_YAML).workflow;
  const brief = stageBriefOf(workflow, "check", "config", null);
  assert.match(brief, /^流程：准备 → 实现 → 检查 → 收尾 ｜ 当前：检查$/m);
  assert.match(brief, /^本步目标：独立核对完成条件与实现成果$/m);
  assert.match(brief, /^完成条件：changes_requested → 实现；blocked → 检查；其他 → 收尾$/m);

  const fallback = stageBriefOf(fallbackWorkflowDefinition(), "implement", "fallback", "yaml_parse_error");
  assert.match(fallback, /配置降级：yaml_parse_error/);
  assert.match(fallback, /当前：implement/);
  assert.match(fallback, /完成后 → 收尾/);
});
