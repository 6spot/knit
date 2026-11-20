import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { RUNS_DIR } from "../dist/application/run-prepare.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit } from "./helpers/cli.mjs";
import { commitAll } from "./helpers/git.mjs";
import { readyTask, runProject, worktreeLine } from "./helpers/run.mjs";

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
async function bridged(t, script) {
  const dir = runProject(t);
  const bridge = await loadBridge(t, dir);
  commitAll(dir, "init");
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  const before = {
    KNIT_PI_BIN: process.env.KNIT_PI_BIN,
    KNIT_FAKE_PI: process.env.KNIT_FAKE_PI,
    KNIT_FAKE_PI_LOG: process.env.KNIT_FAKE_PI_LOG,
    PI_PROVIDER: process.env.PI_PROVIDER,
    PI_MODEL: process.env.PI_MODEL,
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

/** 每 100 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await sleep(100);
  }
  assert.fail(`等了 20 秒：${what}`);
}

test("派发后立即返回，之后能看到结果", async (t) => {
  const { dir, bridge } = await bridged(t, () => ({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }] }));
  const task = readyTask(dir);

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  const runId = lastRun(dir, task).id;
  assert.equal(text(started), `已派发 ${task.id}：实现（${runId}）\n${worktreeLine(dir, task)}会话记录：${RUNS_DIR}/${runId}/session/`);

  await waitUntil(() => lastRun(dir, task).endedAt !== null, `执行 ${runId} 结束`);
  await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
  const status = await bridge.tool("knit_run", { action: "status", taskId: task.id });
  assert.equal(status.isError, undefined, text(status));
  assert.equal(text(status), knit(dir, "run", "status", task.id).stdout.trimEnd());
  assert.match(text(status), /上一次: 实现/);
});

test("桥接 start 把 ctx.model 作为环境交给 CLI，执行者用主会话的模型", async (t) => {
  const { dir, bridge, outside } = await bridged(t, () => ({}));
  const workflow = join(dir, ".knit/workflow.yaml");
  writeFileSync(workflow, readFileSync(workflow, "utf8").replace("model: fake/model\n", ""));
  const task = readyTask(dir);
  const inherited = { PI_PROVIDER: process.env.PI_PROVIDER, PI_MODEL: process.env.PI_MODEL };

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id }, { model: { provider: "p", id: "m" } });
  assert.equal(started.isError, undefined, text(started));
  const runId = lastRun(dir, task).id;
  await waitUntil(() => lastRun(dir, task).endedAt !== null, `执行 ${runId} 结束`);
  await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
  assert.equal(lastRun(dir, task).failure, null);
  const { args } = JSON.parse(readFileSync(join(outside, "pi.jsonl"), "utf8").split("\n")[0]);
  assert.equal(args[args.indexOf("--provider") + 1], "p");
  assert.equal(args[args.indexOf("--model") + 1], "m");
  assert.deepEqual({ PI_PROVIDER: process.env.PI_PROVIDER, PI_MODEL: process.env.PI_MODEL }, inherited);
  await bridge.fire("session_shutdown");
});

[
  { name: "桥接 start 把 ctx.thinkingLevel 交给 CLI，覆盖过期环境", context: "high", override: undefined, expected: "high" },
  { name: "桥接 start 的 thinking 参数优先于 ctx.thinkingLevel", context: "high", override: "off", expected: "off" },
  { name: "桥接 start 没有当前等级时不沿用过期环境", context: undefined, override: undefined, expected: null },
].forEach((scenario) => {
  test(scenario.name, async (t) => {
    const { dir, bridge, outside } = await bridged(t, () => ({}));
    const task = readyTask(dir);
    const before = process.env.PI_REASONING_LEVEL;
    t.after(() => {
      if (before === undefined) delete process.env.PI_REASONING_LEVEL;
      if (before !== undefined) process.env.PI_REASONING_LEVEL = before;
    });
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

test("取消正在跑的执行", async (t) => {
  const { dir, bridge } = await bridged(t, (outside) => ({ waitFor: join(outside, "never") }));
  const task = readyTask(dir);

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  const runId = lastRun(dir, task).id;
  await waitUntil(() => processesOf(runId).length >= 2, `执行 ${runId} 的假 Pi 启动`);

  const cancelled = await bridge.tool("knit_run", { action: "cancel", taskId: task.id });
  assert.equal(cancelled.isError, undefined, text(cancelled));
  assert.equal(text(cancelled).split("\n")[0], `已取消 ${task.id} 的执行 ${runId}`);
  const run = lastRun(dir, task);
  assert.notEqual(run.endedAt, null);
  assert.equal(run.failure, "已取消");
  await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
});

test("命令拒绝时原样转交", async (t) => {
  const { dir, bridge } = await bridged(t, () => ({}));
  const id = knit(dir, "task", "new", "--title", "还没确认").stdout.split("\n")[0].replace("已创建 ", "");
  const refused = knit(dir, "run", "start", id);
  assert.notEqual(refused.code, 0);

  const started = await bridge.tool("knit_run", { action: "start", taskId: id });
  assert.equal(started.isError, true);
  assert.equal(text(started), refused.stderr.trimEnd());

  const status = await bridge.tool("knit_run", { action: "status", taskId: "" });
  assert.equal(status.isError, true);
  assert.equal(text(status), "knit_run 的 status 要有 taskId");
});
