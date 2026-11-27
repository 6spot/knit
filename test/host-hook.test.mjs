import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agyHostHook } from "../dist/adapters/antigravity/host-hook.js";
import { qoderHostHook } from "../dist/adapters/qoder/host-hook.js";
import { workbuddyHostHook } from "../dist/adapters/workbuddy/host-hook.js";
import { deliverTask } from "../dist/application/delivery.js";
import { canSkipHostCommand, inspectHostCommand } from "../dist/application/host-command.js";
import { selectHostTask } from "../dist/application/host-hook.js";
import { initProject } from "../dist/application/init.js";
import { loadConfig, readWorkflow } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { cancelTask, closeTask, readyTask as confirmTask } from "../dist/application/task-lifecycle.js";
import { buildSessionContext, contextLines } from "../dist/application/session-context.js";
import { createTask } from "../dist/application/task-store.js";
import { HOST_SPECS } from "../dist/contracts/host.js";
import { knit, project } from "./helpers/cli.mjs";
import { agents, readyTask, runProject } from "./helpers/run.mjs";

const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const session = "ec33ebf9-0cba-4100-8142-c61503f6c587";
const discussionPaths = ["discussion", "task-splitting", "task-writing"].map((name) => `knit:standards/${name}.md`);
const standardPaths = (text) => [...text.matchAll(/^<standard path="([^"]+)"/gm)].map((match) => match[1]);
const unselected = "没有选中 Knit 任务。用 knit task list 查看任务，用 knit context --use <id> 选中任务。";

function writeStandard(root, name, frontmatter, body) {
  const path = `.knit/standards/${name}.md`;
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), `---\n${frontmatter}\n---\n\n${body}\n`);
  return path;
}

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

test("命令型宿主的编译模块导出登记的钩子函数", async () => {
  for (const host of HOST_SPECS) {
    if (!host.hook) continue;
    const adapter = await import(`../dist/adapters/${host.hook.module}`);
    assert.equal(typeof adapter[host.hook.exportName], "function", `${host.id}: ${host.hook.exportName}`);
  }
});

test("直接 hook 子进程按命令加载模块，保留各宿主的放行和拒绝协议", () => {
  const trace = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      if (url.startsWith('file:')) console.error(url);
      return nextLoad(url, context);
    } });`;
  const desktop = (command) => ({ session_id: session, tool_name: "Bash", tool_input: { command } });
  const hosts = [
    ["agy", "PreToolUse", (command) => ({ conversationId: session, toolCall: { name: "run_command", args: { CommandLine: command } } }), '{"decision":"allow"}\n'],
    ["workbuddy", "pre-tool-use", desktop, ""],
    ["qoder", "pre-tool-use", desktop, ""],
    ["pi", "tool-call", (command) => ({ name: "bash", input: { command }, messages: [] }), '{"command":"find ."}'],
  ];
  for (const [host, event, payload, allowed] of hosts) {
    for (const command of host === "pi" ? ["find ."] : ["find .", "knit deliver id"]) {
      const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(trace)}`, cli, "hook", host, event],
        { input: JSON.stringify(payload(command)), encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /\/application\/host-command\.js/m);
      assert.doesNotMatch(result.stderr, /\/node_modules\/(?:commander|yaml)\/|\/application\/(?:host-hook|session-context|task-store)\.js|\/cli\/(?:deliver|project|run|task|shared)\.js/);
      if (command === "find .") {
        assert.doesNotMatch(result.stderr, /\/node_modules\/sh-syntax\//);
        assert.equal(result.stdout, allowed, host);
        continue;
      }
      assert.match(result.stderr, /\/node_modules\/sh-syntax\//);
      const decision = JSON.parse(result.stdout);
      assert.equal(decision.decision ?? decision.hookSpecificOutput.permissionDecision, "deny", host);
    }
  }
});

