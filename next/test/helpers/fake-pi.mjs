#!/usr/bin/env node
/**
 * 测试用的假 Pi：照 `pi --mode rpc` 的样子一行一个 JSON 地收请求、给回答，不调用模型。
 * 做什么由环境变量 KNIT_FAKE_PI 指向的 JSON 文件决定，字段都可以不写：
 * failStart、exitOnPrompt、writes、commands、waitFor、texts、stubborn。
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
let prompts = 0;
let lastText = "";

log({ args });
if (script.stubborn) {
  process.on("SIGTERM", () => log({ signal: "SIGTERM" }));
  setInterval(() => {}, 1000);
}

async function onPrompt(id, message) {
  log({ message });
  if (script.exitOnPrompt) process.exit(1);
  respond(id);
  for (const write of script.writes ?? []) {
    mkdirSync(dirname(join(process.cwd(), write.path)), { recursive: true });
    writeFileSync(join(process.cwd(), write.path), write.content);
  }
  for (const [program, ...rest] of script.commands ?? []) spawnSync(program, rest, { cwd: process.cwd(), stdio: "ignore" });
  while (script.waitFor && !existsSync(script.waitFor)) await new Promise((resolve) => setTimeout(resolve, 20));
  lastText = texts[Math.min(prompts, texts.length - 1)];
  prompts += 1;
  send({ type: "agent_settled", aborted: false });
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
