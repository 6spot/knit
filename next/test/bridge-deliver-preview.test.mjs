import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBridge } from "./helpers/bridge.mjs";
import { knit } from "./helpers/cli.mjs";
import { doneTask } from "./helpers/deliver.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";

const text = (result) => result.content[0].text;
const failed = (message) => ({ content: [{ type: "text", text: message }], details: undefined, isError: true });

/** 加载了桥接的临时 Git 仓库，初始化生成的文件已经提交。 */
async function bridged(t) {
  const dir = gitProject(t);
  const bridge = await loadBridge(t, dir);
  commitAll(dir, "init");
  return { dir, bridge };
}

/** 把系统的临时目录指到一个空目录，测试结束时改回去；返回这个目录。 */
function emptyTmpdir(t) {
  const before = process.env.TMPDIR;
  const dir = mkdtempSync(join(tmpdir(), "knit-tmp-"));
  t.after(() => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.TMPDIR = dir;
  return dir;
}

test("带提交文案预览", async (t) => {
  const { dir, bridge } = await bridged(t);
  const task = doneTask(dir);
  const plain = knit(dir, "deliver", task.id, "--preview");
  assert.equal(plain.code, 0, plain.stderr);
  const plainLines = plain.stdout.trimEnd().split("\n");
  assert.match(plainLines.at(-1), /^提交文案: 没有给/);
  const before = [git(dir, "status", "--porcelain"), readFileSync(join(dir, task.dir, "task.md"), "utf8")];
  const tmp = emptyTmpdir(t);

  const preview = await bridge.tool("knit_deliver", {
    taskId: task.id,
    preview: true,
    message: "feat: 加问候语\n\n说明一行",
  });
  assert.equal(preview.isError, undefined, text(preview));
  assert.equal(
    text(preview),
    [...plainLines.slice(0, -1), "提交文案:", "  feat: 加问候语", "", "  说明一行"].join("\n"),
  );
  assert.deepEqual([git(dir, "status", "--porcelain"), readFileSync(join(dir, task.dir, "task.md"), "utf8")], before);
  assert.match(before[1], /^status: done$/m);
  assert.deepEqual(readdirSync(tmp), []);
});

test("不带提交文案预览", async (t) => {
  const { dir, bridge } = await bridged(t);
  const task = doneTask(dir);
  const plain = knit(dir, "deliver", task.id, "--preview");
  assert.equal(plain.code, 0, plain.stderr);
  // 只读：桥接要是往里建东西，调用就会失败。
  const tmp = emptyTmpdir(t);
  chmodSync(tmp, 0o555);

  for (const params of [{}, { message: "   " }]) {
    const preview = await bridge.tool("knit_deliver", { taskId: task.id, preview: true, ...params });
    assert.equal(preview.isError, undefined, text(preview));
    assert.equal(text(preview), plain.stdout.trimEnd());
  }
  assert.deepEqual(readdirSync(tmp), []);
});

test("不能预览时", async (t) => {
  const { dir, bridge } = await bridged(t);
  const id = knit(dir, "task", "new", "--title", "还没完成").stdout.split("\n")[0].replace("已创建 ", "");
  const refused = knit(dir, "deliver", id, "--preview");
  assert.notEqual(refused.code, 0);
  assert.notEqual(refused.stderr.trim(), "");

  assert.deepEqual(await bridge.tool("knit_deliver", { taskId: id, preview: true }), failed(refused.stderr.trimEnd()));
  assert.deepEqual(await bridge.tool("knit_deliver", { taskId: "", preview: true }), failed("knit_deliver 要有 taskId"));
});
