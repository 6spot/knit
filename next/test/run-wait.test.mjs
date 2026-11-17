import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/application/config.js";
import { prepareRun } from "../dist/application/run-prepare.js";
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
