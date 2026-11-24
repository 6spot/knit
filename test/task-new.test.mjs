import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task.js";
import { knit, project } from "./helpers/cli.mjs";

const now = new Date();
const TODAY = [now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-");

const taskDirs = (dir) => (existsSync(join(dir, ".knit/tasks")) ? readdirSync(join(dir, ".knit/tasks")).sort() : []);
const read = (dir, file) => parseTaskDocument(readFileSync(join(dir, file), "utf8")).document;

test("创建一个任务：文件能解析，输出 id 和路径", (t) => {
  const dir = project(t);
  const created = knit(dir, "task", "new", "--title", "交接只传需求部分", "--slug", "handoff");
  assert.equal(created.code, 0, created.stderr);
  const file = `.knit/tasks/${TODAY}-handoff/task.md`;
  const document = read(dir, file);
  assert.equal(created.stdout, `已创建 ${document.frontmatter.id}\n${file}\n`);
  assert.match(document.frontmatter.id, /^k-[0-9a-f]{12}$/);
  assert.deepEqual(
    { ...document.frontmatter, id: null, createdAt: null },
    { id: null, title: "交接只传需求部分", status: "draft", stage: null, verification: "self", parent: null, dependsOn: [], priority: "P2", createdAt: null },
  );
  assert.equal(new Date(document.frontmatter.createdAt).toISOString(), document.frontmatter.createdAt);
  assert.equal(document.requirement, "## 目标与范围\n\n## 完成条件\n\n## 待澄清\n\n## 相关资料");
  assert.equal(document.result, null);
  assert.deepEqual(readdirSync(join(dir, `.knit/tasks/${TODAY}-handoff`)), ["task.md"]);

  // 已归档的任务也算存在，可以作上级和依赖。
  const archived = { ...document, frontmatter: { ...document.frontmatter, id: "k-0123456789ab", status: "delivered" } };
  mkdirSync(join(dir, ".knit/tasks/archive/2026-10/10-01-old"), { recursive: true });
  writeFileSync(join(dir, ".knit/tasks/archive/2026-10/10-01-old/task.md"), renderTaskDocument(archived));
  const child = knit(
    dir, "task", "new", "--title", "子任务: 含冒号", "--verification", "independent", "--priority", "P0",
    "--parent", document.frontmatter.id, "--depends-on", document.frontmatter.id, "k-0123456789ab",
  );
  assert.equal(child.code, 0, child.stderr);
  const childDocument = read(dir, `.knit/tasks/${TODAY}-task/task.md`);
  assert.deepEqual(
    { ...childDocument.frontmatter, id: null, createdAt: null },
    {
      id: null, title: "子任务: 含冒号", status: "draft", stage: null, verification: "independent",
      parent: document.frontmatter.id, dependsOn: [document.frontmatter.id, "k-0123456789ab"], priority: "P0", createdAt: null,
    },
  );
});

test("同名目录加序号，归档里的同名目录也算；名称里的其它字符换成 -", (t) => {
  const dir = project(t);
  const first = knit(dir, "task", "new", "--title", "第一个", "--slug", "handoff");
  const second = knit(dir, "task", "new", "--title", "第二个", "--slug", "handoff");
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(taskDirs(dir), [`${TODAY}-handoff`, `${TODAY}-handoff-2`]);
  assert.equal(second.stdout.split("\n")[1], `.knit/tasks/${TODAY}-handoff-2/task.md`);
  assert.notEqual(first.stdout.split("\n")[0], second.stdout.split("\n")[0]);

  mkdirSync(join(dir, `.knit/tasks/archive/2026-10/${TODAY}-handoff-3`), { recursive: true });
  knit(dir, "task", "new", "--title", "第三个", "--slug", "handoff");
  knit(dir, "task", "new", "--title", "名称", "--slug", "交接 hand/off！");
  knit(dir, "task", "new", "--title", "名称", "--slug", "！！");
  assert.deepEqual(taskDirs(dir), [
    `${TODAY}-hand-off`, `${TODAY}-handoff`, `${TODAY}-handoff-2`, `${TODAY}-handoff-4`, `${TODAY}-task`, "archive",
  ]);
});

test("参数不对时不创建，说明是哪个参数", (t) => {
  const dir = project(t);
  const existing = knit(dir, "task", "new", "--title", "已有").stdout.split("\n")[0].replace("已创建 ", "");
  const before = taskDirs(dir);
  const cases = [
    [["--parent", "k-000000000000"], /--parent.*k-000000000000/],
    [["--depends-on", existing, "k-111111111111"], /--depends-on.*k-111111111111/],
    [["--verification", "strict"], /--verification.*none, self, independent/s],
    [["--priority", "P9"], /--priority.*P0, P1, P2, P3/s],
  ];
  for (const [args, expected] of cases) {
    const result = knit(dir, "task", "new", "--title", "不该出现", ...args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, "");
  }
  assert.equal(knit(dir, "task", "new", "--title", "不该出现", "--depends-on", existing, "k-111111111111").stderr.includes(existing), false);
  assert.deepEqual(taskDirs(dir), before);

  const bare = project(t);
  rmdirSync(join(bare, ".knit"));
  const result = knit(bare, "task", "new", "--title", "没有项目");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /knit init/);
  assert.deepEqual(readdirSync(bare), []);
});
