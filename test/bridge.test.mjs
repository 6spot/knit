import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSessionContext, contextBlocks } from "../dist/application/session-context.js";
import { createTask } from "../dist/application/task-store.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task.js";
import { findExecutable } from "../dist/infrastructure/process.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit, project } from "./helpers/cli.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";
import { doneTask, readyTask } from "./helpers/run.mjs";

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

test("Pi 执行者加载桥接时跳过全部工具和钩子，保留原有系统提示", async (t) => {
  const bridge = await loadBridge(t, emptyDir(t), { executor: true });
  assert.deepEqual(bridge.definitions, []);
  assert.deepEqual(bridge.events, []);
  assert.deepEqual(await sectionsAfterTurn(bridge, { other: "其他扩展" }), { other: "其他扩展" });
});

test("任务工具转交创建、列表、确认、完成和路径补录", async (t) => {
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
  const id = /^已创建 - 以横线开头（(k-[0-9a-f]{12})）$/.exec(first)?.[1];
  assert.match(id ?? "", /^k-[0-9a-f]{12}$/);
  assert.deepEqual(rest, [`- 以横线开头（${id}） · draft · 当前会话未选中新草稿`, `[task.md](${file})`]);
  const { frontmatter } = parseTaskDocument(readFileSync(join(dir, file), "utf8")).document;
  assert.deepEqual(
    [frontmatter.title, frontmatter.verification, frontmatter.priority],
    ["- 以横线开头", "independent", "P1"],
  );

  const invalidDeps = await bridge.tool("knit_task", { action: "new", title: "验证依赖", dependsOn: ["-first", "-second"] });
  assert.equal(invalidDeps.isError, true);
  for (const id of ["-first", "-second"]) assert.ok(text(invalidDeps).includes(`--depends-on 指定的任务不存在：${id}`));

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
  const refusedSupplement = await bridge.tool("knit_task", { action: "close", taskId: confirmed.id, paths: ["extra.ts"], reason: "" });
  assert.equal(refusedSupplement.isError, true);
  assert.match(text(refusedSupplement), /补录改动文件仅传 --paths/);
  const independent = readyTask(dir, { verification: "independent" });
  const refusedClose = await bridge.tool("knit_task", { action: "close", taskId: independent.id, result: "完成", reason: "" });
  assert.equal(refusedClose.isError, true);
  assert.match(text(refusedClose), /独立审查.*--reason/);
  const supplemented = await bridge.tool("knit_task", { action: "close", taskId: confirmed.id, paths: ["src/c.ts", "-notes.md"] });
  assert.equal(supplemented.isError, undefined, text(supplemented));
  assert.match(text(supplemented), /已补录.*src\/c\.ts/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, confirmed.dir, "record.json"), "utf8")).changedPaths, [
    "-notes.md",
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
  ]);
});

test("按标题筛选并限制列表、查看详情、按原因取消并检索归档", async (t) => {
  const { dir, bridge } = await bridged(t);
  const params = bridge.definitions.find((tool) => tool.name === "knit_task").parameters.properties;
  for (const action of ["show", "cancel"]) assert.ok(params.action.enum.includes(action));
  assert.equal(params.grep.type, "string");
  assert.equal(params.limit.type, "integer");
  const tasks = ["-Alpha one", "-ALPHA two"].map((title) => createTask(dir, {
    title, slug: "alpha", verification: "self", priority: "P2", parent: null, dependsOn: [],
  }).created);
  const call = (args) => bridge.tool("knit_task", args);
  const list = await call({ action: "list", grep: "-alpha", limit: 1 });
  assert.deepEqual(text(list).split("\n"), [`P2  ${tasks[0].id}  draft  -Alpha one`, "仅显示前 1 条，共 2 条"]);
  const shown = await call({ action: "show", taskId: tasks[0].id });
  assert.match(text(shown), /^标题: -Alpha one$/m);
  assert.deepEqual(bridge.entries, []);
  const cancelled = await call({ action: "cancel", taskId: tasks[0].id, reason: "-需求已变更" });
  assert.equal(cancelled.isError, undefined, text(cancelled));
  assert.equal(text(await call({ action: "list", archive: true, grep: "-aLpHa" })), `P2  ${tasks[0].id}  cancelled  -Alpha one`);
});

