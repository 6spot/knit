import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const builtin = ["delivery.md  交付规范  deliver", "discussion.md  讨论规范  discuss", "task-splitting.md  任务拆分规范  discuss", "task-writing.md  任务编写规范  discuss"].map((row) => `knit:standards/${row}\n`).join("");

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
    stdout: builtin + ".knit/standards/development.md  开发规范  implement, review\n" +
      ".knit/standards/delivery.md  旧版副本，已停用；请把项目定制迁入另名的项目规范\n",
    stderr: "",
  });
  assert.deepEqual(knit(projectWith(t, {}), "standards", "list"), { code: 0, stdout: builtin, stderr: "" });
});

test("standards list：标出不会注入的规范", (t) => {
  const dir = projectWith(t, {
    "plain.md": "# 没有声明\n\n正文\n",
    "scalar.md": "---\ntitle: 写成了一个词\nstages: implement\n---\n\n正文\n",
  });
  assert.deepEqual(knit(dir, "standards", "list"), {
    code: 0,
    stdout: builtin +
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
    stdout: builtin + ".knit/standards/mixed.md  混着写  implement, check, discuss（流程里没有的环节：check）\n",
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

test("从空清单写入、补充适用条目，按当前流程分区查看", (t) => {
  const dir = projectWith(t, {});
  const workflow = join(dir, ".knit/workflow.yaml");
  writeFileSync(workflow, readFileSync(workflow, "utf8").replaceAll("review", "audit"));
  const file = join(dir, ".knit/standards/pitfalls.md");
  const record = (section, title, body) => knit(dir, "standards", "record", "--section", section, "--title", title, "--body", body);
  const show = (stage) => knit(dir, "standards", "pitfalls", stage);
  assert.equal(show("implement").stdout, "没有适用的避坑条目\n");
  assert.equal(record("通用", "查证", "所有环节先核实").code, 0);
  assert.equal(record("implement, audit", "运行夹具", "先执行夹具").code, 0);
  assert.equal(record("deliver", "交付", "交付时核对提交").code, 0);
  const add = () => record("audit", "运行夹具", "再检查输出");
  assert.equal(add().code, 0);
  const saved = readFileSync(file, "utf8");
  assert.equal(add().code, 0);
  assert.equal(record("review", "无效", "错误分区").code, 1);
  assert.equal(readFileSync(file, "utf8"), saved);
  assert.equal(saved.match(/### 运行夹具/g).length, 1);
  assert.equal(show("audit").stdout, "## 通用\n\n### 查证\n\n所有环节先核实\n\n## implement, audit\n\n### 运行夹具\n\n先执行夹具\n\n再检查输出\n");
  assert.equal(show("implement").stdout, show("audit").stdout);
  assert.equal(show("review").code, 1);
  assert.doesNotMatch(show("deliver").stdout, /运行夹具/);
  assert.match(knit(dir, "standards", "list").stdout, /分区：通用 \/ implement, audit \/ deliver/);
});
