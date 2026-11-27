import { buildSessionContext, contextBlocks, contextLines, statusLines } from "../dist/application/session-context.js";
import { initProject } from "../dist/application/init.js";
import { waitRun } from "../dist/application/run-control.js";
import { cancelTask, closeTask, readyTask as confirmTask } from "../dist/application/task-lifecycle.js";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { ARCHIVE_DIR, createTask, findTask } from "../dist/application/task-store.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { loadBridge } from "./helpers/bridge.mjs";
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
  const context = buildSessionContext(dir, id);
  assert.equal(context.kind, "context");
  const head = [...contextLines(buildSessionContext(dir)), ...statusLines(context.task.status), `目录: ${taskDir}`];
  const lines = contextLines(context);
  assert.deepEqual(lines.slice(0, head.length), head);
  return lines.slice(head.length).map(line => `${line}\n`).join("");
}

test("各个状态给对应环节的规范", (t) => {
  const dir = projectWith(t, [A, B, C]);
  const { id, file } = createTask(dir, { title: "加问候语", slug: "task", verification: "independent", priority: "P2", parent: null, dependsOn: [] }).created;
  const taskDir = dirname(file);

  assert.equal(standardsPart(dir, id, taskDir), "");

  const { document } = parseTaskDocument(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, file), renderTaskDocument({ ...document, requirement: REQUIREMENT }));
  assert.equal(confirmTask(dir, id).kind, "ready");
  assert.equal(standardsPart(dir, id, taskDir), `规范（implement 环节）:\n${B.block}`);

  ranStage(dir, id, null);
  assert.equal(standardsPart(dir, id, taskDir), `规范（review 环节）:\n${B.block}`);

  ranStage(dir, id, "pass");
  const delivery = `规范（deliver 环节）:\n${builtinDelivery}\n${C.block}`;
  assert.equal(standardsPart(dir, id, taskDir), delivery);

  assert.equal(closeTask(dir, id, { result: "做完了", paths: [] }).kind, "done");
  assert.equal(standardsPart(dir, id, taskDir), delivery);
});

test("Knit 审查通过后仍有环节待派发时，桌面原生收尾无需说明，CLI 继续提示派发", (t) => {
  const dir = runProject(t);
  const workflow = join(dir, ".knit/workflow.yaml");
  writeFileSync(workflow, `${readFileSync(workflow, "utf8")}  - id: verify\n    name: 验收\n`);
  const task = readyTask(dir);
  ranStage(dir, task.id, null);
  ranStage(dir, task.id, "pass");
  const status = contextBlocks(buildSessionContext(dir, task.id), "native").status;
  const next = status.split("\n").find((line) => line.startsWith("下一步:"));
  assert.ok(next.includes(`完成验收环节。完成后运行 knit task close ${task.id} --result`));
  assert.doesNotMatch(next, /--reason|knit run start/);

  for (const command of [["context"], ["run", "status"], ["run", "wait"]]) {
    const output = knit(dir, ...command, task.id);
    assert.equal(output.code, 0, output.stderr);
    assert.ok(output.stdout.split("\n").includes(`下一步: 派发验收环节（knit run start ${task.id}）`));
  }
});

test("没有规范和已经结束的任务", (t) => {
  const dir = projectWith(t, [A]);
  const confirmed = readyTask(dir);
  const cancelled = readyTask(dir);
  assert.equal(cancelTask(dir, cancelled.id, { reason: "不做了" }).kind, "cancelled");

  assert.equal(standardsPart(dir, confirmed.id, confirmed.dir), "");

  const ended = contextLines(buildSessionContext(dir, cancelled.id)).join("\n");
  assert.match(ended, /^下一步: 任务已结束，可取消选中（knit context --unuse）$/m);
  assert.match(ended.split("\n").at(-1), /^目录: \.knit\/tasks\/archive\//);
  assert.equal(ended.split("任务:")[0], `规范（discuss 环节）:\n${builtinDiscussion}\n${A.block}`);
});

test("Pi 扩展逐轮提示任务工具，确认失效时标出需求变化", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir, { verification: "self" });
  const previous = process.env;
  process.env = { ...previous, PI_CODING_AGENT: "true" };
  t.after(() => { process.env = previous; });
  const bridge = await loadBridge(t, dir);
  await bridge.tool("knit_task", { action: "use", taskId: task.id });
  const turn = async () => {
    const sections = {};
    await bridge.fire("before_agent_start", { systemPromptOptions: { sections } });
    return sections.knit;
  };
  assert.match(await turn(), /^下一步: .*knit_run action=start/m);
  const file = join(dir, task.dir, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("加一个问候语。", "改成两句问候语。"));
  const stale = await turn();
  assert.match(stale, /^状态: draft（确认后改过需求）$/m);
  assert.match(stale, /^下一步: .*knit_task action=ready/m);
  assert.equal(confirmTask(dir, task.id).kind, "ready");
  ranStage(dir, task.id, null);
  assert.match(await turn(), /^下一步: .*knit_task action=close .*result=<总结>/m);
  assert.equal(closeTask(dir, task.id, { result: "完成", paths: [] }).kind, "done");
  assert.match(await turn(), /^下一步: .*knit_deliver/m);
  const cancelled = readyTask(dir);
  assert.equal(cancelTask(dir, cancelled.id, { reason: "取消" }).kind, "cancelled");
  await bridge.tool("knit_task", { action: "use", taskId: cancelled.id });
  const ended = await turn();
  assert.match(ended, /^下一步: .*knit_task action=use，省略 taskId/m);
  assert.doesNotMatch(ended, /knit context --unuse/);
});

