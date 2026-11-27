import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readMaterials } from "../dist/application/handoff.js";
import { sha256Text } from "../dist/contracts/primitives.js";
import { clarifyStateOf, scenarioStateOf } from "../dist/domain/task-requirements.js";
import { currentStatus, headingsOf, parseTaskDocument, parseTaskRecord, referencesOf, renderTaskDocument, renderTaskRecord, requirementDigest, sectionOf, taskDocumentMayHaveId, unparsedTaskId } from "../dist/domain/task.js";
import { project } from "./helpers/cli.mjs";

const FRONTMATTER = `id: k-19c962be9fb8
title: 交接只传需求部分
status: draft
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-14T13:36:56.000Z`;

const REQUIREMENT = `## 目标与范围

## 完成条件

## 待澄清

## 相关资料`;

const EXAMPLE = `---
${FRONTMATTER}
---

${REQUIREMENT}

## 结果

交接改为只传需求部分。
`;

const EMPTY_RECORD = { confirmedDigest: null, changedPaths: [], runs: [], authorization: null };

function documentOf(markdown) {
  const parsed = parseTaskDocument(markdown);
  assert.deepEqual(parsed.problems, []);
  return parsed.document;
}

test("解析出九个字段、需求部分和结果", () => {
  assert.deepEqual(documentOf(EXAMPLE), {
    frontmatter: {
      id: "k-19c962be9fb8",
      title: "交接只传需求部分",
      status: "draft",
      stage: null,
      verification: "self",
      parent: null,
      dependsOn: [],
      priority: "P2",
      createdAt: "2026-11-14T13:36:56.000Z",
    },
    requirement: REQUIREMENT,
    result: "交接改为只传需求部分。",
  });
});

test("CRLF 任务的开头字段、ID、需求摘要和渲染结果与 LF 一致", () => {
  const lf = documentOf(EXAMPLE);
  const crlf = EXAMPLE.replaceAll("\n", "\r\n");
  const parsed = documentOf(crlf);
  assert.deepEqual(parsed, lf);
  assert.equal(requirementDigest(parsed), requirementDigest(lf));
  assert.equal(renderTaskDocument(parsed), EXAMPLE);
  assert.equal(taskDocumentMayHaveId(crlf, new Set([lf.frontmatter.id])), true);
  assert.equal(taskDocumentMayHaveId(crlf, new Set(["k-000000000000"])), false);
  assert.equal(unparsedTaskId(crlf.replace("priority: P2", "priority: PX")), lf.frontmatter.id);
});

test("解析后再渲染与原文逐字相同", () => {
  assert.equal(renderTaskDocument(documentOf(EXAMPLE)), EXAMPLE);
  const full = EXAMPLE.replace("status: draft\nstage: null", "status: active\nstage: implement")
    .replace("title: 交接只传需求部分", 'title: "C1 任务文档：解析 a: b # c"')
    .replace("parent: null", "parent: k-aaaaaaaaaaaa")
    .replace("dependsOn: []", "dependsOn:\n  - k-bbbbbbbbbbbb\n  - k-cccccccccccc");
  assert.equal(renderTaskDocument(documentOf(full)), full);
});

test("改状态、写结果后需求部分和需求摘要不变", () => {
  const before = documentOf(EXAMPLE.replace("## 目标与范围\n", "## 目标与范围\n\n  缩进的一行  \n\n\n- 列表\n"));
  const rendered = renderTaskDocument({
    ...before,
    frontmatter: { ...before.frontmatter, status: "done" },
    result: "做完了。\n\n未验证：无。",
  });
  const after = documentOf(rendered);
  assert.equal(after.frontmatter.status, "done");
  assert.equal(after.result, "做完了。\n\n未验证：无。");
  assert.equal(after.requirement, before.requirement);
  assert.equal(requirementDigest(after), requirementDigest(before));
  assert.equal(requirementDigest(before), sha256Text(before.requirement));
});

test("代码围栏里的 ## 结果 留在需求部分", () => {
  const fenced = "## 目标与范围\n\n````markdown\n```\n## 结果\n```\n\n## 结果\n````\n\n~~~\n## 结果\n~~~";
  const document = documentOf(`---\n${FRONTMATTER}\n---\n\n${fenced}\n\n## 结果\n\n真正的结果\n`);
  assert.equal(document.requirement, fenced);
  assert.equal(document.result, "真正的结果");
});

