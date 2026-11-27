import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadStandards, savePitfall } from "../dist/application/project-config.js";
import { PITFALLS_PATH, pitfallScope, pitfallsForStage, recordPitfall } from "../dist/domain/pitfalls.js";
import { parseStandard, standardsForStage } from "../dist/domain/standards.js";
import { knit, project } from "./helpers/cli.mjs";

test("挑出适用某个环节的规范", (t) => {
  const root = project(t);
  const dir = join(root, ".knit/standards");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "a.md"), "---\ntitle: 甲\nstages: [implement, review]\n---\n\n## 范围\n\n- 甲的正文\n");
  writeFileSync(join(dir, "b.md"), "---\ntitle: 乙\nstages: [deliver]\n---\n\n乙的正文\n");
  writeFileSync(join(dir, "sub/c.md"), "---\ntitle: 丙\nstages: [implement]\n---\n丙的正文\n");
  writeFileSync(join(dir, "notes.txt"), "不是规范\n");

  const standards = loadStandards(root);
  const builtin = loadStandards(project(t));
  assert.deepEqual(builtin.map(({ path }) => path), ["delivery", "discussion", "task-splitting", "task-writing"].map((name) => `knit:standards/${name}.md`));
  assert.deepEqual(standards.slice(0, builtin.length), builtin);
  assert.deepEqual(
    standards.slice(builtin.length).map((standard) => standard.path),
    [".knit/standards/a.md", ".knit/standards/b.md", ".knit/standards/sub/c.md"],
  );
  assert.deepEqual(standardsForStage(standards, "implement"), [
    { path: ".knit/standards/a.md", title: "甲", stages: ["implement", "review"], body: "## 范围\n\n- 甲的正文", problems: [] },
    { path: ".knit/standards/sub/c.md", title: "丙", stages: ["implement"], body: "丙的正文", problems: [] },
  ]);
  assert.deepEqual(standardsForStage(standards, "discuss"), builtin.slice(1));
});

test("没有声明环节的规范不挑", () => {
  const standards = [
    parseStandard(".knit/standards/plain.md", "# 没有声明\n\n正文\n"),
    parseStandard(".knit/standards/untitled.md", "---\n---\n\n正文\n"),
    parseStandard(".knit/standards/empty.md", "---\ntitle: 空的\nstages: []\n---\n\n正文\n"),
  ];
  for (const standard of standards) {
    assert.deepEqual(standard.stages, []);
    assert.deepEqual(standard.problems, []);
  }
  for (const stage of ["discuss", "implement", "review", "deliver"]) {
    assert.deepEqual(standardsForStage(standards, stage), []);
  }
  assert.deepEqual(
    standards.map((standard) => standard.title),
    ["plain", "untitled", "空的"],
  );
  assert.equal(standards[0].body, "# 没有声明\n\n正文");
  assert.equal(standards[1].body, "正文");
});

test("清单保留手写内容、围栏和换行，空分区及未选分区不注入", () => {
  const lines = ["---", "title: 清单", "---", "", "## 通用", "", "### 路径", "", "~~~md", "## deliver", "~~~", "", "## review, implement", "", "### 复验", "", "现有记录", "", "## deliver", "", "### 交付", "", "交付记录", "", "## discuss", ""];
  const original = lines.join("\r\n");
  const supplemented = recordPitfall(original, "implement, review", "复验", "跑两轮");
  assert.equal(supplemented, original.replace("现有记录", "现有记录\r\n\r\n跑两轮"));
  assert.equal(recordPitfall(supplemented, "implement", "复验", "跑两轮"), supplemented);
  assert.equal(recordPitfall(original, "discuss", "路径", "补充"), original.replace("~~~\r\n\r\n## review", "~~~\r\n\r\n补充\r\n\r\n## review"));
  const parsed = parseStandard(PITFALLS_PATH, supplemented);
  assert.equal(pitfallsForStage(parsed.body, "discuss"), "## 通用\n\n### 路径\n\n~~~md\n## deliver\n~~~");
  const empty = parseStandard(PITFALLS_PATH, "## review\n\n## deliver\n交付记录");
  assert.deepEqual(standardsForStage([empty], "review", new Set([PITFALLS_PATH])), []);
  assert.throws(() => recordPitfall(original, "discuss", "条目", "```\n## 示例"), /围栏要闭合/);
});

test("声明写坏的规范不挑并说明问题", () => {
  const broken = parseStandard(".knit/standards/broken.md", "---\ntitle: [没有收尾\nstages: [implement]\n---\n\n正文\n");
  assert.deepEqual(broken.stages, []);
  assert.match(broken.problems.join("\n"), /不是合法的 YAML/);
  assert.equal(broken.title, "broken");

  const scalar = parseStandard(".knit/standards/scalar.md", "---\ntitle: 写成了一个词\nstages: implement\n---\n\n正文\n");
  assert.deepEqual(scalar.stages, []);
  assert.deepEqual(scalar.problems, ["字段 stages 的值不对：要写环节 id 的列表，例如 [implement, review]"]);
  assert.equal(scalar.title, "写成了一个词");
  assert.equal(scalar.body, "---\ntitle: 写成了一个词\nstages: implement\n---\n\n正文");

  const open = parseStandard(".knit/standards/open.md", "---\ntitle: 没有结束\nstages: [implement]\n\n正文\n");
  assert.deepEqual(open.stages, []);
  assert.match(open.problems.join("\n"), /没有结束/);

  assert.deepEqual(standardsForStage([broken, scalar, open], "implement", new Set([broken.path, scalar.path, open.path])), []);
  const typo = parseStandard("custom.md", '---\ntitle: "  标题  "\nstage: [implement]\n---\n正文');
  assert.equal(typo.title, "标题");
  assert.deepEqual(typo.problems, ["多了字段 stage"]);
  const aliases = (n) => parseStandard("alias.md", `---\ntitle: &s review\nstages: [${Array(n).fill("*s").join(", ")}]\n---\n正文`);
  assert.deepEqual(aliases(99).problems, []);
  assert.match(aliases(100).problems.join("\n"), /YAML.*alias count/i);
});

