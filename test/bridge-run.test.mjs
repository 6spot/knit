import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RUNS_DIR } from "../dist/application/run-prepare.js";
import { buildSessionContext, statusLines } from "../dist/application/session-context.js";
import { createTask, scanTasks } from "../dist/application/task-store.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit } from "./helpers/cli.mjs";
import { commitAll, git } from "./helpers/git.mjs";
import { readyTask, runProject, worktreeLine } from "./helpers/run.mjs";

// macOS 的 /usr/bin/git 会再启动工具链中的 Git。临时仓库可以直接用同一安装。
if (process.platform === "darwin") process.env.PATH = `${git(process.cwd(), "--exec-path")}:${process.env.PATH}`;

const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const text = (result) => result.content[0].text;
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
/** 命令行里带着这次执行 id 的进程：后台进程和它启动的假 Pi。 */
const processesOf = (runId) => spawnSync("pgrep", ["-f", runId], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

/**
 * 加载了桥接的临时仓库，初始化生成的文件已经提交；执行者是假 Pi，照 `script(outside)` 做事，
 * `outside` 是项目外面的一个临时目录。
 * 桥接运行的 knit 继承这里设的环境变量，测试结束时改回去。
 */
async function bridged(t, script, options) {
  const dir = runProject(t);
  const bridge = await loadBridge(t, dir, options);
  commitAll(dir, "init");
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  const before = {
    KNIT_PI_BIN: process.env.KNIT_PI_BIN,
    KNIT_FAKE_PI: process.env.KNIT_FAKE_PI,
    KNIT_FAKE_PI_LOG: process.env.KNIT_FAKE_PI_LOG,
    PI_PROVIDER: process.env.PI_PROVIDER,
    PI_MODEL: process.env.PI_MODEL,
    PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(outside, { recursive: true, force: true });
  });
  // 桥接在 Pi 里直接 spawn，不会拿到 bash 工具注入的会话模型。
  delete process.env.PI_PROVIDER;
  delete process.env.PI_MODEL;
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_PI = join(outside, "script.json");
  process.env.KNIT_FAKE_PI_LOG = join(outside, "pi.jsonl");
  writeFileSync(process.env.KNIT_FAKE_PI, JSON.stringify(script(outside)));
  return { dir, bridge, outside };
}

/** 每 50 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 400; tries += 1) {
    if (done()) return;
    await sleep(50);
  }
  assert.fail(`等了 20 秒：${what}`);
}

[
  { name: "桥接 start 的 thinking 参数优先于 ctx.thinkingLevel", context: "high", override: "off", expected: "off" },
  { name: "桥接 start 没有当前等级时不沿用过期环境", context: undefined, override: undefined, expected: null },
].forEach((scenario) => {
  test(scenario.name, async (t) => {
    const { dir, bridge, outside } = await bridged(t, () => ({}));
    const task = readyTask(dir);
    process.env.PI_REASONING_LEVEL = "low";

    const started = await bridge.tool(
      "knit_run",
      { action: "start", taskId: task.id, thinking: scenario.override },
      { thinkingLevel: scenario.context },
    );
    assert.equal(started.isError, undefined, text(started));
    const runId = lastRun(dir, task).id;
    await waitUntil(() => lastRun(dir, task).endedAt !== null, `执行 ${runId} 结束`);
    await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
    assert.equal(lastRun(dir, task).failure, null);
    const { args } = JSON.parse(readFileSync(join(outside, "pi.jsonl"), "utf8").split("\n")[0]);
    assert.equal(args.includes("--thinking"), scenario.expected !== null);
    if (scenario.expected !== null) assert.equal(args[args.indexOf("--thinking") + 1], scenario.expected);
    assert.equal(process.env.PI_REASONING_LEVEL, "low");
    await bridge.fire("session_shutdown");
  });
});

test("命令拒绝时原样转交", async (t) => {
  const { dir, bridge } = await bridged(t, () => ({}));
  const { created, problems } = createTask(dir, { title: "还没确认", slug: "draft", verification: "self", priority: "P2", parent: null, dependsOn: [] });
  assert.deepEqual(problems, []);
  const id = created.id;
  const refused = knit(dir, "run", "start", id);
  assert.notEqual(refused.code, 0);

  const started = await bridge.tool("knit_run", { action: "start", taskId: id });
  assert.equal(started.isError, true);
  assert.equal(text(started), refused.stderr.trimEnd());

  const status = await bridge.tool("knit_run", { action: "status", taskId: "" });
  assert.equal(status.isError, true);
  assert.equal(text(status), "knit_run 的 status 要有 taskId");
});

const pgrep = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
/** 桥接为这个任务启动的 `knit run wait`。别的测试文件同时在跑，所以按任务 id 找。 */
const waitersOf = (task) => pgrep(`run wait ${task.id}`);

/**
 * 加载了桥接的临时仓库，初始化生成的文件已经提交，里面有一个已经确认的任务；
 * 执行者是假 Pi，照 `script(outside)` 做事，`outside` 是项目外面的一个临时目录。
 * 桥接运行的 knit 继承这里设的环境变量，测试结束时改回去。
 */
