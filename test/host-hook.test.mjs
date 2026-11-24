import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agyHostHook } from "../dist/adapters/antigravity/host-hook.js";
import { workbuddyHostHook } from "../dist/adapters/workbuddy/host-hook.js";
import { initProject } from "../dist/application/init.js";
import { cancelTask } from "../dist/application/task-lifecycle.js";
import { buildSessionContext, contextLines } from "../dist/application/session-context.js";
import { project } from "./helpers/cli.mjs";
import { readyTask } from "./helpers/run.mjs";

const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const session = "ec33ebf9-0cba-4100-8142-c61503f6c587";

function isolateEnvironment(t) {
  const previous = process.env;
  process.env = { ...previous };
  t.after(() => { process.env = previous; });
}

function preTool(payload, command) {
  return agyHostHook("PreToolUse", { ...payload, stepIdx: 19, toolCall: { name: "run_command", args: {
    CommandLine: command, Cwd: payload.cwd, WaitMsBeforeAsync: 5000,
  } } });
}

test("普通目录的上级是 Knit 用户目录时，继续查找实际工作区", async (t) => {
  isolateEnvironment(t);
  const parent = project(t);
  const store = join(parent, ".knit");
  mkdirSync(join(store, "worktrees"));
  const cwd = join(parent, "ordinary");
  mkdirSync(cwd);
  process.env.KNIT_HOME = store;
  const payload = { cwd, conversationId: session, workspacePaths: [cwd] };
  for (const event of ["SessionStart", "PreInvocation"]) assert.deepEqual(await agyHostHook(event, payload), {});
  const workspace = project(t);
  initProject(workspace);
  const result = await agyHostHook("PreInvocation", { ...payload, workspacePaths: [workspace] });
  assert.match(result.injectSteps[0].systemMessage.systemMessage, /discussion\.md/);
  assert.equal(existsSync(join(workspace, ".knit/.runtime/host-sessions", `agy-${session}.json`)), true);
  assert.equal(existsSync(join(store, ".runtime")), false);
});

