import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit, project } from "./helpers/cli.mjs";

const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const request = "这次涉及三个文件和独立审查，按刚才讨论的方案做。";

function hook(cwd, host, event, payload) {
  return spawnSync(process.execPath, [cli, "hook", host, event], { cwd, input: JSON.stringify(payload), encoding: "utf8" });
}

test("Pi 将建任务的判断留给主会话，同一轮可显式创建两份独立草稿", async (t) => {
  const cwd = project(t);
  const bridge = await loadBridge(t, cwd);
  bridge.entries.push({ type: "message", id: "u1", message: { role: "user", content: request } });
  const fire = (toolName, input) => bridge.fire("tool_call", { toolName, input });
  for (const [name, input] of [["edit", { path: "a.txt" }], ["subagent", { agent: "review-local" }],
    ["bash", { command: "knit task new --help" }], ["bash", { command: "printf ok > a.txt" }]]) {
    assert.equal(await fire(name, input), undefined, name);
  }
  bridge.entries.push({ type: "message", id: "u2", message: { role: "user", content: "给实现和检查各建一份草稿。" } });
  const created = [];
  for (const title of ["实现", "检查"]) {
    const params = { action: "new", title };
    assert.equal(await fire("knit_task", params), undefined);
    const result = await bridge.tool("knit_task", params);
    assert.equal(result.isError, undefined, result.content[0].text);
    const [first, file] = result.content[0].text.split("\n");
    assert.match(first, new RegExp(`^已创建 ${title}（k-[0-9a-f]+）$`));
    assert.match(readFileSync(join(cwd, file), "utf8"), new RegExp(`title: ${title}`));
    created.push(first);
  }
  assert.notEqual(created[0], created[1]);
  assert.equal(bridge.entries.some((entry) => entry.type === "custom"), false);
  assert.deepEqual(bridge.messages, []);
});

test("Pi 的 bash 交付通过用户整条消息或完整一行核对原话", async (t) => {
  const bridge = await loadBridge(t, project(t));
  bridge.entries.push(
    { type: "message", id: "u1", message: { role: "user", content: "检查通过\n同意交付这项工作" } },
    { type: "message", id: "a1", message: { role: "assistant", content: "现在交付" } },
  );
  const call = (command) => bridge.fire("tool_call", { toolName: "bash", input: { command } });
  for (const command of ["knit deliver k-example --preview", "knit deliver k-example --authorization '同意交付这项工作'",
    "knit deliver k-example --authorization '检查通过\n同意交付这项工作'"]) {
    assert.equal(await call(command), undefined, command);
  }
  for (const command of ["knit deliver k-example", "knit deliver k-example --authorization '同意交付'",
    "knit deliver k-example --authorization '现在交付'"]) {
    assert.equal((await call(command)).block, true, command);
  }
});

test("升级后已加载的 Pi 模板仍可调用 tool-call，并核对实际交付", (t) => {
  const cwd = project(t);
  assert.equal(knit(cwd, "init").code, 0);
  const messages = [{ role: "user", text: request }, { role: "assistant", text: "同意交付" }];
  const call = (name, input) => hook(cwd, "pi", "tool-call", { name, input, sessionId: "old-pi", selected: null, messages });
  const edit = call("edit", { path: "a.txt" });
  assert.equal(edit.status, 0, edit.stderr);
  assert.deepEqual(JSON.parse(edit.stdout), {});
  const command = "knit task new --help";
  const shell = call("bash", { command });
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(JSON.parse(shell.stdout), { command });
  const delivery = { command: "knit deliver k-example --authorization '同意交付'" };
  assert.notEqual(call("bash", delivery).status, 0);
  messages.push({ role: "user", text: "同意交付" });
  assert.equal(call("bash", delivery).status, 0);
});

test("新 Pi 模板与只认识 tool-call 的 CLI 可以执行普通命令并核对交付", async (t) => {
  const cwd = project(t);
  const bridge = await loadBridge(t, cwd);
  // 上一版的协议忽略未知字段，从 messages 核对原话并返回 command。
  const shim = join(cwd, "knit");
  writeFileSync(shim, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.join(" ") !== "hook pi tool-call") process.exit(1);
const { name, input, sessionId, messages } = JSON.parse(fs.readFileSync(0, "utf8"));
const result = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...args], { input: JSON.stringify({ name, input, sessionId, messages }), stdio: ["pipe", "inherit", "inherit"] });
process.exit(result.status);
`, { mode: 0o755 });
  process.env.PATH = `${cwd}${delimiter}${process.env.PATH}`;
  const call = (command) => bridge.fire("tool_call", { toolName: "bash", input: { command } });
  assert.equal(await call("pwd"), undefined);
  assert.equal((await call("knit deliver k-example --authorization '同意交付'")).block, true);
  bridge.entries.push({ type: "message", id: "u1", message: { role: "user", content: "同意交付" } });
  assert.equal(await call("knit deliver k-example --authorization '同意交付'"), undefined);
});

for (const host of ["agy", "workbuddy"]) {
  test(`${host} 放行普通写入，同轮显式建两份草稿分别回执并保留原选择`, (t) => {
    const cwd = project(t);
    assert.equal(knit(cwd, "init", `--${host}`).code, 0);
    const transcript = join(cwd, "transcript.jsonl");
    const agy = host === "agy";
    const row = agy ? { type: "USER_INPUT", source: "USER_EXPLICIT", content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>` }
      : { type: "message", role: "user", content: [{ type: "input_text", text: request }] };
    writeFileSync(transcript, JSON.stringify(row));
    symlinkSync(cli, join(cwd, "knit"));
    const session = "host-session";
    const run = (command) => {
      const decision = agy ? hook(cwd, host, "PreToolUse", { cwd, conversationId: session, transcriptPath: transcript,
        toolCall: { name: "run_command", args: { CommandLine: command, Cwd: cwd } } })
        : hook(cwd, host, "pre-tool-use", { cwd, session_id: session, transcript_path: transcript, tool_name: "Bash", tool_input: { command } });
      assert.equal(decision.status, 0, decision.stderr);
      const output = decision.stdout ? JSON.parse(decision.stdout) : {};
      if (agy) assert.equal(output.decision, "allow");
      else assert.notEqual(output.hookSpecificOutput?.permissionDecision, "deny");
      const script = output.overwrite?.CommandLine ?? output.hookSpecificOutput?.updatedInput?.command ?? command;
      const result = spawnSync("/bin/sh", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, PATH: `${cwd}${delimiter}${process.env.PATH}` } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    run("printf ok > a.txt");
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "ok");
    assert.match(run("knit task new --help"), /--title/);
    const previous = /^已创建 前项（(k-[0-9a-f]+)）/.exec(knit(cwd, "task", "new", "--title", "前项").stdout)[1];
    run(`knit context --use ${previous}`);
    const ids = ["实现", "检查"].map((title) => {
      const [first, file, receipt, link] = run(`knit task new --title ${title}`).trimEnd().split("\n");
      const id = new RegExp(`^已创建 ${title}（(k-[0-9a-f]+)）$`).exec(first)[1];
      assert.equal(receipt, `${title}（${id}） · draft · 当前会话未选中新草稿`);
      assert.equal(link, `[task.md](${file})`);
      assert.match(readFileSync(join(cwd, file), "utf8"), new RegExp(`title: ${title}`));
      return id;
    });
    assert.notEqual(ids[0], ids[1]);
    const state = JSON.parse(readFileSync(join(cwd, `.knit/.runtime/host-sessions/${host}-${session}.json`), "utf8"));
    assert.equal(state.taskId, previous);
  });
}
