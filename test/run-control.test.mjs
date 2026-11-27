import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PiExecutionAdapter } from "../dist/adapters/pi/execution.js";
import { executeRun } from "../dist/application/run-execute.js";
import { loadConfig } from "../dist/application/project-config.js";
import { DEFAULT_STOP_GRACE_MS, cancelRun, startRun, stopRunProcesses, waitRun } from "../dist/application/run-control.js";
import { finishRun } from "../dist/application/run-finish.js";
import { RUNS_DIR, prepareRun } from "../dist/application/run-prepare.js";
import { buildTaskStatus, statusLines } from "../dist/application/session-context.js";
import { createTask, readTask } from "../dist/application/task-store.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { procStartTicks } from "../dist/infrastructure/process.js";
import { knit } from "./helpers/cli.mjs";
import { git } from "./helpers/git.mjs";
import { agents, nodeCommand, readyTask, runProject, setupConfig, worktreeLine, worktreeOf } from "./helpers/run.mjs";

// 鉴于 macOS 的 /usr/bin/git 是启动器，临时仓库直接使用当前 Git 安装的命令目录。
if (process.platform === "darwin") process.env.PATH = `${execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()}:${process.env.PATH}`;

const CLI = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);

/** 假 Pi 的脚本放在项目目录之外；返回写脚本的函数、运行 knit 的函数和这个目录。 */
function fakePi(t, dir, environment = {}) {
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const env = {
    ...process.env,
    KNIT_PI_BIN: FAKE_PI,
    KNIT_FAKE_PI: join(outside, "script.json"),
    KNIT_FAKE_PI_LOG: join(outside, "pi.jsonl"),
    ...environment,
  };
  return {
    outside,
    script: (script) => writeFileSync(env.KNIT_FAKE_PI, JSON.stringify(script)),
    knit: (...args) => cliCommand([...args, "--dir", dir], { env }),
  };
}
function cliCommand(args, options) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], options, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** 每 50 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 400; tries += 1) {
    if (done()) return;
    await sleep(50);
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
/** 等这次执行在记录里结束、后台进程退出；返回记录里的这一项。 */
async function finished(dir, task, runId) {
  await waitUntil(() => lastRun(dir, task).endedAt !== null, `执行 ${runId} 结束`);
  const { pid } = JSON.parse(readFileSync(join(dir, RUNS_DIR, runId, "worker.json"), "utf8"));
  await waitUntil(() => !alive(pid), `后台进程 ${pid} 退出`);
  const run = lastRun(dir, task);
  assert.equal(run.id, runId);
  return run;
}
const startedRunId = (stdout) => stdout.match(/（(r-[0-9a-f]{12})）/)[1];

[
  { PI_PROVIDER: undefined, PI_MODEL: undefined },
  { PI_PROVIDER: "p", PI_MODEL: undefined },
  { PI_PROVIDER: undefined, PI_MODEL: "m" },
].forEach((environment) => {
  test(`没有完整的主会话模型时拒绝：${JSON.stringify(environment)}`, async (t) => {
    const dir = runProject(t);
    const workflow = join(dir, ".knit/workflow.yaml");
    writeFileSync(workflow, readFileSync(workflow, "utf8").replace("model: fake/model\n", ""));
    const task = readyTask(dir);
    const before = ["task.md", "record.json"].map((file) => readFileSync(join(dir, task.dir, file), "utf8"));
    const pi = fakePi(t, dir, environment);

    const refused = await pi.knit("run", "start", task.id);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr,
      "没有指定执行者的模型：不在 Pi 会话里时，在 .knit/workflow.yaml 里写 model，或加 --model provider/模型\n",
    );
    assert.equal(existsSync(join(dir, RUNS_DIR)), false);
    assert.equal(existsSync(join(process.env.KNIT_HOME, "worktrees")), false);
    assert.deepEqual(["task.md", "record.json"].map((file) => readFileSync(join(dir, task.dir, file), "utf8")), before);
  });
});

test("不能派发时不启动进程", async (t) => {
  const dir = runProject(t);
  const pi = fakePi(t, dir);
  const id = draftTask(dir);

  const refused = await pi.knit("run", "start", id);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, `需求还没有确认，或确认之后改过；先运行 knit task ready ${id}\n`);
  assert.equal(existsSync(join(dir, RUNS_DIR)), false);
});

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;

function draftTask(dir) {
  const result = createTask(dir, { title: "还没确认", slug: "draft", verification: "self", priority: "P2", parent: null, dependsOn: [] });
  assert.deepEqual(result.problems, []);
  return result.created.id;
}
function status(dir, id) {
  const { task } = readTask(dir, id);
  return `${statusLines(buildTaskStatus(dir, task.stored.dir, workflowOf(dir), task.document, task.record)).join("\n")}\n`;
}
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
async function dispatchDefaults(dir, task, pi, sessionDefaults, overrides) {
  if (overrides.length) {
    const started = await pi.knit("run", "start", task.id, ...overrides);
    assert.equal(started.code, 0, started.stderr);
    assert.equal((await finished(dir, task, startedRunId(started.stdout))).failure, null);
    return;
  }
  const workflow = workflowOf(dir);
  const prepared = prepareRun({ root: dir, taskId: task.id, workflow, config: loadConfig(dir).config, model: null, sessionDefaults });
  assert.deepEqual(prepared.problems, []);
  // 使用真实 RPC 适配器；把参数日志绑定在这个客户端上，避免并发修改父进程环境。
  const client = join(pi.outside, "client.mjs");
  writeFileSync(client, [
    `#!${process.execPath}`,
    `process.env.KNIT_FAKE_PI = ${JSON.stringify(join(pi.outside, "script.json"))};`,
    `process.env.KNIT_FAKE_PI_LOG = ${JSON.stringify(join(pi.outside, "pi.jsonl"))};`,
    `await import(${JSON.stringify(new URL("./helpers/fake-pi.mjs", import.meta.url).href)});`,
  ].join("\n"), { mode: 0o755 });
  const registry = { ...agents, pi: { ...agents.pi, createAdapter: () => new PiExecutionAdapter(client) } };
  const run = prepared.run;
  assert.deepEqual(await executeRun({ root: dir, taskId: task.id, runId: run.id, workflow, agents: registry, model: run.model, thinking: run.thinking }), []);
  assert.equal(lastRun(dir, task).failure, null);
}

