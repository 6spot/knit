import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task.js";
import { knit, project } from "./helpers/cli.mjs";

const now = new Date();
const MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

/** 用 `task new` 建一个任务，返回它的 id 和目录。 */
function create(dir, ...args) {
  const [first, file] = knit(dir, "task", "new", "--title", "取消任务", ...args).stdout.split("\n");
  return { id: first.replace("已创建 ", ""), dir: file.replace("/task.md", "") };
}

const read = (dir, taskDir) => parseTaskDocument(readFileSync(join(dir, taskDir, "task.md"), "utf8")).document;
/** `.knit` 下每个文件的路径和内容摘要，排好序：前后两次一样，就是文件和目录都没有变。 */
const tree = (dir) =>
  readdirSync(join(dir, ".knit"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${relative(dir, file)}`)
    .sort();

test("取消并归档：目录移到当月的归档目录，状态 cancelled，写下原因", (t) => {
  const dir = project(t);
  const task = create(dir, "--slug", "drop");
  const child = create(dir, "--slug", "child", "--parent", task.id);
  const before = read(dir, task.dir);
  const archivedDir = `.knit/tasks/archive/${MONTH}/${task.dir.split("/").at(-1)}`;

  assert.deepEqual(knit(dir, "task", "cancel", task.id, "--reason", " 不做了 "), {
    code: 0,
    stdout: `已取消 ${task.id}\n${archivedDir}\n`,
    stderr: "",
  });
  assert.equal(existsSync(join(dir, task.dir)), false);
  assert.deepEqual(read(dir, archivedDir), {
    frontmatter: { ...before.frontmatter, status: "cancelled" },
    requirement: before.requirement,
    result: "已取消：不做了",
  });
  // 取消没有内容要记，不会多出一个空的 record.json。
  assert.deepEqual(readdirSync(join(dir, archivedDir)), ["task.md"]);

  // 子任务不跟着取消。
  assert.equal(knit(dir, "task", "list").stdout, `P2  ${child.id}  draft  取消任务\n`);
  assert.equal(knit(dir, "task", "list", "--archive").stdout, `P2  ${task.id}  cancelled  取消任务\n`);
  const shown = knit(dir, "task", "show", task.id).stdout;
  assert.match(shown, /^状态: cancelled$/m);
  assert.match(shown, new RegExp(`^目录: ${archivedDir}$`, "m"));

  // 已完成、有结果的任务：原因接在原来的结果后面；正在环节里的任务取消后环节清空。
  const done = create(dir, "--slug", "done");
  writeFileSync(
    join(dir, done.dir, "task.md"),
    renderTaskDocument({ ...read(dir, done.dir), frontmatter: { ...read(dir, done.dir).frontmatter, status: "active", stage: "review" }, result: "做了一半。" }),
  );
  assert.equal(knit(dir, "task", "cancel", done.id, "--reason", "方向变了").code, 0);
  const cancelled = read(dir, `.knit/tasks/archive/${MONTH}/${done.dir.split("/").at(-1)}`);
  assert.deepEqual(
    [cancelled.frontmatter.status, cancelled.frontmatter.stage, cancelled.result],
    ["cancelled", null, "做了一半。\n\n已取消：方向变了"],
  );
});

test("已经结束的任务不能取消，文件和目录都不变", (t) => {
  const dir = project(t);
  const task = create(dir);
  const open = create(dir, "--slug", "open");
  knit(dir, "task", "cancel", task.id, "--reason", "不做了");
  const before = tree(dir);

  assert.deepEqual(knit(dir, "task", "cancel", task.id, "--reason", "不做了"), {
    code: 1,
    stdout: "",
    stderr: "任务已经结束（cancelled），不能取消\n",
  });
  assert.deepEqual(knit(dir, "task", "cancel", open.id, "--reason", "  "), {
    code: 1,
    stdout: "",
    stderr: "--reason 不能为空：写为什么不做了\n",
  });
  assert.equal(knit(dir, "task", "cancel", "k-000000000000", "--reason", "不做了").code, 1);
  assert.deepEqual(tree(dir), before);

  const delivered = read(dir, open.dir);
  writeFileSync(join(dir, open.dir, "task.md"), renderTaskDocument({ ...delivered, frontmatter: { ...delivered.frontmatter, status: "delivered" } }));
  const after = tree(dir);
  assert.match(knit(dir, "task", "cancel", open.id, "--reason", "不做了").stderr, /任务已经结束（delivered）/);
  assert.deepEqual(tree(dir), after);
});