async function notificationBridge(t, script) {
  const { dir, bridge, outside } = await bridged(t, script, {
    onMessage: (message, options) => {
      const run = scanTasks(dir).flatMap((task) => task.record?.runs ?? []).find((run) => message.content.includes(run.id));
      assert.ok(run, "通知指向实际执行记录");
      assert.notEqual(run.endedAt, null, "发送通知时终态已经入账");
      assert.doesNotMatch(message.content, /^正在跑:/m);
      assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
    },
  });
  return { dir, bridge, outside, task: readyTask(dir) };
}

function statusText(dir, task) {
  const context = buildSessionContext(dir, task.id);
  assert.equal(context.kind, "context");
  return statusLines(context.task.status).join("\n");
}

/** 等这次执行在记录里结束，并且它的后台进程和假 Pi 都退出。 */
async function ended(dir, task) {
  await waitUntil(() => lastRun(dir, task).endedAt !== null, "执行结束");
  await waitUntil(() => pgrep(lastRun(dir, task).id).length === 0, "执行的进程退出");
}

test("桥接派发透传模型、思考等级、多行指令与 fresh，立即返回并在结束时通知一次", async (t) => {
  const { dir, bridge, outside, task } = await notificationBridge(t, (outside) => ({ waitFor: join(outside, "go"), writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }] }));
  const workflow = join(dir, ".knit/workflow.yaml");
  writeFileSync(workflow, readFileSync(workflow, "utf8").replace("model: fake/model\n", ""));
  process.env.PI_REASONING_LEVEL = "low";
  const instruction = "--修订第一项\n保留引号 ' 和空格";
  const schema = bridge.definitions.find((tool) => tool.name === "knit_run").parameters;
  assert.equal(schema.properties.instruction.type, "string");
  assert.equal(schema.properties.fresh.type, "boolean");
  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id, instruction, fresh: true },
    { model: { provider: "p", id: "m" }, thinkingLevel: "high" });
  assert.equal(started.isError, undefined, text(started));
  const run = lastRun(dir, task);
  try {
    assert.equal(text(started), `已派发 ${task.id}：实现（${run.id}）\n${worktreeLine(dir, task)}会话记录：${RUNS_DIR}/${run.id}/session/`);
    assert.equal(run.endedAt, null);
    assert.deepEqual(bridge.messages, []);
  } finally {
    writeFileSync(join(outside, "go"), "");
  }
  await ended(dir, task);
  assert.equal(lastRun(dir, task).failure, null);
  const [{ args }, ...events] = readFileSync(join(outside, "pi.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
  for (const [option, expected] of [["--provider", "p"], ["--model", "m"], ["--thinking", "high"]]) {
    assert.ok(args.includes(option));
    assert.equal(args[args.indexOf(option) + 1], expected);
  }
  assert.ok(events.some((event) => event.message?.includes(`<main-instruction>\n${instruction}\n</main-instruction>`)));
  assert.match(readFileSync(join(dir, RUNS_DIR, run.id, "worker.log"), "utf8"), /新会话（指定了 --fresh）/);
  assert.deepEqual([process.env.PI_PROVIDER, process.env.PI_MODEL, process.env.PI_REASONING_LEVEL], [undefined, undefined, "low"]);
  const status = await bridge.tool("knit_run", { action: "status", taskId: task.id });
  assert.equal(status.isError, undefined, text(status));
  assert.equal(text(status), knit(dir, "run", "status", task.id).stdout.trimEnd());
  await waitUntil(() => bridge.messages.length > 0, "执行结束通知");
  assert.deepEqual(bridge.messages, [
    {
      message: {
        customType: "knit.run-ended",
        content: `Knit 的执行结束了：\n${text(status)}`,
        display: true,
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
  assert.match(bridge.messages[0].message.content, /^上一次: 实现/m);
  await waitUntil(() => waitersOf(task).length === 0, "knit run wait 退出");
  assert.equal(bridge.messages.length, 1);
});

test("两个任务同时执行，桥接各等一次结束并各发一条通知", async (t) => {
  const tasks = [];
  t.after(async () => {
    await bridge.fire("session_shutdown", { reason: "reload" });
    tasks.filter((task) => lastRun(dir, task)?.endedAt === null).forEach((task) => {
      const cancelled = knit(dir, "run", "cancel", task.id);
      assert.equal(cancelled.code, 0, cancelled.stderr);
    });
    await Promise.all(tasks.filter((task) => lastRun(dir, task) !== undefined).map((task) => ended(dir, task)));
    await waitUntil(() => tasks.every((task) => waitersOf(task).length === 0), "全部 knit run wait 退出");
  });
  const { dir, bridge, outside, task } = await notificationBridge(t, (outside) => ({ waitFor: join(outside, "go") }));
  tasks.push(task, readyTask(dir));
  const first = await bridge.tool("knit_run", { action: "start", taskId: tasks[0].id });
  assert.equal(first.isError, undefined, text(first));
  const second = await bridge.tool("knit_run", { action: "start", taskId: tasks[1].id });
  assert.equal(second.isError, undefined, text(second));
  await waitUntil(() => tasks.every((task) => waitersOf(task).length === 1 && pgrep(lastRun(dir, task).id).length === 2), "两个执行者和两个按任务等待的进程都在跑");
  tasks.forEach((task) => {
    assert.equal(lastRun(dir, task).endedAt, null);
    assert.match(statusText(dir, task), /正在跑: 实现/);
  });
  assert.deepEqual(bridge.messages, []);

  writeFileSync(join(outside, "go"), "");
  await Promise.all(tasks.map((task) => ended(dir, task)));
  await waitUntil(() => bridge.messages.length === 2, "每个任务各收到一条通知");
  const expected = tasks.map((task) => ({
    message: {
      customType: "knit.run-ended",
      content: `Knit 的执行结束了：\n${statusText(dir, task)}`,
      display: true,
    },
    options: { deliverAs: "followUp", triggerTurn: true },
  }));
  const byContent = (first, second) => first.message.content.localeCompare(second.message.content);
  assert.deepEqual([...bridge.messages].sort(byContent), expected.sort(byContent));
  await waitUntil(() => tasks.every((task) => waitersOf(task).length === 0), "全部 knit run wait 退出");
  assert.equal(bridge.messages.length, 2);
});

test("同一批审查等最后一名结束才通知，列出两个报告和各自的结论", async (t) => {
  const { dir, bridge, outside, task } = await notificationBridge(t, () => ({ texts: ['```json\n{"verdict":"pass"}\n```'] }));
  const gate = join(outside, "release");
  writeFileSync(join(outside, "slow.json"), JSON.stringify({ waitFor: gate, texts: ['```json\n{"verdict":"changes_requested"}\n```'] }));
  const launcher = join(outside, "pi");
  writeFileSync(launcher, `#!/bin/sh\nfor arg do\n  if [ "$arg" = slow ]; then export KNIT_FAKE_PI="$(dirname "$0")/slow.json"; fi\ndone\nexec "${FAKE_PI}" "$@"\n`, { mode: 0o755 });
  process.env.KNIT_PI_BIN = launcher;
  writeFileSync(join(dir, ".knit/workflow.yaml"), ["version: 1", "stages:", "  - id: review", "    tools: [read]",
    "    executors: [{id: first, model: fake/fast}, {id: second, model: fake/slow}]",
    "    report: {verdict: [pass, changes_requested]}", ""].join("\n"));
  const runs = () => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs;
  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  try {
    await waitUntil(() => runs()[0].endedAt !== null, "第一名已入账");
    assert.equal(runs()[1].endedAt, null);
    await sleep(1500); // 跨过 wait 的一次轮询。
    assert.deepEqual(bridge.messages, []);
  } finally {
    writeFileSync(gate, "");
  }
  await waitUntil(() => bridge.messages.length > 0, "批次结束通知");
  const [notice] = bridge.messages;
  assert.equal(notice.message.customType, "knit.run-ended");
  assert.deepEqual(runs().map((run) => run.verdict), ["pass", "changes_requested"]);
  for (const run of runs()) {
    assert.ok(notice.message.content.includes(`${run.executor}（pi）：${run.verdict}，.knit/.runtime/runs/${run.id}/report.md`));
  }
  await waitUntil(() => waitersOf(task).length === 0, "批次等待退出");
  assert.equal(bridge.messages.length, 1);
});

test("自己取消的不通知", async (t) => {
  const { dir, bridge, task } = await notificationBridge(t, (outside) => ({ waitFor: join(outside, "never") }));

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  const runId = lastRun(dir, task).id;
  await waitUntil(() => waitersOf(task).length === 1 && processesOf(runId).length >= 2, "桥接与假 Pi 都已启动");

  const cancelled = await bridge.tool("knit_run", { action: "cancel", taskId: task.id });
  assert.equal(cancelled.isError, undefined, text(cancelled));
  assert.equal(text(cancelled).split("\n")[0], `已取消 ${task.id} 的执行 ${runId}`);
  assert.equal(lastRun(dir, task).failure, "已取消");
  await ended(dir, task);
  await waitUntil(() => waitersOf(task).length === 0, "取消后 knit run wait 退出");
  assert.deepEqual(bridge.messages, []);
});

test("会话结束之后不再等", async (t) => {
  const { dir, bridge, outside, task } = await notificationBridge(t, (outside) => ({ waitFor: join(outside, "go") }));

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  await waitUntil(() => waitersOf(task).length === 1, "桥接启动 knit run wait");

  await bridge.fire("session_shutdown", { reason: "reload" });
  await waitUntil(() => waitersOf(task).length === 0, "重载后 knit run wait 退出");
  assert.equal(lastRun(dir, task).endedAt, null);
  writeFileSync(join(outside, "go"), "");
  await ended(dir, task);
  assert.equal(lastRun(dir, task).failure, null);
  assert.deepEqual(bridge.messages, []);
  assert.deepEqual(waitersOf(task), []);
});
