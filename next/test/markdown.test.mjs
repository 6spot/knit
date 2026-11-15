import assert from "node:assert/strict";
import { test } from "node:test";
import { headingsOf, sectionOf } from "../dist/domain/markdown.js";

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
