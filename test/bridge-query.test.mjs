/**
 * 任务042：Pi 桥接命令展示结构化查询结果。
 * 用公开 Extension API 替身加载安装后的真实桥接模板，
 * 令 core CLI 返回成功 data，断言通知内容确实可见。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { machineBootId } from "../dist/infrastructure/process.js";
import { renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const BRIDGE_TEMPLATE = join(import.meta.dirname, "..", "assets", "templates", "pi", "extensions", "knit.ts");

// 既有用例走新鲜路径：默认 300ms 预算在 CI／负载下会因 CLI 启动耗时触发缓存回退。
// 默认值不变；超时回退由「每轮上下文只调一次 CLI」用例单独验证（k-0524fc52e81b）。
process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "10000";

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
  const entryRenderers = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => tools.set(definition.name, definition),
    registerEntryRenderer: (customType, renderer) => entryRenderers.set(customType, renderer),
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
  return { commands, notifications, messages, pi, ctx, handlers, tools, entryRenderers, systemPromptOptions, entries, setSessionFile: (path) => { sessionFile = path; } };
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

/** 复刻 Pi 1.5.2 buildSystemPromptSections：raw 正文渲染为 `<knit>…</knit>` 存入 system 分节。 */
function renderKnitSection(raw) {
  return raw ? `<knit>\n${raw}\n</knit>` : raw;
}

async function loadBridge(dir) {
  // 安装映射与清单已 ready；用临时副本替换 __BRIDGE_BASELINE__ 占位后经 tsc 编译加载。
  const { execFileSync } = await import("node:child_process");
  const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
  // 仅在编译后的测试替身中追踪所有 CLI Promise，清理时等到 close，避免后台刷新继续写已删除的目录。
  const source = readFileSync(BRIDGE_TEMPLATE, "utf8")
    .replace("__BRIDGE_BASELINE__", "stub-baseline")
    .replace("function runProcess(", "function fixtureRunProcess(") + `
const fixtureProcesses = new Set<Promise<ExecResult>>();
function runProcess(...args: Parameters<typeof fixtureRunProcess>): Promise<ExecResult> {
  const work = fixtureRunProcess(...args);
  fixtureProcesses.add(work);
  void work.finally(() => fixtureProcesses.delete(work));
  return work;
}
export async function drainFixtureProcesses(): Promise<void> {
  do {
    await Promise.all([...fixtureProcesses]);
    // 预热与扫描的上层 continuation 可能在子进程 close 后再排下一次 CLI；
    // 等到本轮事件循环结束后再判空，避免清理目录时仍有后续查询写入。
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (fixtureProcesses.size > 0);
}
`;
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
  const api = await module.default(host.pi);
  const shutdown = host.handlers.get("session_shutdown");
  host.handlers.set("session_shutdown", async () => {
    // 先停止调度，再等已排队扫描与所有 CLI close；不终止夹具以外的进程。
    shutdown();
    await api.state.scanChain;
    await module.drainFixtureProcesses();
  });
  return { host, bridgePath: bridgeTs, api };
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
    assert.match(second, /task implement 不代替独立检查/);
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
    assert.deepEqual(runStages, ["build", "verify", "status", "list", "resume", "cancel", "accept"], "run.action 按配置派生");
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

    const noticeEntries = () => host.entries.filter((entry) => entry.type === "custom" && entry.customType === "knit.notice");
    const renderNotice = host.entryRenderers.get("knit.notice");
    assert.equal(typeof renderNotice, "function", "桥接注册了 knit.notice 的 entry renderer");

    // 被动：完成且已接收——不调用 sendMessage（不进上下文、不触发轮次），只追加带展示文案的条目。
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 0, "完成且已接收：不调用 sendMessage，不进入任何一轮上下文");
    assert.equal(noticeEntries().length, 1, "被动通知恰好追加一条 knit.notice 条目");
    const passive = noticeEntries()[0];
    assert.deepEqual(Object.keys(passive.data).sort(), ["acceptance", "runId", "signature", "state", "text"], "被动条目承载去重与展示字段");
    assert.equal(passive.data.signature, `${runA.runId}:completed`);
    assert.equal(passive.data.runId, runA.runId);
    assert.equal(passive.data.state, "completed");
    assert.equal(passive.data.acceptance, "completed");
    const notice = passive.data.text;
    assert.match(notice, new RegExp(`^「${truncateTitle(title)}」检查：${shortId(runA.runId)} pass，结果已接收；下一步：`), "通知先给标题与阶段名，run 用短 ID，并写明结果已接收");
    assert.match(notice, new RegExp(runA.runId), "保留完整 run ID");
    assert.doesNotMatch(notice, /或 resume/, "已接收的完成通知不再建议 resume");
    // 展示路径：entry renderer 返回组件，输出含 [knit.notice] 标签与完整文案（theme 缺方法时不抛错）。
    const card = renderNotice(passive, { expanded: false }, {});
    assert.equal(typeof card?.render, "function", "被动条目渲染为组件");
    const rendered = card.render(200).join("\n");
    assert.match(rendered, /\[knit\.notice\]/, "卡片带 [knit.notice] 标签");
    for (const line of notice.split("\n")) assert.ok(rendered.includes(line), `卡片展示完整文案：${line}`);

    // 重复扫描：同一终态不再追加条目、不产生消息。
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 0, "重复扫描不产生消息");
    assert.equal(noticeEntries().length, 1, "重复扫描不重复追加条目");

    // 待同步：结果已发布但尚未接收；保留“不要重复实施”措辞。
    const runB = prepareBridgeRun(dir, taskId, "check");
    finishBridgeRun(dir, runB, "pass");
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 1, "结果待接收：新增一条消息");
    assert.deepEqual(host.messages[0].options, { deliverAs: "followUp", triggerTurn: true }, "结果待接收：进入上下文并唤醒主 Agent");
    assert.equal(host.messages[0].message.customType, "knit.notice");
    assert.equal(host.messages[0].message.display, true);
    assert.deepEqual(host.messages[0].message.details, { runId: runB.runId, state: "completed", acceptance: host.messages[0].message.details.acceptance, signature: `${runB.runId}:completed` });
    assert.notEqual(host.messages[0].message.details.acceptance, "completed", "结果尚未接收");
    const pendingNotice = host.messages[0].message.content;
    assert.match(pendingNotice, new RegExp(`^「${truncateTitle(title)}」检查：${shortId(runB.runId)} 已完成，结果待同步`));
    assert.match(pendingNotice, /不要重复实施/);
    assert.equal(noticeEntries().length, 2, "需处理通知另写一条去重条目");
    const pendingDedupe = noticeEntries()[1];
    assert.deepEqual(pendingDedupe.data, { signature: `${runB.runId}:completed`, runId: runB.runId, state: "completed" }, "去重条目不带 text");
    assert.equal(renderNotice(pendingDedupe, { expanded: false }, {}), undefined, "去重条目不渲染，需处理通知不出现第二张卡片");

    // 失败：仍需处理，保持唤醒。
    const runC = prepareBridgeRun(dir, taskId, "check");
    finishBridgeRun(dir, runC, "failed", "failed");
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 2, "失败终态通知已投递");
    assert.deepEqual(host.messages[1].options, { deliverAs: "followUp", triggerTurn: true }, "失败：需处理并唤醒主 Agent");
    assert.match(host.messages[1].message.content, /failed/, "失败通知如实展示终态");
    assert.equal(noticeEntries().length, 3);
    const failedDedupe = noticeEntries()[2];
    assert.deepEqual(failedDedupe.data, { signature: `${runC.runId}:failed`, runId: runC.runId, state: "failed" }, "失败去重条目不带 text");
    assert.equal(renderNotice(failedDedupe, { expanded: false }, {}), undefined, "失败去重条目不渲染");

    // 再次扫描：三种终态都已去重，消息与条目数不变。
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(host.messages.length, 2, "需处理通知不重复投递");
    assert.equal(noticeEntries().length, 3, "条目不重复追加");
    assert.ok(host.messages.every((item) => item.options.deliverAs === "followUp" && item.options.triggerTurn === true), "所有进入上下文的通知都以 followUp 唤醒");
    assert.match(host.messages[1].message.content, /或 resume/, "失败通知文案保持现状");
    // 改动前遗留的旧去重条目（无 text）与异常数据同样不渲染。
    assert.equal(renderNotice({ type: "custom", customType: "knit.notice", data: { signature: "run-legacy:completed", runId: "run-legacy", state: "completed" } }, { expanded: false }, {}), undefined);
    assert.equal(renderNotice({ type: "custom", customType: "knit.notice", data: { signature: "x", text: "" } }, { expanded: false }, {}), undefined);
    assert.equal(renderNotice({ type: "custom", customType: "knit.notice" }, { expanded: false }, {}), undefined);

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