test("参数不全和命令运行不了", async (t) => {
  const dir = emptyDir(t);
  const bridge = await loadBridge(t, dir);
  const { id } = readyTask(dir, { verification: "self" });
  const before = snapshot(dir);

  for (const action of ["show", "cancel"]) assert.deepEqual(await bridge.tool("knit_task", { action }), failed(`knit_task 的 ${action} 要有 taskId`));
  for (const reason of [undefined, "", "  "]) {
    assert.deepEqual(await bridge.tool("knit_task", { action: "cancel", taskId: id, reason }), failed("knit_task 的 cancel 要有 reason"));
  }
  assert.deepEqual(await bridge.tool("knit_task", { action: "ready" }), failed("knit_task 的 ready 要有 taskId"));
  assert.deepEqual(await bridge.tool("knit_task", { action: "new", title: "" }), failed("knit_task 的 new 要有 title"));
  assert.deepEqual(await bridge.tool("knit_task", { action: "close", taskId: id }), failed("knit_task 的 close 要有 result 或 paths"));
  assert.deepEqual(snapshot(dir), before);

  // loadBridge 在测试结束时把 PATH 改回去。
  process.env.PATH = emptyDir(t);
  const unavailable = await bridge.tool("knit_task", { action: "list" });
  assert.equal(unavailable.isError, true);
  assert.match(text(unavailable), /^运行不了 knit 命令（.+）；确认 knit 已经安装并且在 PATH 上$/);
});

/** 加载了桥接的临时项目，不在 Git 仓库里。 */
async function bridged(t) {
  const dir = project(t);
  return { dir, bridge: await loadBridge(t, dir) };
}
const selections = (bridge) => bridge.entries.map((entry) => [entry.type, entry.customType, entry.data]);

