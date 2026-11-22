import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AntigravityExecutionAdapter, cleanAgyRuntime } from "../dist/adapters/antigravity/execution.js";
import { loadConfig } from "../dist/application/config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit } from "./helpers/cli.mjs";
import { loadBridge } from "./helpers/bridge.mjs";
import { commitAll } from "./helpers/git.mjs";
import { agents, readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

const isolated = { skip: process.platform !== "darwin" && "需要 macOS sandbox-exec" };
const runDir = (root, run) => join(root, ".knit/.runtime/runs", run.id);
const readRows = (path) => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
const lastRun = (root, task) => JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8")).runs.at(-1);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const runKnit = (root, ...args) => {
  const result = knit(root, ...args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
};
async function until(predicate) {
  for (const _ of Array.from({ length: 200 })) {
    const result = predicate();
    if (result) return result;
    await sleep(50);
  }
  assert.fail("等了 10 秒");
}

function fixture(t, { tools = "[read, write, exec]", agent = "    agent: antigravity\n", options = "", stage = "review", rex = false, failure = false, environment = {} } = {}) {
  const root = runProject(t);
  const dir = mkdtempSync("/private/tmp/knit-test-agy-");
  const home = join(dir, "home");
  const state = join(home, ".gemini/antigravity-cli");
  const brain = join(state, "brain");
  mkdirSync(state, { recursive: true });
  const agy = join(dir, "agy");
  const fake = fileURLToPath(new URL("./helpers/fake-agy.mjs", import.meta.url));
  writeFileSync(agy, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`);
  chmodSync(agy, 0o755);
  const env = { ...environment, HOME: home, KNIT_AGY_BIN: agy };
  if (rex) {
    symlinkSync(fileURLToPath(new URL("./helpers/fake-rex.mjs", import.meta.url)), join(dir, "rex"));
    Object.assign(env, { KNIT_FAKE_REX: dir, REX_SESSION: "session:1", REX_BLOCK: "block:1", PATH: `${dir}:${process.env.PATH}` });
    if (failure) writeFileSync(join(dir, "fail"), "session.new_layer");
  }
  const previous = Object.fromEntries([...Object.keys(env), "KNIT_FAKE_AGY", "KNIT_SESSION_AGENT"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const report = stage === "review" ? "    report:\n      verdict: [pass, changes_requested, blocked]\n" : "";
  const configure = () => writeFileSync(join(root, ".knit/workflow.yaml"),
    `version: 1\nmodel: pi/default\nthinking: off\nstages:\n  - id: ${stage}\n${agent}${options}${tools === null ? "" : `    tools: ${tools}\n`}${report}`);
  configure();
  commitAll(root, "agy workflow");
  const task = readyTask(root);
  t.after(async () => {
    const run = existsSync(root) ? lastRun(root, task) : undefined;
    if (run?.endedAt === null) knit(root, "run", "cancel", task.id);
    if (run?.id && existsSync(join(runDir(root, run), "worker.json"))) {
      const { pid } = JSON.parse(readFileSync(join(runDir(root, run), "worker.json"), "utf8"));
      await until(() => !alive(pid));
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      if (value !== undefined) process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, dir, home, brain, state, task, configure,
    start: (script, ...args) => {
      process.env.KNIT_FAKE_AGY = JSON.stringify(script);
      return runKnit(root, "run", "start", task.id, ...args);
    },
    ended: () => until(() => {
      const run = lastRun(root, task);
      return run?.endedAt ? run : null;
    }),
    transcripts: () => existsSync(brain) ? readdirSync(brain).map((path) => join(brain, path)) : [],
  };
}

function addDetachedService(f) {
  writeFileSync(join(f.root, "service.mjs"), `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const service = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true, stdio: "ignore", env: {},
    });
    writeFileSync("service.pid", String(service.pid));
    service.unref();
  `);
  commitAll(f.root, "detached service fixture");
}

test("显式 agent、模型和 effort 配置报告各自的行号", (t) => {
  const root = runProject(t);
  writeFileSync(join(root, ".knit/workflow.yaml"), `version: 1\nstages:\n  - id: a\n    agent: other\n  - id: b\n    agent: antigravity\n    model: pi/model\n    thinking: minimal\n  - id: c\n    agent: pi\n    model: gemini-3\n`);
  const result = knit(root, "workflow", "validate");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /第 4 行：.*pi／antigravity/);
  assert.match(result.stderr, /第 7 行：.*Antigravity 模型 ID/);
  assert.match(result.stderr, /第 8 行：.*low／medium／high／xhigh／max/);
  assert.match(result.stderr, /第 11 行：.*provider\/模型/);
});

test("后台同一 stream 会话只补报一次，省略 agy 参数，run wait 通知原 Pi", isolated, async (t) => {
  const f = fixture(t, { tools: "all" });
  const bridge = await loadBridge(t, f.root, { onMessage: (message, options) => {
    assert.equal(lastRun(f.root, f.task).verdict, "pass");
    assert.match(message.content, /^Agent: antigravity$/m);
    assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
  } });
  f.configure();
  process.env.KNIT_FAKE_AGY = JSON.stringify({ retry: true });
  const started = await bridge.tool("knit_run", { action: "start", taskId: f.task.id }, { model: { provider: "host", id: "model" }, thinkingLevel: "high" });
  assert.equal(started.isError, undefined, started.content[0].text);
  const run = await f.ended();
  assert.equal(run.agent, "antigravity");
  assert.equal(run.verdict, "pass", run.failure);
  const events = readRows(join(f.root, run.sessionFile));
  assert.equal(events.filter((event) => event.event === "init").length, 1);
  assert.equal(events.filter((event) => event.event === "result").length, 2);
  const transcript = readRows(f.transcripts()[0]);
  assert.ok(!transcript[0].args.some((arg) => /^--(?:model|effort)/.test(arg)));
  assert.match(transcript.findLast((row) => row.type === "USER_INPUT").content, /不要重新做一遍/);
  await until(() => bridge.messages.length === 1);
  assert.match(runKnit(f.root, "run", "wait", f.task.id), /^Agent: antigravity$/m);
  await sleep(250);
  assert.equal(bridge.messages.length, 1);
});

const waiting = "KNIT_AGY_WAITING\n请提供测试输入";
const unmarked = "审查完成\n```json\n{\"verdict\":\"pass\"}\n```";
for (const { stage, responses, failure } of [
  { stage: "implement", responses: [unmarked, "KNIT_AGY_SUBMIT\n完成实现"] },
  { stage: "implement", responses: [waiting, waiting], failure: true },
  { stage: "review", responses: [waiting, "KNIT_AGY_SUBMIT\n缺少结论", `KNIT_AGY_SUBMIT\n${unmarked}`] },
  { stage: "review", responses: [unmarked, ""], failure: true },
]) {
  test(`后台 ${stage} 漏标或等待后在原会话追问，${failure ? "再次未提交时退出" : "提交后校验报告"}`, isolated, async (t) => {
    const f = fixture(t, { stage, tools: "[]" });
    f.start({ responses });
    const run = await f.ended();
    const rows = readRows(f.transcripts()[0]);
    const messages = rows.filter((row) => row.type === "USER_INPUT");
    assert.deepEqual(messages.length, responses.length);
    assert.match(messages[1].content, /后台.*第一行.*KNIT_AGY_SUBMIT.*完整报告/);
    if (messages.length === 3) assert.match(messages[2].content, /不要重新做一遍/);
    assert.ok(!alive(rows[0].pid));
    const report = join(runDir(f.root, run), "report.md");
    if (failure) {
      assert.match(run.failure, /后台追问后仍未.*提交报告/);
      assert.equal(run.verdict, null);
      assert.ok(!existsSync(report));
      return;
    }
    assert.equal(run.failure, null);
    assert.equal(run.verdict, stage === "review" ? "pass" : null);
    assert.equal(readFileSync(report, "utf8"), responses.at(-1).split("\n").slice(1).join("\n"));
  });
}

test("后台明确报告权限阻塞时保留模型与工具的原因", isolated, async (t) => {
  const f = fixture(t, { tools: "[]" });
  f.start({ denied: true, responses: ["KNIT_AGY_PERMISSION_BLOCKED\n必要操作被拒"] });
  assert.match((await f.ended()).failure, /Antigravity 权限阻塞：必要操作被拒.*deny rule.*denied_actions/);
});

test("Rex 同轮被钩子拒绝和用户拒批后仍可提交有效报告", isolated, async (t) => {
  const f = fixture(t, { rex: true });
  f.start({ tools: [
    { name: "search_web", args: {} },
    { name: "run_command", args: { CommandLine: "pwd" }, decline: true },
  ] });
  const run = await f.ended();
  assert.equal(run.verdict, "pass", run.failure);
  const rows = readRows(run.sessionFile);
  assert.equal(rows.filter((row) => row.type === "USER_INPUT").length, 1);
  assert.deepEqual(rows.filter((row) => row.status === "ERROR").map((row) => row.error.message),
    ["Knit：search_web 需要 network", "User declined the tool call"]);
});

test("Rex 创建窗格失败时保留 Agent 和覆盖值，SUCCESS 保留 denied_actions 和工具错误", isolated, async (t) => {
  const f = fixture(t, { rex: true, failure: true, agent: "", options: "    model: own-model\n    thinking: low\n" });
  process.env.KNIT_SESSION_AGENT = "antigravity";
  f.start({ denied: true }, "--model", "override-id", "--thinking", "xhigh");
  const run = await f.ended();
  assert.equal(run.agent, "antigravity");
  assert.match(run.failure, /Matches user-configured deny rule.*Tool permission denied.*denied_actions:.*write_file/);
  assert.match(readFileSync(join(runDir(f.root, run), "worker.log"), "utf8"), /改在后台执行/);
  const args = readRows(f.transcripts()[0])[0].args;
  assert.ok(args.includes("--model=override-id") && args.includes("--effort=xhigh"));
});

test("Rex 等追加输入，以原命令显示批准与拒绝，并在原会话补报", isolated, async (t) => {
  const f = fixture(t, { rex: true, options: "    model: stage-model\n    thinking: medium\n" });
  const retainedAsk = ["write_file(*)", "command(git push)", "command(regex:git)", "command(regex:.* --version)"];
  const permissions = { allow: ["command(git status)"], ask: ["command(*)", "command(regex:(?i)/private/tmp/knit-agy-exec-.*/RUN-COMMAND)", ...retainedAsk], deny: ["command(git push)"] };
  writeFileSync(join(f.state, "settings.json"), JSON.stringify({ permissions }));
  const cwd = worktreeOf(f.root, f.task);
  const gate = join(cwd, "input-ready");
  const command = (line, decline = false) => ({ name: "run_command", args: { CommandLine: line, Cwd: cwd }, decline });
  const allow = "printf approved > approved.txt";
  const reject = "printf declined > declined.txt";
  f.start({ wait: gate, retry: true, tools: [command(allow), command(reject, true)] });
  await until(() => f.transcripts().some((path) => readFileSync(path, "utf8").includes('"type":"PLANNER_RESPONSE","content":"KNIT_AGY_WAITING')));
  assert.equal(lastRun(f.root, f.task).endedAt, null);
  assert.match(runKnit(f.root, "run", "status", f.task.id), /^Agent: antigravity$/m);
  assert.ok(existsSync(join(cwd, "approved.txt")), readFileSync(f.transcripts()[0], "utf8"));
  assert.equal(readFileSync(join(cwd, "approved.txt"), "utf8"), "approved");
  assert.ok(!existsSync(join(cwd, "declined.txt")));
  writeFileSync(gate, "");
  const run = await f.ended();
  assert.equal(run.verdict, "pass", run.failure);
  const transcript = readRows(run.sessionFile);
  assert.deepEqual(transcript.filter((row) => row.type === "APPROVAL").map((row) => [row.result.decision, row.result.permissionOverrides]), [
    ["ask", [`command(${allow})`]], ["ask", [`command(${reject})`]],
  ]);
  assert.ok(transcript[0].args.includes("--model=stage-model") && transcript[0].args.includes("--effort=medium"));
  const commandEntry = transcript.find((row) => row.type === "APPROVAL").result.overwrite.CommandLine.split(" ").at(-1);
  const handoff = [join(f.root, ".knit/tasks"), join(f.root, ".knit/.runtime/runs")].map((path) => realpathSync.native(path));
  assert.deepEqual(transcript[0].settings.permissions, {
    ask: retainedAsk,
    allow: [...permissions.allow, `command(${commandEntry})`, ...handoff.map((dir) => `read_file(${dir})`)],
    deny: [...permissions.deny, ...handoff.map((dir) => `write_file(${dir})`), `read_file(${realpathSync.native(runDir(f.root, run))})`,
      "mcp(*)", "read_url(*)", "execute_url(*)"],
  });
  assert.equal(transcript.filter((row) => row.type === "USER_INPUT").length, 3);
  assert.ok(!existsSync(join(cwd, ".agents/hooks.json")));
});

test("Rex 未收到提交回执时仍可追加输入，执行达到上限后记录原因", isolated, async (t) => {
  const f = fixture(t, { rex: true });
  const gate = join(worktreeOf(f.root, f.task), "input-ready");
  f.start({ wait: gate, unmarked: true, limit: true });
  await until(() => f.transcripts().some((path) => readFileSync(path, "utf8").includes('"content":"请提供测试输入"')));
  assert.equal(lastRun(f.root, f.task).endedAt, null);
  writeFileSync(gate, "");
  const run = await f.ended();
  assert.match(run.failure, /Antigravity 执行出错：max_steps_exceeded/);
  assert.ok(!existsSync(join(runDir(f.root, run), "report.md")));
});

for (const write of [false, true]) {
  const tools = write ? "[read, write, exec]" : "[read, exec]";
  test(`run_command 在 ${tools} 下使用独立 TMPDIR 和宿主环境`, isolated, async (t) => {
    const privateKeys = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_OFFLINE"];
    const environment = Object.fromEntries(privateKeys.map((key) => [key, "private"]));
    const f = fixture(t, { tools, environment: { ...environment, LOGNAME: "fixture-user", GOPATH: "/fixture/go" } });
    mkdirSync(join(f.root, "nested"));
    writeFileSync(join(f.root, "nested/input"), "relative input\n");
    commitAll(f.root, "here-doc working directory fixture");
    const command = (CommandLine) => ({ name: "run_command", args: { CommandLine, Cwd: "nested" } });
    f.start({ tools: [
      command('printf "%s %s\\n" "$LOGNAME" "$GOPATH" > "$TMPDIR/leftover" && cat "$TMPDIR/leftover" && echo "$TMPDIR"'),
      command('cat <<EOF\nhere-doc in ${PWD##*/}: $(cat input)\nEOF'),
      command(`env | grep -E '^(${privateKeys.join("|")})='`),
      command('touch "$TMPDIR/../run-command" "$TMPDIR/../tool.sock"'),
      command("touch project-result"),
    ] });
    const run = await f.ended();
    assert.equal(run.verdict, "pass", run.failure);
    const [temp, heredoc, env, control, worktree] = readRows(f.transcripts()[0]).find((row) => row.type === "TOOL_CHECKS").checks;
    assert.equal(temp.code, 0, temp.stderr);
    const [values, path] = temp.stdout.trim().split("\n");
    assert.equal(values, "fixture-user /fixture/go");
    assert.match(path, /^\/private\/tmp\/knit-agy-exec-[^/]+\/tmp$/);
    assert.ok(!existsSync(dirname(path)));
    assert.equal(heredoc.code, 0, heredoc.stderr);
    assert.equal(heredoc.stdout, "here-doc in nested: relative input\n");
    assert.equal(env.code, 1, env.stderr);
    assert.equal(env.stdout, "");
    assert.match(control.stderr, /run-command: Operation not permitted/);
    assert.match(control.stderr, /tool.sock: Operation not permitted/);
    assert.equal(worktree.code, write ? 0 : 1, worktree.stderr);
    if (!write) assert.match(worktree.stderr, /project-result: Operation not permitted/);
    assert.deepEqual(run.changedPaths, write ? ["nested/project-result"] : []);
    cleanAgyRuntime(worktreeOf(f.root, f.task), runDir(f.root, run));
  });
}

for (const order of ["结算先清理", "会话先收尾", "窗格删除定位文件时结算"]) {
  test(`跟踪器返回非零时清理文件并结算，${order}`, isolated, async (t) => {
    const f = fixture(t);
    const workflow = parseWorkflow(readFileSync(join(f.root, ".knit/workflow.yaml"), "utf8")).workflow;
    const prepared = prepareRun({ root: f.root, taskId: f.task.id, workflow, config: loadConfig(f.root).config, model: null });
    assert.deepEqual(prepared.problems, []);
    const cwd = worktreeOf(f.root, f.task);
    const dir = join(f.root, prepared.run.dir);
    const session = new AntigravityExecutionAdapter().createSession({ root: f.root, cwd, dir, capabilities: ["read", "exec"], model: null, thinking: null, report: {} });
    assert.equal(await session.start(), null);
    t.after(() => session.stop());
    const locator = join(dir, "agy-temp-path");
    const original = readFileSync(locator, "utf8");
    // 真实跟踪器对超长 scope 返回 2。保留运行目录里的实际 socket、入口和 tmp 子目录。
    const path = `${original}${"x".repeat(128)}`;
    renameSync(original, path);
    writeFileSync(locator, path);
    t.after(() => rmSync(path, { recursive: true, force: true }));
    const finish = () => assert.deepEqual(finishRun({ root: f.root, taskId: f.task.id, runId: prepared.run.id, workflow, agents,
      verdict: "pass", failure: order === "结算先清理" ? "已取消" : null, sessionFile: null }), []);
    if (order === "窗格删除定位文件时结算") {
      // 只控制两次清理的先后，删除文件、回收进程和写入执行记录都走真实实现。
      const remove = rmSync;
      const hook = t.mock.method(fs, "rmSync", (file, options) => {
        remove(file, options);
        if (file === locator) finish();
      });
      syncBuiltinESMExports();
      try { await session.stop(); } finally { hook.mock.restore(); syncBuiltinESMExports(); }
    }
    if (order === "会话先收尾") await session.stop();
    if (order !== "窗格删除定位文件时结算") finish();
    const run = lastRun(f.root, f.task);
    assert.ok(Number.isFinite(Date.parse(run.endedAt)));
    assert.equal(run.verdict, null);
    assert.match(run.failure, /Antigravity 命令进程回收失败：2/);
    if (order === "结算先清理") assert.match(run.failure, /已取消/);
    assert.deepEqual(run.changedPaths, []);
    for (const file of [path, locator, join(cwd, ".agents/hooks.json")]) assert.ok(!existsSync(file), file);
    assert.throws(() => cleanAgyRuntime(cwd, dir), /Antigravity 命令进程回收失败：2/);
  });
}

test("后台正常结算前停止已脱离父进程和进程组的命令服务", isolated, async (t) => {
  const f = fixture(t);
  addDetachedService(f);
  const cwd = worktreeOf(f.root, f.task);
  f.start({ tools: [{ name: "run_command", args: { Cwd: cwd, CommandLine: "node service.mjs" } }] });
  const run = await f.ended();
  const pid = Number(readFileSync(join(cwd, "service.pid"), "utf8"));
  assert.ok(pid > 0);
  t.after(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); });
  assert.equal(run.verdict, "pass", run.failure);
  const checks = readRows(f.transcripts()[0]).find((row) => row.type === "TOOL_CHECKS").checks;
  assert.equal(checks[0].code, 0, checks[0].stderr);
  assert.ok(!alive(pid), "执行已入账，脱离进程组的命令服务仍在运行");
});

