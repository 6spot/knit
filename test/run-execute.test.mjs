import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/project-config.js";
import { executeRun } from "../dist/application/run-execute.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { lastPassedReview, stageEntries } from "../dist/domain/progress.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { commitAll, git } from "./helpers/git.mjs";
import { agents, readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

// macOS 的 /usr/bin/git 会再启动工具链中的 Git。临时仓库可以直接用同一安装。
if (process.platform === "darwin") process.env.PATH = `${git(process.cwd(), "--exec-path")}:${process.env.PATH}`;

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
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
/** 补报和模型响应直接从带 verdict 的审查开始。环节推进另有完整的实现→审查用例。 */
function reviewRun(dir, task) {
  writeFileSync(join(dir, ".knit/workflow.yaml"), [
    "version: 1", "model: fake/model", "stages:", "  - id: review", "    prompt: .knit/agents/review.md",
    "    tools: [read, write, exec]", "    report: {verdict: [pass, changes_requested, blocked]}", "",
  ].join("\n"));
  return reviewAgain(dir, task);
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
    log,
    script: (script) => writeFileSync(join(outside, "script.json"), JSON.stringify(script)),
    /** 最近一次启动收到的参数。 */
    args: () => log().findLast((line) => line.args !== undefined).args,
    messages: () => log().flatMap((line) => (line.message === undefined ? [] : [line.message])),
  };
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

test("审查 API 失败、报告失败后重派恢复原生会话，最后才计为通过", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const file = join(dir, ".knit/workflow.yaml");
  writeFileSync(file, "version: 1\nmodel: fake/model\nstages:\n  - id: review\n    resume: true\n    maxVisits: 0\n    report: {verdict: [pass, changes_requested, blocked]}\n");
  const first = prepare(dir, task);
  pi.script({ nativeSession: true, modelError: "HTTP 429", writes: [{ path: "partial.txt", content: "partial work\n" }] });
  assert.deepEqual(await execute(dir, task, first), []);
  const failed = lastRun(dir, task);
  assert.equal(failed.failure, "执行者出错：HTTP 429");
  assert.ok(failed.resumeId && existsSync(failed.resumeId));
  const { run: second, problems } = prepareRun({ root: dir, taskId: task.id, workflow: workflowOf(dir), config: loadConfig(dir).config,
    model: null, instruction: "核对剩余测试" });
  assert.deepEqual(problems, []);
  const resumeMessage = (run) => readFileSync(join(dir, run.dir, "resume-message.md"), "utf8");
  assert.equal(readFileSync(join(dir, second.dir, "resume-id.txt"), "utf8"), failed.resumeId);
  assert.match(resumeMessage(second), /HTTP 429.*检查当前 Worktree 状态.*完整报告/);
  assert.match(resumeMessage(second), /<main-instruction>\n核对剩余测试/);
  assert.match(resumeMessage(second), /<worktree-changes base="HEAD">\n未跟踪文件：\npartial.txt/);
  assert.equal(readFileSync(join(second.worktree.path, "partial.txt"), "utf8"), "partial work\n");
  pi.script({ nativeSession: true, texts: ["报告没有 JSON"] });
  assert.deepEqual(await execute(dir, task, second), []);
  assert.equal(valueOf(pi.args(), "--session"), failed.resumeId);
  assert.equal(pi.messages()[1], resumeMessage(second));
  assert.equal(lastRun(dir, task).resumeId, failed.resumeId);
  assert.match(lastRun(dir, task).failure, /^报告读不出来/);
  const record = () => JSON.parse(fileOf(dir, task, "record.json"));
  assert.equal(stageEntries(record(), "review"), 0);
  assert.equal(lastPassedReview(record()), undefined);
  const third = prepare(dir, task);
  assert.match(resumeMessage(third), /报告读不出来.*检查当前 Worktree 状态/);
  assert.doesNotMatch(resumeMessage(third), /HTTP 429/);
  pi.script({ nativeSession: true, texts: [PASS] });
  assert.deepEqual(await execute(dir, task, third), []);
  assert.equal(valueOf(pi.args(), "--session"), failed.resumeId);
  assert.equal(pi.messages().at(-1), resumeMessage(third));
  assert.match(readFileSync(join(dir, third.dir, "worker.log"), "utf8"), /续聊原会话/);
  assert.equal(lastRun(dir, task).failure, null);
  assert.equal(lastRun(dir, task).verdict, "pass");
  assert.equal(stageEntries(record(), "review"), 1);
  assert.equal(lastPassedReview(record()).id, third.id);
});

