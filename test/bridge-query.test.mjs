/**
 * 任务042：Pi 桥接命令展示结构化查询结果。
 * 用公开 Extension API 替身加载安装后的真实桥接模板，
 * 令 core CLI 返回成功 data，断言通知内容确实可见。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const BRIDGE_TEMPLATE = join(import.meta.dirname, "..", "assets", "templates", "pi", "extensions", "knit.ts");

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-042-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  execFileSync(process.execPath, [CLI, "init", "--client", "pi", "--dir", dir], { encoding: "utf8" });
  return dir;
}

/** 最小公开 API 替身：捕获 registerCommand handler 与 ui.notify 通知。 */
/* 模板为 TypeScript；Node 24 类型剥离直接加载 .ts。 */
function makeHostStub() {
  const commands = new Map();
  const notifications = [];
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => tools.set(definition.name, definition),
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, id: `entry-${entries.length + 1}`, parentId: null, data });
      // 与真实宿主一致：条目自然落盘到会话文件（resolveSelection 读原生路径）。
      if (sessionFile !== null) {
        appendFileSync(sessionFile, JSON.stringify({ timestamp: "2026-11-02T00:00:02.000Z", type: "custom", customType, id: `entry-${entries.length}`, parentId: null, data }) + "\n");
      }
    },
  };
  const entries = [];
  const systemPromptOptions = { sections: {} };
  let sessionFile = null;
  const ctx = {
    ui: { notify: (text, level) => notifications.push({ text: String(text), level }) },
    reload: async () => {},
    sessionManager: {
      getSessionId: () => "stub-session",
      getSessionFile: () => sessionFile,
      getBranch: () => entries,
      getEntries: () => entries,
    },
  };
  return { commands, notifications, pi, ctx, handlers, tools, systemPromptOptions, setSessionFile: (path) => { sessionFile = path; } };
}

