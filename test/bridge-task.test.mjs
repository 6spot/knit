import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTaskDocument } from "../dist/domain/task.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit } from "./helpers/cli.mjs";
import { readyTask } from "./helpers/run.mjs";

const BRIDGE = ".pi/extensions/knit.ts";
const template = readFileSync(new URL(`../assets/templates/pi/extensions/knit.ts`, import.meta.url), "utf8");

/** 一个空的临时目录，不在 Git 仓库里。 */
function emptyDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 目录下所有文件的相对路径和内容。 */
const snapshot = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => [path.slice(dir.length + 1), readFileSync(path, "utf8")]);

const text = (result) => result.content[0].text;
const failed = (message) => ({ content: [{ type: "text", text: message }], details: undefined, isError: true });

test("初始化生成桥接", (t) => {
  const dir = emptyDir(t);
  const first = knit(dir, "init", "--pi");
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(readdirSync(dir).sort(), [".knit", ".pi"]);
  assert.equal(readFileSync(join(dir, BRIDGE), "utf8"), template);
  assert.match(first.stdout.split("下一步")[0], /^已生成:\n(  .+\n)*  \.pi\/extensions\/knit\.ts\n/);

  writeFileSync(join(dir, BRIDGE), "// 项目自己改的\n");
  const forced = knit(dir, "init", "--force");
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(readFileSync(join(dir, BRIDGE), "utf8"), template);
  const backup = forced.stdout.match(/^备份: (.+)\/$/m)[1];
  assert.equal(readFileSync(join(dir, backup, BRIDGE), "utf8"), "// 项目自己改的\n");

  const checked = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "-p",
      fileURLToPath(new URL("../tsconfig.templates.json", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stdout);
});

test("四个动作转交命令", async (t) => {
  const dir = emptyDir(t);
  const bridge = await loadBridge(t, dir);

  const created = await bridge.tool("knit_task", {
    action: "new",
    title: "- 以横线开头",
    verification: "independent",
    priority: "P1",
  });
  assert.equal(created.isError, undefined, text(created));
  assert.equal(created.details, undefined);
  const [first, file, ...rest] = text(created).split("\n");
  const id = first.replace("已创建 ", "");
  assert.match(id, /^k-[0-9a-f]{12}$/);
  assert.deepEqual(rest, [`- 以横线开头（${id}） · draft · 当前会话未选中新草稿`, `[task.md](${file})`]);
  const { frontmatter } = parseTaskDocument(readFileSync(join(dir, file), "utf8")).document;
  assert.deepEqual(
    [frontmatter.title, frontmatter.verification, frontmatter.priority],
    ["- 以横线开头", "independent", "P1"],
  );

  const listed = await bridge.tool("knit_task", { action: "list" });
  assert.equal(listed.isError, undefined);
  assert.equal(text(listed), knit(dir, "task", "list").stdout.trimEnd());
  assert.match(text(listed), new RegExp(id));
  const archived = await bridge.tool("knit_task", { action: "list", archive: true });
  assert.equal(archived.isError, undefined);
  assert.equal(text(archived), knit(dir, "task", "list", "--archive").stdout.trimEnd());
  assert.notEqual(text(archived), text(listed));

  const refused = knit(dir, "task", "ready", id);
  assert.notEqual(refused.code, 0);
  assert.deepEqual(await bridge.tool("knit_task", { action: "ready", taskId: id }), failed(refused.stderr.trimEnd()));

  const confirmed = readyTask(dir, { verification: "self" });
  const closed = await bridge.tool("knit_task", {
    action: "close",
    taskId: confirmed.id,
    result: "做完了。\n两个场景都验证过。",
    paths: ["src/b.ts", "src/a.ts"],
  });
  assert.equal(closed.isError, undefined, text(closed));
  const done = parseTaskDocument(readFileSync(join(dir, confirmed.dir, "task.md"), "utf8")).document;
  assert.equal(done.frontmatter.status, "done");
  assert.equal(done.result, "做完了。\n两个场景都验证过。");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, confirmed.dir, "record.json"), "utf8")).changedPaths, [
    "src/a.ts",
    "src/b.ts",
  ]);
});

test("参数不全和命令运行不了", async (t) => {
  const dir = emptyDir(t);
  const bridge = await loadBridge(t, dir);
  const { id } = readyTask(dir, { verification: "self" });
  const before = snapshot(dir);

  assert.deepEqual(await bridge.tool("knit_task", { action: "ready" }), failed("knit_task 的 ready 要有 taskId"));
  assert.deepEqual(await bridge.tool("knit_task", { action: "new", title: "" }), failed("knit_task 的 new 要有 title"));
  assert.deepEqual(await bridge.tool("knit_task", { action: "close", taskId: id }), failed("knit_task 的 close 要有 result"));
  assert.deepEqual(snapshot(dir), before);

  // loadBridge 在测试结束时把 PATH 改回去。
  process.env.PATH = emptyDir(t);
  const unavailable = await bridge.tool("knit_task", { action: "list" });
  assert.equal(unavailable.isError, true);
  assert.match(text(unavailable), /^运行不了 knit 命令（.+）；确认 knit 已经安装并且在 PATH 上$/);
});
