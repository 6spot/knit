import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { executeRun } from "../dist/application/run-execute.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { agents, readyTask, runProject } from "./helpers/run.mjs";

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);

/** 假 Pi 的脚本和记录文件放在项目目录之外；返回改脚本的函数和记录文件的位置。 */
function fakePi(t) {
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  const saved = { KNIT_FAKE_PI: process.env.KNIT_FAKE_PI, KNIT_FAKE_PI_LOG: process.env.KNIT_FAKE_PI_LOG };
  process.env.KNIT_FAKE_PI = join(outside, "script.json");
  process.env.KNIT_FAKE_PI_LOG = join(outside, "log.jsonl");
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(outside, { recursive: true, force: true });
  });
  return {
    script: (script) => writeFileSync(join(outside, "script.json"), JSON.stringify(script)),
    log: () =>
      readFileSync(join(outside, "log.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  };
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
const execute = (dir, task, run) =>
  executeRun({ root: dir, taskId: task.id, runId: run.id, workflow: workflowOf(dir), model: run.model, agents });
/** 准备出一次审查执行：先把实现那一次直接记成正常结束。 */
function reviewRun(dir, task) {
  const implement = prepare(dir, task);
  const finished = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: implement.id,
    workflow: workflowOf(dir),
    verdict: null,
    failure: null,
    sessionFile: null,
  });
  assert.deepEqual(finished, []);
  const review = prepare(dir, task);
  assert.equal(review.stage.id, "review");
  return review;
}

for (const mode of ["开窗失败", "启动超时"]) {
  test(`注入的窗格宿主${mode}时回退后台，并通过同一注册表结算`, async (t) => {
    const root = runProject(t);
    const task = readyTask(root);
    const run = prepare(root, task);
    const dir = join(root, run.dir);
    const calls = [];
    const pane = Promise.withResolvers();
    const paneHost = {
      open(options) {
        calls.push(options);
        // 自定义宿主也可能抛出普通 JavaScript 值。
        if (mode === "开窗失败") throw null;
        return pane;
      },
      waitClosed(handle) {
        assert.equal(handle, pane);
        queueMicrotask(() => t.mock.timers.tick(20_001));
        return pane.promise;
      },
      close(handle) {
        assert.equal(handle, pane);
        calls.push("close");
        handle.resolve();
      },
    };
    const adapter = {
      paneCommand(launch) {
        assert.equal(launch.root, root);
        return ["fixture"];
      },
      createSession(launch) {
        assert.equal(launch.root, root);
        calls.push("background");
        return { sessionFile: null, start: async () => null, prompt: async () => ({ report: "后台完成", failure: null }), stop: async () => {} };
      },
    };
    const registry = { ...agents, pi: {
      ...agents.pi,
      createAdapter: () => adapter,
      cleanRun(cwd, runDir) {
        assert.deepEqual([cwd, runDir], [run.worktree.path, dir]);
        calls.push("clean");
      },
    } };
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    assert.deepEqual(await executeRun({ root, taskId: task.id, runId: run.id, workflow: workflowOf(root), model: run.model, agents: registry, paneHost }), []);
    assert.deepEqual(calls, [
      { label: `knit ${run.id}`, cwd: run.worktree.path, command: ["fixture"] },
      ...(mode === "启动超时" ? ["close"] : []), "background", "clean",
    ]);
    assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "后台完成");
    const ended = lastRun(root, task);
    assert.notEqual(ended.endedAt, null);
    assert.equal(ended.failure, null);
  });
}

test("已登记的并行执行启动前，重载的同名环节允许写入时结算为失败", async (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const path = join(root, ".knit/workflow.yaml");
  const stage = "version: 1\nmodel: fake/model\nstages:\n  - id: review\n";
  writeFileSync(path, `${stage}    tools: [read]\n    executors: [{id: a}, {id: b}]\n`);
  const prepared = prepareRun({ root, taskId: task.id, workflow: workflowOf(root), config: loadConfig(root).config, model: null });
  assert.deepEqual(prepared.problems, []);
  for (const [index, tools] of ["[read, write]", "all"].entries()) {
    writeFileSync(path, `${stage}    tools: ${tools}\n`);
    assert.deepEqual(await execute(root, task, prepared.runs[index]), []);
  }
  const { runs } = JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8"));
  assert.ok(runs.every((run) => run.endedAt && run.verdict === null && run.failure.includes("并行批次要求只读")));
});

test("做完之后存下报告，记下结论和改动文件", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  const report = '审查通过。\n\n```json\n{ "verdict": "pass" }\n```';
  pi.script({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }], texts: [report] });

  assert.deepEqual(await execute(dir, task, run), []);

  assert.equal(readFileSync(join(dir, run.dir, "report.md"), "utf8"), report);
  const ended = lastRun(dir, task);
  assert.ok(!Number.isNaN(Date.parse(ended.endedAt)));
  assert.deepEqual(
    { id: ended.id, verdict: ended.verdict, failure: ended.failure, changedPaths: ended.changedPaths, sessionFile: ended.sessionFile },
    { id: run.id, verdict: "pass", failure: null, changedPaths: ["src/a.ts"], sessionFile: null },
  );
  const [{ args }, ...prompts] = pi.log();
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], readFileSync(join(dir, run.dir, "system.md"), "utf8"));
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,write,edit,bash");
  assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4), ["--provider", "fake", "--model", "model"]);
  assert.equal(args[args.indexOf("--session-dir") + 1], join(dir, run.dir, "session"));
  assert.deepEqual(prompts, [{ message: readFileSync(join(dir, run.dir, "message.md"), "utf8") }]);
});

test("启动不了或中途退出时记为失败", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);

  pi.script({ failStart: true });
  assert.deepEqual(await execute(dir, task, prepare(dir, task)), []);
  const first = lastRun(dir, task);
  assert.match(first.failure, /^执行者启动失败：.*Model not found/);
  assert.equal(first.verdict, null);
  assert.ok(!Number.isNaN(Date.parse(first.endedAt)));

  pi.script({ exitOnPrompt: true });
  const second = prepare(dir, task);
  assert.deepEqual(await execute(dir, task, second), []);
  const ended = lastRun(dir, task);
  assert.equal(ended.id, second.id);
  assert.equal(ended.failure, "执行者中途退出");
  assert.equal(ended.verdict, null);
  assert.ok(!Number.isNaN(Date.parse(ended.endedAt)));
});

test("报告读不出来时记为失败并保留原文", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  pi.script({ texts: ["看过了，没有问题。"] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.equal(ended.failure, "报告读不出来：报告结尾没有能解析的 json 代码块");
  assert.equal(ended.verdict, null);
  assert.equal(readFileSync(join(dir, run.dir, "report.md"), "utf8"), "看过了，没有问题。");
});
