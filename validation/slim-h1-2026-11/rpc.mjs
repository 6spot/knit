// 启动一个 rpc 模式的 Pi：发命令、收事件，把收到的行原样存成 jsonl。
// 两种不存：流式输出的增量（完整的消息在 message_end 里），和 get_entries 的响应（内容就是会话记录）。
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const DIALOGS = ["select", "confirm", "input", "editor"];

/** 不带进主会话的变量：这些是运行本脚本的那个 Pi 会话自己的。 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...extra };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_CODING_AGENT", "REX_SESSION", "REX_BLOCK"]) {
    delete env[key];
  }
  return env;
}

export function startPi({ cwd, args, env, log }) {
  writeFileSync(log, "");
  const child = spawn("pi", ["--mode", "rpc", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  let seq = 0;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim() === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        appendFileSync(log, `${line}\n`);
        continue;
      }
      if (record.type === "message_update") continue;
      if (!(record.type === "response" && record.command === "get_entries")) appendFileSync(log, `${line}\n`);
      events.push(record);
      if (record.type === "response" && pending.has(record.id)) {
        pending.get(record.id)(record);
        pending.delete(record.id);
      }
      // 要人回答的对话框一律取消，免得卡住。
      if (record.type === "extension_ui_request" && DIALOGS.includes(record.method)) {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));

  function call(type, data = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = `r${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} 等了 ${timeoutMs}ms 没有响应`));
      }, timeoutMs);
      pending.set(id, (record) => {
        clearTimeout(timer);
        resolve(record);
      });
      child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    });
  }

  /** 等到 `from` 之后（含）第一个满足条件的事件，返回它的下标。 */
  function waitEvent(predicate, from, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const index = events.findIndex((event, i) => i >= from && predicate(event));
        if (index >= 0) {
          clearInterval(timer);
          resolve(index);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等了 ${timeoutMs}ms：${what}`));
        }
      }, 100);
    });
  }

  /** 关掉标准输入让 Pi 自己退出；五秒不退就杀掉。 */
  async function stop() {
    child.stdin.end();
    const done = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    if (done === null) child.kill("SIGKILL");
    return done ?? (await exited);
  }

  return { child, events, call, waitEvent, stop, stderr: () => stderr };
}