function finish(dir, task, run, { verdict = null, failure = null } = {}) {
  const problems = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure,
    sessionFile: null,
  });
  assert.deepEqual(problems, []);
}
function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

test("没派发过时给出下一步", (t) => {
  const dir = runProject(t);
  const draft = draftTask(dir);
  const ready = readyTask(dir);

  assert.equal(
    status(dir, draft),
    `任务: 还没确认（${draft}）\n状态: draft\n还没有派发过\n下一步: 先确认需求（knit task ready ${draft}）\n`,
  );
  assert.equal(
    status(dir, ready.id),
    `任务: 加问候语（${ready.id}）\n状态: ready\n还没有派发过\n下一步: 派发实现环节（knit run start ${ready.id}）\n`,
  );
});

test("结束之后显示结果和下一步", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const head = `任务: 加问候语（${task.id}）\n`;
  const worktree = worktreeLine(dir, task);

  const implement = prepare(dir, task);
  write(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");
  write(worktreeOf(dir, task), "src/b.ts", "export const b = 2;\n");
  write(dir, `${implement.dir}/worker.log`, "正常结束\n");
  write(dir, `${implement.dir}/report.md`, "做完了。\n");
  finish(dir, task, implement);
  assert.equal(
    status(dir, task.id),
    `${head}状态: active(implement)\n${worktree}上一次: 实现（${implement.id}）\n结果: 正常结束\n` +
      `报告: ${RUNS_DIR}/${implement.id}/report.md\n改动文件: 2 个\nAgent: pi\n下一步: 派发审查环节（knit run start ${task.id}）\n`,
  );

  const review = prepare(dir, task);
  finish(dir, task, review, { verdict: "changes_requested" });
  const recordPath = join(dir, task.dir, "record.json");
  const legacy = JSON.parse(readFileSync(recordPath, "utf8"));
  delete legacy.runs.at(-1).agent;
  writeFileSync(recordPath, JSON.stringify(legacy));
  assert.equal(
    status(dir, task.id),
    `${head}状态: active(review)\n${worktree}上一次: 审查（${review.id}）\n结论: changes_requested\n` +
      `改动文件: 0 个\nAgent: pi\n下一步: 派发实现环节（knit run start ${task.id}）\n`,
  );

  const other = readyTask(dir);
  const failed = prepare(dir, other);
  finish(dir, other, failed, { failure: "执行者中途退出" });
  assert.doesNotMatch(status(dir, other.id), /^日志:/m);
  write(dir, `${failed.dir}/worker.log`, "执行者中途退出\n");
  assert.equal(
    status(dir, other.id),
    `任务: 加问候语（${other.id}）\n状态: active(implement)\n${worktreeLine(dir, other)}上一次: 实现（${failed.id}）\n失败: 执行者中途退出\n` +
      `日志: ${failed.dir}/worker.log\n改动文件: 0 个\nAgent: pi\n下一步: 派发实现环节（knit run start ${other.id}）\n`,
  );
});

/** 命令行里带着这次执行 id 的进程：后台进程和它启动的假 Pi。 */
const processesOf = (runId) => spawnSync("pgrep", ["-f", runId], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

for (const count of [1, 2]) test(`${count} 个执行器刚入账时的 status、wait 和 cancel 会等 worker 登记进程身份`, async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const source = "version: 1\nmodel: fake/model\nstages:\n  - id: check\n    tools: [read]\n" +
    (count === 2 ? "    executors: [{id: a}, {id: b}]\n" : "");
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
    assert.doesNotMatch(pending.status.stdout, /^(报告|日志):/m);
    prepared.runs.forEach((run) => assert.ok(pending.status.stdout.includes(`正在启动: check（${run.id}）`)));
    assert.equal(await Promise.race([pending.wait.then(() => true), sleep(20, false)]), false);
    const cancelled = await pending.cancel;
    assert.deepEqual(cancelled.problems, []);
    assert.equal(cancelled.runs.length, count);
    assert.ok(cancelled.runs.every((run) => run.workerMissing === false));
    const { runs } = JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8"));
    assert.equal(runs.length, count);
    assert.ok(runs.every((run) => run.failure === "已取消" && !Object.hasOwn(run, "resumeBlocked")));
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
  batch.forEach((run) => write(root, `${run.dir}/report.md`, "检查完成"));
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

test("没有执行在跑时立即返回", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);

  const waited = await waitRun(dir, task.id);
  assert.deepEqual(waited.problems, []);
  assert.equal(waited.task.document.frontmatter.id, task.id);
  assert.deepEqual(await waitRun(dir, task.id, undefined, Date.now() + 1000), waited);
  assert.deepEqual((await waitRun(dir, "k-000000000000")).problems, ["没有任务 k-000000000000；用 knit task list 查看现有任务"]);
  for (const value of ["0", "-1", "1.5", "1e2"]) {
    const invalid = knit(dir, "run", "wait", task.id, "--timeout", value);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /正整数秒数/);
  }
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
      assert.doesNotMatch(result.stdout, /^(报告|日志):/m);
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

  write(dir, `${prepared.run.dir}/worker.log`, "后台退出");
  const waited = spawnSync(process.execPath, [CLI, "run", "wait", task.id, "--dir", dir], { encoding: "utf8", timeout: 5000 });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.stdout, status(dir, task.id));
  assert.ok(waited.stdout.split("\n").includes(`日志: ${prepared.run.dir}/worker.log`));
  assert.match(waited.stdout, new RegExp(`knit run cancel ${task.id}`));
});