test("后台命令的转发客户端被终止时，在会话结束前回收命令", isolated, async (t) => {
  const f = fixture(t, { rex: true });
  const cwd = worktreeOf(f.root, f.task);
  const gate = join(cwd, "input-ready");
  const pidFile = join(cwd, "command.pid");
  f.start({ wait: gate, tools: [{ name: "run_command", args: { CommandLine: "echo $$ > command.pid; exec sleep 60" }, background: true }] });
  const pid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")));
  assert.ok(alive(pid));
  const checks = readRows(f.transcripts()[0]).find((row) => row.type === "TOOL_CHECKS").checks;
  process.kill(checks[0].pid, "SIGKILL");
  await until(() => !alive(pid));
  assert.equal(lastRun(f.root, f.task).endedAt, null);
  writeFileSync(gate, "");
  const run = await f.ended();
  assert.equal(run.verdict, "pass", run.failure);
});

test("直接取消结束 agy、同组命令和已脱离父进程的服务，结果由 Pi 工具返回", isolated, async (t) => {
  const f = fixture(t);
  const bridge = await loadBridge(t, f.root);
  f.configure();
  addDetachedService(f);
  const cwd = worktreeOf(f.root, f.task);
  const pidFile = join(cwd, "child.pid");
  const serviceFile = join(cwd, "service.pid");
  process.env.KNIT_FAKE_AGY = JSON.stringify({ long: "node service.mjs; /bin/sleep 60 & echo $! > child.pid; wait" });
  const started = await bridge.tool("knit_run", { action: "start", taskId: f.task.id });
  assert.equal(started.isError, undefined, started.content[0].text);
  const pid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")));
  const service = Number(readFileSync(serviceFile, "utf8"));
  assert.ok(service > 0);
  t.after(() => { if (alive(service)) process.kill(service, "SIGKILL"); });
  assert.ok(alive(service));
  assert.ok(alive(pid));
  const cancelled = await bridge.tool("knit_run", { action: "cancel", taskId: f.task.id });
  assert.match(cancelled.content[0].text, /已取消/);
  assert.equal((await f.ended()).failure, "已取消");
  assert.ok(!alive(pid));
  assert.ok(!alive(service));
  assert.deepEqual(bridge.messages, []);
});