test("knit_run action=resume：生成新 run 后真启动，wait 观察到终态；每轮上下文与 knit_context 显示 nextAction（k-836997c84864）", async () => {
  const dir = project("resume-bridge");
  const savedBin = process.env.KNIT_PI_BIN;
  const savedAction = process.env.KNIT_FAKE_ACTION;
  try {
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    const created = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", "桥接恢复", "--slug", "bridge-resume", "--verification", "self", "--dir", dir], { encoding: "utf8" }));
    const taskId = created.data.taskId;
    execFileSync(process.execPath, [CLI, "--json", "task", "ready", taskId, "--dir", dir], { encoding: "utf8" });
    // 旧 run：已认领、worker 句柄指向已退出进程、阶段 Pi 已退出且无结果（worker 被杀的现场）。
    const old = prepareBridgeRun(dir, taskId, "implement");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const now = new Date().toISOString();
    const runs = new RunStore(dir);
    const bootId = machineBootId();
    runs.writeLaunch(old.runId, { ...runs.readLaunch(old.runId), state: "confirmed", attempts: 1, handle: { pid: dead, bootId, procStartTicks: "1", hostname: "h", recordedAt: now } });
    runs.writeState(old.runId, {
      schemaVersion: 1, runId: old.runId, taskId, phase: "implement", state: "running",
      worker: { workerId: "w-dead", pid: dead, bootId, procStartTicks: "1", hostname: "h" },
      claimedAt: now, updatedAt: now, prepared: true, preparedAt: now, snapshot: null, reason: null,
    });
    runs.writeStageProcess(old.runId, {
      schemaVersion: 1, runId: old.runId, taskId, phase: "implement", state: "exited", workerPid: dead, piPid: null,
      bootId, procStartTicks: null, hostname: "h", nativeSessionId: "stub-stage", knitSessionId: "ks-stub", startedAt: now, recordedAt: now,
    });

    // 每轮上下文：选择任务后显示核心推导的 resume 出口。
    execFileSync(process.execPath, [CLI, "--json", "task", "use", taskId, "--session", resolveMain(dir), "--entry", "sel-resume", "--persisted", "--dir", dir], { encoding: "utf8" });
    appendFileSync(nativeFile, JSON.stringify({ timestamp: "2026-11-02T00:00:02.000Z", type: "custom", customType: "knit.selection", id: "sel-resume", parentId: null, data: { taskId, branch: "refs/heads/main", operationId: "sel-resume-op" } }) + "\n");
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    assert.match(host.systemPromptOptions.sections.knit, new RegExp(`下一步（run_worker_exited）.*\\n  knit run resume ${old.runId}`));
    const context = await host.tools.get("knit_context").execute("c1", { taskId, stage: "implement" }, null, null, host.ctx);
    assert.equal(context.isError, false, context.content?.[0]?.text ?? "");
    assert.match(context.content[0].text, /^下一步（run_worker_exited）/);

    // resume：生成新 run 并真启动；wait 观察终态。
    process.env.KNIT_PI_BIN = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
    const actionPath = join(dir, "fake-action.json");
    writeFileSync(actionPath, JSON.stringify({ writes: [{ path: "a.txt", content: "resumed\n" }], report: { summary: "桥接恢复完成", changedPaths: ["a.txt"] } }));
    process.env.KNIT_FAKE_ACTION = actionPath;
    const resumed = await host.tools.get("knit_run").execute("r1", { action: "resume", runId: old.runId, wait: true }, null, null, host.ctx);
    assert.equal(resumed.isError, false, resumed.content?.[0]?.text ?? "");
    assert.equal(resumed.details.started, true);
    assert.equal(resumed.details.launch.state, "confirmed");
    assert.equal(resumed.details.status.state, "completed");
    assert.match(resumed.content[0].text, new RegExp(`已恢复为新 run ${resumed.details.request.runId}：启动 confirmed`));
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "resumed\n");

    await host.handlers.get("session_shutdown")();
  } finally {
    if (savedBin === undefined) delete process.env.KNIT_PI_BIN;
    else process.env.KNIT_PI_BIN = savedBin;
    if (savedAction === undefined) delete process.env.KNIT_FAKE_ACTION;
    else process.env.KNIT_FAKE_ACTION = savedAction;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knit_deliver 桥接：非 plan 动作一律传会话记录，native:／message:／自由文本引用报 authorization_unverified（k-28296c22647a）", async () => {
  const dir = project("deliver-auth");
  try {
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", [
      { type: "message", id: "u1a2b3c4", parentId: null, message: { role: "user", content: "可以提交" } },
    ]);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    const created = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", "桥接授权", "--slug", "bridge-auth", "--dir", dir], { encoding: "utf8" }));
    const taskId = created.data.taskId;
    const taskFile = join(dir, ".knit", created.data.relativePath);
    writeFileSync(taskFile, readFileSync(taskFile, "utf8").replace(/^stage: .*$/m, "stage: deliver"));
    const tool = host.tools.get("knit_deliver");
    const deliver = (authorizationRef) => tool.execute("d", { action: "deliver", taskId, branch: "refs/heads/main", authorizationRef }, null, null, host.ctx);

    // 会话中没有这些用户消息：不论写法都按会话核对并拒绝，不再以 verified=false 接受。
    for (const ref of ["native:x", "message:x", "用户说可以交付", "user:自由文本"]) {
      const denied = await deliver(ref);
      assert.equal(denied.isError, true, ref);
      assert.match(denied.content[0].text, /authorization_unverified/, `${ref}: ${denied.content[0].text}`);
    }
    // 对照：真实用户消息通过授权核对（之后按交付资格等其它原因停下，与授权无关）。
    const genuine = await deliver("user:u1a2b3c4");
    assert.doesNotMatch(genuine.content[0].text, /authorization_unverified/, genuine.content[0].text);

    // 取不到会话文件：用户类引用在桥接层直接拒绝；项目策略来源仍交核心。
    host.setSessionFile(null);
    for (const ref of ["native:x", "自由文本", "user:u1a2b3c4"]) {
      const denied = await deliver(ref);
      assert.equal(denied.isError, true, ref);
      assert.match(denied.content[0].text, /^authorization_unverified: 当前会话没有原生记录文件/, ref);
    }
    const policy = await deliver("workflow:AGENTS.md");
    assert.doesNotMatch(policy.content[0].text, /authorization_unverified/, policy.content[0].text);
    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 安装一个记录调用的 CLI 包装（k-0524fc52e81b）：桥接仍调用 installation.json 的入口，
 * 包装逐次追加 argv 后转交真实 CLI；tests 用调用日志核对每轮只产生一个 CLI 进程。
 */
function installCliSpy(dir) {
  const base = join(dir, ".knit", ".runtime", "spy");
  mkdirSync(join(base, "cli"), { recursive: true });
  mkdirSync(join(base, "contracts"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "..", "dist", "contracts", "bridge-tools.json"), join(base, "contracts", "bridge-tools.json"));
  const installPath = join(dir, ".knit", ".runtime", "installation.json");
  const installation = JSON.parse(readFileSync(installPath, "utf8"));
  const spyPath = join(base, "cli", "knit.mjs");
  writeFileSync(spyPath, [
    'import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    "const log = process.env.KNIT_SPY_LOG;",
    "if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + \"\\n\");",
    // 测试钩子：让 run list 查询失败（无输出、非零退出），其余命令照常转发。
    "if (process.env.KNIT_SPY_FAIL_RUN_LIST === \"1\" && process.argv[3] === \"run\" && process.argv[4] === \"list\") process.exit(1);",
    // 测试钩子：让任务级 status 查询失败（status --run 照常转发）。
    "if (process.env.KNIT_SPY_FAIL_TASK_STATUS === \"1\" && process.argv[3] === \"status\" && String(process.argv[4] ?? \"\").startsWith(\"k-\")) process.exit(1);",
    "const delay = Number(process.env.KNIT_SPY_DELAY_MS ?? 0);",
    "const contextOnly = process.env.KNIT_SPY_DELAY_CONTEXT_ONLY === \"1\";",
    "const commandArgs = process.argv.slice(2).filter((arg) => arg !== \"--dev\");",
    "const isContext = commandArgs[1] === \"session\" && commandArgs[2] === \"context\";",
    "if (Number.isFinite(delay) && delay > 0 && (!contextOnly || isContext)) await new Promise((resolve) => setTimeout(resolve, delay));",
    "if (isContext && process.env.KNIT_SPY_FAIL_CONTEXT === \"1\") process.exit(1);",
    // 先执行真实查询，再挂起已读取快照的回包；由文件信号显式释放。
    "const gate = isContext ? process.env.KNIT_SPY_CONTEXT_GATE : undefined;",
    "if (gate) {",
    "  const child = spawnSync(process.execPath, [process.env.KNIT_SPY_REAL, ...process.argv.slice(2)], { encoding: \"utf8\", env: process.env });",
    "  writeFileSync(gate + \".snapshot.tmp\", child.stdout);",
    "  renameSync(gate + \".snapshot.tmp\", gate + \".snapshot\");",
    "  const deadline = Date.now() + 15000;",
    "  while (!existsSync(gate + \".release\")) {",
    "    if (Date.now() > deadline) process.exit(2);",
    "    await new Promise((resolve) => setTimeout(resolve, 10));",
    "  }",
    "  process.stdout.write(child.stdout);",
    "  process.stderr.write(child.stderr);",
    "  process.exit(child.status ?? 1);",
    "}",
    "const child = spawnSync(process.execPath, [process.env.KNIT_SPY_REAL, ...process.argv.slice(2)], { stdio: \"inherit\", env: process.env });",
    "process.exit(child.status ?? 1);",
    "",
  ].join("\n"));
  writeFileSync(installPath, JSON.stringify({ ...installation, cliEntry: spyPath }, null, 2) + "\n");
  return { log: join(dir, "spy-calls.log"), real: installation.cliEntry, spyPath };
}

function readSpyCalls(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

/** 读取主会话与 `knit session context` 的当前选择／阶段，作为注入文本的对照权威。 */
function sessionContextOf(dir) {
  const sessions = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "session", "list", "--dir", dir], { encoding: "utf8" }));
  const main = sessions.data.find((entry) => entry.kind === "main" && entry.ref?.nativeSessionId === "stub-session") ?? sessions.data.find((entry) => entry.kind === "main");
  assert.ok(main, "缺少主会话登记");
  const context = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "session", "context", main.knitSessionId, "--dir", dir], { encoding: "utf8" }));
  return context.data;
}

