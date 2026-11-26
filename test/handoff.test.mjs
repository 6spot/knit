import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_HANDOFF_LIMITS, assembleHandoff } from "../dist/application/handoff.js";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { RUNS_DIR, prepareRun } from "../dist/application/run-prepare.js";
import { createTask, findTask } from "../dist/application/task-store.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { project } from "./helpers/cli.mjs";
import { agents, readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

/** 往临时项目里写文件，`files` 是路径到内容的对照。 */
function write(dir, files) {
  Object.entries(files).forEach((entry) => {
    mkdirSync(dirname(join(dir, entry[0])), { recursive: true });
    writeFileSync(join(dir, entry[0]), entry[1]);
  });
}

/**
 * 建任务，把需求部分和结果改写成给定的内容，再用 findTask 取出来。
 * `references` 拿到任务目录，返回「相关资料」的内容。
 */
function taskWith(dir, references, result = null) {
  const { id, file: path } = createTask(dir, { title: "拼出交接内容", slug: "handoff", verification: "self", priority: "P2", parent: null, dependsOn: [] }).created;
  const document = parseTaskDocument(readFileSync(join(dir, path), "utf8")).document;
  const requirement = `## 目标与范围\n\n只传需求部分。\n\n## 完成条件\n\n- 能跑通\n\n## 待澄清\n\n## 相关资料\n\n${references(dirname(path))}`;
  writeFileSync(join(dir, path), renderTaskDocument({ ...document, requirement, result }));
  return findTask(dir, id);
}

const IMPLEMENT = { id: "implement", prompt: ".knit/agents/implement.md", tools: ["read"] };
const location = (dir, task) => `你在任务的 Worktree 里工作：${dir}。仓库资料的相对路径以这里为准。\n任务目录和以前的报告在主检出（${dir}），只读，不要改。任务目录：${join(dir, task.dir)}；这些资料和报告按给出的绝对路径读取。`;

test("系统提示里是角色文件和规范", (t) => {
  const dir = project(t);
  write(dir, {
    ".knit/agents/implement.md": "\n你是实现环节的执行者。\n\n只做任务写明的事。\n\n",
    ".knit/standards/a.md": "---\ntitle: 甲规范\nstages: [implement, review]\n---\n\n甲的正文\n",
    ".knit/standards/b.md": "---\ntitle: 乙规范\nstages: [deliver]\n---\n\n乙的正文\n",
    ".knit/standards/c.md": "丙的正文\n",
  });
  const task = taskWith(dir, () => "- `.knit/standards/c.md#丙` — 点名追加的规范\n- `.knit/standards/a.md` — 本来就适用的规范");
  const handoff = assembleHandoff({ root: dir, worktree: dir, task, stage: IMPLEMENT, previous: null });

  assert.equal(
    handoff.systemPrompt,
    [
      "你是实现环节的执行者。\n\n只做任务写明的事。",
      '<standard path=".knit/standards/a.md" title="甲规范">\n甲的正文\n</standard>',
      '<standard path=".knit/standards/c.md" title="c">\n丙的正文\n</standard>',
    ].join("\n\n"),
  );
  assert.deepEqual(handoff.problems, []);
  for (const body of ["甲的正文", "乙的正文", "丙的正文"]) assert.ok(!handoff.firstMessage.includes(body), body);
  assert.ok(!handoff.firstMessage.includes("<material"));

  // 没有角色文件的环节：系统提示里只有规范。
  const review = assembleHandoff({ root: dir, worktree: dir, task, stage: { id: "review", prompt: null }, previous: null });
  assert.ok(review.systemPrompt.startsWith('<standard path=".knit/standards/a.md"'));
  assert.deepEqual(review.problems, []);
});

test("点名内置资源或旧副本时只传包内版本，点名清单时仍只给本环节", (t) => {
  const root = project(t);
  const worktree = project(t);
  const checklist = ".knit/standards/pitfalls.md";
  const previous = ".knit/standards/task-writing.md";
  const task = taskWith(root, () => `- \`${previous}\`\n- \`knit:standards/task-writing.md\`\n- \`./${checklist}#deliver\``);
  write(worktree, { [checklist]: "## deliver\n\nWorktree 的旧清单\n" });
  write(root, { [previous]: "---\nstages: [implement]\n---\n弃用副本的正文\n" });
  const input = { root, worktree, task, stage: { id: "implement", prompt: null }, previous: null };
  const missing = assembleHandoff(input);
  assert.deepEqual(missing.problems, [`主检出里没有点名的规范：${checklist}`]);
  assert.doesNotMatch(missing.firstMessage, /Worktree 的旧清单/);

  write(root, { [checklist]: "## 通用\n\n通用正文\n\n## implement, review\n\n共同正文\n\n## deliver\n\n交付正文\n" });
  const handoff = assembleHandoff(input);
  assert.deepEqual(handoff.problems, []);
  assert.equal(handoff.systemPrompt.match(/<standard path="knit:standards\/task-writing.md"/g).length, 1);
  assert.match(handoff.systemPrompt, /对照完成条件检查执行者/);
  assert.ok(handoff.systemPrompt.includes("## 通用\n\n通用正文\n\n## implement, review\n\n共同正文"));
  assert.doesNotMatch(handoff.systemPrompt, /弃用副本的正文|交付正文|Worktree 的旧清单/);
  assert.doesNotMatch(handoff.firstMessage, /<material|通用正文|共同正文|交付正文/);
});

test("第一条消息里是需求、资料、计划和上一环节的报告", (t) => {
  const dir = project(t);
  write(dir, {
    "src/a.ts": "export const a = 1;\n",
    "docs/design.md": "# 设计\n\n## 5. 交接\n\n只给点名的一节。\n\n## 6. 流程\n\n没有点名的一节。\n",
    "src/pi/index.ts": "export {};\n",
  });
  const task = taskWith(
    dir,
    () => "- `src/a.ts` — 要改的文件\n- `docs/design.md#5-交接` — 依据的设计\n- `src/pi/` — 搬来的代码",
    "这是结果，不该交出去。",
  );
  write(dir, {
    [`${task.dir}/plan.md`]: "\n先做甲，再做乙。\n",
    [`${task.dir}/record.json`]: JSON.stringify({
      confirmedDigest: null,
      changedPaths: ["src/only-in-record.ts"],
      runs: [],
      authorization: null,
    }),
    [`${task.dir}/design.md`]: "没有点名的任务资料。\n",
  });
  const input = {
    root: dir,
    worktree: dir,
    task: findTask(dir, task.document.frontmatter.id),
    stage: { id: "review", prompt: null, tools: [] },
    previous: {
      stage: "implement",
      path: join(dir, ".knit/.runtime/runs/r-1/report.md"),
      changedPaths: ["src/a.ts", "src/b.ts"],
      text: "\n做完了，测试通过。\n",
    },
  };
  const handoff = assembleHandoff(input);

  assert.equal(
    handoff.firstMessage,
    [
      location(dir, task),
      `<task path="${join(dir, task.dir, "task.md")}">\n# 拼出交接内容\n\n${task.document.requirement}\n</task>`,
      '<material path="src/a.ts">\nexport const a = 1;\n</material>',
      '<material path="docs/design.md#5-交接">\n## 5. 交接\n\n只给点名的一节。\n</material>',
      '<material path="src/pi/">\n这是一个目录，没有附上内容。\n</material>',
      `<plan path="${join(dir, task.dir, "plan.md")}">\n先做甲，再做乙。\n</plan>`,
      `<previous-report stage="implement" path="${input.previous.path}">\n` +
        "改动的文件：\n- src/a.ts\n- src/b.ts\n\n做完了，测试通过。\n</previous-report>",
    ].join("\n\n"),
  );
  assert.equal(handoff.systemPrompt, "");
  assert.deepEqual(handoff.problems, []);
  for (const hidden of ["这是结果", "only-in-record", "没有点名的一节", "没有点名的任务资料"]) {
    assert.ok(!handoff.firstMessage.includes(hidden), hidden);
  }
  assert.deepEqual(assembleHandoff(input), handoff);

  const untouched = assembleHandoff({ ...input, previous: { ...input.previous, changedPaths: [] } });
  assert.match(untouched.firstMessage, /\n改动的文件：无\n\n做完了，测试通过。\n<\/previous-report>$/);
});

test("缺少文件时说明问题", (t) => {
  const dir = project(t);
  write(dir, { "src/a.ts": "export const a = 1;\n" });
  const task = taskWith(dir, () => "- `src/missing.ts` — 写错了路径\n- `src/a.ts` — 要改的文件");
  const handoff = assembleHandoff({ root: dir, worktree: dir, task, stage: IMPLEMENT, previous: null });

  assert.deepEqual(handoff.problems, [
    "环节 implement 的角色文件不存在：.knit/agents/implement.md",
    "相关资料里点名的文件不存在：src/missing.ts",
  ]);
  assert.equal(handoff.systemPrompt, "");
  assert.equal(
    handoff.firstMessage,
    `${location(dir, task)}\n\n<task path="${join(dir, task.dir, "task.md")}">\n# 拼出交接内容\n\n${task.document.requirement}\n</task>\n\n` +
      '<material path="src/a.ts">\n需要时按路径自己读。\n</material>',
  );

  // 「相关资料」点名了自己的 plan.md 时只按点名的给，不再另给一块计划。
  const planned = taskWith(dir, (taskDir) => `- \`${taskDir}/plan.md#步骤\` — 只要步骤这一节`);
  write(dir, { [`${planned.dir}/plan.md`]: "## 步骤\n\n先做甲。\n\n## 备忘\n\n别的内容。\n" });
  const once = assembleHandoff({ root: dir, worktree: dir, task: planned, stage: { id: "implement", prompt: null }, previous: null });
  assert.ok(once.firstMessage.endsWith(`<material path="${join(dir, planned.dir, "plan.md")}#步骤">\n## 步骤\n\n先做甲。\n</material>`));
  assert.ok(!once.firstMessage.includes("<plan"));
});

/** 建任务，「相关资料」点名给定的路径，再用 findTask 取出来。 */
function taskNaming(dir, paths) {
  const { id, file: path } = createTask(dir, { title: "交接的上限", slug: "limits", verification: "self", priority: "P2", parent: null, dependsOn: [] }).created;
  const document = parseTaskDocument(readFileSync(join(dir, path), "utf8")).document;
  const requirement = `## 目标与范围\n\n## 相关资料\n\n${paths.map((named) => `- \`${named}\` — 资料`).join("\n")}`;
  writeFileSync(join(dir, path), renderTaskDocument({ ...document, requirement }));
  return findTask(dir, id);
}

const STAGE = { id: "implement", prompt: ".knit/agents/implement.md" };
const bytes = (text) => Buffer.byteLength(text);

test("单个文件超过上限时只给路径", (t) => {
  const dir = project(t);
  write(dir, { "docs/big.md": `${"字".repeat(100)}\n`, "docs/small.md": `${"字".repeat(60)}\n` });
  const handoff = assembleHandoff({
    root: dir,
    worktree: dir,
    task: taskNaming(dir, ["docs/big.md", "docs/small.md"]),
    stage: { id: "implement", prompt: null },
    previous: { stage: "implement", path: join(dir, ".knit/.runtime/runs/r-1/report.md"), changedPaths: [], text: "x".repeat(190) },
    limits: { fileBytes: 200, totalBytes: 100000 },
  });

  // 100 个汉字是 300 字节：按字符数算不会超过 200。
  assert.ok(
    handoff.firstMessage.includes(
      '<material path="docs/big.md">\n这份资料有 300 字节，超过单个文件的上限 200 字节，没有附上；需要时按路径自己读。\n</material>',
    ),
  );
  assert.ok(handoff.firstMessage.includes(`<material path="docs/small.md">\n${"字".repeat(60)}\n</material>`));
  // 报告连同“改动的文件”那一段一起算，超过了也只给路径。
  assert.ok(handoff.firstMessage.includes(`<previous-report stage="implement" path="${join(dir, ".knit/.runtime/runs/r-1/report.md")}">`));
  assert.match(handoff.firstMessage, /\n这份资料有 \d+ 字节，超过单个文件的上限 200 字节，没有附上；需要时按路径自己读。\n<\/previous-report>$/);
  assert.deepEqual(handoff.problems, []);
});

test("合计超过上限时后面的只给路径", (t) => {
  const dir = project(t);
  write(dir, {
    ".knit/agents/implement.md": "角色\n",
    ".knit/standards/a.md": "---\ntitle: 甲规范\nstages: [implement]\n---\n\n规范正文\n",
    "docs/one.md": `${"1".repeat(100)}\n`,
    "docs/two.md": `${"2".repeat(100)}\n`,
    "docs/three.md": `${"3".repeat(100)}\n`,
    "src/pi/index.ts": "export {};\n",
  });
  const task = taskNaming(dir, ["docs/one.md", "src/pi", "docs/two.md", "docs/three.md"]);
  write(dir, { [`${task.dir}/plan.md`]: "先做甲。\n" });
  const taskContent = `# 交接的上限\n\n${task.document.requirement}`;
  // 任何时候都全文给的三样：角色文件、规范、需求部分。
  const always = bytes("角色") + bytes("规范正文") + bytes(taskContent);
  const assemble = (totalBytes) =>
    assembleHandoff({ root: dir, worktree: dir, task, stage: STAGE, previous: null, limits: { fileBytes: 200, totalBytes } });

  const handoff = assemble(always + 299);
  assert.equal(
    handoff.systemPrompt,
    '角色\n\n<standard path=".knit/standards/a.md" title="甲规范">\n规范正文\n</standard>',
  );
  assert.equal(
    handoff.firstMessage,
    [
      `你在任务的 Worktree 里工作：${dir}。仓库资料的相对路径以这里为准。\n任务目录和以前的报告在主检出（${dir}），只读，不要改。任务目录：${join(dir, task.dir)}；这些资料和报告按给出的绝对路径读取。`,
      `<task path="${join(dir, task.dir, "task.md")}">\n${taskContent}\n</task>`,
      `<material path="docs/one.md">\n${"1".repeat(100)}\n</material>`,
      '<material path="src/pi">\n这是一个目录，没有附上内容。\n</material>',
      `<material path="docs/two.md">\n${"2".repeat(100)}\n</material>`,
      `<material path="docs/three.md">\n加上这份资料会超过一次交接的上限 ${always + 299} 字节，没有附上；需要时按路径自己读。\n</material>`,
      `<plan path="${join(dir, task.dir, "plan.md")}">\n先做甲。\n</plan>`,
    ].join("\n\n"),
  );
  assert.deepEqual(handoff.problems, []);

  // 正好等于上限不算超过；规范和需求再长也全文给，资料全部只剩路径。
  assert.ok(assemble(always + 312).firstMessage.includes("3".repeat(100)));
  const tight = assemble(10);
  assert.equal(tight.systemPrompt, handoff.systemPrompt);
  assert.ok(tight.firstMessage.includes(taskContent));
  assert.equal(tight.firstMessage.split("没有附上；").length, 5);
});

