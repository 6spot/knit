import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/project-config.js";
import { executeRun } from "../dist/application/run-execute.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { commitAll } from "./helpers/git.mjs";
import { agents, readyTask, runProject } from "./helpers/run.mjs";

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);

/** 假 Pi 的脚本和记录文件放在项目目录之外；返回改脚本的函数和读记录的函数。 */
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
  const log = () =>
    readFileSync(join(outside, "log.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  return {
    script: (script) => writeFileSync(join(outside, "script.json"), JSON.stringify(script)),
    /** 最近一次启动收到的参数。 */
    args: () => log().findLast((line) => line.args !== undefined).args,
    messages: () => log().flatMap((line) => (line.message === undefined ? [] : [line.message])),
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
/** 上一次审查失败之后再准备一次。 */
function reviewAgain(dir, task) {
  const review = prepare(dir, task);
  assert.equal(review.stage.id, "review");
  return review;
}
/** 参数 `name` 后面跟的值；没有这个参数时是 undefined。 */
const valueOf = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("工具按环节的 tools 给", async (t) => {
  const dir = runProject(t);
  const pi = fakePi(t);
  pi.script({});
  const file = join(dir, ".knit/workflow.yaml");
  const original = readFileSync(file, "utf8");
  const line = "    tools: [read, write, exec]\n";
  assert.ok(original.includes(line));
  /** 把实现环节的 tools 换成 `tools`（null 是不写），执行一次实现环节，返回假 Pi 收到的启动参数。 */
  const argsWith = async (tools) => {
    // 流程文件里实现环节在前，replace 只换第一处。
    writeFileSync(file, original.replace(line, tools === null ? "" : `    tools: ${tools}\n`));
    commitAll(dir, `tools ${tools}`);
    const task = readyTask(dir);
    const run = prepare(dir, task);
    assert.equal(run.stage.id, "implement");
    assert.deepEqual(await execute(dir, task, run), []);
    const ended = lastRun(dir, task);
    assert.deepEqual({ id: ended.id, failure: ended.failure }, { id: run.id, failure: null });
    assert.ok(!Number.isNaN(Date.parse(ended.endedAt)));
    return pi.args();
  };
  const shape = (args) => ({
    tools: valueOf(args, "--tools"),
    exclude: valueOf(args, "--exclude-tools"),
    noTools: args.includes("--no-tools"),
    noExtensions: args.includes("--no-extensions"),
  });

  assert.deepEqual(shape(await argsWith(null)), {
    tools: undefined,
    exclude: undefined,
    noTools: false,
    noExtensions: false,
  });
  assert.deepEqual(shape(await argsWith("[read, exec]")), {
    tools: "read,grep,find,ls,bash",
    exclude: undefined,
    noTools: false,
    noExtensions: true,
  });
  const none = shape(await argsWith("[]"));
  assert.deepEqual({ tools: none.tools, noTools: none.noTools }, { tools: undefined, noTools: true });
  assert.deepEqual(shape(await argsWith("[read, external]")), {
    tools: "+read,+grep,+find,+ls",
    exclude: "write,edit,bash",
    noTools: false,
    noExtensions: false,
  });
});

test("没有给出报告时记为失败，不要求补报", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  pi.script({ texts: ["  \n"] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.deepEqual(
    { id: ended.id, verdict: ended.verdict, failure: ended.failure },
    { id: run.id, verdict: null, failure: "执行者没有给出报告" },
  );
  assert.equal(pi.messages().length, 1);
});

test("模型请求出错时记下模型服务给的原因，不要求补报", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  pi.script({ modelError: "Connection error." });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.deepEqual(
    { id: ended.id, verdict: ended.verdict, failure: ended.failure },
    { id: run.id, verdict: null, failure: "执行者出错：Connection error." },
  );
  assert.equal(pi.messages().length, 1);
  assert.ok(!existsSync(join(dir, run.dir, "report.md")));

  // 模型服务没有给原因时。
  pi.script({ modelError: "" });
  const again = reviewAgain(dir, task);
  assert.deepEqual(await execute(dir, task, again), []);
  assert.equal(lastRun(dir, task).failure, "执行者出错：没有给出原因");
});

test("模型请求先出错两次、重试之后成功时，后台执行照常读报告和结论", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  const report = '审查通过。\n\n```json\n{ "verdict": "pass" }\n```';
  pi.script({ retryErrors: ["Claude: Service Unavailable (error)", "Claude: Service Unavailable (error)"], texts: [report] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.deepEqual(
    { id: ended.id, verdict: ended.verdict, failure: ended.failure },
    { id: run.id, verdict: "pass", failure: null },
  );
  assert.notEqual(ended.endedAt, null);
  assert.equal(readFileSync(join(dir, run.dir, "report.md"), "utf8"), report);
  assert.equal(pi.messages().length, 1);
});

test("被中止时记为失败，不要求补报", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  pi.script({ aborted: true, texts: ['审查通过。\n\n```json\n{ "verdict": "pass" }\n```'] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.deepEqual(
    { id: ended.id, verdict: ended.verdict, failure: ended.failure },
    { id: run.id, verdict: null, failure: "执行者被中止" },
  );
  assert.equal(pi.messages().length, 1);
});