test("Rex 窗格已启动后退出，执行结算失败且不回退", isolated, async (t) => {
  const f = fixture(t, { rex: true });
  f.start({ exit: true });
  const run = await f.ended();
  assert.match(run.failure, /窗格关掉了/);
  assert.equal(f.transcripts().length, 1);
});

test("Rex 在 SessionStart 后取消，从定位文件回填原生转录", isolated, async (t) => {
  const f = fixture(t, { rex: true, tools: "[]" });
  f.start({ pauseAfterStart: true });
  const dir = runDir(f.root, lastRun(f.root, f.task));
  const locator = join(dir, "session-file.txt");
  await until(() => existsSync(locator));
  assert.deepEqual(f.transcripts(), [readFileSync(locator, "utf8")]);
  runKnit(f.root, "run", "cancel", f.task.id);
  const run = await f.ended();
  assert.equal(run.failure, "已取消");
  assert.equal(run.sessionFile, f.transcripts()[0]);
});

test("Rex 关掉仍在执行命令的窗格时停止进程再结算", isolated, async (t) => {
  const f = fixture(t, { rex: true });
  const cwd = worktreeOf(f.root, f.task);
  const pidFile = join(cwd, "child.pid");
  f.start({ pathFromTool: true, tools: [{ name: "run_command", args: { Cwd: cwd, CommandLine: "/bin/sleep 60 & echo $! > child.pid; wait" } }] });
  const pid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")));
  const file = readdirSync(join(f.dir, "layers"))[0];
  execFileSync(join(f.dir, "rex"), ["api", "call", "session.close_layer", JSON.stringify({
    session_id: "session:1", layer_id: `layer:${file.slice(0, -5)}`,
  })]);
  const run = await f.ended();
  assert.match(run.failure, /窗格关掉了/);
  assert.ok(!alive(pid));
  assert.ok(!existsSync(join(cwd, ".agents/hooks.json")));
  assert.deepEqual(f.transcripts(), [run.sessionFile]);
});

