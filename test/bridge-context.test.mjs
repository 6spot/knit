import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task-document.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit, project } from "./helpers/cli.mjs";
import { readyTask } from "./helpers/run.mjs";

const HINT = "没有选中 Knit 任务。可以直接讨论需求；用户明确要求建任务时，用 knit_task 的 new 创建草稿。用 list 查看任务，use 选中或取消选择。";
const DISCUSSION_PATHS = [
  ".knit/standards/discussion.md",
  ".knit/standards/task-splitting.md",
  ".knit/standards/task-writing.md",
];
const paths = (text) => [...text.matchAll(/^<standard path="([^"]+)"/gm)].map((match) => match[1]);
const snapshot = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .sort()
  .map((file) => [file, readFileSync(file, "utf8")]);

/** 加载了真实初始化产物和 CLI 的临时项目，不调用模型。 */
async function bridged(t) {
  const dir = project(t);
  return { dir, bridge: await loadBridge(t, dir) };
}

async function newTask(bridge, title) {
  const created = await bridge.tool("knit_task", { action: "new", title });
  assert.equal(created.isError, undefined, created.content[0].text);
  const [first, file] = created.content[0].text.split("\n");
  return { id: first.replace("已创建 ", ""), file };
}

async function sectionsAfterTurn(bridge, sections = {}) {
  const event = { systemPromptOptions: { sections } };
  await bridge.fire("before_agent_start", event);
  return event.systemPromptOptions.sections;
}

test("首轮直接讨论，每轮完整提供 discuss 规范，不改任务和执行记录", async (t) => {
  const { dir, bridge } = await bridged(t);
  mkdirSync(join(dir, ".knit/standards/nested"));
  writeFileSync(join(dir, ".knit/standards/nested/writing.md"),
    "---\ntitle: 项目讨论规范\nstages: [discuss]\n---\n\n- 写清产出和完成条件。\n- 保留项目特有的讨论约束。\n");
  writeFileSync(join(dir, ".knit/standards/unassigned.md"), "不适用任何环节\n");
  readyTask(dir, { verification: "self" });
  const before = snapshot(join(dir, ".knit"));
  bridge.entries.push({ type: "message", id: "user-1", message: { role: "user", content: "我想给程序加问候语，先聊聊需求。" } });
  const entries = structuredClone(bridge.entries);
  const first = await sectionsAfterTurn(bridge, { other: "别的扩展的一段" });
  assert.deepEqual(first, { other: "别的扩展的一段", knit: `${knit(dir, "context").stdout.trimEnd()}\n${HINT}` });
  assert.deepEqual(paths(first.knit), [DISCUSSION_PATHS[0], ".knit/standards/nested/writing.md", ...DISCUSSION_PATHS.slice(1)]);
  assert.match(first.knit, /^- 保留项目特有的讨论约束。$/m);
  assert.doesNotMatch(first.knit, /^任务:|^状态:|^下一步:/m);
  assert.deepEqual(await sectionsAfterTurn(bridge, structuredClone(first)), first);
  assert.deepEqual(snapshot(join(dir, ".knit")), before);
  assert.deepEqual(bridge.entries, entries);
  assert.deepEqual(bridge.messages, []);
});

test("草稿切换、取消选择和待交付任务：每轮保留讨论规范并按路径去重", async (t) => {
  const { dir, bridge } = await bridged(t);
  writeFileSync(join(dir, ".knit/standards/shared.md"), "---\ntitle: 共享规则\nstages: [discuss, deliver]\n---\n\n共享规则正文\n");
  // 标题与正文相同但路径不同的文件不能被去掉。
  writeFileSync(join(dir, ".knit/standards/delivery-only.md"), "---\ntitle: 共享规则\nstages: [deliver]\n---\n\n共享规则正文\n");
  const drafts = [await newTask(bridge, "第一个任务"), await newTask(bridge, "另一个任务")];
  const discussionPaths = [DISCUSSION_PATHS[0], ".knit/standards/shared.md", ...DISCUSSION_PATHS.slice(1)];
  for (const task of drafts) {
    await bridge.tool("knit_task", { action: "use", taskId: task.id });
    const selected = (await sectionsAfterTurn(bridge)).knit;
    assert.equal(selected, knit(dir, "context", task.id).stdout.trimEnd());
    assert.deepEqual(paths(selected), discussionPaths);
    assert.match(selected, new RegExp(`^任务: .+（${task.id}）$`, "m"));
    assert.match(selected, /^状态: draft$/m);
    assert.match(selected, new RegExp(`^下一步: 先确认需求（knit task ready ${task.id}）$`, "m"));
    assert.doesNotMatch(selected.slice(selected.indexOf("任务:")), /<standard/);
  }
  await bridge.tool("knit_task", { action: "use" });
  assert.deepEqual(await sectionsAfterTurn(bridge), { knit: `${knit(dir, "context").stdout.trimEnd()}\n${HINT}` });

  const completed = readyTask(dir, { verification: "self" });
  assert.equal(knit(dir, "task", "close", completed.id, "--result", "已验证").code, 0);
  await bridge.tool("knit_task", { action: "use", taskId: completed.id });
  const before = snapshot(join(dir, ".knit"));
  const delivered = await sectionsAfterTurn(bridge);
  assert.deepEqual(paths(delivered.knit), [...discussionPaths, ".knit/standards/delivery-only.md", ".knit/standards/delivery.md"]);
  assert.match(delivered.knit, /^状态: done$/m);
  assert.match(delivered.knit, new RegExp(`^下一步: 用户授权后交付（knit deliver ${completed.id}）$`, "m"));
  assert.deepEqual(await sectionsAfterTurn(bridge, structuredClone(delivered)), delivered);
  assert.deepEqual(snapshot(join(dir, ".knit")), before);
});