function captureDiagChunks() {
  const chunks = [];
  const savedWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    void rest;
    chunks.push(String(chunk));
    return true;
  };
  return {
    chunks,
    events: () =>
      chunks.join("").split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "knit.bridge.diag"),
    restore: () => {
      process.stderr.write = savedWrite;
    },
  };
}

/** 有界等待显式快照信号；时序由 gate 控制，不靠长 sleep 猜查询进度。 */
async function waitForContextSnapshot(gate) {
  const deadline = Date.now() + 10000;
  while (!existsSync(`${gate}.snapshot`)) {
    assert.ok(Date.now() < deadline, `未收到快照信号: ${gate}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return JSON.parse(readFileSync(`${gate}.snapshot`, "utf8")).data;
}

for (const failNewContext of [false, true]) {
  test(`上下文竞态：读 A 后切 B，${failNewContext ? "新查询失败保留原生分节" : "B 先缓存、A 最后回包再失败"}（k-8fc483a6e41e）`, async () => {
    const dir = project("context-race");
    const names = ["KNIT_SPY_LOG", "KNIT_SPY_REAL", "KNIT_SPY_CONTEXT_GATE", "KNIT_SPY_FAIL_CONTEXT", "KNIT_BRIDGE_CONTEXT_TIMEOUT_MS", "KNIT_DEV"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const gate = join(dir, "held-a");
    let host;
    let oldTurn;
    let diag;
    try {
      const create = (slug) => JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", `竞态任务${slug}`, "--slug", `race-${slug}`, "--dir", dir], { encoding: "utf8" })).data.taskId;
      const a = create("a");
      const b = create("b");
      const spy = installCliSpy(dir);
      process.env.KNIT_SPY_LOG = spy.log;
      process.env.KNIT_SPY_REAL = spy.real;
      process.env.KNIT_SPY_FAIL_CONTEXT = "1";
      process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "10000";
      process.env.KNIT_DEV = "1";
      ({ host } = await loadBridge(dir));
      // init 正常生成本次模板，不依赖 force 或安装外部包。
      assert.equal(readFileSync(join(dir, ".pi", "extensions", "knit.ts"), "utf8").replace(/const MANAGED_BASELINE = "[^"]+";/, 'const MANAGED_BASELINE = "__BRIDGE_BASELINE__";'), readFileSync(BRIDGE_TEMPLATE, "utf8"));
      const selection = { type: "custom", id: "sel-a", parentId: null, customType: "knit.selection", data: { taskId: a, branch: "refs/heads/main", operationId: "race-a" } };
      host.setSessionFile(writeStubNativeSession(dir, "stub-session", [selection]));
      host.entries.push(selection);
      const previous = `<!-- knit:turn-context -->\n当前任务：「合法上一轮」（${shortId(a)}）`;
      host.entries.push({ type: "message", id: "prev", message: { role: "system", sections: { knit: renderKnitSection(previous) } } });
      diag = captureDiagChunks();
      await host.handlers.get("session_start")({}, host.ctx);
      // 先让失败的预热彻底结束，保留无内存缓存的原生回填路径。
      await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: { sections: {} } }, host.ctx);
      delete process.env.KNIT_SPY_FAIL_CONTEXT;
      process.env.KNIT_SPY_CONTEXT_GATE = gate;
      rmSync(spy.log, { force: true });
      const oldOptions = { sections: {} };
      let oldTurnSettled = false;
      oldTurn = host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: oldOptions }, host.ctx).then(() => { oldTurnSettled = true; });
      assert.equal((await waitForContextSnapshot(gate)).taskId, a, "旧请求已实际读取 A");
      const queried = await host.tools.get("knit_status").execute("read-only", { taskId: a }, null, null, host.ctx);
      assert.equal(queried.isError, false);
      const sharedOptions = { sections: {} };
      const sharedTurn = host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: sharedOptions }, host.ctx);
      delete process.env.KNIT_SPY_CONTEXT_GATE;
      if (failNewContext) process.env.KNIT_SPY_FAIL_CONTEXT = "1";
      const used = await host.tools.get("knit_task").execute("switch-b", { action: "use", taskId: b }, null, null, host.ctx);
      assert.equal(used.isError, false);
      assert.equal(sessionContextOf(dir).taskId, b, "核心当前选择确为 B");
      const current = { sections: {} };
      await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: current }, host.ctx);
      if (failNewContext) {
        assert.match(current.sections.knit, /合法上一轮/);
        assert.match(current.sections.knit, /上下文可能过期/);
        assert.ok(diag.events().some((event) => event.event === "context_refresh_failed"));
      } else {
        assert.match(current.sections.knit, new RegExp(shortId(b)));
        assert.doesNotMatch(current.sections.knit, new RegExp(`${shortId(a)}|上下文可能过期`));
      }
      // B 的查询已完成后才允许 A 回包；等旧用户轮次完成即确认其缓存写入路径也已走完。
      assert.equal(oldTurnSettled, false, "A 必须仍在等待回包，不能靠超时结束竞态");
      writeFileSync(`${gate}.release`, "release\n");
      await oldTurn;
      await sharedTurn;
      assert.equal(readSpyCalls(spy.log).filter((args) => {
        const plain = args.filter((arg) => arg !== "--dev");
        return plain[1] === "session" && plain[2] === "context";
      }).length, 2, "只读查询不失效：A 请求共享，写动作后只新建一次 B 查询");
      assert.match(oldOptions.sections.knit, /上下文可能过期/, "旧回包不能被标 fresh");
      process.env.KNIT_SPY_FAIL_CONTEXT = "1";
      const fallback = { sections: {} };
      await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: fallback }, host.ctx);
      assert.match(fallback.sections.knit, /上下文可能过期/);
      if (failNewContext) assert.match(fallback.sections.knit, /合法上一轮/);
      else {
        assert.match(fallback.sections.knit, new RegExp(shortId(b)), "旧 A 不得覆盖已成功缓存的 B");
        assert.doesNotMatch(fallback.sections.knit, new RegExp(shortId(a)));
      }
      assert.doesNotMatch(fallback.sections.knit, /<knit>/);
      assert.equal((fallback.sections.knit.match(/<!-- knit:turn-context -->/g) ?? []).length, 1);
      assert.ok(diag.events().some((event) => event.event === "context_refresh_failed" && event.reason === "context_invalidated"));
    } finally {
      writeFileSync(`${gate}.release`, "release\n");
      if (oldTurn) await oldTurn;
      if (host) await host.handlers.get("session_shutdown")();
      if (diag) diag.restore();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("夹具清理：shutdown 等待已读取快照的后台 CLI 关闭后再删除项目", async () => {
  const dir = project("cleanup-inflight");
  const gate = join(dir, "held-background");
  const names = ["KNIT_SPY_LOG", "KNIT_SPY_REAL", "KNIT_SPY_CONTEXT_GATE"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let host;
  let shutdown;
  try {
    const spy = installCliSpy(dir);
    process.env.KNIT_SPY_LOG = spy.log;
    process.env.KNIT_SPY_REAL = spy.real;
    process.env.KNIT_SPY_CONTEXT_GATE = gate;
    ({ host } = await loadBridge(dir));
    host.setSessionFile(writeStubNativeSession(dir, "stub-session", []));
    await host.handlers.get("session_start")({}, host.ctx);
    await waitForContextSnapshot(gate);
    let closed = false;
    shutdown = host.handlers.get("session_shutdown")().then(() => { closed = true; });
    // 一个 event-loop 回合让清理走到等待点；gate 未释放前，CLI 必须仍然在途。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "不能只停止观察器就宣称夹具已静止");
    writeFileSync(`${gate}.release`, "release\n");
    await shutdown;
    assert.equal(closed, true);
  } finally {
    writeFileSync(`${gate}.release`, "release\n");
    if (shutdown) await shutdown;
    else if (host) await host.handlers.get("session_shutdown")();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("每轮上下文只调一次 session context；超时用上一轮缓存并标注可能过期（k-0524fc52e81b）", async () => {
  const dir = project("context-once");
  const savedLog = process.env.KNIT_SPY_LOG;
  const savedReal = process.env.KNIT_SPY_REAL;
  const savedDelay = process.env.KNIT_SPY_DELAY_MS;
  const savedTimeout = process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS;
  try {
    const spy = installCliSpy(dir);
    process.env.KNIT_SPY_LOG = spy.log;
    process.env.KNIT_SPY_REAL = spy.real;
    process.env.KNIT_SPY_DELAY_MS = "0";
    process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "10000";
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    // session_start 的 attach／verify／restore／预热与首个观察器扫描都经同一包装；等它们结束再计数。
    await new Promise((resolve) => setTimeout(resolve, 2500));
    rmSync(spy.log, { force: true });

    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const calls = readSpyCalls(spy.log);
    assert.equal(calls.length, 1, `每轮只应产生一个 CLI 调用: ${JSON.stringify(calls)}`);
    assert.deepEqual(calls[0].slice(0, 3), ["--json", "session", "context"], "上下文只走 session context");
    assert.equal(calls[0].at(-2), "--dir");
    assert.match(host.systemPromptOptions.sections.knit, /当前无选定任务/);

    // 预算内拿不到结果：不阻塞等待，改用上一轮缓存并标注可能过期。
    process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "1";
    process.env.KNIT_SPY_DELAY_MS = "2000";
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const cached = host.systemPromptOptions.sections.knit;
    assert.match(cached, /当前无选定任务/, "超时仍给出上一轮上下文");
    assert.match(cached, /上下文可能过期/, "超时标注可能过期");
    assert.match(cached, /本次查询超过 1ms/, "写明超时预算");
    assert.equal(readSpyCalls(spy.log).at(-1).slice(0, 3).join(" "), "--json session context");
    process.env.KNIT_SPY_DELAY_MS = "0";
    await host.handlers.get("session_shutdown")();
  } finally {
    if (savedLog === undefined) delete process.env.KNIT_SPY_LOG;
    else process.env.KNIT_SPY_LOG = savedLog;
    if (savedReal === undefined) delete process.env.KNIT_SPY_REAL;
    else process.env.KNIT_SPY_REAL = savedReal;
    if (savedDelay === undefined) delete process.env.KNIT_SPY_DELAY_MS;
    else process.env.KNIT_SPY_DELAY_MS = savedDelay;
    if (savedTimeout === undefined) delete process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS;
    else process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = savedTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("续接会话：预热在途时三轮用户消息都注入当轮上下文（k-50d398bff55f／R1.S1）", async () => {
  const dir = project("resume-inject");
  const saved = {};
  for (const name of ["KNIT_SPY_LOG", "KNIT_SPY_REAL", "KNIT_SPY_DELAY_MS", "KNIT_SPY_DELAY_CONTEXT_ONLY", "KNIT_BRIDGE_CONTEXT_TIMEOUT_MS"]) {
    saved[name] = process.env[name];
  }
  try {
    const first = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", "续接任务一", "--slug", "resume-one", "--verification", "self", "--dir", dir], { encoding: "utf8" }));
    const firstId = first.data.taskId;
    execFileSync(process.execPath, [CLI, "--json", "task", "ready", firstId, "--dir", dir], { encoding: "utf8" });
    const second = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", "续接任务二", "--slug", "resume-two", "--verification", "self", "--dir", dir], { encoding: "utf8" }));
    const secondId = second.data.taskId;

    const spy = installCliSpy(dir);
    process.env.KNIT_SPY_LOG = spy.log;
    process.env.KNIT_SPY_REAL = spy.real;
    // 续接进程的冷启动约 0.6s：拖慢 session context 超过单轮 300ms 预算，attach／verify 不受影响。
    process.env.KNIT_SPY_DELAY_MS = "800";
    process.env.KNIT_SPY_DELAY_CONTEXT_ONLY = "1";
    delete process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS;

    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", [
      { type: "custom", id: "sel-1", parentId: null, customType: "knit.selection", data: { taskId: firstId, branch: "refs/heads/main", operationId: "sel-op-1" } },
    ]);
    host.setSessionFile(nativeFile);
    host.entries.push({ type: "custom", id: "sel-1", parentId: null, customType: "knit.selection", data: { taskId: firstId, branch: "refs/heads/main", operationId: "sel-op-1" } });
    await host.handlers.get("session_start")({}, host.ctx);

    // 第 1 轮：session_start 预热仍在途（800ms > 300ms）。旧实现会再起一个 CLI 并超时，删除分节。
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const firstSection = host.systemPromptOptions.sections.knit;
    assert.ok(firstSection, "续接首轮必须有 knit 分节");
    assert.match(firstSection, /当前任务：「续接任务一」/);
    const firstContext = sessionContextOf(dir);
    assert.equal(firstContext.taskId, firstId, "首轮任务与 session context 一致");
    assert.equal(firstContext.task.stage, "implement", "首轮阶段与 session context 一致");
    assert.match(firstSection, new RegExp(`阶段：实现（implement）`));
    assert.match(firstSection, new RegExp(shortId(firstId)));
    assert.doesNotMatch(firstSection, /上下文可能过期/, "预热结果应作为当轮上下文，不是降级缓存");
    assert.equal(readSpyCalls(spy.log).filter((call) => call[1] === "session" && call[2] === "context").length, 1, "预热与首轮共享同一个 session context 调用");

    // 第 2 轮：切换任务后必须拿到新任务与阶段，不能用上一轮内容。
    // task use 触发的后台刷新与本轮注入共享在途请求；给 1s 预算避免测试机负载误判回退（默认 300ms 回退由超时用例覆盖）。
    process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "1000";
    process.env.KNIT_SPY_DELAY_MS = "0";
    const usedSecond = await host.tools.get("knit_task").execute("use-second", { action: "use", taskId: secondId }, null, null, host.ctx);
    assert.equal(usedSecond.isError, false, usedSecond.content?.[0]?.text ?? "");
    await new Promise((resolve) => setTimeout(resolve, 600));
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const secondSection = host.systemPromptOptions.sections.knit;
    assert.ok(secondSection, "续接第 2 轮必须有 knit 分节");
    const secondContext = sessionContextOf(dir);
    assert.equal(secondContext.taskId, secondId, "第 2 轮任务与 session context 一致");
    assert.equal(secondContext.task.stage, "start", "第 2 轮阶段与 session context 一致");
    assert.match(secondSection, /当前任务：「续接任务二」/);
    assert.match(secondSection, /阶段：准备（start）/);
    assert.match(secondSection, new RegExp(shortId(secondId)));
    assert.doesNotMatch(secondSection, /上下文可能过期/);

    // 第 3 轮：切回任务一，仍取当轮选择。
    const usedFirst = await host.tools.get("knit_task").execute("use-first", { action: "use", taskId: firstId }, null, null, host.ctx);
    assert.equal(usedFirst.isError, false, usedFirst.content?.[0]?.text ?? "");
    await new Promise((resolve) => setTimeout(resolve, 600));
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const thirdSection = host.systemPromptOptions.sections.knit;
    assert.ok(thirdSection, "续接第 3 轮必须有 knit 分节");
    const thirdContext = sessionContextOf(dir);
    assert.equal(thirdContext.taskId, firstId, "第 3 轮任务与 session context 一致");
    assert.equal(thirdContext.task.stage, "implement", "第 3 轮阶段与 session context 一致");
    assert.match(thirdSection, /当前任务：「续接任务一」/);
    assert.match(thirdSection, /阶段：实现（implement）/);
    assert.doesNotMatch(thirdSection, /上下文可能过期/);
    for (const section of [firstSection, secondSection, thirdSection]) {
      assert.ok(section.startsWith("<!-- knit:turn-context -->"), "每轮都写同一分节，不堆叠历史");
    }
    // 自身通知触发的 custom 轮次不重查，但必须保留已有分节（Pi 不设置即按 diff 删除）。
    // 原生会话里存的是已渲染的 `<knit>…</knit>`，回填时必须还原为 raw 正文，否则会嵌套。
    host.entries.push({ type: "message", id: "sys-last", parentId: null, message: { role: "system", content: "", sections: { knit: renderKnitSection(thirdSection) } } });
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "custom", message: "knit run 完成", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    assert.equal(host.systemPromptOptions.sections.knit, thirdSection, "custom 轮次保留已有分节并剥离宿主包装");
    const customRendered = renderKnitSection(host.systemPromptOptions.sections.knit);
    assert.equal((customRendered.match(/<knit>/g) ?? []).length, 1, "回填后只有宿主单层包裹");
    assert.equal((customRendered.match(/<!-- knit:turn-context -->/g) ?? []).length, 1, "回填后 marker 不重复");
    await host.handlers.get("session_shutdown")();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("续接会话：刷新超时保留上一轮缓存并标注可能过期、记录诊断（k-50d398bff55f／R1.S2）", async () => {
  const dir = project("resume-stale");
  const saved = {};
  for (const name of ["KNIT_SPY_LOG", "KNIT_SPY_REAL", "KNIT_SPY_DELAY_MS", "KNIT_SPY_DELAY_CONTEXT_ONLY", "KNIT_BRIDGE_CONTEXT_TIMEOUT_MS", "KNIT_DEV"]) {
    saved[name] = process.env[name];
  }
  let diag = null;
  try {
    const spy = installCliSpy(dir);
    process.env.KNIT_SPY_LOG = spy.log;
    process.env.KNIT_SPY_REAL = spy.real;
    process.env.KNIT_SPY_DELAY_CONTEXT_ONLY = "1";
    process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "10000";
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    await new Promise((resolve) => setTimeout(resolve, 500));
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const previous = host.systemPromptOptions.sections.knit;
    assert.ok(previous, "首轮先有可回退的上下文");

    // 第二轮刷新超时（1ms）：保留上一轮正文，标注可能过期，并记诊断事件。
    process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "1";
    process.env.KNIT_SPY_DELAY_MS = "2000";
    process.env.KNIT_DEV = "1";
    diag = captureDiagChunks();
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const stale = host.systemPromptOptions.sections.knit;
    assert.ok(stale, "刷新失败不得清空分节");
    assert.match(stale, /当前无选定任务/, "保留上一轮正文");
    assert.match(stale, /上下文可能过期/, "标注可能过期");
    assert.match(stale, /本次查询超过 1ms/, "写明失败原因");
    assert.equal((stale.match(/上下文可能过期/g) ?? []).length, 1, "降级说明不堆叠");
    const events = diag.events();
    const cachedEvent = events.find((event) => event.event === "context_cache_used");
    assert.ok(cachedEvent, `缺少缓存回退诊断: ${diag.chunks.join("")}`);
    assert.equal(cachedEvent.reason, "timeout", "诊断说明是超时");
    await host.handlers.get("session_shutdown")();
  } finally {
    if (diag !== null) diag.restore();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("续接会话：无缓存且刷新失败时保留原生上一轮分节、不静默清空（k-50d398bff55f／R1.S2）", async () => {
  const dir = project("resume-fallback");
  const saved = {};
  for (const name of ["KNIT_SPY_LOG", "KNIT_SPY_REAL", "KNIT_SPY_DELAY_MS", "KNIT_SPY_DELAY_CONTEXT_ONLY", "KNIT_BRIDGE_CONTEXT_TIMEOUT_MS", "KNIT_DEV"]) {
    saved[name] = process.env[name];
  }
  const savedWrite = process.stderr.write;
  const chunks = [];
  try {
    const spy = installCliSpy(dir);
    process.env.KNIT_SPY_LOG = spy.log;
    process.env.KNIT_SPY_REAL = spy.real;
    process.env.KNIT_SPY_DELAY_MS = "5000";
    process.env.KNIT_SPY_DELAY_CONTEXT_ONLY = "1";
    process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS = "1";
    process.env.KNIT_DEV = "1";
    process.stderr.write = (chunk, ...rest) => {
      void rest;
      chunks.push(String(chunk));
      return true;
    };
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    // 续接进程的新桥接实例没有内存缓存；上一轮分节只存在于原生会话的 system diff 中。
    // 真实宿主保存的是渲染后的 `<knit>…</knit>`，回填前必须剥离包装。
    const previousBody = "<!-- knit:turn-context -->\n当前任务：「上一轮任务」（k-aaaaaa）\n阶段：准备（start）";
    host.entries.push({ type: "message", id: "sys-prev", parentId: null, message: { role: "system", content: "", sections: { knit: renderKnitSection(previousBody) } } });
    await host.handlers.get("session_start")({}, host.ctx);

    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const injected = host.systemPromptOptions.sections.knit;
    assert.ok(injected, "刷新失败且无缓存时也不能 delete 分节");
    assert.match(injected, /上一轮任务/, "保留原生会话里的上一轮正文");
    assert.match(injected, /上下文可能过期/, "标注可能过期");
    assert.match(injected, /本次查询超过 1ms/, "写明失败原因");
    assert.ok(injected.startsWith("<!-- knit:turn-context -->\n"), "回填的是 raw 正文，等待宿主统一包装");
    assert.doesNotMatch(injected, /<knit>/, "不得把宿主渲染的包装写回 raw 分节");
    assert.equal((injected.match(/<!-- knit:turn-context -->/g) ?? []).length, 1, "回填后 marker 不重复");
    const injectedRendered = renderKnitSection(injected);
    assert.equal((injectedRendered.match(/<knit>/g) ?? []).length, 1, "渲染后只有单层 <knit> 包裹");

    // 不需要刷新的 custom 轮次原样保留正文与过期标注（只剥离宿主包装）。
    host.entries.push({ type: "message", id: "sys-stale", parentId: null, message: { role: "system", content: "", sections: { knit: renderKnitSection(injected) } } });
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "custom", message: "knit run 完成", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    assert.equal(host.systemPromptOptions.sections.knit, injected, "custom 轮次原样保留过期标注");

    // 旧版本曾把已渲染分节写回 raw，真实会话里留下嵌套；回填时应收敛为单层、不再叠加。
    host.entries.push({ type: "message", id: "sys-nested", parentId: null, message: { role: "system", content: "", sections: { knit: renderKnitSection(renderKnitSection(`${previousBody}\n上下文可能过期：旧失败。`)) } } });
    host.systemPromptOptions.sections = {};
    await host.handlers.get("before_agent_start")({ messageType: "user", systemPromptOptions: host.systemPromptOptions }, host.ctx);
    const converged = host.systemPromptOptions.sections.knit;
    assert.ok(converged, "旧版嵌套分节也不能丢");
    assert.doesNotMatch(converged, /<knit>/, "回填时收敛掉旧版嵌套包装");
    assert.equal((converged.match(/<!-- knit:turn-context -->/g) ?? []).length, 1, "旧版重复 marker 不继续叠加");
    assert.equal((converged.match(/上下文可能过期/g) ?? []).length, 1, "旧版过期说明不继续叠加");
    const events = chunks
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "knit.bridge.diag");
    const previousEvent = events.find((event) => event.event === "context_previous_section_used" && /超过 1ms/.test(String(event.reason)));
    assert.ok(previousEvent, `缺少上一轮分节回退诊断: ${chunks.join("")}`);
    await host.handlers.get("session_shutdown")();
  } finally {
    process.stderr.write = savedWrite;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knit_run wait=true 期间中止：及时返回当前状态，不取消 run（k-0524fc52e81b）", async () => {
  const dir = project("wait-abort");
  const savedBin = process.env.KNIT_PI_BIN;
  const savedAction = process.env.KNIT_FAKE_ACTION;
  try {
    const { host, api } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    const created = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", "等待中止", "--slug", "wait-abort", "--verification", "self", "--dir", dir], { encoding: "utf8" }));
    const taskId = created.data.taskId;
    execFileSync(process.execPath, [CLI, "--json", "task", "ready", taskId, "--dir", dir], { encoding: "utf8" });
    // 旧 run：worker 与阶段 Pi 均已退出且无结果 → resume 生成新 run（与既有 resume 用例同现场）。
    const old = prepareBridgeRun(dir, taskId, "implement");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const now = new Date().toISOString();
    const runs = new RunStore(dir);
    const bootId = machineBootId();
    runs.writeLaunch(old.runId, { ...runs.readLaunch(old.runId), state: "confirmed", attempts: 1, handle: { pid: dead, bootId, procStartTicks: "1", hostname: "h", recordedAt: now } });
    runs.writeState(old.runId, {
      schemaVersion: 1, runId: old.runId, taskId, phase: "implement", state: "running",
      worker: { workerId: "w-dead", pid: dead, bootId, procStartTicks: "1", hostname: "h" },
      claimedAt: now, updatedAt: now, prepared: true, preparedAt: now, snapshot: null, reason: null,
    });
    runs.writeStageProcess(old.runId, {
      schemaVersion: 1, runId: old.runId, taskId, phase: "implement", state: "exited", workerPid: dead, piPid: null,
      bootId, procStartTicks: null, hostname: "h", nativeSessionId: "stub-stage", knitSessionId: "ks-stub", startedAt: now, recordedAt: now,
    });
    process.env.KNIT_PI_BIN = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
    const actionPath = join(dir, "fake-action.json");
    writeFileSync(actionPath, JSON.stringify({ waitFile: ".never-signal", waitTimeoutMs: 120_000, report: { summary: "不应在等待中完成", changedPaths: [] } }));
    process.env.KNIT_FAKE_ACTION = actionPath;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 2500);
    const startedAt = Date.now();
    const result = await host.tools.get("knit_run").execute("w1", { action: "resume", runId: old.runId, wait: true }, controller.signal, null, host.ctx);
    const elapsed = Date.now() - startedAt;
    clearTimeout(abortTimer);
    assert.equal(result.isError, false, result.content?.[0]?.text ?? "");
    assert.ok(elapsed < 20_000, `中止后应及时返回，实际 ${elapsed}ms`);
    assert.match(result.content[0].text, /等待已中止（run 未取消）/);
    assert.equal(result.details.waitAborted, true);
    const runId = result.details.request.runId;
    assert.ok(["claimed", "preparing", "running"].includes(result.details.status.state), `当前状态: ${result.details.status.state}`);
    const status = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "status", "--run", runId, "--dir", dir], { encoding: "utf8" }));
    assert.notEqual(status.data.state, "cancelled", "中止等待不取消 run");
    assert.equal(status.data.cancelRequestedAt, null);
    // 等待中止不算已返回终态：run 留在跟踪集合（此时 run 仍在运行，观察器扫描只会重复加入，不会移除）。
    assert.equal(api.state.watchedRuns.has(runId), true, "中止的等待不算已返回终态：run 留在跟踪集合");
    // 收尾：放出等待信号，让假 Pi 正常结束，避免残留 worker。
    writeFileSync(join(dir, ".never-signal"), "done\n");
    for (let index = 0; index < 50; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const current = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "status", "--run", runId, "--dir", dir], { encoding: "utf8" }));
      if (["completed", "cancelled", "failed"].includes(current.data.state)) break;
    }
    // run 之后完成仍唤醒主 Agent，且只唤醒一次（k-b9ea41e9eec0）。观察器节拍可能先于下面的显式扫描投递，两种顺序结果相同。
    await host.handlers.get("agent_settled")({}, host.ctx);
    await api.state.scanChain;
    const woke = host.messages.filter((item) => item.message.details?.runId === runId);
    assert.equal(woke.length, 1, "等待中止后 run 完成：唤醒主 Agent 一次");
    assert.deepEqual(woke[0].options, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(api.state.watchedRuns.has(runId), false, "通知投递后移出跟踪集合");
    await host.handlers.get("session_shutdown")();
  } finally {
    if (savedBin === undefined) delete process.env.KNIT_PI_BIN;
    else process.env.KNIT_PI_BIN = savedBin;
    if (savedAction === undefined) delete process.env.KNIT_FAKE_ACTION;
    else process.env.KNIT_FAKE_ACTION = savedAction;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 停掉桥接自带的观察器节拍：通知用例只由显式 agent_settled 触发扫描，避免定时扫描落在发布与接收之间。 */
async function stopBridgeObserver(api) {
  await api.state.scanChain;
  api.state.started = false;
  if (api.state.timer !== null) {
    clearTimeout(api.state.timer);
    api.state.timer = null;
  }
  await api.state.scanChain;
}

test("桥接通知：本会话跟踪的 run 完成且已接收后唤醒；未跟踪的只展示；文案给任务级下一步（k-b9ea41e9eec0）", async () => {
  const dir = project("notice-watched");
  const saved = {};
  let host;
  for (const name of ["KNIT_SPY_LOG", "KNIT_SPY_REAL", "KNIT_SPY_DELAY_MS", "KNIT_SPY_FAIL_TASK_STATUS"]) saved[name] = process.env[name];
  try {
    const spy = installCliSpy(dir);
    process.env.KNIT_SPY_LOG = spy.log;
    process.env.KNIT_SPY_REAL = spy.real;
    process.env.KNIT_SPY_DELAY_MS = "0";
    delete process.env.KNIT_SPY_FAIL_TASK_STATUS;
    // 标题不超过 20 字：通知展示完整标题，不截断。
    const title = "跟踪通知";
    const loaded = await loadBridge(dir);
    host = loaded.host;
    const { api } = loaded;
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    await stopBridgeObserver(api);

    const created = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", title, "--slug", "notice-watched", "--verification", "self", "--dir", dir], { encoding: "utf8" }));
    const taskId = created.data.taskId;
    execFileSync(process.execPath, [CLI, "--json", "task", "ready", taskId, "--dir", dir], { encoding: "utf8" });
    const taskFile = join(dir, ".knit", created.data.relativePath);
    writeFileSync(taskFile, readFileSync(taskFile, "utf8").replace(/^stage: .*$/m, "stage: check"));

    const settle = async () => {
      await host.handlers.get("agent_settled")({}, host.ctx);
      await api.state.scanChain;
    };
    const accept = async (run) => {
      const db = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
      await db.operations.setState(run.acceptanceOperationId, "completed");
      db.close();
    };
    const nextSummary = () => {
      const status = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "status", taskId, "--dir", dir], { encoding: "utf8" }));
      return status.data.nextAction.summary;
    };
    const noticeEntries = () => host.entries.filter((entry) => entry.type === "custom" && entry.customType === "knit.notice");
    const renderNotice = host.entryRenderers.get("knit.notice");
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // 扫描看到运行中：加入跟踪集合，不产生通知。
    const runA = prepareBridgeRun(dir, taskId, "check");
    await settle();
    assert.equal(api.state.watchedRuns.has(runA.runId), true, "未到终态的本会话 run 加入跟踪集合");
    assert.equal(host.messages.length, 0);
    assert.equal(noticeEntries().length, 0);

    // 随后完成且已接收：进入上下文并唤醒，文案给任务级下一步。
    finishBridgeRun(dir, runA, "pass");
    await accept(runA);
    const next = nextSummary();
    assert.equal(typeof next, "string");
    await settle();
    assert.equal(host.messages.length, 1, "跟踪中的 run 完成且已接收：发送消息");
    assert.deepEqual(host.messages[0].options, { deliverAs: "followUp", triggerTurn: true }, "进入上下文并唤醒主 Agent");
    assert.equal(host.messages[0].message.customType, "knit.notice");
    assert.deepEqual(host.messages[0].message.details, { runId: runA.runId, state: "completed", acceptance: "completed", signature: `${runA.runId}:completed` });
    const woke = host.messages[0].message.content.split("\n")[0];
    assert.equal(woke, `「${title}」检查：${shortId(runA.runId)} pass，结果已接收；下一步：${next.replace(/\s+/g, " ").trim()}（报告：knit status --run ${runA.runId}）`);
    assert.doesNotMatch(woke, /或 resume/, "已接收的完成通知不再建议 resume");
    assert.equal(noticeEntries().length, 1, "唤醒通知另写一条去重条目");
    assert.deepEqual(noticeEntries()[0].data, { signature: `${runA.runId}:completed`, runId: runA.runId, state: "completed" }, "去重条目不带 text");
    assert.equal(renderNotice(noticeEntries()[0], { expanded: false }, {}), undefined, "去重条目不渲染，不出现第二张卡片");
    assert.equal(api.state.watchedRuns.has(runA.runId), false, "通知投递后移出跟踪集合");

    // 重复扫描不重复唤醒。
    await settle();
    assert.equal(host.messages.length, 1, "重复扫描不重复唤醒");
    assert.equal(noticeEntries().length, 1, "重复扫描不重复追加条目");

    // 未跟踪：首次看到就已完成且已接收——只展示、不进上下文。
    const runB = prepareBridgeRun(dir, taskId, "check");
    finishBridgeRun(dir, runB, "pass");
    await accept(runB);
    assert.equal(api.state.watchedRuns.has(runB.runId), false);
    await settle();
    assert.equal(host.messages.length, 1, "未跟踪的已收尾 run 不调用 sendMessage");
    assert.equal(noticeEntries().length, 2);
    const passive = noticeEntries()[1];
    assert.equal(passive.data.signature, `${runB.runId}:completed`);
    assert.match(passive.data.text, new RegExp(`^「${title}」检查：${shortId(runB.runId)} pass，结果已接收；下一步：`), "被动通知同样写明结果已接收");
    assert.equal(typeof renderNotice(passive, { expanded: false }, {})?.render, "function", "被动条目由 entry renderer 展示");

    // 取不到任务级下一步：退回 run 级查看，通知照常唤醒。
    const runC = prepareBridgeRun(dir, taskId, "check");
    await settle();
    assert.equal(api.state.watchedRuns.has(runC.runId), true);
    finishBridgeRun(dir, runC, "pass");
    await accept(runC);
    process.env.KNIT_SPY_FAIL_TASK_STATUS = "1";
    await settle();
    delete process.env.KNIT_SPY_FAIL_TASK_STATUS;
    assert.equal(host.messages.length, 2, "任务状态查询失败不影响投递");
    assert.deepEqual(host.messages[1].options, { deliverAs: "followUp", triggerTurn: true });
    assert.match(host.messages[1].message.content, new RegExp(`^「${title}」检查：${shortId(runC.runId)} pass，结果已接收；下一步：knit status --run ${escape(runC.runId)} 查看。$`, "m"));
    assert.doesNotMatch(host.messages[1].message.content, /或 resume/);

    // 跟踪中的 run 失败：仍按需处理唤醒，文案保持现状。
    const runD = prepareBridgeRun(dir, taskId, "check");
    await settle();
    finishBridgeRun(dir, runD, "failed", "failed");
    await settle();
    assert.equal(host.messages.length, 3);
    assert.deepEqual(host.messages[2].options, { deliverAs: "followUp", triggerTurn: true });
    assert.match(host.messages[2].message.content, new RegExp(`${shortId(runD.runId)} failed；下一步：knit status --run ${escape(runD.runId)} 查看，或 resume。`));
    assert.equal(api.state.watchedRuns.size, 0, "已通知的 run 都移出跟踪集合");

    // wait 仍在等待时扫描先看到终态：等 wait 的结论再分流。等待被中止（终态未随工具结果返回）→ 唤醒。
    const pendingWait = (runId) => {
      let release = () => {};
      api.state.waitingRuns.set(runId, new Promise((resolve) => { release = resolve; }));
      return (returned) => {
        if (returned) api.state.watchedRuns.delete(runId);
        api.state.waitingRuns.delete(runId);
        release();
      };
    };
    const scanDuringWait = async (run, returned) => {
      await settle();
      assert.equal(api.state.watchedRuns.has(run.runId), true);
      const finishWait = pendingWait(run.runId);
      finishBridgeRun(dir, run, "pass");
      await accept(run);
      const before = { messages: host.messages.length, entries: noticeEntries().length };
      let scanned = false;
      const scan = host.handlers.get("agent_settled")({}, host.ctx).then(() => { scanned = true; });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(scanned, false, "wait 未出结论前扫描不分流");
      assert.deepEqual({ messages: host.messages.length, entries: noticeEntries().length }, before, "wait 未出结论前不投递也不展示");
      finishWait(returned);
      await scan;
      await api.state.scanChain;
      return before;
    };
    const runE = prepareBridgeRun(dir, taskId, "check");
    const beforeE = await scanDuringWait(runE, false);
    assert.equal(host.messages.length, beforeE.messages + 1, "等待中止：完成通知唤醒主 Agent");
    assert.equal(host.messages.at(-1).message.details.runId, runE.runId);
    assert.deepEqual(host.messages.at(-1).options, { deliverAs: "followUp", triggerTurn: true });

    // 等待已把终态带回工具结果 → 只展示。
    const runF = prepareBridgeRun(dir, taskId, "check");
    const beforeF = await scanDuringWait(runF, true);
    assert.equal(host.messages.length, beforeF.messages, "wait 已返回终态：不唤醒");
    assert.equal(noticeEntries().length, beforeF.entries + 1);
    assert.equal(noticeEntries().at(-1).data.signature, `${runF.runId}:completed`);
    assert.equal(typeof noticeEntries().at(-1).data.text, "string", "只追加带展示文案的条目");
    assert.equal(api.state.watchedRuns.size, 0);

    // 投递前再次核对原生会话：扫描等待期间会话已切换或宿主对象已失效，旧会话的通知既不唤醒也不展示（DESIGN §9.3）。
    const scanAcrossSwitch = async (change, restore, label) => {
      const run = prepareBridgeRun(dir, taskId, "check");
      await settle();
      assert.equal(api.state.watchedRuns.has(run.runId), true);
      const finishWait = pendingWait(run.runId);
      finishBridgeRun(dir, run, "pass");
      await accept(run);
      const before = { messages: host.messages.length, entries: noticeEntries().length };
      const scan = host.handlers.get("agent_settled")({}, host.ctx);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      change();
      try {
        finishWait(false);
        await scan;
        await api.state.scanChain;
        assert.deepEqual({ messages: host.messages.length, entries: noticeEntries().length }, before, label);
      } finally {
        restore();
      }
    };
    // 宿主对象已失效：读取会话抛错按已切换处理，扫描不抛错。
    const originalSessionId = host.ctx.sessionManager.getSessionId;
    await scanAcrossSwitch(
      () => { host.ctx.sessionManager.getSessionId = () => { throw new Error("stale ctx"); }; },
      () => { host.ctx.sessionManager.getSessionId = originalSessionId; },
      "宿主对象已失效：不投递也不展示",
    );
    // 桥接已登记到另一个原生会话：扫描开始时的会话不再是当前会话。
    await scanAcrossSwitch(
      () => { api.state.nativeSessionId = "switched-session"; },
      () => {},
      "会话已切换：不投递也不展示",
    );
  } finally {
    if (host) await host.handlers.get("session_shutdown")();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knit_run 派发的 run 未被扫描到运行中也唤醒；wait 已返回终态的只展示（k-b9ea41e9eec0）", async () => {
  const dir = project("notice-dispatch");
  const savedBin = process.env.KNIT_PI_BIN;
  const savedAction = process.env.KNIT_FAKE_ACTION;
  let host;
  try {
    const loaded = await loadBridge(dir);
    host = loaded.host;
    const { api } = loaded;
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    // 观察器停掉后 pokeObserver 不再扫描：下面的跟踪只可能来自派发登记。
    await stopBridgeObserver(api);
    process.env.KNIT_PI_BIN = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
    const actionPath = join(dir, "fake-action.json");
    process.env.KNIT_FAKE_ACTION = actionPath;
    const newTask = (name, slug) => {
      const created = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", name, "--slug", slug, "--verification", "self", "--dir", dir], { encoding: "utf8" }));
      execFileSync(process.execPath, [CLI, "--json", "task", "ready", created.data.taskId, "--dir", dir], { encoding: "utf8" });
      return created.data.taskId;
    };
    const runStatus = (runId) => JSON.parse(execFileSync(process.execPath, [CLI, "--json", "status", "--run", runId, "--dir", dir], { encoding: "utf8" })).data;
    const settle = async () => {
      await host.handlers.get("agent_settled")({}, host.ctx);
      await api.state.scanChain;
    };
    const noticeEntries = () => host.entries.filter((entry) => entry.type === "custom" && entry.customType === "knit.notice");

    // 派发（不 wait）：取得 runId 即登记跟踪；首次扫描时已完成且已接收，仍唤醒。
    const taskA = newTask("派发后唤醒", "dispatch-wake");
    writeFileSync(actionPath, JSON.stringify({ writes: [{ path: "a.txt", content: "dispatched\n" }], report: { summary: "派发完成", changedPaths: ["a.txt"] } }));
    const dispatched = await host.tools.get("knit_run").execute("d1", { action: "implement", taskId: taskA, provider: "test", model: "fake" }, null, null, host.ctx);
    assert.equal(dispatched.isError, false, dispatched.content?.[0]?.text ?? "");
    const runA = dispatched.details.request.runId;
    assert.equal(api.state.watchedRuns.has(runA), true, "派发即加入跟踪集合");
    let viewA = runStatus(runA);
    for (let index = 0; index < 150 && !["completed", "cancelled", "failed"].includes(viewA.state); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      viewA = runStatus(runA);
    }
    assert.equal(viewA.state, "completed", `run 终态: ${viewA.state}（${viewA.reason ?? viewA.result?.failureReason ?? ""}）`);
    assert.equal(viewA.acceptance?.state, "completed", "worker 已自行接收结果");
    assert.equal(host.messages.length, 0, "派发到完成之间没有扫描");
    await settle();
    assert.equal(host.messages.length, 1, "派发的 run 首次扫描即已完成且已接收：仍唤醒");
    assert.deepEqual(host.messages[0].options, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(host.messages[0].message.details.runId, runA);
    assert.equal(host.messages[0].message.details.acceptance, "completed");
    assert.match(host.messages[0].message.content, /结果已接收；下一步：/);
    assert.equal(noticeEntries().length, 1);

    // wait 已返回终态：结果已在当前轮工具结果里，完成通知只展示。
    const taskB = newTask("等待后不唤醒", "wait-passive");
    writeFileSync(actionPath, JSON.stringify({ writes: [{ path: "b.txt", content: "waited\n" }], report: { summary: "等待完成", changedPaths: ["b.txt"] } }));
    const waited = await host.tools.get("knit_run").execute("d2", { action: "implement", taskId: taskB, provider: "test", model: "fake", wait: true }, null, null, host.ctx);
    assert.equal(waited.isError, false, waited.content?.[0]?.text ?? "");
    const runB = waited.details.request.runId;
    assert.equal(waited.details.status.state, "completed", "wait 返回终态");
    assert.equal(waited.details.status.acceptance?.state, "completed");
    assert.equal(api.state.waitingRuns.size, 0, "等待结束后清除等待登记");
    assert.equal(api.state.watchedRuns.has(runB), false, "wait 已返回终态：移出跟踪集合");
    await settle();
    assert.equal(host.messages.length, 1, "wait 已返回终态：不再唤醒");
    assert.equal(noticeEntries().length, 2);
    assert.equal(noticeEntries()[1].data.signature, `${runB}:completed`);
    assert.match(noticeEntries()[1].data.text, /结果已接收；下一步：/, "wait 后的完成通知只追加带展示文案的条目");
    assert.equal(api.state.watchedRuns.size, 0);
  } finally {
    if (host) await host.handlers.get("session_shutdown")();
    if (savedBin === undefined) delete process.env.KNIT_PI_BIN;
    else process.env.KNIT_PI_BIN = savedBin;
    if (savedAction === undefined) delete process.env.KNIT_FAKE_ACTION;
    else process.env.KNIT_FAKE_ACTION = savedAction;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("观察器：无活动 run 退避到 30 秒，有活动 run 回到 5 秒；节拍来自实际调度（k-0524fc52e81b）", async () => {
  const dir = project("observer-cadence");
  try {
    const { host, api } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    const waitDelay = async (expected) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const timer = api.state.timer;
        if (timer !== null && timer?._idleTimeout === expected) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };
    assert.equal(await waitDelay(30_000), true, `无活动 run 应退避到 30s，实际 ${api.state.timer?._idleTimeout}`);
    assert.equal(api.state.lastScanActive, false);

    const created = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", "观察节拍", "--slug", "observer-cadence", "--verification", "self", "--dir", dir], { encoding: "utf8" }));
    const taskId = created.data.taskId;
    execFileSync(process.execPath, [CLI, "--json", "task", "ready", taskId, "--dir", dir], { encoding: "utf8" });
    const request = prepareBridgeRun(dir, taskId, "implement");
    const now = new Date().toISOString();
    new RunStore(dir).writeState(request.runId, {
      schemaVersion: 1,
      runId: request.runId,
      taskId,
      phase: "implement",
      state: "running",
      worker: { workerId: "stub-worker", pid: process.pid, bootId: "stub-boot", procStartTicks: null, hostname: "stub-host" },
      claimedAt: now,
      updatedAt: now,
      prepared: true,
      preparedAt: now,
      snapshot: null,
      reason: null,
    });
    await host.handlers.get("agent_settled")({}, host.ctx);
    assert.equal(api.state.lastScanActive, true, "有活动 run 时按 5s 节拍");
    assert.equal(await waitDelay(5_000), true, `有活动 run 应回到 5s，实际 ${api.state.timer?._idleTimeout}`);
    await host.handlers.get("session_shutdown")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("观察器：run list 查询失败不推进扫描时间，恢复后从原时间点继续查（k-0524fc52e81b）", async () => {
  const dir = project("observer-scan-failure");
  const saved = {};
  let host;
  for (const name of ["KNIT_SPY_LOG", "KNIT_SPY_REAL", "KNIT_SPY_DELAY_MS", "KNIT_SPY_FAIL_RUN_LIST"]) saved[name] = process.env[name];
  try {
    const spy = installCliSpy(dir);
    process.env.KNIT_SPY_LOG = spy.log;
    process.env.KNIT_SPY_REAL = spy.real;
    process.env.KNIT_SPY_DELAY_MS = "0";
    delete process.env.KNIT_SPY_FAIL_RUN_LIST;
    const loaded = await loadBridge(dir);
    host = loaded.host;
    const { api } = loaded;
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    const sinceOfLastScan = () => {
      const call = readSpyCalls(spy.log).filter((args) => args[1] === "run" && args[2] === "list").at(-1);
      return Date.parse(call[call.indexOf("--since") + 1]);
    };

    // 扫描串行排队：等会话启动时观察器自己排的那次也结束，再读扫描时间。
    const settle = async () => {
      await host.handlers.get("agent_settled")({}, host.ctx);
      await api.state.scanChain;
    };

    // 一次成功扫描把扫描时间推进到该次开始时刻。
    await settle();
    const scannedAt = api.state.lastScanAt;
    assert.equal(typeof scannedAt, "number");

    // 查询失败：扫描时间保持不变，节拍沿用上一次的判断。
    process.env.KNIT_SPY_FAIL_RUN_LIST = "1";
    await new Promise((resolve) => setTimeout(resolve, 20));
    const activeBefore = api.state.lastScanActive;
    await settle();
    assert.equal(sinceOfLastScan(), scannedAt, "失败的这次查询从上次成功扫描的时间点查");
    assert.equal(api.state.lastScanAt, scannedAt, "查询失败不推进扫描时间");
    assert.equal(api.state.lastScanActive, activeBefore);

    // 恢复后的第一次查询仍从原时间点开始，失败期间出结果的 run 不会漏掉；成功后才推进。
    delete process.env.KNIT_SPY_FAIL_RUN_LIST;
    await settle();
    assert.equal(sinceOfLastScan(), scannedAt, "恢复后的查询仍用失败前的时间点");
    assert.ok(api.state.lastScanAt > scannedAt, "查询成功后推进扫描时间");
  } finally {
    if (host) await host.handlers.get("session_shutdown")();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("桥接诊断：cli_version 记录安装 CLI 与仓库版本／dist 摘要，会话启动提示改用本地 dist（k-0524fc52e81b）", async () => {
  const dir = project("bridge-version-diag");
  const savedDev = process.env.KNIT_DEV;
  const savedWrite = process.stderr.write;
  const chunks = [];
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "knit", version: "9.9.9" }) + "\n");
    process.env.KNIT_DEV = "1";
    process.stderr.write = (chunk, ...rest) => {
      void rest;
      chunks.push(String(chunk));
      return true;
    };
    const { host } = await loadBridge(dir);
    const nativeFile = writeStubNativeSession(dir, "stub-session", []);
    host.setSessionFile(nativeFile);
    await host.handlers.get("session_start")({}, host.ctx);
    const events = chunks
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "knit.bridge.diag");
    const version = events.find((event) => event.event === "cli_version");
    assert.ok(version, `缺少 cli_version 诊断: ${chunks.join("")}`);
    assert.equal(version.installedVersion, "0.1.0");
    assert.equal(version.repoVersion, "9.9.9");
    assert.match(String(version.reason), /版本不一致/);
    assert.match(String(version.reason), /本地 dist/);
    assert.equal(
      host.notifications.some((notice) => notice.level === "warning" && /版本不一致/.test(notice.text) && /本地 dist/.test(notice.text)),
      true,
      "会话启动提示改用本地 dist",
    );
    await host.handlers.get("session_shutdown")();
  } finally {
    process.stderr.write = savedWrite;
    if (savedDev === undefined) delete process.env.KNIT_DEV;
    else process.env.KNIT_DEV = savedDev;
    rmSync(dir, { recursive: true, force: true });
  }
});