test("按 ID 查活跃任务时跳过归档，活跃未命中时仍能找到归档任务", async (t) => {
  const root = runProject(t);
  const active = readyTask(root);
  const archived = readyTask(root);
  assert.equal(cancelTask(root, archived.id, { reason: "不做了" }).kind, "cancelled");

  // task.md 是目录，尝试按普通文件读取就会报 EISDIR。
  const broken = join(root, ARCHIVE_DIR, "2000-01", "broken", "task.md");
  mkdirSync(broken, { recursive: true });
  assert.equal(findTask(root, active.id)?.dir, active.dir);
  const context = buildSessionContext(root, active.id);
  assert.equal(context.kind, "context");
  assert.ok(statusLines(context.task.status)[0].includes(active.id));
  const waited = await waitRun(root, active.id);
  assert.deepEqual(waited.problems, []);
  assert.equal(waited.task.document.frontmatter.id, active.id);
  rmSync(broken, { recursive: true });
  assert.equal(findTask(root, archived.id)?.archived, true);
});

test("独立初始化的子项目供 CLI 和钩子共同选用，指令文件错误在派发前报告", (t) => {
  const root = runProject(t);
  const child = join(root, "child");
  const nested = join(child, "nested");
  mkdirSync(nested, { recursive: true });
  const task = initProject(child).task;
  assert.match(knit(nested, "task", "list").stdout, new RegExp(task.id));
  assert.equal(knit(nested, "workflow", "validate").code, 0);
  const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;
  const selected = spawnSync(process.execPath, [cli, "context", "--use", task.id], { cwd: nested, encoding: "utf8",
    env: { ...process.env, KNIT_HOST: "agy", KNIT_HOST_SESSION: "nested" } });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(JSON.parse(readFileSync(join(child, ".knit/.runtime/host-sessions/agy-nested.json"))).taskId, task.id);
  for (const file of [join(child, "missing"), nested]) {
    const invalid = knit(nested, "run", "start", task.id, "--instruction-file", file);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stderr, `读不到修改指令：--instruction-file 需要已有的普通文件：${file}\n`);
  }
});

test("初始化直接使用安装包中的通用规范", (t) => {
  const dir = project(t);
  initProject(dir);
  const task = createTask(dir, { title: "加问候语", slug: "task", verification: "self", priority: "P2", parent: null, dependsOn: [] });
  assert.deepEqual(task.problems, []);
  const shown = knit(dir, "context", task.created.id);
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
  assert.match(unselected.stdout, /按当前宿主指引派发外部执行者或使用原生子 Agent/);
  for (const role of ["implement", "review"]) {
    const prompt = readFileSync(join(dir, `.knit/agents/${role}.md`), "utf8");
    assert.match(prompt, /新会话的交接消息/);
    assert.match(prompt, /续聊.*本轮增量消息/);
  }
  assert.match(unselected.stdout, /## 指称任务[\s\S]*标题（ID）/);
});

test("讨论与当前环节按路径去重，嵌套目录里的规范也完整提供", (t) => {
  const dir = projectWith(t, [D, C, A, B]);
  const discussion = contextLines(buildSessionContext(dir)).join("\n");
  assert.equal(`${discussion}\n`, `规范（discuss 环节）:\n${builtinDiscussion}\n${A.block}\n${D.block}`);
  assert.equal(contextLines(buildSessionContext(dir)).join("\n"), discussion);
  const task = readyTask(dir, { verification: "self" });
  ranStage(dir, task.id, null);
  assert.equal(standardsPart(dir, task.id, task.dir), `规范（deliver 环节）:\n${builtinDelivery}\n${C.block}`);
  const shown = contextLines(buildSessionContext(dir, task.id)).join("\n");
  assert.equal((shown.match(new RegExp(`<standard path="${D.path}"`, "g")) ?? []).length, 1);

  const sharedOnly = projectWith(t, [D]);
  const other = readyTask(sharedOnly, { verification: "self" });
  ranStage(sharedOnly, other.id, null);
  assert.equal(standardsPart(sharedOnly, other.id, other.dir), `规范（deliver 环节）:\n${builtinDelivery}`);
});

test("没有项目讨论规范时给出完整内置规范", (t) => {
  const dir = projectWith(t, [B]);
  assert.equal(contextLines(buildSessionContext(dir)).join("\n") + "\n", `规范（discuss 环节）:\n${builtinDiscussion}`);
});

test("主会话随讨论、实现、审查和交付切换清单，正文与 CLI 选区一致", (t) => {
  const path = ".knit/standards/pitfalls.md";
  const text = "---\ntitle: 避坑清单\n---\n\n## 通用\n\n每轮核实\n\n## discuss\n\n核对需求\n\n## implement, review\n\n执行共用\n\n## review\n\n审查专用\n\n## deliver\n\n交付专用\n";
  const dir = projectWith(t, [{ path, text }]);
  const task = readyTask(dir);
  function check(stage, ...args) {
    const shown = contextLines(buildSessionContext(dir, ...args)).join("\n");
    const expected = knit(dir, "standards", "pitfalls", stage);
    assert.equal(expected.code, 0, expected.stderr);
    const blocks = [...shown.matchAll(/<standard path="\.knit\/standards\/pitfalls\.md" title="避坑清单">\n([\s\S]*?)<\/standard>/g)];
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

  const first = contextLines(buildSessionContext(dir, task.id)).join("\n");
  assert.match(first, /^规范（implement 环节）:$/m);
  assert.equal(contextLines(buildSessionContext(dir, task.id)).join("\n"), first);
  assert.deepEqual(buildSessionContext(dir, "k-000000000000"), {
    kind: "refused", problems: ["没有任务 k-000000000000；用 knit task list 查看现有任务"],
  });
});