test("Pi Bash 钩子仅为需要核对的命令启动 CLI", async (t) => {
  const { bridge } = await bridged(t);
  const bin = emptyDir(t);
  const calls = join(bin, "calls");
  const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
  writeFileSync(join(bin, "knit"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const ordinary = ["ls -la", "git status", "git diff --stat", "npm test", "node --test test/a.test.mjs",
    'cat "README.md"', "grep 'hello' src/", "rg 'foo' src/"];
  for (const command of ordinary) {
    const event = { toolName: "bash", input: { command } };
    assert.equal(await bridge.fire("tool_call", event), undefined);
    assert.equal(event.input.command, command);
  }
  assert.equal(existsSync(calls), false);
  const denied = ["knit deliver id", 'k"nit" deliver id'];
  for (const command of denied) {
    const result = await bridge.fire("tool_call", { toolName: "bash", input: { command } });
    assert.equal(result?.block, true, command);
    assert.match(result.reason, /--authorization/);
  }
  bridge.entries.push(SECOND);
  const checked = ["knit deliver --preview id", "knit deliver id --authorization '授权交付'"];
  for (const command of checked) {
    assert.equal(await bridge.fire("tool_call", { toolName: "bash", input: { command } }), undefined, command);
  }
  const dynamicDir = { toolName: "bash", input: { command: "knit deliver id --dir $ROOT --authorization '授权交付'" } };
  assert.equal(await bridge.fire("tool_call", dynamicDir), undefined);
  assert.match(dynamicDir.input.command, /--dir "\$ROOT"/);
  assert.equal(readFileSync(calls, "utf8"), "hook pi tool-call\n".repeat(denied.length + checked.length + 1));
  for (const response of ["{", '{"quotes":false}', "{}"]) {
    writeFileSync(join(bin, "knit"), `#!/bin/sh\nprintf '%s' '${response}'\n`);
    assert.equal((await bridge.fire("tool_call", { toolName: "bash", input: { command: denied[0] } })).block, true);
  }
});

test("Pi 取消失败或只取消一个成员时继续等待整批通知", async (t) => {
  const { bridge } = await bridged(t);
  const bin = emptyDir(t);
  const release = join(bin, "finished");
  writeFileSync(join(bin, "knit"), `#!/bin/sh
case "$2" in
  cancel) [ "$4" = '--run=first' ] ;;
  wait) while [ ! -f '${release}' ]; do sleep 0.02; done; echo 'first 已取消，second 已完成' ;;
esac\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const run = (params) => bridge.tool("knit_run", { taskId: "fixture", ...params });
  try {
    assert.equal((await run({ action: "start" })).isError, undefined);
    assert.equal((await run({ action: "cancel" })).isError, true);
    assert.equal((await run({ action: "cancel", runId: "first" })).isError, undefined);
    assert.deepEqual(bridge.messages, []);
    writeFileSync(release, "");
    for (let i = 0; i < 200 && !bridge.messages.length; i++) await sleep(10);
    assert.equal(bridge.messages.length, 1);
    assert.equal(bridge.messages[0].message.customType, "knit.run-ended");
    assert.match(bridge.messages[0].message.content, /first 已取消，second 已完成/);
  } finally {
    await bridge.fire("session_shutdown");
  }
});

test("选中和取消选中", async (t) => {
  const { dir, bridge } = await bridged(t);
  const id = /^已创建 要选中的任务（(k-[0-9a-f]{12})）$/.exec(knit(dir, "task", "new", "--title", "要选中的任务").stdout.split("\n")[0])[1];
  assert.deepEqual(bridge.entries, []);

  const used = await bridge.tool("knit_task", { action: "use", taskId: id });
  assert.equal(used.isError, undefined, text(used));
  assert.equal(text(used), `已选中 要选中的任务（${id}）\n${knit(dir, "task", "show", id).stdout.trimEnd()}`);
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

const HINT = "没有选中 Knit 任务。用 knit_task 的 list 查看任务，use 选中。";
const DISCUSSION_PATHS = [
  "knit:standards/discussion.md",
  "knit:standards/task-splitting.md",
  "knit:standards/task-writing.md",
];
const paths = (text) => [...text.matchAll(/^<standard path="([^"]+)"/gm)].map((match) => match[1]);

function draft(dir, title) {
  const result = createTask(dir, { title, slug: "task", priority: "P2", verification: "self", parent: null, dependsOn: [] });
  assert.deepEqual(result.problems, []);
  return result.created;
}

async function newTask(bridge, title) {
  const created = await bridge.tool("knit_task", { action: "new", title });
  assert.equal(created.isError, undefined, created.content[0].text);
  const [first, file] = created.content[0].text.split("\n");
  return { id: /^已创建 .+（(k-[0-9a-f]+)）$/.exec(first)[1], file };
}

function discussion(dir) {
  return contextBlocks(buildSessionContext(dir)).discussion;
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
  const first = await sectionsAfterTurn(bridge, { other: "别的扩展的一段" });
  assert.deepEqual(first, { other: "别的扩展的一段", knit: discussion(dir) });
  assert.deepEqual(paths(first.knit), [...DISCUSSION_PATHS, ".knit/standards/nested/writing.md"]);
  assert.match(first.knit, /^- 保留项目特有的讨论约束。$/m);
  assert.doesNotMatch(first.knit, /^任务:|^状态:|^下一步:/m);
  assert.deepEqual(await sectionsAfterTurn(bridge, structuredClone(first)), first);
  assert.deepEqual(snapshot(join(dir, ".knit")), before);
  assert.equal(bridge.entries.length, 2);
  assert.equal(bridge.entries[1].customType, "knit.context");
  assert.equal(bridge.entries[1].display, false);
  assert.match(bridge.entries[1].content, /没有选中 Knit 任务/);
});

test("草稿切换、取消选择和待交付任务：每轮保留讨论规范并按路径去重", async (t) => {
  const { dir, bridge } = await bridged(t);
  writeFileSync(join(dir, ".knit/standards/shared.md"), "---\ntitle: 共享规则\nstages: [discuss, deliver]\n---\n\n共享规则正文\n");
  // 标题与正文相同但路径不同的文件不能被去掉。
  writeFileSync(join(dir, ".knit/standards/delivery-only.md"), "---\ntitle: 共享规则\nstages: [deliver]\n---\n\n共享规则正文\n");
  const drafts = [draft(dir, "第一个任务"), draft(dir, "另一个任务")];
  const discussionPaths = [...DISCUSSION_PATHS, ".knit/standards/shared.md"];
  for (const task of drafts) {
    await bridge.tool("knit_task", { action: "use", taskId: task.id });
    const sections = await sectionsAfterTurn(bridge);
    assert.equal(sections.knit, discussion(dir));
    assert.deepEqual(paths(sections.knit), discussionPaths);
    const selected = bridge.entries.at(-1).content;
    assert.deepEqual(paths(selected), []);
    assert.match(selected, new RegExp(`^任务: .+（${task.id}）$`, "m"));
    assert.match(selected, /^状态: draft$/m);
    assert.match(selected, new RegExp(`^下一步: 先确认需求（knit task ready ${task.id}）$`, "m"));
    assert.doesNotMatch(selected.slice(selected.indexOf("任务:")), /<standard/);
  }
  await bridge.tool("knit_task", { action: "use" });
  assert.deepEqual(await sectionsAfterTurn(bridge), { knit: discussion(dir) });
  assert.ok(bridge.entries.at(-1).content.includes(HINT));

  const completed = doneTask(dir);
  await bridge.tool("knit_task", { action: "use", taskId: completed.id });
  const before = snapshot(join(dir, ".knit"));
  const delivered = await sectionsAfterTurn(bridge);
  assert.deepEqual(paths(delivered.knit), discussionPaths);
  const last = bridge.entries.at(-1);
  assert.deepEqual(paths(last.content), ["knit:standards/delivery.md", ".knit/standards/delivery-only.md"]);
  assert.match(last.content, /^状态: done$/m);
  assert.match(last.content, new RegExp(`^下一步: 用户授权后交付（knit deliver ${completed.id}）$`, "m"));
  assert.deepEqual(await sectionsAfterTurn(bridge, structuredClone(delivered)), delivered);
  assert.equal(bridge.entries.at(-1), last);
  assert.deepEqual(snapshot(join(dir, ".knit")), before);
});

test("用户明确要求后用现有工具建草稿、写需求，成功或失败都保持选择", async (t) => {
  const { dir, bridge } = await bridged(t);
  const description = bridge.definitions.find((tool) => tool.name === "knit_task").description;
  for (const usage of [/new 建一份草稿（要有 title）/, /new 不改变当前的任务选择/, /use 选中一个任务/, /ready 确认需求/, /close 把任务记为完成/, /done 任务仅传 paths 可补录/, /list 列出任务/]) {
    assert.match(description, usage);
  }
  assert.doesNotMatch(description, /是否建 Knit 任务|委派|明确要求/);
  const first = await newTask(bridge, "现有草稿");
  assert.deepEqual(bridge.entries, []);
  await sectionsAfterTurn(bridge);
  assert.match(bridge.entries.at(-1).content, /没有选中 Knit 任务/);
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
  await sectionsAfterTurn(bridge);
  assert.match(bridge.entries.at(-1).content, new RegExp(`^任务: 现有草稿（${first.id}）$`, "m"));
  const current = structuredClone(bridge.entries);

  const beforeFailure = snapshot(join(dir, ".knit"));
  const failed = await bridge.tool("knit_task", { action: "new", title: "创建失败", parent: "k-000000000000" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /k-000000000000/);
  assert.deepEqual(snapshot(join(dir, ".knit")), beforeFailure);
  assert.deepEqual(bridge.entries, current);
  assert.deepEqual(paths((await sectionsAfterTurn(bridge)).knit), DISCUSSION_PATHS);
});

test("选中任务读不出来时仍保留讨论规范，缺少事件 sections 时不报错", async (t) => {
  const { dir, bridge } = await bridged(t);
  const task = draft(dir, "会被删掉");
  await bridge.tool("knit_task", { action: "use", taskId: task.id });
  rmSync(join(dir, dirname(task.file)), { recursive: true });
  const before = structuredClone(bridge.entries);
  const missing = buildSessionContext(dir, task.id);
  assert.equal(missing.kind, "refused");
  assert.ok(missing.problems.length > 0);
  assert.deepEqual(await sectionsAfterTurn(bridge), { knit: discussion(dir) });
  assert.ok(bridge.entries.at(-1).content.includes(`选中的 Knit 任务 ${task.id} 读不出来：\n${missing.problems.join("\n")}`));
  assert.deepEqual(bridge.entries.slice(0, -1), before);
  await bridge.fire("before_agent_start", {});
});

test("每轮新建 sections 时，读取失败沿用当前分支的讨论规范，成功的空块生效", async (t) => {
  const { bridge } = await bridged(t);
  const stable = await sectionsAfterTurn(bridge);
  bridge.appendMessage({ role: "system", content: "", sections: { knit: `<knit>\n${stable.knit}\n</knit>` } });
  const bin = emptyDir(t);
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "knit"), `#!/bin/sh\necho call >> '${calls}'\necho '临时读取故障' >&2\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  await bridge.reload();
  assert.deepEqual(await sectionsAfterTurn(bridge, {}), stable);
  assert.match(bridge.entries.at(-1).content, /Knit 上下文读不出来：[\s\S]*临时读取故障/);
  const count = bridge.entries.length;
  await bridge.requestMessages();
  assert.deepEqual(await sectionsAfterTurn(bridge, {}), stable);
  assert.equal(bridge.entries.length, count);
  assert.equal(readFileSync(calls, "utf8"), "call\ncall\n");
  writeFileSync(join(bin, "knit"), "#!/bin/sh\necho '{'\n");
  assert.deepEqual(await sectionsAfterTurn(bridge, {}), stable);
  assert.match(bridge.entries.at(-1).content, /未返回有效的分块/);
  writeFileSync(join(bin, "knit"), `#!/bin/sh\necho '{"discussion":"","status":"","supplement":"","pitfalls":""}'\n`);
  assert.deepEqual(await sectionsAfterTurn(bridge, {}), { knit: "" });
});

for (const projection of ["buildSessionContext", "buildSessionProjection", null]) {
  test(`Pi 恢复、压缩与分支切换按可见块重建（${projection ?? "旧版分支"}）`, async (t) => {
    const dir = project(t);
    const bridge = await loadBridge(t, dir, { projection });
    const first = doneTask(dir);
    const second = doneTask(dir);
    const use = (task) => bridge.tool("knit_task", { action: "use", taskId: task.id });
    await use(first);
    const bareBranch = [...bridge.entries];
    const stable = await sectionsAfterTurn(bridge, { knit: knit(dir, "context", first.id).stdout });
    assert.equal(stable.knit, discussion(dir));
    const complete = bridge.entries.at(-1);
    assert.match(complete.content, /knit:standards\/delivery\.md/);
    const fullBranch = [...bridge.entries];
    await bridge.reload();
    assert.deepEqual(await sectionsAfterTurn(bridge), stable);
    assert.deepEqual(bridge.entries, fullBranch);

    await use(second);
    await sectionsAfterTurn(bridge);
    const delta = bridge.entries.at(-1);
    assert.deepEqual(Object.keys(delta.details.digests), ["status"]);
    bridge.compact(projection ? delta.id : null);
    assert.deepEqual(await sectionsAfterTurn(bridge), stable);
    const restored = bridge.entries.at(-1);
    assert.match(restored.content, /knit:standards\/delivery\.md/);
    assert.deepEqual(Object.keys(restored.details.digests), projection ? ["supplement"] : ["status", "supplement"]);
    assert.ok(bridge.projectContext().messages.some((m) => m.role === "custom" && m.content.includes(second.id)));
    bridge.switchBranch(bareBranch);
    await sectionsAfterTurn(bridge);
    assert.equal(bridge.entries.at(-1).content, complete.content);
    bridge.switchBranch(fullBranch);
    await sectionsAfterTurn(bridge);
    assert.deepEqual(bridge.entries, fullBranch);
  });
}

test("压缩后首个请求补足缺块，投影随分支、再次压缩和恢复重建", async (t) => {
  const { dir, bridge } = await bridged(t);
  const task = doneTask(dir);
  await bridge.tool("knit_task", { action: "use", taskId: task.id });
  await sectionsAfterTurn(bridge);
  const full = [...bridge.entries];
  const toolResult = { role: "toolResult", content: [{ type: "text", text: "完成" }], timestamp: 1 };
  const kept = bridge.appendMessage(toolResult);
  await bridge.fire("turn_end", { toolResults: [toolResult] });
  bridge.compact(kept);
  const first = await bridge.requestMessages();
  assert.match(first.at(-1).content, /knit:standards\/delivery.md/);
  const branch = [...bridge.entries];
  bridge.appendMessage({ role: "user", content: "再看一次", timestamp: 2 });
  await bridge.reload();
  await sectionsAfterTurn(bridge);
  assert.deepEqual((await bridge.requestMessages()).slice(0, -1), first);
  bridge.switchBranch(full);
  assert.equal((await bridge.requestMessages()).filter((m) => m.customType === "knit.context").length, 1);
  assert.deepEqual(bridge.entries, full);
  bridge.switchBranch(branch);
  bridge.compact();
  const rebuilt = await bridge.requestMessages();
  assert.equal(rebuilt.length, 2);
  assert.deepEqual(rebuilt.at(-1), first.at(-1));
});

test("Pi 1.7.0 Responses 离线重放多次请求的前缀与工具声明", async (t) => {
  const pi = findExecutable("pi");
  if (!pi || spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout?.trim() !== "1.7.0") {
    return t.skip("需要本机 Pi 1.7.0 的 Responses 转换器");
  }
  const launcher = realpathSync(pi);
  const release = join(dirname(launcher), "../install/releases/1.7.0");
  const anchor = pathToFileURL(existsSync(release) ? join(release, "index.js") : launcher);
  const agent = findPackageJSON("@earendil-works/pi-coding-agent", anchor);
  assert.equal(JSON.parse(readFileSync(agent)).version, "1.7.0");
  const ai = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(agent));
  const { prepareResponsesPrompt } = await import(pathToFileURL(join(dirname(ai), "dist/api/openai-responses-shared.js")));
  const { convertToLlm } = await import(pathToFileURL(join(dirname(agent), "dist/core/messages.js")));
  const { dir, bridge } = await bridged(t);
  const task = readyTask(dir, { verification: "self" });
  const sections = {};
  const model = { id: "fixture", provider: "fixture", api: "openai-responses", reasoning: true, input: ["text"] };
  const start = () => sectionsAfterTurn(bridge, sections);
  const request = () => prepareResponsesPrompt(model, { messages: [
    { role: "system", content: "离线测试", sections: { knit: `<knit>\n${sections.knit}\n</knit>` },
      toolsAdded: bridge.definitions.map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: 0 },
    ...convertToLlm(bridge.projectContext().messages),
  ] }, new Set(), { supportsMidConvoSystemMessages: false });
  const user = (id) => bridge.entries.push(userSaid(id, "查看当前状态"));
  user("u1");
  await start();
  const first = request();
  assert.equal(first.input[0].role, "developer");
  assert.ok(first.input[0].content.includes(discussion(dir)));
  assert.equal(first.requestTools.length, 3);
  const params = { action: "use", taskId: task.id };
  const used = await bridge.tool("knit_task", params);
  const toolResult = { role: "toolResult", toolCallId: "call", toolName: "knit_task", content: used.content, isError: false, timestamp: 1 };
  bridge.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "knit_task", arguments: params }],
    api: model.api, model: model.id, provider: model.provider, stopReason: "toolUse", timestamp: 1 } }, { type: "message", message: toolResult });
  await bridge.fire("turn_end", { toolResults: [toolResult] });
  const selected = request();
  assert.deepEqual(selected.input.slice(first.input.length).map((item) => item.type ?? item.role), ["function_call", "function_call_output", "user"]);
  assert.match(selected.input.at(-1).content[0].text, /^状态: ready$/m);
  assert.equal((await bridge.tool("knit_task", { action: "close", taskId: task.id, result: "离线验证" })).isError, undefined);
  user("u2");
  await start();
  const closed = request();
  assert.equal(closed.input.length, selected.input.length + 2);
  assert.match(closed.input.at(-1).content[0].text, /^状态: done$/m);
  assert.match(closed.input.at(-1).content[0].text, /knit:standards\/delivery.md/);
  user("u3");
  await start();
  const repeated = request();
  assert.equal(repeated.input.length, closed.input.length + 1);
  assert.equal(repeated.input.at(-1).content[0].text, "查看当前状态");
  for (const [before, after] of [[first, selected], [selected, closed], [closed, repeated]]) {
    assert.deepEqual(after.input.slice(0, before.input.length), before.input);
    assert.deepEqual(after.requestTools, before.requestTools);
  }
  t.diagnostic(`4 次离线请求的 input 项数 ${[first, selected, closed, repeated].map((p) => p.input.length).join(" → ")}，各次工具声明均为 ${first.requestTools.length} 个`);

  const { SessionManager } = await import(pathToFileURL(join(dirname(agent), "dist/core/session-manager.js")));
  const manager = SessionManager.inMemory(dir);
  const native = bridge;
  await native.reload(manager);
  const tasks = [doneTask(dir), doneTask(dir)];
  writeFileSync(join(dir, ".knit/standards/pitfalls.md"), "---\ntitle: 避坑清单\n---\n\n## deliver\n\n核实交付结果。\n");
  const use = (b, task) => b.tool("knit_task", { action: "use", taskId: task.id });
  const render = async (b) => prepareResponsesPrompt(model, { messages: convertToLlm(await b.requestMessages()) },
    new Set(), { supportsMidConvoSystemMessages: false });
  const prefix = (a, b) => {
    assert.deepEqual(b.input.slice(0, a.input.length), a.input);
    assert.deepEqual(b.requestTools, a.requestTools);
  };
  const toolBeat = (b, call) => {
    const id = b.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: call, name: "knit_task", arguments: { action: "list" } }],
      api: model.api, model: model.id, provider: model.provider, stopReason: "toolUse", timestamp: 2 });
    b.appendMessage({ ...toolResult, toolCallId: call, content: [{ type: "text", text: "已查阅" }] });
    return id;
  };
  native.appendMessage({ role: "system", content: "离线测试", sections: { knit: `<knit>\n${discussion(dir)}\n</knit>` },
    toolsAdded: native.definitions.map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: 0 });
  await use(native, tasks[0]);
  await sectionsAfterTurn(native);
  await use(native, tasks[1]);
  await sectionsAfterTurn(native);
  const deltaId = manager.getLeafId();
  assert.deepEqual(Object.keys(manager.getLeafEntry().details.digests), ["status"]);
  const callId = toolBeat(native, "before_compact");
  assert.equal(await native.fire("turn_end", { toolResults: [toolResult] }), undefined);
  const original = manager.getLeafId();
  for (const partial of [false, true]) {
    await native.reload(manager);
    manager.branch(original);
    native.compact(partial ? deltaId : callId);
    const repaired = await render(native);
    const repair = manager.getLeafEntry().data.message;
    assert.deepEqual(Object.keys(repair.details.digests), partial ? ["supplement", "pitfalls"] : ["status", "supplement", "pitfalls"]);
    assert.equal(repaired.input.at(-1).content[0].text, repair.content);
    assert.match(repair.content, /核实交付结果。/);
    assert.match(repair.content, /knit:standards\/delivery.md/);
    assert.ok(JSON.stringify(repaired.input).includes(tasks[1].id));
    assert.equal(repaired.input[0].role, "developer");
    assert.ok(repaired.input[0].content.includes(discussion(dir)));
    assert.deepEqual(repaired.requestTools, first.requestTools);
    toolBeat(native, "after_compact");
    assert.equal(await native.fire("turn_end", { toolResults: [toolResult] }), undefined);
    const continued = await render(native);
    prefix(repaired, continued);
    assert.equal(continued.input.length, repaired.input.length + 2);

    const reopened = SessionManager.inMemory(dir, undefined, JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getBranch()])));
    await native.reload(reopened);
    const oldLeaf = reopened.getLeafId();
    assert.equal((await sectionsAfterTurn(native, {})).knit, discussion(dir));
    assert.equal(reopened.getLeafId(), oldLeaf);
    native.appendMessage({ role: "user", content: "继续", timestamp: 3 });
    const resumed = await render(native);
    prefix(continued, resumed);
    assert.equal(resumed.input.length, continued.input.length + 1);
    await use(native, tasks[0]);
    toolBeat(native, "changed");
    const changed = await native.fire("turn_end", { toolResults: [toolResult] });
    assert.deepEqual(Object.keys(changed.entries.at(-1).details.digests), ["status"]);
    const updated = await render(native);
    prefix(resumed, updated);
    assert.equal(updated.input.length, resumed.input.length + 3);
    assert.ok(updated.input.at(-1).content[0].text.includes(tasks[0].id));
    assert.equal(await native.fire("turn_end", { toolResults: [toolResult] }), undefined);
    assert.deepEqual(await render(native), updated);
    t.diagnostic(`${partial ? "部分" : "完整"}移除后的首条、续拍、重开和状态更新 input 项数 ${[repaired, continued, resumed, updated].map((p) => p.input.length).join(" → ")}`);
  }
});

