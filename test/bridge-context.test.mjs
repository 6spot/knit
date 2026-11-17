import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadBridge } from "./helpers/bridge.mjs";
import { knit } from "./helpers/cli.mjs";

const HINT = "没有选中 Knit 任务。用 knit_task 的 list 查看任务，use 选中一个。";

/** 加载了桥接的临时项目，不在 Git 仓库里。 */
async function bridged(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bridge: await loadBridge(t, dir) };
}

/** 用 `knit_task` 的 `new` 建一个任务；返回它的 id 和任务文件的路径。 */
async function newTask(bridge, title) {
  const created = await bridge.tool("knit_task", { action: "new", title });
  assert.equal(created.isError, undefined, created.content[0].text);
  const [first, file] = created.content[0].text.split("\n");
  return { id: first.replace("已创建 ", ""), file };
}

/** 触发一轮，返回这一轮之后的各段系统提示。 */
async function sectionsAfterTurn(bridge, sections = {}) {
  const event = { systemPromptOptions: { sections } };
  await bridge.fire("before_agent_start", event);
  return event.systemPromptOptions.sections;
}

test("选中任务之后每一轮写入", async (t) => {
  const { dir, bridge } = await bridged(t);
  writeFileSync(
    join(dir, ".knit", "standards", "writing.md"),
    "---\ntitle: 任务编写规范\nstages: [discuss]\n---\n\n- 写清产出和完成条件。\n",
  );
  const task = await newTask(bridge, "第一个任务");
  await bridge.tool("knit_task", { action: "use", taskId: task.id });

  const first = await sectionsAfterTurn(bridge, { other: "别的扩展的一段" });
  assert.deepEqual(first, { other: "别的扩展的一段", knit: knit(dir, "context", task.id).stdout.trimEnd() });
  assert.match(first.knit, /^- 写清产出和完成条件。$/m);
  assert.match(first.knit, new RegExp(`^任务: 第一个任务（${task.id}）$`, "m"));

  assert.equal((await sectionsAfterTurn(bridge)).knit, first.knit);

  const other = await newTask(bridge, "另一个任务");
  await bridge.tool("knit_task", { action: "use", taskId: other.id });
  const switched = (await sectionsAfterTurn(bridge)).knit;
  assert.equal(switched, knit(dir, "context", other.id).stdout.trimEnd());
  assert.match(switched, new RegExp(`^任务: 另一个任务（${other.id}）$`, "m"));
});

test("没有选中任务", async (t) => {
  const { bridge } = await bridged(t);
  assert.deepEqual(bridge.entries, []);
  assert.deepEqual(await sectionsAfterTurn(bridge), { knit: HINT });

  const task = await newTask(bridge, "选了又取消");
  await bridge.tool("knit_task", { action: "use", taskId: task.id });
  await bridge.tool("knit_task", { action: "use" });
  assert.deepEqual(await sectionsAfterTurn(bridge), { knit: HINT });
});

test("选中的任务读不出来", async (t) => {
  const { dir, bridge } = await bridged(t);
  const task = await newTask(bridge, "会被删掉");
  await bridge.tool("knit_task", { action: "use", taskId: task.id });
  rmSync(join(dir, dirname(task.file)), { recursive: true });

  const missing = knit(dir, "context", task.id);
  assert.notEqual(missing.code, 0);
  assert.notEqual(missing.stderr.trim(), "");
  assert.deepEqual(await sectionsAfterTurn(bridge), {
    knit: `选中的 Knit 任务 ${task.id} 读不出来：\n${missing.stderr.trimEnd()}`,
  });

  await bridge.fire("before_agent_start", {});
});
