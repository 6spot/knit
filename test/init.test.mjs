import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMPLATES } from "../dist/application/init.js";
import { parseTaskDocument } from "../dist/domain/task-document.js";
import { knit } from "./helpers/cli.mjs";

const targets = TEMPLATES.map((item) => item.target);
const template = (name) => readFileSync(new URL(`../assets/templates/${name}`, import.meta.url), "utf8");
const listed = (title, paths) => [title, ...paths.map((path) => `  ${path}`)];
/** `.knit/tasks/` 下进行中的任务的 task.md，相对项目根。 */
const taskFiles = (dir) =>
  readdirSync(join(dir, ".knit", "tasks"))
    .filter((name) => name !== "archive")
    .map((name) => `.knit/tasks/${name}/task.md`);

/** 一个空的临时目录，不在 Git 仓库里。 */
function emptyDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("在空目录里初始化", (t) => {
  const dir = emptyDir(t);
  const result = knit(dir, "init");
  assert.equal(result.code, 0, result.stderr);
  const [taskFile] = taskFiles(dir);
  const task = readFileSync(join(dir, taskFile), "utf8");
  const frontmatter = parseTaskDocument(task).document.frontmatter;
  assert.equal(
    result.stdout,
    `${[
      ...listed("已生成:", targets),
      `初始化任务: ${frontmatter.id}（${taskFile}）；在 Pi 里用 knit_task 的 use 选中它`,
    ].join("\n")}\n`,
  );
  for (const item of TEMPLATES) assert.equal(readFileSync(join(dir, item.target), "utf8"), template(item.template));
  assert.deepEqual(readdirSync(join(dir, ".knit", "standards")).sort(), [
    "delivery.md",
    "discussion.md",
    "task-splitting.md",
    "task-writing.md",
  ]);
  assert.equal(
    knit(dir, "standards", "list").stdout,
    [
      ".knit/standards/delivery.md  交付规范  deliver",
      ".knit/standards/discussion.md  讨论规范  discuss",
      ".knit/standards/task-splitting.md  任务拆分规范  discuss",
      ".knit/standards/task-writing.md  任务编写规范  discuss",
    ].join("\n") + "\n",
  );
  assert.equal(readdirSync(join(dir, ".knit", "tasks")).length, 1);
  assert.match(taskFile, /^\.knit\/tasks\/\d\d-\d\d-bootstrap-standards\/task\.md$/);
  assert.equal(frontmatter.verification, "self");
  assert.equal(knit(dir, "task", "list").stdout, `P1  ${frontmatter.id}  draft  完善项目的开发规范\n`);
  // 开头字段之后空一行，就是模板，一个字不差。
  assert.equal(task.endsWith(`createdAt: ${frontmatter.createdAt}\n---\n\n${template("tasks/bootstrap-standards.md")}`), true);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);

  assert.equal(knit(dir, "workflow", "validate").code, 0);
  assert.equal(knit(dir, "task", "new", "--title", "试一下").code, 0);
});

test("已有的文件不动，缺的补上", (t) => {
  const dir = emptyDir(t);
  knit(dir, "init");
  appendFileSync(join(dir, ".knit", "workflow.yaml"), "# 项目自己加的\n");
  rmSync(join(dir, ".knit", "agents", "review.md"));
  writeFileSync(join(dir, ".knit", "standards", "a.md"), "项目自己写的\n");
  const contents = () => [...targets, ".knit/standards/a.md"].map((path) => readFileSync(join(dir, path), "utf8"));

  const second = knit(dir, "init");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    second.stdout,
    `${[
      ...listed("已生成:", [".knit/agents/review.md"]),
      ...listed("已有，没有动:", targets.filter((target) => target !== ".knit/agents/review.md")),
    ].join("\n")}\n`,
  );
  assert.equal(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8"), `${template("workflow.yaml")}# 项目自己加的\n`);
  assert.equal(readFileSync(join(dir, ".knit", "standards", "a.md"), "utf8"), "项目自己写的\n");
  assert.equal(readFileSync(join(dir, ".knit", "agents", "review.md"), "utf8"), template("agents/review.md"));

  const before = contents();
  const third = knit(dir, "init");
  assert.equal(third.code, 0, third.stderr);
  assert.equal(third.stdout, `${listed("已有，没有动:", targets).join("\n")}\n`);
  assert.deepEqual(contents(), before);
});

test("项目里已经有任务时不建初始化任务，归档的也算", (t) => {
  const dir = emptyDir(t);
  knit(dir, "init");
  const [taskFile] = taskFiles(dir);
  const id = parseTaskDocument(readFileSync(join(dir, taskFile), "utf8")).document.frontmatter.id;
  const again = () =>
    [["init"], ["init", "--force"]].forEach((args) => {
      const result = knit(dir, ...args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, `${listed("已有，没有动:", targets).join("\n")}\n`);
    });

  again();
  assert.deepEqual(taskFiles(dir), [taskFile]);

  assert.equal(knit(dir, "task", "cancel", id, "--reason", "不需要").code, 0);
  again();
  assert.deepEqual(taskFiles(dir), []);
  assert.equal(knit(dir, "task", "list").stdout, "没有任务\n");
  assert.equal(knit(dir, "task", "list", "--archive").stdout, `P1  ${id}  cancelled  完善项目的开发规范\n`);
});

test("初始化任务的正文通得过确认", (t) => {
  const dir = emptyDir(t);
  knit(dir, "init");
  const id = parseTaskDocument(readFileSync(join(dir, taskFiles(dir)[0]), "utf8")).document.frontmatter.id;
  assert.deepEqual(knit(dir, "task", "ready", id), { code: 0, stdout: `已确认 ${id}：0 个场景\n`, stderr: "" });
  assert.equal(knit(dir, "task", "list").stdout, `P1  ${id}  ready  完善项目的开发规范\n`);
});