test("没有 ## 结果 时结果是 null，渲染出的文本里没有这一节", () => {
  const markdown = `---\n${FRONTMATTER}\n---\n\n${REQUIREMENT}\n`;
  const document = documentOf(markdown);
  assert.equal(document.result, null);
  assert.equal(renderTaskDocument(document), markdown);
  assert.equal(renderTaskDocument(document).includes("## 结果"), false);
});

test("格式问题：得不到数据，问题里点到对应的字段", () => {
  const cases = [
    [EXAMPLE.replace("---\n", ""), /没有开头字段/],
    [EXAMPLE.replace("title: 交接只传需求部分", "title: a: b"), /不是合法的 YAML/],
    [EXAMPLE.replace("title: 交接只传需求部分\n", ""), /缺少字段 title/],
    [EXAMPLE.replace("priority: P2", "priority: P2\nowner: me"), /多了字段 owner/],
    [EXAMPLE.replace("status: draft", "status: open"), /字段 status 的值不对/],
    [EXAMPLE.replace("status: draft", "status: active"), /字段 stage 的值不对/],
    [EXAMPLE.replace("stage: null", "stage: implement"), /字段 stage 的值不对/],
  ];
  for (const [markdown, expected] of cases) {
    const parsed = parseTaskDocument(markdown);
    assert.equal(parsed.document, null);
    assert.match(parsed.problems.join("\n"), expected);
  }
});

test("currentStatus：确认之后改过需求的 ready／active 按 draft 算", () => {
  const withStatus = (status, stage = null) => {
    const document = documentOf(EXAMPLE);
    return { ...document, frontmatter: { ...document.frontmatter, status, stage } };
  };
  const confirmed = { ...EMPTY_RECORD, confirmedDigest: requirementDigest(documentOf(EXAMPLE)) };
  const stale = { ...EMPTY_RECORD, confirmedDigest: sha256Text("改动之前的需求") };

  assert.equal(currentStatus(withStatus("ready"), confirmed), "ready");
  assert.equal(currentStatus(withStatus("active", "implement"), confirmed), "active");
  assert.equal(currentStatus(withStatus("ready"), stale), "draft");
  assert.equal(currentStatus(withStatus("active", "implement"), stale), "draft");
  assert.equal(currentStatus(withStatus("ready"), EMPTY_RECORD), "draft");
  assert.equal(currentStatus(withStatus("done"), stale), "done");
  assert.equal(currentStatus(withStatus("draft"), confirmed), "draft");
});

test("record.json：空记录、往返和格式问题", () => {
  assert.deepEqual(parseTaskRecord(null), { record: EMPTY_RECORD, problems: [] });
  assert.equal(
    renderTaskRecord(EMPTY_RECORD),
    '{\n  "confirmedDigest": null,\n  "changedPaths": [],\n  "runs": [],\n  "authorization": null\n}\n',
  );

  const record = {
    authorization: "user:1f7f9eea",
    runs: [
      {
        sessionFile: null,
        resumeId: "native-id",
        requirementDigest: sha256Text("需求"),
        changedPaths: ["next/src/a.ts"],
        verdict: "pass",
        failure: null,
        endedAt: null,
        startedAt: "2026-11-15T01:00:00.000Z",
        stage: "review",
        id: "r-1",
      },
    ],
    changedPaths: ["next/src/b.ts"],
    confirmedDigest: sha256Text("需求"),
  };
  const rendered = renderTaskRecord(record);
  assert.deepEqual(parseTaskRecord(rendered), { record, problems: [] });
  assert.deepEqual(Object.keys(JSON.parse(rendered)), ["confirmedDigest", "changedPaths", "runs", "authorization"]);
  assert.deepEqual(Object.keys(JSON.parse(rendered).runs[0]), [
    "id",
    "stage",
    "startedAt",
    "endedAt",
    "verdict",
    "failure",
    "requirementDigest",
    "changedPaths",
    "sessionFile",
    "resumeId",
  ]);

  const cases = [
    ["{", /不是合法的 JSON/],
    [JSON.stringify({ ...EMPTY_RECORD, owner: "me" }), /多了字段 owner/],
    [JSON.stringify({ ...EMPTY_RECORD, changedPaths: "next/src/a.ts" }), /字段 changedPaths 的值不对/],
  ];
  for (const [json, expected] of cases) {
    const parsed = parseTaskRecord(json);
    assert.equal(parsed.record, null);
    assert.match(parsed.problems.join("\n"), expected);
  }
});