for (const tools of ["[read, write, exec]", "[read, write, exec, external, network]", "all", null]) {
  test(`tools ${tools ?? "省略"} 的 external 声明控制外层沙箱读取定制文本`, isolated, async (t) => {
    const f = fixture(t, { tools });
    const workspace = [".agents/skills/demo/SKILL.md", ".agents/rules/demo.md", ".agent/workflows/demo.md",
      "_agents/agents/demo.md", "_agent/skills.json", ".agents/agents.json", ".agents/rules.json"];
    const home = [".gemini/antigravity-cli/skills/demo/SKILL.md", ".gemini/skills/demo/SKILL.md", ".gemini/config/rules/demo.md"]
      .map((path) => join(f.home, path));
    mkdirSync(join(f.root, ".agent"));
    mkdirSync(join(f.root, "team-workflows"));
    symlinkSync("../team-workflows", join(f.root, ".agent/workflows"));
    mkdirSync(join(f.root, "_agent"));
    symlinkSync("../team-plugins.json", join(f.root, "_agent/plugins.json"));
    for (const path of [...workspace.map((path) => join(f.root, path)), ...home]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, path.endsWith(".json") ? "{}" : "# Demo\n");
    }
    const emptyConfigs = [
      [".agents/mcp_config.json", { mcpServers: {} }], [".mcp.json", { mcpServers: {} }], ["_agent/plugins.json", []],
      [join(f.home, ".gemini/config/mcp_config.json"), { mcpServers: null }], [join(f.home, ".gemini/config/plugins.json"), {}],
    ].map(([path, contents]) => {
      writeFileSync(resolve(f.root, path), JSON.stringify(contents));
      return path;
    });
    commitAll(f.root, "text customization fixtures");
    const texts = [...workspace, ...home];
    const external = tools !== "[read, write, exec]";
    f.start({ configReads: [...texts, ...emptyConfigs], configWrites: external ? texts : [] });
    const run = await f.ended();
    assert.equal(run.verdict, "pass", run.failure);
    const result = readRows(f.transcripts()[0])[0];
    assert.deepEqual(result.configReads, [...texts.map(() => external ? "allowed" : "EPERM"), ...emptyConfigs.map(() => "EPERM")]);
    assert.deepEqual(result.configWrites, external ? texts.map(() => "EPERM") : []);
  });
}

