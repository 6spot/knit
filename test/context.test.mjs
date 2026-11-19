import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../dist/application/config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task-document.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { commitAll } from "./helpers/git.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";

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

/** 临时仓库，里面有这几份规范，已经提交。 */
function projectWith(t, standards) {
  const dir = runProject(t);
  mkdirSync(join(dir, ".knit", "standards"));
  for (const item of standards) writeFileSync(join(dir, item.path), item.text);
  commitAll(dir, "standards");
  return dir;
}

/** 一次已经结束的执行，不启动 Pi。 */
function ranStage(dir, id, verdict) {
  const workflow = workflowOf(dir);
  const { run, problems } = prepareRun({ root: dir, taskId: id, workflow, config: loadConfig(dir).config, model: null });
  assert.deepEqual(problems, []);
  assert.deepEqual(finishRun({ root: dir, taskId: id, runId: run.id, workflow, verdict, failure: null, sessionFile: null }), []);
}

/** `knit context` 的输出要以 `knit run status` 的输出开头，接着是 `目录:` 一行；返回这之后的部分。 */
function standardsPart(dir, id, taskDir) {
  const shown = knit(dir, "context", id);
  assert.equal(shown.code, 0, shown.stderr);
  const head = `${knit(dir, "run", "status", id).stdout}目录: ${taskDir}\n`;
  assert.equal(shown.stdout.slice(0, head.length), head);
  return shown.stdout.slice(head.length);
}

test("各个状态给对应环节的规范", (t) => {
  const dir = projectWith(t, [A, B, C]);
  const [first, file] = knit(dir, "task", "new", "--title", "加问候语", "--verification", "independent").stdout.split("\n");
  const id = first.replace("已创建 ", "");
  const taskDir = file.replace("/task.md", "");

  assert.equal(standardsPart(dir, id, taskDir), `规范（discuss 环节）:\n${A.block}`);

  const { document } = parseTaskDocument(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, file), renderTaskDocument({ ...document, requirement: REQUIREMENT }));
  assert.equal(knit(dir, "task", "ready", id).code, 0);
  assert.equal(standardsPart(dir, id, taskDir), `规范（implement 环节）:\n${B.block}`);

  ranStage(dir, id, null);
  assert.equal(standardsPart(dir, id, taskDir), `规范（review 环节）:\n${B.block}`);

  ranStage(dir, id, "pass");
  assert.equal(standardsPart(dir, id, taskDir), `规范（deliver 环节）:\n${C.block}`);

  assert.equal(knit(dir, "task", "close", id, "--result", "做完了").code, 0);
  assert.equal(standardsPart(dir, id, taskDir), `规范（deliver 环节）:\n${C.block}`);
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
  assert.doesNotMatch(ended.stdout, /规范/);
});

test("初始化生成的通用规范", (t) => {
  const dir = project(t);
  const initialized = knit(dir, "init");
  assert.equal(initialized.code, 0, initialized.stderr);
  const created = knit(dir, "task", "new", "--title", "加问候语");
  assert.equal(created.code, 0, created.stderr);
  const [first] = created.stdout.split("\n");
  const id = first.replace("已创建 ", "");

  const shown = knit(dir, "context", id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(
    [...shown.stdout.matchAll(/^<standard path="([^"]+)"/gm)].map((match) => match[1]),
    [
      ".knit/standards/discussion.md",
      ".knit/standards/task-splitting.md",
      ".knit/standards/task-writing.md",
    ],
  );
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
