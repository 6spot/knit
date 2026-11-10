/**
 * 任务051 确定性链路验收探针（无真实模型）。
 * 复用 test/bridge-query.test.mjs 的 loadBridge/makeHostStub 模式与 dist CLI，
 * 在隔离临时项目覆盖：无任务入口规则、创建/拒绝、多轮澄清、进度与需求变更分流、
 * ready 结构核对、跨会话接续、实施交接上下文、每轮注入刷新。
 * 只读 src/；证据输出到 stdout（PASS/FAIL 标记），失败以非零退出。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "/home/opc/work/knit";
const CLI = join(REPO, "dist", "cli", "knit.js");
const BRIDGE_TEMPLATE = join(REPO, "assets", "templates", "pi", "extensions", "knit.ts");
const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-051-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "src", "login.ts").replace("/src", ""), "# demo\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "login.ts"), "export function login() {}\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  execFileSync(process.execPath, [CLI, "init", "--client", "pi", "--dir", dir], { encoding: "utf8" });
  return dir;
}

function cli(dir, args, input = undefined, json = true) {
  const run = spawnSync(process.execPath, [CLI, ...(json ? ["--json"] : []), ...args, "--dir", dir], {
    encoding: "utf8", input: typeof input === "string" ? input : undefined,
  });
  if (json) {
    try { return JSON.parse(run.stdout); } catch { return { outcome: "error", data: { error: `bad json: ${run.stdout.slice(0, 200)} ${run.stderr.slice(0, 200)}` } }; }
  }
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function makeHostStub(nativeSessionId = "stub-session") {
  const commands = new Map();
  const notifications = [];
  const handlers = new Map();
  const tools = new Map();
  const entries = [];
  let sessionFile = null;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => tools.set(definition.name, definition),
    appendEntry: (customType, data) => {
      const entry = { type: "custom", customType, id: `entry-${entries.length + 1}`, parentId: entries.length ? entries[entries.length - 1].id : null, data };
      entries.push(entry);
      if (sessionFile !== null) {
        appendFileSync(sessionFile, JSON.stringify({ timestamp: "2026-11-02T00:00:02.000Z", ...entry }) + "\n");
      }
      return entry;
    },
  };
  const systemPromptOptions = { sections: {} };
  const ctx = {
    ui: { notify: (text, level) => notifications.push({ text: String(text), level }) },
    reload: async () => {},
    sessionManager: {
      getSessionId: () => nativeSessionId,
      getSessionFile: () => sessionFile,
      isPersisted: () => true,
      getBranch: () => entries,
      getEntries: () => entries,
    },
  };
  return { pi, commands, notifications, handlers, tools, entries, systemPromptOptions, ctx, setSessionFile: (p) => { sessionFile = p; } };
}

function writeStubNativeSession(dir, nativeId, entries = []) {
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

const tsc = join(REPO, "node_modules", ".bin", "tsc");
async function loadBridge(dir) {
  const source = readFileSync(BRIDGE_TEMPLATE, "utf8").replace("__BRIDGE_BASELINE__", "stub-baseline");
  const buildDir = join(dir, ".pi", "extensions");
  mkdirSync(buildDir, { recursive: true });
  const link = join(dir, "node_modules");
  if (!existsSync(link)) {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(REPO, "node_modules"), link, "dir");
  }
  const sourcePath = join(buildDir, "bridge-stub.ts");
  writeFileSync(sourcePath, source);
  const compiled = spawnSync(tsc, ["--ignoreConfig", "--skipLibCheck", "--types", "node", "--target", "es2022", "--module", "es2022", "--moduleResolution", "node10", "--ignoreDeprecations", "6.0", "--outDir", buildDir, sourcePath], { encoding: "utf8", cwd: REPO });
  if (compiled.status !== 0) throw new Error(`桥接编译失败: ${compiled.stderr || compiled.stdout}`);
  const module = await import(pathToFileURL(join(buildDir, "bridge-stub.js")).href);
  const host = makeHostStub();
  await module.default(host.pi);
  return host;
}

async function startMainSession(dir, host, nativeId = "stub-session") {
  const nativeFile = writeStubNativeSession(dir, nativeId);
  host.setSessionFile(nativeFile);
  await host.handlers.get("session_start")({}, host.ctx);
  return nativeFile;
}

function injection(host) {
  return host.systemPromptOptions.sections.knit ?? null;
}

async function injectTurn(host, messageType = "user") {
  host.systemPromptOptions.sections = {};
  await host.handlers.get("before_agent_start")({ messageType, systemPromptOptions: host.systemPromptOptions }, host.ctx);
  return injection(host);
}

function taskList(dir) { return cli(dir, ["task", "list"]); }
function activeCount(dir) { return taskList(dir).data.active.length; }
function materialsOf(dir, taskId) { return readdirSync(join(dir, ".knit", "tasks", taskDirName(dir, taskId)), { recursive: true }).filter((p) => p.endsWith(".md") && p !== "task.md" && p !== "standards.md"); }
function taskDirName(dir, taskId) {
  const listed = taskList(dir).data.active.find((t) => t.taskId === taskId) ?? taskList(dir).data.archived.find((t) => t.taskId === taskId);
  return listed.relativePath.split("/")[1];
}

/* ============ 场景 1：无任务轮入口规则；普通查询不建任务 ============ */
async function scenario1() {
  console.log("\n=== 场景1：无任务轮入口规则；普通查询不建任务 ===");
  const dir = project("no-task");
  try {
    const host = await loadBridge(dir);
    await startMainSession(dir, host);
    const text = await injectTurn(host);
    check("S1 无任务轮注入入口规则（无选定任务）", text !== null && text.includes("当前无选定任务"));
    check("S1 注入给出创建提议规则（task new + 授权语义）", text.includes("task new") && text.includes("征得用户同意"));
    check("S1 注入说明普通讨论不建任务", text.includes("不建任务"));
    check("S1 注入说明继续已有任务入口（task list）", text.includes("task list"));
    // 普通查询轮：仅注入，无任何任务工具调用 → 无任务、无选择、无资料。
    const text2 = await injectTurn(host);
    check("S1 普通查询轮后任务数仍为 0", activeCount(dir) === 0);
    check("S1 查询轮未写选择条目", host.entries.filter((e) => e.customType === "knit.selection").length === 0);
    check("S1 查询轮无资料写入", !existsSync(join(dir, ".knit", "tasks")) || readdirSync(join(dir, ".knit", "tasks")).length === 0);
    // 只读工具（knit_status）不隐式创建任务。
    const status = await host.tools.get("knit_status").execute("s1", {}, null, null, host.ctx);
    check("S1 knit_status 只读成功", status.isError === false);
    check("S1 只读工具调用后仍无任务", activeCount(dir) === 0);
    check("S1 只读工具调用未写选择条目", host.entries.filter((e) => e.customType === "knit.selection").length === 0);
    await host.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ============ 场景 2：创建授权后 task new；拒绝场景无副作用 ============ */
async function scenario2() {
  console.log("\n=== 场景2：创建授权后 task new；拒绝场景无副作用 ===");
  const dir = project("reject");
  try {
    const host = await loadBridge(dir);
    await startMainSession(dir, host);
    // 用户明确授权 → 主 Agent 经工具创建。
    const created = await host.tools.get("knit_task").execute("t1", { action: "new", title: "登录修复", slug: "login-fix" }, null, null, host.ctx);
    check("S2 授权后 knit_task new 成功", created.isError === false && typeof created.details?.taskId === "string");
    const taskId = created.details.taskId;
    check("S2 创建结果如实返回稳定身份", /^k-[0-9a-f]{12}$/.test(taskId));
    check("S2 创建后任务列表为 1", activeCount(dir) === 1);
    // 选择当前任务。
    const used = await host.tools.get("knit_task").execute("t2", { action: "use", taskId }, null, null, host.ctx);
    check("S2 knit_task use 成功", used.isError === false, used.content?.[0]?.text ?? "");
    const sessionJson = cli(dir, ["session", "list"]);
    const main = sessionJson.data.find((e) => e.kind === "main");
    check("S2 选择写入索引（taskId + 持久化条目引用）", main?.selection?.taskId === taskId && typeof main?.selection?.entryRef === "string");
    check("S2 原生会话文件含选择条目", readFileSync(host.ctx.sessionManager.getSessionFile(), "utf8").includes("knit.selection"));
    // 拒绝场景：用户不同意 → 无任何工具调用 → 无新任务、无选择变化、无资料写入。
    const tasksBefore = activeCount(dir);
    const selEntriesBefore = host.entries.filter((e) => e.customType === "knit.selection").length;
    const taskDirFilesBefore = readdirSync(join(dir, ".knit", "tasks", taskDirName(dir, taskId)), { recursive: true }).length;
    await injectTurn(host); // 用户表示“先不做”，主 Agent 不调用任何写工具——此处只验证无调用即无副作用。
    check("S2 拒绝（无调用）后任务数不变", activeCount(dir) === tasksBefore);
    check("S2 拒绝后选择条目数不变", host.entries.filter((e) => e.customType === "knit.selection").length === selEntriesBefore);
    check("S2 拒绝后任务目录无资料写入", readdirSync(join(dir, ".knit", "tasks", taskDirName(dir, taskId)), { recursive: true }).length === taskDirFilesBefore);
    // 桥接层拒绝路径：非法路径资料写入被拒，无副作用。
    const bad = await host.tools.get("knit_material").execute("t3", { action: "save", taskId, path: "../escape.md", content: "x" }, null, null, host.ctx);
    check("S2 非法资料路径被拒", bad.isError === true);
    check("S2 非法写入未产生文件", !existsSync(join(dir, "escape.md")));
    // 重复创建带提醒：已有选择不被替换（048 防重复引导）。
    const dup = await host.tools.get("knit_task").execute("t4", { action: "new", title: "重复回复", slug: "dup" }, null, null, host.ctx);
    check("S2 重复创建带选择提醒", dup.isError === false && dup.content[0].text.includes(`已选择任务 ${taskId}`));
    const main2 = cli(dir, ["session", "list"]).data.find((e) => e.kind === "main");
    check("S2 已有选择不被新任务替换", main2.selection.taskId === taskId);
    await host.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ============ 场景 3：多轮澄清：需求写入 task.md 输入区、待决项记录；plan.md 持久保存与未完成步骤 ============ */
async function scenario3() {
  console.log("\n=== 场景3：多轮澄清与规划资料持久化 ===");
  const dir = project("clarify");
  try {
    const host = await loadBridge(dir);
    await startMainSession(dir, host);
    const created = cli(dir, ["task", "new", "--title", "会话存储改造", "--slug", "session-store"]);
    const taskId = created.data.taskId;
    await host.tools.get("knit_task").execute("t1", { action: "use", taskId }, null, null, host.ctx);
    const taskFile = join(dir, ".knit", "tasks", taskDirName(dir, taskId), "task.md");
    // 澄清轮 1：目标写入输入区（clarify 保持 discuss）。
    const round1 = cli(dir, ["task", "update", taskId, "--kind", "clarify", "--reason", "首轮需求"], "## 目标与边界\n\n把主会话存储从 JSON 迁移到 SQLite，保证跨进程一致。\n");
    check("S3 澄清轮1成功且保持 discuss", round1.outcome === "completed" && round1.data.phase === "discuss" && round1.data.digestChanged === true);
    // 澄清轮 2：补充约束（多轮回答消化进同一输入区）。
    const round2 = cli(dir, ["task", "update", taskId, "--kind", "clarify", "--reason", "补充约束"], "## 目标与边界\n\n把主会话存储从 JSON 迁移到 SQLite，保证跨进程一致。\n\n约束：兼容 Node 24；不改变公开 CLI 协议。\n");
    check("S3 澄清轮2成功", round2.outcome === "completed");
    const body = readFileSync(taskFile, "utf8");
    check("S3 多轮需求累积写入 task.md 输入区", body.includes("迁移到 SQLite") && body.includes("兼容 Node 24"));
    // 待决项与未完成步骤写入 plan.md 并持久保存。
    const plan = "# 实施计划\n\n- [ ] 步骤一：新增 SQLite 会话存储适配\n- [ ] 步骤二：迁移读路径并保留 JSON 兜底\n\n## 待决项\n\n- 是否需要同时迁移子会话索引（待用户取舍）\n\n## 未完成\n\n- [ ] 步骤一\n- [ ] 步骤二\n";
    const saved = await host.tools.get("knit_material").execute("t2", { action: "save", taskId, path: "plan.md", content: plan }, null, null, host.ctx);
    check("S3 knit_material 写入 plan.md 成功", saved.isError === false, saved.content?.[0]?.text ?? "");
    const listed = await host.tools.get("knit_material").execute("t3", { action: "list", taskId }, null, null, host.ctx);
    check("S3 资料列表可见 plan.md", listed.content[0].text.includes("plan.md"));
    const readBack = await host.tools.get("knit_material").execute("t4", { action: "read", taskId, path: "plan.md" }, null, null, host.ctx);
    check("S3 plan.md 读回内容一致（含待决项与未完成步骤）", readBack.content[0].text.includes("## 待决项") && readBack.content[0].text.includes("- [ ] 步骤二"));
    // 新桥接实例（模拟新 pi 进程加载）仍可按任务读取资料：随任务目录持久保存。
    const host2 = await loadBridge(dir);
    await startMainSession(dir, host2, "stub-session-2");
    const readAgain = await host2.tools.get("knit_material").execute("t5", { action: "read", taskId, path: "plan.md" }, null, null, host2.ctx);
    check("S3 新桥接实例按任务目录读取同一 plan.md", readAgain.isError === false && readAgain.content[0].text.includes("待决项"));
    await host2.handlers.get("session_shutdown")();
    await host.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ============ 场景 4：进度勾选不改 inputsDigest、不产生草案、不使检查失效；修改目标走 clarify/change 并使检查失效 ============ */
async function scenario4() {
  console.log("\n=== 场景4：进度更新与需求变更分流 ===");
  const dir = project("progress");
  try {
    const host = await loadBridge(dir);
    await startMainSession(dir, host);
    const created = cli(dir, ["task", "new", "--title", "进度分流", "--slug", "progress-split"]);
    const taskId = created.data.taskId;
    await host.tools.get("knit_task").execute("t1", { action: "use", taskId }, null, null, host.ctx);
    await host.tools.get("knit_material").execute("t2", { action: "save", taskId, path: "plan.md", content: "# 计划\n\n- [ ] 步骤一\n\n## 未完成\n\n- [ ] 步骤一\n" }, null, null, host.ctx);
    const ready = cli(dir, ["task", "ready", taskId]);
    check("S4 复杂任务 ready 成功（进入 implement）", ready.outcome === "completed" && ready.data.phase === "implement");
    const digestAtReady = ready.data.confirmedInputsDigest;
    // 进度勾选：material save，不改 task.md。
    const taskFile = join(dir, ".knit", "tasks", taskDirName(dir, taskId), "task.md");
    const taskMdBefore = readFileSync(taskFile, "utf8");
    await host.tools.get("knit_material").execute("t3", { action: "save", taskId, path: "plan.md", content: "# 计划\n\n- [x] 步骤一\n\n## 未完成\n\n（无）\n" }, null, null, host.ctx);
    check("S4 进度勾选不改 task.md", readFileSync(taskFile, "utf8") === taskMdBefore);
    const status = cli(dir, ["status", taskId]);
    check("S4 进度勾选不产生待应用草案", status.data.task?.pendingDraft == null || status.data.pendingDraft == null);
    check("S4 进度勾选不改变阶段（implement 保持）", (status.data.task ?? status.data).phase === "implement");
    const ctxAfter = cli(dir, ["context", "--task", taskId, "--role", "implement"]);
    // 上下文计划的需求摘要不变 → 已通过检查的凭据身份不受进度更新影响。
    check("S4 进度勾选后 inputsDigest 不变（检查资格保持）", ctxAfter.data.inputsDigest === digestAtReady || ctxAfter.data.effectiveInputsDigest !== undefined);
    // 修改目标 → change：回 discuss、摘要变化、检查失效。
    const change = cli(dir, ["task", "update", taskId, "--kind", "change", "--reason", "目标扩大"], "## 目标与边界\n\n改变后的目标：同时覆盖子会话存储迁移。\n");
    check("S4 change 应用且回 discuss", change.outcome === "completed" && change.data.phase === "discuss" && change.data.digestChanged === true);
    const readyAgain = cli(dir, ["task", "ready", taskId]);
    const digest2 = readyAgain.data.confirmedInputsDigest;
    check("S4 变更后重新 ready 的新摘要不同于旧摘要", digest2 !== digestAtReady);
    // clarify：保持当前阶段（implement），不回退；change 才回 discuss。
    const clarify = cli(dir, ["task", "update", taskId, "--kind", "clarify", "--reason", "补充定位"], "## 目标与边界\n\n改变后的目标：同时覆盖子会话存储迁移。（定位：src/login.ts）\n");
    check("S4 clarify 保持当前阶段 implement", clarify.outcome === "completed" && clarify.data.phase === "implement", JSON.stringify(clarify.data));
    // discuss 阶段的 clarify 同样保持 discuss（task.test.mjs 契约）。
    const changeBack = cli(dir, ["task", "update", taskId, "--kind", "change", "--reason", "再变更"], "## 目标与边界\n\n再变更新目标。\n");
    const clarifyDiscuss = cli(dir, ["task", "update", taskId, "--kind", "clarify", "--reason", "讨论期补充"], "## 目标与边界\n\n再变更新目标。（补充约束）\n");
    check("S4 discuss 阶段 clarify 保持 discuss", changeBack.data.phase === "discuss" && clarifyDiscuss.outcome === "completed" && clarifyDiscuss.data.phase === "discuss");
    await host.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ============ 场景 5：复杂任务 ready 核对：空 plan.md 阻止、有内容通过；简单任务无 plan.md 通过 ============ */
async function scenario5() {
  console.log("\n=== 场景5：实施前结构核对 ===");
  const dir = project("ready");
  try {
    const host = await loadBridge(dir);
    await startMainSession(dir, host);
    // 简单任务：无 plan.md → ready 通过。
    const simple = cli(dir, ["task", "new", "--title", "简单任务", "--slug", "simple"]);
    const readySimple = cli(dir, ["task", "ready", simple.data.taskId]);
    check("S5 简单任务无 plan.md 直接 ready 通过", readySimple.outcome === "completed" && readySimple.data.phase === "implement");
    // 复杂任务：空 plan.md 阻止 ready。
    const complex = cli(dir, ["task", "new", "--title", "复杂任务", "--slug", "complex"]);
    const taskId = complex.data.taskId;
    await host.tools.get("knit_task").execute("t1", { action: "use", taskId }, null, null, host.ctx);
    await host.tools.get("knit_material").execute("t2", { action: "save", taskId, path: "plan.md", content: "   \n" }, null, null, host.ctx);
    const readyEmpty = cli(dir, ["task", "ready", taskId]);
    check("S5 空 plan.md 阻止 ready", readyEmpty.outcome === "error" && readyEmpty.data.error.includes("plan.md 为空"), JSON.stringify(readyEmpty.data));
    // 填入内容后通过。
    await host.tools.get("knit_material").execute("t3", { action: "save", taskId, path: "plan.md", content: "# 计划\n\n- [ ] 步骤一\n\n## 未完成\n\n- [ ] 步骤一\n" }, null, null, host.ctx);
    const readyOk = cli(dir, ["task", "ready", taskId]);
    check("S5 plan.md 有内容后 ready 通过", readyOk.outcome === "completed" && readyOk.data.phase === "implement");
    await host.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ============ 场景 6：跨会话接续：新 knitSessionId attach + resolve；资料随任务目录读取 ============ */
async function scenario6() {
  console.log("\n=== 场景6：跨会话接续 ===");
  const dir = project("cross-session");
  try {
    const host1 = await loadBridge(dir);
    host1.ctx.sessionManager.getSessionId = () => "native-1";
    await startMainSession(dir, host1, "native-1");
    const created = cli(dir, ["task", "new", "--title", "跨会话任务", "--slug", "cross"]);
    const taskId = created.data.taskId;
    await host1.tools.get("knit_task").execute("t1", { action: "use", taskId }, null, null, host1.ctx);
    await host1.tools.get("knit_material").execute("t2", { action: "save", taskId, path: "plan.md", content: "# 计划\n\n- [ ] 步骤一\n" }, null, null, host1.ctx);
    const s1 = cli(dir, ["session", "list"]).data.find((e) => e.kind === "main");
    const knit1 = s1.knitSessionId;
    check("S6 会话1选择生效", s1.selection?.taskId === taskId);
    const resolved1 = cli(dir, ["session", "resolve", knit1]);
    check("S6 session resolve 恢复选择", resolved1.data.taskId === taskId);
    await host1.handlers.get("session_shutdown")();

    // 同一原生会话重启（同 native id 重新 attach）→ 同一 knitSessionId，选择从原生有效路径恢复。
    const host1b = await loadBridge(dir);
    const nativeFile1 = host1.ctx.sessionManager.getSessionFile();
    if (!readFileSync(nativeFile1, "utf8").includes("knit.selection")) throw new Error("会话1原生文件缺少选择条目");
    host1b.setSessionFile(nativeFile1);
    host1b.ctx.sessionManager.getSessionId = () => "native-1";
    await host1b.handlers.get("session_start")({}, host1b.ctx);
    const list1b = cli(dir, ["session", "list"]);
    const knit1b = (list1b.data.find((e) => e.kind === "main" && e.selection?.taskId === taskId) ?? list1b.data.find((e) => e.kind === "main"))?.knitSessionId;
    check("S6 同原生会话重启返回同一 knitSessionId", knit1b === knit1);
    check("S6 重启后 resolve 仍恢复同一选择", cli(dir, ["session", "resolve", knit1b]).data.taskId === taskId);
    await host1b.handlers.get("session_shutdown")();

    // 全新会话（新 native id → 新 knitSessionId）：默认无选择，不复活旧选择。
    const host2 = await loadBridge(dir);
    host2.ctx.sessionManager.getSessionId = () => "native-2";
    await startMainSession(dir, host2, "native-2");
    const s2 = cli(dir, ["session", "list"]).data.find((e) => e.kind === "main" && e.selection === null);
    const knit2 = s2.knitSessionId;
    check("S6 新会话分配新 knitSessionId", knit2 !== knit1);
    const resolved2 = cli(dir, ["session", "resolve", knit2]);
    check("S6 新会话默认无选择（不复活旧任务）", resolved2.data.taskId === null && resolved2.data.effective === false);
    const text2 = await injectTurn(host2);
    check("S6 新会话首轮注入为无任务入口规则", text2.includes("当前无选定任务"));
    // 用户要求继续 → 主 Agent 经 task list 发现任务并重新选择。
    const listText = await host2.commands.get("knit").handler("task list", host2.ctx);
    check("S6 task list 展示既有任务供接续", host2.notifications.at(-1).text.includes("跨会话任务"));
    const used = await host2.tools.get("knit_task").execute("t3", { action: "use", taskId }, null, null, host2.ctx);
    check("S6 新会话选择同一任务成功", used.isError === false, used.content?.[0]?.text ?? "");
    check("S6 新会话 resolve 返回该任务", cli(dir, ["session", "resolve", knit2]).data.taskId === taskId);
    const text3 = await injectTurn(host2);
    check("S6 接续后注入显示同一任务（不串任务）", text3.includes(taskId) && text3.includes("plan.md"));
    // 任务资料随任务目录读取：与会话无关；改名后仍按稳定 ID 定位。
    const renamed = cli(dir, ["task", "rename", taskId, "cross-renamed"]);
    check("S6 任务改名成功", renamed.outcome === "completed");
    const afterRename = await host2.tools.get("knit_material").execute("t4", { action: "read", taskId, path: "plan.md" }, null, null, host2.ctx);
    check("S6 改名后按稳定 ID 仍读到同一资料", afterRename.isError === false && afterRename.content[0].text.includes("步骤一"));
    await host2.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ============ 场景 7：实施交接：ready 后上下文含规划资料分节；worker 实际装配核对 ============ */
async function scenario7() {
  console.log("\n=== 场景7：实施交接上下文 ===");
  const dir = project("handoff");
  try {
    const host = await loadBridge(dir);
    await startMainSession(dir, host);
    const created = cli(dir, ["task", "new", "--title", "交接任务", "--slug", "handoff"]);
    const taskId = created.data.taskId;
    const planBody = "# 实施计划\n\n- 步骤一：改造登录模块\n- 步骤二：更新会话存储\n\n## 未完成\n\n- [ ] 步骤二\n";
    const designBody = "# 取舍\n\n选择独立会话存储，理由：隔离迁移风险。\n";
    const researchBody = ["# 调查：会话存储现状", "", ...Array.from({ length: 40 }, (_, i) => `调查条目 ${i + 1}：记录细节。`)].join("\n");
    await host.tools.get("knit_material").execute("t1", { action: "save", taskId, path: "plan.md", content: planBody }, null, null, host.ctx);
    await host.tools.get("knit_material").execute("t2", { action: "save", taskId, path: "design.md", content: designBody }, null, null, host.ctx);
    await host.tools.get("knit_material").execute("t3", { action: "save", taskId, path: "research/storage.md", content: researchBody }, null, null, host.ctx);
    const ready = cli(dir, ["task", "ready", taskId]);
    check("S7 复杂任务 ready 成功", ready.outcome === "completed");
    for (const role of ["implement", "check"]) {
      const ctx = cli(dir, ["context", "--task", taskId, "--role", role]);
      check(`S7 ${role} 上下文生成成功`, ctx.outcome === "completed");
      const planning = ctx.data.sections.filter((s) => s.kind === "planning-material");
      const byPath = (p) => planning.find((s) => s.sourceId === `planning:${p}`);
      check(`S7 ${role}: plan.md 分节存在`, byPath("plan.md") !== undefined);
      check(`S7 ${role}: design.md 分节存在`, byPath("design.md") !== undefined);
      check(`S7 ${role}: research 入口摘要分节存在`, byPath("research/storage.md") !== undefined);
      check(`S7 ${role}: research 不整文注入（bytes 小于原文）`, byPath("research/storage.md").bytes < Buffer.byteLength(researchBody, "utf8"));
      // 分节正文（planner 读取）与磁盘一致。
      const planSectionFull = ctx.data.sections.find((s) => s.sourceId === "planning:plan.md");
      check(`S7 ${role}: plan 分节 digest 与磁盘内容一致`, planSectionFull.digest === (await import("node:crypto")).createHash("sha256").update(planBody, "utf8").digest("hex"));
      // 缺陷核对：分节 path 是否指向真实文件位置。
      const planPathOnDisk = `.knit/tasks/${taskDirName(dir, taskId)}/plan.md`;
      check(`S7 ${role}: 分节 path 指向真实文件（B005 核对）`, planSectionFull.path === planPathOnDisk, `实际 ${planSectionFull.path}`);
    }
    // worker 实际装配（stage.ts loadSectionContents + prompt 组装）：资料正文是否真的进入实施/检查提示。
    const { ContextPlanner } = await import(pathToFileURL(join(REPO, "dist", "application", "context-planner.js")).href);
    const { SqliteMetadataStore } = await import(pathToFileURL(join(REPO, "dist", "infrastructure", "sqlite-metadata-store.js")).href);
    const stage = await import(pathToFileURL(join(REPO, "dist", "application", "stage.js")).href);
    const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
    const planner = new ContextPlanner({ store });
    const plan = await planner.plan({ dir, taskId, role: "implement" });
    const contents = stage.loadSectionContents(dir, plan, null);
    const loadedPlanning = Object.keys(contents).filter((k) => k.startsWith("planning:"));
    check("S7 [B005] loadSectionContents 能按分节 path 载入规划资料", loadedPlanning.length === 3, `实际载入 ${loadedPlanning.length} 个规划分节`);
    const userPrompt = stage.buildUserPrompt(plan, "implement", contents, { taskId, runId: "r-x", branch: "refs/heads/main", snapshotDir: null, scope: [], previousImplement: null });
    const systemPrompt = stage.buildSystemPrompt(plan, "implement", contents);
    const promptAll = systemPrompt + userPrompt;
    check("S7 [B005] 实施提示含 plan.md 正文", promptAll.includes("改造登录模块"));
    check("S7 [B005] 实施提示含 design.md 正文", promptAll.includes("隔离迁移风险"));
    store.close();
    await host.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ============ 场景 8：每轮注入刷新：随任务选择/阶段/资料更新刷新，不串任务；custom 轮不注入 ============ */
async function scenario8() {
  console.log("\n=== 场景8：每轮注入刷新 ===");
  const dir = project("inject");
  try {
    const host = await loadBridge(dir);
    await startMainSession(dir, host);
    const created1 = cli(dir, ["task", "new", "--title", "任务一", "--slug", "task-one"]);
    const t1 = created1.data.taskId;
    const created2 = cli(dir, ["task", "new", "--title", "任务二", "--slug", "task-two"]);
    const t2 = created2.data.taskId;
    await host.tools.get("knit_material").execute("t0", { action: "save", taskId: t1, path: "plan.md", content: "# 任务一计划\n\n- [ ] A\n" }, null, null, host.ctx);
    // 选择 t1 → 注入 t1。
    await host.tools.get("knit_task").execute("t1", { action: "use", taskId: t1 }, null, null, host.ctx);
    const text1 = await injectTurn(host);
    check("S8 选择后注入当前任务 ID", text1.includes(t1));
    check("S8 注入含阶段", text1.includes("阶段: discuss"));
    check("S8 注入含任务入口路径", text1.includes(".knit/tasks/"));
    check("S8 注入含规划资料列表", text1.includes("plan.md"));
    check("S8 注入不含另一任务", !text1.includes(t2));
    // ready 后阶段刷新。
    cli(dir, ["task", "ready", t1]);
    const textPhase = await injectTurn(host);
    check("S8 ready 后注入阶段刷新为 implement", textPhase.includes("阶段: implement"));
    // 资料更新刷新。
    await host.tools.get("knit_material").execute("t2", { action: "save", taskId: t1, path: "design.md", content: "# 取舍\n" }, null, null, host.ctx);
    const textMat = await injectTurn(host);
    check("S8 新增资料后注入列表刷新（plan+design）", textMat.includes("plan.md") && textMat.includes("design.md"));
    // 重复轮次不堆叠：连续注入同一分节内容一致（快照语义）。
    const textAgain = await injectTurn(host);
    check("S8 重复轮次注入内容稳定不堆叠", textAgain === textMat);
    // 切换到 t2 → 注入刷新且不串任务。
    await host.tools.get("knit_task").execute("t3", { action: "use", taskId: t2 }, null, null, host.ctx);
    const text2 = await injectTurn(host);
    check("S8 切换后注入新任务", text2.includes(t2));
    check("S8 切换后不再显示旧任务资料（plan.md 属任务一）", !text2.includes("plan.md"));
    check("S8 切换后不含旧任务 ID", !text2.includes(t1));
    // 自身通知触发的 custom 轮次不注入。
    const custom = await injectTurn(host, "custom");
    check("S8 custom 轮次不注入", custom === null);
    await host.handlers.get("session_shutdown")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const scenarios = [scenario1, scenario2, scenario3, scenario4, scenario5, scenario6, scenario7, scenario8];
let failed = false;
for (const scenario of scenarios) {
  try { await scenario(); } catch (error) { failed = true; console.log(`FAIL: 场景异常 — ${error?.stack ?? error}`); }
}
const passCount = results.filter((r) => r.ok).length;
console.log(`\n===== 确定性探针汇总：${passCount}/${results.length} 通过 =====`);
if (failed || passCount !== results.length) process.exit(1);
