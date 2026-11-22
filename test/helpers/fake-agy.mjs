#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.5.13");
  process.exit(0);
}
const script = JSON.parse(process.env.KNIT_FAKE_AGY);
const cwd = process.cwd();
const conversationId = randomUUID();
const brain = join(homedir(), ".gemini/antigravity-cli/brain");
mkdirSync(brain, { recursive: true });
const transcriptPath = join(brain, `${conversationId}.jsonl`);
const row = (data) => appendFileSync(transcriptPath, `${JSON.stringify(data)}\n`);
const hooksFile = ".agents/hooks.json";
if (!lstatSync(hooksFile).isFile()) throw new Error("agy did not discover the Worktree hooks file");
const hookConfig = JSON.parse(readFileSync(hooksFile, "utf8")).knit;
const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
const hook = (event, payload = {}) => {
  const entry = event === "PreToolUse" ? hookConfig[event][0].hooks[0] : hookConfig[event][0];
  const result = spawnSync("/bin/sh", ["-c", entry.command], {
    encoding: "utf8", input: JSON.stringify({ conversationId, transcriptPath, ...payload }), timeout: 10_000,
  });
  assert.equal(result.status, 0, `${event}: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
for (const file of [".agents/mcp_config.json", ".agent/mcp_config.json", join(homedir(), ".gemini/config/mcp_config.json")]) {
  try {
    const mcp = JSON.parse(readFileSync(file, "utf8"));
    for (const server of Object.values(mcp.mcpServers)) spawnSync(server.command, server.args);
  } catch (error) {
    assert.ok(["ENOENT", "EPERM", "EACCES"].includes(error.code), error);
  }
}
const configReads = script.configReads?.map((file) => {
  try {
    readFileSync(file);
    return "allowed";
  } catch (error) {
    return error.code;
  }
});
row({ type: "INIT", args, cwd, settings, configReads });
hook("SessionStart");

function tools() {
  if (!script.tools) return;
  const checks = script.tools.map((spec) => {
    const result = hook("PreToolUse", { toolCall: { name: spec.name, args: spec.args } });
    if (result.decision === "deny") return { decision: result.decision };
    if (spec.name === "run_command") {
      row({ type: "APPROVAL", result });
      assert.match(result.overwrite.CommandLine, /^\/private\/tmp\/knit-agy-exec-[\w-]+\/run-command [a-f0-9-]+$/);
      if (spec.decline) return { decision: result.decision, declined: true };
      const command = spawnSync("/bin/sh", ["-c", result.overwrite.CommandLine], { encoding: "utf8", timeout: 7000 });
      return { decision: result.decision, stdout: command.stdout, stderr: command.stderr, code: command.status };
    }
    try {
      if (spec.name === "write_to_file") writeFileSync(spec.args.TargetFile, "native\n");
      return { decision: result.decision, text: spec.name === "view_file" ? readFileSync(spec.args.AbsolutePath, "utf8") : null };
    } catch (error) {
      return { decision: result.decision, error: error.code };
    }
  });
  row({ type: "TOOL_CHECKS", checks });
}

const emit = (event) => console.log(JSON.stringify(event));
const submit = 'KNIT_AGY_SUBMIT\n审查完成\n```json\n{"verdict":"pass"}\n```';
const turn = (message) => row({ type: "USER_INPUT", content: message });
const stop = (response, executionNum) => {
  row({ source: "MODEL", type: "PLANNER_RESPONSE", content: response });
  return hook("Stop", { fullyIdle: true, executionNum, terminationReason: "NO_TOOL_CALL" });
};
const interactive = args.includes("--prompt-interactive");
if (interactive) {
  turn(args[args.indexOf("--prompt-interactive") + 1]);
  tools();
  if (script.exit) process.exit(0);
  if (script.wait) {
    assert.deepEqual(stop(script.unmarked ? "请提供测试输入" : "KNIT_AGY_WAITING\n请提供测试输入", 0), {});
    while (!existsSync(script.wait)) await sleep(30);
    turn("追加输入：继续审查");
  }
  if (script.limit) {
    hook("Stop", { fullyIdle: true, executionNum: 1, terminationReason: "max_steps_exceeded" });
    process.exit(0);
  }
  const reply = stop(script.retry ? "KNIT_AGY_SUBMIT\n缺少结论" : submit, 1);
  if (script.retry) {
    assert.equal(reply.decision, "continue");
    turn(reply.reason);
    stop(script.invalidAgain ? "KNIT_AGY_SUBMIT\n仍缺少结论" : submit, 2);
  }
  process.exit(0);
}

emit({ event: "init", conversation_id: conversationId, init: { cwd, tools: [] } });
const messages = [];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line).message.content;
  messages.push(message);
  turn(message);
  if (messages.length === 1) tools();
  if (script.long) {
    const result = hook("PreToolUse", { toolCall: { name: "run_command", args: { Cwd: cwd, CommandLine: script.long } } });
    spawnSync("/bin/sh", ["-c", result.overwrite.CommandLine]);
  }
  if (script.denied) emit({ event: "step_update", step_update: {
    conversation_id: conversationId, step_index: 2, state: "ERROR", step_type: "tool", tool_name: "write_file",
    tool_info: { name: "write_file", error: { type: "TOOL_ERROR", message: "Matches user-configured deny rule" } },
  } });
  emit({ event: "result", result: {
    conversation_id: conversationId, status: "SUCCESS",
    response: script.retry && (messages.length === 1 || script.invalidAgain) ? "KNIT_AGY_SUBMIT\n缺少结论" : submit,
    ...(script.denied ? { error: "Tool permission denied", denied_actions: [{ action: "write_file", display_name: "Edit" }] } : {}),
  } });
}