test("多报告的失败原因计入字节上限，裁决指令和成员路径仍能读取", (t) => {
  const dir = project(t);
  const previous = ["first", "second"].map((executor) => ({
    stage: "review", executor, verdict: null, failure: `诊断内容${"细节".repeat(100)}`,
    path: join(dir, ".knit/.runtime/runs", executor, "report.md"), changedPaths: [], text: "",
  }));
  const input = { root: dir, worktree: dir, task: taskNaming(dir, []), stage: { id: "implement", prompt: null },
    previous, instruction: "先修复两份报告共有的问题。" };
  assert.ok(assembleHandoff(input).firstMessage.includes(previous[0].failure));
  for (const limits of [{ fileBytes: 100, totalBytes: 8192 }, { fileBytes: 8192, totalBytes: 100 }]) {
    const { firstMessage } = assembleHandoff({ ...input, limits });
    assert.ok(firstMessage.includes(`<main-instruction>\n${input.instruction}\n</main-instruction>`));
    assert.doesNotMatch(firstMessage, /诊断内容/);
    assert.equal(firstMessage.match(/需要时按路径自己读/g).length, 2);
    previous.forEach((report) => assert.ok(firstMessage.includes(report.path)));
  }
});

test("没有 read 时沿用配置的单文件上限", (t) => {
  const dir = project(t);
  write(dir, {
    ".knit/agents/implement.md": "角色\n",
    ".knit/standards/a.md": "---\ntitle: 甲规范\nstages: [implement]\n---\n\n规范正文\n",
    "docs/one.md": `${"字".repeat(5000)}\n`,
  });
  const task = taskNaming(dir, ["docs/one.md"]);
  write(dir, { [`${task.dir}/plan.md`]: "先做甲。\n" });
  const input = {
    root: dir,
    worktree: dir,
    task,
    stage: { ...STAGE, tools: [] },
    previous: { stage: "implement", path: join(dir, ".knit/.runtime/runs/r-1/report.md"), changedPaths: ["docs/one.md"], text: "做完了。" },
  };
  const handoff = assembleHandoff(input);

  assert.deepEqual(assembleHandoff({ ...input, limits: { fileBytes: 10 ** 9, totalBytes: 10 ** 9 } }), handoff);
  assert.ok(!`${handoff.systemPrompt}${handoff.firstMessage}`.includes("没有附上"));
  assert.ok(handoff.firstMessage.includes("字".repeat(5000)));
  assert.deepEqual(DEFAULT_HANDOFF_LIMITS, { fileBytes: 16384, totalBytes: 65536 });
});