for (const mode of ["deleted", "rejected"]) {
  test(`失败原生会话${mode}时自动回退完整交接`, async (t) => {
    const dir = runProject(t);
    const task = readyTask(dir);
    const pi = fakePi(t);
    const file = join(dir, ".knit/workflow.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("  - id: implement", "  - id: implement\n    resume: true"));
    pi.script({ nativeSession: true, modelError: "HTTP 429" });
    assert.deepEqual(await execute(dir, task, prepare(dir, task)), []);
    const prior = lastRun(dir, task);
    assert.ok(prior.resumeId);
    assert.equal(prior.failure, "执行者出错：HTTP 429");
    const run = prepare(dir, task);
    assert.equal(readFileSync(join(dir, run.dir, "resume-id.txt"), "utf8"), prior.resumeId);
    if (mode === "deleted") rmSync(prior.resumeId);
    pi.script({ nativeSession: true, rejectResume: mode === "rejected" });
    assert.deepEqual(await execute(dir, task, run), []);
    assert.equal(valueOf(pi.args(), "--session"), undefined);
    assert.equal(pi.messages().at(-1), readFileSync(join(dir, run.dir, "message.md"), "utf8"));
    assert.equal(lastRun(dir, task).failure, null);
    assert.notEqual(lastRun(dir, task).resumeId, prior.resumeId);
    const log = readFileSync(join(dir, run.dir, "worker.log"), "utf8");
    assert.match(log, /已自动回退新会话/);
    assert.match(log, mode === "deleted" ? /原生会话文件不存在/ : /执行者启动失败/);
  });
}

test("模型失败同时发生违规时保留违规原因，不恢复该会话", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const file = join(dir, ".knit/workflow.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("  - id: implement", "  - id: implement\n    resume: true"));
  pi.script({ nativeSession: true, modelError: "HTTP 429", writes: [{ path: ".knit/config.json", content: "{}" }] });
  assert.deepEqual(await execute(dir, task, prepare(dir, task)), []);
  const prior = lastRun(dir, task);
  assert.ok(prior.resumeId);
  assert.equal(prior.failure, "执行者出错：HTTP 429；执行者改了受保护的文件：.knit/config.json");
  const retry = prepare(dir, task);
  assert.equal(existsSync(join(dir, retry.dir, "resume-id.txt")), false);
  pi.script({ nativeSession: true });
  assert.deepEqual(await execute(dir, task, retry), []);
  assert.equal(valueOf(pi.args(), "--session"), undefined);
  assert.equal(pi.messages().at(-1), readFileSync(join(dir, retry.dir, "message.md"), "utf8"));
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

const PASS = '改好了格式。\n\n```json\n{ "verdict": "pass" }\n```';

test("补报之后读得出就按正常结束", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  pi.script({ texts: ["看过了，没有问题。", PASS] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.deepEqual({ verdict: ended.verdict, failure: ended.failure }, { verdict: "pass", failure: null });
  assert.equal(readFileSync(join(dir, run.dir, "report.md"), "utf8"), PASS);
  assert.deepEqual(pi.messages(), [
    readFileSync(join(dir, run.dir, "message.md"), "utf8"),
    "上一条消息里的报告读不出来：\n- 报告结尾没有能解析的 json 代码块\n" +
      "请只重新输出完整的报告，结尾带上 json 代码块。不要修改文件，不要重新做一遍。",
  ]);
});

test("补报之后仍读不出就记为失败", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);
  const run = reviewRun(dir, task);
  const second = "再说一遍：没有问题。";
  pi.script({ texts: ["看过了，没有问题。", second, PASS] });

  assert.deepEqual(await execute(dir, task, run), []);

  const ended = lastRun(dir, task);
  assert.equal(ended.failure, "报告读不出来：报告结尾没有能解析的 json 代码块");
  assert.equal(ended.verdict, null);
  assert.equal(readFileSync(join(dir, run.dir, "report.md"), "utf8"), second);
  assert.equal(pi.messages().length, 2);
});

test("读得出时不补报", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t);

  // 实现环节没有声明报告字段，只有文字的消息就是报告。
  pi.script({ texts: ["做完了。", PASS] });
  const implement = prepare(dir, task);
  assert.equal(implement.stage.id, "implement");
  assert.deepEqual(await execute(dir, task, implement), []);
  const first = lastRun(dir, task);
  assert.deepEqual({ verdict: first.verdict, failure: first.failure }, { verdict: null, failure: null });
  assert.equal(readFileSync(join(dir, implement.dir, "report.md"), "utf8"), "做完了。");
  assert.equal(pi.messages().length, 1);

  pi.script({ texts: [PASS, "不该用到。"] });
  const review = prepare(dir, task);
  assert.equal(review.stage.id, "review");
  assert.deepEqual(await execute(dir, task, review), []);
  const second = lastRun(dir, task);
  assert.deepEqual({ verdict: second.verdict, failure: second.failure }, { verdict: "pass", failure: null });
  assert.equal(pi.messages().length, 2);
});

