import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { ARCHIVE_DIR, findTask } from "../dist/application/task-store.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { commitAll } from "./helpers/git.mjs";
import { agents, readyTask, runProject } from "./helpers/run.mjs";

const REQUIREMENT =
  "## 目标与范围\n\n加一个问候语。\n\n## 完成条件\n\n### Requirement: 问候\n#### Scenario: 打招呼\n- WHEN 运行程序\n- THEN 输出问候语\n\n## 待澄清\n\n## 相关资料";
const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const standard = (name, title, stages) => ({
  path: `.knit/standards/${name}`,
  text: `---\ntitle: ${title}\nstages: [${stages.join(", ")}]\n---\n\n- ${title}的第一条。\n- ${title}的第二条。\n`,
  block: `<standard path=".knit/standards/${name}" title="${title}">\n- ${title}的第一条。\n- ${title}的第二条。\n</standard>\n`,
});
const A = standard("a.md", "讨论规范", ["discuss"]);
const B = standard("b.md", "开发规范", ["implement", "review"]);
const C = standard("c.md", "交付规范", ["deliver"]);
const D = standard("nested/d.md", "讨论与交付规范", ["discuss", "deliver"]);

function builtinBlock(name, title) {
  const file = new URL(`../assets/standards/${name}.md`, import.meta.url);
  const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  return `<standard path="knit:standards/${name}.md" title="${title}">\n${body}\n</standard>\n`;
}
const builtinDiscussion = [builtinBlock("discussion", "讨论规范"), builtinBlock("task-splitting", "任务拆分规范"), builtinBlock("task-writing", "任务编写规范")].join("\n");
const builtinDelivery = builtinBlock("delivery", "交付规范");

/** 临时仓库，里面有这几份规范，已经提交。 */
function projectWith(t, standards) {
  const dir = runProject(t);
  mkdirSync(join(dir, ".knit", "standards"));
  standards.forEach((item) => {
    mkdirSync(dirname(join(dir, item.path)), { recursive: true });
    writeFileSync(join(dir, item.path), item.text);
  });
  commitAll(dir, "standards");
  return dir;
}

/** 一次已经结束的执行，不启动 Pi。 */
function ranStage(dir, id, verdict) {
  const workflow = workflowOf(dir);
  const { run, problems } = prepareRun({ root: dir, taskId: id, workflow, config: loadConfig(dir).config, model: null });
  assert.deepEqual(problems, []);
  assert.deepEqual(finishRun({ agents, root: dir, taskId: id, runId: run.id, workflow, verdict, failure: null, sessionFile: null }), []);
}

/** 先给完整讨论规范，再给状态与目录；返回任务的补充规范。 */
function standardsPart(dir, id, taskDir) {
  const shown = knit(dir, "context", id);
  assert.equal(shown.code, 0, shown.stderr);
  const discussion = knit(dir, "context");
  assert.equal(discussion.code, 0, discussion.stderr);
  const head = `${discussion.stdout}${knit(dir, "run", "status", id).stdout}目录: ${taskDir}\n`;
  assert.equal(shown.stdout.slice(0, head.length), head);
  return shown.stdout.slice(head.length);
}

test("各个状态给对应环节的规范", (t) => {
  const dir = projectWith(t, [A, B, C]);
  const [first, file] = knit(dir, "task", "new", "--title", "加问候语", "--verification", "independent").stdout.split("\n");
  const id = first.replace("已创建 ", "");
  const taskDir = file.replace("/task.md", "");

  assert.equal(standardsPart(dir, id, taskDir), "");

  const { document } = parseTaskDocument(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, file), renderTaskDocument({ ...document, requirement: REQUIREMENT }));
  assert.equal(knit(dir, "task", "ready", id).code, 0);
  assert.equal(standardsPart(dir, id, taskDir), `规范（implement 环节）:\n${B.block}`);

  ranStage(dir, id, null);
  assert.equal(standardsPart(dir, id, taskDir), `规范（review 环节）:\n${B.block}`);

  ranStage(dir, id, "pass");
  const delivery = `规范（deliver 环节）:\n${builtinDelivery}\n${C.block}`;
  assert.equal(standardsPart(dir, id, taskDir), delivery);

  assert.equal(knit(dir, "task", "close", id, "--result", "做完了").code, 0);
  assert.equal(standardsPart(dir, id, taskDir), delivery);
});

test("没有规范和已经结束的任务", (t) => {
  const dir = projectWith(t, [A]);
  const confirmed = readyTask(dir);
  const cancelled = readyTask(dir);
  assert.equal(knit(dir, "task", "cancel", cancelled.id, "--reason", "不做了").code, 0);

  assert.equal(standardsPart(dir, confirmed.id, confirmed.dir), "规范（implement 环节）: 没有\n");

  const ended = knit(dir, "context", cancelled.id);
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stdout.trimEnd().split("\n").at(-1), /^目录: \.knit\/tasks\/archive\//);
  assert.equal(ended.stdout.split("任务:")[0], `规范（discuss 环节）:\n${builtinDiscussion}\n${A.block}`);
});

