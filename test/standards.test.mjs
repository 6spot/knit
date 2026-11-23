import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadStandards } from "../dist/application/standards-store.js";
import { PITFALLS_PATH, pitfallsForStage, recordPitfall } from "../dist/domain/pitfalls.js";
import { parseStandard, standardsForStage } from "../dist/domain/standards.js";
import { project } from "./helpers/cli.mjs";

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
    parseStandard(".knit/standards/untitled.md", "---\nowner: someone\n---\n\n正文\n"),
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

  assert.deepEqual(standardsForStage([broken, scalar, open], "implement"), []);
});