test("具备 read 时按呈现内容的字节筛选短文档和章节，计划和报告沿用配置预算", (t) => {
  const dir = project(t);
  const exact = `短${"a".repeat(4093)}`;
  const large = `${exact}b`;
  const task = taskNaming(dir, ["code.ts", "short.md", "long.md", "notes.txt#证据"]);
  write(dir, {
    "code.ts": "export const answer = 42;",
    "short.md": exact,
    "long.md": large,
    "notes.txt": `## 证据\n\n章节正文\n\n## 附录\n\n${large}`,
    [`${task.dir}/plan.md`]: large,
  });
  for (const tools of [null, ["read"]]) {
    const input = { root: dir, worktree: dir, task, stage: { id: "custom", prompt: null, tools },
      previous: { stage: "previous", path: "report.md", changedPaths: [], text: large } };
    const handoff = assembleHandoff(input);
    assert.deepEqual(handoff.problems, []);
    assert.deepEqual(assembleHandoff(input), handoff);
    assert.doesNotMatch(handoff.firstMessage, /export const answer/);
    assert.ok(handoff.firstMessage.includes(`<material path="short.md">\n${exact}\n</material>`));
    assert.match(handoff.firstMessage, /<material path="long.md">\n这份资料有 4097 字节，超过单个文件的上限 4096/);
    assert.match(handoff.firstMessage, /<material path="notes.txt#证据">\n## 证据\n\n章节正文\n<\/material>/);
    assert.ok(handoff.firstMessage.includes(`${large}\n</plan>`));
    assert.ok(handoff.firstMessage.includes(`${large}\n</previous-report>`));
  }
});

const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const occurrences = (text, part) => text.split(part).length - 1;

/** 准备下一次执行；返回这次执行和它的 message.md。 */
function prepare(dir, task) {
  const { run, problems } = prepareRun({
    root: dir,
    taskId: task.id,
    workflow: workflowOf(dir),
    config: loadConfig(dir).config,
    model: null,
  });
  assert.deepEqual(problems, []);
  return { ...run, root: dir, message: readFileSync(join(dir, run.dir, "message.md"), "utf8") };
}
/** 写下这次执行的报告，再把它记成正常结束。 */
function finish(dir, task, run, report, verdict = null) {
  writeFileSync(join(dir, run.dir, "report.md"), report);
  const problems = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure: null,
    sessionFile: null,
  });
  assert.deepEqual(problems, []);
}
const block = (tag, stage, run, body) =>
  `<${tag} stage="${stage}" path="${join(run.root, RUNS_DIR, run.id, "report.md")}">\n${body}\n</${tag}>`;