test("首次记录按普通目录权限创建，拒绝无效分区和缺少闭合行的清单", (t) => {
  const root = project(t);
  savePitfall(root, "通用", "条目", "正文");
  assert.equal(statSync(join(root, ".knit/standards")).mode & 0o777, 0o777 & ~process.umask());
  for (const scope of ["", "  ", "通用, implement", "implement、通用"]) {
    assert.equal(pitfallScope(scope), null);
    assert.throws(() => recordPitfall("", scope, "条目", "正文"), /分区/);
  }
  assert.equal(pitfallsForStage("## 通用, implement\n坏分区\n## review\n有效", "implement"), "");
  assert.throws(() => recordPitfall("---\ntitle: 清单\n## 通用", "通用", "条目", "正文"), /没有结束/);
});

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

const builtin = ["delivery.md  交付规范  deliver", "discussion.md  讨论规范  discuss", "task-splitting.md  任务拆分规范  discuss", "task-writing.md  任务编写规范  discuss"].map((row) => {
  const name = row.split(" ")[0];
  const source = readFileSync(new URL(`../assets/standards/${name}`, import.meta.url), "utf8");
  const bytes = Buffer.byteLength(parseStandard(name, source).body);
  return `knit:standards/${row}  ${bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`}\n`;
}).join("");

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
    "edge.md": "字".repeat(341),
    "kilobyte.md": "字".repeat(341) + "a",
    "rounded.md": "字".repeat(500),
    "development.md": "---\ntitle: 开发规范\nstages: [implement, review]\n---\n\n正文\n",
    "delivery.md": "---\ntitle: 交付规范\nstages: [deliver]\n---\n\n正文\n",
  });
  assert.deepEqual(knit(dir, "standards", "list"), {
    code: 0,
    stdout: builtin + ".knit/standards/development.md  开发规范  implement, review  6 B\n" +
      ".knit/standards/edge.md  edge  没有声明适用的环节，不会注入  1023 B\n" +
      ".knit/standards/kilobyte.md  kilobyte  没有声明适用的环节，不会注入  1.0 KB\n" +
      ".knit/standards/rounded.md  rounded  没有声明适用的环节，不会注入  1.5 KB\n" +
      ".knit/standards/delivery.md  旧版副本，已停用；请把项目定制迁入另名的项目规范\n",
    stderr: "",
  });
  assert.deepEqual(knit(projectWith(t, {}), "standards", "list"), { code: 0, stdout: builtin, stderr: "" });
});

test("standards list：标出不会注入的规范", (t) => {
  const dir = projectWith(t, {
    "plain.md": "# 没有声明\n\n正文\n",
    "scalar.md": "---\ntitle: 写成了一个词\nstages: implement\n---\n\n正文\n",
    "yaml.md": "---\ntitle: [未闭合\n---\n",
  });
  const listed = knit(dir, "standards", "list");
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stderr, "");
  const [known, invalidYaml] = listed.stdout.split(".knit/standards/yaml.md  yaml  ");
  assert.equal(known, builtin +
    ".knit/standards/plain.md  plain  没有声明适用的环节，不会注入  22 B\n" +
    ".knit/standards/scalar.md  写成了一个词  开头声明有问题，不会注入：" +
    "字段 stages 的值不对：要写环节 id 的列表，例如 [implement, review]  59 B\n");
  assert.match(invalidYaml, /^开头声明有问题，不会注入：开头声明不是合法的 YAML：/);
});

test("standards list：标出流程里没有的环节", (t) => {
  const dir = projectWith(t, { "mixed.md": "---\ntitle: 混着写\nstages: [implement, check, discuss]\n---\n\n正文\n" });
  assert.deepEqual(knit(dir, "standards", "list"), {
    code: 0,
    stdout: builtin + ".knit/standards/mixed.md  混着写  implement, check, discuss（流程里没有的环节：check）  6 B\n",
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
  assert.equal(statSync(file).mode & 0o777, 0o644);
  savePitfall(dir, "implement, audit", "运行夹具", "先执行夹具");
  assert.equal(statSync(file).mode & 0o777, 0o644);
  savePitfall(dir, "deliver", "交付", "交付时核对提交");
  savePitfall(dir, "audit", "运行夹具", "再检查输出");
  const saved = readFileSync(file, "utf8");
  savePitfall(dir, "audit", "运行夹具", "再检查输出");
  assert.match(record("", "无效", "空分区").stderr, /分区要写/);
  assert.equal(record("review", "无效", "错误分区").code, 1);
  assert.equal(readFileSync(file, "utf8"), saved);
  assert.equal(saved.match(/### 运行夹具/g).length, 1);
  const audit = show("audit");
  assert.equal(audit.code, 0, audit.stderr);
  assert.equal(audit.stdout, "## 通用\n\n### 查证\n\n所有环节先核实\n\n## implement, audit\n\n### 运行夹具\n\n先执行夹具\n\n再检查输出\n");
  const checklist = loadStandards(dir).filter((standard) => standard.path === PITFALLS_PATH);
  assert.equal(`${standardsForStage(checklist, "implement")[0].body}\n`, audit.stdout);
  assert.equal(show("review").code, 1);
  assert.doesNotMatch(standardsForStage(checklist, "deliver")[0].body, /运行夹具/);
  assert.match(knit(dir, "standards", "list").stdout, /分区：通用 \/ implement, audit \/ deliver/);
});
