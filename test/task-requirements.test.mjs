import test from "node:test";
import assert from "node:assert/strict";
import { clarifyStateOf, scenarioStateOf } from "../dist/domain/task-requirements.js";

const scenario = (name, steps = "- WHEN 执行操作\n- THEN 得到结果") => `#### Scenario: ${name}\n${steps}\n`;
const THREE = `## 完成条件\n\n### Requirement: 第一需求\n${scenario("第一场景")}${scenario("第二场景")}\n### Requirement: 第二需求\n${scenario("第三场景")}`;
const refs = scenarioStateOf(THREE).scenarios;

test("解析：编号与两级名称、加粗等价、围栏、自由列表", () => {
  assert.deepEqual(refs.map(({ id, requirement, name }) => [id, requirement, name]), [["R1.S1", "第一需求", "第一场景"], ["R1.S2", "第一需求", "第二场景"], ["R2.S1", "第二需求", "第三场景"]]);
  assert.deepEqual(scenarioStateOf(THREE).issues, []);
  const plain = `## 完成条件\n### Requirement: 需求\n${scenario("场景", "- GIVEN 条件\n- WHEN 操作\n- THEN 结果\n- AND 补充")}`;
  assert.deepEqual(scenarioStateOf(plain.replace(/- (GIVEN|WHEN|THEN|AND)/g, "- **$1**")), scenarioStateOf(plain));
  for (const fence of ["```", "~~~~"]) {
    const fenced = `${fence}markdown\n## 完成条件\n### Requirement：错字\n${fence}\n${THREE}\n${fence}markdown\n### Requirement: 示例\n#### Scenario: 无步骤\n## 输入引用\n${fence}\n## 输入引用\n### Requirement: 外部\n`;
    assert.deepEqual(scenarioStateOf(fenced), scenarioStateOf(THREE));
  }
  assert.deepEqual(scenarioStateOf("## 完成条件\n- 普通列表\n说明\n"), { scenarios: [], issues: [] });
  assert.deepEqual(scenarioStateOf(THREE.replaceAll("\n", "\r\n")), scenarioStateOf(THREE));
});

test("结构错误：空需求、缺步骤、空名与重名、近似标题与游离场景", () => {
  const cases = [
    ["### Requirement: 空需求", "requirement_without_scenario", /空需求/],
    [`### Requirement: 需求\n${scenario("只有 WHEN", "- WHEN 操作")}`, "scenario_missing_step", /只有 WHEN.*THEN/],
    [`### Requirement: 需求\n${scenario("只有 THEN", "- THEN 结果")}`, "scenario_missing_step", /只有 THEN.*WHEN/],
    ["### Requirement:   ", "name_empty", /Requirement.*为空/],
    ["### Requirement: 需求\n#### Scenario:   ", "name_empty", /Scenario.*为空/],
    [`### Requirement: 需求\n${scenario("场景")}### Requirement: 需求\n${scenario("场景")}`, "name_duplicate", /Requirement.*重复/],
    [`### Requirement: 需求\n${scenario("重复")}${scenario("重复")}`, "name_duplicate", /Scenario.*重复/],
    ["### Requirement：全角冒号", "heading_malformed", /全角冒号/],
    ["### Requirement: 需求\n#### scenario: 小写", "heading_malformed", /小写/],
    [scenario("游离"), "scenario_orphan", /游离/],
  ];
  for (const [body, kind, message] of cases) {
    const state = scenarioStateOf(`## 完成条件\n${body}`);
    assert.equal(state.issues.length, 1, body);
    assert.equal(state.issues[0].kind, kind, body);
    assert.match(state.issues[0].message, message);
  }
  for (const steps of ["- WHEN\n- THEN", "  - WHEN 操作\n- then 结果", "- **WHEN**   \n- THEN 结果"]) {
    assert.match(scenarioStateOf(`## 完成条件\n### Requirement: 需求\n${scenario("空或非顶格步骤", steps)}`).issues[0].message, /缺少/);
  }
  assert.equal(scenarioStateOf(THREE.replace("第三场景", "第一场景")).issues.length, 0, "跨 Requirement 场景名可重复");
});

test("待澄清：两种标记各自计数，正文最多 3 条并截断，区段到下一个标题为止", () => {
  const long = "长".repeat(121);
  const state = clarifyStateOf(
    [
      "## 完成条件",
      "- [blocking] 不在待澄清区段里",
      "## 待澄清",
      "",
      "- [blocking] 第一项 ",
      `- [blocking] ${long}`,
      "- [assumed] 假定项",
      "  - [blocking] 缩进的不算",
      "- [Blocking] 大小写不同的不算",
      "- [blocking] 第三项",
      "- [blocking] 第四项",
      "### 三级标题不结束区段",
      "- [assumed] 仍在区段里",
      "## 相关资料",
      "- [blocking] 区段之外",
    ].join("\n"),
  );
  assert.deepEqual(state, { blocking: 4, assumed: 2, blockingItems: ["第一项", `${"长".repeat(119)}…`, "第三项"] });
  assert.equal(Array.from(state.blockingItems[1]).length, 120);
  assert.deepEqual(clarifyStateOf("## 待澄清\n- [blocking] 甲\n# 一级标题\n- [blocking] 乙").blocking, 1);
  assert.deepEqual(clarifyStateOf(THREE), { blocking: 0, assumed: 0, blockingItems: [] });
  assert.deepEqual(clarifyStateOf("## 待澄清\n"), { blocking: 0, assumed: 0, blockingItems: [] });
});
