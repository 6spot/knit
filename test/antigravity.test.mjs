import assert from "node:assert/strict";
import childProcess, { execFile, execFileSync, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { text } from "node:stream/consumers";
import { once } from "node:events";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AntigravityExecutionAdapter, cleanAgyRuntime } from "../dist/adapters/antigravity/execution.js";
import { AgyBroker } from "../dist/adapters/antigravity/broker.js";
import { WORKSPACE_CONTROL, agyPreflight, commandSandboxProfile } from "../dist/adapters/antigravity/isolation.js";
import { initProject } from "../dist/application/init.js";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { buildTaskStatus, statusLines } from "../dist/application/session-context.js";
import { ensureWorktree, taskWorktree } from "../dist/application/worktree.js";
import { scanTasks } from "../dist/application/task-store.js";
import { HOST_SPECS } from "../dist/contracts/host.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { cachedGitProject, commitAll, git } from "./helpers/git.mjs";
import { agents, readyTask, worktreeOf } from "./helpers/run.mjs";

// macOS 的系统 git 是工具链启动器。让临时仓库的 Git 调用直接使用同一安装的可执行文件。
if (process.platform === "darwin") process.env.PATH = `${execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()}:${process.env.PATH}`;

const isolated = { skip: process.platform !== "darwin" && "需要 macOS sandbox-exec" };
const runDir = (root, run) => join(root, ".knit/.runtime/runs", run.id);
const readRows = (path) => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
const lastRun = (root, task) => JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8")).runs.at(-1);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(predicate) {
  for (const _ of Array.from({ length: 200 })) {
    const result = predicate();
    if (result) return result;
    await sleep(50);
  }
  assert.fail("等了 10 秒");
}

function agyTempDir() {
  const base = realpathSync.native(tmpdir());
  // 优先遵循 os.tmpdir()；仅当路径过长可能触及 macOS Unix socket / sandbox 限制时尝试短路径回退。
  if (base.length <= 80) return mkdtempSync(join(base, "knit-test-agy-"));
  try {
    return realpathSync.native(mkdtempSync(join("/tmp", "knit-test-agy-")));
  } catch {
    return mkdtempSync(join(base, "knit-test-agy-"));
  }
}

function agyFixture(t, projectLifetime, { tools = "[read, write, exec]", agent = "    agent: antigravity\n", options = "", stage = "review", extraStages = "", rex = false, failure = false, environment = {} } = {}) {
  const report = stage === "review" ? "    report:\n      verdict: [pass, changes_requested, blocked]\n" : "";
  const workflowText = `version: 1\nmodel: pi/default\nthinking: off\nstages:\n  - id: ${stage}\n${agent}${options}${tools === null ? "" : `    tools: ${tools}\n`}${report}${extraStages}`;
  // node:test 按登记顺序运行 after。先回收执行者，再释放仓库和 KNIT_HOME。
  const runtime = new AsyncDisposableStack();
  t.after(() => runtime.disposeAsync());
  // 派发读取主检出当前的流程。各用例在自己的副本中配置，角色和已确认任务只准备一次。
  const root = cachedGitProject(projectLifetime, "agy-ready", (template) => {
    mkdirSync(join(template, ".knit/agents"), { recursive: true });
    writeFileSync(join(template, ".knit/agents/implement.md"), "你是实现环节的执行者。\n");
    writeFileSync(join(template, ".knit/agents/review.md"), "你是审查环节的执行者。\n");
    writeFileSync(join(template, ".knit/workflow.yaml"), "version: 1\nstages:\n  - id: review\n    agent: antigravity\n    tools: [read, write, exec]\n");
    commitAll(template, "agy workflow");
    readyTask(template);
  });
  const [task] = scanTasks(root);
  const configure = () => writeFileSync(join(root, ".knit/workflow.yaml"), workflowText);
  configure();
  const dir = agyTempDir();
  runtime.defer(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = join(dir, "home");
  const state = join(home, ".gemini/antigravity-cli");
  const brain = join(state, "brain");
  mkdirSync(state, { recursive: true });
  const agy = join(dir, "agy");
  const fake = fileURLToPath(new URL("./helpers/fake-agy.mjs", import.meta.url));
  writeFileSync(agy, `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.5.13; exit 0; fi\nexec '${process.execPath}' '${fake}' "$@"\n`);
  chmodSync(agy, 0o755);
  const env = { ...environment, HOME: home, KNIT_AGY_BIN: agy };
  if (rex) {
    symlinkSync(fileURLToPath(new URL("./helpers/fake-rex.mjs", import.meta.url)), join(dir, "rex"));
    Object.assign(env, { KNIT_FAKE_REX: dir, REX_SESSION: "session:1", REX_BLOCK: "block:1", PATH: `${dir}:${process.env.PATH}` });
    if (failure) writeFileSync(join(dir, "fail"), "session.new_layer");
  }
  if (projectLifetime === t) {
    const previous = Object.fromEntries([...Object.keys(env), "KNIT_FAKE_AGY", "KNIT_SESSION_AGENT"].map((key) => [key, process.env[key]]));
    runtime.defer(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        if (value !== undefined) process.env[key] = value;
      }
    });
    Object.assign(process.env, env);
  }
  const childEnv = { ...process.env, ...env };
  const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
  const command = (...args) => new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args, "--dir", root], { env: childEnv }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ status: error?.code ?? 0, stdout, stderr });
    });
  });
  const run = async (...args) => {
    const result = await command(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  runtime.defer(async () => {
    const { runs } = JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8"));
    if (runs.some((item) => item.endedAt === null)) await run("run", "cancel", task.id);
    const pids = runs.map((run) => join(runDir(root, run), "worker.json"))
      .filter((file) => existsSync(file)).map((file) => JSON.parse(readFileSync(file, "utf8")).pid);
    await until(() => pids.every((pid) => !alive(pid)));
  });
  // 适配器同步读取 HOME 和 agy 路径；返回事件循环前恢复，其他夹具只向子进程传环境。
  const preflight = (capabilities) => {
    const saved = { HOME: process.env.HOME, KNIT_AGY_BIN: process.env.KNIT_AGY_BIN };
    try {
      Object.assign(process.env, { HOME: home, KNIT_AGY_BIN: agy });
      if (capabilities !== undefined) {
        const tree = taskWorktree(root, task.dir);
        return agyPreflight(root, tree.path, tree.branch, capabilities);
      }
      const result = prepareRun({ root, taskId: task.id, workflow: parseWorkflow(workflowText).workflow,
        config: loadConfig(root).config, model: null,
        checkAgent: (name, tools, tree) => agents[name].checkDispatch?.(root, tree.path, tree.branch, tools) ?? null });
      assert.equal(result.run, null);
      return result.problems.join("\n");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        if (value !== undefined) process.env[key] = value;
      }
    }
  };
  // 直接驱动已登记的后台 worker 来检查沙箱与结算。派发预检、窗格、取消和并行批次另走 run start。
  const complete = async (script) => {
    const prepared = prepareRun({ root, taskId: task.id, workflow: parseWorkflow(workflowText).workflow,
      config: loadConfig(root).config, model: null });
    assert.deepEqual(prepared.problems, []);
    const worker = prepared.run;
    childEnv.KNIT_FAKE_AGY = JSON.stringify(script);
    await run("run", "worker", worker.id, "--task", task.id,
      ...(worker.model === null ? [] : ["--model", worker.model]), ...(worker.thinking === null ? [] : ["--thinking", worker.thinking]));
    const settled = lastRun(root, task);
    assert.equal(settled.id, worker.id);
    assert.ok(settled.endedAt);
    return settled;
  };
  return { root, dir, home, brain, state, task, configure, preflight, complete, env: childEnv, command, run,
    start: (script, ...args) => {
      childEnv.KNIT_FAKE_AGY = JSON.stringify(script);
      return run("run", "start", task.id, ...args);
    },
    ended: () => until(() => {
      const run = lastRun(root, task);
      return run?.endedAt ? run : null;
    }),
    transcripts: () => existsSync(brain) ? readdirSync(brain).map((path) => join(brain, path)) : [],
  };
}

