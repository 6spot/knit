import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskDocument, renderTaskDocument, renderTaskRecord, requirementDigest } from "../dist/domain/task.js";
import { knit, project } from "./helpers/cli.mjs";

const REQUIREMENT =
  "## 目标与范围\n\n交接只传需求部分。\n\n## 完成条件\n\n### Requirement: 交接\n#### Scenario: 只传需求\n- WHEN 派发\n- THEN 只有需求部分\n\n## 待澄清\n\n## 相关资料";

/** 用 `task new` 建任务并填入需求；`ready` 为真时再用 `task ready` 确认。 */
function create(dir, { ready = true, args = [] } = {}) {
  const [first, path] = knit(dir, "task", "new", "--title", "完成任务", ...args).stdout.split("\n");
  const task = { id: first.replace("已创建 ", ""), file: join(dir, path), record: join(dir, path.replace("task.md", "record.json")) };
  writeFileSync(task.file, renderTaskDocument({ ...read(task), requirement: REQUIREMENT }));
  if (ready) assert.equal(knit(dir, "task", "ready", task.id).code, 0);
  return task;
}

const read = (task) => parseTaskDocument(readFileSync(task.file, "utf8")).document;
const record = (task) => JSON.parse(readFileSync(task.record, "utf8"));
const files = (task) => [readFileSync(task.file, "utf8"), existsSync(task.record) ? readFileSync(task.record, "utf8") : null];
const runOf = (id, stage, verdict) => ({
  id,
  stage,
  startedAt: "2026-11-15T01:00:00.000Z",
  endedAt: "2026-11-15T01:10:00.000Z",
  verdict,
  failure: null,
  requirementDigest: "x",
  changedPaths: [],
  sessionFile: null,
});

test("完成一个已确认的任务：状态 done，写下结果，登记改动文件", (t) => {
  const dir = project(t);
  const task = create(dir);
  const before = read(task);
  writeFileSync(task.record, renderTaskRecord({ ...record(task), changedPaths: ["next/src/c.ts", "next/src/a.ts"] }));

  assert.deepEqual(
    knit(dir, "task", "close", task.id, "--result", "  做完了  ", "--paths", "next/src/b.ts", "./next/src/a.ts", "--reason", "不用写"),
    { code: 0, stdout: `已完成 ${task.id}\n`, stderr: "" },
  );
  const after = read(task);
  assert.deepEqual(after, { ...before, frontmatter: { ...before.frontmatter, status: "done" }, result: "做完了" });
  assert.equal(readFileSync(task.file, "utf8").includes(REQUIREMENT), true);
  assert.equal(requirementDigest(after), requirementDigest(before));
  assert.deepEqual(record(task), {
    confirmedDigest: requirementDigest(before),
    changedPaths: ["next/src/a.ts", "next/src/b.ts", "next/src/c.ts"],
    runs: [],
    authorization: null,
  });
  assert.match(knit(dir, "task", "show", task.id).stdout, /^状态: done$/m);

  // 正在某个环节里的任务也可以完成；不给 --paths 时不登记。
  const active = create(dir, { args: ["--slug", "active"] });
  writeFileSync(
    active.file,
    renderTaskDocument({ ...read(active), frontmatter: { ...read(active).frontmatter, status: "active", stage: "implement" } }),
  );
  assert.equal(knit(dir, "task", "close", active.id, "--result", "做完了\n\n未验证：无。").code, 0);
  assert.deepEqual(
    [read(active).frontmatter.status, read(active).frontmatter.stage, read(active).result, record(active).changedPaths],
    ["done", null, "做完了\n\n未验证：无。", []],
  );
});

test("不能完成时说明下一步，不写文件", (t) => {
  const dir = project(t);
  const draft = create(dir, { ready: false });
  const stale = create(dir, { args: ["--slug", "stale"] });
  writeFileSync(stale.file, renderTaskDocument({ ...read(stale), requirement: `${REQUIREMENT}\n\n- 确认后加的一条` }));
  for (const task of [draft, stale]) {
    const before = files(task);
    const result = knit(dir, "task", "close", task.id, "--result", "做完了");
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `需求还没有确认，或确认之后改过；先运行 knit task ready ${task.id}\n`);
    assert.deepEqual(files(task), before);
  }

  const ready = create(dir, { args: ["--slug", "ready"] });
  const before = files(ready);
  const cases = [
    [["--result", "  "], /^--result 不能为空/],
    [["--result", "做完了", "--paths", "next/a.ts", "/etc/passwd", "../outside.ts", "next/../../b.ts"], /^--paths 要写项目内的相对路径：\/etc\/passwd\n.*\.\.\/outside\.ts\n.*next\/\.\.\/\.\.\/b\.ts\n$/],
  ];
  for (const [args, expected] of cases) {
    const result = knit(dir, "task", "close", ready.id, ...args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, expected);
    assert.deepEqual(files(ready), before);
  }
  assert.equal(knit(dir, "task", "close", "k-000000000000", "--result", "做完了").stderr, "没有任务 k-000000000000；用 knit task list 查看现有任务\n");

  knit(dir, "task", "close", ready.id, "--result", "做完了");
  const done = files(ready);
  const again = knit(dir, "task", "close", ready.id, "--result", "又做完了");
  assert.equal(again.code, 1);
  assert.match(again.stderr, /任务已经完成；要改总结直接编辑 task\.md 的「结果」/);
  assert.deepEqual(files(ready), done);
  for (const status of ["delivered", "cancelled"]) {
    writeFileSync(ready.file, renderTaskDocument({ ...read(ready), frontmatter: { ...read(ready).frontmatter, status } }));
    assert.match(knit(dir, "task", "close", ready.id, "--result", "做完了").stderr, new RegExp(`任务已经结束（${status}）`));
  }
});

test("独立审查的任务要先审查通过，或给出直接完成的理由", (t) => {
  const dir = project(t);
  const task = create(dir, { args: ["--verification", "independent"] });
  const before = files(task);
  const refused = knit(dir, "task", "close", task.id, "--result", "做完了");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /独立审查的任务要在审查通过后才能完成.*--reason <理由>/);
  assert.deepEqual(files(task), before);

  // 最后一条带结论的执行不是 pass：仍然拒绝。
  const withRuns = (target, ...runs) => {
    const requirementDigest = record(target).confirmedDigest;
    writeFileSync(target.record, renderTaskRecord({ ...record(target), runs: runs.map((run) => ({ ...run, requirementDigest })) }));
  };
  withRuns(task, runOf("r-1", "review", "pass"), runOf("r-2", "review", "changes_requested"), runOf("r-3", "implement", null));
  assert.equal(knit(dir, "task", "close", task.id, "--result", "做完了").code, 1);

  assert.equal(knit(dir, "task", "close", task.id, "--result", "做完了", "--reason", "用户要求").code, 0);
  assert.equal(read(task).result, "做完了\n\n没有经过独立审查，直接完成：用户要求");
  assert.equal(read(task).frontmatter.status, "done");

  // 审查通过之后不需要理由，给了也不写进结果。
  const reviewed = create(dir, { args: ["--verification", "independent", "--slug", "reviewed"] });
  withRuns(reviewed, runOf("r-1", "review", "changes_requested"), runOf("r-2", "review", "pass"), runOf("r-3", "implement", null));
  assert.equal(knit(dir, "task", "close", reviewed.id, "--result", "做完了", "--reason", "用户要求").code, 0);
  assert.equal(read(reviewed).result, "做完了");
});
