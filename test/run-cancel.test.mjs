import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { DEFAULT_STOP_GRACE_MS, stopRunProcesses } from "../dist/application/run-control.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { procStartTicks } from "../dist/infrastructure/process.js";
import { knit } from "./helpers/cli.mjs";
import { agents, readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

const CLI = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const recordOf = (dir, task) => readFileSync(join(dir, task.dir, "record.json"), "utf8");
const lastRun = (dir, task) => JSON.parse(recordOf(dir, task)).runs.at(-1);
/** 命令行里带着这次执行 id 的进程：后台进程和它启动的假 Pi（--session-dir 在执行目录里）。 */
const processesOf = (runId) => spawnSync("pgrep", ["-f", runId], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

function prepare(dir, task) {
  const { run, problems } = prepareRun({
    root: dir,
    taskId: task.id,
    workflow: workflowOf(dir),
    config: loadConfig(dir).config,
    model: null,
  });
  assert.deepEqual(problems, []);
  return run;
}
/** 每 100 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await sleep(100);
  }
  assert.fail(`等了 20 秒：${what}`);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("停掉正在跑的执行", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const script = join(outside, "script.json");
  const start = () =>
    spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script },
    });
  // 先写文件，再等一个不会出现的文件。
  const stuck = { writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }], waitFor: join(outside, "never") };
  writeFileSync(script, JSON.stringify(stuck));
  assert.equal(start().status, 0);
  const run = lastRun(dir, task);
  await waitUntil(() => existsSync(join(worktreeOf(dir, task), "src/a.ts")), "假 Pi 写出 src/a.ts");
  const { pid } = JSON.parse(readFileSync(join(dir, RUNS_DIR, run.id, "worker.json"), "utf8"));
  assert.equal(processesOf(run.id).length, 2);

  const cancelled = knit(dir, "run", "cancel", task.id);

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `已取消 ${task.id} 的执行 ${run.id}\n改动文件: 1 个\n`);
  const ended = lastRun(dir, task);
  assert.ok(!Number.isNaN(Date.parse(ended.endedAt)));
  assert.deepEqual(
    { id: ended.id, verdict: ended.verdict, failure: ended.failure, changedPaths: ended.changedPaths },
    { id: run.id, verdict: null, failure: "已取消", changedPaths: ["src/a.ts"] },
  );
  assert.equal(alive(pid), false);
  // 命令返回时后台进程和假 Pi 都已经不在了，不需要再等。
  assert.equal(processesOf(run.id).length, 0);
  assert.ok(existsSync(join(worktreeOf(dir, task), "src/a.ts")));
  assert.equal(existsSync(join(dir, "src/a.ts")), false);

  // 再派发时做的还是这个环节；这一次让它做完，不留后台进程。
  writeFileSync(script, JSON.stringify({}));
  const again = start();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /：实现（r-[0-9a-f]{12}）\n/);
  await waitUntil(() => lastRun(dir, task).endedAt !== null, "第二次执行结束");
  const next = lastRun(dir, task);
  assert.notEqual(next.id, run.id);
  assert.deepEqual({ stage: next.stage, failure: next.failure }, { stage: "implement", failure: null });
  await waitUntil(() => processesOf(next.id).length === 0, "第二次的后台进程退出");
});

test("取消后台执行时连客户端启动的子进程一起停止，并结束 wait", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const script = join(process.env.KNIT_HOME, "script.json");
  writeFileSync(script, JSON.stringify({ child: true, waitFor: join(process.env.KNIT_HOME, "never") }));
  const started = spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", dir], {
    encoding: "utf8", env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script },
  });
  assert.equal(started.status, 0, started.stderr);
  const run = lastRun(dir, task);
  t.after(() => spawnSync("pkill", ["-9", "-f", run.id]));
  await waitUntil(() => processesOf(run.id).length === 3, "后台进程、客户端和它的子进程都在跑");

  const cancelled = knit(dir, "run", "cancel", task.id);

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(lastRun(dir, task).failure, "已取消");
  assert.equal(processesOf(run.id).length, 0);
  assert.match(knit(dir, "run", "wait", task.id).stdout, /^失败: 已取消$/m);
});

test("执行者不理会 SIGTERM 时等到它被结束", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const script = join(outside, "script.json");
  const log = join(outside, "log.jsonl");
  const stuck = {
    stubborn: true,
    writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }],
    waitFor: join(outside, "never"),
  };
  writeFileSync(script, JSON.stringify(stuck));
  const started = spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script, KNIT_FAKE_PI_LOG: log },
  });
  assert.equal(started.status, 0, started.stderr);
  const run = lastRun(dir, task);
  // 测试中途失败时，这个假 Pi 自己不会退出。
  t.after(() => spawnSync("pkill", ["-9", "-f", run.id]));
  await waitUntil(() => existsSync(join(worktreeOf(dir, task), "src/a.ts")), "假 Pi 写出 src/a.ts");
  assert.equal(processesOf(run.id).length, 2);

  const cancelled = spawnSync(process.execPath, [CLI, "run", "cancel", task.id, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, KNIT_STOP_GRACE_MS: "200" },
  });

  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `已取消 ${task.id} 的执行 ${run.id}\n改动文件: 1 个\n`);
  const ended = lastRun(dir, task);
  assert.deepEqual(
    { id: ended.id, verdict: ended.verdict, failure: ended.failure, changedPaths: ended.changedPaths },
    { id: run.id, verdict: null, failure: "已取消", changedPaths: ["src/a.ts"] },
  );
  assert.equal(processesOf(run.id).length, 0);
  // 假 Pi 收到过 SIGTERM 而没有退出：它是被 SIGKILL 结束的。
  assert.ok(readFileSync(log, "utf8").includes('{"signal":"SIGTERM"}'));
});

test("进程已经不在时记为失败", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const run = prepare(dir, task);

  const cancelled = knit(dir, "run", "cancel", task.id);

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `执行 ${run.id} 的进程已经不在了，已记为失败\n改动文件: 0 个\n`);
  const ended = lastRun(dir, task);
  assert.ok(!Number.isNaN(Date.parse(ended.endedAt)));
  assert.deepEqual({ id: ended.id, failure: ended.failure }, { id: run.id, failure: "执行进程意外退出" });
});

test("没有正在跑的执行时说明", (t) => {
  const dir = runProject(t);
  const fresh = readyTask(dir);
  const ended = readyTask(dir);
  const run = prepare(dir, ended);
  const finished = finishRun({
    agents,
    root: dir,
    taskId: ended.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict: null,
    failure: null,
    sessionFile: null,
  });
  assert.deepEqual(finished, []);

  for (const task of [fresh, ended]) {
    const before = recordOf(dir, task);
    const refused = knit(dir, "run", "cancel", task.id);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, `任务 ${task.id} 没有正在跑的执行\n`);
    assert.equal(recordOf(dir, task), before);
  }
});

test("stopRunProcesses 默认宽限期保持 5000ms，支持传入短宽限期先 SIGTERM 后 SIGKILL", async (t) => {
  assert.equal(DEFAULT_STOP_GRACE_MS, 5000);
  const dir = runProject(t);
  const task = readyTask(dir);
  const run = prepare(dir, task);
  const outside = mkdtempSync(join(tmpdir(), "knit-stubborn-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const ready = join(outside, "ready");
  const sigterm = join(outside, "sigterm");
  const worker = spawn(
    process.execPath,
    ["-e", `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(sigterm)},'1'));fs.writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000);`],
    { detached: true, stdio: "ignore" },
  );
  const exited = new Promise((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
  worker.unref();
  t.after(() => {
    try {
      process.kill(-worker.pid, "SIGKILL");
    } catch {
      // 已退出。
    }
  });
  await waitUntil(() => existsSync(ready), "顽固后台进程就绪");
  writeFileSync(join(dir, RUNS_DIR, run.id, "worker.json"), JSON.stringify({ pid: worker.pid, start: procStartTicks(worker.pid) }));

  const before = Date.now();
  await stopRunProcesses(dir, run.id, 150);
  const elapsed = Date.now() - before;
  const exit = await exited;

  assert.equal(existsSync(sigterm), true);
  assert.equal(exit.signal, "SIGKILL");
  assert.equal(alive(worker.pid), false);
  assert.ok(elapsed >= 130 && elapsed < 2000, `宽限期未按预期生效：${elapsed}ms`);
});
