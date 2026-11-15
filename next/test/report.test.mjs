import assert from "node:assert/strict";
import { test } from "node:test";
import { readReport } from "../dist/domain/report.js";

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
