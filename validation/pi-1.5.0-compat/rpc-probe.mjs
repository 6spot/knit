// Pi 1.5.0 RPC 协议探针（Knit 关键边界）：get_state、set_model 校验、真实模型轮、agent_settled、abort。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PI = "/home/opc/.pi/agent/bin/pi";
const dir = mkdtempSync(join(tmpdir(), "pi152-probe-"));
writeFileSync(join(dir, "notes.md"), "KNIT_PONG_MARKER_7f3a\n");
const results = {};
const env = { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
const args = [PI, "--mode", "rpc", "--offline", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--session-dir", join(dir, "sessions"), "--no-approve",
  "--provider", process.env.PI_PROVIDER, "--model", process.env.PI_MODEL,
  "--tools", "read", "--session-id", "probe152", "--name", "Knit 1.5.0 probe",
  "--append-system-prompt", "临时验证夹具：只按测试请求回答。"];
const child = spawn(PI, args.slice(1), { cwd: dir, env });
const events = [];
let pending = new Map();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line);
      events.push(record);
      if (record.id && pending.has(record.id)) { pending.get(record.id)(record); pending.delete(record.id); }
    } catch { events.push({ type: "invalid_record" }); }
  }
});
child.stderr.on("data", (c) => events.push({ type: "stderr", text: c.toString().slice(0, 200) }));
function call(kind, data = {}, timeoutMs = 30000) {
  const id = `req-${nextId++}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, type: kind, ...data }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ id, error: "timeout" }); } }, timeoutMs);
  });
}
function waitEvent(type, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const check = () => { const found = events.find((e) => e.type === type); if (found) resolve(found); };
    check();
    const timer = setInterval(() => { check(); if (Date.now() > start + timeoutMs) { clearInterval(timer); resolve(null); } }, 100);
    const start = Date.now();
  });
}
const start = Date.now();
// 1. get_state
const state = await call("get_state", {}, 30000);
results.getState = state.data?.sessionId ? "ok" : JSON.stringify(state).slice(0, 120);
results.sessionFileExists = state.data?.sessionFile ? existsSync(state.data.sessionFile) : null;
// 2. set_model 校验
const setModel = await call("set_model", { provider: process.env.PI_PROVIDER, modelId: process.env.PI_MODEL }, 30000);
results.setModel = setModel.error ? `rejected:${JSON.stringify(setModel.error).slice(0, 80)}` : "ok";
// 3. 真实模型轮：读文件并回复标记（Knit 阶段语义）
const prompt = await call("prompt", { message: "用 read 工具读取 notes.md，然后只回复包含 KNIT_PONG_MARKER_7f3a 的一行。不要做别的事。" }, 150000);
results.promptRpc = prompt.error ? `timeout` : "ok";
const settled = await waitEvent("agent_settled", 150000);
results.agentSettled = settled ? (settled.aborted ? "aborted" : "settled") : "timeout";
const messageEnd = events.filter((e) => e.type === "message_end" || e.type === "message_update");
results.assistantText = (() => {
  for (const e of [...events].reverse()) {
    const text = e.message?.content ?? e.partialResult?.content;
    if (Array.isArray(text)) { const joined = text.map((b) => b.text ?? "").join(""); if (joined.includes("KNIT_PONG_MARKER")) return "marker-found"; }
  }
  return "marker-missing";
})();
// 4. 工具 schema 校验：非法参数的工具调用被拒（pi-schema）
const badTool = await call("tool_call", { toolName: "read", input: { path: 12345 } }, 15000);
results.toolSchemaReject = badTool.error || badTool.data ? JSON.stringify(badTool).slice(0, 100) : "passed-through(需工具层核对)";
// 5. 取消：新 prompt + abort
const p2 = call("prompt", { message: "数到 100。" }, 30000);
await new Promise((r) => setTimeout(r, 2000));
const abort = await call("abort", {}, 15000);
results.abort = abort.error ? "rejected" : "ok";
await p2.catch(() => {});
const settled2 = await waitEvent("agent_settled", 30000);
results.abortSettled = settled2 ? (settled2.aborted ? "aborted" : "settled") : "timeout";
// 6. 原生会话落盘
results.nativeFilePersisted = existsSync(state.data?.sessionFile ?? "");
// 7. 退出
child.stdin.write(JSON.stringify({ id: `req-${nextId++}`, kind: "exit" }) + "\n");
await new Promise((r) => setTimeout(r, 1500));
child.kill();
console.log("PI_152_PROBE", JSON.stringify(results, null, 1));
console.log("PI_VERSION", execFileSync(PI, ["--version"], { encoding: "utf8" }).trim());