test("按 ID 查活跃任务时跳过归档，活跃未命中时仍能找到归档任务", (t) => {
  const root = runProject(t);
  const active = readyTask(root);
  const archived = readyTask(root);
  const cancelled = knit(root, "task", "cancel", archived.id, "--reason", "不做了");
  assert.equal(cancelled.code, 0, cancelled.stderr);

  // task.md 是目录，尝试按普通文件读取就会报 EISDIR。
  const broken = join(root, ARCHIVE_DIR, "2000-01", "broken", "task.md");
  mkdirSync(broken, { recursive: true });
  assert.equal(findTask(root, active.id)?.dir, active.dir);
  for (const args of [["context"], ["run", "status"], ["run", "wait"]]) {
    const result = knit(root, ...args, active.id);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(active.id));
  }
  rmSync(broken, { recursive: true });
  assert.equal(findTask(root, archived.id)?.archived, true);
});

test("初始化直接使用安装包中的通用规范", (t) => {
  const dir = project(t);
  const initialized = knit(dir, "init");
  assert.equal(initialized.code, 0, initialized.stderr);
  const created = knit(dir, "task", "new", "--title", "加问候语");
  assert.equal(created.code, 0, created.stderr);
  const [first] = created.stdout.split("\n");
  const id = first.replace("已创建 ", "");

  const shown = knit(dir, "context", id);
  assert.equal(shown.code, 0, shown.stderr);
  const unselected = knit(dir, "context");
  assert.equal(unselected.code, 0, unselected.stderr);
  assert.ok(shown.stdout.startsWith(unselected.stdout));
  assert.deepEqual(
    [...unselected.stdout.matchAll(/^<standard path="([^"]+)"/gm)].map((match) => match[1]),
    [
      "knit:standards/discussion.md",
      "knit:standards/task-splitting.md",
      "knit:standards/task-writing.md",
    ],
  );
});

test("讨论与当前环节按路径去重，嵌套目录里的规范也完整提供", (t) => {
  const dir = projectWith(t, [D, C, A, B]);
  const discussion = knit(dir, "context");
  assert.deepEqual(discussion, { code: 0, stdout: `规范（discuss 环节）:\n${builtinDiscussion}\n${A.block}\n${D.block}`, stderr: "" });
  assert.deepEqual(knit(dir, "context"), discussion);
  const task = readyTask(dir, { verification: "self" });
  ranStage(dir, task.id, null);
  assert.equal(standardsPart(dir, task.id, task.dir), `规范（deliver 环节）:\n${builtinDelivery}\n${C.block}`);
  const shown = knit(dir, "context", task.id);
  assert.equal((shown.stdout.match(new RegExp(`<standard path="${D.path}"`, "g")) ?? []).length, 1);

  const sharedOnly = projectWith(t, [D]);
  const other = readyTask(sharedOnly, { verification: "self" });
  ranStage(sharedOnly, other.id, null);
  assert.equal(standardsPart(sharedOnly, other.id, other.dir), `规范（deliver 环节）:\n${builtinDelivery}`);
});

test("没有项目讨论规范时给出完整内置规范", (t) => {
  const dir = projectWith(t, [B]);
  assert.deepEqual(knit(dir, "context"), { code: 0, stdout: `规范（discuss 环节）:\n${builtinDiscussion}`, stderr: "" });
});

test("主会话随讨论、实现、审查和交付切换清单，正文与 CLI 选区一致", (t) => {
  const path = ".knit/standards/pitfalls.md";
  const text = "---\ntitle: 避坑清单\n---\n\n## 通用\n\n每轮核实\n\n## discuss\n\n核对需求\n\n## implement, review\n\n执行共用\n\n## review\n\n审查专用\n\n## deliver\n\n交付专用\n";
  const dir = projectWith(t, [{ path, text }]);
  const task = readyTask(dir);
  function check(stage, ...args) {
    const shown = knit(dir, "context", ...args);
    const expected = knit(dir, "standards", "pitfalls", stage);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(expected.code, 0, expected.stderr);
    const blocks = [...shown.stdout.matchAll(/<standard path="\.knit\/standards\/pitfalls\.md" title="避坑清单">\n([\s\S]*?)<\/standard>/g)];
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0][1], expected.stdout);
    return blocks[0][1];
  }
  assert.equal(check("discuss"), "## 通用\n\n每轮核实\n\n## discuss\n\n核对需求\n");
  assert.equal(check("implement", task.id), "## 通用\n\n每轮核实\n\n## implement, review\n\n执行共用\n");
  ranStage(dir, task.id, null);
  assert.equal(check("review", task.id), "## 通用\n\n每轮核实\n\n## implement, review\n\n执行共用\n\n## review\n\n审查专用\n");
  ranStage(dir, task.id, "pass");
  assert.equal(check("deliver", task.id), "## 通用\n\n每轮核实\n\n## deliver\n\n交付专用\n");
});

test("状态没变时输出逐字不变", (t) => {
  const dir = projectWith(t, [A, B, C]);
  const task = readyTask(dir);

  const first = knit(dir, "context", task.id);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^规范（implement 环节）:$/m);
  assert.deepEqual(knit(dir, "context", task.id), first);

  const missing = knit(dir, "context", "k-000000000000");
  assert.deepEqual(missing, { code: 1, stdout: "", stderr: knit(dir, "run", "status", "k-000000000000").stderr });
  assert.notEqual(missing.stderr, "");
});