const configuredMcp = { mcpServers: { demo: { command: "/usr/bin/true" } } };
const plugin = { name: "demo", version: "1.0.0" };
const enabledPlugins = [{ name: "demo", enabled: true }];
const externalHooks = { demo: { SessionStart: [{ type: "command", command: "/usr/bin/true" }] } };
for (const [location, source, contents] of [
  ["workspace", ".mcp.json", configuredMcp], ["workspace", ".agent/mcp_config.json", configuredMcp],
  ["workspace", ".agents/plugins", plugin], ["workspace", "_agents/plugins.json", enabledPlugins],
  ["workspace", "_agent/hooks.json", externalHooks], ["workspace", ".gemini/config.json", {}],
  ["home", ".gemini/config/mcp_config.json", configuredMcp], ["home", ".gemini/config/plugins", plugin],
  ["home", ".gemini/config/plugins.json", enabledPlugins], ["home", ".gemini/config/hooks.json", externalHooks],
]) {
  test(`external 派发前指出 ${location} 的 ${source}`, isolated, (t) => {
    const f = fixture(t, { tools: "all" });
    const path = join(location === "home" ? f.home : f.root, source);
    const file = source.endsWith("/plugins") ? join(path, "demo/plugin.json") : path;
    if (source === ".agent/mcp_config.json") {
      mkdirSync(join(f.root, "team-config"));
      symlinkSync("team-config", join(f.root, ".agent"));
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(contents));
    if (location === "workspace") commitAll(f.root, "startup configuration fixture");
    const result = knit(f.root, "run", "start", f.task.id);
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes(`无法隔离已配置的外部工具及其运行时写入：${location === "home" ? path : source}`), result.stderr);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });
}