function addDetachedService(f) {
  const tree = taskWorktree(f.root, f.task.dir);
  assert.deepEqual(ensureWorktree(f.root, tree).problems, []);
  writeFileSync(join(tree.path, "service.mjs"), `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const service = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true, stdio: "ignore", env: {},
    });
    writeFileSync("service.pid", String(service.pid));
    service.unref();
  `);
}

test("工作树写保护覆盖所有登记的宿主目录并去重", () => {
  assert.equal(WORKSPACE_CONTROL.length, new Set(WORKSPACE_CONTROL).size);
  for (const host of HOST_SPECS) {
    for (const dir of host.controlDirs) assert.ok(WORKSPACE_CONTROL.includes(dir), `${host.id}: ${dir}`);
  }
});

test("显式 agent、模型和 effort 配置报告各自的行号", () => {
  const parsed = parseWorkflow(`version: 1\nstages:\n  - id: a\n    agent: other\n  - id: b\n    agent: antigravity\n    model: pi/model\n    thinking: minimal\n  - id: c\n    agent: pi\n    model: gemini-3\n`);
  assert.equal(parsed.workflow, null);
  assert.deepEqual(parsed.validation.issues.map((issue) => issue.line), [4, 7, 8, 11]);
  const messages = parsed.validation.issues.map((issue) => issue.message);
  assert.match(messages[0], /第 4 行：.*pi／antigravity/);
  assert.match(messages[1], /第 7 行：.*Antigravity 模型 ID/);
  assert.match(messages[2], /第 8 行：.*low／medium／high／xhigh／max/);
  assert.match(messages[3], /第 11 行：.*provider\/模型/);
});

// 先启动独立仓库的长用例。依赖进程环境或替换 fs 方法的用例在这一组结束后串行执行。
test("独立仓库中的 Antigravity 执行", { concurrency: Math.min(10, availableParallelism()) }, independentRuns);

