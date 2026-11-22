import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { assembleHandoff } from "../dist/application/handoff.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { takeSnapshot } from "../dist/application/workspace.js";
import { parseTaskDocument, requirementDigest } from "../dist/domain/task-document.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit } from "./helpers/cli.mjs";
import { readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

const workflowOf = (dir, edit = (text) => text) =>
  parseWorkflow(edit(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8"))).workflow;
const prepare = (dir, taskId, { model = null, thinking, workflow = workflowOf(dir) } = {}) =>
  prepareRun({ root: dir, taskId, workflow, config: loadConfig(dir).config, model, thinking });
const documentOf = (dir, task) => parseTaskDocument(readFileSync(join(dir, task.dir, "task.md"), "utf8")).document;
const recordOf = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8"));
const filesOf = (dir, task) => ["task.md", "record.json"].map((file) => readFileSync(join(dir, task.dir, file), "utf8"));
const runDirs = (dir) => (existsSync(join(dir, RUNS_DIR)) ? readdirSync(join(dir, RUNS_DIR)) : []);
/** 直接改写执行记录里的最后一项，当作这次执行已经结束。 */
function endLastRun(dir, task, fields) {
  const record = recordOf(dir, task);
  Object.assign(record.runs.at(-1), { endedAt: "2026-11-15T02:00:00.000Z", ...fields });
  writeFileSync(join(dir, task.dir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
}

test("能派发时存好交接内容并登记", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const workflow = workflowOf(dir);
  const document = documentOf(dir, task);
  const expected = assembleHandoff({
    root: dir,
    worktree: worktreeOf(dir, task),
    task: { dir: task.dir, document },
    stage: workflow.stages[0],
    previous: null,
    limits: loadConfig(dir).config.handoff,
  });
  assert.deepEqual(expected.problems, []);

  const { run, problems } = prepare(dir, task.id, { workflow, thinking: "high" });
  assert.deepEqual(problems, []);
  assert.match(run.id, /^r-[0-9a-f]{12}$/);
  assert.deepEqual(run, { id: run.id, dir: `${RUNS_DIR}/${run.id}`, stage: workflow.stages[0], worktree: { path: worktreeOf(dir, task), branch: `knit/${basename(task.dir)}` }, agent: "pi", model: "fake/model", thinking: "high" });
  assert.deepEqual(readdirSync(join(dir, run.dir)).sort(), ["before.json", "message.md", "system.md"]);
  assert.ok(readFileSync(join(dir, run.dir, "system.md"), "utf8").startsWith(`${expected.systemPrompt}\n\n<rules>\n`));
  assert.equal(readFileSync(join(dir, run.dir, "message.md"), "utf8"), expected.firstMessage);
  // before.json 记录执行者的检出，不含主检出里的任务和运行资料。
  assert.deepEqual(JSON.parse(readFileSync(join(dir, run.dir, "before.json"), "utf8")), takeSnapshot(worktreeOf(dir, task)));

  const after = documentOf(dir, task);
  assert.deepEqual(after, { ...document, frontmatter: { ...document.frontmatter, status: "active", stage: "implement" } });
  const record = recordOf(dir, task);
  assert.equal(record.runs.length, 1);
  assert.deepEqual(record.runs[0], {
    id: run.id,
    stage: "implement",
    agent: "pi",
    startedAt: record.runs[0].startedAt,
    endedAt: null,
    verdict: null,
    failure: null,
    requirementDigest: requirementDigest(after),
    changedPaths: [],
    sessionFile: null,
  });
  assert.equal(record.runs[0].requirementDigest, record.confirmedDigest);
  assert.equal(record.runs[0].endedAt, null);

  // 失败的执行不算数：再准备还是实现环节；另外给了 model 时用给的
  endLastRun(dir, task, { failure: "执行者中途退出" });
  assert.equal(recordOf(dir, task).runs[0].endedAt, "2026-11-15T02:00:00.000Z");
  const again = prepare(dir, task.id, { model: "other/big-model" });
  assert.deepEqual(again.problems, []);
  assert.equal(again.run.stage.id, "implement");
  assert.equal(again.run.model, "other/big-model");
  assert.equal(recordOf(dir, task).runs.length, 2);
});

test("省略 agent 时配置逐字段接受，派发按实际客户端校验", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const { workflow, validation } = parseWorkflow("version: 1\nstages:\n  - id: implement\n    model: agy-id\n    thinking: minimal\n");
  assert.deepEqual(validation.issues, []);
  const input = { root, taskId: task.id, workflow, config: loadConfig(root).config, model: null };
  assert.deepEqual(prepareRun(input).problems, ["--model 要写成 provider/模型：agy-id"]);
  const sessionDefaults = { agent: "antigravity", model: null, thinking: null };
  assert.deepEqual(prepareRun({ ...input, sessionDefaults }).problems, ["思考等级只允许 low／medium／high／xhigh／max：minimal"]);
  assert.deepEqual(recordOf(root, task).runs, []);
});

test("不能派发时说明原因，什么都不写", (t) => {
  const dir = runProject(t);
  const draft = knit(dir, "task", "new", "--title", "还没确认").stdout.split("\n")[0].replace("已创建 ", "");
  const first = readyTask(dir);
  const dependent = readyTask(dir, { dependsOn: [first.id] });
  const second = readyTask(dir);
  const before = [first, dependent, second].map((task) => filesOf(dir, task));

  const refused = [
    [prepare(dir, draft), `需求还没有确认，或确认之后改过；先运行 knit task ready ${draft}`],
    [prepare(dir, dependent.id), `依赖的任务还没有交付：${first.id}（ready）；交付并合并之后再派发`],
    [prepare(dir, first.id, { model: "big-model" }), "--model 要写成 provider/模型：big-model"],
    [prepare(dir, first.id, { thinking: "ultra" }), "思考等级只允许 off／minimal／low／medium／high／xhigh／max：ultra"],
    [prepare(dir, "k-000000000000"), "没有任务 k-000000000000；用 knit task list 查看现有任务"],
  ];
  for (const [result, problem] of refused) assert.deepEqual(result, { run: null, problems: [problem] });
  assert.deepEqual(runDirs(dir), []);
  assert.equal(existsSync(join(process.env.KNIT_HOME, "worktrees")), false);
  assert.deepEqual([first, dependent, second].map((task) => filesOf(dir, task)), before);

  // 这个任务自己有一次没结束的执行，拒绝后不增加记录或改写任务文件。
  const { run } = prepare(dir, first.id);
  const running = filesOf(dir, first);
  assert.deepEqual(prepare(dir, first.id), {
    run: null,
    problems: [`任务 ${first.id} 的执行 ${run.id} 还没有结束；等它结束，或运行 knit run cancel ${first.id}`],
  });
  assert.deepEqual(runDirs(dir), [run.id]);
  assert.deepEqual(filesOf(dir, first), running);
  assert.equal(recordOf(dir, first).runs.length, 1);
  assert.equal(existsSync(worktreeOf(dir, second)), false);
  assert.deepEqual(filesOf(dir, second), before[2]);
});

test("task.md 写坏了：说出哪里坏了，不建执行目录", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const file = join(dir, task.dir, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("priority: P2", "priority: PX"));

  const { run, problems } = prepare(dir, task.id);
  assert.equal(run, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^task\.md：字段 priority 的值不对：/);
  assert.deepEqual(runDirs(dir), []);
});

test("下一个环节拿到上一个环节的报告", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const implement = prepare(dir, task.id).run;
  endLastRun(dir, task, { changedPaths: ["src/greet.ts", "test/greet.test.ts"] });
  writeFileSync(join(dir, implement.dir, "report.md"), "加了 greet()，测试通过。\n");

  const review = prepare(dir, task.id).run;
  assert.equal(review.stage.id, "review");
  assert.equal(documentOf(dir, task).frontmatter.stage, "review");
  const block = [
    `<previous-report stage="implement" path="${join(dir, implement.dir, "report.md")}">`,
    "改动的文件：",
    "- src/greet.ts",
    "- test/greet.test.ts",
    "",
    "加了 greet()，测试通过。",
    "</previous-report>",
  ].join("\n");
  assert.ok(readFileSync(join(dir, review.dir, "message.md"), "utf8").endsWith(block));

  // 审查这一次失败了，再准备还是审查；上一份报告删掉之后用一句话代替
  endLastRun(dir, task, { failure: "执行者中途退出" });
  rmSync(join(dir, implement.dir, "report.md"));
  const retry = prepare(dir, task.id).run;
  assert.equal(retry.stage.id, "review");
  assert.ok(
    readFileSync(join(dir, retry.dir, "message.md"), "utf8").endsWith(
      block.replace("加了 greet()，测试通过。", "报告原文不在这台机器上。"),
    ),
  );
});
