import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskDocument, renderTaskDocument, requirementDigest } from "../dist/domain/task-document.js";
import { renderTaskRecord } from "../dist/domain/task-record.js";
import { knit, project } from "./helpers/cli.mjs";

const EMPTY_RECORD = { confirmedDigest: null, changedPaths: [], runs: [], authorization: null };

/** 用 `task new` 建一个任务，返回它的 id 和目录。 */
function create(dir, ...args) {
  const [first, file] = knit(dir, "task", "new", ...args).stdout.split("\n");
  return { id: first.replace("已创建 ", ""), dir: file.replace("/task.md", "") };
}

/** 直接改写临时项目里的任务文件；`change` 拿到解析出的文档，返回要写回的文档。 */
function rewrite(dir, task, change, record) {
  const file = join(dir, task.dir, "task.md");
  const document = change(parseTaskDocument(readFileSync(file, "utf8")).document);
  writeFileSync(file, renderTaskDocument(document));
  if (record !== undefined) writeFileSync(join(dir, task.dir, "record.json"), renderTaskRecord(record(document)));
}

const withFrontmatter = (fields) => (document) => ({ ...document, frontmatter: { ...document.frontmatter, ...fields } });

test("task list：按优先级和创建时间排，写坏的排在最后", (t) => {
  const dir = project(t);
  assert.deepEqual(knit(dir, "task", "list"), { code: 0, stdout: "没有任务\n", stderr: "" });

  const second = create(dir, "--title", "乙", "--slug", "b");
  const first = create(dir, "--title", "甲", "--slug", "a", "--priority", "P0");
  const third = create(dir, "--title", "丙", "--slug", "c");
  const archived = create(dir, "--title", "旧的", "--slug", "old");
  rewrite(dir, second, withFrontmatter({ status: "active", stage: "implement" }), (document) => ({
    ...EMPTY_RECORD,
    confirmedDigest: requirementDigest(document),
  }));
  rewrite(dir, archived, withFrontmatter({ status: "delivered" }));
  mkdirSync(join(dir, ".knit/tasks/archive/2026-10"), { recursive: true });
  renameSync(join(dir, archived.dir), join(dir, ".knit/tasks/archive/2026-10/10-01-old"));
  mkdirSync(join(dir, ".knit/tasks/00-broken"));
  writeFileSync(join(dir, ".knit/tasks/00-broken/task.md"), "只有正文\n");
  writeFileSync(join(dir, third.dir, "record.json"), "{");

  const listed = knit(dir, "task", "list");
  assert.equal(listed.code, 0, listed.stderr);
  const lines = listed.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 2), [`P0  ${first.id}  draft  甲`, `P2  ${second.id}  active(implement)  乙`]);
  assert.match(lines[2], /^\.knit\/tasks\/00-broken：task\.md：没有开头字段/);
  assert.match(lines[3], new RegExp(`^${third.dir}：record\\.json：不是合法的 JSON`));
  assert.equal(lines.length, 4);

  assert.equal(knit(dir, "task", "list", "--archive").stdout, `P2  ${archived.id}  delivered  旧的\n`);
});