test("快速结束的执行不再整秒空等，且支持显式 pollMs 与超时语义", async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const workflow = parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
  const input = { root, taskId: task.id, workflow, config: loadConfig(root).config, model: null };
  const prepared = prepareRun(input);
  assert.deepEqual(prepared.problems, []);
  writeFileSync(join(root, prepared.run.dir, "worker.json"), JSON.stringify({ pid: process.pid, start: procStartTicks(process.pid) }));

  const timedOutBefore = Date.now();
  const limited = waitRun(root, task.id, undefined, timedOutBefore + 120, { pollMs: 10 });
  const document = join(root, task.dir, "task.md");
  const original = readFileSync(document, "utf8");
  // 中间轮询只读 record.json；超时返回时才重读最新文档。
  writeFileSync(document, "");
  await sleep(35);
  writeFileSync(document, original.replace("title: 加问候语", "title: 等待超时"));
  const timedOut = await limited;
  const timedOutMs = Date.now() - timedOutBefore;
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.task.document.frontmatter.title, "等待超时");
  assert.ok(timedOutMs >= 110 && timedOutMs < 600, `超时耗时异常：${timedOutMs}ms`);

  const quickBefore = Date.now();
  const waiting = waitRun(root, task.id);
  setTimeout(() => {
    assert.deepEqual(finishRun({ ...input, agents, runId: prepared.run.id, verdict: null, failure: null, sessionFile: null }), []);
  }, 60);
  const waited = await waiting;
  const quickMs = Date.now() - quickBefore;
  assert.equal(waited.timedOut, undefined);
  assert.equal(waited.task.record.runs.at(-1).endedAt !== null, true);
  assert.ok(quickMs < 500, `短执行不应整秒空等：${quickMs}ms`);
});

test("等待期间任务移动后重新定位，worker 退出时返回最新任务", async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const run = prepare(root, task);
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exit = once(worker, "exit");
  t.after(async () => { worker.kill(); await exit; });
  writeFileSync(join(root, run.dir, "worker.json"), JSON.stringify({ pid: worker.pid, start: procStartTicks(worker.pid) }));
  const waiting = waitRun(root, task.id, undefined, Date.now() + 5000, { pollMs: 5 });
  const moved = `${task.dir}-moved`;
  await sleep(25);
  renameSync(join(root, task.dir), join(root, moved));
  assert.equal(await Promise.race([waiting, sleep(25, "pending")]), "pending");
  const file = join(root, moved, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("title: 加问候语", "title: 等待中改名"));
  worker.kill();
  const result = await waiting;
  assert.deepEqual(result.problems, []);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.task.dir, moved);
  assert.equal(result.task.document.frontmatter.title, "等待中改名");
  assert.equal(result.task.record.runs.at(-1).endedAt, null);
});

const recordOf = (dir, task) => readFileSync(join(dir, task.dir, "record.json"), "utf8");

test("进程已经不在时记为失败", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const run = prepare(dir, task);

  const cancelled = knit(dir, "run", "cancel", task.id);

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `加问候语（${task.id}）的执行 ${run.id} 进程已经不在了，已记为失败\n改动文件: 0 个\n`);
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

const batchRecord = (root, task) => JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8"));

function parallelProject(t, root) {
  const started = [];
  // 在删除夹具之前停完进程，失败的断言也不会留下等待文件的假 Pi。
  t.after(async () => {
    started.filter((task) => lastRun(root, task).endedAt === null).forEach((task) => {
      const cancelled = knit(root, "run", "cancel", task.id);
      assert.equal(cancelled.code, 0, cancelled.stderr);
    });
    await Promise.all(started.map((task) => waitUntil(() => processesOf(lastRun(root, task).id).length === 0, "执行进程退出")));
  });
  return {
    root,
    start: (task) => {
      const script = join(process.env.KNIT_HOME, `${task.id}.json`);
      writeFileSync(script, JSON.stringify({
        writes: [
          { path: `src/${task.id}.txt`, content: task.id },
          { path: "shared.txt", content: task.id },
        ],
        waitFor: join(process.env.KNIT_HOME, `${task.id}.go`),
        texts: [`${task.id} 做完了。`],
      }));
      const result = spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", root], {
        encoding: "utf8",
        env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script },
      });
      assert.equal(result.status, 0, result.stderr);
      started.push(task);
      const run = lastRun(root, task);
      assert.equal(result.stdout, `已派发 加问候语（${task.id}）：实现（${run.id}）\n${worktreeLine(root, task)}会话记录：${RUNS_DIR}/${run.id}/session/\n`);
      return run;
    },
    release: (task) => writeFileSync(join(process.env.KNIT_HOME, `${task.id}.go`), ""),
  };
}

async function running(root, task) {
  await waitUntil(() => existsSync(join(worktreeOf(root, task), `src/${task.id}.txt`)), "假 Pi 写出文件");
  assert.equal(lastRun(root, task).endedAt, null);
  assert.equal(processesOf(lastRun(root, task).id).length, 2);
  const shown = status(root, task.id);
  assert.ok(shown.includes(`正在跑: 实现（${lastRun(root, task).id}）`), shown);
  assert.ok(shown.includes(worktreeLine(root, task)), shown);
}

