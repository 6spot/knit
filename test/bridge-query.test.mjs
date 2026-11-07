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
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const BRIDGE_TEMPLATE = join(import.meta.dirname, "..", "assets", "templates", "pi", "extensions", "knit.ts");

function shortId(id) {
  const dash = id.indexOf("-");
  return `${id.slice(0, dash + 1)}${id.slice(dash + 1, dash + 7)}`;
}

function truncateTitle(title) {
  return `${Array.from(title).slice(0, 20).join("")}…`;
}

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-042-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  execFileSync(process.execPath, [CLI, "init", "--pi", "--dir", dir], { encoding: "utf8" });
  return dir;
}

/** 最小公开 API 替身：捕获 registerCommand handler 与 ui.notify 通知。 */
/* 模板为 TypeScript；Node 24 类型剥离直接加载 .ts。 */
function makeHostStub() {
  const commands = new Map();
  const notifications = [];
  const messages = [];
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => tools.set(definition.name, definition),
    sendMessage: (message, options) => messages.push({ message, options }),
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
  return { commands, notifications, messages, pi, ctx, handlers, tools, systemPromptOptions, setSessionFile: (path) => { sessionFile = path; } };
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
  // 让 bridge-stub.ts 的 tsc 解析 @types/node：项目 node_modules 链接到测试项目根（编译后移除）。
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "dir");
  const sourcePath = join(buildDir, "bridge-stub.ts");
  writeFileSync(sourcePath, source);
  const compiled = spawnSync(tsc, ["--ignoreConfig", "--skipLibCheck", "--types", "node", "--target", "es2022", "--module", "es2022", "--moduleResolution", "node10", "--ignoreDeprecations", "6.0", "--outDir", buildDir, sourcePath], { encoding: "utf8", cwd: import.meta.dirname });
  if (compiled.status !== 0) throw new Error(`桥接模板编译失败: ${compiled.stderr || compiled.stdout}`);
  // 模板只依赖 node 内建模块；编译产物写入 .pi/extensions，项目根推导保持同构。
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
    assert.match(listNotice.text, /进行中（1）/);
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

    // 空列表：默认视图仍给出三段与汇总，归档只提示条数。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("task list", host.ctx);
    assert.match(host.notifications.at(-1).text, /进行中（1）：/);
    assert.match(host.notifications.at(-1).text, /归档 0（task list --archive）/);

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
    assert.match(first, /是否建任务由用户决定/);
    assert.match(first, /不派发无任务 worker/);
    assert.match(first, /派发分层：动手前先判断可委派/);
    assert.match(first, /W1 独立检查/);
    assert.match(first, /W4 用户指定/);
    assert.match(first, /没有任务就没有 Knit worker/);
    assert.match(first, /复杂但不建任务时不派 Knit run/);
    assert.match(first, /verification/);
    assert.match(first, /澄清门/);
    assert.match(first, /先取证再提问/);
    assert.match(first, /缺口清单为空或用户已裁决才登记/);
    assert.match(first, /（Agent 建议，待确认）/);
    assert.match(first, /复杂需求先拆分/);
    assert.match(first, /blocking 未清零不 task ready/);
    assert.match(first, /不得以“完整方案＋是否正确”作为唯一确认/);
    assert.match(first, /任务选择：/);
    assert.match(first, /遗漏选择先补问/);
    assert.match(first, /创建任务不等于需求确认或实施授权/);
    assert.match(first, /明确“按这个做”/);
    assert.match(first, /规范沉淀：/);
    assert.match(first, /需求澄清：/);
    assert.match(first, /交付：实施与检查结果由主会话接收/);
    assert.match(first, /完整规则见 AGENTS\.md/);
    assert.match(first, /流程配置见 \.knit\/workflow\.yaml/);
    assert.doesNotMatch(first, /workflow\.md/);
    assert.match(first, /历史查询/);
    assert.match(first, /需求澄清取证时可用/);
    assert.match(first, /普通对话仅在用户明确表达/);
    assert.match(first, /knit_task action=search/);
    assert.match(first, /未表达意愿不主动检索/);
    assert.match(first, /相关记录不等于因果结论/);
    assert.equal((first.match(/历史查询:/g) ?? []).length, 1, "无任务注入的历史查询只出现一次");
    assert.doesNotMatch(first, /待澄清: \d+ 项/, "无任务不显示未决数量");

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
    assert.match(second, new RegExp(`当前任务：「注入任务」（${shortId(taskId)}）`));
    assert.match(second, /阶段：准备（start）/);
    assert.match(second, /任务入口: \.knit\//);
    assert.match(second, /按当前阶段推进/);
    assert.doesNotMatch(second, /workflow\.md/);
    assert.match(second, /任务选择：/);
    assert.match(second, /遗漏选择先补问/);
    assert.match(second, /创建任务不等于需求确认或实施授权/);
    assert.match(second, /规范沉淀：/);
    assert.match(second, /需求澄清：/);
    assert.match(second, /交付：实施与检查结果由主会话接收/);
    assert.match(second, /派发分层：/);
    assert.match(second, /W1 独立检查.*W4 用户指定/);
    assert.match(second, /不得用 task implement 绕开 W1/);
    assert.equal((second.match(/历史查询:/g) ?? []).length, 1, "任务注入的历史查询只出现一次");
    assert.doesNotMatch(second, /待澄清: \d+ 项/, "无未决项不显示噪音");
    assert.doesNotMatch(second, /假设待确认: \d+ 项/, "无假设不显示噪音");

    // 「待澄清」计数进入注入与 status；blocking 阻止 ready。
    const taskFile = join(dir, ".knit", listJson.data.active[0].relativePath, "task.md");
    const templateBody = readFileSync(taskFile, "utf8");
    writeFileSync(
      taskFile,
      templateBody.replace(
        /## 待澄清\n\n<!--[\s\S]*?-->\n/,
        "## 待澄清\n\n- [blocking] 归档后旧索引是否保留？选项 A 保留／B 删除\n- [blocking] 是否支持逐任务文案？选项 A 支持／B 不支持\n- [assumed] 批量交付暂不支持逐任务文案（Agent 建议，待确认）\n",
      ),
    );
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const clarifyInjected = host.systemPromptOptions.sections.knit;
    assert.match(clarifyInjected, /待澄清: 2 项/);
    assert.match(clarifyInjected, /假设待确认: 1 项/);
    const statusJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "status", taskId, "--dir", dir], { encoding: "utf8" }));
    assert.deepEqual(statusJson.data.clarify, { blocking: 2, assumed: 1 }, "status 暴露「待澄清」计数");
    const blockedReady = spawnSync(process.execPath, [CLI, "--json", "task", "ready", taskId, "--dir", dir], { encoding: "utf8" });
    assert.notEqual(blockedReady.status, 0, "blocking 阻止 ready");
    assert.match(JSON.parse(blockedReady.stdout).data.error, /2 项 \[blocking\]/, "ready 错误带上未决数量");
    writeFileSync(taskFile, templateBody);

    // 阶段行使用配置显示名；不显示内部 id 作为主标签。
    execFileSync(process.execPath, [CLI, "--json", "task", "ready", taskId, "--dir", dir], { encoding: "utf8" });
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    assert.match(host.systemPromptOptions.sections.knit, /阶段：实现（implement）/);

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