test("task show：标题、状态、场景数、待澄清数和改动文件", (t) => {
  const dir = project(t);
  const parent = create(dir, "--title", "上级", "--slug", "parent");
  const task = create(dir, "--title", "交接只传需求部分", "--slug", "handoff", "--parent", parent.id, "--depends-on", parent.id);
  const requirement = [
    "## 目标与范围",
    "",
    "## 完成条件",
    "",
    "### Requirement: 交接",
    "#### Scenario: 只传需求",
    "- WHEN 派发",
    "- THEN 只有需求部分",
    "#### Scenario: 超出上限",
    "- WHEN 超出",
    "- THEN 提示",
    "",
    "## 待澄清",
    "",
    "- [blocking] 上限是多少",
    "",
    "## 相关资料",
  ].join("\n");
  rewrite(
    dir,
    task,
    (document) => ({ ...document, requirement }),
    () => ({
      ...EMPTY_RECORD,
      changedPaths: ["next/src/b.ts", "next/src/a.ts"],
      runs: [
        {
          id: "r-1",
          stage: "implement",
          startedAt: "2026-11-15T01:00:00.000Z",
          endedAt: null,
          verdict: null,
          requirementDigest: "x",
          changedPaths: ["next/src/a.ts"],
          sessionFile: null,
        },
      ],
    }),
  );

  assert.deepEqual(knit(dir, "task", "show", task.id), {
    code: 0,
    stdout: [
      "标题: 交接只传需求部分",
      `ID: ${task.id}`,
      "状态: draft",
      "验证: self",
      "优先级: P2",
      `父任务: ${parent.id}`,
      `依赖: ${parent.id}`,
      `目录: ${task.dir}`,
      "完成条件: 2 个场景",
      "待澄清: 1 项 blocking，0 项 assumed",
      "改动文件（2）:",
      "  next/src/a.ts",
      "  next/src/b.ts",
      "",
    ].join("\n"),
    stderr: "",
  });

  // 没有内容的项写“无”；没有改动文件时不打印这一项；写法问题跟在场景数后面。
  rewrite(dir, parent, (document) => ({ ...document, requirement: "## 完成条件\n### Requirement: 空的" }));
  const bare = knit(dir, "task", "show", parent.id).stdout;
  assert.match(bare, /^父任务: 无\n依赖: 无\n/m);
  assert.match(bare, /^完成条件: 0 个场景，1 处写法问题\n待澄清: 0 项 blocking，0 项 assumed\n$/m);
  assert.equal(bare.includes("改动文件"), false);

  // 已归档的也能查到。
  mkdirSync(join(dir, ".knit/tasks/archive/2026-10"), { recursive: true });
  renameSync(join(dir, parent.dir), join(dir, ".knit/tasks/archive/2026-10/10-01-parent"));
  assert.match(knit(dir, "task", "show", parent.id).stdout, /^目录: \.knit\/tasks\/archive\/2026-10\/10-01-parent$/m);

  assert.deepEqual(knit(dir, "task", "show", "k-000000000000"), {
    code: 1,
    stdout: "",
    stderr: "没有任务 k-000000000000；用 knit task list 查看现有任务\n",
  });
  writeFileSync(join(dir, task.dir, "record.json"), JSON.stringify({ ...EMPTY_RECORD, owner: "me" }));
  assert.deepEqual(knit(dir, "task", "show", task.id), { code: 1, stdout: "", stderr: "record.json：多了字段 owner\n" });
});

test("确认后改过需求：list 和 show 都显示 draft 并说明", (t) => {
  const dir = project(t);
  const task = create(dir, "--title", "改过需求");
  const kept = create(dir, "--title", "没改需求", "--slug", "kept");
  const confirmed = (document) => ({ ...EMPTY_RECORD, confirmedDigest: requirementDigest(document) });
  rewrite(dir, task, withFrontmatter({ status: "ready" }), confirmed);
  rewrite(dir, kept, withFrontmatter({ status: "ready" }), confirmed);
  assert.match(knit(dir, "task", "show", task.id).stdout, /^状态: ready$/m);

  rewrite(dir, task, (document) => ({ ...document, requirement: `${document.requirement}\n\n- 新加的一条` }));
  assert.equal(
    knit(dir, "task", "list").stdout,
    `P2  ${task.id}  draft  改过需求（确认后改过需求）\nP2  ${kept.id}  ready  没改需求\n`,
  );
  assert.match(knit(dir, "task", "show", task.id).stdout, /^状态: draft（确认后改过需求，需要重新 task ready）$/m);
  assert.match(knit(dir, "task", "show", kept.id).stdout, /^状态: ready$/m);
});