test("用户明确要求后用现有工具建草稿、写需求，成功或失败都保持选择", async (t) => {
  const { dir, bridge } = await bridged(t);
  const description = bridge.definitions.find((tool) => tool.name === "knit_task").description;
  assert.match(description, /只有用户明确要求创建任务时才用 new 建草稿/);
  assert.match(description, /当轮回复中给出任务标题、编号、task.md 链接、draft 草稿状态及当前会话是否已选中/);
  assert.match(description, /创建失败时说明原因，当前讨论可以继续/);
  const first = await newTask(bridge, "现有草稿");
  assert.deepEqual(bridge.entries, []);
  assert.match((await sectionsAfterTurn(bridge)).knit, /没有选中 Knit 任务/);
  await bridge.tool("knit_task", { action: "use", taskId: first.id });
  bridge.entries.push({ type: "message", id: "user-1", message: { role: "user", content: "问候语输出到标准输出，不做配置和界面；把这些建成任务，先不要实施。" } });
  const entries = structuredClone(bridge.entries);
  const oldTask = snapshot(join(dir, dirname(first.file)));
  const created = await newTask(bridge, "输出问候语");
  const file = join(dir, created.file);
  const parsed = parseTaskDocument(readFileSync(file, "utf8"));
  const requirement = "## 目标与范围\n\n问候语输出到标准输出，不做配置和界面。\n\n## 完成条件\n\n### Requirement: 问候\n#### Scenario: 打招呼\n- WHEN 运行程序\n- THEN 标准输出包含问候语\n\n## 待澄清\n\n## 相关资料";
  writeFileSync(file, renderTaskDocument({ ...parsed.document, requirement }));
  const saved = parseTaskDocument(readFileSync(file, "utf8")).document;
  assert.equal(saved.requirement, requirement);
  assert.equal(saved.frontmatter.title, "输出问候语");
  assert.equal(saved.frontmatter.id, created.id);
  assert.equal(saved.frontmatter.status, "draft");
  assert.equal(existsSync(join(dir, dirname(created.file), "record.json")), false);
  assert.deepEqual(bridge.entries, entries);
  assert.deepEqual(snapshot(join(dir, dirname(first.file))), oldTask);
  assert.match((await sectionsAfterTurn(bridge)).knit, new RegExp(`^任务: 现有草稿（${first.id}）$`, "m"));

  const beforeFailure = snapshot(join(dir, ".knit"));
  const failed = await bridge.tool("knit_task", { action: "new", title: "创建失败", parent: "k-000000000000" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /k-000000000000/);
  assert.deepEqual(snapshot(join(dir, ".knit")), beforeFailure);
  assert.deepEqual(bridge.entries, entries);
  assert.deepEqual(paths((await sectionsAfterTurn(bridge)).knit), DISCUSSION_PATHS);
});

test("选中任务读不出来时仍保留讨论规范，缺少事件 sections 时不报错", async (t) => {
  const { dir, bridge } = await bridged(t);
  const task = await newTask(bridge, "会被删掉");
  await bridge.tool("knit_task", { action: "use", taskId: task.id });
  rmSync(join(dir, dirname(task.file)), { recursive: true });
  const before = structuredClone(bridge.entries);
  const missing = knit(dir, "context", task.id);
  assert.notEqual(missing.code, 0);
  assert.notEqual(missing.stderr.trim(), "");
  assert.deepEqual(await sectionsAfterTurn(bridge), {
    knit: `${knit(dir, "context").stdout.trimEnd()}\n选中的 Knit 任务 ${task.id} 读不出来：\n${missing.stderr.trimEnd()}`,
  });
  assert.deepEqual(bridge.entries, before);
  await bridge.fire("before_agent_start", {});
});
