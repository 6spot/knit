import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assembleHandoff, DEFAULT_HANDOFF_LIMITS } from "../dist/application/handoff.js";
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

/** 用 `task new` 建任务，「相关资料」点名给定的路径，再用 findTask 取出来。 */
function taskNaming(dir, paths) {
  const [first, path] = knit(dir, "task", "new", "--title", "交接的上限", "--slug", "limits").stdout.split("\n");
  const document = parseTaskDocument(readFileSync(join(dir, path), "utf8")).document;
  const requirement = `## 目标与范围\n\n## 相关资料\n\n${paths.map((named) => `- \`${named}\` — 资料`).join("\n")}`;
  writeFileSync(join(dir, path), renderTaskDocument({ ...document, requirement }));
  return findTask(dir, first.replace("已创建 ", ""));
}

const STAGE = { id: "implement", prompt: ".knit/agents/implement.md" };
const bytes = (text) => Buffer.byteLength(text);

test("单个文件超过上限时只给路径", (t) => {
  const dir = project(t);
  write(dir, { "docs/big.md": `${"字".repeat(100)}\n`, "docs/small.md": `${"字".repeat(60)}\n` });
  const handoff = assembleHandoff({
    root: dir,
    task: taskNaming(dir, ["docs/big.md", "docs/small.md"]),
    stage: { id: "implement", prompt: null },
    previous: { stage: "implement", path: ".knit/.runtime/runs/r-1/report.md", changedPaths: [], text: "x".repeat(190) },
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
  assert.match(
    handoff.firstMessage,
    /<previous-report stage="implement" path="\.knit\/\.runtime\/runs\/r-1\/report\.md">\n这份资料有 \d+ 字节，超过单个文件的上限 200 字节，没有附上；需要时按路径自己读。\n<\/previous-report>$/,
  );
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
    assembleHandoff({ root: dir, task, stage: STAGE, previous: null, limits: { fileBytes: 200, totalBytes } });

  const handoff = assemble(always + 299);
  assert.equal(
    handoff.systemPrompt,
    '角色\n\n<standard path=".knit/standards/a.md" title="甲规范">\n规范正文\n</standard>',
  );
  assert.equal(
    handoff.firstMessage,
    [
      `<task path="${task.dir}/task.md">\n${taskContent}\n</task>`,
      `<material path="docs/one.md">\n${"1".repeat(100)}\n</material>`,
      '<material path="src/pi">\n这是一个目录，没有附上内容。\n</material>',
      `<material path="docs/two.md">\n${"2".repeat(100)}\n</material>`,
      `<material path="docs/three.md">\n加上这份资料会超过一次交接的上限 ${always + 299} 字节，没有附上；需要时按路径自己读。\n</material>`,
      `<plan path="${task.dir}/plan.md">\n先做甲。\n</plan>`,
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

test("没有超出时和原来相同", (t) => {
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
    task,
    stage: STAGE,
    previous: { stage: "implement", path: ".knit/.runtime/runs/r-1/report.md", changedPaths: ["docs/one.md"], text: "做完了。" },
  };
  const handoff = assembleHandoff(input);

  assert.deepEqual(assembleHandoff({ ...input, limits: { fileBytes: 10 ** 9, totalBytes: 10 ** 9 } }), handoff);
  assert.ok(!`${handoff.systemPrompt}${handoff.firstMessage}`.includes("没有附上"));
  assert.ok(handoff.firstMessage.includes("字".repeat(5000)));
  assert.deepEqual(DEFAULT_HANDOFF_LIMITS, { fileBytes: 16384, totalBytes: 65536 });
});
