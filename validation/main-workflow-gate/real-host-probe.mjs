/**
 * 任务051 真实宿主最小验证（pi 1.5.0 + 真实桥接 + 真实模型，≤3 轮）。
 * 复用 validation/pi-1.5.0-compat/tools-probe.mjs 的 RPC 探针模式：
 *  - 轮1：真实模型经 knit_task 创建任务并选择（knit_task new + use）；
 *  - 轮2：真实模型经 knit_material 写 plan.md 并读回（knit_material save + read）；
 *  - 轮3：不调用工具，仅凭每轮注入的 knit 上下文回答当前任务与资料（验证 before_agent_start 注入到达模型）。
 * 每轮后用 CLI 核对真实落盘结果，不只看模型回复。事件流存 events.jsonl 作证据。
 * 输出 PASS/FAIL 标记；不含任何凭据。
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KNIT = "/home/opc/work/knit/dist/cli/knit.js";
const PI = "/home/opc/.pi/agent/bin/pi";
const PROVIDER = "magpie";
const MODEL = "group/openai";
const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// 隔离项目。
const dir = mkdtempSync(join(tmpdir(), "knit-051-real-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(join(dir, "src", "login.ts"), "export function login() {}\n");
writeFileSync(join(dir, "README.md"), "# demo\n");
execFileSync("git", ["add", "."], { cwd: dir });
execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
const initRun = spawnSync(process.execPath, [KNIT, "--json", "init", "--client", "pi", "--dir", dir], { encoding: "utf8" });
check("R0 init 成功且桥接生成", initRun.status === 0 && existsSync(join(dir, ".pi", "extensions", "knit.ts")));

// 真实 pi 1.5.0（RPC 模式）加载项目桥接。
const child = spawn(PI, ["--mode", "rpc", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--session-dir", join(dir, ".knit", ".runtime", "pi-sessions"), "--approve",
  "--provider", PROVIDER, "--model", MODEL,
  "--session-id", "knit-gate-051", "--name", "knit gate 051"], {
  cwd: dir, env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
});
const events = [];
let stderr = "";
let pending = new Map();
let idCounter = 1;
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      events.push(rec);
      if (rec.id && pending.has(rec.id)) { pending.get(rec.id)(rec); pending.delete(rec.id); }
    } catch {}
  }
});
child.stderr.on("data", (c) => { stderr += c.toString(); });
function call(kind, data = {}, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const rid = `r${idCounter++}`;
    pending.set(rid, resolve);
    child.stdin.write(JSON.stringify({ id: rid, type: kind, ...data }) + "\n");
    setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); resolve({ id: rid, error: "timeout" }); } }, timeoutMs);
  });
}
function waitSettled(afterIndex, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const settled = events.slice(afterIndex).some((e) => e.type === "agent_settled");
      if (settled || Date.now() - started > timeoutMs) { clearInterval(timer); resolve(settled); }
    }, 300);
  });
}
const toolCallsOf = () => {
  const seen = new Map();
  for (const e of events) {
    if (e.type !== "message_end") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "toolCall" && !seen.has(b.id)) seen.set(b.id, { name: b.name, arguments: b.arguments });
    }
  }
  return [...seen.values()];
};
const lastAssistantText = () => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const content = e.message?.content ?? e.partialResult?.content;
    if (Array.isArray(content)) {
      const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "";
};
function cliJson(args) {
  const run = spawnSync(process.execPath, [KNIT, "--json", ...args, "--dir", dir], { encoding: "utf8" });
  try { return JSON.parse(run.stdout); } catch { return { outcome: "error", data: { error: run.stdout.slice(0, 200) } }; }
}

try {
  const state = await call("get_state", {}, 30000);
  check("R0 RPC get_state 连接（pi 1.5.0）", !state.error);
  const setModel = await call("set_model", { provider: PROVIDER, modelId: MODEL }, 30000);
  check("R0 set_model 真实模型可用", !setModel.error && setModel.error !== "timeout");

  // ── 轮1：经 knit_task 创建任务并选择 ──
  let mark = events.length;
  await call("prompt", { message: "用 knit_task 工具完成两步：第一步 action=new 创建任务，title 用「README 安装说明」，slug 用 readme-install；第二步 action=use 把刚创建的任务选为当前任务。完成后只报告任务 ID。" }, 240000);
  const settled1 = await waitSettled(mark);
  check("R1 真实模型轮收敛（agent_settled）", settled1);
  const turn1Calls = toolCallsOf().filter((c) => c.name === "knit_task");
  check("R1 真实模型调用 knit_task（≥2 次：new + use）", turn1Calls.length >= 2, JSON.stringify(turn1Calls.map((c) => c.arguments?.action)));
  check("R1 调用含 action=new", turn1Calls.some((c) => c.arguments?.action === "new"));
  check("R1 调用含 action=use", turn1Calls.some((c) => c.arguments?.action === "use"));
  const list = cliJson(["task", "list"]);
  const target = (list.data?.active ?? []).find((t) => t.title === "README 安装说明" && t.relativePath.endsWith("readme-install")) ?? null;
  const taskId = target?.taskId ?? null;
  check("R1 任务真实落盘（标题与 slug 与请求一致）", taskId !== null, `taskId=${taskId} active=${list.data?.active?.length}`);
  const mainSession = cliJson(["session", "list"]).data?.find((e) => e.kind === "main");
  check("R1 真实主会话已登记", typeof mainSession?.knitSessionId === "string");
  const selectionOk = mainSession?.selection?.taskId === taskId && mainSession?.selection?.persisted === true;
  check("R1 选择已持久化到索引（taskId + persisted）", selectionOk, JSON.stringify(mainSession?.selection ?? null));
  const resolved = cliJson(["session", "resolve", mainSession.knitSessionId]);
  check("R1 session resolve 从原生会话恢复选择", resolved.data?.taskId === taskId && resolved.data?.effective === true, JSON.stringify(resolved.data));

  // ── 轮2：经 knit_material 写 plan.md 并读回 ──
  mark = events.length;
  await call("prompt", { message: `用 knit_material 工具完成两步：第一步 action=save 给任务 ${taskId} 写 plan.md，内容必须是：\n# 实施计划\n\n- [ ] 补充安装说明\n- [ ] 校验文档渲染\n\n## 未完成\n\n- [ ] 补充安装说明\n- [ ] 校验文档渲染\n\n第二步 action=read 读回 plan.md。完成后只报告文件第一行。` }, 240000);
  const settled2 = await waitSettled(mark);
  check("R2 真实模型轮收敛（agent_settled）", settled2);
  const turn2Calls = toolCallsOf().filter((c) => c.name === "knit_material");
  check("R2 真实模型调用 knit_material（≥2 次：save + read）", turn2Calls.length >= 2, JSON.stringify(turn2Calls.map((c) => c.arguments?.action)));
  check("R2 调用含 action=save 且 path=plan.md", turn2Calls.some((c) => c.arguments?.action === "save" && c.arguments?.path === "plan.md"));
  const planFile = join(dir, ".knit", "tasks", list.data.active[0].relativePath.split("/")[1], "plan.md");
  const planOnDisk = existsSync(planFile) ? readFileSync(planFile, "utf8") : "";
  check("R2 plan.md 真实落盘且含未完成步骤", planOnDisk.includes("## 未完成") && planOnDisk.includes("- [ ] 补充安装说明"), planOnDisk.slice(0, 80));
  const reply2 = lastAssistantText();
  check("R2 工具读回数据正确呈现（模型回复第一行）", reply2.includes("# 实施计划"), reply2.slice(0, 120));

  // ── 轮3：仅凭每轮注入回答（不调用工具）→ 验证 before_agent_start 注入到达真实模型 ──
  mark = events.length;
  const toolCallsBeforeTurn3 = toolCallsOf().length;
  await call("prompt", { message: "不要调用任何工具。只根据你在本轮收到的系统提示中 knit 注入分节回答：当前选定任务的 ID 是什么？规划资料列表是什么？" }, 240000);
  const settled3 = await waitSettled(mark);
  check("R3 真实模型轮收敛（agent_settled）", settled3);
  const reply3 = lastAssistantText();
  const turn3NewToolCalls = toolCallsOf().length - toolCallsBeforeTurn3;
  check("R3 第三轮未调用工具（注入验证不污染）", turn3NewToolCalls === 0, `新增工具调用 ${turn3NewToolCalls}`);
  check("R3 第三轮真实模型轮完成", reply3.length > 0, reply3.slice(0, 100));
  check("R3 模型回答含当前任务 ID（注入到达）", reply3.includes(taskId ?? "∅"), reply3.slice(0, 200));
  check("R3 模型回答含规划资料 plan.md（注入到达）", /plan\.md/.test(reply3), reply3.slice(0, 200));

  // 证据落盘（不含凭据；arguments 可能含任务标题等非敏感内容）。
  const evidence = {
    piVersion: "1.5.0", provider: PROVIDER, model: MODEL,
    project: dir,
    turns: 3,
    toolCalls: toolCallsOf(),
    finalReplies: { turn1: "", turn2: reply2, turn3: reply3 },
  };
  writeFileSync(join(import.meta.dirname, "real-host-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(import.meta.dirname, "real-host-summary.json"), JSON.stringify(evidence, null, 2));
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}
const passCount = results.filter((r) => r.ok).length;
console.log(`\n===== 真实宿主探针汇总：${passCount}/${results.length} 通过 =====`);
if (stderr.trim()) console.log("STDERR:", stderr.slice(0, 400));
if (passCount !== results.length) process.exit(1);