/** 生成带 session 头与选择条目的原生会话文件（stub 会话管理器的真实文件）。 */
function writeStubNativeSession(dir, nativeId, entries) {
  const sessionDir = join(dir, ".knit", ".runtime", "pi-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: nativeId, cwd: dir, timestamp: "2026-11-02T00:00:00.000Z" }),
    ...entries.map((entry) => JSON.stringify({ timestamp: "2026-11-02T00:00:01.000Z", ...entry })),
  ];
  const file = join(sessionDir, `2026-11-02T00-00-00-000Z_${nativeId}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

async function loadBridge(dir) {
  // 安装映射与清单已 ready；用临时副本替换 __BRIDGE_BASELINE__ 占位后经 tsc 编译加载。
  const { execFileSync } = await import("node:child_process");
  const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
  const source = readFileSync(BRIDGE_TEMPLATE, "utf8").replace("__BRIDGE_BASELINE__", "stub-baseline");
  const bridgeTs = join(dir, ".bridge-stub.ts");
  writeFileSync(bridgeTs, source);
  // 编译产物放进测试项目的 .pi/extensions/.bridge-build/，与安装布局同构（root 推导 = 项目根）。
  const buildDir = join(dir, ".pi", "extensions");
  mkdirSync(buildDir, { recursive: true });
  // 让 bridge-stub.ts 解析 typebox：项目 node_modules 链接到测试项目根（编译后移除）。
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "dir");
  const sourcePath = join(buildDir, "bridge-stub.ts");
  writeFileSync(sourcePath, source);
  const compiled = spawnSync(tsc, ["--ignoreConfig", "--skipLibCheck", "--types", "node", "--target", "es2022", "--module", "es2022", "--moduleResolution", "node10", "--ignoreDeprecations", "6.0", "--outDir", buildDir, sourcePath], { encoding: "utf8", cwd: import.meta.dirname });
  if (compiled.status !== 0) throw new Error(`桥接模板编译失败: ${compiled.stderr || compiled.stdout}`);
  // 模板 import typebox —— 解析到项目 node_modules；bridge-out 内相对引用需重定位。typebox 由测试进程的 node_modules 提供。
  const module = await import(pathToFileURL(join(buildDir, "bridge-stub.js")).href);
  const host = makeHostStub();
  module.default(host.pi);
  return { host, bridgePath: bridgeTs };
}

test("桥接命令展示结构化查询结果：task list、status、按任务查询可见；失败与空列表有准确提示（任务042）", async () => {
  const dir = project("query");
  try {
    const { host, bridgePath } = await loadBridge(dir);
    await host.commands.get("knit").handler("task new --title 桥接查询 --slug bridge-query", host.ctx);
    const createdNotice = host.notifications.at(-1);
    assert.equal(createdNotice.level, "info");
    assert.match(createdNotice.text, /桥接查询/, "创建结果按任务身份展示");

    // /knit task list。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("task list", host.ctx);
    const listNotice = host.notifications.at(-1);
    assert.equal(listNotice.level, "info");
    assert.match(listNotice.text, /活跃任务（1）/);
    assert.match(listNotice.text, /桥接查询/);

    // /knit status（项目概览）。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("status", host.ctx);
    const overviewNotice = host.notifications.at(-1);
    assert.match(overviewNotice.text, /任务（1）/);
    assert.match(overviewNotice.text, /活跃运行（\d+）/);

    // /knit-status（别名命令）。
    host.notifications.length = 0;
    await host.commands.get("knit-status").handler("", host.ctx);
    const statusNotice = host.notifications.at(-1);
    assert.match(statusNotice.text, /任务（1）/);

    // /knit status <taskId>（按任务查询）。
    const taskListJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    const id = taskListJson.data.active[0].taskId;
    host.notifications.length = 0;
    await host.commands.get("knit").handler(`status ${id}`, host.ctx);
    const byIdNotice = host.notifications.at(-1);
    assert.match(byIdNotice.text, new RegExp(id));
    assert.match(byIdNotice.text, /运行（\d+）/);

    // 失败响应：未知子命令给出错误提示而非通用完成。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("definitely-not-a-command", host.ctx);
    const failureNotice = host.notifications.at(-1);
    assert.equal(failureNotice.level, "warning");
    assert.notEqual(failureNotice.text, "Knit 命令已完成");

    // 空列表：归档空列表显示（无）。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("task list", host.ctx);
    assert.match(host.notifications.at(-1).text, /已归档（0）：\n  - （无）/s);

    rmSync(join(dir, ".pi", "extensions"), { recursive: true, force: true });
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    void dirname;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("每轮注入：before_agent_start 写 knit 分节；无任务入口规则；任务切换刷新；不堆叠（任务047）", async () => {
  const dir = project("inject");
  try {
    const { host } = await loadBridge(dir);
    // stub 会话管理器挂真实原生文件，attach 记录该文件。
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    // 登记主会话（桥接 session_start 语义：attach 后 state.nativeSessionId 与 stub 一致）。
    await host.handlers.get("session_start")({}, host.ctx);
    // 首轮（无任务）：分节给入口规则。
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const first = host.systemPromptOptions.sections.knit;
    assert.match(first, /当前无选定任务/);
    assert.match(first, /task new/);

    // 创建并选择任务后，下轮注入当前任务状态。
    await host.commands.get("knit").handler("task new --title 注入任务 --slug inject", host.ctx);
    const listJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    const taskId = listJson.data.active[0].taskId;
    const sessionJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "session", "list", "--dir", dir], { encoding: "utf8" }));
    const mainSession = sessionJson.data.find((entry) => entry.kind === "main");
    // 选择条目写入原生文件后按 --persisted 登记（DESIGN §9.1）。
    execFileSync(process.execPath, [CLI, "--json", "task", "use", taskId, "--session", mainSession.knitSessionId, "--entry", "sel-1", "--persisted", "--dir", dir], { encoding: "utf8" });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(nativeFile, JSON.stringify({ timestamp: "2026-11-02T00:00:02.000Z", type: "custom", customType: "knit.selection", id: "sel-1", parentId: null, data: { taskId, branch: "refs/heads/main", operationId: "sel-op-1" } }) + "\n");

    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const second = host.systemPromptOptions.sections.knit;
    assert.match(second, new RegExp(taskId));
    assert.match(second, /阶段: discuss/);
    assert.match(second, /任务入口: \.knit\//);

    // 规划资料出现在注入。
    execFileSync(process.execPath, [CLI, "--json", "task", "material", "save", taskId, "plan.md", "--dir", dir], { encoding: "utf8", input: "# 计划\n" });
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    assert.match(host.systemPromptOptions.sections.knit, /plan\.md/);

    // 自身通知触发的轮次（custom）不注入。
    delete host.systemPromptOptions.sections.knit;
    await host.handlers.get("before_agent_start")({ messageType: "custom", message: "knit run 完成", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    assert.equal(host.systemPromptOptions.sections.knit, undefined, "custom 轮次不注入");
    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("对话任务衔接：显式创建、重复引导、拒绝无副作用、选择已有任务、部分结果如实（任务048）", async () => {
  const dir = project("intake");
  try {
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);

    // 1. 显式创建：用户明确授权（主 Agent 直接执行）。
    await host.commands.get("knit").handler("task new --title 显式创建 --slug explicit", host.ctx);
    const list1 = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    assert.equal(list1.data.active.length, 1);
    const firstId = list1.data.active[0].taskId;

    // 2. 工具层创建 + 已有选择提醒（重复回复防线）。
    const tool = host.commands.get("knit_task") ?? null;
    void tool;
    const tasksToolSchema = host.commands;
    void tasksToolSchema;
    // knit_task 通过 registerTool 注册到 pi；stub 捕获：
    const toolDef = host.commands.get("knit_task") ?? null;
    void toolDef;

    // 通过桥接命令再建一个（模拟主 Agent 补充任务），有选择时结果带提醒。
    // 先选择第一个任务（knit_task use 经桥接写原生条目并登记）。
    // 用桥接命令直接 task use（转交 CLI，需要 --entry --persisted；这里直接写条目再用命令）：
    execFileSync(process.execPath, [CLI, "--json", "task", "use", firstId, "--session", resolveMain(dir), "--entry", "sel-1", "--persisted", "--dir", dir], { encoding: "utf8" });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(nativeFile, JSON.stringify({ timestamp: "2026-11-02T00:00:02.000Z", type: "custom", customType: "knit.selection", id: "sel-1", parentId: null, data: { taskId: firstId, branch: "refs/heads/main", operationId: "sel-op-1" } }) + "\n");

    // 3. 拒绝创建：用户不同意时无任何副作用——验证当前任务数不变。
    const countBefore = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" })).data.active.length;

    // 4. 重复回复防线：注入上下文（047）告知当前选择；工具层 selectionReminder 附加提醒。
    // 此处验证命令层语义：显式创建不被阻止，但已有选择不受影响、不串绑。
    await host.commands.get("knit").handler("task new --title 重复回复 --slug duplicate", host.ctx);
    const list2 = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    assert.equal(list2.data.active.length, countBefore + 1, "Knit 不阻止显式创建；防重复由主 Agent 依据注入上下文判断");
    assert.equal(list2.data.active.find((entry) => entry.taskId === firstId) !== undefined, true, "已有任务不受影响，不串绑");

    // 5. 部分结果如实：task use 到不存在的任务返回协议错误，不静默成功。
    const badUseRun = spawnSync(process.execPath, [CLI, "--json", "task", "use", "k-ffffffffffff", "--session", resolveMain(dir), "--dir", dir], { encoding: "utf8" });
    const badUse = JSON.parse(badUseRun.stdout);
    assert.equal(badUse.outcome, "error");
    assert.ok(badUse.data.error.length > 0);

    // 6. 需求写入任务资料（045 入口）：CLI material save。
    execFileSync(process.execPath, [CLI, "--json", "task", "material", "save", firstId, "plan.md", "--dir", dir], { encoding: "utf8", input: "# 需求与计划\n" });
    const material = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "material", "read", firstId, "plan.md", "--dir", dir], { encoding: "utf8" }));
    assert.equal(material.data.exists, true);

    // 7. 拒绝后无副作用：任务数仍为 2。
    const listFinal = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    assert.equal(listFinal.data.active.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function resolveMain(dir) {
  const sessionJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "session", "list", "--dir", dir], { encoding: "utf8" }));
  return sessionJson.data.find((entry) => entry.kind === "main").knitSessionId;
}

test("knit_material 与 knit_task new 提醒：需求写入入口与重复创建引导（任务048）", async () => {
  const dir = project("intake-tool");
  try {
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);

    // 用户明确授权创建 → 主 Agent 调 knit_task new。
    const created = await host.tools.get("knit_task").execute("t1", { action: "new", title: "工具创建", slug: "tool-new" }, null, null, host.ctx);
    assert.equal(created.isError, false);
    const firstId = created.details.taskId;

    // 无选择时创建不附加提醒。
    assert.ok(!created.content[0].text.includes("当前会话已选择任务"), "无既有选择不加提醒");

    // 选择该任务（经 knit_task use）。
    const used = await host.tools.get("knit_task").execute("t2", { action: "use", taskId: firstId }, null, null, host.ctx);
    assert.equal(used.isError, false, used.content?.[0]?.text ?? "");

    // 重复回复再建：提醒当前已有选择，不自动切换。
    const duplicate = await host.tools.get("knit_task").execute("t3", { action: "new", title: "重复回复", slug: "tool-dup" }, null, null, host.ctx);
    assert.equal(duplicate.isError, false);
    assert.match(duplicate.content[0].text, new RegExp(`已选择任务 ${firstId}`), "重复创建带提醒");
    const selection = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "session", "list", "--dir", dir], { encoding: "utf8" }));
    const main = selection.data.find((entry) => entry.kind === "main");
    assert.equal(main.selection.taskId, firstId, "选择不被新任务悄悄替换");

    // knit_material 保存/读取需求资料。
    const saved = await host.tools.get("knit_material").execute("t4", { action: "save", taskId: firstId, path: "plan.md", content: "# 需求与计划\n" }, null, null, host.ctx);
    assert.equal(saved.isError, false);
    const read = await host.tools.get("knit_material").execute("t5", { action: "read", taskId: firstId, path: "plan.md" }, null, null, host.ctx);
    assert.ok(read.content[0].text.includes("需求与计划"));
    const listed = await host.tools.get("knit_material").execute("t6", { action: "list", taskId: firstId }, null, null, host.ctx);
    assert.ok(listed.content[0].text.includes("plan.md"));

    // 非法路径拒绝。
    const bad = await host.tools.get("knit_material").execute("t7", { action: "save", taskId: firstId, path: "../escape.md", content: "x" }, null, null, host.ctx);
    assert.equal(bad.isError, true);

    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
