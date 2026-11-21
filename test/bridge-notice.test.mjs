import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { scanTasks } from "../dist/application/task-store.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit } from "./helpers/cli.mjs";
import { commitAll } from "./helpers/git.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";

const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const text = (result) => result.content[0].text;
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
const pgrep = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
/** 桥接为这个任务启动的 `knit run wait`。别的测试文件同时在跑，所以按任务 id 找。 */
const waitersOf = (task) => pgrep(`run wait ${task.id}`);

/**
 * 加载了桥接的临时仓库，初始化生成的文件已经提交，里面有一个已经确认的任务；
 * 执行者是假 Pi，照 `script(outside)` 做事，`outside` 是项目外面的一个临时目录。
 * 桥接运行的 knit 继承这里设的环境变量，测试结束时改回去。
 */
async function bridged(t, script) {
  const dir = runProject(t);
  const bridge = await loadBridge(t, dir, {
    onMessage: (message, options) => {
      const run = scanTasks(dir).flatMap((task) => task.record?.runs ?? []).find((run) => message.content.includes(run.id));
      assert.ok(run, "通知指向实际执行记录");
      assert.notEqual(run.endedAt, null, "发送通知时终态已经入账");
      assert.doesNotMatch(message.content, /^正在跑:/m);
      assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
    },
  });
  commitAll(dir, "init");
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  const before = { KNIT_PI_BIN: process.env.KNIT_PI_BIN, KNIT_FAKE_PI: process.env.KNIT_FAKE_PI };
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(outside, { recursive: true, force: true });
  });
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_PI = join(outside, "script.json");
  writeFileSync(process.env.KNIT_FAKE_PI, JSON.stringify(script(outside)));
  return { dir, bridge, outside, task: readyTask(dir) };
}

/** 每 100 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await sleep(100);
  }
  assert.fail(`等了 20 秒：${what}`);
}

/** 等这次执行在记录里结束，并且它的后台进程和假 Pi 都退出。 */
async function ended(dir, task) {
  await waitUntil(() => lastRun(dir, task).endedAt !== null, "执行结束");
  await waitUntil(() => pgrep(lastRun(dir, task).id).length === 0, "执行的进程退出");
}

test("结束时发一条消息", async (t) => {
  const { dir, bridge, task } = await bridged(t, () => ({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }] }));

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  assert.deepEqual(bridge.messages, []);

  await ended(dir, task);
  for (let tries = 0; tries < 50 && bridge.messages.length === 0; tries += 1) await sleep(100);
  assert.deepEqual(bridge.messages, [
    {
      message: {
        customType: "knit.run-ended",
        content: `Knit 的执行结束了：\n${knit(dir, "run", "status", task.id).stdout.trimEnd()}`,
        display: true,
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
  assert.match(bridge.messages[0].message.content, /^上一次: 实现/m);
  await waitUntil(() => waitersOf(task).length === 0, "knit run wait 退出");
  await sleep(1500);
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
  const { dir, bridge, outside, task } = await bridged(t, (outside) => ({ waitFor: join(outside, "go") }));
  tasks.push(task, readyTask(dir));
  const first = await bridge.tool("knit_run", { action: "start", taskId: tasks[0].id });
  assert.equal(first.isError, undefined, text(first));
  const second = await bridge.tool("knit_run", { action: "start", taskId: tasks[1].id });
  assert.equal(second.isError, undefined, text(second));
  await waitUntil(() => tasks.every((task) => waitersOf(task).length === 1 && pgrep(lastRun(dir, task).id).length === 2), "两个执行者和两个按任务等待的进程都在跑");
  tasks.forEach((task) => {
    assert.equal(lastRun(dir, task).endedAt, null);
    assert.match(knit(dir, "run", "status", task.id).stdout, /正在跑: 实现/);
  });
  assert.deepEqual(bridge.messages, []);

  writeFileSync(join(outside, "go"), "");
  await Promise.all(tasks.map((task) => ended(dir, task)));
  await waitUntil(() => bridge.messages.length === 2, "每个任务各收到一条通知");
  const expected = tasks.map((task) => ({
    message: {
      customType: "knit.run-ended",
      content: `Knit 的执行结束了：\n${knit(dir, "run", "status", task.id).stdout.trimEnd()}`,
      display: true,
    },
    options: { deliverAs: "followUp", triggerTurn: true },
  }));
  const byContent = (first, second) => first.message.content.localeCompare(second.message.content);
  assert.deepEqual([...bridge.messages].sort(byContent), expected.sort(byContent));
  await waitUntil(() => tasks.every((task) => waitersOf(task).length === 0), "全部 knit run wait 退出");
  await sleep(1500);
  assert.equal(bridge.messages.length, 2);
});

test("自己取消的不通知", async (t) => {
  const { dir, bridge, task } = await bridged(t, (outside) => ({ waitFor: join(outside, "never") }));

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  await waitUntil(() => waitersOf(task).length === 1, "桥接启动 knit run wait");

  const cancelled = await bridge.tool("knit_run", { action: "cancel", taskId: task.id });
  assert.equal(cancelled.isError, undefined, text(cancelled));
  assert.equal(lastRun(dir, task).failure, "已取消");
  await sleep(2500);
  assert.deepEqual(bridge.messages, []);
  assert.deepEqual(waitersOf(task), []);
  await ended(dir, task);
});

test("会话结束之后不再等", async (t) => {
  const { dir, bridge, outside, task } = await bridged(t, (outside) => ({ waitFor: join(outside, "go") }));

  const started = await bridge.tool("knit_run", { action: "start", taskId: task.id });
  assert.equal(started.isError, undefined, text(started));
  await waitUntil(() => waitersOf(task).length === 1, "桥接启动 knit run wait");

  await bridge.fire("session_shutdown", { reason: "reload" });
  writeFileSync(join(outside, "go"), "");
  await ended(dir, task);
  assert.equal(lastRun(dir, task).failure, null);
  await sleep(2500);
  assert.deepEqual(bridge.messages, []);
  assert.deepEqual(waitersOf(task), []);
});
