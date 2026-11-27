import assert from "node:assert/strict";
import { test } from "node:test";
import { readReport, reportOutcome } from "../dist/domain/report.js";

const FENCE = "`".repeat(3);
const block = (value) => [`${FENCE}json`, typeof value === "string" ? value : JSON.stringify(value, null, 2), FENCE].join("\n");

test("没有声明字段时不要求代码块", () => {
  assert.deepEqual(readReport({}, "改了两个文件，测试都过了。"), { fields: {}, problems: [] });
  assert.deepEqual(readReport({}, `做完了。\n\n${block({ verdict: "pass" })}\n`), { fields: {}, problems: [] });
});

test("读出声明的字段", () => {
  const declared = { verdict: ["pass", "changes_requested", "blocked"], findings: "string[]", selfVerified: "bool" };
  const fields = {
    verdict: "changes_requested",
    findings: [`README 里的 ${FENCE}sh 代码块少了结尾`, "测试没有覆盖空输入"],
    selfVerified: false,
    note: "只看了 next/",
  };
  const report = [
    "## 审查结果",
    "",
    "报告的格式示例：",
    "",
    block({ verdict: "pass", findings: [], selfVerified: true }),
    "",
    "发现两个问题，见下。",
    "",
    block(fields),
    "",
  ].join("\n");
  assert.deepEqual(readReport(declared, report), { fields, problems: [] });

  // 前面的代码块再多，也取结尾那个
  const many = [...Array.from({ length: 20 }, (_, index) => block(`echo ${index}`)), block(fields)].join("\n\n");
  assert.deepEqual(readReport(declared, many), { fields, problems: [] });

  // 其余几种类型
  const others = { summary: "string", changedPaths: "paths" };
  const values = { summary: "", changedPaths: ["next/src/a.ts"] };
  assert.deepEqual(readReport(others, block(values)), { fields: values, problems: [] });
});

test("只读最后一个顶层围栏，尾块损坏或未闭合时要求补报", () => {
  const declared = { verdict: ["pass", "blocked"] };
  const example = block({ verdict: "pass" });
  for (const tail of [block('{"verdict":"blocked",}'), '~~~json\n{}\n```', `${FENCE}json\n{`,
    `~~~~markdown\n${example}\n~~~~`]) {
    assert.deepEqual(readReport(declared, `${example}\n\n${tail}`), {
      fields: null, problems: ["报告结尾没有能解析的 json 代码块"],
    });
  }
  assert.equal(readReport(declared, `正文 ${example}`).fields, null);
  assert.equal(readReport(declared, `  ${example}`).fields, null);
  const fields = { verdict: "blocked", example: `第一行\n${FENCE}json\n{}\n${FENCE}\n~~~` };
  for (const marker of [FENCE, "~~~"]) {
    const tail = [`${marker}json`, JSON.stringify(fields), marker].join("\r\n");
    assert.deepEqual(readReport(declared, `${example}\n${tail}`), { fields, problems: [] });
  }
});

test("空白报告即使没有声明字段也要求补报", () => {
  for (const declared of [{}, { verdict: ["pass"] }]) {
    assert.deepEqual(reportOutcome(declared, " \n\t"), { outcome: null, problems: ["执行者没有给出报告"] });
  }
});

test("读不出时说明原因", () => {
  const declared = { verdict: ["pass", "blocked"], changedPaths: "paths" };
  const cases = [
    ["都看过了，没有问题。", ["报告结尾没有能解析的 json 代码块"]],
    [block("verdict: pass"), ["报告结尾没有能解析的 json 代码块"]],
    [block(["pass"]), ["报告结尾没有能解析的 json 代码块"]],
    [block({ changedPaths: [] }), ["报告缺少字段 verdict"]],
    [
      block({ verdict: "ok", changedPaths: "next/src/a.ts" }),
      ["报告的字段 verdict 只能是 pass、blocked", "报告的字段 changedPaths 应当是路径数组"],
    ],
    [block({ verdict: "pass", changedPaths: ["a", ""] }), ["报告的字段 changedPaths 应当是路径数组"]],
  ];
  for (const [text, problems] of cases) {
    assert.deepEqual(readReport(declared, `结论见下。\n\n${text}\n`), { fields: null, problems }, text);
  }

  const typed = { summary: "string", findings: "string[]", selfVerified: "bool" };
  assert.deepEqual(readReport(typed, block({ summary: 1, findings: ["a", 2], selfVerified: "true" })), {
    fields: null,
    problems: [
      "报告的字段 summary 应当是字符串",
      "报告的字段 findings 应当是字符串数组",
      "报告的字段 selfVerified 应当是 true 或 false",
    ],
  });
});

test("额外字段保留在报告中，只有声明的 verdict 可作为结论", () => {
  const declared = { summary: "string" };
  const fields = { summary: "已核对", verdict: "pass", note: "详见附件" };
  const report = block(fields);
  assert.deepEqual(readReport(declared, report), { fields, problems: [] });
  assert.deepEqual(reportOutcome(declared, report), { outcome: { verdict: null, failure: null }, problems: [] });
  assert.deepEqual(reportOutcome({ ...declared, verdict: ["pass"] }, report), { outcome: { verdict: "pass", failure: null }, problems: [] });
  assert.deepEqual(reportOutcome({ verdict: "string" }, block({ verdict: "" })), { outcome: { verdict: null, failure: null }, problems: [] });
});
