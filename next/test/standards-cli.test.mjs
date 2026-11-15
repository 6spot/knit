import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { knit, project } from "./helpers/cli.mjs";

/** 和 workflow-cli.test.mjs 里的示例流程相同：implement、review 两个环节。 */
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

/** 建一个带流程的临时项目，`standards` 是文件名到内容的对照。 */
function projectWith(t, standards) {
  const dir = project(t);
  writeFileSync(join(dir, ".knit/workflow.yaml"), SAMPLE_WORKFLOW_YAML);
  mkdirSync(join(dir, ".knit/standards"));
  Object.entries(standards).forEach((entry) => writeFileSync(join(dir, ".knit/standards", entry[0]), entry[1]));
  return dir;
}

test("standards list：列出规范和各自适用的环节", (t) => {
  const dir = projectWith(t, {
    "development.md": "---\ntitle: 开发规范\nstages: [implement, review]\n---\n\n正文\n",
    "delivery.md": "---\ntitle: 交付规范\nstages: [deliver]\n---\n\n正文\n",
  });
  assert.deepEqual(knit(dir, "standards", "list"), {
    code: 0,
    stdout:
      ".knit/standards/delivery.md  交付规范  deliver\n" +
      ".knit/standards/development.md  开发规范  implement, review\n",
    stderr: "",
  });
  assert.deepEqual(knit(projectWith(t, {}), "standards", "list"), { code: 0, stdout: "没有规范\n", stderr: "" });
});

test("standards list：标出不会注入的规范", (t) => {
  const dir = projectWith(t, {
    "plain.md": "# 没有声明\n\n正文\n",
    "scalar.md": "---\ntitle: 写成了一个词\nstages: implement\n---\n\n正文\n",
  });
  assert.deepEqual(knit(dir, "standards", "list"), {
    code: 0,
    stdout:
      ".knit/standards/plain.md  plain  没有声明适用的环节，不会注入\n" +
      ".knit/standards/scalar.md  写成了一个词  开头声明有问题，不会注入：" +
      "字段 stages 的值不对：要写环节 id 的列表，例如 [implement, review]\n",
    stderr: "",
  });
});

test("standards list：标出流程里没有的环节", (t) => {
  const dir = projectWith(t, { "mixed.md": "---\ntitle: 混着写\nstages: [implement, check, discuss]\n---\n\n正文\n" });
  assert.deepEqual(knit(dir, "standards", "list"), {
    code: 0,
    stdout: ".knit/standards/mixed.md  混着写  implement, check, discuss（流程里没有的环节：check）\n",
    stderr: "",
  });

  const missing = project(t);
  mkdirSync(join(missing, ".knit/standards"));
  writeFileSync(join(missing, ".knit/standards/a.md"), "---\ntitle: 甲\nstages: [implement]\n---\n");
  const result = knit(missing, "standards", "list");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /knit init/);
});