test("hook 的帮助、未知事件及无效参数沿用既有输出与退出码", () => {
  const help = "Usage: knit hook [options] [command]\n\nOptions:\n  -h, --help      display help for command\n\nCommands:\n  agy <event>\n  help [command]  display help for command\n";
  const agyHelp = "Usage: knit hook agy [options] <event>\n\nOptions:\n  -h, --help  display help for command\n";
  for (const [args, status, stdout, stderr] of [
    [["--help"], 0, help, ""], [["agy", "--help"], 0, agyHelp, ""],
    [["pi", "unknown"], 1, "", "未知的 Pi 工具事件\n"],
    [["unknown", "event"], 1, "", "error: unknown command 'unknown'\n"],
    [["agy"], 1, "", "error: missing required argument 'event'\n"],
    [["agy", "--x"], 1, "", "error: unknown option '--x'\n"],
    [["agy", "PreToolUse", "more"], 1, "", "error: too many arguments for 'agy'. Expected 1 argument but got 2: PreToolUse, more.\n"],
  ]) {
    const result = spawnSync(process.execPath, [cli, "hook", ...args], { input: "", encoding: "utf8" });
    assert.deepEqual([result.status, result.stdout, result.stderr], [status, stdout, stderr], args.join(" "));
  }
});

test("普通命令不加载 shell 解析器，Knit 命令仍使用既有解析及改写", async (t) => {
  const bridgeTemplate = await import("../assets/templates/pi/extensions/knit.ts");
  const imports = [];
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "sh-syntax") imports.push(specifier);
    return nextResolve(specifier, context);
  } });
  t.after(() => hook.deregister());
  const environment = { session: "KNIT_HOST=agy", start: "KNIT_SESSION_AGENT=antigravity" };
  for (const command of ["ls -la", "git status", "git diff --stat", "npm test", "node --test test/a.test.mjs",
    'cat "README.md"', "grep 'hello' src/", "rg 'foo' src/", "find .", "find . -name '*.ts'", "rg foo .", "git add .",
    "git diff -- .", "ls .", "cat scripts/build.sh", "rg sh-syntax src/", "npm test -- --dash", "rg --path=. foo",
    "cat foo.bash", "rg source-map", "rg myshell", "rg 'foo bar' ."]) {
    assert.equal(canSkipHostCommand(command), true, command);
    assert.equal(bridgeTemplate.canSkipHostCommand(command), true, command);
    assert.deepEqual(await inspectHostCommand(command, environment), { command, quotes: [] });
  }
  assert.deepEqual(imports, []);
  for (const command of ["knit deliver id", 'k"nit" deliver id', "k'n'it deliver id", String.raw`k\nit deliver id`,
    "knit deliver --preview id", "knit context --use id", "knit task new --title example", "knit run start id",
    "$CMD deliver", "$(printf knit) deliver", "echo `date`", "KNIT --version", "eval 'echo hello'", "e'val' 'echo hello'",
    "sh -c 'echo hello'", "/bin/bash -c 'echo hello'", 'b"ash" -c true', "zsh --version", "dash -c true", "ksh -c true",
    "source setup", "base64 file", "./sh -c true", "env bash", "echo myKNITfile", "eval 'knit deliver id'",
    ". setup", "\t. setup", '"" . setup', "'.' setup", "(. setup)", "{ . setup; }", "! . setup", "if true; then . setup; fi",
    "true && . setup", "FOO=1 . setup", 'FOO="two words" . setup', "FOO=!x . setup", "</dev/null . setup",
    "LABEL=two\u00a0words . setup", "< two\u00a0words . setup", "repeat 2 . setup",
    "2> log . setup", '>out< "input file" . setup', "command -p . setup", "time -p -- . setup",
    ...[";", "\r", "\n", "&", "|", "(", ")", "{", "}", "!"].map((control) => `true${control}\t. setup`),
    ...["if", "then", "elif", "else", "while", "until", "do", "time", "coproc", "builtin", "command", "exec", "nohup", "noglob", "nocorrect", "-"].map((prefix) => `${prefix} . setup`)]) {
    assert.equal(canSkipHostCommand(command), false, command);
    assert.equal(bridgeTemplate.canSkipHostCommand(command), false, command);
  }
  for (const command of ["knit deliver id", 'k"nit" deliver id', "k'n'it deliver id", String.raw`k\nit deliver id`,
    "eval 'knit deliver id'", "sh -c 'knit deliver id'", "bash -c 'knit deliver id'"]) {
    assert.deepEqual(await inspectHostCommand(command, environment), { command, quotes: [""] });
  }
  assert.ok(imports.length > 0, "完整检查必须加载 sh-syntax");
  const preview = "knit deliver --preview id";
  assert.deepEqual(await inspectHostCommand(preview, environment), { command: preview, quotes: [] });
  const authorized = "knit deliver id --authorization '同意交付'";
  assert.deepEqual(await inspectHostCommand(authorized, environment), { command: authorized, quotes: ["同意交付"] });
  for (const command of ["knit context --use id", "knit context --unuse", "knit task new --title example"]) {
    assert.deepEqual(await inspectHostCommand(command, environment), { command: `env ${environment.session} ${command}`, quotes: [] });
  }
  const start = "knit run start id";
  assert.deepEqual(await inspectHostCommand(start, environment), { command: `env ${environment.start} ${start}`, quotes: [] });
});

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
  const task = createTask(root, { title: "加问候语", slug: "task", verification: "self", priority: "P2", parent: null, dependsOn: [] }).created;
  const development = writeStandard(root, "development", "title: 开发规范\nstages: [implement]", "验证输出。");
  const subdir = join(root, "subdir");
  mkdirSync(subdir);
  payload.workspacePaths = [subdir];
  const injected = async (event = "PreInvocation") => (await agyHostHook(event, payload)).injectSteps[0].systemMessage.systemMessage;
  const called = spawnSync(process.execPath, [cli, "hook", "agy", "SessionStart"], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(called.status, 0, called.stderr);
  const first = JSON.parse(called.stdout).injectSteps[0].systemMessage.systemMessage;
  assert.deepEqual(standardPaths(first), discussionPaths);
  assert.equal(first.split("\n").at(-1), unselected);
  const states = join(root, ".knit/.runtime/host-sessions");
  const state = () => JSON.parse(readFileSync(join(states, `agy-${session}.json`), "utf8"));
  const initialState = state();
  assert.equal(initialState.taskId, null);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  symlinkSync(cli, join(plain, "knit"));
  const select = async (command) => {
    const modified = await preTool(payload, `true && ${command}`);
    assert.equal(modified.decision, "allow");
    return spawnSync("/bin/sh", ["-c", modified.overwrite.CommandLine], { encoding: "utf8", cwd: subdir,
      env: { ...process.env, PATH: `${plain}:${process.env.PATH}` } });
  };
  const used = await select(`TASK_ID=${task.id} sh -c 'knit context --use="$TASK_ID"'`);
  assert.equal(used.status, 0);
  assert.equal(used.stdout, `已选中 加问候语（${task.id}）\n`);
  assert.equal(state().taskId, task.id);
  assert.equal(state().digests.discussion, initialState.digests.discussion);
  assert.equal(state().digests.status, undefined);
  const selected = await injected();
  assert.match(selected, /^状态: draft$/m);
  assert.ok(selected.includes(`下一步: 先确认需求（knit task ready ${task.id}）`));
  assert.ok(selected.includes(`目录: ${dirname(task.file)}`));
  assert.deepEqual(standardPaths(selected), []);

  assert.equal(confirmTask(root, task.id).kind, "ready");
  const ready = await injected();
  assert.match(ready, /^状态: ready$/m);
  assert.match(ready, /^下一步: .*knit run start /m);
  assert.match(ready, /^规范（implement 环节）:/m);
  assert.deepEqual(standardPaths(ready), [development]);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  assert.equal((await select("knit context --use missing")).status, 1);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  assert.equal(cancelTask(root, task.id, { reason: "结束" }).kind, "cancelled");
  const ended = await injected();
  assert.match(ended, /状态: cancelled/);
  assert.match(ended, /目录: .knit\/tasks\/archive\//);
  assert.deepEqual(standardPaths(ended), []);
  const archive = /^目录: (.*)$/m.exec(ended)[1];
  renameSync(join(root, archive, "task.md"), join(root, archive, "moved"));
  const error = await injected();
  assert.ok(error.startsWith(`选中的 Knit 任务 ${task.id} 读不出来\n`));
  assert.deepEqual(standardPaths(error), []);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  payload.conversationId = "another/session's id";
  assert.equal(await injected(), first);
  assert.equal((await select("sh -o errexit -c -- 'knit context --unuse'")).status, 0);
  assert.equal(readdirSync(states).filter((name) => name.endsWith(".json")).length, 2);
  assert.equal(state().taskId, task.id);
  payload.conversationId = session;
  assert.equal((await select("knit context --unuse")).status, 0);
  assert.equal(await injected(), unselected);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
});

