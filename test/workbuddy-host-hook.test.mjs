import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { knit, project } from "./helpers/cli.mjs";
import { readyTask } from "./helpers/run.mjs";

const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const events = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", PreToolUse: "pre-tool-use" };
const session = "b35aac84-ed2d-4029-a78c-188510e77bcc";
function hook(payload, options = {}) {
  const result = spawnSync(process.execPath, [cli, "hook", "workbuddy", events[payload.hook_event_name]], {
    input: JSON.stringify(payload), encoding: "utf8", ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout === "" ? null : JSON.parse(result.stdout).hookSpecificOutput;
}

function preTool(cwd, command, tool = "Bash") {
  return hook({ session_id: session, cwd, transcript_path: join(cwd, `${session}.jsonl`), hook_event_name: "PreToolUse",
    call_id: "call-8", tool_use_id: "call-8", tool_name: tool,
    tool_input: { command, timeout: 120000, description: "调用 Knit", run_in_background: false } });
}

test("实际事件从启动到每轮提交按会话注入，选择、状态变化和取消选择后刷新", (t) => {
  const cwd = project(t);
  const plain = process.env.KNIT_HOME;
  const start = { session_id: session, transcript_path: join(cwd, `${session}.jsonl`), hook_event_name: "SessionStart", source: "startup" };
  const prompt = { session_id: session, transcript_path: start.transcript_path, hook_event_name: "UserPromptSubmit", prompt: "继续", is_internal_continuation: false, cwd };
  const env = { ...process.env, CODEBUDDY_PROJECT_DIR: plain, CLAUDE_PROJECT_DIR: cwd };
  assert.equal(hook(start, { env, cwd }), null);
  assert.equal(hook({ ...prompt, cwd: plain }, { env: { ...env, CODEBUDDY_PROJECT_DIR: cwd } }), null);
  assert.equal(knit(cwd, "init").code, 0);
  const task = readyTask(cwd);
  const first = hook(start, { env: { ...env, CODEBUDDY_PROJECT_DIR: cwd }, cwd: plain });
  assert.equal(first.hookEventName, "SessionStart");
  assert.match(first.additionalContext, /discussion\.md/);
  assert.match(first.additionalContext, /原生子 Agent[\s\S]*显式指定外部执行者/);
  assert.match(first.additionalContext, /run_in_background: true[\s\S]*--timeout 60[\s\S]*下一轮/);
  assert.match(first.additionalContext, /dangerouslyDisableSandbox: true/);
  assert.equal(hook(prompt), null);
  symlinkSync(cli, join(plain, "knit"));
  const select = (command) => {
    const result = preTool(cwd, command);
    assert.equal(result.hookEventName, "PreToolUse");
    assert.match(result.updatedInput.command, /KNIT_HOST=workbuddy KNIT_HOST_SESSION=/);
    const ran = spawnSync("/bin/sh", ["-c", result.updatedInput.command], { cwd, env: { ...process.env, PATH: `${plain}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
  };
  select(`knit context --use ${task.id}`);
  const selected = hook(prompt);
  assert.equal(selected.hookEventName, "UserPromptSubmit");
  assert.ok(selected.additionalContext.startsWith(knit(cwd, "context", task.id).stdout.trimEnd()));
  assert.equal(hook(prompt), null);
  assert.equal(knit(cwd, "task", "cancel", task.id, "--reason", "结束").code, 0);
  assert.match(hook({ ...prompt, is_internal_continuation: true }).additionalContext, /状态: cancelled/);
  const other = readyTask(cwd);
  select(`knit context --use ${other.id}`);
  assert.ok(hook(prompt).additionalContext.startsWith(knit(cwd, "context", other.id).stdout.trimEnd()));
  assert.equal(hook(prompt), null);
  select("knit context --unuse");
  assert.equal(hook(prompt).additionalContext, first.additionalContext);
});

test("Bash 交付只接受转录中完整的用户原话，预览和派发原样放行", (t) => {
  const cwd = project(t);
  const transcript = join(cwd, `${session}.jsonl`);
  const text = (value) => ({ type: "input_text", text: value });
  const user = (content, providerData = { skipRun: false }) => ({ id: "msg-test", type: "message", role: "user", content, providerData });
  const meta = [{ isMeta: true }, { skipRun: true }, { isAdditionalData: true }, { teammateMessage: { from: "worker" } },
    { isCompactInternal: true }, { isCompacted: true }, { isSummary: true }, { compactType: "auto" }, { agent: "compact" },
    { goalStatus: "done" }, { scheduledTaskTrigger: {} }, { contentFilterNotice: true }, { hookStatus: {} }];
  const rows = [user("先等等\n同意交付 A"), user([text("同意交付 B\n<system-reminder data-role=\"hook\">\n钩子原话\n</system-reminder>"),
    { type: "output_text", text: "工具原话" }]), { ...user("模型原话"), role: "assistant" }, { ...user("事件原话"), type: "event" },
    ...meta.map((data, index) => user([text(`合成${index}`)], data))];
  writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n"));
  const deliver = "knit deliver k-test";
  for (const quote of ["", "交付 A", "伪造", "模型原话", "钩子原话", "工具原话", "事件原话", ...meta.map((_, index) => `合成${index}`)]) {
    const result = preTool(cwd, quote ? `${deliver} --authorization '${quote}'` : deliver);
    assert.equal(result.permissionDecision, "deny", quote);
    assert.match(result.permissionDecisionReason, /--authorization[\s\S]*--preview/);
  }
  for (const quote of ["先等等\n同意交付 A", "同意交付 A", "同意交付 B"]) assert.equal(preTool(cwd, `${deliver} --authorization '${quote}'`), null);
  writeFileSync(transcript, "");
  assert.equal(preTool(cwd, `${deliver} --authorization '同意交付 B'`).permissionDecision, "deny");
  for (const command of ["git status", `${deliver} --preview`, "knit run start k-test"]) assert.equal(preTool(cwd, command), null);
  assert.equal(preTool(cwd, deliver, "Other"), null);
});

test("桌面 user_query 内的多行原话可核对，附件来源和提醒只作为宿主信息", (t) => {
  const cwd = project(t);
  const body = "请使用这次审查结果\n同意交付桌面桥接";
  const row = { id: "msg-desktop", type: "message", role: "user", providerData: { skipRun: false }, content: [
    { type: "input_text", text: `<system-reminder data-role="hook">提醒内容</system-reminder>\n<user_query><query_source>来自微信聊天记录</query_source>\n${body}</user_query>` },
    { type: "input_text", text: "<image_local_path>\n/tmp/picture.png\n</image_local_path>" },
  ] };
  writeFileSync(join(cwd, `${session}.jsonl`), `${JSON.stringify(row)}\n`);
  const check = (quote) => preTool(cwd, `knit deliver k-test --authorization '${quote}'`);
  for (const quote of [body, "同意交付桌面桥接"]) assert.equal(check(quote), null);
  for (const quote of ["交付桌面桥接", "提醒内容", "<query_source>来自微信聊天记录</query_source>", "/tmp/picture.png"]) {
    assert.equal(check(quote).permissionDecision, "deny");
  }
});

test("已安装的项目钩子在 GUI 极简 PATH 下加载工作区与当前版本的 CLI", (t) => {
  const root = project(t);
  assert.equal(knit(root, "init", "--workbuddy").code, 0);
  const home = process.env.KNIT_HOME;
  const shims = join(home, ".local/share/mise/shims");
  mkdirSync(shims, { recursive: true });
  symlinkSync(cli, join(shims, "knit"));
  symlinkSync(process.execPath, join(shims, "node"));
  const hooks = JSON.parse(readFileSync(join(root, ".workbuddy/settings.json"))).hooks;
  assert.equal(hooks.PreToolUse[0].matcher, "^Bash$");
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CODEBUDDY_PROJECT_DIR: root };
  const invoke = (event, fields) => spawnSync("/bin/sh", ["-c", hooks[event][0].hooks[0].command], { cwd: home, env,
    input: JSON.stringify({ hook_event_name: event, session_id: session, ...fields }), encoding: "utf8" });
  const result = invoke("SessionStart", { source: "startup" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  const skip = invoke("UserPromptSubmit", { cwd: root, prompt: "继续", is_internal_continuation: false });
  assert.equal(skip.status, 0, skip.stderr);
  assert.equal(skip.stdout, "");
  const denied = invoke("PreToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "knit deliver id" } });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
});