const fileOf = (dir, task, file) => readFileSync(join(dir, task.dir, file), "utf8");
const finish = (dir, task, run, { verdict = null, failure = null, sessionFile = null } = {}) =>
  finishRun({ agents, root: dir, taskId: task.id, runId: run.id, workflow: workflowOf(dir), verdict, failure, sessionFile });
function put(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

test("正常结束时记下结论和改动文件", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  assert.deepEqual(finish(dir, task, prepare(dir, task)), []);
  const run = prepare(dir, task);
  assert.equal(run.stage.id, "review");
  const started = lastRun(dir, task);
  const taskFile = fileOf(dir, task, "task.md");

  put(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");
  put(worktreeOf(dir, task), `${task.dir}/plan.md`, "# 计划\n");
  put(dir, `${run.dir}/worker.log`, "started\n");
  assert.deepEqual(finish(dir, task, run, { verdict: "pass", sessionFile: `${run.dir}/session.jsonl` }), []);

  const ended = lastRun(dir, task);
  assert.ok(!Number.isNaN(Date.parse(ended.endedAt)));
  assert.deepEqual(ended, {
    ...started,
    endedAt: ended.endedAt,
    verdict: "pass",
    failure: null,
    changedPaths: ["src/a.ts"],
    sessionFile: `${run.dir}/session.jsonl`,
  });
  assert.equal(fileOf(dir, task, "task.md"), taskFile);
  assert.match(taskFile, /^status: active$/m);
  assert.match(taskFile, /^stage: review$/m);
});

test("提交了改动或改了受保护的文件时记为失败", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);

  const committed = prepare(dir, task);
  put(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");
  commitAll(worktreeOf(dir, task), "executor commit");
  assert.deepEqual(finish(dir, task, committed, { verdict: "pass" }), []);
  const first = lastRun(dir, task);
  assert.equal(first.verdict, null);
  assert.match(first.failure, /^执行者提交了改动：HEAD 从 [0-9a-f]{7} 变成 [0-9a-f]{7}$/);
  assert.deepEqual(first.changedPaths, ["src/a.ts"]);

  const guarded = prepare(dir, task);
  put(worktreeOf(dir, task), ".knit/standards/development.md", "改过的规范\n");
  put(worktreeOf(dir, task), "src/b.ts", "export const b = 2;\n");
  assert.deepEqual(finish(dir, task, guarded, { verdict: "pass" }), []);
  const second = lastRun(dir, task);
  assert.equal(second.verdict, null);
  assert.equal(second.failure, "执行者改了受保护的文件：.knit/standards/development.md");
  assert.deepEqual(second.changedPaths, [".knit/standards/development.md", "src/b.ts"]);
});

test("派发与结算对 .knit 外的流程角色文件都使用字节指纹", (t) => {
  const dir = runProject(t);
  const role = "roles/implement.md";
  const workflow = join(dir, ".knit/workflow.yaml");
  writeFileSync(workflow, readFileSync(workflow, "utf8").replace(".knit/agents/implement.md", role));
  put(dir, role, "implementation\n");
  put(dir, ".gitattributes", "roles/*.md text\n");
  commitAll(dir, "external role");
  const task = readyTask(dir);
  const run = prepare(dir, task);
  const before = JSON.parse(readFileSync(join(dir, run.dir, "before.json"), "utf8"));
  assert.match(before.files[role], /^file /);
  const cwd = worktreeOf(dir, task);
  put(cwd, role, "implementation\r\n");
  git(cwd, "add", role);
  assert.equal(git(cwd, "status", "--porcelain", "--", role), "");
  assert.deepEqual(finish(dir, task, run), []);
  assert.equal(lastRun(dir, task).failure, `执行者改了受保护的文件：${role}`);
  assert.deepEqual(lastRun(dir, task).changedPaths, [role]);
});

test("调用方给的失败原因照记，结束过的不能再结束", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const run = prepare(dir, task);
  put(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");

  assert.deepEqual(finish(dir, task, run, { verdict: "pass", failure: "已取消" }), []);
  const ended = lastRun(dir, task);
  assert.equal(ended.failure, "已取消");
  assert.equal(ended.verdict, null);
  assert.deepEqual(ended.changedPaths, ["src/a.ts"]);

  const record = fileOf(dir, task, "record.json");
  const problem = `执行 ${run.id} 不在任务 ${task.id} 的记录里，或者已经结束`;
  assert.deepEqual(finish(dir, task, run, { verdict: "pass" }), [problem]);
  assert.deepEqual(finish(dir, task, { id: "r-000000000000" }, { verdict: "pass" }), [
    problem.replace(run.id, "r-000000000000"),
  ]);
  assert.equal(fileOf(dir, task, "record.json"), record);
});
