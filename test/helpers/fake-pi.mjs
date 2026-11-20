#!/usr/bin/env node
/**
 * 测试用的假 Pi：照 `pi --mode rpc` 的样子一行一个 JSON 地收请求、给回答，不调用模型。
 * 做什么由环境变量 KNIT_FAKE_PI 指向的 JSON 文件决定，字段都可以不写：
 * failStart、exitOnPrompt、writes、commands、waitFor、texts、aborted、modelError、retryErrors、stubborn、paneExit、startDelay、resumeOn。
 * aborted 为真时它报告自己是被中止的。modelError 是模型服务给的出错原因：有它时这一轮的最后一条消息是出错的，没有文字。
 * retryErrors 是重试前的错误原因数组：每轮先出现这些出错的助手消息，再照常做完；RPC 模式还发重试事件和成功消息的 message_end。
 * 命令行里没有 `--mode` 时它是“交互界面”：加载 `--extension` 给的扩展，照 Pi 的扩展接口触发事件。
 * 这时 failStart 表示不认识模型，paneExit 为真时不加载扩展就以 1 退出；startDelay 是加载扩展之前等的毫秒数；aborted 为真时第一轮是被中止的，
 * 等 resumeOn 指的文件出现（当作用户接着输入了一句）再做第二轮。
 * stubborn 为真时不理会 SIGTERM，输入关闭时也不退出，只有 SIGKILL 能结束它。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const script = process.env.KNIT_FAKE_PI ? JSON.parse(readFileSync(process.env.KNIT_FAKE_PI, "utf8")) : {};
const log = (line) => {
  if (process.env.KNIT_FAKE_PI_LOG) appendFileSync(process.env.KNIT_FAKE_PI_LOG, `${JSON.stringify(line)}\n`);
};
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (id, data = {}) => send({ type: "response", id, success: true, data });
const texts = script.texts ?? ["做完了。"];
const failedMessage = { role: "assistant", content: [], stopReason: "error", errorMessage: script.modelError };
const retryMessages = (script.retryErrors ?? []).map((errorMessage) => ({
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage,
}));
let prompts = 0;
let lastText = "";
const successfulMessage = () => ({ role: "assistant", content: [{ type: "text", text: lastText }], stopReason: "stop" });

log({ args });
if (script.stubborn) {
  process.on("SIGTERM", () => log({ signal: "SIGTERM" }));
  setInterval(() => {}, 1000);
}

async function work() {
  for (const write of script.writes ?? []) {
    mkdirSync(dirname(join(process.cwd(), write.path)), { recursive: true });
    writeFileSync(join(process.cwd(), write.path), write.content);
  }
  for (const [program, ...rest] of script.commands ?? []) spawnSync(program, rest, { cwd: process.cwd(), stdio: "ignore" });
  while (script.waitFor && !existsSync(script.waitFor)) await new Promise((resolve) => setTimeout(resolve, 20));
  lastText = texts[Math.min(prompts, texts.length - 1)];
  prompts += 1;
}

async function onPrompt(id, message) {
  log({ message });
  if (script.exitOnPrompt) process.exit(1);
  respond(id);
  retryMessages.forEach((message, index) => {
    send({ type: "message_end", message });
    send({
      type: "auto_retry_start",
      attempt: index + 1,
      maxAttempts: retryMessages.length + 1,
      delayMs: 2000,
      errorMessage: message.errorMessage,
    });
  });
  await work();
  if (script.modelError !== undefined) {
    lastText = "";
    send({ type: "message_end", message: failedMessage });
  }
  if (script.retryErrors !== undefined && script.modelError === undefined) {
    send({ type: "message_end", message: successfulMessage() });
    send({ type: "auto_retry_end", success: true, attempt: retryMessages.length });
  }
  send({ type: "agent_settled", aborted: script.aborted === true });
}

if (!args.includes("--mode")) {
  if (script.paneExit) process.exit(1);
  if (script.startDelay) await new Promise((resolve) => setTimeout(resolve, script.startDelay));
  const { default: extension } = await import(arg("--extension"));
  const handlers = {};
  const branch = [];
  let pending = null;
  const ctx = {
    sessionManager: { getBranch: () => branch, getSessionFile: () => join(arg("--session-dir"), "fake.jsonl") },
    modelRegistry: { find: () => (script.failStart ? undefined : {}) },
    ui: { notify: (text) => log({ notify: text }) },
    shutdown: () => setImmediate(() => process.exit(0)),
  };
  extension({
    on: (event, handler) => (handlers[event] = handler),
    sendUserMessage: (text) => (pending = text),
  });
  handlers.session_start({ reason: "startup" }, ctx);
  let aborted = script.aborted === true;
  while (pending !== null) {
    const message = pending;
    pending = null;
    log({ message });
    branch.push({ type: "message", message: { role: "user", content: message } });
    if (aborted) {
      branch.push({ type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } });
      handlers.agent_settled({ aborted: true }, ctx);
      aborted = false;
      while (!existsSync(script.resumeOn)) await new Promise((resolve) => setTimeout(resolve, 20));
      pending = "接着做";
      continue;
    }
    branch.push(...retryMessages.map((message) => ({ type: "message", message })));
    await work();
    branch.push({
      type: "message",
      message: script.modelError !== undefined ? failedMessage : successfulMessage(),
    });
    handlers.agent_settled({ aborted: false }, ctx);
  }
  // 扩展没有再发消息也没有要求退出时，界面停在那里等用户。
  await new Promise(() => setInterval(() => {}, 1000));
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id, type, message } = JSON.parse(line);
  if (type === "get_state") {
    respond(id, { sessionId: arg("--session-id"), sessionFile: null, model: { provider: arg("--provider"), id: arg("--model") } });
  } else if (type === "set_model" && script.failStart) {
    send({ type: "response", id, success: false, error: "Model not found" });
  } else if (type === "get_last_assistant_text") {
    respond(id, { text: lastText });
  } else if (type === "prompt") {
    void onPrompt(id, message);
  } else {
    // set_model、clear_queue、abort
    respond(id);
  }
});
lines.on("close", () => {
  if (!script.stubborn) process.exit(0);
});