test("后台 stop 等待 agy 退出时的整批尾行追加到日志", isolated, async (t) => {
  const root = agyTempDir();
  const dir = join(root, "runs/current");
  const log = join(dir, "session/agy.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, '{"previous":true}\n');
  writeFileSync(join(dir, "system.md"), "fixture");
  const agy = join(root, "agy");
  const result = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "KNIT_AGY_SUBMIT\n完成" } });
  const tail = Array.from({ length: 4096 }, (_, index) => JSON.stringify({ event: "step_update", index }));
  writeFileSync(join(root, "tail.jsonl"), tail.join("\n"));
  writeFileSync(agy, `#!${process.execPath}\nimport { readFileSync } from 'node:fs';
process.once('SIGTERM', () => process.stdout.end(readFileSync('tail.jsonl'), () => process.exit(0)));
process.stdin.once('data', () => console.log(${JSON.stringify(result)}));\n`, { mode: 0o755 });
  const previous = process.env.KNIT_AGY_BIN;
  process.env.KNIT_AGY_BIN = agy;
  const session = new AntigravityExecutionAdapter().createSession({ root, cwd: root, dir, capabilities: ["read"], model: null, thinking: null });
  if (previous === undefined) delete process.env.KNIT_AGY_BIN;
  else process.env.KNIT_AGY_BIN = previous;
  t.after(async () => { await session.stop(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(await session.start(), null);
  assert.equal((await session.prompt("交接")).report, "完成");
  await session.stop();
  assert.equal(readFileSync(log, "utf8"), ['{"previous":true}', result, ...tail, ""].join("\n"));
});

test("Broker 的固定规则复用期间仍按当前真实目标保护链接", (t) => {
  const cwd = agyTempDir();
  t.after(() => rmSync(cwd, { recursive: true }));
  const plugin = join(cwd, ".agents/plugins/knit");
  mkdirSync(dirname(plugin), { recursive: true });
  const profile = commandSandboxProfile({ cwd, dir: join(cwd, "run"), paths: [], command: { socket: "sock", temporary: "tmp" }, network: false, write: true });
  const initial = profile();
  for (const name of ["first", "second"]) {
    const target = join(cwd, name);
    mkdirSync(target);
    symlinkSync(target, plugin);
    const current = profile();
    assert.ok(current.startsWith(initial));
    assert.ok(current.includes(`(deny file-read-data (subpath ${JSON.stringify(target)}))`));
    assert.ok(current.includes(`(deny file-write* (subpath ${JSON.stringify(target)}))`));
    rmSync(plugin);
    assert.equal(profile(), initial);
  }
});

test("Broker 回收未结束时仍能答复钩子，命令等待回收且可提前断开", { ...isolated, timeout: 5000 }, async (t) => {
  const root = realpathSync.native(mkdtempSync("/tmp/knit-broker-"));
  const path = join(root, "sock");
  const broker = new AgyBroker({ root, cwd: root, dir: join(root, "run"), capabilities: ["read", "write", "exec"] }, path, async () => ({ ok: true }));
  await broker.start();
  t.after(() => { broker.stop(); rmSync(root, { recursive: true, force: true }); });
  const hook = async (event, payload) => {
    const client = createConnection(path);
    client.end(JSON.stringify({ kind: "hook", key: broker.hookEnv.KNIT_AGY_HOOK_KEY, event, payload }));
    return JSON.parse(await text(client));
  };
  const execute = childProcess.execFile;
  for (const mode of ["success", "error", "disconnect"]) {
    const started = Promise.withResolvers();
    // 让跟踪器在管道上等待测试放行，长 scope 走真实的回收失败路径。
    const tracker = t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
      const scope = mode === "error" ? "x".repeat(128) : args[1];
      const child = execute("/bin/sh", ["-c", 'read release && exec "$0" "$1" "$2"', file, args[0], scope], options, callback);
      started.resolve(child);
      return child;
    });
    syncBuiltinESMExports();
    try {
      const command = mode === "disconnect"
        ? "(while [ ! -f release-output ]; do sleep 0.01; done; echo out; echo err >&2; touch output-done) & exit 7" : "exit 7";
      const reply = await hook("PreToolUse", { toolCall: { name: "run_command", args: { CommandLine: command } } });
      const accepted = once(broker.server, "connection");
      const client = createConnection(path);
      const [socket] = await accepted;
      const messages = text(client);
      client.write(JSON.stringify({ kind: "command", key: /^KNIT_AGY_REQUEST=(\S+)/.exec(reply.overwrite.CommandLine)[1] }) + "\n");
      const child = await started.promise;
      assert.deepEqual(await hook("SessionStart", {}), { ok: true });
      assert.equal(client.readableEnded, false);
      if (mode === "disconnect") {
        socket.destroy();
        t.mock.method(socket, "write", () => assert.fail("对已销毁的 socket 转发了输出"));
        t.mock.method(socket, "end", () => assert.fail("对已销毁的 socket 发送了退出结果"));
        writeFileSync(join(root, "release-output"), "");
        await until(() => existsSync(join(root, "output-done")));
      }
      const closed = once(child, "close");
      child.stdin.end("release\n");
      await closed;
      assert.deepEqual((await messages).trim().split("\n").filter(Boolean).map(JSON.parse),
        mode === "disconnect" ? [] : mode === "error" ? [{ error: "Antigravity 命令进程回收失败：2" }] : [{ code: 7 }]);
    } finally {
      tracker.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("后台同一 stream 会话只补报一次，省略 agy 参数，run wait 通知原 Pi", isolated, async (t) => {
  const f = agyFixture(t, t, { tools: "all" });
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
  await until(() => bridge.messages.length > 0);
  const [stored] = scanTasks(f.root);
  const workflow = parseWorkflow(readFileSync(join(f.root, ".knit/workflow.yaml"), "utf8")).workflow;
  const status = buildTaskStatus(f.root, stored.dir, workflow, stored.document, stored.record);
  assert.equal(spawnSync("pgrep", ["-f", `run wait ${f.task.id}`]).status, 1);
  assert.deepEqual(bridge.messages.map(({ message }) => message.content), [`Knit 的执行结束了：\n${statusLines(status).join("\n")}`]);
});

for (const order of ["结算先清理", "会话先收尾", "窗格删除定位文件时结算"]) {
  test(`跟踪器返回非零时清理文件并结算，${order}`, isolated, async (t) => {
    const f = agyFixture(t, t);
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

test("直接取消结束 agy、同组命令和已脱离父进程的服务，结果由 Pi 工具返回", isolated, async (t) => {
  const f = agyFixture(t, t);
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

const configuredMcp = { mcpServers: { demo: { command: "/usr/bin/true" } } };
const plugin = { name: "demo", version: "1.0.0" };
const enabledPlugins = [{ name: "demo", enabled: true }];
const externalHooks = { demo: { SessionStart: [{ type: "command", command: "/usr/bin/true" }] } };
// 子进程各自继承夹具环境。父测试持有临时 KNIT_HOME，每个子测试有独立仓库和 Worktree。
async function independentRuns(suite) {
  const cases = [];
  const check = (...args) => cases.push(suite.test(...args));
  const fixture = (t, options) => agyFixture(t, suite, options);

  check("后台原生工具按实际路径读取交接资料，当前运行和主检出写入受保护", isolated, async (t) => {
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
    // 适配器启动和钩子在整个会话中读取 HOME；在夹具自己的进程环境里执行。
    const launch = { root: f.root, cwd, dir, capabilities: ["read", "write", "exec"], model: null, thinking: null, report: {} };
    const program = `
      import assert from "node:assert/strict";
      import { AntigravityExecutionAdapter } from ${JSON.stringify(new URL("../dist/adapters/antigravity/execution.js", import.meta.url).href)};
      const session = new AntigravityExecutionAdapter().createSession(JSON.parse(process.argv[1]));
      try {
        assert.equal(await session.start(), null);
        assert.equal((await session.prompt("fixture")).failure, null);
      } finally {
        await session.stop();
      }
    `;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", program, JSON.stringify(launch)], {
      env: { ...f.env, KNIT_FAKE_AGY: JSON.stringify({ tools: cases.map(([tool]) => tool) }) },
    });
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

  for (const mode of ["stream", "pane", "missing", "incompatible", "wrong-id"]) {
    check(`Antigravity 沙箱内返工会话 ${mode}`, isolated, async (t) => {
      const pane = mode === "pane" || mode === "incompatible";
      const f = fixture(t, { stage: "implement", tools: "[]", options: "    resume: true\n    prompt: .knit/agents/implement.md\n",
        rex: pane, extraStages: "  - id: review\n    agent: antigravity\n    tools: []\n    report: {verdict: [changes_requested, pass]}\n    onVerdict: {changes_requested: implement}\n" });
      // 窗格要核对 run start 登记的 worker 身份，两个窗格场景都走完整派发。
      if (pane) await f.start({});
      const first = pane ? await f.ended() : await f.complete({});
      assert.equal(first.failure, null);
      assert.match(first.resumeId, /^[a-f0-9-]{36}$/);
      assert.notEqual(first.resumeId, first.sessionFile);
      const reviewReport = '审查意见\n```json\n{"verdict":"changes_requested"}\n```';
      if (mode === "stream" || mode === "pane") {
        await f.start({ responses: [`KNIT_AGY_SUBMIT\n${reviewReport}`] });
      } else {
        // 三种回退从一次已结算的审查开始。原会话和返工仍跑真实沙箱客户端。
        const workflow = parseWorkflow(readFileSync(join(f.root, ".knit/workflow.yaml"), "utf8")).workflow;
        const input = { root: f.root, taskId: f.task.id, workflow };
        const prepared = prepareRun({ ...input, config: loadConfig(f.root).config, model: null });
        assert.deepEqual(prepared.problems, []);
        assert.equal(prepared.run.stage.id, "review");
        writeFileSync(join(f.root, prepared.run.dir, "report.md"), reviewReport);
        assert.deepEqual(finishRun({ ...input, agents, runId: prepared.run.id, verdict: "changes_requested", failure: null, sessionFile: null }), []);
      }
      const review = await f.ended();
      assert.equal(review.verdict, "changes_requested", review.failure);
      if (mode === "missing") rmSync(join(f.state, "conversations", `${first.resumeId}.db`));
      await f.start({ rejectResume: mode === "incompatible", ignoreResume: mode === "wrong-id" }, "--instruction", "修复两处边界");
      const repair = await f.ended();
      assert.equal(repair.failure, null);
      const rows = readRows(join(f.brain, `${repair.resumeId}.jsonl`));
      const args = rows.findLast((row) => row.type === "INIT").args;
      const message = rows.findLast((row) => row.type === "USER_INPUT").content;
      const [stored] = scanTasks(f.root);
      const workflow = parseWorkflow(readFileSync(join(f.root, ".knit/workflow.yaml"), "utf8")).workflow;
      const status = mode === "stream" ? await f.run("run", "status", f.task.id)
        : statusLines(buildTaskStatus(f.root, stored.dir, workflow, stored.document, stored.record)).join("\n");
      assert.match(message, /修复两处边界/);
      assert.ok(existsSync(join(runDir(f.root, repair), "report.md")));
      assert.deepEqual(repair.changedPaths, []);
      if (mode === "stream" || mode === "pane") {
        assert.equal(repair.resumeId, first.resumeId);
        assert.equal(args[args.indexOf("--conversation") + 1], first.resumeId);
        assert.ok(message.includes(join(runDir(f.root, review), "report.md")));
        assert.match(message, /审查意见/);
        assert.doesNotMatch(message, /<task |你是实现环节的执行者/);
        assert.match(status, /续聊原会话/);
        return;
      }
      assert.notEqual(repair.resumeId, first.resumeId);
      assert.equal(args.includes("--conversation"), false);
      assert.match(message, /你是实现环节的执行者/);
      assert.match(message, /<task /);
      const reason = { missing: /对话不存在/, incompatible: /会话退出/, "wrong-id": /与请求不一致/ }[mode];
      assert.match(status, reason);
      assert.match(readFileSync(join(runDir(f.root, repair), "worker.log"), "utf8"), reason);
    });
  }

  const waiting = "KNIT_AGY_WAITING\n请提供测试输入";
  const unmarked = "审查完成\n```json\n{\"verdict\":\"pass\"}\n```";
  for (const { stage, responses, failure } of [
    { stage: "implement", responses: [unmarked, "KNIT_AGY_SUBMIT\n完成实现"] },
    { stage: "implement", responses: [waiting, waiting], failure: true },
    { stage: "review", responses: [waiting, "KNIT_AGY_SUBMIT\n缺少结论", unmarked, `KNIT_AGY_SUBMIT\n${unmarked}`] },
    { stage: "review", responses: [unmarked, ""], failure: true },
  ]) {
    check(`后台 ${stage} 漏标或等待后在原会话追问，${failure ? "再次未提交时退出" : "提交后校验报告"}`, isolated, async (t) => {
      const f = fixture(t, { stage, tools: "[]" });
      const run = await f.complete({ responses });
      const rows = readRows(f.transcripts()[0]);
      const messages = rows.filter((row) => row.type === "USER_INPUT");
      assert.deepEqual(messages.length, responses.length);
      assert.match(messages[1].content, /后台.*第一行.*KNIT_AGY_SUBMIT.*完整报告/);
      if (stage === "review" && !failure) {
        assert.match(messages[2].content, /不要重新做一遍/);
        assert.equal(messages[3].content, messages[1].content);
      }
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

  check("同批 Pi 在 Antigravity 运行期间结算，改动清单排除正在使用的隔离钩子", isolated, async (t) => {
    const f = fixture(t, { tools: "[read]", agent: "    executors: [{id: pi-reader, agent: pi}, {id: agy-reader, agent: antigravity}]\n" });
    const record = () => JSON.parse(readFileSync(join(f.root, f.task.dir, "record.json"), "utf8"));
    const gate = join(f.dir, "pi-ready");
    const script = join(f.dir, "pi.json");
    writeFileSync(script, JSON.stringify({ waitFor: gate, texts: ['```json\n{"verdict":"pass"}\n```'] }));
    f.env.KNIT_PI_BIN = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
    f.env.KNIT_FAKE_PI = script;
    await f.start({ pauseAfterStart: true });
    try {
      const [pi, agy] = record().runs;
      await until(() => existsSync(join(runDir(f.root, agy), "session-file.txt")));
      writeFileSync(gate, "");
      await until(() => record().runs[0].endedAt);
      assert.equal(record().runs[0].verdict, "pass");
      assert.equal(record().runs[1].endedAt, null);
      assert.deepEqual(record().runs[0].changedPaths, []);
      const after = JSON.parse(readFileSync(join(runDir(f.root, pi), "after.json"), "utf8"));
      assert.ok(!Object.hasOwn(after.files, ".agents/hooks.json"));
      assert.ok(existsSync(join(worktreeOf(f.root, f.task), ".agents/hooks.json")));
    } finally {
      if (record().runs.some((run) => run.endedAt === null)) await f.run("run", "cancel", f.task.id);
    }
  });

  check("两个 Antigravity 共用钩子，单项取消后另一人仍能使用自己的钩子并交报", isolated, async (t) => {
    const f = fixture(t, { tools: "[read]", agent: "    executors: [{id: a, agent: antigravity}, {id: b, agent: antigravity}]\n" });
    const gate = join(f.dir, "continue");
    const hook = join(worktreeOf(f.root, f.task), ".agents/hooks.json");
    const runs = () => JSON.parse(readFileSync(join(f.root, f.task.dir, "record.json"), "utf8")).runs;
    await f.start({ wait: gate, tools: [{ name: "list_dir", args: {} }] });
    try {
      const [a, b] = runs();
      for (const run of [a, b]) {
        const locator = join(runDir(f.root, run), "session-file.txt");
        await until(() => existsSync(locator));
        const transcript = readRows(readFileSync(locator, "utf8").trim());
        assert.ok(transcript[0].args.includes(realpathSync.native(join(runDir(f.root, run), "agy-settings.json"))));
      }
      const shared = readFileSync(hook, "utf8");
      assert.ok(!shared.includes("tool.sock"));
      await f.run("run", "cancel", f.task.id, "--run", a.id);
      assert.equal(runs()[0].failure, "已取消");
      assert.equal(runs()[1].endedAt, null);
      assert.equal(readFileSync(hook, "utf8"), shared);
      writeFileSync(gate, "");
      const passed = await f.ended();
      assert.equal(passed.verdict, "pass", passed.failure);
      assert.ok(existsSync(join(runDir(f.root, b), "report.md")));
      assert.deepEqual(runs().map((run) => run.changedPaths), [[], []]);
      assert.ok(!existsSync(hook));
      assert.equal(git(worktreeOf(f.root, f.task), "status", "--porcelain", "--untracked-files=all"), "");
    } finally {
      writeFileSync(gate, "");
      if (runs().some((run) => run.endedAt === null)) await f.run("run", "cancel", f.task.id);
    }
  });

  check("后台明确报告权限阻塞时保留模型与工具的原因", isolated, async (t) => {
    const f = fixture(t, { tools: "[]" });
    const run = await f.complete({ denied: true, responses: ["KNIT_AGY_PERMISSION_BLOCKED\n必要操作被拒"] });
    assert.match(run.failure, /Antigravity 权限阻塞：必要操作被拒.*deny rule.*denied_actions/);
  });

  check("Rex 同轮被钩子拒绝和用户拒批后仍可提交有效报告", isolated, async (t) => {
    const f = fixture(t, { rex: true });
    await f.start({ tools: [
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

  check("Rex 创建窗格失败时保留 Agent 和覆盖值，SUCCESS 保留 denied_actions 和工具错误", isolated, async (t) => {
    const f = fixture(t, { rex: true, failure: true, agent: "", options: "    model: own-model\n    thinking: low\n" });
    f.env.KNIT_SESSION_AGENT = "antigravity";
    await f.start({ denied: true }, "--model", "override-id", "--thinking", "xhigh");
    const run = await f.ended();
    assert.equal(run.agent, "antigravity");
    assert.match(run.failure, /Matches user-configured deny rule.*Tool permission denied.*denied_actions:.*write_file/);
    assert.match(readFileSync(join(runDir(f.root, run), "worker.log"), "utf8"), /改在后台执行/);
    const args = readRows(f.transcripts()[0])[0].args;
    assert.ok(args.includes("--model=override-id") && args.includes("--effort=xhigh"));
  });

  check("Rex 等追加输入，在边界内自动放行命令并清空询问规则，在原会话补报", isolated, async (t) => {
    const f = fixture(t, { rex: true, options: "    model: stage-model\n    thinking: medium\n" });
    const permissions = { allow: ["command(git status)"], ask: ["command(*)", "write_file(*)", "command(git push)"], deny: ["command(git push)"] };
    writeFileSync(join(f.state, "settings.json"), JSON.stringify({ permissions }));
    const cwd = worktreeOf(f.root, f.task);
    const gate = join(cwd, "input-ready");
    const command = (line, decline = false) => ({ name: "run_command", args: { CommandLine: line, Cwd: cwd }, decline });
    const allow = "printf approved > approved.txt";
    const reject = "printf declined > declined.txt";
    await f.start({ wait: gate, retry: true, tools: [command(allow), command(reject, true)] });
    await until(() => f.transcripts().some((path) => readFileSync(path, "utf8").includes('"type":"PLANNER_RESPONSE","content":"KNIT_AGY_WAITING')));
    assert.equal(lastRun(f.root, f.task).endedAt, null);
    assert.match(await f.run("run", "status", f.task.id), /^Agent: antigravity$/m);
    assert.ok(existsSync(join(cwd, "approved.txt")), readFileSync(f.transcripts()[0], "utf8"));
    assert.equal(readFileSync(join(cwd, "approved.txt"), "utf8"), "approved");
    assert.ok(!existsSync(join(cwd, "declined.txt")));
    writeFileSync(gate, "");
    const run = await f.ended();
    assert.equal(run.verdict, "pass", run.failure);
    const transcript = readRows(run.sessionFile);
    assert.deepEqual(transcript.filter((row) => row.type === "APPROVAL").map((row) => [row.result.decision, row.result.permissionOverrides]), [
      ["auto_approve", [`command(${allow})`]], ["auto_approve", [`command(${reject})`]],
    ]);
    assert.ok(transcript[0].args.includes("--model=stage-model") && transcript[0].args.includes("--effort=medium"));
    const commandEntry = transcript.find((row) => row.type === "APPROVAL").result.overwrite.CommandLine.split(" ").at(-1);
    const handoff = [join(f.root, ".knit/tasks"), join(f.root, ".knit/.runtime/runs")].map((path) => realpathSync.native(path));
    const realCwd = realpathSync.native(cwd);
    assert.deepEqual(transcript[0].settings.permissions, {
      ask: [],
      allow: [...permissions.allow, `command(${commandEntry})`, ...handoff.map((dir) => `read_file(${dir})`), `read_file(${realCwd})`, `write_file(${realCwd})`],
      deny: [...permissions.deny, ...handoff.map((dir) => `write_file(${dir})`), `read_file(${realpathSync.native(runDir(f.root, run))})`,
        "mcp(*)", "read_url(*)", "execute_url(*)"],
    });
    assert.equal(transcript.filter((row) => row.type === "USER_INPUT").length, 3);
    assert.ok(!existsSync(join(cwd, ".agents/hooks.json")));
  });

  check("Rex 未收到提交回执时仍可追加输入，执行达到上限后记录原因", isolated, async (t) => {
    const f = fixture(t, { rex: true });
    const gate = join(worktreeOf(f.root, f.task), "input-ready");
    await f.start({ wait: gate, unmarked: true, limit: true });
    await until(() => f.transcripts().some((path) => readFileSync(path, "utf8").includes('"content":"请提供测试输入"')));
    assert.equal(lastRun(f.root, f.task).endedAt, null);
    writeFileSync(gate, "");
    const run = await f.ended();
    assert.match(run.failure, /Antigravity 执行出错：max_steps_exceeded/);
    assert.ok(!existsSync(join(runDir(f.root, run), "report.md")));
  });

  for (const write of [false, true]) {
    const tools = write ? "[read, write, exec]" : "[read, exec]";
    check(`run_command 在 ${tools} 下使用独立 TMPDIR 和宿主环境`, isolated, async (t) => {
      const privateKeys = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_OFFLINE", "KNIT_AGY_SOCKET", "KNIT_AGY_HOOK_KEY"];
      const environment = Object.fromEntries(privateKeys.map((key) => [key, "private"]));
      const f = fixture(t, { tools, environment: { ...environment, LOGNAME: "fixture-user", GOPATH: "/fixture/go" } });
      mkdirSync(join(f.root, "nested"));
      writeFileSync(join(f.root, "nested/input"), "relative input\n");
      commitAll(f.root, "here-doc working directory fixture");
      const command = (CommandLine) => ({ name: "run_command", args: { CommandLine, Cwd: "nested" } });
      const run = await f.complete({ tools: [
        command('printf "%s %s\\n" "$LOGNAME" "$GOPATH" > "$TMPDIR/leftover" && cat "$TMPDIR/leftover" && echo "$TMPDIR"'),
        command('cat <<EOF\nhere-doc in ${PWD##*/}: $(cat input)\nEOF'),
        command(`env | grep -E '^(${privateKeys.join("|")})='`),
        command('touch "$TMPDIR/../run-command" "$TMPDIR/../tool.sock"'),
        command("touch project-result"),
      ] });
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

  check("后台正常结算前停止已脱离父进程和进程组的命令服务", isolated, async (t) => {
    const f = fixture(t);
    addDetachedService(f);
    const cwd = worktreeOf(f.root, f.task);
    await f.start({ tools: [{ name: "run_command", args: { Cwd: cwd, CommandLine: "node service.mjs" } }] });
    const run = await f.ended();
    const pid = Number(readFileSync(join(cwd, "service.pid"), "utf8"));
    assert.ok(pid > 0);
    t.after(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); });
    assert.equal(run.verdict, "pass", run.failure);
    const checks = readRows(f.transcripts()[0]).find((row) => row.type === "TOOL_CHECKS").checks;
    assert.equal(checks[0].code, 0, checks[0].stderr);
    assert.ok(!alive(pid), "执行已入账，脱离进程组的命令服务仍在运行");
  });

  check("后台命令的转发客户端被终止时，在会话结束前回收命令", isolated, async (t) => {
    const f = fixture(t, { rex: true });
    const cwd = worktreeOf(f.root, f.task);
    const gate = join(cwd, "input-ready");
    const pidFile = join(cwd, "command.pid");
    await f.start({ wait: gate, tools: [{ name: "run_command", args: { CommandLine: "echo $$ > command.pid; exec sleep 60" }, background: true }] });
    const pid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")));
    assert.ok(alive(pid));
    const { checks } = await until(() => readRows(f.transcripts()[0]).find((row) => row.type === "TOOL_CHECKS"));
    process.kill(checks[0].pid, "SIGKILL");
    await until(() => !alive(pid));
    assert.equal(lastRun(f.root, f.task).endedAt, null);
    writeFileSync(gate, "");
    const run = await f.ended();
    assert.equal(run.verdict, "pass", run.failure);
  });

  check("Rex 窗格已启动后退出，执行结算失败且不回退", isolated, async (t) => {
    const f = fixture(t, { rex: true });
    await f.start({ exit: true });
    const run = await f.ended();
    assert.match(run.failure, /窗格关掉了/);
    assert.equal(f.transcripts().length, 1);
  });

  check("Rex 在 SessionStart 后取消，从定位文件回填原生转录", isolated, async (t) => {
    const f = fixture(t, { rex: true, tools: "[]" });
    await f.start({ pauseAfterStart: true });
    const dir = runDir(f.root, lastRun(f.root, f.task));
    const locator = join(dir, "session-file.txt");
    await until(() => existsSync(locator));
    assert.deepEqual(f.transcripts(), [readFileSync(locator, "utf8")]);
    await f.run("run", "cancel", f.task.id);
    const run = await f.ended();
    assert.equal(run.failure, "已取消");
    assert.equal(run.sessionFile, f.transcripts()[0]);
  });

  check("Rex 关掉仍在执行命令的窗格时停止进程再结算", isolated, async (t) => {
    const f = fixture(t, { rex: true });
    const cwd = worktreeOf(f.root, f.task);
    const pidFile = join(cwd, "child.pid");
    await f.start({ pathFromTool: true, tools: [{ name: "run_command", args: { Cwd: cwd, CommandLine: "/bin/sleep 60 & echo $! > child.pid; wait" } }] });
    const pid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")));
    const file = readdirSync(join(f.dir, "layers"))[0];
    execFileSync(join(f.dir, "rex"), ["api", "call", "session.close_layer", JSON.stringify({
      session_id: "session:1", layer_id: `layer:${file.slice(0, -5)}`,
    })], { env: f.env });
    const run = await f.ended();
    assert.match(run.failure, /窗格关掉了/);
    assert.ok(!alive(pid));
    assert.ok(!existsSync(join(cwd, ".agents/hooks.json")));
    assert.deepEqual(f.transcripts(), [run.sessionFile]);
  });

  for (const tools of ["[read, write, exec]", "[read, write, exec, external, network]", "all", null]) {
    check(`tools ${tools ?? "省略"} 的 external 声明控制外层沙箱读取定制文本`, isolated, async (t) => {
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
      await f.start({ configReads: [...texts, ...emptyConfigs], configWrites: external ? texts : [] });
      const run = await f.ended();
      assert.equal(run.verdict, "pass", run.failure);
      const result = readRows(f.transcripts()[0])[0];
      assert.deepEqual(result.configReads, [...texts.map(() => external ? "allowed" : "EPERM"), ...emptyConfigs.map(() => "EPERM")]);
      assert.deepEqual(result.configWrites, external ? texts.map(() => "EPERM") : []);
    });
  }

  for (const tools of ["[read, write, exec]", "all"]) {
    for (const linked of [false, true]) {
      check(`主会话插件${linked ? "目录链接及实际路径" : "目录"}在 ${tools} 下通过派发且两层沙箱均拒绝读写`, isolated, async (t) => {
        const f = fixture(t, { tools });
        const plugins = ".agents/plugins";
        const knit = join(plugins, "knit");
        const target = linked ? "main-session-plugin" : knit;
        mkdirSync(join(f.root, plugins), { recursive: true });
        if (linked) symlinkSync("../../main-session-plugin", join(f.root, knit));
        mkdirSync(join(f.root, target, "rules"), { recursive: true });
        const files = ["plugin.json", "hooks.json", "rules/AGENTS.md"];
        for (const [index, contents] of [JSON.stringify({ name: "knit" }), "{}", "# 主会话讨论规范\n"].entries()) {
          writeFileSync(join(f.root, target, files[index]), contents);
        }
        const skill = ".agents/skills/demo/SKILL.md";
        mkdirSync(join(f.root, dirname(skill)), { recursive: true });
        writeFileSync(join(f.root, skill), "# Demo\n");
        commitAll(f.root, "main-session plugin and skill");
        const paths = [...new Set([knit, target])].flatMap((dir) => files.map((name) => join(dir, name)));
        const probe = `const fs = require("node:fs");
          for (const path of process.argv.slice(1)) {
            for (const op of [() => fs.readFileSync(path), () => fs.appendFileSync(path, "probe")]) {
              try { op(); console.log("allowed"); } catch (error) { console.log(error.code); }
            }
          }`;
        await f.start({ configReads: [...paths, skill], configWrites: [...paths, skill], tools: [
          { name: "run_command", args: { CommandLine: `'${process.execPath}' -e '${probe}' ${paths.join(" ")}` } },
        ] });
        const run = await f.ended();
        assert.equal(run.verdict, "pass", run.failure);
        const rows = readRows(f.transcripts()[0]);
        assert.deepEqual(rows[0].configReads, [...paths.map(() => "EPERM"), tools === "all" ? "allowed" : "EPERM"]);
        assert.deepEqual(rows[0].configWrites, [...paths, skill].map(() => "EPERM"));
        const [command] = rows.find((row) => row.type === "TOOL_CHECKS").checks;
        assert.equal(command.code, 0, command.stderr);
        assert.deepEqual(command.stdout.trim().split("\n"), paths.flatMap(() => ["EPERM", "EPERM"]));
        assert.deepEqual(run.changedPaths, []);
      });
    }
  }

  for (const existing of [false, true]) {
    check(`${existing ? "已有" : "新"} Worktree 识别混合大小写的 Knit 目录并指出同级插件和钩子链接`, isolated, async (t) => {
      const f = fixture(t, { tools: "all" });
      const cwd = worktreeOf(f.root, f.task);
      if (existing) git(f.root, "worktree", "add", "-b", `knit/${basename(f.task.dir)}`, cwd);
      const root = existing ? cwd : f.root;
      const plugins = join(root, ".agents/plugins");
      const knitPlugin = join(plugins, "knit");
      mkdirSync(plugins, { recursive: true });
      const hookName = existsSync(join(root, ".AGENTS")) ? "Hooks.json" : "hooks.json";
      symlinkSync(`.agents/${hookName}`, join(root, "hook-alias"));
      symlinkSync("../../hook-alias", knitPlugin);
      const reject = (pattern, dispatch = false) => {
        if (!existing) commitAll(root, "plugin conflict fixture");
        assert.match((dispatch ? f.preflight() : f.preflight(null)) ?? "", pattern);
        assert.equal(lastRun(f.root, f.task), undefined);
        assert.equal(existsSync(cwd), existing);
      };
      reject(/\.agents\/plugins\/knit 指向 \.agents/, true);
      rmSync(knitPlugin);
      symlinkSync(".agents/plugins", join(root, "plugin-directory"));
      symlinkSync(`${existing ? "../.." : cwd}/plugin-directory/../${hookName}`, knitPlugin);
      reject(/\.agents\/plugins\/knit 指向 \.agents/);
      rmSync(knitPlugin);
      symlinkSync("..", knitPlugin);
      reject(/\.agents\/plugins\/knit 指向 \.agents/);
      rmSync(knitPlugin);
      writeFileSync(knitPlugin, "ordinary file");
      reject(/无法隔离.*\.agents\/plugins\/knit/);
      rmSync(knitPlugin);
      mkdirSync(join(plugins, "KnIt"));
      writeFileSync(join(plugins, "KnIt/plugin.json"), '{"name":"knit"}');
      mkdirSync(join(plugins, "other"));
      writeFileSync(join(plugins, "other/plugin.json"), '{}');
      if (!existsSync(knitPlugin)) renameSync(join(plugins, "KnIt"), knitPlugin);
      reject(/无法隔离.*\.agents\/plugins\/other/, true);
      rmSync(join(plugins, "other"), { recursive: true });
      if (!existing) commitAll(root, "only main-session plugin");
      await f.start({ configReads: [".agents/plugins/knit/plugin.json"] });
      const run = await f.ended();
      assert.equal(run.verdict, "pass", run.failure);
      assert.deepEqual(readRows(f.transcripts()[0])[0].configReads, ["EPERM"]);
    });
  }

  check("新 Worktree 预检识别通过共享插件目录指回检出的主会话插件和隔离钩子目录", isolated, (t) => {
    const f = fixture(t);
    const cwd = worktreeOf(f.root, f.task);
    const plugins = join(f.dir, "shared-plugins");
    mkdirSync(plugins);
    mkdirSync(join(f.root, ".agents"));
    symlinkSync(plugins, join(f.root, ".agents/plugins"));
    mkdirSync(join(f.root, "main-session-plugin"));
    writeFileSync(join(f.root, "main-session-plugin/plugin.json"), '{"name":"knit"}');
    commitAll(f.root, "shared plugin directory");
    const link = join(plugins, "knit");
    const tools = [["read", "write", "exec"], null];
    symlinkSync(join(cwd, ".agents"), link);
    for (const capabilities of tools) assert.match(f.preflight(capabilities) ?? "", /\.agents\/plugins\/knit 指向 \.agents/);
    rmSync(link);
    symlinkSync(join(cwd, "main-session-plugin"), link);
    for (const capabilities of tools) assert.equal(f.preflight(capabilities), null);
  });

  check("新 Worktree 合并大小写不同的插件父目录时仍指出同级插件", isolated, async (t) => {
    const f = fixture(t, { tools: "all" });
    const manifest = ".AGENTS/Plugins/knit/plugin.json";
    mkdirSync(join(f.root, dirname(manifest)), { recursive: true });
    writeFileSync(join(f.root, manifest), '{"name":"knit"}');
    if (!existsSync(join(f.root, ".agents/plugins/knit/plugin.json"))) return t.skip("需要大小写不敏感的检出");
    commitAll(f.root, "main session plugin");
    // The Git index can contain both spellings, even on a case-insensitive test volume.
    const blob = git(f.root, "rev-parse", `HEAD:${manifest}`);
    git(f.root, "-c", "core.ignoreCase=false", "update-index", "--add", "--cacheinfo", "100644", blob, ".agents/plugins/other/plugin.json");
    git(f.root, "-c", "user.name=knit", "-c", "user.email=knit@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "same-level plugin");
    assert.match(f.preflight(), /无法隔离.*\.agents\/plugins\/other/);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });

  check("WorkBuddy 与 Qoder 主会话桥接可与 AGY 执行者共存，项目钩子只读", isolated, async (t) => {
    const f = fixture(t, { tools: "all" });
    initProject(f.root, false, { workbuddy: true, qoder: true });
    commitAll(f.root, "desktop bridge fixture");
    const paths = [".workbuddy/settings.json", ".workbuddy/knit-hook.sh", ".qoder/settings.json", ".qoder/knit-hook.sh"];
    await f.start({ configReads: paths, configWrites: paths });
    const run = await f.ended();
    assert.equal(run.verdict, "pass", run.failure);
    const [init] = readRows(f.transcripts()[0]);
    assert.deepEqual(init.configReads, paths.map(() => "allowed"));
    assert.deepEqual(init.configWrites, paths.map(() => "EPERM"));
  });

  check("组合缺少隔离能力，派发前无 Worktree 或执行记录", isolated, async (t) => {
    const f = fixture(t, { tools: "[read, external]" });
    assert.match(f.preflight(), /external.*联网/);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });

  check("兼容目录链接会屏蔽 Knit 钩子，在派发前拒绝", isolated, async (t) => {
    const f = fixture(t);
    symlinkSync(".agents", join(f.root, ".agent"));
    commitAll(f.root, "hook alias fixture");
    assert.match(f.preflight(), /\.agent 指向 \.agents.*隔离钩子/);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });

  check("新 Worktree 在派发前识别 Git 树中的间接兼容目录链接", isolated, async (t) => {
    const f = fixture(t, { tools: "[read]" });
    mkdirSync(join(f.root, "links"));
    symlinkSync("../.agents", join(f.root, "links", "custom"));
    symlinkSync("links/custom", join(f.root, ".agent"));
    commitAll(f.root, "indirect hook alias fixture");
    assert.match(f.preflight(), /\.agent 指向 \.agents.*隔离钩子/);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });

  check("新 Worktree 在派发前识别配置文件指向 Knit 钩子的链接", isolated, async (t) => {
    const f = fixture(t, { tools: "[read]" });
    mkdirSync(join(f.root, ".agent"));
    symlinkSync("../.agents/hooks.json", join(f.root, ".agent/hooks.json"));
    commitAll(f.root, "hook file alias fixture");
    assert.match(f.preflight(), /\.agent\/hooks\.json 指向 \.agents.*隔离钩子/);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });

  check("已有 Worktree 的兼容目录链接按实际钩子目录的大小写检查", isolated, async (t) => {
    const f = fixture(t, { tools: "[read]" });
    const first = await f.complete({ denied: true });
    assert.match(first.failure, /Antigravity 权限阻塞/);
    const cwd = worktreeOf(f.root, f.task);
    const agents = join(cwd, ".AgEnTs");
    const canonical = join(cwd, ".agents");
    rmSync(canonical, { recursive: true });
    mkdirSync(agents);
    if (!existsSync(canonical)) return t.skip("需要大小写不敏感的文件系统");
    symlinkSync(".AgEnTs", join(cwd, ".agent"));
    assert.match(f.preflight(), /\.agent 指向 \.agents.*隔离钩子/);
    assert.equal(JSON.parse(readFileSync(join(f.root, f.task.dir, "record.json"), "utf8")).runs.length, 1);
  });

  check("大小写不敏感的检出在派发前识别 Git 树中的钩子冲突", isolated, async (t) => {
    const f = fixture(t, { tools: "[read]" });
    mkdirSync(join(f.root, ".AgEnTs"));
    writeFileSync(join(f.root, ".AgEnTs/Hooks.json"), "{}");
    if (!existsSync(join(f.root, ".agents/hooks.json"))) return t.skip("需要大小写不敏感的文件系统");
    commitAll(f.root, "case-insensitive hook fixture");
    assert.match(f.preflight(), /已有 \.agents\/hooks\.json/);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });

  check("准备命令生成冲突的钩子时，在登记执行前撤回新 Worktree", isolated, async (t) => {
    const f = fixture(t);
    const command = "mkdir -p .agents && printf '{}' > .agents/hooks.json";
    writeFileSync(join(f.root, ".knit/config.json"), JSON.stringify({ worktree: { setup: [command] } }));
    const result = await f.command("run", "start", f.task.id);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /已有 \.agents\/hooks\.json/);
    assert.ok(!existsSync(worktreeOf(f.root, f.task)));
    assert.equal(lastRun(f.root, f.task), undefined);
  });

  for (const capabilities of [[], ["read"], ["read", "write", "exec"]]) {
    check(`macOS 外层和命令沙箱约束 tools: [${capabilities.join(", ")}]`, isolated, async (t) => {
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
      const run = await f.complete({ configReads: [manifest, join(cwd, ".agents/plugins.json")], tools: [
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
  for (const [location, source, contents] of [
    ["workspace", ".mcp.json", configuredMcp], ["workspace", ".agent/mcp_config.json", configuredMcp],
    ["workspace", ".agents/plugins", plugin], ["workspace", "_agents/plugins.json", enabledPlugins],
    ["workspace", ".agent/plugins", plugin],
    ["workspace", "_agent/hooks.json", externalHooks], ["workspace", ".gemini/config.json", {}],
    ["home", ".gemini/config/mcp_config.json", configuredMcp], ["home", ".gemini/config/plugins", plugin],
    ["home", ".gemini/config/plugins.json", enabledPlugins], ["home", ".gemini/config/hooks.json", externalHooks],
  ]) {
    check(`external 派发前指出 ${location} 的 ${source}`, isolated, async (t) => {
      const f = fixture(t, { tools: "all" });
      const path = join(location === "home" ? f.home : f.root, source);
      const file = source.endsWith("/plugins") ? join(path, source === ".agents/plugins" ? "demo/plugin.json" : "knit/plugin.json") : path;
      if (source === ".agent/mcp_config.json") {
        mkdirSync(join(f.root, "team-config"));
        symlinkSync("team-config", join(f.root, ".agent"));
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(contents));
      if (location === "workspace") commitAll(f.root, "startup configuration fixture");
      const expected = `无法隔离已配置的外部工具及其运行时写入：${location === "home" ? path : source}`;
      if ([".agent/mcp_config.json", ".gemini/config/plugins.json"].includes(source)) {
        const result = await f.command("run", "start", f.task.id);
        assert.equal(result.status, 1, result.stdout);
        assert.ok(result.stderr.includes(expected), result.stderr);
      } else {
        assert.equal(f.preflight(null), `Antigravity ${expected}${source === ".agents/plugins" ? "/demo" : ""}`);
      }
      assert.ok(!existsSync(worktreeOf(f.root, f.task)));
      assert.equal(lastRun(f.root, f.task), undefined);
    });
  }

  await Promise.all(cases);
}