test("AGY 从 stdin 注入、按会话去重，选择和状态变化后刷新", async (t) => {
  const root = project(t);
  const plain = process.env.KNIT_HOME;
  const payload = { conversationId: session, workspacePaths: [plain], cwd: plain };
  for (const event of ["SessionStart", "PreInvocation"]) assert.deepEqual(await agyHostHook(event, payload), {});
  assert.equal(existsSync(join(plain, ".knit")), false);
  initProject(root);
  const task = readyTask(root);
  const subdir = join(root, "subdir");
  mkdirSync(subdir);
  payload.workspacePaths = [subdir];
  const injected = async (event = "PreInvocation") => (await agyHostHook(event, payload)).injectSteps[0].systemMessage.systemMessage;
  const called = spawnSync(process.execPath, [cli, "hook", "agy", "SessionStart"], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(called.status, 0, called.stderr);
  const first = JSON.parse(called.stdout).injectSteps[0].systemMessage.systemMessage;
  assert.ok(first.includes('<standard path="knit:standards/discussion.md"'));
  assert.match(first, /没有选中 Knit 任务/);
  const states = join(root, ".knit/.runtime/host-sessions");
  const state = () => JSON.parse(readFileSync(join(states, `agy-${session}.json`), "utf8"));
  assert.deepEqual(state(), { taskId: null, lastDigest: createHash("sha256").update(first).digest("hex") });
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  symlinkSync(cli, join(plain, "knit"));
  const select = async (command) => {
    const modified = await preTool(payload, `true && ${command}`);
    assert.equal(modified.decision, "allow");
    return spawnSync("/bin/sh", ["-c", modified.overwrite.CommandLine], { encoding: "utf8", cwd: subdir,
      env: { ...process.env, PATH: `${plain}:${process.env.PATH}` } });
  };
  assert.equal((await select(`TASK_ID=${task.id} sh -c 'knit context --use="$TASK_ID"'`)).status, 0);
  assert.equal(state().taskId, task.id);
  assert.equal(state().lastDigest, null);
  const selected = await injected();
  assert.equal(selected, contextLines(buildSessionContext(root, task.id)).join("\n").trimEnd());
  assert.match(selected, /^状态: ready$/m);
  assert.match(selected, /^下一步: .*knit run start /m);
  assert.ok(selected.includes(`目录: ${task.dir}`));
  assert.match(selected, /^规范（implement 环节）:/m);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  assert.equal((await select("knit context --use missing")).status, 1);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  assert.equal(cancelTask(root, task.id, { reason: "结束" }).kind, "cancelled");
  const ended = await injected();
  assert.match(ended, /状态: cancelled/);
  assert.match(ended, /目录: .knit\/tasks\/archive\//);
  const archive = /^目录: (.*)$/m.exec(ended)[1];
  renameSync(join(root, archive, "task.md"), join(root, archive, "moved"));
  assert.match(await injected(), /discussion.md[\s\S]*选中的 Knit 任务 .* 读不出来/);
  payload.conversationId = "another/session's id";
  assert.equal(await injected(), first);
  assert.equal((await select("sh -o errexit -c -- 'knit context --unuse'")).status, 0);
  assert.equal(readdirSync(states).filter((name) => name.endsWith(".json")).length, 2);
  assert.equal(state().taskId, task.id);
  payload.conversationId = session;
  assert.equal((await select("knit context --unuse")).status, 0);
  assert.equal(await injected(), first);
});

test("交付只接受本次调用的预览选项或转录中完整的用户原话", async (t) => {
  const cwd = project(t);
  const payload = { cwd, conversationId: session, transcriptPath: join(cwd, "transcript.jsonl") };
  const row = (content, type = "USER_INPUT", source = "USER_EXPLICIT") => JSON.stringify({ step_index: 1, source, type, status: "DONE", content });
  const user = (text) => row(`<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n元数据\n</ADDITIONAL_METADATA>`);
  writeFileSync(payload.transcriptPath, [user("先不要交付"), user("同意交付这个任务"), user("第一行\n  同意交付 A  "),
    row("模型原话", "PLANNER_RESPONSE", "MODEL")].join("\n"));
  for (const command of ["git status", "command -v knit deliver", "echo 'knit deliver id'", "knit deliver id --preview", "knit deliver id --authorization='同意交付这个任务'",
    'knit deliver --preview "$TASK_ID"', 'knit deliver id --dir "$PWD/sub dir" --preview',
    `knit deliver id --dir="$PWD/sub dir" --authorization '同意交付这个任务'`,
    "printf 中文 && env DEBUG=1 knit deliver --dir '目录 A' id --authorization ' 同意交付 A '",
    `bash show-arguments.sh -c 'knit context --unuse'`, `sh -c 'echo knit deliver'`,
    `knit deliver id --dir "$PWD" --authorization '同意交付这个任务'`,
    "A=1 knit deliver id --authorization '第一行\n  同意交付 A  '"]) assert.deepEqual(await preTool(payload, command), { decision: "allow" }, command);
  for (const command of ["knit deliver id", "knit deliver id --authorization 交付", "knit deliver id --authorization 伪造",
    "knit deliver id --authorization 元数据", "knit deliver id --authorization 模型原话", "knit deliver id --authorization=$QUOTE",
    "knit deliver id --authorization 交付 --message-file '--preview'", "knit deliver id --preview && knit deliver other",
    "knit deliver id --authorization '同意交付这个任务' | env A=1 knit --dir '目录 A' deliver other",
    "echo $(knit deliver id)", `bash -lc 'knit deliver id'`, "knit deliver id --authorization '未闭合"]) {
    const result = await preTool(payload, command);
    assert.equal(result.decision, "deny", command);
    assert.match(result.reason, /--authorization/);
  }
  payload.transcriptPath += ".missing";
  assert.deepEqual(await preTool(payload, "knit deliver id --preview"), { decision: "allow" });
  assert.equal((await preTool(payload, "knit deliver id --authorization 同意交付这个任务")).decision, "deny");
});

test("run start 透传 AGY 默认执行者并保留显式选择", async (t) => {
  isolateEnvironment(t);
  const cwd = project(t);
  const payload = { cwd, conversationId: session };
  const env = { ...process.env, PATH: `${cwd}:${process.env.PATH}` };
  delete process.env.KNIT_SESSION_AGENT;
  delete env.KNIT_SESSION_AGENT;
  writeFileSync(join(cwd, "knit"), '#!/bin/sh\nprintf "%s\\n" "$KNIT_SESSION_AGENT"\n', { mode: 0o755 });
  const command = ["printf '中文\\n'", "knit run start id", "KNIT_SESSION_AGENT=pi knit run start other",
    `sh -c 'knit run start nested && echo "\${KNIT_SESSION_AGENT-unset}"'`, `eval 'knit run' 'start joined'`].join(" && ");
  const modified = await preTool(payload, command);
  assert.equal(modified.decision, "allow");
  const ran = spawnSync("/bin/sh", ["-c", modified.overwrite.CommandLine], { env, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, "中文\nantigravity\npi\nantigravity\nunset\nantigravity\n");
  assert.deepEqual(await preTool(payload, "env KNIT_SESSION_AGENT=pi knit run start id"), { decision: "allow" });
  process.env.KNIT_SESSION_AGENT = "pi";
  assert.deepEqual(await preTool(payload, "knit run start id"), { decision: "allow" });
});

const events = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", PreToolUse: "pre-tool-use" };
const buddySession = "b35aac84-ed2d-4029-a78c-188510e77bcc";
async function buddyHook(payload) {
  return (await workbuddyHostHook(events[payload.hook_event_name], payload))?.hookSpecificOutput ?? null;
}

function buddyPreTool(cwd, command, tool = "Bash") {
  return buddyHook({ session_id: buddySession, cwd, transcript_path: join(cwd, `${buddySession}.jsonl`), hook_event_name: "PreToolUse",
    call_id: "call-8", tool_use_id: "call-8", tool_name: tool,
    tool_input: { command, timeout: 120000, description: "调用 Knit", run_in_background: false } });
}

test("实际事件从启动到每轮提交按会话注入，选择、状态变化和取消选择后刷新", async (t) => {
  isolateEnvironment(t);
  const cwd = project(t);
  const plain = process.env.KNIT_HOME;
  const start = { session_id: buddySession, transcript_path: join(cwd, `${buddySession}.jsonl`), hook_event_name: "SessionStart", source: "startup" };
  const prompt = { session_id: buddySession, transcript_path: start.transcript_path, hook_event_name: "UserPromptSubmit", prompt: "继续", is_internal_continuation: false, cwd };
  process.env.CODEBUDDY_PROJECT_DIR = plain;
  process.env.CLAUDE_PROJECT_DIR = cwd;
  assert.equal(await buddyHook(start), null);
  process.env.CODEBUDDY_PROJECT_DIR = cwd;
  assert.equal(await buddyHook({ ...prompt, cwd: plain }), null);
  initProject(cwd);
  const task = readyTask(cwd);
  const first = await buddyHook(start);
  assert.equal(first.hookEventName, "SessionStart");
  assert.match(first.additionalContext, /discussion\.md/);
  assert.match(first.additionalContext, /原生子 Agent[\s\S]*显式指定外部执行者/);
  assert.match(first.additionalContext, /run_in_background: true[\s\S]*--timeout 60[\s\S]*下一轮/);
  assert.match(first.additionalContext, /dangerouslyDisableSandbox: true/);
  assert.equal(await buddyHook(prompt), null);
  symlinkSync(cli, join(plain, "knit"));
  const select = async (command) => {
    const result = await buddyPreTool(cwd, command);
    assert.equal(result.hookEventName, "PreToolUse");
    assert.match(result.updatedInput.command, /KNIT_HOST=workbuddy KNIT_HOST_SESSION=/);
    const ran = spawnSync("/bin/sh", ["-c", result.updatedInput.command], { cwd, env: { ...process.env, PATH: `${plain}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
  };
  await select(`knit context --use ${task.id}`);
  const selected = await buddyHook(prompt);
  assert.equal(selected.hookEventName, "UserPromptSubmit");
  assert.ok(selected.additionalContext.startsWith(contextLines(buildSessionContext(cwd, task.id)).join("\n").trimEnd()));
  assert.equal(await buddyHook(prompt), null);
  assert.equal(cancelTask(cwd, task.id, { reason: "结束" }).kind, "cancelled");
  assert.match((await buddyHook({ ...prompt, is_internal_continuation: true })).additionalContext, /状态: cancelled/);
  const other = readyTask(cwd);
  await select(`knit context --use ${other.id}`);
  assert.ok((await buddyHook(prompt)).additionalContext.startsWith(contextLines(buildSessionContext(cwd, other.id)).join("\n").trimEnd()));
  assert.equal(await buddyHook(prompt), null);
  await select("knit context --unuse");
  assert.equal((await buddyHook(prompt)).additionalContext, first.additionalContext);
});

test("Bash 交付只接受转录中完整的用户原话，预览和派发原样放行", async (t) => {
  const cwd = project(t);
  const transcript = join(cwd, `${buddySession}.jsonl`);
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
    const result = await buddyPreTool(cwd, quote ? `${deliver} --authorization '${quote}'` : deliver);
    assert.equal(result.permissionDecision, "deny", quote);
    assert.match(result.permissionDecisionReason, /--authorization[\s\S]*--preview/);
  }
  for (const quote of ["先等等\n同意交付 A", "同意交付 A", "同意交付 B"]) assert.equal(await buddyPreTool(cwd, `${deliver} --authorization '${quote}'`), null);
  writeFileSync(transcript, "");
  assert.equal((await buddyPreTool(cwd, `${deliver} --authorization '同意交付 B'`)).permissionDecision, "deny");
  for (const command of ["git status", `${deliver} --preview`, "knit run start k-test"]) assert.equal(await buddyPreTool(cwd, command), null);
  assert.equal(await buddyPreTool(cwd, deliver, "Other"), null);
});

test("桌面 user_query 内的多行原话可核对，附件来源和提醒只作为宿主信息", async (t) => {
  const cwd = project(t);
  const body = "请使用这次审查结果\n同意交付桌面桥接";
  const row = { id: "msg-desktop", type: "message", role: "user", providerData: { skipRun: false }, content: [
    { type: "input_text", text: `<system-reminder data-role="hook">提醒内容</system-reminder>\n<user_query><query_source>来自微信聊天记录</query_source>\n${body}</user_query>` },
    { type: "input_text", text: "<image_local_path>\n/tmp/picture.png\n</image_local_path>" },
  ] };
  writeFileSync(join(cwd, `${buddySession}.jsonl`), `${JSON.stringify(row)}\n`);
  const check = (quote) => buddyPreTool(cwd, `knit deliver k-test --authorization '${quote}'`);
  for (const quote of [body, "同意交付桌面桥接"]) assert.equal(await check(quote), null);
  for (const quote of ["交付桌面桥接", "提醒内容", "<query_source>来自微信聊天记录</query_source>", "/tmp/picture.png"]) {
    assert.equal((await check(quote)).permissionDecision, "deny");
  }
});

test("已安装的项目钩子在 GUI 极简 PATH 下加载工作区与当前版本的 CLI", async (t) => {
  const root = project(t);
  initProject(root, false, { workbuddy: true });
  const home = process.env.KNIT_HOME;
  const shims = join(home, ".local/share/mise/shims");
  mkdirSync(shims, { recursive: true });
  symlinkSync(cli, join(shims, "knit"));
  symlinkSync(process.execPath, join(shims, "node"));
  const hooks = JSON.parse(readFileSync(join(root, ".workbuddy/settings.json"))).hooks;
  assert.equal(hooks.PreToolUse[0].matcher, ".*");
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CODEBUDDY_PROJECT_DIR: root };
  const invoke = (event, fields) => spawnSync("/bin/sh", ["-c", hooks[event][0].hooks[0].command], { cwd: home, env,
    input: JSON.stringify({ hook_event_name: event, session_id: buddySession, ...fields }), encoding: "utf8" });
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