test("组合缺少隔离能力，派发前无 Worktree 或执行记录", isolated, (t) => {
  const f = fixture(t, { tools: "[read, external]" });
  const result = knit(f.root, "run", "start", f.task.id);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /external.*联网/);
  assert.ok(!existsSync(worktreeOf(f.root, f.task)));
  assert.equal(lastRun(f.root, f.task), undefined);
});

test("兼容目录链接会屏蔽 Knit 钩子，在派发前拒绝", isolated, (t) => {
  const f = fixture(t);
  symlinkSync(".agents", join(f.root, ".agent"));
  commitAll(f.root, "hook alias fixture");
  const result = knit(f.root, "run", "start", f.task.id);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /\.agent 指向 \.agents.*隔离钩子/);
  assert.ok(!existsSync(worktreeOf(f.root, f.task)));
  assert.equal(lastRun(f.root, f.task), undefined);
});

test("新 Worktree 在派发前识别 Git 树中的间接兼容目录链接", isolated, (t) => {
  const f = fixture(t, { tools: "[read]" });
  mkdirSync(join(f.root, "links"));
  symlinkSync("../.agents", join(f.root, "links", "custom"));
  symlinkSync("links/custom", join(f.root, ".agent"));
  commitAll(f.root, "indirect hook alias fixture");
  const result = knit(f.root, "run", "start", f.task.id);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /\.agent 指向 \.agents.*隔离钩子/);
  assert.ok(!existsSync(worktreeOf(f.root, f.task)));
  assert.equal(lastRun(f.root, f.task), undefined);
});

test("新 Worktree 在派发前识别配置文件指向 Knit 钩子的链接", isolated, (t) => {
  const f = fixture(t, { tools: "[read]" });
  mkdirSync(join(f.root, ".agent"));
  symlinkSync("../.agents/hooks.json", join(f.root, ".agent/hooks.json"));
  commitAll(f.root, "hook file alias fixture");
  const result = knit(f.root, "run", "start", f.task.id);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /\.agent\/hooks\.json 指向 \.agents.*隔离钩子/);
  assert.ok(!existsSync(worktreeOf(f.root, f.task)));
  assert.equal(lastRun(f.root, f.task), undefined);
});

test("已有 Worktree 的兼容目录链接按实际钩子目录的大小写检查", isolated, async (t) => {
  const f = fixture(t, { tools: "[read]" });
  f.start({ denied: true });
  assert.match((await f.ended()).failure, /Antigravity 权限阻塞/);
  const cwd = worktreeOf(f.root, f.task);
  const agents = join(cwd, ".AgEnTs");
  const canonical = join(cwd, ".agents");
  rmSync(canonical, { recursive: true });
  mkdirSync(agents);
  if (!existsSync(canonical)) return t.skip("需要大小写不敏感的文件系统");
  symlinkSync(".AgEnTs", join(cwd, ".agent"));
  const result = knit(f.root, "run", "start", f.task.id);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /\.agent 指向 \.agents.*隔离钩子/);
  assert.equal(JSON.parse(readFileSync(join(f.root, f.task.dir, "record.json"), "utf8")).runs.length, 1);
});

test("大小写不敏感的检出在派发前识别 Git 树中的钩子冲突", isolated, (t) => {
  const f = fixture(t, { tools: "[read]" });
  mkdirSync(join(f.root, ".AgEnTs"));
  writeFileSync(join(f.root, ".AgEnTs/Hooks.json"), "{}");
  if (!existsSync(join(f.root, ".agents/hooks.json"))) return t.skip("需要大小写不敏感的文件系统");
  commitAll(f.root, "case-insensitive hook fixture");
  const result = knit(f.root, "run", "start", f.task.id);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /已有 \.agents\/hooks\.json/);
  assert.ok(!existsSync(worktreeOf(f.root, f.task)));
  assert.equal(lastRun(f.root, f.task), undefined);
});

test("准备命令生成冲突的钩子时，在登记执行前撤回新 Worktree", isolated, (t) => {
  const f = fixture(t);
  const command = "mkdir -p .agents && printf '{}' > .agents/hooks.json";
  writeFileSync(join(f.root, ".knit/config.json"), JSON.stringify({ worktree: { setup: [command] } }));
  const result = knit(f.root, "run", "start", f.task.id);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /已有 \.agents\/hooks\.json/);
  assert.ok(!existsSync(worktreeOf(f.root, f.task)));
  assert.equal(lastRun(f.root, f.task), undefined);
});