test("返工和再审时两份报告都拿到", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const implement = prepare(dir, task);
  mkdirSync(join(worktreeOf(dir, task), "src"));
  writeFileSync(join(worktreeOf(dir, task), "src/a.ts"), "export const a = 1;\n");
  finish(dir, task, implement, "第一次实现的报告。\n");
  const review = prepare(dir, task);
  finish(dir, task, review, "第一轮审查：a 的值不对。\n", "changes_requested");

  const rework = prepare(dir, task);
  assert.equal(rework.stage.id, "implement");
  assert.ok(
    rework.message.endsWith(
      [
        block("previous-report", "review", review, "改动的文件：无\n\n第一轮审查：a 的值不对。"),
        block("own-last-report", "implement", implement, "改动的文件：\n- src/a.ts\n\n第一次实现的报告。"),
      ].join("\n\n"),
    ),
    rework.message,
  );

  writeFileSync(join(worktreeOf(dir, task), "src/a.ts"), "export const a = 2;\n");
  finish(dir, task, rework, "返工的实现报告。\n");
  const again = prepare(dir, task);
  assert.equal(again.stage.id, "review");
  assert.ok(
    again.message.includes(
      [
        block("previous-report", "implement", rework, "改动的文件：\n- src/a.ts\n\n返工的实现报告。"),
        block("own-last-report", "review", review, "改动的文件：无\n\n第一轮审查：a 的值不对。"),
      ].join("\n\n"),
    ),
    again.message,
  );
});