test("环节、项目规范和避坑分区分别更新；同环节开始执行只刷新状态", async (t) => {
  const root = runProject(t);
  const task = readyTask(root, { verification: "self" });
  const payload = { cwd: root, conversationId: session };
  const injected = async (event = "PreInvocation") => (await agyHostHook(event, payload)).injectSteps[0].systemMessage.systemMessage;
  const setDevelopment = (body) => writeStandard(root, "development", "title: 开发规范\nstages: [implement]", body);
  const setPitfalls = (implement, deliver) => writeStandard(root, "pitfalls", "title: 避坑清单",
    `## 通用\n\n每轮核实\n\n## discuss\n\n核对需求\n\n## implement\n\n${implement}\n\n## deliver\n\n${deliver}`);
  const development = setDevelopment("实现要求初版。");
  const pitfalls = setPitfalls("实现避坑初版。", "交付避坑初版。");
  const first = await injected("SessionStart");
  assert.deepEqual(standardPaths(first), [...discussionPaths, pitfalls]);
  assert.match(first, /核对需求/);
  assert.equal(selectHostTask(root, { host: "agy", sessionId: session }, task.id).kind, "selected");
  const selected = await injected();
  assert.deepEqual(standardPaths(selected), [development, pitfalls]);
  assert.match(selected, /实现避坑初版/);

  setDevelopment("实现要求新版。");
  const edited = await injected();
  assert.match(edited, /^状态: ready$/m);
  assert.match(edited, /实现要求新版/);
  assert.deepEqual(standardPaths(edited), [development]);
  setPitfalls("实现避坑初版。", "交付避坑新版。");
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  setPitfalls("实现避坑新版。", "交付避坑新版。");
  const updated = await injected();
  assert.match(updated, /^状态: ready$/m);
  assert.match(updated, /实现避坑新版/);
  assert.deepEqual(standardPaths(updated), [pitfalls]);

  const workflow = readWorkflow(root).workflow;
  const { run, problems } = prepareRun({ root, taskId: task.id, workflow, config: loadConfig(root).config, model: null });
  assert.deepEqual(problems, []);
  const active = await injected();
  assert.match(active, /^状态: active\(implement\)$/m);
  assert.deepEqual(standardPaths(active), []);
  assert.deepEqual(finishRun({ agents, root, taskId: task.id, runId: run.id, workflow, verdict: null, failure: null, sessionFile: null }), []);
  const finished = await injected();
  assert.match(finished, /^下一步: 核对之后运行 knit task close /m);
  assert.match(finished, /交付避坑新版/);
  assert.doesNotMatch(finished, /实现避坑新版/);
  assert.deepEqual(standardPaths(finished), ["knit:standards/delivery.md", pitfalls]);
  assert.equal(closeTask(root, task.id, { result: "结束", paths: [] }).kind, "done");
  const closed = await injected();
  assert.match(closed, /^状态: done$/m);
  assert.deepEqual(standardPaths(closed), []);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
});