test("后台原生工具按实际路径读取交接资料，当前运行和主检出写入受保护", isolated, async (t) => {
  const f = fixture(t);
  const cwd = join(f.dir, "worktree");
  const tasks = join(f.root, ".knit/tasks");
  const runs = join(f.root, ".knit/.runtime/runs");
  const dir = join(runs, "current");
  const report = join(runs, "previous/report.md");
  const plan = join(f.root, f.task.dir, "plan.md");
  mkdirSync(join(runs, "previous"), { recursive: true });
  mkdirSync(dir);
  mkdirSync(join(cwd, ".knit"), { recursive: true });
  writeFileSync(join(cwd, ".knit/workflow.yaml"), "original");
  writeFileSync(join(cwd, "project.txt"), "original");
  writeFileSync(join(dir, "system.md"), "fixture");
  writeFileSync(report, "previous");
  writeFileSync(plan, "plan");
  symlinkSync(dir, join(tasks, "current-link"));
  const permissions = { ask: ["command(*)", "write_file(*)"], deny: ["command(git push)"], allow: ["command(git status)"] };
  writeFileSync(join(f.state, "settings.json"), JSON.stringify({ permissions }));
  const view = (path) => ({ name: "view_file", args: { AbsolutePath: path } });
  const edit = (path) => ({ name: "edit_file", args: { Path: path, Target: "original", Replacement: "edited" } });
  const searches = [
    ["list_dir", "DirectoryPath", {}],
    ["find_by_name", "SearchDirectory", { Pattern: "*.txt" }],
    ["grep_search", "SearchPath", { Query: "original" }],
  ].flatMap(([name, field, args]) => [
    { name, args }, { name, args: { ...args, [field]: "" } }, { name, args: { ...args, [field]: join(runs, "previous") } },
  ]);
  const session = new AntigravityExecutionAdapter().createSession({ root: f.root, cwd, dir, capabilities: ["read", "write", "exec"],
    model: null, thinking: null, report: {} });
  const cases = [
    ...searches.map((tool) => [tool, "allow"]),
    [view(plan), "allow"], [view(report), "allow"], [{ name: "read_file", args: { Path: "project.txt" } }, "allow"],
    [view(join(dir, "system.md")), "deny"], [view(join(tasks, "current-link/system.md")), "deny"],
    [view(join(f.root, ".knit/workflow.yaml")), "deny"], [view(f.home), "deny"],
    [{ name: "grep_search", args: { SearchPath: runs, Query: "previous" } }, "deny"],
    [{ name: "find_by_name", args: { SearchDirectory: dir, Pattern: "*.md" } }, "deny"],
    [edit("project.txt"), "allow"], [edit(".knit/workflow.yaml"), "deny"], [edit(plan), "deny"], [edit(report), "deny"],
    [{ name: "run_command", args: { CommandLine: "pwd", RunPersistent: true } }, "deny"],
    [{ name: "run_command", args: { CommandLine: "pwd", RequestedTerminalID: "fixture" } }, "deny"],
    [{ name: "run_command", args: { CommandLine: `echo overwrite > '${plan}' ; echo overwrite > '${report}'` } }, "auto_approve"],
  ];
  process.env.KNIT_FAKE_AGY = JSON.stringify({ tools: cases.map(([tool]) => tool) });
  try {
    assert.equal(await session.start(), null);
    assert.equal((await session.prompt("fixture")).failure, null);
  } finally {
    await session.stop();
  }
  const rows = readRows(f.transcripts()[0]);
  const settings = rows[0].settings;
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.deepEqual(settings.trustedWorkspaces, [cwd]);
  assert.deepEqual(settings.permissions.ask, []);
  assert.ok(settings.permissions.deny.includes(permissions.deny[0]));
  for (const rule of [permissions.allow[0], `read_file(${realpathSync.native(tasks)})`, `read_file(${realpathSync.native(runs)})`, `write_file(${cwd})`]) {
    assert.ok(settings.permissions.allow.includes(rule), rule);
  }
  const checks = rows.find((row) => row.type === "TOOL_CHECKS").checks;
  cases.forEach(([tool, decision], index) => assert.equal(checks[index].decision, decision, JSON.stringify(tool)));
  assert.deepEqual(checks.filter((item) => typeof item.text === "string").map((item) => item.text), ["plan", "previous"]);
  assert.equal(checks.at(-1).code, 1);
  assert.match(checks.at(-1).stderr, /Operation not permitted/);
  assert.deepEqual(["project.txt", ".knit/workflow.yaml", plan, report].map((path) =>
    readFileSync(path.startsWith("/") ? path : join(cwd, path), "utf8")), ["edited", "original", "plan", "previous"]);
});

