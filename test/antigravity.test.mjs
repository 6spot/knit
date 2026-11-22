import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { knit } from "./helpers/cli.mjs";
import { loadBridge } from "./helpers/bridge.mjs";
import { commitAll } from "./helpers/git.mjs";
import { readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

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

function fixture(t, { tools = "[read, write, exec]", agent = "    agent: antigravity\n", options = "", stage = "review", rex = false, failure = false } = {}) {
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
  const env = { HOME: home, KNIT_AGY_BIN: agy };
  if (rex) {
    symlinkSync(fileURLToPath(new URL("./helpers/fake-rex.mjs", import.meta.url)), join(dir, "rex"));
    Object.assign(env, { KNIT_FAKE_REX: dir, REX_SESSION: "session:1", REX_BLOCK: "block:1", PATH: `${dir}:${process.env.PATH}` });
    if (failure) writeFileSync(join(dir, "fail"), "session.new_layer");
  }
  const previous = Object.fromEntries([...Object.keys(env), "KNIT_FAKE_AGY", "KNIT_SESSION_AGENT"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const report = stage === "review" ? "    report:\n      verdict: [pass, changes_requested, blocked]\n" : "";
  const configure = () => writeFileSync(join(root, ".knit/workflow.yaml"),
    `version: 1\nmodel: pi/default\nthinking: off\nstages:\n  - id: ${stage}\n${agent}${options}    tools: ${tools}\n${report}`);
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
  const permissions = { allow: ["command(git status)"], ask: ["command(printf)"], deny: ["command(git push)"] };
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
    ["force_ask", [`command(${allow})`]], ["force_ask", [`command(${reject})`]],
  ]);
  assert.ok(transcript[0].args.includes("--model=stage-model") && transcript[0].args.includes("--effort=medium"));
  const commandEntry = transcript.find((row) => row.type === "APPROVAL").result.overwrite.CommandLine.split(" ")[0];
  assert.deepEqual(transcript[0].settings.permissions, {
    ...permissions,
    allow: [...permissions.allow, `command(${commandEntry})`],
    deny: [...permissions.deny, "mcp(*)", "read_url(*)", "execute_url(*)"],
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
      { name: "manage_task", args: { Action: "send_input", TaskId: "fixture-task", Input: "fixture" } },
      { name: "write_to_file", args: { TargetFile: join(cwd, bridgePath) } },
    ] });
    const run = await f.ended();
    assert.equal(run.verdict, "pass", run.failure);
    const rows = readRows(f.transcripts()[0]);
    assert.deepEqual(rows[0].configReads, ["EPERM", "EPERM"]);
    const checks = rows.find((row) => row.type === "TOOL_CHECKS").checks;
    assert.equal(checks[8].decision, "deny");
    const commandStatus = capabilities.includes("exec") ? "allow" : "deny";
    assert.deepEqual(checks.slice(9).map((item) => item.decision), [commandStatus, commandStatus, "deny", "deny"]);
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
