#!/usr/bin/env node
/** 最小 Pi RPC 假实现：只用于 Knit 阶段执行测试，不模拟真实模型。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const provider = arg("--provider") ?? "fake";
const model = arg("--model") ?? "fake";
const sessionDir = arg("--session-dir") ?? join(process.cwd(), "sessions");
const explicitFile = arg("--session");
// 恢复（--session）时沿用文件内的会话 ID，模拟真实 Pi 的身份保持语义。
function sessionIdFromFile(file) {
  try {
    const first = readFileSync(file, "utf8").split("\n")[0];
    const header = JSON.parse(first);
    return typeof header.id === "string" && header.id !== "" ? header.id : undefined;
  } catch {
    return undefined;
  }
}
const sessionId =
  arg("--session-id") ??
  (explicitFile !== undefined && existsSync(explicitFile) ? sessionIdFromFile(explicitFile) : undefined) ??
  randomUUID();
const cwd = process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = explicitFile ?? join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
if (process.env.KNIT_FAKE_NO_FILE !== "1" && !existsSync(sessionFile)) {
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + "\n");
}
let parentId = null;
let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let lastText = "";
let settled = false;
let pendingSpec = null;
let abortCompleted = false;
let completed = false;
function completeNow(spec) {
  if (completed) return;
  completed = true;
  for (const write of spec.writes ?? []) {
    const target = join(cwd, write.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, write.content ?? "");
  }
  lastText = spec.text ?? "```json\n" + JSON.stringify(spec.report ?? { summary: "fake report" }) + "\n```";
  usage = { input: usage.input + 100, output: usage.output + 20, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.total + 120 };
  event("agent_start");
  entry("message", { role: "assistant", content: lastText });
  event("agent_end");
}
function settle(aborted) {
  if (settled) return;
  settled = true;
  event("agent_settled", { aborted });
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function event(type, extra = {}) {
  send({ type, ...extra });
}
function entry(type, data) {
  const id = randomUUID();
  if (process.env.KNIT_FAKE_NO_FILE !== "1") {
    appendFileSync(sessionFile, JSON.stringify({ id, parentId, type, timestamp: new Date().toISOString(), ...data }) + "\n");
  }
  parentId = id;
  return id;
}
function respond(id, data) {
  send({ type: "response", id, success: true, data });
}
function action() {
  const path = process.env.KNIT_FAKE_ACTION;
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, type } = request;
  // 测试钩子：模拟 pi 侧启动失败；stderr 写入 pi 侧错误细节，供启动诊断测试。
  const startFailure = process.env.KNIT_FAKE_START_FAILURE ?? null;
  if (startFailure === "exit") {
    process.stderr.write("Unknown provider: magpie\n");
    process.exit(3);
  }
  if (startFailure === "set_model" && type === "set_model") {
    process.stderr.write("Error: Model not found: magpie/glm-5.3-flash\n");
    send({ type: "response", id, success: false, error: "Model not found: magpie/glm-5.3-flash" });
    return;
  }
  if (type === "get_state") {
    respond(id, { sessionId, sessionFile, model: { provider, id: model } });
    return;
  }
  if (type === "set_model") {
    respond(id, { provider, modelId: model });
    return;
  }
  if (type === "get_last_assistant_text") {
    respond(id, { text: lastText });
    return;
  }
  if (type === "get_messages") {
    respond(id, { messages: [] });
    return;
  }
  if (type === "get_session_stats") {
    respond(id, { tokens: { ...usage }, cost: null, assistantMessages: 1, toolCalls: 0 });
    return;
  }
  if (type === "clear_queue" || type === "abort") {
    respond(id, {});
    if (type === "abort" && process.env.KNIT_FAKE_IGNORE_ABORT === "1") {
      // 模拟工具/宿主暂不响应 abort；测试取消宽限与进程组清理。
      return;
    }
    if (type === "abort" && process.env.KNIT_FAKE_COMPLETE_ON_ABORT === "1") {
      // 确定性竞争注入：收到取消请求的同一 tick 发布 completed 结果，
      // 不靠真实时序偶然命中；终态由阶段执行器收敛为唯一。
      if (!abortCompleted && !settled && pendingSpec !== null) {
        abortCompleted = true;
        completeNow(pendingSpec);
        settle(false);
      }
      return;
    }
    if (type === "abort") settle(true);
    return;
  }
  if (type === "prompt") {
    respond(id, {});
    const spec = action();
    if (abortCompleted) return;
    pendingSpec = spec;
    if (spec.waitFile) {
      // 测试钩子：等待信号文件出现后再动作，模拟进行中的阶段执行；
      // 被中止（settle）后直接返回，不执行任何写入或报告。
      const signal = join(cwd, spec.waitFile);
      const deadline = Date.now() + (spec.waitTimeoutMs ?? 30_000);
      while (!settled && !existsSync(signal) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (settled) return;
    }
    completeNow(spec);
    setTimeout(() => settle(false), spec.delayMs ?? 5);
    return;
  }
  respond(id, {});
});
rl.on("close", () => {
  if (process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE === "1") return;
  process.exit(0);
});