for (const capabilities of [[], ["read"], ["read", "write", "exec"]]) {
  test(`macOS 外层和命令沙箱约束 tools: [${capabilities.join(", ")}]`, isolated, async (t) => {
    const f = fixture(t, { tools: JSON.stringify(capabilities) });
    const cwd = worktreeOf(f.root, f.task);
    const data = join(cwd, "fixture.txt");
    const outside = join(f.dir, "outside.txt");
    const cliState = join(f.state, "brain", "forbidden.txt");
    const link = join(cwd, "outside-link");
    const bridgePath = ".pi/extensions/knit.ts";
    mkdirSync(join(f.root, ".pi/extensions"), { recursive: true });
    writeFileSync(join(f.root, bridgePath), "// Knit bridge fixture\n");
    mkdirSync(join(f.root, ".agents"));
    mkdirSync(join(f.root, ".agent"));
    mkdirSync(join(f.home, ".gemini/config"), { recursive: true });
    const legacyConfig = join(f.dir, "legacy-mcp.json");
    const manifest = join(f.home, ".gemini/config/plugins.json");
    writeFileSync(manifest, '{}');
    writeFileSync(join(f.root, ".agents/plugins.json"), '{}');
    const mcp = (marker) => JSON.stringify({ mcpServers: { eager: {
      command: "/usr/bin/touch", args: [join(cwd, marker)], disabled: true,
    } } });
    writeFileSync(join(f.root, ".agents/mcp_config.json"), mcp("mcp-started"));
    writeFileSync(join(f.home, ".gemini/config/mcp_config.json"), mcp("global-mcp-started"));
    writeFileSync(legacyConfig, mcp("legacy-mcp-started"));
    symlinkSync(legacyConfig, join(f.root, ".agent/mcp_config.json"));
    symlinkSync(cliState, join(f.root, "cli-state-link"));
    writeFileSync(join(f.root, "fixture.txt"), "fixture");
    symlinkSync(f.dir, join(f.root, "outside-link"));
    mkdirSync(join(f.root, "nested"));
    writeFileSync(join(f.root, "nested/keep"), "");
    commitAll(f.root, "MCP and symlink fixtures");
    const connections = [];
    const server = createServer((sock) => { connections.push(sock); sock.end(); }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const target = `http://127.0.0.1:${server.address().port}/`;
    f.start({ configReads: [manifest, join(cwd, ".agents/plugins.json")], tools: [
      { name: "view_file", args: { AbsolutePath: data } },
      { name: "write_to_file", args: { TargetFile: join(cwd, "native.txt") } },
      { name: "write_to_file", args: { TargetFile: outside } },
      { name: "write_to_file", args: { TargetFile: join(link, "native-link.txt") } },
      { name: "write_to_file", args: { TargetFile: cliState } },
      { name: "search_web", args: { query: "local fixture" } },
      { name: "call_mcp_tool", args: {} },
      { name: "run_command", args: { Cwd: join(cwd, "nested"), CommandLine: [
        'printf "%s" "$PWD" > ../command.txt',
        `/usr/bin/touch '${outside}' ../outside-link/command-link.txt '../.git' '../.knit/workflow.yaml' '${cliState}'`,
        `printf rewritten > '../${bridgePath}'`,
        `/usr/bin/curl -sS --max-time 1 '${target}'`,
        "echo exit-observed; echo err-observed >&2; exit 7",
      ].join("; ") } },
      { name: "write_to_file", args: { TargetFile: join(cwd, "cli-state-link") } },
      { name: "command_status", args: { CommandId: "fixture-command" } },
      { name: "manage_task", args: { Action: "status", TaskId: "fixture-task" } },
      { name: "manage_task", args: { Action: "list" } },
      { name: "manage_task", args: { Action: "kill", TaskId: "fixture-task" } },
      { name: "manage_task", args: { Action: "send_input", TaskId: "fixture-task", Input: "fixture" } },
      { name: "write_to_file", args: { TargetFile: join(cwd, bridgePath) } },
      { name: "list_dir", args: { DirectoryPath: join(f.root, f.task.dir) } },
    ] });
    const run = await f.ended();
    assert.equal(run.verdict, "pass", run.failure);
    const rows = readRows(f.transcripts()[0]);
    assert.deepEqual(rows[0].configReads, ["EPERM", "EPERM"]);
    const checks = rows.find((row) => row.type === "TOOL_CHECKS").checks;
    assert.equal(checks[8].decision, "deny");
    const commandStatus = capabilities.includes("exec") ? "allow" : "deny";
    assert.deepEqual(checks.slice(9).map((item) => item.decision), [commandStatus, commandStatus, commandStatus, commandStatus,
      "deny", "deny", capabilities.includes("read") ? "allow" : "deny"]);
    assert.equal(readFileSync(join(cwd, bridgePath), "utf8"), "// Knit bridge fixture\n");
    assert.deepEqual(checks.slice(2, 7).map((item) => item.decision), Array(5).fill("deny"));
    assert.deepEqual(checks[0], capabilities.includes("read") ? { decision: "allow", text: "fixture" } : { decision: "deny" });
    if (capabilities.includes("write")) {
      assert.equal(checks[1].decision, "allow", JSON.stringify(checks));
      assert.equal(checks[7].code, 7, JSON.stringify(checks));
      assert.equal(readFileSync(join(cwd, "native.txt"), "utf8"), "native\n");
      assert.equal(readFileSync(join(cwd, "command.txt"), "utf8"), realpathSync(join(cwd, "nested")));
      assert.match(checks[7].stdout, /exit-observed/);
      assert.match(checks[7].stderr, /Operation not permitted/);
      assert.match(checks[7].stderr, /err-observed/);
      assert.equal(run.changedPaths.join(","), "command.txt,native.txt");
    } else {
      assert.equal(checks[1].decision, "deny");
      assert.equal(checks[7].decision, "deny");
      assert.deepEqual(run.changedPaths, []);
    }
    for (const path of [outside, cliState, join(f.dir, "native-link.txt"), join(f.dir, "command-link.txt"),
      ...["mcp-started", "global-mcp-started", "legacy-mcp-started"].map((file) => join(cwd, file))]) {
      assert.ok(!existsSync(path), path);
    }
    assert.equal(connections.length, 0);
  });
}
