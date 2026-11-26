import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { deliverTask } from "../dist/application/delivery.js";
import { assembleHandoff } from "../dist/application/handoff.js";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { RUNS_DIR, prepareRun } from "../dist/application/run-prepare.js";
import { buildTaskStatus, statusLines } from "../dist/application/session-context.js";
import { cancelTask, closeTask, readyTask as confirmTask } from "../dist/application/task-lifecycle.js";
import { archiveDirOf, createTask, findTask } from "../dist/application/task-store.js";
import { takeSnapshot } from "../dist/application/workspace.js";
import { stageRules } from "../dist/domain/report.js";
import { parseTaskDocument, requirementDigest } from "../dist/domain/task.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { commitAll, git } from "./helpers/git.mjs";
import { agents, readyTask, runProject, worktreeOf, writeArchiveHistory } from "./helpers/run.mjs";

// 在 macOS 上直接使用工具链的 Git 来准备和检查各轮派发的快照。
if (process.platform === "darwin") process.env.PATH = `${git(process.cwd(), "--exec-path")}:${process.env.PATH}`;

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
    resumeId: null,
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
  const created = createTask(dir, { title: "还没确认", slug: "draft", verification: "self", priority: "P2", parent: null, dependsOn: [] });
  assert.deepEqual(created.problems, []);
  const draft = created.created.id;
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

/** 实现、审查两个环节；`review` 是接在审查环节后面的几行。 */
function workflowWith(review, reviewPrompt = ".knit/agents/review.md") {
  const { workflow, validation } = parseWorkflow(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    name: 实现",
      "    prompt: .knit/agents/implement.md",
      "  - id: review",
      "    name: 审查",
      `    prompt: ${reviewPrompt}`,
      ...review,
      "",
    ].join("\n"),
  );
  assert.deepEqual(validation.issues, []);
  return workflow;
}
const REPORT = [
  "    report:",
  "      verdict: [pass, changes_requested, blocked]",
  "      findings: string[]",
  "      changedPaths: paths",
  "      selfVerified: bool",
  "      note: string",
];
const FIXED = [
  "- 不要提交，也不要切换或新建分支。结束时 HEAD 变了，这次执行记为失败。",
  "- 不要修改这些文件，改了这次执行记为失败：.knit/standards/ 下的文件、.knit/workflow.yaml、.knit/config.json、.knit/agents/implement.md、.knit/agents/review.md。",
  "- 你的最后一条消息就是这个环节的报告，会原样交给下一个环节和用户。",
];

test("没有声明报告字段的环节", () => {
  const workflow = workflowWith(REPORT);

  const rules = stageRules(workflow, workflow.stages[0]);

  assert.equal(rules, ["<rules>", ...FIXED, "</rules>"].join("\n"));
  // 第二条里有 .knit/config.json，所以核对的是没有要 json 代码块的那一条。
  assert.equal(rules.includes("json 代码块"), false);
  assert.equal(rules.replace(".knit/config.json", "").includes("json"), false);
  assert.equal(stageRules(workflow, workflow.stages[0]), rules);
});

test("声明了报告字段的环节", () => {
  const workflow = workflowWith(REPORT);

  assert.equal(
    stageRules(workflow, workflow.stages[1]),
    [
      "<rules>",
      ...FIXED,
      "- 报告的结尾放一个 json 代码块，给出这些字段：",
      "  - verdict：pass、changes_requested、blocked 之一",
      "  - findings：字符串数组",
      "  - changedPaths：路径数组",
      "  - selfVerified：true 或 false",
      "  - note：字符串",
      "</rules>",
    ].join("\n"),
  );

  const shared = workflowWith(REPORT, ".knit/agents/implement.md");
  assert.equal(
    stageRules(shared, shared.stages[1]).split("\n")[2],
    "- 不要修改这些文件，改了这次执行记为失败：.knit/standards/ 下的文件、.knit/workflow.yaml、.knit/config.json、.knit/agents/implement.md。",
  );
});

test("派发时写进系统提示", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const workflow = parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
  const stored = findTask(dir, task.id);
  const expected = assembleHandoff({
    root: dir,
    worktree: worktreeOf(dir, task),
    task: { dir: stored.dir, document: stored.document },
    stage: workflow.stages[0],
    previous: null,
  });

  const { run, problems } = prepareRun({ root: dir, taskId: task.id, workflow, config: loadConfig(dir).config, model: null });

  assert.deepEqual(problems, []);
  assert.equal(
    readFileSync(join(dir, run.dir, "system.md"), "utf8"),
    `${expected.systemPrompt}\n\n${stageRules(workflow, workflow.stages[0])}`,
  );
  assert.equal(readFileSync(join(dir, run.dir, "message.md"), "utf8"), expected.firstMessage);
});

