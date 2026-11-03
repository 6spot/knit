// Pi 1.5.0 + Knit 桥接最小宿主验证：项目 init → pi rpc 加载项目扩展 → /knit-status 命令 handled → 工具调用。
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const KNIT = "/home/opc/work/knit/dist/cli/knit.js";
const dir = mkdtempSync(join(tmpdir(), "pi152-bridge-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
writeFileSync(join(dir, "a.txt"), "alpha\n");
execFileSync("git", ["add", "."], { cwd: dir });
execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
const init = spawnSync(process.execPath, [KNIT, "--json", "init", "--client", "pi", "--dir", dir], { encoding: "utf8" });
const initData = JSON.parse(init.stdout);
const results = { initReady: initData.data?.ready === true };
// 用 pi rpc 加载项目扩展（信任由 --approve 提供；非交互下项目扩展自动加载）
const child = spawn("/home/opc/.pi/agent/bin/pi", ["--mode", "rpc", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--session-dir", join(dir, ".knit", ".runtime", "pi-sessions"), "--approve",
  "--provider", "magpie", "--model", "group/openai", "--tools", "read", "--no-context-files",
  "--session-id", "bridge152", "--name", "Knit 1.5.0 bridge probe"], { cwd: dir, env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } });
const events = [];
let pending = new Map();
let id = 1;
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    try { const rec = JSON.parse(line); events.push(rec); if (rec.id && pending.has(rec.id)) { pending.get(rec.id)(rec); pending.delete(rec.id); } } catch {}
  }
});
const call = (kind, data = {}, timeoutMs = 30000) => new Promise((resolve) => {
  const rid = `r${id++}`;
  pending.set(rid, resolve);
  child.stdin.write(JSON.stringify({ id: rid, type: kind, ...data }) + "\n");
  setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); resolve({ id: rid, error: "timeout" }); } }, timeoutMs);
});
await call("get_state", {}, 30000);
await call("set_model", { provider: "magpie", modelId: "group/openai" }, 30000);
// /knit-status 命令经 sendUserMessage：扩展命令拦截 → disposition handled，不触模型。
const cmd = await call("prompt", { message: "/knit-status" }, 60000);
results.knitStatusCommand = cmd.error ? "timeout" : "sent";
// /knit-status 命令被扩展拦截：prompt 响应 disposition=handled，不产生模型轮（015 语义）。
results.promptDisposition = typeof cmd.response?.disposition === "string" ? cmd.response.disposition : JSON.stringify(cmd).slice(0, 100);
results.noAgentStart = !events.some((e) => e.type === "agent_start");

// 桥接工具在 1.5.0 的 schema 注册与真实模型调用：模型读文件并用 knit_status 工具回报。
const toolRound = await call("prompt", { message: "先创建一个任务：用 knit_task 工具，action 为 new，title 为 probe152。然后用 knit_status 工具（不带参数）查询项目状态，并把工具返回中出现的任务 ID 原样回复给我。不要做其它事。" }, 180000);
results.toolRoundRpc = toolRound.error ? "timeout" : "ok";
const toolSettled = await new Promise((resolve) => {
  const start = Date.now();
  const timer = setInterval(() => {
    const s = events.find((e) => e.type === "agent_settled");
    if (s) { clearInterval(timer); resolve(s); }
    if (Date.now() - start > 150000) { clearInterval(timer); resolve(null); }
  }, 200);
});
results.toolRoundSettled = toolSettled ? (toolSettled.aborted ? "aborted" : "settled") : "timeout";
results.bridgeToolCalled = events.some((e) => (e.type === "tool_execution_start" || e.type === "tool_execution_update") && String(e.toolName ?? e.partialResult?.toolName ?? "").startsWith("knit_")) ? "yes" : "not-observed";
const toolText = (() => {
  for (const e of [...events].reverse()) {
    const text = e.message?.content ?? e.partialResult?.content;
    if (Array.isArray(text)) { const joined = text.map((b) => b.text ?? "").join(""); if (joined.includes("k-")) return joined.slice(0, 120); }
  }
  return null;
})();
results.taskIdFromTool = toolText !== null ? "reported" : "missing";
results.eventKinds = [...new Set(events.map((e) => e.type))].join(",");
// knit_task 工具已注册（get_state 或扩展条目无法直接枚举；以桥接加载无崩溃 + 命令 handled 为证据）。
results.bridgeLoaded = results.knitStatusCommand === "sent" && results.noAgentStart;
child.stdin.write(JSON.stringify({ id: "exit", type: "exit" }) + "\n");
await new Promise((r) => setTimeout(r, 1200));
child.kill();
console.log("PI_152_BRIDGE", JSON.stringify(results, null, 1));
