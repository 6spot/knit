import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBridge } from "./helpers/bridge.mjs";
import { knit } from "./helpers/cli.mjs";

/** 加载了桥接的临时项目，不在 Git 仓库里。 */
async function bridged(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bridge: await loadBridge(t, dir) };
}

const text = (result) => result.content[0].text;
const selections = (bridge) => bridge.entries.map((entry) => [entry.type, entry.customType, entry.data]);

test("选中和取消选中", async (t) => {
  const { dir, bridge } = await bridged(t);
  const id = knit(dir, "task", "new", "--title", "要选中的任务").stdout.split("\n")[0].replace("已创建 ", "");
  assert.deepEqual(bridge.entries, []);

  const used = await bridge.tool("knit_task", { action: "use", taskId: id });
  assert.equal(used.isError, undefined, text(used));
  assert.equal(text(used), `已选中 ${id}\n${knit(dir, "task", "show", id).stdout.trimEnd()}`);
  assert.deepEqual(selections(bridge), [["custom", "knit.selection", { taskId: id }]]);

  const cleared = await bridge.tool("knit_task", { action: "use" });
  assert.equal(cleared.isError, undefined);
  assert.equal(text(cleared), "已取消选中");
  assert.deepEqual(selections(bridge), [
    ["custom", "knit.selection", { taskId: id }],
    ["custom", "knit.selection", { taskId: null }],
  ]);

  const created = await bridge.tool("knit_task", { action: "new", title: "新建的不选中" });
  assert.equal(created.isError, undefined, text(created));
  assert.equal(bridge.entries.length, 2);
});

test("选一个不存在的任务", async (t) => {
  const { dir, bridge } = await bridged(t);
  const shown = knit(dir, "task", "show", "k-000000000000");
  assert.notEqual(shown.code, 0);

  const used = await bridge.tool("knit_task", { action: "use", taskId: "k-000000000000" });
  assert.equal(used.isError, true);
  assert.equal(text(used), shown.stderr.trimEnd());
  assert.deepEqual(bridge.entries, []);
});