const taskFiles = (root, task) => ["task.md", "record.json"].map((file) => readFileSync(join(root, task.dir, file), "utf8"));

function refusedWithoutChanges(root, task, expected) {
  const before = [taskFiles(root, task), runDirs(root), git(root, "worktree", "list", "--porcelain")];
  const refused = prepare(root, task.id);
  assert.equal(refused.run, null);
  assert.equal(refused.problems.length, 1);
  assert.match(refused.problems[0], expected);
  assert.deepEqual([taskFiles(root, task), runDirs(root), git(root, "worktree", "list", "--porcelain")], before);
  assert.equal(existsSync(worktreeOf(root, task)), false);
  assert.equal(git(root, "branch", "--list", `knit/${basename(task.dir)}`), "");
  assert.deepEqual(JSON.parse(taskFiles(root, task)[1]).runs, []);
  return refused.problems[0];
}

["draft", "ready", "active", "done"].forEach((status) => test(`依赖 ${status} 还没有交付，建 Worktree 之前拒绝`, (t) => {
  const root = runProject(t);
  const dependency = readyTask(root, { verification: "self" });
  const task = readyTask(root, { dependsOn: [dependency.id] });
  if (status === "draft") {
    const file = join(root, dependency.dir, "task.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("status: ready", "status: draft"));
  }
  if (status === "active") assert.deepEqual(prepare(root, dependency.id).problems, []);
  if (status === "done") assert.deepEqual(closeTask(root, dependency.id, { result: "还没有交付", paths: [] }), { kind: "done", title: "加问候语" });
  const problem = refusedWithoutChanges(root, task, /依赖的任务还没有交付/);
  assert.ok(problem.includes(`${dependency.id}（${status}）`), problem);
  assert.match(problem, /交付并合并之后再派发/);
}));

test("取消的归档依赖仍拒绝，提示沿用原文", (t) => {
  const root = runProject(t);
  const dependency = readyTask(root);
  const task = readyTask(root, { dependsOn: [dependency.id] });
  assert.equal(cancelTask(root, dependency.id, { reason: "不再需要" }).kind, "cancelled");
  assert.equal(refusedWithoutChanges(root, task, /依赖的任务还没有完成/), `依赖的任务还没有完成：${dependency.id}（cancelled）`);
});

test("依赖在主检出和任务分支都找不到，提示不存在或已交付但未合并", (t) => {
  const root = runProject(t);
  const dependency = readyTask(root);
  const task = readyTask(root, { dependsOn: [dependency.id] });
  rmSync(join(root, dependency.dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const problem = refusedWithoutChanges(root, task, /主检出里找不到/);
  assert.ok(problem.includes(dependency.id), problem);
  assert.match(problem, /可能.*已经.*交付.*还没有合并/);
  assert.match(problem, /不存在/);
});

test("缺失依赖按任务文档的身份定位分支，不依赖 YAML 排版或 Git grep 配置", (t) => {
  const root = runProject(t);
  const dependency = readyTask(root);
  const task = readyTask(root, { dependsOn: [dependency.id] });
  const unrelated = readyTask(root);
  const dependencyFile = join(root, dependency.dir, "task.md");
  writeFileSync(dependencyFile, readFileSync(dependencyFile, "utf8").replace(`id: ${dependency.id}`, `id: "${dependency.id}" # 合法的 YAML`));
  const unrelatedFile = join(root, unrelated.dir, "task.md");
  writeFileSync(unrelatedFile, `${readFileSync(unrelatedFile, "utf8")}\n示例：\n\n\`\`\`yaml\nid: ${dependency.id}\n\`\`\`\n`);
  commitAll(root, "task documents with quoted identity and an example");
  const branch = `knit/${basename(dependency.dir)}`;
  const unrelatedBranch = `knit/${basename(unrelated.dir)}`;
  git(root, "branch", branch);
  git(root, "branch", unrelatedBranch);
  rmSync(join(root, dependency.dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const problem = refusedWithoutChanges(root, task, /主检出里找不到/);
  assert.ok(problem.includes(`任务分支：${branch}；在主检出里运行 git merge ${branch}`), problem);
  assert.equal(problem.includes(`任务分支：${unrelatedBranch}；`), false, problem);
  git(root, "config", "grep.patternType", "fixed");
  assert.equal(refusedWithoutChanges(root, task, /主检出里找不到/), problem);
});

[false, true].forEach((ignored) => test(`依赖真实交付但未合并时拒绝，合并后 Worktree 拿到代码（任务目录${ignored ? "被忽略" : "未入库"}）`, (t) => {
  const root = runProject(t);
  writeFileSync(join(root, ".gitignore"), `.knit/.runtime/\n${ignored ? ".knit/tasks/\n" : ""}`);
  commitAll(root, "ignore runtime and optional task files");
  const dependency = readyTask(root, { verification: "self" });
  const task = readyTask(root, { dependsOn: [dependency.id] });
  const dispatched = prepare(root, dependency.id);
  assert.deepEqual(dispatched.problems, []);
  const worktree = dispatched.run.worktree;
  writeFileSync(join(worktree.path, "dependency.txt"), "delivered dependency code\n");
  assert.deepEqual(finishRun({ agents, root, taskId: dependency.id, runId: dispatched.run.id, workflow: workflowOf(root), verdict: null, failure: null, sessionFile: null }), []);
  assert.deepEqual(closeTask(root, dependency.id, { result: "实现已验证", paths: [] }), { kind: "done", title: "加问候语" });
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: dependency\n");
  const delivered = deliverTask(realpathSync(root), dependency.id, { authorization: "user:delivery", messageFile: message });
  assert.equal(delivered.kind, "delivered");
  const archive = archiveDirOf(dependency);
  assert.equal(existsSync(join(root, dependency.dir)), false);
  assert.equal(existsSync(join(root, archive)), ignored);
  assert.match(readFileSync(join(ignored ? root : worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(existsSync(join(root, "dependency.txt")), false);
  const history = writeArchiveHistory(root, documentOf(root, task));
  const unrelatedRecord = join(history.at(-1), "record.json");
  rmSync(unrelatedRecord);
  mkdirSync(unrelatedRecord);
  // 其它任务分支可以带着这份归档；任务身份要对应它自己的目录名和分支。
  git(root, "branch", "knit/unrelated", worktree.branch);
  const problem = refusedWithoutChanges(root, task, /还没有合并/);
  assert.ok(problem.includes(dependency.id), problem);
  assert.ok(problem.includes(`git merge ${worktree.branch}`), problem);
  assert.equal(problem.includes("knit/unrelated"), false);
  if (!ignored) {
    assert.equal(findTask(root, dependency.id).storeRoot, worktree.path);
    assert.deepEqual(prepare(root, dependency.id), {
      run: null, problems: [`没有任务 ${dependency.id}；用 knit task list 查看现有任务`],
    });
    assert.match(problem, /可能.*已经.*交付.*还没有合并/);
    assert.match(problem, /不存在/);
  }

  // 检查的是当前分支的 HEAD，并且普通的非快进合并也算已合并。
  git(root, "checkout", "-qb", "dependency-target");
  writeFileSync(join(root, "target.txt"), "current branch advanced\n");
  git(root, "add", "target.txt");
  git(root, "commit", "-qm", "advance target", "--only", "--", "target.txt");
  git(root, "merge", "--no-edit", worktree.branch);
  assert.equal(git(root, "log", "-1", "--format=%P").split(" ").length, 2);
  const accepted = prepare(root, task.id);
  assert.deepEqual(accepted.problems, []);
  assert.equal(readFileSync(join(accepted.run.worktree.path, "dependency.txt"), "utf8"), "delivered dependency code\n");
  assert.equal(readFileSync(join(accepted.run.worktree.path, "target.txt"), "utf8"), "current branch advanced\n");
  assert.equal(JSON.parse(taskFiles(root, task)[1]).runs.length, 1);

  git(root, "worktree", "remove", worktree.path);
  git(root, "branch", "-d", worktree.branch);
  const later = readyTask(root, { dependsOn: [dependency.id] });
  const withoutBranch = prepare(root, later.id);
  assert.deepEqual(withoutBranch.problems, []);
  assert.equal(readFileSync(join(withoutBranch.run.worktree.path, "dependency.txt"), "utf8"), "delivered dependency code\n");
}));

test("主会话直接完成不检查依赖，直接交付且归档的依赖可以派发", (t) => {
  const root = runProject(t);
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n");
  commitAll(root, "ignore runtime");
  const unfinished = readyTask(root);
  const dependency = readyTask(root, { verification: "self", dependsOn: [unfinished.id] });
  const task = readyTask(root, { dependsOn: [dependency.id] });
  writeFileSync(join(root, "dependency.txt"), "main session code\n");
  assert.deepEqual(closeTask(root, dependency.id, { result: "主会话完成", paths: ["dependency.txt"] }), { kind: "done", title: "加问候语" });
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: main session dependency\n");
  const delivered = deliverTask(realpathSync(root), dependency.id, { authorization: "user:delivery", messageFile: message });
  assert.equal(delivered.kind, "delivered");
  assert.match(readFileSync(join(root, archiveDirOf(dependency), "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(git(root, "branch", "--list", `knit/${basename(dependency.dir)}`), "");
  const accepted = prepare(root, task.id);
  assert.deepEqual(accepted.problems, []);
  assert.equal(readFileSync(join(accepted.run.worktree.path, "dependency.txt"), "utf8"), "main session code\n");
});

/** 准备下一次执行并把它记成结束；返回这次执行的 id。 */
function runOnce(dir, task, stage, { verdict = null, failure = null } = {}) {
  const { run, problems } = prepare(dir, task.id);
  assert.deepEqual(problems, []);
  assert.equal(run.stage.id, stage);
  const finished = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure,
    sessionFile: null,
  });
  assert.deepEqual(finished, []);
  return run.id;
}

/**
 * 实现环节的 maxVisits 是 1；任务做过实现、审查（changes_requested）、一次失败的实现、
 * 实现、审查（changes_requested）。返回项目目录、任务、到上限时该给出的那一组行。
 */
function atLimit(t) {
  const dir = runProject(t);
  const file = join(dir, ".knit/workflow.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("    name: 实现\n", "    name: 实现\n    maxVisits: 1\n"));
  commitAll(dir, "limit");
  assert.equal(workflowOf(dir).stages[0].maxVisits, 1);
  const task = readyTask(dir);
  const runs = [
    ["实现", runOnce(dir, task, "implement"), ""],
    ["审查", runOnce(dir, task, "review", { verdict: "changes_requested" }), "changes_requested"],
  ];
  const failed = runOnce(dir, task, "implement", { failure: "执行者中途退出" });
  runs.push(
    ["实现", runOnce(dir, task, "implement"), ""],
    ["审查", runOnce(dir, task, "review", { verdict: "changes_requested" }), "changes_requested"],
  );
  const notice = [
    "实现环节已经进入 2 次，到了上限，不再派发。各轮的报告：",
    ...runs.map(([name, id, verdict]) => `  ${name}（${id}）${verdict}：${RUNS_DIR}/${id}/report.md`),
    "可以走的路：",
    `  1. 主会话直接修，改完运行 knit task close ${task.id} --paths <改动的文件>`,
    "  2. 拆成更小的任务",
    `  3. 需求本身有问题就改需求，再运行 knit task ready ${task.id}；进入次数从头数`,
    `  4. 用户决定带理由接受：knit task close ${task.id} --reason <理由>`,
  ];
  assert.equal(notice.some((line) => line.includes(failed)), false);
  return { dir, task, notice };
}

test("到返工上限后派发和状态列出四条路，重新确认需求恢复派发", (t) => {
  const { dir, task, notice } = atLimit(t);
  const before = readdirSync(join(dir, RUNS_DIR)).sort();

  const refused = knit(dir, "run", "start", task.id);

  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, notice.map((line) => `${line}\n`).join(""));
  assert.equal(notice.length, 10);
  assert.deepEqual(readdirSync(join(dir, RUNS_DIR)).sort(), before);
  assert.equal(before.length, 5);

  const status = () => {
    const stored = findTask(dir, task.id);
    return statusLines(buildTaskStatus(dir, task.dir, workflowOf(dir), stored.document, stored.record));
  };
  assert.ok(status().join("\n").endsWith(`改动文件: 0 个\nAgent: pi\n下一步: ${notice.join("\n")}`));

  const file = join(dir, task.dir, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("加一个问候语。", "加一个问候语，带上名字。"));

  assert.equal(confirmTask(dir, task.id).kind, "ready");
  assert.equal(status().at(-1), `下一步: 派发实现环节（knit run start ${task.id}）`);
  const { run, problems } = prepare(dir, task.id);
  assert.deepEqual(problems, []);
  assert.equal(run.stage.id, "implement");
  assert.ok(existsSync(join(dir, run.dir, "message.md")));
});