/** 加载了桥接的临时 Git 仓库，初始化生成的文件已经提交。 */
async function bridgedGit(t) {
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
  const { dir, bridge } = await bridgedGit(t);
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

test("文案写入失败时清理已创建的临时目录", async (t) => {
  const { bridge } = await bridged(t);
  const tmp = emptyTmpdir(t);
  const failure = new Error("文案写入失败");
  const fault = t.mock.method(fsPromises, "writeFile", async () => { throw failure; });
  syncBuiltinESMExports();
  try {
    await assert.rejects(bridge.tool("knit_deliver", { taskId: "fixture", preview: true, message: "文案" }), failure);
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
});

test("不带提交文案预览", async (t) => {
  const { dir, bridge } = await bridgedGit(t);
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
  const { dir, bridge } = await bridgedGit(t);
  const { id } = draft(dir, "还没完成");
  const refused = knit(dir, "deliver", id, "--preview");
  assert.notEqual(refused.code, 0);
  assert.notEqual(refused.stderr.trim(), "");

  assert.deepEqual(await bridge.tool("knit_deliver", { taskId: id, preview: true }), failed(refused.stderr.trimEnd()));
  assert.deepEqual(await bridge.tool("knit_deliver", { taskId: "", preview: true }), failed("knit_deliver 要有 taskId"));
});

const now = new Date();
const archived = (task) =>
  `.knit/tasks/archive/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(task.dir)}`;
const filesOf = (dir, taskDir) => ["task.md", "record.json"].map((name) => readFileSync(join(dir, taskDir, name), "utf8"));

/** 会话记录的样子照 Pi 的会话格式。 */
const userSaid = (id, content) => ({ type: "message", id, message: { role: "user", content } });
const FIRST = userSaid("u-first", "可以交付，然后下一步G。");
const SECOND = userSaid("u-second", [{ type: "text", text: "造不出来就先不管这个\n授权交付" }]);

/** 加载了桥接的临时项目，不在 Git 仓库里；会话记录里有那两条用户消息。 */
async function authorizedBridge(t) {
  const { dir, bridge } = await bridged(t);
  bridge.entries.push(FIRST, SECOND);
  return { dir, bridge };
}

test("找到原话时交付并记下是哪一条", async (t) => {
  const { dir, bridge } = await authorizedBridge(t);
  const task = doneTask(dir);
  const other = doneTask(dir);

  const delivered = await bridge.tool("knit_deliver", { taskId: task.id, authorization: "  授权交付  " });
  assert.equal(delivered.isError, undefined, text(delivered));
  assert.equal(
    text(delivered),
    `已交付 加问候语（${task.id}）\n归档: ${archived(task)}\n提交: 这个项目不在 Git 仓库里，没有提交`,
  );
  assert.equal(existsSync(join(dir, task.dir)), false);
  const [document, record] = filesOf(dir, archived(task));
  assert.match(document, /^status: delivered$/m);
  assert.equal(JSON.parse(record).authorization, "user:u-second 授权交付");

  const again = await bridge.tool("knit_deliver", { taskId: other.id, authorization: "可以交付，然后下一步G。" });
  assert.equal(again.isError, undefined, text(again));
  assert.equal(
    JSON.parse(filesOf(dir, archived(other))[1]).authorization,
    "user:u-first 可以交付，然后下一步G。",
  );
});

test("找不到原话时不交付", async (t) => {
  const { dir, bridge } = await authorizedBridge(t);
  bridge.entries.push(
    { type: "message", id: "a-1", message: { role: "assistant", content: [{ type: "text", text: "同意交付" }] } },
    { type: "custom_message", id: "c-1", customType: "knit.run-ended", content: "同意交付", display: true },
  );
  const task = doneTask(dir);
  writeFileSync(join(dir, ".knit/standards/quote.md"), "---\ntitle: 离线样例\nstages: [deliver]\n---\n仅宿主上下文提到的授权\n");
  await bridge.tool("knit_task", { action: "use", taskId: task.id });
  await sectionsAfterTurn(bridge);
  assert.match(bridge.entries.at(-1).content, /^仅宿主上下文提到的授权$/m);
  const shell = await bridge.fire("tool_call", { toolName: "bash", input: { command: `knit deliver ${task.id} --authorization 仅宿主上下文提到的授权` } });
  assert.equal(shell.block, true);
  const before = filesOf(dir, task.dir);

  for (const quote of ["仅宿主上下文提到的授权", "同意交付", "交付", "可以交付"]) {
    assert.deepEqual(
      await bridge.tool("knit_deliver", { taskId: task.id, authorization: quote }),
      failed(
        `在这个会话里找不到用户说过这句话：${quote}；authorization 要写用户同意交付的那条消息的原话（整条，或者其中完整的一行）`,
      ),
    );
  }
  for (const params of [{}, { authorization: "   " }]) {
    assert.deepEqual(
      await bridge.tool("knit_deliver", { taskId: task.id, ...params }),
      failed("交付要有用户的授权：authorization 写用户同意交付的那条消息的原话"),
    );
  }
  assert.deepEqual(filesOf(dir, task.dir), before);
  assert.equal(existsSync(join(dir, archived(task))), false);
});

test("在 Git 仓库里带提交文案交付", async (t) => {
  const dir = gitProject(t);
  const bridge = await loadBridge(t, dir);
  const task = doneTask(dir);
  commitAll(dir, "task");
  bridge.entries.push(userSaid("u-git", "可以交付"));
  const tmpBefore = process.env.TMPDIR;
  const tmp = mkdtempSync(join(tmpdir(), "knit-tmp-"));
  t.after(() => {
    if (tmpBefore === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpBefore;
    rmSync(tmp, { recursive: true, force: true });
  });
  process.env.TMPDIR = tmp;

  const delivered = await bridge.tool("knit_deliver", {
    taskId: task.id,
    authorization: "可以交付",
    message: "feat: 加问候语",
  });
  assert.equal(delivered.isError, undefined, text(delivered));
  assert.equal(text(delivered).split("\n")[2], `提交: ${git(dir, "rev-parse", "--short", "HEAD")} feat: 加问候语`);
  assert.equal(git(dir, "log", "-1", "--format=%B"), `feat: 加问候语\n\nKnit-Task: ${task.id}`);
  assert.equal(JSON.parse(filesOf(dir, archived(task))[1]).authorization, "user:u-git 可以交付");
  assert.deepEqual(readdirSync(tmp), []);
});