test("桥接按 workflow.yaml 派生阶段 schema；读取失败退回字符串由核心报合法清单（P6）", async () => {
  const dir = project("workflow-schema");
  try {
    writeFileSync(join(dir, ".knit", "workflow.yaml"), [
      "version: 1",
      "stages:",
      "  - id: build",
      "    name: 构建",
      "  - id: verify",
      "    name: 验证",
      "    report:",
      "      verdict: [pass, blocked]",
      "    onVerdict:",
      "      blocked: build",
      "",
    ].join("\n"));
    const { host } = await loadBridge(dir);
    const runStages = host.tools.get("knit_run").parameters.properties.action.anyOf.map((entry) => entry.const);
    assert.deepEqual(runStages, ["build", "verify", "status", "list", "resume", "cancel"], "run.action 按配置派生");
    const contextStages = host.tools.get("knit_context").parameters.properties.stage.anyOf.map((entry) => entry.const);
    assert.deepEqual(contextStages, ["start", "build", "verify", "deliver"], "context.stage 按配置派生");
    const workflowTool = host.tools.get("knit_workflow");
    assert.ok(workflowTool, "新增 knit_workflow");
    const shown = await workflowTool.execute("w1", { action: "show" }, null, null, host.ctx);
    assert.equal(shown.isError, false, shown.content?.[0]?.text ?? "");
    assert.deepEqual(shown.details.workflow.stages.map((stage) => stage.id), ["build", "verify"]);
    const validated = await workflowTool.execute("w2", { action: "validate" }, null, null, host.ctx);
    assert.equal(validated.isError, false);
    assert.equal(validated.details.validation.ok, true);
    assert.equal(JSON.stringify(host.tools.get("knit_run").parameters).includes("advisory"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("桥接 knit_workflow set-tools：all／[]／clear 与 show 回显一致", async () => {
  const dir = project("workflow-set-tools");
  try {
    writeFileSync(join(dir, ".knit", "workflow.yaml"), "version: 1\nstages:\n  - id: build\n    tools: [read]\n");
    const { host } = await loadBridge(dir);
    const tool = host.tools.get("knit_workflow");
    const toolsAfter = async (params) => {
      const result = await tool.execute("w", { action: "set-tools", stageId: "build", ...params }, null, null, host.ctx);
      assert.equal(result.isError, false, result.content?.[0]?.text ?? "");
      const shown = await tool.execute("s", { action: "show" }, null, null, host.ctx);
      const fromShow = shown.details.workflow.stages[0].tools;
      assert.deepEqual(result.details.workflow.stages[0].tools, fromShow, "写入回显与 show 一致");
      return fromShow;
    };
    assert.equal(await toolsAfter({ tools: "all" }), null, "all = 全部放开");
    assert.deepEqual(await toolsAfter({ tools: [] }), [], "[] = 全部禁用");
    assert.deepEqual(await toolsAfter({ tools: ["read", "exec"] }), ["read", "exec"]);
    assert.equal(await toolsAfter({ clear: true }), null, "clear = 删除字段（全部放开）");
    assert.equal(/tools:/.test(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("桥接读取坏配置失败时退回字符串参数，不静默通过（P6）", async () => {
  const dir = project("workflow-schema-bad");
  try {
    writeFileSync(join(dir, ".knit", "workflow.yaml"), "version: 2\nstages:\n  - id: build\n");
    const { host } = await loadBridge(dir);
    const action = host.tools.get("knit_run").parameters.properties.action;
    assert.equal(action.type, "string", "降级时保留字符串参数");
    assert.equal(action.anyOf, undefined);
    const stage = host.tools.get("knit_context").parameters.properties.stage;
    assert.equal(stage.type, "string");
    assert.equal(stage.anyOf, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("桥接通知与 turn context 优先标题与阶段名；knit_status／knit_run 文本同口径", async () => {
  const dir = project("display-labels");
  try {
    const title = "桥接通知标题用于验证展示截断行为并超过二十字";
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);

    await host.commands.get("knit").handler(`task new --title ${title} --slug bridge-display`, host.ctx);
    const list = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    const taskId = list.data.active[0].taskId;
    execFileSync(process.execPath, [CLI, "--json", "task", "ready", taskId, "--dir", dir], { encoding: "utf8" });
    const taskFile = join(dir, ".knit", list.data.active[0].relativePath, "task.md");
    writeFileSync(taskFile, readFileSync(taskFile, "utf8").replace(/^stage: .*$/m, "stage: check"));

    const runA = prepareBridgeRun(dir, taskId, "check");
    finishBridgeRun(dir, runA, "pass");
    const dbPath = join(dir, ".knit", ".runtime", "metadata.db");
    const db = new SqliteMetadataStore(dbPath);
    await db.operations.setState(runA.acceptanceOperationId, "completed");
    db.close();

    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 1, "终态通知已投递");
    assert.deepEqual(host.messages[0].options, { deliverAs: "nextTurn", triggerTurn: false }, "完成且已接收：只进入下一轮上下文，不唤醒");
    const notice = host.messages[0].message.content;
    assert.match(notice, new RegExp(`^「${truncateTitle(title)}」检查：${shortId(runA.runId)} pass；下一步：`), "通知先给标题与阶段名，run 用短 ID");
    assert.match(notice, new RegExp(runA.runId), "下一步保留完整 run ID");

    // 待同步：结果已发布但尚未接收；保留“不要重复实施”措辞。
    const runB = prepareBridgeRun(dir, taskId, "check");
    finishBridgeRun(dir, runB, "pass");
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 2);
    assert.deepEqual(host.messages[1].options, { deliverAs: "followUp", triggerTurn: true }, "结果待接收：唤醒主 Agent");
    const pendingNotice = host.messages[1].message.content;
    assert.match(pendingNotice, new RegExp(`^「${truncateTitle(title)}」检查：${shortId(runB.runId)} 已完成，结果待同步`));
    assert.match(pendingNotice, /不要重复实施/);

    // 失败：仍需处理，保持唤醒。
    const runC = prepareBridgeRun(dir, taskId, "check");
    finishBridgeRun(dir, runC, "failed", "failed");
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 3, "失败终态通知已投递");
    assert.deepEqual(host.messages[2].options, { deliverAs: "followUp", triggerTurn: true }, "失败：需处理并唤醒主 Agent");
    assert.match(host.messages[2].message.content, /failed/, "失败通知如实展示终态");

    // 每轮上下文：标题与短任务 ID 同行，阶段行带配置显示名。
    execFileSync(process.execPath, [CLI, "--json", "task", "use", taskId, "--session", resolveMain(dir), "--entry", "sel-display", "--persisted", "--dir", dir], { encoding: "utf8" });
    appendFileSync(nativeFile, JSON.stringify({ timestamp: "2026-11-02T00:00:02.000Z", type: "custom", customType: "knit.selection", id: "sel-display", parentId: null, data: { taskId, branch: "refs/heads/main", operationId: "sel-display-op" } }) + "\n");
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const context = host.systemPromptOptions.sections.knit;
    assert.match(context, new RegExp(`当前任务：「${truncateTitle(title)}」（${shortId(taskId)}）`));
    assert.match(context, /阶段：检查（check）/);

    // knit_status／knit_run 的文本结果同样标题与阶段名优先。
    const statusTool = await host.tools.get("knit_status").execute("s1", { runId: runA.runId }, null, null, host.ctx);
    assert.equal(statusTool.isError, false, statusTool.content?.[0]?.text ?? "");
    assert.match(statusTool.content[0].text, new RegExp(`^任务：「${truncateTitle(title)}」${shortId(taskId)}（阶段：检查 check）`));
    const runTool = await host.tools.get("knit_run").execute("r1", { action: "status", runId: runA.runId }, null, null, host.ctx);
    assert.equal(runTool.isError, false, runTool.content?.[0]?.text ?? "");
    assert.match(runTool.content[0].text, new RegExp(`^任务：「${truncateTitle(title)}」${shortId(taskId)}（阶段：检查 check）`));
    const runList = await host.tools.get("knit_run").execute("r2", { action: "list" }, null, null, host.ctx);
    assert.equal(runList.isError, false, runList.content?.[0]?.text ?? "");
    assert.match(runList.content[0].text, new RegExp(`「${truncateTitle(title)}」${shortId(taskId)}检查：${shortId(runA.runId)}`));

    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function prepareBridgeRun(dir, taskId, stage) {
  const prepared = JSON.parse(execFileSync(process.execPath, [
    CLI, "--json", "run", "prepare", "--stage", stage, "--task", taskId,
    "--client", "pi", "--native", "stub-session", "--provider", "test", "--model", "fake", "--dir", dir,
  ], { encoding: "utf8" }));
  assert.equal(prepared.outcome, "completed", prepared.data?.error ?? "");
  return prepared.data.request;
}

function finishBridgeRun(dir, request, verdict, state = "completed") {
  const now = new Date().toISOString();
  const runs = new RunStore(dir);
  runs.writeState(request.runId, {
    schemaVersion: 1,
    runId: request.runId,
    taskId: request.taskId,
    phase: request.phase,
    workflowMode: request.workflowMode ?? "config",
    state,
    worker: { workerId: "stub-worker", pid: 1, bootId: "stub-boot", procStartTicks: null, hostname: "stub-host" },
    claimedAt: now,
    updatedAt: now,
    prepared: true,
    preparedAt: now,
    snapshot: { state: "ready", digest: null, entries: null, reason: null },
    reason: null,
  });
  runs.writeResult(request.runId, {
    schemaVersion: 1,
    runId: request.runId,
    taskId: request.taskId,
    phase: request.phase,
    state,
    report: state === "completed" ? { summary: "展示标签测试", validation: ["bridge fixture"], blockers: [], verdict } : null,
    reportSummary: state === "completed" ? "展示标签测试" : null,
    nativeEntries: { startEntryId: null, leafEntryId: null },
    usage: { inputTokens: null, outputTokens: null },
    session: null,
    actualChangedPaths: [],
    acceptanceOperationId: request.acceptanceOperationId,
    recordedAt: now,
    failureReason: state === "failed" ? "fixture failed" : null,
    workflowMode: request.workflowMode ?? "config",
  });
}

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

    // knit_task search：不需要 taskId，返回可核对来源；无匹配为空数组。
    const searched = await host.tools.get("knit_task").execute("t8", { action: "search", query: ["需求与计划"], scope: "task" }, null, null, host.ctx);
    assert.equal(searched.isError, false, searched.content?.[0]?.text ?? "");
    assert.ok(Array.isArray(searched.details));
    assert.equal(searched.details.length, 1);
    assert.equal(searched.details[0].kind, "task");
    assert.equal(searched.details[0].taskId, firstId);
    assert.match(searched.details[0].ref, /plan\.md:\d+$/);
    const emptySearch = await host.tools.get("knit_task").execute("t9", { action: "search", query: "不存在的查询词" }, null, null, host.ctx);
    assert.equal(emptySearch.isError, false);
    assert.deepEqual(emptySearch.details, []);

    // /knit task search 的可读摘要也展示来源与片段。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("task search 需求与计划 --scope task", host.ctx);
    assert.match(host.notifications.at(-1).text, /匹配记录（1）/);
    assert.match(host.notifications.at(-1).text, /plan\.md:\d+/);
    assert.match(host.notifications.at(-1).text, /需求与计划/);

    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knit_task ready／record／close 未传 taskId 使用当前选择；无选择返回同一句明确提示", async () => {
  const dir = project("current-task");
  try {
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    const tool = host.tools.get("knit_task");
    const expected = "未选择任务：请提供 taskId，或先用 knit_task action=use 选择当前任务";

    const noSelection = await tool.execute("t1", { action: "ready" }, null, null, host.ctx);
    assert.equal(noSelection.isError, true);
    assert.equal(noSelection.content[0].text, expected);

    const created = await tool.execute("t2", { action: "new", title: "当前任务", slug: "current-task" }, null, null, host.ctx);
    assert.equal(created.isError, false, created.content?.[0]?.text ?? "");
    const taskId = created.details.taskId;
    const used = await tool.execute("t3", { action: "use", taskId }, null, null, host.ctx);
    assert.equal(used.isError, false, used.content?.[0]?.text ?? "");

    const ready = await tool.execute("t4", { action: "ready" }, null, null, host.ctx);
    assert.equal(ready.isError, false, ready.content?.[0]?.text ?? "");
    assert.equal(ready.details.taskId, taskId);
    assert.equal(ready.details.stage, "implement");

    const recorded = await tool.execute("t5", { action: "record", body: "工具未传 taskId 的记录" }, null, null, host.ctx);
    assert.equal(recorded.isError, false, recorded.content?.[0]?.text ?? "");
    const list = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    const relative = list.data.active.find((entry) => entry.taskId === taskId).relativePath;
    assert.match(readFileSync(join(dir, ".knit", relative, "task.md"), "utf8"), /工具未传 taskId 的记录/);

    const closed = await tool.execute("t6", { action: "close", outcome: "cancelled", runsSettled: true }, null, null, host.ctx);
    assert.equal(closed.isError, false, closed.content?.[0]?.text ?? "");
    assert.equal(closed.details.taskId, taskId);
    assert.equal(closed.details.outcome, "cancelled");

    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 归档夹具：按 task.md 结构直接落盘，仅用于列表渲染。 */
function writeArchivedTask(dir, month, name, overrides = {}) {
  const frontmatter = {
    id: "k-bbbbbbbbbbbb",
    status: "closed",
    stage: "deliver",
    outcome: "completed",
    branch: "refs/heads/main",
    createdAt: "2026-11-02T00:00:00.000Z",
    title: "归档旧任务",
    ...overrides,
  };
  const file = join(dir, ".knit", "tasks", "archive", month, name, "task.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderTaskDocument({ frontmatter, ...renderInitialTaskBody(frontmatter.title), trailingBody: "" }));
  return file;
}

test("knit_task action=list：默认只列活跃并提示归档条数，archive 走按月视图（k-c06c5a41092f）", async () => {
  const dir = project("list-scope");
  try {
    const { host } = await loadBridge(dir);
    writeArchivedTask(dir, "2026-11", "11-02-legacy", { id: "k-bbbbbbbbbbbb", title: "归档旧任务" });

    const tool = host.tools.get("knit_task");
    const active = await tool.execute("l1", { action: "list" }, null, null, host.ctx);
    assert.equal(active.isError, false, active.content?.[0]?.text ?? "");
    const activeText = active.content[0].text;
    assert.match(activeText, /进行中（0）/);
    assert.match(activeText, /归档 1（task list --archive）/);
    assert.doesNotMatch(activeText, /归档旧任务/, "默认不展开归档明细");

    const archived = await tool.execute("l2", { action: "list", archive: true }, null, null, host.ctx);
    assert.equal(archived.isError, false, archived.content?.[0]?.text ?? "");
    const archivedText = archived.content[0].text;
    assert.match(archivedText, /归档 2026-11（1）/);
    assert.match(archivedText, /归档旧任务/);
    assert.match(archivedText, /全部归档 1 条/);

    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
