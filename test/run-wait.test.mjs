import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/application/config.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit } from "./helpers/cli.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";

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

  await sleep(1500);
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

test("没有执行在跑时立即返回", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);

  const status = knit(dir, "run", "status", task.id);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(knit(dir, "run", "wait", task.id), status);

  const missing = knit(dir, "run", "wait", "k-000000000000");
  assert.deepEqual(missing, { code: 1, stdout: "", stderr: knit(dir, "run", "status", "k-000000000000").stderr });
  assert.notEqual(missing.stderr, "");
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