const runOf = (id, failure) => ({
  id,
  stage: "implement",
  startedAt: "2026-11-15T01:00:00.000Z",
  endedAt: "2026-11-15T01:10:00.000Z",
  verdict: null,
  failure,
  requirementDigest: "x",
  changedPaths: [],
  sessionFile: null,
  resumeId: null,
});

test("带失败原因的记录写出再读回不变", () => {
  const record = {
    confirmedDigest: "x",
    changedPaths: [],
    runs: [runOf("r-1", "执行者启动失败：模型不存在"), runOf("r-2", null)],
    authorization: null,
  };
  const rendered = renderTaskRecord(record);
  assert.deepEqual(parseTaskRecord(rendered), { record, problems: [] });
  for (const run of JSON.parse(rendered).runs) {
    assert.deepEqual(Object.keys(run), [
      "id",
      "stage",
      "startedAt",
      "endedAt",
      "verdict",
      "failure",
      "requirementDigest",
      "changedPaths",
      "sessionFile",
      "resumeId",
    ]);
  }
});

test("旧记录省略 resumeId 时按 null 读", () => {
  const { resumeId, ...oldRun } = runOf("r-1", null);
  const record = { confirmedDigest: "x", changedPaths: [], runs: [oldRun], authorization: null };
  assert.equal(parseTaskRecord(JSON.stringify(record)).record.runs[0].resumeId, null);
});

test("缺少失败原因字段的记录读不进来", () => {
  const { failure, ...withoutFailure } = runOf("r-1", null);
  const parsed = parseTaskRecord(
    JSON.stringify({ confirmedDigest: "x", changedPaths: [], runs: [withoutFailure], authorization: null }),
  );
  assert.equal(parsed.record, null);
  assert.ok(parsed.problems.some((problem) => problem.includes("failure")), JSON.stringify(parsed.problems));
});

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

test("待澄清忽略围栏中的标题和未决项", () => {
  for (const fence of ["````", "~~~~"]) {
    const markdown = [
      `   ${fence}markdown`, "## 待澄清", fence,
      "- [blocking] 仍在待澄清区段之前",
      "## 待澄清", ` ${fence}`, fence.slice(1),
      "- [assumed] 示例", "- [blocking] 示例", "## 其它", "# 一级标题", `${fence}${fence}`,
      "- [assumed] 实际假定", "- [blocking] 实际问题",
    ].join("\n");
    assert.deepEqual(clarifyStateOf(markdown), { blocking: 1, assumed: 1, blockingItems: ["实际问题"] });
  }
});

test("取出一节和它的下级内容", () => {
  const document = [
    "# 设计",
    "",
    "## 5. 交接",
    "",
    "交接的说明。",
    "",
    "### 5.1 给谁什么",
    "",
    "给执行者。",
    "",
    "### 5.2 放在哪里",
    "",
    "放在系统提示里。",
    "",
    "",
    "## 6. 流程",
    "",
    "流程的说明。",
    "",
  ].join("\n");
  const section = sectionOf(document, "5-交接");
  assert.equal(
    section,
    "## 5. 交接\n\n交接的说明。\n\n### 5.1 给谁什么\n\n给执行者。\n\n### 5.2 放在哪里\n\n放在系统提示里。",
  );
  assert.equal(sectionOf(document, "5. 交接"), section);
  assert.equal(sectionOf(document, "5.1 给谁什么"), "### 5.1 给谁什么\n\n给执行者。");
  assert.equal(sectionOf(document, "6-流程"), "## 6. 流程\n\n流程的说明。");
  assert.deepEqual(headingsOf(document.split("\n")).slice(0, 3), [
    { line: 0, level: 1, text: "设计" },
    { line: 2, level: 2, text: "5. 交接" },
    { line: 6, level: 3, text: "5.1 给谁什么" },
  ]);
});

