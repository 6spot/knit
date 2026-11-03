// 真实桥接（init 产物）在 1.5.0 下模型工具列表验证。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
const KNIT = "/home/opc/work/knit/dist/cli/knit.js";
const dir = mkdtempSync(join(tmpdir(), "pi152-real-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
writeFileSync(join(dir, "a.txt"), "alpha\n");
execFileSync("git", ["add", "."], { cwd: dir });
execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
spawnSync(process.execPath, [KNIT, "--json", "init", "--client", "pi", "--dir", dir], { encoding: "utf8" });
const child = spawn("/home/opc/.pi/agent/bin/pi", ["--mode", "rpc", "--offline", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--session-dir", join(dir, ".knit", ".runtime", "pi-sessions"), "--approve",
  "--provider", "magpie", "--model", "group/openai",
  "--session-id", "real152", "--name", "real bridge"], { cwd: dir, env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } });
const events = [];
let stderr = "";
let pending = new Map();
let id = 1;
child.stdout.on("data", (chunk) => { for (const line of chunk.toString().split("\n")) { if (!line.trim()) continue; try { const rec = JSON.parse(line); events.push(rec); if (rec.id && pending.has(rec.id)) { pending.get(rec.id)(rec); pending.delete(rec.id); } } catch {} } });
child.stderr.on("data", (c) => { stderr += c.toString(); });
const call = (kind, data = {}, timeoutMs = 30000) => new Promise((resolve) => {
  const rid = `r${id++}`; pending.set(rid, resolve);
  child.stdin.write(JSON.stringify({ id: rid, type: kind, ...data }) + "\n");
  setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); resolve({ id: rid, error: "timeout" }); } }, timeoutMs);
});
await call("get_state", {}, 30000);
await call("set_model", { provider: "magpie", modelId: "group/openai" }, 30000);
await call("prompt", { message: "不要执行任何工具。只回答：你的可用工具里有哪些名字以 knit_ 开头？逐一列出名字，不要说别的。" }, 180000);
await new Promise((r) => { const s = Date.now(); const t = setInterval(() => { if (events.some((e) => e.type === "agent_settled") || Date.now() - s > 150000) { clearInterval(t); r(); } }, 300); });
for (const e of [...events].reverse()) {
  const text = e.message?.content ?? e.partialResult?.content;
  if (Array.isArray(text)) { const joined = text.map((b) => b.text ?? "").join(""); if (joined.trim()) { console.log("MODEL_TOOLS:", joined.slice(0, 500)); break; } }
}
if (stderr.trim()) console.log("STDERR:", stderr.slice(0, 600));
child.kill();