async function ended(root, task) {
  await waitUntil(() => lastRun(root, task).endedAt !== null, "执行结束");
  await waitUntil(() => processesOf(lastRun(root, task).id).length === 0, "后台进程和假 Pi 退出");
  const waited = await waitRun(root, task.id);
  assert.deepEqual(waited.problems, []);
  assert.deepEqual(waited.task.record.runs.at(-1), lastRun(root, task));
  return lastRun(root, task);
}

function ownChanges(root, task) {
  assert.deepEqual(lastRun(root, task).changedPaths, ["shared.txt", `src/${task.id}.txt`]);
  assert.equal(readFileSync(join(worktreeOf(root, task), "shared.txt"), "utf8"), task.id);
  assert.equal(existsSync(join(root, "shared.txt")), false);
  assert.equal(existsSync(join(root, `src/${task.id}.txt`)), false);
}

// 整组共用临时 KNIT_HOME 的生命周期，每次派发仍在独立仓库和 Worktree 中运行。
test("独立仓库中的后台派发", { concurrency: 6 }, async (suite) => {
  const cases = [];
  const check = (...args) => cases.push(suite.test(...args));

  check("正在跑和进程不在了分得出来", async (t) => {
    const running = runProject(suite);
    const first = readyTask(running);
    const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const gate = join(outside, "go");
    writeFileSync(join(outside, "script.json"), JSON.stringify({ waitFor: gate }));
    const started = await cliCommand(["run", "start", first.id, "--dir", running], {
      encoding: "utf8",
      env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: join(outside, "script.json") },
    });
    assert.equal(started.code, 0, started.stderr);
    const run = lastRun(running, first);

    assert.equal(
      status(running, first.id),
      `任务: 加问候语（${first.id}）\n状态: active(implement)\n${worktreeLine(running, first)}` +
        `正在跑: 实现（${run.id}），开始于 ${run.startedAt}\n会话记录: ${RUNS_DIR}/${run.id}/session/\nAgent: pi\n`,
    );

    const gone = runProject(suite);
    const second = readyTask(gone);
    const lost = prepare(gone, second);
    assert.equal(
      status(gone, second.id),
      `任务: 加问候语（${second.id}）\n状态: active(implement)\n${worktreeLine(gone, second)}` +
        `执行 ${lost.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${second.id} 记为失败\nAgent: pi\n`,
    );

    writeFileSync(gate, "");
    await waitUntil(() => lastRun(running, first).endedAt !== null, `执行 ${run.id} 结束`);
    const { pid } = JSON.parse(readFileSync(join(running, RUNS_DIR, run.id, "worker.json"), "utf8"));
    await waitUntil(() => !alive(pid), `后台进程 ${pid} 退出`);
    assert.match(status(running, first.id), /\n上一次: 实现（r-[0-9a-f]{12}）\n结果: 正常结束\n/);
  });

  check("等待期间流程配置变坏时立即报错，执行者仍继续运行", async (t) => {
    t.after(() => {
      writeFileSync(file, original);
      if (lastRun(dir, task).endedAt === null) knit(dir, "run", "cancel", task.id);
    });
    const dir = runProject(suite);
    const task = readyTask(dir);
    const script = join(process.env.KNIT_HOME, `${task.id}.json`);
    const gate = join(process.env.KNIT_HOME, `${task.id}.go`);
    const log = join(process.env.KNIT_HOME, `${task.id}.jsonl`);
    writeFileSync(script, JSON.stringify({ waitFor: gate }));
    const started = await cliCommand(["run", "start", task.id, "--dir", dir], {
      encoding: "utf8", env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script, KNIT_FAKE_PI_LOG: log },
    });
    assert.equal(started.code, 0, started.stderr);
    const runId = lastRun(dir, task).id;
    const file = join(dir, ".knit/workflow.yaml");
    const original = readFileSync(file, "utf8");
    await waitUntil(() => existsSync(log), "执行者已读取流程并启动 Pi");
    // waitRun 在第一次轮询中读完有效流程，再等待下一轮。
    const waiting = waitRun(dir, task.id, undefined, undefined, { pollMs: 50 });
    writeFileSync(file, original.replace("version: 1", "version: 999"));
    const result = await Promise.race([waiting, sleep(4000, null, { ref: false })]);
    assert.ok(result, "wait 没有在下一次轮询报告流程错误");
    assert.equal(result.task, null);
    assert.match(result.problems.join("\n"), /version/);
    assert.equal(lastRun(dir, task).endedAt, null);
    writeFileSync(file, original);
    writeFileSync(gate, "");
    assert.match(knit(dir, "run", "wait", task.id).stdout, /^结果: 正常结束$/m);
    await waitUntil(() => processesOf(runId).length === 0, "执行进程退出");
  });

  check("执行在读完记录之后、看后台进程之前正常结束", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: join(outside, "script.json") };
    writeFileSync(env.KNIT_FAKE_PI, JSON.stringify({ waitFor: join(outside, "go") }));
    const started = await cliCommand(["run", "start", task.id, "--dir", dir], { encoding: "utf8", env });
    assert.equal(started.code, 0, started.stderr);
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
    assert.deepEqual(output, { stdout: status(dir, task.id), stderr: "", code: 0 });
    assert.match(output.stdout, /^结果: 正常结束$/m);
  });

  check("停掉正在跑的执行", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const script = join(outside, "script.json");
    const start = () =>
      cliCommand(["run", "start", task.id, "--dir", dir], {
        encoding: "utf8",
        env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script },
      });
    // 先写文件，再等一个不会出现的文件。
    const stuck = { writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }], waitFor: join(outside, "never") };
    writeFileSync(script, JSON.stringify(stuck));
    assert.equal((await start()).code, 0);
    const run = lastRun(dir, task);
    await waitUntil(() => existsSync(join(worktreeOf(dir, task), "src/a.ts")), "假 Pi 写出 src/a.ts");
    const { pid } = JSON.parse(readFileSync(join(dir, RUNS_DIR, run.id, "worker.json"), "utf8"));
    assert.equal(processesOf(run.id).length, 2);

    const cancelled = await cliCommand(["run", "cancel", task.id, "--dir", dir]);

    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.stdout, `已取消 加问候语（${task.id}）的执行 ${run.id}\n改动文件: 1 个\n`);
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
    const again = await start();
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /：实现（r-[0-9a-f]{12}）\n/);
    await waitUntil(() => lastRun(dir, task).endedAt !== null, "第二次执行结束");
    const next = lastRun(dir, task);
    assert.notEqual(next.id, run.id);
    assert.deepEqual({ stage: next.stage, failure: next.failure }, { stage: "implement", failure: null });
    await waitUntil(() => processesOf(next.id).length === 0, "第二次的后台进程退出");
  });

  check("取消后台执行时连客户端启动的子进程一起停止，并结束 wait", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    const script = join(process.env.KNIT_HOME, `${task.id}.json`);
    writeFileSync(script, JSON.stringify({ child: true, waitFor: join(process.env.KNIT_HOME, "never") }));
    const started = await cliCommand(["run", "start", task.id, "--dir", dir], {
      encoding: "utf8", env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script },
    });
    assert.equal(started.code, 0, started.stderr);
    const run = lastRun(dir, task);
    t.after(() => spawnSync("pkill", ["-9", "-f", run.id]));
    await waitUntil(() => processesOf(run.id).length === 3, "后台进程、客户端和它的子进程都在跑");

    const cancelled = await cliCommand(["run", "cancel", task.id, "--dir", dir]);

    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(lastRun(dir, task).failure, "已取消");
    assert.equal(processesOf(run.id).length, 0);
    assert.match(knit(dir, "run", "wait", task.id).stdout, /^失败: 已取消$/m);
  });

  check("执行者不理会 SIGTERM 时等到它被结束", async (t) => {
    const dir = runProject(suite);
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
    const started = await cliCommand(["run", "start", task.id, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script, KNIT_FAKE_PI_LOG: log },
    });
    assert.equal(started.code, 0, started.stderr);
    const run = lastRun(dir, task);
    // 测试中途失败时，这个假 Pi 自己不会退出。
    t.after(() => spawnSync("pkill", ["-9", "-f", run.id]));
    await waitUntil(() => existsSync(join(worktreeOf(dir, task), "src/a.ts")), "假 Pi 写出 src/a.ts");
    assert.equal(processesOf(run.id).length, 2);

    const cancelled = await cliCommand(["run", "cancel", task.id, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, KNIT_STOP_GRACE_MS: "200" },
    });

    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.stdout, `已取消 加问候语（${task.id}）的执行 ${run.id}\n改动文件: 1 个\n`);
    const ended = lastRun(dir, task);
    assert.deepEqual(
      { id: ended.id, verdict: ended.verdict, failure: ended.failure, changedPaths: ended.changedPaths },
      { id: run.id, verdict: null, failure: "已取消", changedPaths: ["src/a.ts"] },
    );
    assert.equal(processesOf(run.id).length, 0);
    // 假 Pi 收到过 SIGTERM 而没有退出：它是被 SIGKILL 结束的。
    assert.ok(readFileSync(log, "utf8").includes('{"signal":"SIGTERM"}'));
  });

  check("等到正在跑的执行结束", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: join(outside, "script.json") };
    writeFileSync(env.KNIT_FAKE_PI, JSON.stringify({ waitFor: join(outside, "go") }));
    const started = await cliCommand(["run", "start", task.id, "--dir", dir], { encoding: "utf8", env });
    assert.equal(started.code, 0, started.stderr);
    const runId = lastRun(dir, task).id;

    const waiting = spawn(process.execPath, [CLI, "run", "wait", task.id, "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "", code: undefined };
    waiting.stdout.on("data", (chunk) => (output.stdout += chunk));
    waiting.stderr.on("data", (chunk) => (output.stderr += chunk));
    waiting.on("close", (code) => (output.code = code));
    t.after(() => waiting.kill());

    const before = Date.now();
    const limited = await cliCommand(["run", "wait", task.id, "--dir", dir, "--timeout", "1"], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.ok(Date.now() - before >= 1000);
    assert.equal(limited.code, 0, limited.stderr);
    assert.match(limited.stdout, /^正在跑: 实现/m);
    assert.match(limited.stdout, /批次仍在运行/);
    assert.equal(lastRun(dir, task).endedAt, null);
    assert.deepEqual(output, { stdout: "", stderr: "", code: undefined });

    writeFileSync(join(outside, "go"), "");
    await waitUntil(() => output.code !== undefined, "knit run wait 退出");
    await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
    assert.deepEqual(output, { stdout: status(dir, task.id), stderr: "", code: 0 });
    assert.match(output.stdout, /^上一次: 实现/m);
  });

  check("派发后立即返回，执行者在后台做完", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    const pi = fakePi(t, dir);
    pi.script({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }] });

    const started = await pi.knit("run", "start", task.id);
    assert.equal(started.code, 0, started.stderr);
    const runId = lastRun(dir, task).id;
    const runDir = `${RUNS_DIR}/${runId}`;
    assert.equal(started.stdout, `已派发 加问候语（${task.id}）：实现（${runId}）\n${worktreeLine(dir, task)}会话记录：${runDir}/session/\n`);
    const worker = JSON.parse(readFileSync(join(dir, runDir, "worker.json"), "utf8"));
    assert.ok(Number.isInteger(worker.pid) && worker.pid > 0);
    assert.equal(typeof worker.start, "string");

    const run = await finished(dir, task, runId);
    assert.equal(run.failure, null);
    assert.deepEqual(run.changedPaths, ["src/a.ts"]);
    assert.equal(readFileSync(join(worktreeOf(dir, task), "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(existsSync(join(dir, "src/a.ts")), false);
    assert.equal(readFileSync(join(dir, runDir, "report.md"), "utf8"), "做完了。");
    assert.equal(readFileSync(join(dir, runDir, "worker.log"), "utf8"), "");
  });

  check("start 等两条准备命令按顺序完成，快照排除准备文件；审查和返工不再运行", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    setupConfig(dir, [
      nodeCommand("require('node:fs').writeFileSync('setup.txt', 'first')"),
      nodeCommand("setTimeout(() => require('node:fs').appendFileSync('setup.txt', ':second:' + process.env.KNIT_SETUP_TEST), 100)"),
    ]);
    const pi = fakePi(t, dir, { KNIT_SETUP_TEST: "inherited" });
    pi.script({ writes: [{ path: "worker.txt", content: "worker" }] });
    const started = await pi.knit("run", "start", task.id);
    assert.equal(started.code, 0, started.stderr);
    const first = lastRun(dir, task);
    const setupText = existsSync(join(worktreeOf(dir, task), "setup.txt")) ? readFileSync(join(worktreeOf(dir, task), "setup.txt"), "utf8") : null;
    assert.equal((await finished(dir, task, first.id)).failure, null);
    assert.equal(started.stdout, `已派发 加问候语（${task.id}）：实现（${first.id}）\n${worktreeLine(dir, task)}已运行准备命令：2 条\n会话记录：${RUNS_DIR}/${first.id}/session/\n`);
    assert.equal(setupText, "first:second:inherited");
    assert.equal(existsSync(join(dir, "setup.txt")), false);
    assert.deepEqual(lastRun(dir, task).changedPaths, ["worker.txt"]);

    // 若复用时误跑，第二条会追加，第一条会以 19 退出。
    setupConfig(dir, [nodeCommand("process.exit(19)"), nodeCommand("require('node:fs').appendFileSync('setup.txt', ':again')")]);
    pi.script({ texts: ['```json\n{"verdict":"changes_requested"}\n```'] });
    const review = await pi.knit("run", "start", task.id);
    assert.equal(review.code, 0, review.stderr);
    assert.doesNotMatch(review.stdout, /已运行准备命令/);
    assert.equal((await finished(dir, task, startedRunId(review.stdout))).verdict, "changes_requested");
    pi.script({});
    const repair = await pi.knit("run", "start", task.id);
    assert.equal(repair.code, 0, repair.stderr);
    assert.doesNotMatch(repair.stdout, /已运行准备命令/);
    assert.equal((await finished(dir, task, startedRunId(repair.stdout))).failure, null);
    assert.equal(readFileSync(join(worktreeOf(dir, task), "setup.txt"), "utf8"), "first:second:inherited");
  });

  check("并行批次准备期间重复 start，已创建的 Worktree 只由取得派发权的一次使用", async (t) => {
    const root = runProject(suite);
    writeFileSync(join(root, ".knit/workflow.yaml"), "version: 1\nmodel: fake/model\nstages:\n  - id: check\n    tools: [read]\n    executors: [{id: a}, {id: b}]\n");
    const task = readyTask(root);
    const marker = join(process.env.KNIT_HOME, "setup-started");
    const release = join(process.env.KNIT_HOME, "finish-setup");
    setupConfig(root, [nodeCommand("const fs=require('node:fs');fs.writeFileSync(process.env.KNIT_SETUP_STARTED,'');const timer=setInterval(()=>{if(fs.existsSync(process.env.KNIT_SETUP_RELEASE))clearInterval(timer)},30)")]);
    const args = [CLI, "run", "start", task.id, "--dir", root];
    const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_SETUP_STARTED: marker, KNIT_SETUP_RELEASE: release };
    const child = spawn(process.execPath, args, { env, stdio: "ignore" });
    const first = once(child, "close");
    try {
      await waitUntil(() => existsSync(marker), "第一次派发进入准备命令");
      const second = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 5000 });
      assert.equal(second.status, 1, second.stderr);
      assert.ok(existsSync(join(worktreeOf(root, task), ".git")));
      assert.equal(lastRun(root, task), undefined);
      writeFileSync(release, "");
      assert.equal((await first)[0], 0);
      assert.equal(knit(root, "run", "wait", task.id).code, 0);
      const { runs } = JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8"));
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.endedAt && run.failure === null && run.batchId === runs[0].batchId));
    } finally {
      writeFileSync(release, "");
      await first;
      if (lastRun(root, task)?.endedAt === null) knit(root, "run", "cancel", task.id);
    }
  });

  check("第二条准备命令失败时 start 原样报告、停止后续命令、撤回脏 Worktree，改对后能再派发", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    const marker = join(process.env.KNIT_HOME, "must-not-run");
    const failedCommand = nodeCommand("console.log('setup stdout'); console.error('setup stderr'); process.exit(23)");
    setupConfig(dir, [
      nodeCommand("require('node:fs').writeFileSync('untracked.txt', 'unfinished'); require('node:fs').mkdirSync('node_modules')"),
      failedCommand,
      nodeCommand("require('node:fs').writeFileSync(process.env.KNIT_SETUP_MARKER, 'bad')"),
    ]);
    const pi = fakePi(t, dir, { KNIT_SETUP_MARKER: marker });
    pi.script({});
    const before = ["task.md", "record.json"].map((file) => readFileSync(join(dir, task.dir, file), "utf8"));
    const trees = git(dir, "worktree", "list", "--porcelain");
    const refused = await pi.knit("run", "start", task.id);
    if (refused.code === 0) await finished(dir, task, startedRunId(refused.stdout));
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.ok(refused.stderr.includes(failedCommand), refused.stderr);
    assert.match(refused.stderr, /退出码[：: ]+23/);
    assert.match(refused.stderr, /setup stdout\n/);
    assert.match(refused.stderr, /setup stderr\n/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(worktreeOf(dir, task)), false);
    assert.equal(git(dir, "branch", "--list", `knit/${basename(task.dir)}`), "");
    assert.equal(git(dir, "worktree", "list", "--porcelain"), trees);
    assert.equal(existsSync(join(dir, RUNS_DIR)), false);
    assert.equal(existsSync(join(pi.outside, "pi.jsonl")), false);
    assert.deepEqual(["task.md", "record.json"].map((file) => readFileSync(join(dir, task.dir, file), "utf8")), before);

    setupConfig(dir, [nodeCommand("require('node:fs').writeFileSync('untracked.txt', 'ready')")]);
    const retried = await pi.knit("run", "start", task.id);
    assert.equal(retried.code, 0, retried.stderr);
    assert.match(retried.stdout, /已运行准备命令：1 条/);
    assert.equal(readFileSync(join(worktreeOf(dir, task), "untracked.txt"), "utf8"), "ready");
    assert.equal((await finished(dir, task, startedRunId(retried.stdout))).failure, null);
  });

  [
    { name: "没有配置时用主会话的模型", top: null, stage: null, override: null, expected: "p/m" },
    { name: "顶层模型优先于主会话", top: "top/m", stage: null, override: null, expected: "top/m" },
    { name: "环节模型优先于顶层和主会话", top: "top/m", stage: "stage/m", override: null, expected: "stage/m" },
    { name: "--model 优先于环节、顶层和主会话", top: "top/m", stage: "stage/m", override: "cli/m", expected: "cli/m" },
  ].forEach((scenario) => {
    check(scenario.name, async (t) => {
      const dir = runProject(suite);
      const workflow = join(dir, ".knit/workflow.yaml");
      writeFileSync(
        workflow,
        readFileSync(workflow, "utf8")
          .replace("model: fake/model\n", scenario.top === null ? "" : `model: ${scenario.top}\n`)
          .replace("    name: 实现\n", `    name: 实现\n${scenario.stage === null ? "" : `    model: ${scenario.stage}\n`}`),
      );
      const task = readyTask(dir);
      const pi = fakePi(t, dir, { PI_PROVIDER: "p", PI_MODEL: "m" });
      pi.script({});

      await dispatchDefaults(dir, task, pi, { model: "p/m", thinking: null }, scenario.override === null ? [] : ["--model", scenario.override]);
      const { args } = JSON.parse(readFileSync(join(pi.outside, "pi.jsonl"), "utf8").split("\n")[0]);
      assert.equal(`${args[args.indexOf("--provider") + 1]}/${args[args.indexOf("--model") + 1]}`, scenario.expected);
    });
  });

  [
    { name: "没有配置时用主会话的思考等级", top: null, stage: null, override: null, session: "high", expected: "high" },
    { name: "顶层思考等级优先于主会话", top: "low", stage: null, override: null, session: "high", expected: "low" },
    { name: "环节思考等级优先于顶层和主会话", top: "low", stage: "max", override: null, session: "high", expected: "max" },
    { name: "--thinking 优先于环节、顶层和主会话", top: "low", stage: "max", override: "off", session: "high", expected: "off" },
    { name: "四处都没有思考等级时派发成功且不传 --thinking", top: null, stage: null, override: null, session: undefined, expected: null },
  ].forEach((scenario) => {
    check(scenario.name, async (t) => {
      const dir = runProject(suite);
      const workflow = join(dir, ".knit/workflow.yaml");
      writeFileSync(
        workflow,
        readFileSync(workflow, "utf8")
          .replace("version: 1\n", `version: 1\n${scenario.top === null ? "" : `thinking: ${scenario.top}\n`}`)
          .replace("    name: 实现\n", `    name: 实现\n${scenario.stage === null ? "" : `    thinking: ${scenario.stage}\n`}`),
      );
      const task = readyTask(dir);
      const pi = fakePi(t, dir, { PI_REASONING_LEVEL: scenario.session });
      pi.script({});

      await dispatchDefaults(dir, task, pi, { model: null, thinking: scenario.session ?? null }, scenario.override === null ? [] : ["--thinking", scenario.override]);
      const { args } = JSON.parse(readFileSync(join(pi.outside, "pi.jsonl"), "utf8").split("\n")[0]);
      assert.equal(args.includes("--thinking"), scenario.expected !== null);
      if (scenario.expected !== null) assert.equal(args[args.indexOf("--thinking") + 1], scenario.expected);
      assert.equal(Object.hasOwn(lastRun(dir, task), "thinking"), false);
      assert.doesNotMatch(status(dir, task.id), /thinking|思考等级/);
    });
  });

  check("同一个任务的执行者还在跑时不能再派发，提示不变且没有新的记录", async (t) => {
    const dir = runProject(suite);
    const first = readyTask(dir);
    const second = readyTask(dir);
    const pi = fakePi(t, dir);
    const gate = join(pi.outside, "go");
    pi.script({ waitFor: gate });

    const started = await pi.knit("run", "start", first.id);
    assert.equal(started.code, 0, started.stderr);
    const runId = startedRunId(started.stdout);
    const before = ["task.md", "record.json"].map((file) => readFileSync(join(dir, first.dir, file), "utf8"));
    const refused = await pi.knit("run", "start", first.id);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr,
      `任务 ${first.id} 的执行 ${runId} 还没有结束；等它结束，或运行 knit run cancel ${first.id}\n`,
    );
    assert.equal(lastRun(dir, first).endedAt, null);
    assert.deepEqual(["task.md", "record.json"].map((file) => readFileSync(join(dir, first.dir, file), "utf8")), before);
    assert.equal(JSON.parse(before[1]).runs.length, 1);

    writeFileSync(gate, "");
    assert.equal((await finished(dir, first, runId)).failure, null);
    const next = await pi.knit("run", "start", second.id);
    assert.equal(next.code, 0, next.stderr);
    assert.equal((await finished(dir, second, startedRunId(next.stdout))).failure, null);
  });

  check("派发后台执行者时剥离宿主单次沙箱注入的临时 NODE_OPTIONS 与 broker 变量", async (t) => {
    const dir = runProject(suite);
    const task = readyTask(dir);
    const shim = join(dir, ".knit/.runtime-test-node-brokered-fs-shim.cjs");
    writeFileSync(shim, "");
    t.after(() => rmSync(shim, { force: true }));
    const pi = fakePi(t, dir, {
      NODE_OPTIONS: `--require ${shim}`,
      CODEBUDDY_BROKERED_FS_HOOK_ENABLED: "1",
      CODEBUDDY_SAFE_DELETE_SANDBOX: "1",
      SANDBOX_CENTER_IPC_ADDRESS: "/tmp/dead-broker.sock",
    });
    const dump = join(pi.outside, "env.json");
    pi.script({
      commands: [[
        process.execPath, "-e",
        'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? null, broker: process.env.CODEBUDDY_BROKERED_FS_HOOK_ENABLED ?? null, safeDelete: process.env.CODEBUDDY_SAFE_DELETE_SANDBOX ?? null, ipc: process.env.SANDBOX_CENTER_IPC_ADDRESS ?? null }))',
        dump,
      ]],
    });
    const started = await pi.knit("run", "start", task.id);
    assert.equal(started.code, 0, started.stderr);
    const runId = startedRunId(started.stdout);
    const done = await finished(dir, task, runId);
    assert.equal(done.failure, null);
    assert.deepEqual(JSON.parse(readFileSync(dump, "utf8")), {
      nodeOptions: null,
      broker: null,
      safeDelete: null,
      ipc: null,
    });
  });

  check("不同任务同时派发，各在自己的 Worktree 结束、记改动并推进状态", async (t) => {
    const project = parallelProject(t, runProject(suite));
    const tasks = [readyTask(project.root), readyTask(project.root)];
    const main = [git(project.root, "branch", "--show-current"), git(project.root, "rev-parse", "HEAD")];
    project.start(tasks[0]);
    await running(project.root, tasks[0]);
    project.start(tasks[1]);
    await Promise.all(tasks.map((task) => running(project.root, task)));
    assert.notEqual(worktreeOf(project.root, tasks[0]), worktreeOf(project.root, tasks[1]));
    assert.notEqual(lastRun(project.root, tasks[0]).id, lastRun(project.root, tasks[1]).id);
    assert.equal(git(project.root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 3);

    project.release(tasks[0]);
    assert.equal((await ended(project.root, tasks[0])).failure, null);
    await running(project.root, tasks[1]);
    project.release(tasks[1]);
    assert.equal((await ended(project.root, tasks[1])).failure, null);
    tasks.forEach((task) => {
      ownChanges(project.root, task);
      assert.equal(batchRecord(project.root, task).runs.length, 1);
      const runDir = join(project.root, RUNS_DIR, lastRun(project.root, task).id);
      assert.equal(readFileSync(join(runDir, "report.md"), "utf8"), `${task.id} 做完了。`);
      assert.ok(readdirSync(runDir).includes("before.json"));
      assert.equal(existsSync(join(worktreeOf(project.root, task), RUNS_DIR)), false);
      assert.equal(existsSync(join(worktreeOf(project.root, task), task.dir)), false);
      assert.equal(git(worktreeOf(project.root, task), "rev-parse", "HEAD"), main[1]);
      assert.ok(status(project.root, task.id).includes(`下一步: 派发审查环节（knit run start ${task.id}）`));
    });
    assert.deepEqual([git(project.root, "branch", "--show-current"), git(project.root, "rev-parse", "HEAD")], main);
  });

  check("取消并行任务甲只停甲，任务乙继续运行并正常结束", async (t) => {
    const project = parallelProject(t, runProject(suite));
    const first = readyTask(project.root);
    const second = readyTask(project.root);
    const firstRun = project.start(first);
    await running(project.root, first);
    project.start(second);
    await running(project.root, second);
    const secondBefore = batchRecord(project.root, second);

    const cancelled = knit(project.root, "run", "cancel", first.id);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.stdout, `已取消 加问候语（${first.id}）的执行 ${firstRun.id}\n改动文件: 2 个\n`);
    assert.equal(processesOf(firstRun.id).length, 0);
    assert.equal(lastRun(project.root, first).failure, "已取消");
    assert.notEqual(lastRun(project.root, first).endedAt, null);
    ownChanges(project.root, first);
    assert.deepEqual(batchRecord(project.root, second), secondBefore);
    await running(project.root, second);
    project.release(second);
    assert.equal((await ended(project.root, second)).failure, null);
    ownChanges(project.root, second);
    assert.ok(status(project.root, second.id).includes(`下一步: 派发审查环节（knit run start ${second.id}）`));
  });

  await Promise.all(cases);
});