test("代码围栏里的标题不算", () => {
  const document = [
    "## 3. 任务资料",
    "",
    "```markdown",
    "## 目标与范围",
    "",
    "~~~",
    "## 完成条件",
    "```",
    "",
    "围栏之后的内容。",
    "",
    "~~~~",
    "## 待澄清",
    "~~~",
    "## 相关资料",
    "~~~~",
    "",
    "## 4. 规范",
  ].join("\n");
  assert.equal(sectionOf(document, "3-任务资料"), document.split("\n").slice(0, 16).join("\n"));
  for (const anchor of ["目标与范围", "完成条件", "待澄清", "相关资料"]) {
    assert.equal(sectionOf(document, anchor), null, anchor);
  }
  assert.equal(sectionOf(document, "4-规范"), "## 4. 规范");
});

test("找不到和重名", () => {
  const document = ["## 示例", "", "第一个。", "", "## 其它", "", "## 示例", "", "第二个。"].join("\n");
  assert.equal(sectionOf(document, "没有这个标题"), null);
  assert.equal(sectionOf(document, ""), null);
  assert.equal(sectionOf(document, "示例"), "## 示例\n\n第一个。");
  assert.equal(sectionOf("## Task Files (task.md)\n\n正文\n", "task-files-taskmd"), "## Task Files (task.md)\n\n正文");
});

test("从「相关资料」读出路径和标题", () => {
  const requirement = [
    "## 目标与范围",
    "",
    "正文里提到的 `next/src/not-a-reference.ts` 不算。",
    "",
    "```markdown",
    "## 相关资料",
    "",
    "- `docs/example.md` — 围栏里的示例不算",
    "```",
    "",
    "## 相关资料",
    "",
    "- `.knit/standards/development.md` — 开发规范，里面的 `stages` 不算",
    "- `next/src/a.ts`、`next/src/b.ts` — `currentStatus`、渲染",
    "  - `next/src/indented.ts` — 缩进的行不算",
    "- `docs/design.md#5-交接` — 设计的 `5.1` 小节",
    "- `next/src/a.ts` — 写了第二次",
    "- `docs/design.md#` — 井号后面是空的",
    "",
    "## 结尾",
    "",
    "- `next/src/after.ts` — 下一节里的不算",
  ].join("\n");
  assert.deepEqual(referencesOf(requirement), [
    { path: ".knit/standards/development.md", anchor: null },
    { path: "next/src/a.ts", anchor: null },
    { path: "next/src/b.ts", anchor: null },
    { path: "docs/design.md", anchor: "5-交接" },
    { path: "docs/design.md", anchor: null },
  ]);
  assert.deepEqual(referencesOf("## 目标与范围\n\n- `next/src/a.ts` — 没有相关资料这一节"), []);
});

test("读出文件、章节和目录", (t) => {
  const root = project(t);
  mkdirSync(join(root, "src/pi"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "design.md"), "# 设计\n\n## 5. 交接\n\n只给需求部分。\n\n## 6. 流程\n\n可以配置。\n");
  const references = [
    { path: "./src/a.ts", anchor: null },
    { path: "design.md", anchor: "5-交接" },
    { path: "src/pi/", anchor: null },
  ];
  assert.deepEqual(readMaterials(root, references), {
    materials: [
      { reference: references[0], kind: "file", text: "export const a = 1;\n" },
      { reference: references[1], kind: "section", text: "## 5. 交接\n\n只给需求部分。" },
      { reference: references[2], kind: "directory", text: null },
    ],
    problems: [],
  });
});

test("找不到时说明是哪一份", (t) => {
  const root = project(t);
  writeFileSync(join(root, "design.md"), "## 5. 交接\n\n只给需求部分。\n");
  const existing = { path: "design.md", anchor: null };
  const result = readMaterials(root, [
    { path: "src/missing.ts", anchor: null },
    { path: "design.md", anchor: "7-返工" },
    existing,
    { path: "../outside.md", anchor: null },
  ]);
  assert.deepEqual(result.problems, [
    "相关资料里点名的文件不存在：src/missing.ts",
    "design.md 里没有标题「7-返工」",
    "相关资料里的路径要写项目内的相对路径：../outside.md",
  ]);
  assert.deepEqual(result.materials, [{ reference: existing, kind: "file", text: "## 5. 交接\n\n只给需求部分。\n" }]);
});