test("第一次进入和留在原环节时不多给", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);

  const implement = prepare(dir, task);
  finish(dir, task, implement, "实现的报告。\n");
  const review = prepare(dir, task);
  finish(dir, task, review, "审查卡住了：缺一份资料。\n", "blocked");
  const again = prepare(dir, task);

  assert.equal(again.stage.id, "review");
  for (const message of [implement.message, review.message, again.message]) {
    assert.equal(message.includes("<own-last-report"), false);
  }
  assert.ok(
    again.message.endsWith(block("previous-report", "review", review, "改动的文件：无\n\n审查卡住了：缺一份资料。")),
  );
  assert.equal(occurrences(again.message, "<previous-report"), 1);
  assert.equal(occurrences(again.message, "审查卡住了：缺一份资料。"), 1);
});

test("受字节上限约束，不给时和原来相同", (t) => {
  const dir = runProject(t);
  const stored = findTask(dir, readyTask(dir).id);
  const input = {
    root: dir,
    worktree: worktreeOf(dir, stored),
    task: { dir: stored.dir, document: stored.document },
    stage: { id: "review", prompt: ".knit/agents/review.md" },
    previous: { stage: "implement", path: join(dir, RUNS_DIR, "r-2/report.md"), changedPaths: [], text: "实现的报告。" },
    limits: { fileBytes: 200, totalBytes: 100000 },
  };
  const own = { stage: "review", path: join(dir, RUNS_DIR, "r-1/report.md"), changedPaths: [], text: "字".repeat(100) };

  const withOwn = assembleHandoff({ ...input, own });
  assert.ok(withOwn.firstMessage.includes(`</previous-report>\n\n<own-last-report stage="review" path="${own.path}">`));
  assert.match(withOwn.firstMessage, /\n这份资料有 \d+ 字节，超过单个文件的上限 200 字节，没有附上；需要时按路径自己读。\n<\/own-last-report>$/);
  assert.equal(withOwn.firstMessage.includes("字字"), false);

  const without = assembleHandoff(input);
  assert.deepEqual(assembleHandoff({ ...input, own: null }), without);
  assert.equal(without.firstMessage.includes("<own-last-report"), false);
  assert.ok(withOwn.firstMessage.startsWith(without.firstMessage));
  assert.equal(withOwn.systemPrompt, without.systemPrompt);
});
