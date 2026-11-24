import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskDocument, renderTaskDocument, requirementDigest } from "../dist/domain/task.js";
import { saveTask, findTask } from "../dist/application/task-store.js";
import { knit, project } from "./helpers/cli.mjs";

const scenario = (name, steps = "- WHEN 执行操作\n- THEN 得到结果") => `#### Scenario: ${name}\n${steps}\n`;
const requirementOf = ({ acceptance = "", clarify = "" }) =>
  `## 目标与范围\n\n## 完成条件\n\n${acceptance}\n## 待澄清\n\n${clarify}\n## 相关资料`;
const TWO = `### Requirement: 需求\n${scenario("第一场景")}${scenario("第二场景")}`;

/** 用 `task new` 建任务，再把需求部分（和开头字段）直接改写成给定的内容。 */
function create(dir, requirement, frontmatter = {}, ...args) {
  const [first, path] = knit(dir, "task", "new", "--title", "确认需求", ...args).stdout.split("\n");
  const task = { id: first.replace("已创建 ", ""), file: join(dir, path), record: join(dir, path.replace("task.md", "record.json")) };
  const document = read(task);
  writeFileSync(task.file, renderTaskDocument({ ...document, requirement, frontmatter: { ...document.frontmatter, ...frontmatter } }));
  return task;
}

const read = (task) => parseTaskDocument(readFileSync(task.file, "utf8")).document;
const record = (task) => JSON.parse(readFileSync(task.record, "utf8"));

test("确认通过：状态变成 ready，记下需求摘要", (t) => {
  const dir = project(t);
  const task = create(dir, requirementOf({ acceptance: TWO, clarify: "- [assumed] 上限按 64 KB\n" }));
  const before = read(task);

  assert.deepEqual(knit(dir, "task", "ready", task.id), {
    code: 0,
    stdout: `已确认 ${task.id}：2 个场景\n还有 1 项 [assumed] 没有得到用户确认\n`,
    stderr: "",
  });
  const after = read(task);
  assert.deepEqual(after, { ...before, frontmatter: { ...before.frontmatter, status: "ready" } });
  assert.deepEqual(record(task), { confirmedDigest: requirementDigest(after), changedPaths: [], runs: [], authorization: null });
  assert.match(knit(dir, "task", "show", task.id).stdout, /^状态: ready$/m);

  // self／none 的任务可以不写场景，完成条件用普通列表。
  const plain = create(dir, requirementOf({ acceptance: "- 能跑通\n" }), {}, "--slug", "plain", "--verification", "none");
  assert.deepEqual(knit(dir, "task", "ready", plain.id), { code: 0, stdout: `已确认 ${plain.id}：0 个场景\n`, stderr: "" });
});

test("不满足时拒绝并说明怎么改，不写文件", (t) => {
  const dir = project(t);
  const cases = [
    [
      requirementOf({ acceptance: TWO, clarify: "- [blocking] 上限是多少\n- [blocking] 超出时怎么办\n- [blocking] 谁确认\n- [blocking] 第四项\n" }),
      {},
      [/4 项 \[blocking\]/, /  - 上限是多少\n  - 超出时怎么办\n  - 谁确认\n  和用户/, /把结论写进正文并删掉这一行/],
    ],
    [
      requirementOf({ acceptance: `### Requirement: 需求\n${scenario("缺一步", "- WHEN 执行操作")}` }),
      {},
      [/1 处写法问题/, /缺一步.*THEN/, /#### Scenario: 名称\n- GIVEN/],
    ],
    [
      requirementOf({ acceptance: "- 能跑通\n" }),
      { verification: "independent" },
      [/独立审查的任务必须把完成条件写成场景/, /verification 改成 self/, /#### Scenario: 名称\n- GIVEN/],
    ],
  ];
  cases.forEach(([requirement, frontmatter, expected], index) => {
    const task = create(dir, requirement, frontmatter, "--slug", `case-${index}`);
    const before = readFileSync(task.file, "utf8");
    const result = knit(dir, "task", "ready", task.id);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    for (const pattern of expected) assert.match(result.stderr, pattern);
    assert.equal(readFileSync(task.file, "utf8"), before);
    assert.equal(existsSync(task.record), false);
  });

  // 几条同时不满足时都列出来。
  const both = create(
    dir,
    requirementOf({ acceptance: "### Requirement: 空的\n", clarify: "- [blocking] 没定\n" }),
    {},
    "--slug",
    "both",
  );
  const result = knit(dir, "task", "ready", both.id);
  assert.match(result.stderr, /1 项 \[blocking\]/);
  assert.match(result.stderr, /1 处写法问题/);

  assert.deepEqual(knit(dir, "task", "ready", "k-000000000000"), {
    code: 1,
    stdout: "",
    stderr: "没有任务 k-000000000000；用 knit task list 查看现有任务\n",
  });
  for (const status of ["done", "delivered", "cancelled"]) {
    const ended = create(dir, requirementOf({ acceptance: TWO }), { status }, "--slug", status);
    const refused = knit(dir, "task", "ready", ended.id);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`任务已经结束（${status}）.*新建一个任务`));
    assert.equal(existsSync(ended.record), false);
  }
});

test("确认后改了需求要重新确认；没改时不写文件", (t) => {
  const dir = project(t);
  const task = create(dir, requirementOf({ acceptance: TWO }));
  knit(dir, "task", "ready", task.id);
  const confirmed = [readFileSync(task.file, "utf8"), readFileSync(task.record, "utf8")];

  assert.deepEqual(knit(dir, "task", "ready", task.id), { code: 0, stdout: "已确认，需求没有变化\n", stderr: "" });
  assert.deepEqual([readFileSync(task.file, "utf8"), readFileSync(task.record, "utf8")], confirmed);

  // 正在某个环节里的任务：需求没变时不需要重新确认。
  const active = { ...read(task), frontmatter: { ...read(task).frontmatter, status: "active", stage: "implement" } };
  writeFileSync(task.file, renderTaskDocument(active));
  const refused = knit(dir, "task", "ready", task.id);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /任务正在 implement 环节，需求没有变化，不需要重新确认/);

  // 改了需求：回到 ready、环节清空，摘要更新。
  const changed = requirementOf({ acceptance: `${TWO}${scenario("第三场景")}` });
  writeFileSync(task.file, renderTaskDocument({ ...active, requirement: changed }));
  assert.match(knit(dir, "task", "show", task.id).stdout, /^状态: draft（确认后改过需求/m);
  assert.deepEqual(knit(dir, "task", "ready", task.id), { code: 0, stdout: `已确认 ${task.id}：3 个场景\n`, stderr: "" });
  const after = read(task);
  assert.equal(after.frontmatter.status, "ready");
  assert.equal(after.frontmatter.stage, null);
  assert.equal(after.requirement, changed);
  assert.equal(record(task).confirmedDigest, requirementDigest(after));
  assert.notEqual(record(task).confirmedDigest, JSON.parse(confirmed[1]).confirmedDigest);

  // 读入之后文件被别人改过：不覆盖，说明是哪个文件。
  const stored = findTask(dir, task.id);
  const edited = renderTaskDocument({ ...after, requirement: `${changed}\n\n别人加的一行` });
  writeFileSync(task.file, edited);
  const recordBefore = readFileSync(task.record, "utf8");
  const conflicts = saveTask(dir, stored, stored.document, { ...stored.record, confirmedDigest: null });
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /task\.md 在读入之后被改过/);
  assert.equal(readFileSync(task.file, "utf8"), edited);
  assert.equal(readFileSync(task.record, "utf8"), recordBefore);
});