test("旧会话保留任务并迁移摘要，CLI 仍完整输出，任务损坏只报告一次", async (t) => {
  const root = project(t);
  initProject(root);
  const task = readyTask(root);
  const development = writeStandard(root, "development", "title: 开发规范\nstages: [implement]", "验证输出。");
  const full = contextLines(buildSessionContext(root, task.id)).join("\n");
  assert.deepEqual(knit(root, "context", task.id), { code: 0, stdout: `${full}\n`, stderr: "" });
  assert.deepEqual(standardPaths(full), [...discussionPaths, development]);
  assert.ok(full.includes(`目录: ${task.dir}`));
  const path = join(root, `.knit/.runtime/host-sessions/agy-${session}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ taskId: task.id, lastDigest: createHash("sha256").update(full).digest("hex") }));
  const payload = { cwd: root, conversationId: session };
  const injected = async () => (await agyHostHook("PreInvocation", payload)).injectSteps[0].systemMessage.systemMessage;
  const migrated = await injected();
  assert.deepEqual(standardPaths(migrated), [...discussionPaths, development]);
  assert.match(migrated, /^状态: ready$/m);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.taskId, task.id);
  assert.equal(state.lastDigest, undefined);
  assert.match(state.digests.status, /^[a-f0-9]{64}$/);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});

  const record = join(root, task.dir, "record.json");
  const original = readFileSync(record);
  writeFileSync(record, "{");
  const error = await injected();
  assert.match(error, /读不出来[\s\S]*record\.json[\s\S]*不是合法的 JSON/);
  assert.deepEqual(standardPaths(error), []);
  assert.deepEqual(await agyHostHook("PreInvocation", payload), {});
  writeFileSync(record, original);
  const restored = await injected();
  assert.match(restored, /^状态: ready$/m);
  assert.deepEqual(standardPaths(restored), []);
});

test("交付只接受本次调用的预览选项或转录中完整的用户原话", async (t) => {
  const cwd = project(t);
  const payload = { cwd, conversationId: session, transcriptPath: join(cwd, "transcript.jsonl") };
  const row = (content, type = "USER_INPUT", source = "USER_EXPLICIT") => JSON.stringify({ step_index: 1, source, type, status: "DONE", content });
  const user = (text) => row(`<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n元数据\n</ADDITIONAL_METADATA>`);
  writeFileSync(payload.transcriptPath, [user("先不要交付"), user("同意交付这个任务"), user("第一行\n  同意交付 A  "),
    row("模型原话", "PLANNER_RESPONSE", "MODEL")].join("\n"));
  for (const command of ["git status", "command -v knit deliver", "echo 'knit deliver id'", "knit deliver id --preview", "knit deliver id --authorization='同意交付这个任务'",
    'knit deliver id --message "fix: 文案含空格" --preview',
    'knit deliver id --message "fix: 文案含空格" --authorization "同意交付这个任务"',
    'knit deliver id --message="fix: 文案含空格" --authorization "同意交付这个任务"',
    'knit deliver --preview "$TASK_ID"', 'knit deliver id --dir "$PWD/sub dir" --preview',
    `knit deliver id --dir="$PWD/sub dir" --authorization '同意交付这个任务'`,
    "printf 中文 && env DEBUG=1 knit deliver --dir '目录 A' id --authorization ' 同意交付 A '",
    `bash show-arguments.sh -c 'knit context --unuse'`, `sh -c 'echo knit deliver'`,
    `knit deliver id --dir "$PWD" --authorization '同意交付这个任务'`,
    "A=1 knit deliver id --authorization '第一行\n  同意交付 A  '"]) assert.deepEqual(await preTool(payload, command), { decision: "allow" }, command);
  for (const command of ["knit deliver id", "knit deliver id --authorization 交付", "knit deliver id --authorization 伪造",
    "knit deliver id --authorization 元数据", "knit deliver id --authorization 模型原话", "knit deliver id --authorization=$QUOTE",
    'knit deliver id --message="fix: 文案含空格" --authorization "原话不匹配"',
    'knit deliver id --message "--preview"',
    'knit deliver id --message $(printf dynamic) --authorization "同意交付这个任务"',
    'knit deliver id --message=$(printf dynamic) --preview',
    'knit deliver id --preview --message=$(printf dynamic)',
    'knit deliver id --preview --message $TEXT --authorization "同意交付这个任务"',
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

test("环境预检使用 AGY 默认执行者，桌面钩子放行预检", async (t) => {
  isolateEnvironment(t);
  delete process.env.KNIT_SESSION_AGENT;
  const cwd = project(t);
  const payload = { cwd, conversationId: session };
  const validate = "knit workflow validate --env";
  assert.deepEqual(await preTool(payload, validate), { decision: "allow", overwrite: {
    CommandLine: `env KNIT_SESSION_AGENT="\${KNIT_SESSION_AGENT-antigravity}" ${validate}`,
  } });
  for (const command of [`KNIT_SESSION_AGENT=pi ${validate}`, `env KNIT_SESSION_AGENT=pi ${validate}`, "knit workflow validate", "knit workflow validate --dir '--env'"]) {
    assert.deepEqual(await preTool(payload, command), { decision: "allow" });
  }
  process.env.KNIT_SESSION_AGENT = "pi";
  assert.deepEqual(await preTool(payload, validate), { decision: "allow" });
  for (const command of [validate, `KNIT_SESSION_AGENT=pi ${validate}`]) {
    assert.equal(await buddyPreTool(cwd, command), null);
    assert.equal(await qoderHostHook("pre-tool-use", { cwd, session_id: session, tool_name: "Bash", tool_input: { command } }), null);
  }
  assert.equal((await preTool(payload, `${validate} && knit deliver id`)).decision, "deny");
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

test("WorkBuddy 改写 Bash 命令时保留其余工具参数", async () => {
  const fields = { timeout: 120000, description: "调用 Knit", run_in_background: false };
  for (const command of ["knit context --use k-test", "knit context --unuse", "knit task new --title 示例"]) {
    const toolInput = Object.freeze({ command, ...fields });
    const result = await workbuddyHostHook("pre-tool-use", { session_id: buddySession, tool_name: "Bash", tool_input: toolInput });
    assert.deepEqual(result, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: {
      ...fields, command: `env KNIT_HOST=workbuddy KNIT_HOST_SESSION='${buddySession}' ${command}`,
    } } });
  }
});

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
  const development = writeStandard(cwd, "development", "title: 开发规范\nstages: [implement]", "验证输出。");
  const first = await buddyHook(start);
  assert.equal(first.hookEventName, "SessionStart");
  assert.deepEqual(standardPaths(first.additionalContext), discussionPaths);
  assert.ok(first.additionalContext.includes(unselected));
  assert.match(first.additionalContext, /原生子 Agent[\s\S]*不调用 knit run start/);
  assert.doesNotMatch(first.additionalContext, /dangerouslyDisableSandbox|run_in_background/);
  assert.equal(await buddyHook(prompt), null);
  symlinkSync(cli, join(plain, "knit"));
  const select = async (command) => {
    const result = await buddyPreTool(cwd, command);
    assert.equal(result.hookEventName, "PreToolUse");
    assert.match(result.updatedInput.command, /KNIT_HOST=workbuddy KNIT_HOST_SESSION=/);
    const ran = spawnSync("/bin/sh", ["-c", result.updatedInput.command], { cwd, env: { ...process.env, PATH: `${plain}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
  };
  const refreshed = async (expectedStatus, paths = [], payload = prompt) => {
    const output = await buddyHook(payload);
    assert.equal(output.hookEventName, "UserPromptSubmit");
    assert.match(output.additionalContext, expectedStatus);
    assert.deepEqual(standardPaths(output.additionalContext), paths);
    assert.doesNotMatch(output.additionalContext, /WorkBuddy 是桌面 GUI 主会话宿主|不调用 knit run start/);
    return output.additionalContext;
  };
  await select(`knit context --use ${task.id}`);
  const selected = await refreshed(/^状态: ready$/m, [development]);
  assert.ok(selected.includes(`目录: ${task.dir}`));
  await select(`knit context --use ${task.id}`);
  assert.equal(await buddyHook(prompt), null);
  assert.equal(cancelTask(cwd, task.id, { reason: "结束" }).kind, "cancelled");
  await refreshed(/^状态: cancelled$/m, [], { ...prompt, is_internal_continuation: true });
  const other = readyTask(cwd, { verification: "self" });
  await select(`knit context --use ${other.id}`);
  await refreshed(/^状态: ready$/m, [development]);
  assert.equal(await buddyHook(prompt), null);
  assert.equal(closeTask(cwd, other.id, { result: "结束", paths: [] }).kind, "done");
  await refreshed(/^状态: done$/m, ["knit:standards/delivery.md"]);
  assert.equal(deliverTask(cwd, other.id, { authorization: "同意交付" }).kind, "delivered");
  const delivered = await refreshed(/^状态: delivered$/m);
  assert.match(delivered, /^目录: \.knit\/tasks\/archive\//m);
  await select("knit context --unuse");
  assert.equal(await refreshed(/没有选中 Knit 任务/), unselected);
  assert.equal(await buddyHook(prompt), null);
});

test("Bash 交付只接受转录中完整的用户原话，预览放行、外部派发被拦截", async (t) => {
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
    assert.equal(Object.hasOwn(result, "updatedInput"), false);
  }
  for (const quote of ["先等等\n同意交付 A", "同意交付 A", "同意交付 B"]) assert.equal(await buddyPreTool(cwd, `${deliver} --authorization '${quote}'`), null);
  writeFileSync(transcript, "");
  assert.equal((await buddyPreTool(cwd, `${deliver} --authorization '同意交付 B'`)).permissionDecision, "deny");
  for (const command of ["knit run start k-test", "KNIT_SESSION_AGENT=pi knit run start k-test", "sh -c 'knit run start k-test'", `sh -c "knit run start $ID"`]) {
    const denied = await buddyPreTool(cwd, command);
    assert.equal(denied.permissionDecision, "deny", command);
    assert.match(denied.permissionDecisionReason, /原生子 Agent[\s\S]*knit run start/);
    assert.equal(Object.hasOwn(denied, "updatedInput"), false);
  }
  for (const command of ["git status", `${deliver} --preview`, "knit run status k-test"]) assert.equal(await buddyPreTool(cwd, command), null);
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

test("Qoder 保留 Bash 工具参数，按会话选择任务并提示原生派发方式", async (t) => {
  isolateEnvironment(t);
  const cwd = project(t);
  const plain = process.env.KNIT_HOME;
  const { task } = initProject(cwd);
  const payload = { session_id: "session's id", cwd, tool_name: "Bash" };
  const preTool = (tool_input, tool_name = "Bash") => qoderHostHook("pre-tool-use", { ...payload, tool_name, tool_input });
  process.env.QODER_PROJECT_DIR = plain;
  process.env.CLAUDE_PROJECT_DIR = cwd;
  assert.equal(await qoderHostHook("session-start", { ...payload, cwd: "" }), null);
  delete process.env.QODER_PROJECT_DIR;
  const first = (await qoderHostHook("session-start", { ...payload, cwd: "" })).hookSpecificOutput;
  assert.equal(first.hookEventName, "SessionStart");
  assert.deepEqual(standardPaths(first.additionalContext), discussionPaths);
  assert.ok(first.additionalContext.includes(unselected));
  assert.match(first.additionalContext, /Qoder 自身工具与原生子 Agent/);
  assert.equal(await qoderHostHook("user-prompt-submit", payload), null);
  const fields = { description: "选择草稿", timeout: 3000, run_in_background: false };
  symlinkSync(cli, join(plain, "knit"));
  for (const command of [`knit context --use ${task.id}`, "knit context --unuse", "knit task new --title 示例"]) {
    const output = (await preTool({ command, ...fields })).hookSpecificOutput;
    assert.deepEqual(output, { hookEventName: "PreToolUse", updatedInput: {
      ...fields, command: `env KNIT_HOST=qoder KNIT_HOST_SESSION='session'\\''s id' ${command}`,
    } });
    if (command.startsWith("knit task new")) continue;
    const ran = spawnSync("/bin/sh", ["-c", output.updatedInput.command], { cwd, env: { ...process.env, PATH: `${plain}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const prompt = (await qoderHostHook("user-prompt-submit", payload)).hookSpecificOutput;
    assert.equal(prompt.hookEventName, "UserPromptSubmit");
    assert.deepEqual(standardPaths(prompt.additionalContext), []);
    assert.ok(prompt.additionalContext.includes(command.includes("--use") ? task.id : unselected));
  }
  const denied = (await preTool({ command: "true && knit run start k-test" })).hookSpecificOutput;
  assert.equal(denied.hookEventName, "PreToolUse");
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Qoder 自身工具与原生子 Agent 完成实现和检查.*普通终端、Pi 或 Antigravity/);
  assert.equal(await preTool({ command: "knit run start id" }, "Other"), null);
  assert.equal(await preTool({ command: 1 }), null);
});

test("Qoder JSONL 授权只采用真实输入的整条或完整一行，排除宿主元数据与残缺标签", async (t) => {
  const cwd = project(t);
  const user = (content) => ({ type: "user", origin: { kind: "human" }, humanInput: { mode: "prompt" }, isMeta: false,
    message: { role: "user", content } });
  const text = (body) => ({ type: "text", text: body });
  const meta = [{ isMeta: true }, { isCompactSummary: true }, { isVisibleInTranscriptOnly: true }, { toolUseResult: null },
    { origin: { kind: "agent" } }, { humanInput: { mode: "tool" } }, { type: "assistant" }];
  const body = "审查结束\n同意交付这个任务";
  const rows = [user(body), user([text("允许归档"), text('<system-reminder from="hook">\n系统提醒\n</system-reminder>'),
    text("<hook_context>\n钩子提示\n<loaded_context>\n加载内容\n</loaded_context>\n嵌套结尾\n</hook_context>")]),
    { type: "user", message: { content: "省略可选字段" } }, { ...user(""), message: { role: "assistant", content: "助手" } },
    user([text("工具伴随文本"), { type: "tool_result", content: "工具结果" }]),
    user("<loaded_context>\n残缺提醒"), user("<hook_context\n残缺开始"), user("孤立结束\n</system-reminder>"),
    user("<hook_context><hook_context>内层</hook_context>\n外层未闭合"),
    ...meta.map((flags, index) => ({ ...user(`合成${index}`), ...flags }))];
  const payload = { cwd, session_id: session, transcript_path: `${session}.jsonl`, tool_name: "Bash" };
  const invoke = (command) => qoderHostHook("pre-tool-use", { ...payload, tool_input: { command } });
  const check = (quote) => invoke(`knit deliver id --authorization '${quote}'`);
  assert.equal(await invoke("knit deliver id --preview"), null);
  assert.equal((await check(body)).hookSpecificOutput.permissionDecision, "deny");
  writeFileSync(join(cwd, payload.transcript_path), rows.map((row) => JSON.stringify(row)).join("\n"));
  for (const quote of [body, "同意交付这个任务", "允许归档", "省略可选字段"]) assert.equal(await check(quote), null, quote);
  for (const quote of ["伪造", "同意交付", "助手", "系统提醒", "钩子提示", "加载内容", "嵌套结尾", "工具伴随文本", "工具结果",
    "残缺提醒", "残缺开始", "孤立结束", "外层未闭合", ...meta.map((_, index) => `合成${index}`)]) {
    const output = (await check(quote)).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny", quote);
    assert.match(output.permissionDecisionReason, /--authorization/);
  }
});

for (const [host, projectDir] of [["workbuddy", "CODEBUDDY_PROJECT_DIR"], ["qoder", "QODER_PROJECT_DIR"]]) test(`${host} 已安装的项目钩子在 GUI 极简 PATH 下加载工作区与当前版本的 CLI`, (t) => {
  const root = project(t);
  initProject(root, false, { [host]: true });
  const home = process.env.KNIT_HOME;
  const shims = join(home, ".local/share/mise/shims");
  mkdirSync(shims, { recursive: true });
  symlinkSync(cli, join(shims, "knit"));
  writeFileSync(join(shims, "node"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$KNIT_TEST_NODE_CALLS"\nexec "$KNIT_TEST_NODE" "$@"\n', { mode: 0o755 });
  const nodeCalls = join(home, "node-calls");
  const hooks = JSON.parse(readFileSync(join(root, `.${host}/settings.json`))).hooks;
  assert.equal(hooks.PreToolUse[0].matcher, "^Bash$");
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", [projectDir]: root,
    KNIT_TEST_NODE_CALLS: nodeCalls, KNIT_TEST_NODE: process.execPath };
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
  assert.equal(readFileSync(nodeCalls, "utf8"), `-v\n${join(shims, "knit")}\n`.repeat(3));
});

test("桌面钩子遇到 Node 22 或缺少 knit 时由登录 shell 启动", (t) => {
  const root = project(t);
  initProject(root, false, { workbuddy: true, qoder: true });
  const home = process.env.KNIT_HOME;
  const shims = join(home, ".local/share/mise/shims");
  const loginBin = join(home, "login-bin");
  const calls = join(home, "calls");
  mkdirSync(shims, { recursive: true });
  mkdirSync(loginBin);
  symlinkSync(cli, join(shims, "knit"));
  symlinkSync(cli, join(loginBin, "knit"));
  symlinkSync(process.execPath, join(loginBin, "node"));
  writeFileSync(join(shims, "node"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$KNIT_TEST_CALLS"\n[ "$1" = -v ] || exit 99\nprintf "v22.0.0\\n"\n', { mode: 0o755 });
  writeFileSync(join(home, ".profile"), 'printf "login\\n" >> "$KNIT_TEST_CALLS"\nexport PATH="$KNIT_TEST_LOGIN_BIN:$PATH"\n');
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh",
    KNIT_TEST_CALLS: calls, KNIT_TEST_LOGIN_BIN: loginBin };
  const hook = join(root, ".workbuddy/knit-hook.sh");
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: buddySession, cwd: root,
    tool_name: "Bash", tool_input: { command: "knit deliver id" } });
  // 模拟找不到 knit，不依赖机器的 Homebrew 等固定 PATH 目录是否装了 knit。
  const scenarios = [
    { name: "Node 22", args: [hook, "pre-tool-use"], calls: "-v\nlogin\n" },
    { name: "缺少 knit", args: ["-c", 'command() { return 1; }; . "$0"', hook, "pre-tool-use"], calls: "login\n" },
  ];
  const qoder = spawnSync("/bin/sh", [join(root, ".qoder/knit-hook.sh"), "session-start"], { cwd: root, env, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: root }) });
  assert.equal(qoder.status, 0, qoder.stderr);
  assert.equal(JSON.parse(qoder.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(readFileSync(calls, "utf8"), "-v\nlogin\n");
  for (const scenario of scenarios) {
    writeFileSync(calls, "");
    const result = spawnSync("/bin/sh", scenario.args, { cwd: root, env, input, encoding: "utf8" });
    assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", scenario.name);
    assert.equal(readFileSync(calls, "utf8"), scenario.calls, scenario.name);
  }
});
