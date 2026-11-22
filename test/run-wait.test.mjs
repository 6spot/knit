import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/application/config.js";
import { cancelRun, startRun, waitRun } from "../dist/application/run-control.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { buildTaskStatus } from "../dist/application/session-context.js";
import { statusLines } from "../dist/cli/run.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { procStartTicks } from "../dist/infrastructure/process.js";
import { knit } from "./helpers/cli.mjs";
import { agents, readyTask, runProject } from "./helpers/run.mjs";

const CLI = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
/** 命令行里带着这次执行 id 的进程：后台进程和它启动的假 Pi。 */
const processesOf = (runId) => spawnSync("pgrep", ["-f", runId], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

/** 每 100 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await sleep(100);
  }
  assert.fail(`等了 20 秒：${what}`);
}

test("等到正在跑的执行结束", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: join(outside, "script.json") };
  writeFileSync(env.KNIT_FAKE_PI, JSON.stringify({ waitFor: join(outside, "go") }));
  const started = spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", dir], { encoding: "utf8", env });
  assert.equal(started.status, 0, started.stderr);
  const runId = lastRun(dir, task).id;

  const waiting = spawn(process.execPath, [CLI, "run", "wait", task.id, "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "", code: undefined };
  waiting.stdout.on("data", (chunk) => (output.stdout += chunk));
  waiting.stderr.on("data", (chunk) => (output.stderr += chunk));
  waiting.on("close", (code) => (output.code = code));
  t.after(() => waiting.kill());

  const before = Date.now();
  const limited = spawnSync(process.execPath, [CLI, "run", "wait", task.id, "--dir", dir, "--timeout", "1"], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.ok(Date.now() - before >= 1000);
  assert.equal(limited.status, 0, limited.error?.message ?? limited.stderr);
  assert.match(limited.stdout, /^正在跑: 实现/m);
  assert.match(limited.stdout, /批次仍在运行/);
  assert.equal(lastRun(dir, task).endedAt, null);
  assert.deepEqual(output, { stdout: "", stderr: "", code: undefined });

  writeFileSync(join(outside, "go"), "");
  await waitUntil(() => output.code !== undefined, "knit run wait 退出");
  await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
  assert.deepEqual(output, { stdout: knit(dir, "run", "status", task.id).stdout, stderr: "", code: 0 });
  assert.match(output.stdout, /^上一次: 实现/m);
});

test("等待期间流程配置变坏时立即报错，执行者仍继续运行", async (t) => {
  t.after(() => {
    writeFileSync(file, original);
    if (lastRun(dir, task).endedAt === null) knit(dir, "run", "cancel", task.id);
  });
  const dir = runProject(t);
  const task = readyTask(dir);
  const script = join(process.env.KNIT_HOME, "script.json");
  const gate = join(process.env.KNIT_HOME, "go");
  writeFileSync(script, JSON.stringify({ waitFor: gate }));
  const started = spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", dir], {
    encoding: "utf8", env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script },
  });
  assert.equal(started.status, 0, started.stderr);
  const runId = lastRun(dir, task).id;
  const file = join(dir, ".knit/workflow.yaml");
  const original = readFileSync(file, "utf8");
  const waiting = spawn(process.execPath, [CLI, "run", "wait", task.id, "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "", code: undefined };
  waiting.stdout.on("data", (chunk) => (output.stdout += chunk));
  waiting.stderr.on("data", (chunk) => (output.stderr += chunk));
  waiting.on("close", (code) => (output.code = code));
  t.after(() => waiting.kill());
  await sleep(1500);
  assert.equal(output.code, undefined);

  writeFileSync(file, original.replace("version: 1", "version: 999"));
  await waitUntil(() => output.code !== undefined, "wait 重新校验流程后退出");

  assert.equal(output.code, 1);
  assert.equal(output.stdout, "");
  assert.notEqual(output.stderr, "");
  assert.equal(lastRun(dir, task).endedAt, null);
  writeFileSync(file, original);
  writeFileSync(gate, "");
  assert.match(knit(dir, "run", "wait", task.id).stdout, /^结果: 正常结束$/m);
  await waitUntil(() => processesOf(runId).length === 0, "执行进程退出");
});

test("批次刚入账时的 wait 和 cancel 会等 worker 登记进程身份", async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const source = "version: 1\nmodel: fake/model\nstages:\n  - id: check\n    tools: [read]\n    executors: [{id: a}, {id: b}]\n";
  writeFileSync(join(root, ".knit/workflow.yaml"), source);
  const input = { root, taskId: task.id, workflow: parseWorkflow(source).workflow, config: loadConfig(root).config, model: null };
  const pending = {};
  const prepared = startRun({ ...input, workerCommand: () => {
    pending.status ??= knit(root, "run", "status", task.id);
    pending.wait ??= waitRun(root, task.id);
    pending.cancel ??= cancelRun({ ...input, agents });
    return [process.execPath, "-e", "setTimeout(() => {}, 20000)"];
  } });
  assert.deepEqual(prepared.problems, []);
  try {
    assert.equal(pending.status.code, 0, pending.status.stderr);
    prepared.runs.forEach((run) => assert.ok(pending.status.stdout.includes(`正在启动: check（${run.id}）`)));
    assert.equal(await Promise.race([pending.wait.then(() => true), sleep(20, false)]), false);
    const cancelled = await pending.cancel;
    assert.deepEqual(cancelled.problems, []);
    assert.deepEqual(cancelled.runs.map((run) => run.workerMissing), [false, false]);
    const { runs } = JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8"));
    assert.deepEqual(runs.map((run) => run.failure), ["已取消", "已取消"]);
  } finally {
    await pending.cancel;
    if (lastRun(root, task).endedAt === null) await cancelRun({ ...input, agents });
    await pending.wait;
  }
});

test("两次轮询之间派发下一环节，原等待返回所等批次的全部报告", async (t) => {
  const root = runProject(t);
  const source = "version: 1\nmodel: fake/model\nstages:\n  - id: check\n    tools: [read]\n    executors: [{id: a}, {id: b}]\n  - id: implement\n";
  writeFileSync(join(root, ".knit/workflow.yaml"), source);
  const task = readyTask(root);
  const input = { root, taskId: task.id, workflow: parseWorkflow(source).workflow, config: loadConfig(root).config, model: null };
  const prepare = () => {
    const result = prepareRun(input);
    assert.deepEqual(result.problems, []);
    // 本测试进程提供可观测的存活标识，使结算和下一次派发能在同一次轮询间隔内完成。
    result.runs.forEach((run) => writeFileSync(join(root, run.dir, "worker.json"), JSON.stringify({ pid: process.pid, start: procStartTicks(process.pid) })));
    return result.runs;
  };
  const finish = (run) => assert.deepEqual(finishRun({ ...input, agents, runId: run.id, verdict: null, failure: null, sessionFile: null }), []);
  const batch = prepare();
  const waiting = waitRun(root, task.id);
  batch.forEach(finish);
  const [next] = prepare();
  try {
    const waited = await Promise.race([waiting, sleep(4000, null, { ref: false })]);
    assert.ok(waited, "wait 还在等待下一环节");
    assert.equal(lastRun(root, task).endedAt, null);
    const output = statusLines(buildTaskStatus(root, task.dir, waited.workflow, waited.task.document, waited.task.record, waited.batchId)).join("\n");
    batch.forEach((run) => assert.ok(output.includes(`${run.dir}/report.md`)));
    assert.ok(!output.includes(next.id));
  } finally {
    finish(next);
    await waiting;
  }
});

test("没有执行在跑时立即返回", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);

  const status = knit(dir, "run", "status", task.id);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(knit(dir, "run", "wait", task.id), status);
  assert.deepEqual(knit(dir, "run", "wait", task.id, "--timeout", "1"), status);
  for (const value of ["0", "-1", "1.5", "1e2"]) {
    const invalid = knit(dir, "run", "wait", task.id, "--timeout", value);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /正整数秒数/);
  }

  const missing = knit(dir, "run", "wait", "k-000000000000");
  assert.deepEqual(missing, { code: 1, stdout: "", stderr: knit(dir, "run", "status", "k-000000000000").stderr });
  assert.notEqual(missing.stderr, "");
});

test("只读检出仅有批次记录时可以查看和等待，运行目录按原状保留", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const source = "version: 1\nmodel: fake/model\nstages:\n  - id: review\n    tools: [read]\n    executors: [{id: a}, {id: b}]\n";
  writeFileSync(join(root, ".knit/workflow.yaml"), source);
  const prepared = prepareRun({ root, taskId: task.id, workflow: parseWorkflow(source).workflow, config: loadConfig(root).config, model: null });
  assert.deepEqual(prepared.problems, []);
  const runtime = join(root, ".knit/.runtime");
  rmSync(runtime, { recursive: true });
  chmodSync(join(root, ".knit"), 0o555);
  try {
    for (const command of [["run", "status"], ["context"], ["run", "wait"]]) {
      const result = knit(root, ...command, task.id);
      assert.equal(result.code, 0, result.stderr);
      prepared.runs.forEach((run) => assert.ok(result.stdout.includes(`执行 ${run.id} 的进程已经不在了`)));
      assert.equal(existsSync(runtime), false);
    }
  } finally {
    chmodSync(join(root, ".knit"), 0o755);
  }
});

test("后台进程不在了也返回", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const workflow = parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
  const prepared = prepareRun({ root: dir, taskId: task.id, workflow, config: loadConfig(dir).config, model: null });
  assert.deepEqual(prepared.problems, []);
  assert.equal(lastRun(dir, task).endedAt, null);

  const waited = spawnSync(process.execPath, [CLI, "run", "wait", task.id, "--dir", dir], { encoding: "utf8", timeout: 5000 });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.stdout, knit(dir, "run", "status", task.id).stdout);
  assert.match(waited.stdout, new RegExp(`knit run cancel ${task.id}`));
});

test("执行在读完记录之后、看后台进程之前正常结束", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: join(outside, "script.json") };
  writeFileSync(env.KNIT_FAKE_PI, JSON.stringify({ waitFor: join(outside, "go") }));
  const started = spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", dir], { encoding: "utf8", env });
  assert.equal(started.status, 0, started.stderr);
  const runId = lastRun(dir, task).id;

  // knit run wait 读完任务记录之后去读 worker.json；换成命名管道，它就停在这两步之间。
  const identityFile = join(dir, RUNS_DIR, runId, "worker.json");
  const identity = readFileSync(identityFile, "utf8");
  rmSync(identityFile);
  assert.equal(spawnSync("mkfifo", [identityFile]).status, 0);

  const waiting = spawn(process.execPath, [CLI, "run", "wait", task.id, "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "", code: undefined };
  waiting.stdout.on("data", (chunk) => (output.stdout += chunk));
  waiting.stderr.on("data", (chunk) => (output.stderr += chunk));
  waiting.on("close", (code) => (output.code = code));
  t.after(() => waiting.kill());

  // 只写方式打开管道会一直等到有人来读：打开成功就是 knit run wait 已经停在上面了。
  const writer = await Promise.race([open(identityFile, constants.O_WRONLY), sleep(20000, null, { ref: false })]);
  if (writer === null) {
    // 让上面那次打开返回，不然测试进程退不出去。
    closeSync(openSync(identityFile, "r+"));
    assert.fail("等了 20 秒：knit run wait 没有去读 worker.json");
  }
  t.after(() => writer.close());
  // 路径换回普通文件：knit run wait 已经打开的管道不受影响，之后别的读取不会再停住。
  rmSync(identityFile);
  writeFileSync(identityFile, identity);

  writeFileSync(join(outside, "go"), "");
  await waitUntil(() => lastRun(dir, task).endedAt !== null, "执行结束");
  await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
  assert.deepEqual(output, { stdout: "", stderr: "", code: undefined });

  await writer.writeFile(identity);
  await writer.close();
  await waitUntil(() => output.code !== undefined, "knit run wait 退出");
  assert.deepEqual(output, { stdout: knit(dir, "run", "status", task.id).stdout, stderr: "", code: 0 });
  assert.match(output.stdout, /^结果: 正常结束$/m);
});
