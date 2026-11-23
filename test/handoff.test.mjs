import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assembleHandoff } from "../dist/application/handoff.js";
import { findTask } from "../dist/application/task-store.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task-document.js";
import { knit, project } from "./helpers/cli.mjs";

/** 往临时项目里写文件，`files` 是路径到内容的对照。 */
function write(dir, files) {
  Object.entries(files).forEach((entry) => {
    mkdirSync(dirname(join(dir, entry[0])), { recursive: true });
    writeFileSync(join(dir, entry[0]), entry[1]);
  });
}

/**
 * 用 `task new` 建任务，把需求部分和结果改写成给定的内容，再用 findTask 取出来。
 * `references` 拿到任务目录，返回「相关资料」的内容。
 */
function taskWith(dir, references, result = null) {
  const [first, path] = knit(dir, "task", "new", "--title", "拼出交接内容", "--slug", "handoff").stdout.split("\n");
  const document = parseTaskDocument(readFileSync(join(dir, path), "utf8")).document;
  const requirement = `## 目标与范围\n\n只传需求部分。\n\n## 完成条件\n\n- 能跑通\n\n## 待澄清\n\n## 相关资料\n\n${references(dirname(path))}`;
  writeFileSync(join(dir, path), renderTaskDocument({ ...document, requirement, result }));
  return findTask(dir, first.replace("已创建 ", ""));
}

const IMPLEMENT = { id: "implement", prompt: ".knit/agents/implement.md" };
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
    stage: { id: "review", prompt: null },
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
      '<material path="src/a.ts">\nexport const a = 1;\n</material>',
  );

  // 「相关资料」点名了自己的 plan.md 时只按点名的给，不再另给一块计划。
  const planned = taskWith(dir, (taskDir) => `- \`${taskDir}/plan.md#步骤\` — 只要步骤这一节`);
  write(dir, { [`${planned.dir}/plan.md`]: "## 步骤\n\n先做甲。\n\n## 备忘\n\n别的内容。\n" });
  const once = assembleHandoff({ root: dir, worktree: dir, task: planned, stage: { id: "implement", prompt: null }, previous: null });
  assert.ok(once.firstMessage.endsWith(`<material path="${join(dir, planned.dir, "plan.md")}#步骤">\n## 步骤\n\n先做甲。\n</material>`));
  assert.ok(!once.firstMessage.includes("<plan"));
});
