import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { test } from "node:test";
import { RUNS_DIR } from "../dist/contracts/task.js";
import { procStartTicks } from "../dist/infrastructure/process.js";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { cancelTask, closeTask, readyTask } from "../dist/application/task-lifecycle.js";
import { deliverTask } from "../dist/application/delivery.js";
import { createTask, findTask, readTask, saveTask, scanTasks, taskCommit } from "../dist/application/task-store.js";
import { currentStatus, parseTaskDocument, renderTaskDocument, renderTaskRecord, requirementDigest } from "../dist/domain/task.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { git, gitProject } from "./helpers/git.mjs";
import { agents, doneTask, runProject, writeArchiveHistory } from "./helpers/run.mjs";

const now = new Date();
const TODAY = [now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-");

const taskDirs = (dir) => (existsSync(join(dir, ".knit/tasks")) ? readdirSync(join(dir, ".knit/tasks")).sort() : []);
const readCreated = (dir, file) => parseTaskDocument(readFileSync(join(dir, file), "utf8")).document;

const defaults = { title: "任务", slug: "task", verification: "self", priority: "P2", parent: null, dependsOn: [] };
function draft(root, options = {}) {
  const result = createTask(root, { ...defaults, ...options });
  assert.deepEqual(result.problems, []);
  const dir = dirname(result.created.file);
  return { id: result.created.id, dir, file: join(root, result.created.file), record: join(root, dir, "record.json") };
}

test("创建一个任务：文件能解析，输出 id 和路径", (t) => {
  const dir = project(t);
  const created = knit(dir, "task", "new", "--title", "交接只传需求部分", "--slug", "handoff");
  assert.equal(created.code, 0, created.stderr);
  const file = `.knit/tasks/${TODAY}-handoff/task.md`;
  const document = readCreated(dir, file);
  assert.equal(created.stdout, `已创建 交接只传需求部分（${document.frontmatter.id}）\n${file}\n`);
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
  draft(dir, { title: "子任务: 含冒号", verification: "independent", priority: "P0", parent: document.frontmatter.id,
    dependsOn: [document.frontmatter.id, "k-0123456789ab"] });
  const childDocument = readCreated(dir, `.knit/tasks/${TODAY}-task/task.md`);
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
  const first = draft(dir, { slug: "handoff" });
  const second = draft(dir, { slug: "handoff" });
  assert.equal(second.dir, `.knit/tasks/${TODAY}-handoff-2`);
  assert.notEqual(first.id, second.id);
  mkdirSync(join(dir, `.knit/tasks/archive/2026-10/${TODAY}-handoff-3`), { recursive: true });
  for (const slug of ["handoff", "交接 hand/off！", "！！"]) draft(dir, { slug });
  assert.deepEqual(taskDirs(dir), [
    `${TODAY}-hand-off`, `${TODAY}-handoff`, `${TODAY}-handoff-2`, `${TODAY}-handoff-4`, `${TODAY}-task`, "archive",
  ]);
});

test("参数不对时不创建，说明是哪个参数", (t) => {
  const dir = project(t);
  const existing = draft(dir).id;
  const before = taskDirs(dir);
  for (const [options, expected] of [
    [{ parent: "k-000000000000" }, /--parent.*k-000000000000/],
    [{ dependsOn: [existing, "k-111111111111"] }, /--depends-on.*k-111111111111/],
  ]) {
    const result = createTask(dir, { ...defaults, ...options });
    assert.equal(result.created, null);
    assert.match(result.problems.join("\n"), expected);
    assert.ok(!result.problems.join("\n").includes(existing));
  }
  // 枚举由 Commander 在进入应用层前校验。
  for (const [option, value, expected] of [["--verification", "strict", /none, self, independent/], ["--priority", "P9", /P0, P1, P2, P3/]]) {
    const result = knit(dir, "task", "new", "--title", "不该出现", option, value);
    assert.equal(result.code, 1);
    assert.match(result.stderr, expected);
  }
  assert.deepEqual(taskDirs(dir), before);

  const bare = project(t);
  rmdirSync(join(bare, ".knit"));
  const result = knit(bare, "task", "new", "--title", "没有项目");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /knit init/);
  assert.deepEqual(readdirSync(bare), []);
});

const scenario = (name, steps = "- WHEN 执行操作\n- THEN 得到结果") => `#### Scenario: ${name}\n${steps}\n`;
const requirementOf = ({ acceptance = "", clarify = "" }) =>
  `## 目标与范围\n\n## 完成条件\n\n${acceptance}\n## 待澄清\n\n${clarify}\n## 相关资料`;
const TWO = `### Requirement: 需求\n${scenario("第一场景")}${scenario("第二场景")}`;

function create(dir, requirement, frontmatter = {}, options = {}) {
  const task = draft(dir, options);
  const document = read(task);
  writeFileSync(task.file, renderTaskDocument({ ...document, requirement, frontmatter: { ...document.frontmatter, ...frontmatter } }));
  return task;
}

const read = (task) => parseTaskDocument(readFileSync(task.file, "utf8")).document;
const record = (task) => JSON.parse(readFileSync(task.record, "utf8"));

test("确认通过：状态变成 ready，记下需求摘要", (t) => {
  const dir = project(t);
  const task = create(dir, requirementOf({ acceptance: TWO, clarify: "- [assumed] 上限按 64 KB\n" }));
  const before = read(task);

  assert.deepEqual(knit(dir, "task", "ready", task.id), {
    code: 0,
    stdout: `已确认 任务（${task.id}）：2 个场景\n还有 1 项 [assumed] 没有得到用户确认\n`,
    stderr: "",
  });
  const after = read(task);
  assert.deepEqual(after, { ...before, frontmatter: { ...before.frontmatter, status: "ready" } });
  assert.deepEqual(record(task), { confirmedDigest: requirementDigest(after), changedPaths: [], runs: [], authorization: null });
  assert.equal(currentStatus(read(task), record(task)), "ready");

  // self／none 的任务可以不写场景，完成条件用普通列表。
  const plain = create(dir, requirementOf({ acceptance: "- 能跑通\n" }), {}, { slug: "plain", verification: "none" });
  assert.deepEqual(readyTask(dir, plain.id), { kind: "ready", title: "任务", scenarios: 0, assumed: 0 });
});

test("不满足时拒绝并说明怎么改，不写文件", (t) => {
  const dir = project(t);
  for (const [requirement, fields, check] of [
    [requirementOf({ acceptance: TWO, clarify: "- [blocking] 上限是多少\n- [blocking] 超出时怎么办\n- [blocking] 谁确认\n- [blocking] 第四项" }), {},
      (result) => { assert.equal(result.blocking, 4); assert.deepEqual(result.blockingItems, ["上限是多少", "超出时怎么办", "谁确认"]); }],
    [requirementOf({ acceptance: `### Requirement: 需求\n${scenario("缺一步", "- WHEN 执行操作")}` }), {},
      (result) => assert.match(result.scenarioIssues.join("\n"), /缺一步.*THEN/)],
    [requirementOf({ acceptance: "- 能跑通" }), { verification: "independent" }, (result) => assert.equal(result.missingScenarios, true)],
    [requirementOf({ acceptance: "### Requirement: 空的", clarify: "- [blocking] 没定" }), {},
      (result) => { assert.equal(result.blocking, 1); assert.equal(result.scenarioIssues.length, 1); }],
  ]) {
    const task = create(dir, requirement, fields);
    const before = readFileSync(task.file, "utf8");
    const result = readyTask(dir, task.id);
    assert.equal(result.kind, "invalidRequirement");
    check(result);
    assert.equal(readFileSync(task.file, "utf8"), before);
    assert.equal(existsSync(task.record), false);
  }
  assert.match(readyTask(dir, "k-000000000000").problems[0], /没有任务/);
  for (const status of ["done", "delivered", "cancelled"]) {
    const ended = create(dir, requirementOf({ acceptance: TWO }), { status });
    assert.match(readyTask(dir, ended.id).problems[0], new RegExp(`任务已经结束（${status}）.*新建一个任务`));
    assert.equal(existsSync(ended.record), false);
  }
});

test("确认后改了需求要重新确认；没改时不写文件", (t) => {
  const dir = project(t);
  const task = create(dir, requirementOf({ acceptance: TWO }));
  assert.equal(readyTask(dir, task.id).kind, "ready");
  const confirmed = [readFileSync(task.file, "utf8"), readFileSync(task.record, "utf8")];

  assert.deepEqual(readyTask(dir, task.id), { kind: "alreadyReady", title: "任务" });
  assert.deepEqual([readFileSync(task.file, "utf8"), readFileSync(task.record, "utf8")], confirmed);

  // 正在某个环节里的任务：需求没变时不需要重新确认。
  const active = { ...read(task), frontmatter: { ...read(task).frontmatter, status: "active", stage: "implement" } };
  writeFileSync(task.file, renderTaskDocument(active));
  const refused = readyTask(dir, task.id);
  assert.equal(refused.kind, "refused");
  assert.match(refused.problems[0], /任务正在 implement 环节，需求没有变化，不需要重新确认/);

  // 改了需求：回到 ready、环节清空，摘要更新。
  const changed = requirementOf({ acceptance: `${TWO}${scenario("第三场景")}` });
  writeFileSync(task.file, renderTaskDocument({ ...active, requirement: changed }));
  assert.equal(currentStatus(read(task), record(task)), "draft");
  assert.deepEqual(readyTask(dir, task.id), { kind: "ready", title: "任务", scenarios: 3, assumed: 0 });
  const after = read(task);
  assert.equal(after.frontmatter.status, "ready");
  assert.equal(after.frontmatter.stage, null);
  assert.equal(after.requirement, changed);
  assert.equal(record(task).confirmedDigest, requirementDigest(after));
  assert.notEqual(record(task).confirmedDigest, JSON.parse(confirmed[1]).confirmedDigest);

  // 读入之后文件被别人改过：不覆盖，说明是哪个文件。
  const stored = findTask(dir, task.id);
  const edited = renderTaskDocument({ ...after, requirement: `${changed}\n\n别人加的一行` });
  writeFileSync(task.file, edited);
  const recordBefore = readFileSync(task.record, "utf8");
  const conflicts = saveTask(dir, stored, stored.document, { ...stored.record, confirmedDigest: null });
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /task\.md 在读入之后被改过/);
  assert.equal(readFileSync(task.file, "utf8"), edited);
  assert.equal(readFileSync(task.record, "utf8"), recordBefore);
});

const REQUIREMENT =
  "## 目标与范围\n\n交接只传需求部分。\n\n## 完成条件\n\n### Requirement: 交接\n#### Scenario: 只传需求\n- WHEN 派发\n- THEN 只有需求部分\n\n## 待澄清\n\n## 相关资料";

function closeFixture(dir, { ready = true, ...options } = {}) {
  const task = create(dir, REQUIREMENT, {}, options);
  if (ready) assert.equal(readyTask(dir, task.id).kind, "ready");
  return task;
}

const close = (dir, task, options = {}) => closeTask(dir, task.id, { result: "做完了", paths: [], ...options });
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
  const task = closeFixture(dir);
  const before = read(task);
  writeFileSync(task.record, renderTaskRecord({ ...record(task), changedPaths: ["next/src/c.ts", "next/src/a.ts"] }));

  assert.deepEqual(
    knit(dir, "task", "close", task.id, "--result", "  做完了  ", "--paths", "next/src/b.ts", "./next/src/a.ts", "--reason", "不用写"),
    { code: 0, stdout: `已完成 任务（${task.id}）\n`, stderr: "" },
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
  assert.equal(currentStatus(read(task), record(task)), "done");

  // 正在某个环节里的任务也可以完成；不给 --paths 时不登记。
  const active = closeFixture(dir, { slug: "active" });
  writeFileSync(
    active.file,
    renderTaskDocument({ ...read(active), frontmatter: { ...read(active).frontmatter, status: "active", stage: "implement" } }),
  );
  assert.equal(close(dir, active, { result: "做完了\n\n未验证：无。" }).kind, "done");
  assert.deepEqual(
    [read(active).frontmatter.status, read(active).frontmatter.stage, read(active).result, record(active).changedPaths],
    ["done", null, "做完了\n\n未验证：无。", []],
  );
});

test("done 任务仅补录路径，保留手工排版的结果并更新交付预览", (t) => {
  const dir = gitProject(t);
  const task = closeFixture(dir, { verification: "independent" });
  assert.equal(close(dir, task, { reason: "用户要求", paths: ["z.ts"] }).kind, "done");
  const markdown = readFileSync(task.file, "utf8").replace("status: done", 'status: "done"') + "\n\n";
  writeFileSync(task.file, markdown);
  writeFileSync(join(dir, "a.ts"), "a");
  const before = record(task);
  const updated = knit(dir, "task", "close", task.id, "--paths", "b.ts", "a.ts", "./a.ts");
  assert.deepEqual(updated, { code: 0, stdout: `已补录 任务（${task.id}）的改动路径：a.ts、b.ts\n`, stderr: "" });
  assert.equal(readFileSync(task.file, "utf8"), markdown);
  assert.deepEqual(record(task), { ...before, changedPaths: ["a.ts", "b.ts", "z.ts"] });
  const preview = deliverTask(dir, task.id, { preview: true });
  assert.equal(preview.kind, "preview");
  assert.deepEqual(preview.preview.commit.files.map((file) => file.path), ["a.ts"]);
  assert.deepEqual(preview.preview.commit.others, []);
});

test("补录路径仍受状态、确认摘要、未结束执行和参数约束", (t) => {
  const dir = project(t);
  const task = closeFixture(dir);
  const refuse = (options, message) => {
    const before = files(task);
    const result = closeTask(dir, task.id, options);
    assert.equal(result.kind, "refused");
    assert.match(result.problems.join("\n"), message);
    assert.deepEqual(files(task), before);
  };
  const paths = ["a.ts"];
  for (const status of ["ready", "active"]) {
    writeFileSync(task.file, renderTaskDocument({ ...read(task), frontmatter: { ...read(task).frontmatter, status, stage: status === "active" ? "implement" : null } }));
    refuse({ paths }, /--result 不能为空/);
  }
  assert.equal(close(dir, task).kind, "done");
  const done = read(task);
  for (const options of [{ paths: [] }, { paths, result: "" }, { paths, reason: "" }]) {
    refuse(options, /改总结直接编辑 task.md 的「结果」.*仅传 --paths/);
  }
  const before = files(task);
  const invalid = knit(dir, "task", "close", task.id, "--paths", "../outside", "/absolute");
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /相对路径：\.\.\/outside/);
  assert.match(invalid.stderr, /相对路径：\/absolute/);
  assert.deepEqual(files(task), before);
  refuse({ paths: [""] }, /项目内的相对路径/);
  for (const status of ["draft", "delivered", "cancelled"]) {
    writeFileSync(task.file, renderTaskDocument({ ...done, frontmatter: { ...done.frontmatter, status } }));
    refuse({ paths }, /需求还没有确认|任务已经结束/);
  }
  writeFileSync(task.file, renderTaskDocument({ ...done, requirement: `${done.requirement}\n\n新增需求` }));
  refuse({ paths }, /需求与确认记录不符/);
  writeFileSync(task.file, renderTaskDocument(done));
  writeFileSync(task.record, renderTaskRecord({ ...record(task), runs: [{ ...runOf("r-1", "implement", null), endedAt: null }] }));
  refuse({ paths }, /执行 r-1 还没有结束/);
});

test("不能完成时说明下一步，不写文件", (t) => {
  const dir = project(t);
  const draft = closeFixture(dir, { ready: false });
  const stale = closeFixture(dir, { slug: "stale" });
  writeFileSync(stale.file, renderTaskDocument({ ...read(stale), requirement: `${REQUIREMENT}\n\n- 确认后加的一条` }));
  for (const task of [draft, stale]) {
    const before = files(task);
    assert.deepEqual(close(dir, task), { kind: "refused", problems: [`需求还没有确认，或确认之后改过；先运行 knit task ready ${task.id}`] });
    assert.deepEqual(files(task), before);
  }

  const ready = closeFixture(dir, { slug: "ready" });
  const before = files(ready);
  for (const [options, expected] of [
    [{ result: "  " }, /^--result 不能为空/],
    [{ paths: ["next/a.ts", "/etc/passwd", "../outside.ts", "next/../../b.ts"] }, /相对路径：\/etc\/passwd\n.*\.\.\/outside\.ts\n.*next\/\.\.\/\.\.\/b\.ts$/],
  ]) {
    const result = close(dir, ready, options);
    assert.equal(result.kind, "refused");
    assert.match(result.problems.join("\n"), expected);
    assert.deepEqual(files(ready), before);
  }
  assert.match(close(dir, { id: "k-000000000000" }).problems[0], /没有任务/);
  assert.equal(close(dir, ready).kind, "done");
  const done = files(ready);
  assert.match(close(dir, ready).problems[0], /任务已经完成；要改总结直接编辑 task\.md 的「结果」/);
  assert.deepEqual(files(ready), done);
  for (const status of ["delivered", "cancelled"]) {
    writeFileSync(ready.file, renderTaskDocument({ ...read(ready), frontmatter: { ...read(ready).frontmatter, status } }));
    assert.match(close(dir, ready).problems[0], new RegExp(`任务已经结束（${status}）`));
  }
});

test("独立审查的任务要先审查通过，或给出直接完成的理由", (t) => {
  const dir = project(t);
  const task = closeFixture(dir, { verification: "independent" });
  const before = files(task);
  const refused = close(dir, task);
  assert.equal(refused.kind, "refused");
  assert.match(refused.problems[0], /独立审查的任务要在审查通过后才能完成.*--reason <理由>/);
  assert.deepEqual(files(task), before);

  // 最后一条带结论的执行不是 pass：仍然拒绝。
  const withRuns = (target, ...runs) => {
    const requirementDigest = record(target).confirmedDigest;
    writeFileSync(target.record, renderTaskRecord({ ...record(target), runs: runs.map((run) => ({ ...run, requirementDigest })) }));
  };
  withRuns(task, runOf("r-1", "review", "pass"), runOf("r-2", "review", "changes_requested"), runOf("r-3", "implement", null));
  assert.equal(close(dir, task).kind, "refused");

  assert.equal(close(dir, task, { reason: "用户要求" }).kind, "done");
  assert.equal(read(task).result, "做完了\n\n没有经过独立审查，直接完成：用户要求");
  assert.equal(read(task).frontmatter.status, "done");

  // 审查通过之后不需要理由，给了也不写进结果。
  const reviewed = closeFixture(dir, { verification: "independent", slug: "reviewed" });
  withRuns(reviewed, runOf("r-1", "review", "changes_requested"), runOf("r-2", "review", "pass"), runOf("r-3", "implement", null));
  assert.equal(close(dir, reviewed, { reason: "用户要求" }).kind, "done");
  assert.equal(read(reviewed).result, "做完了");
});

const MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

const cancelDraft = (dir, options) => draft(dir, { title: "取消任务", ...options });
const cancel = (dir, task, reason = "不做了") => cancelTask(dir, task.id, { reason });
const readDirectory = (dir, taskDir) => parseTaskDocument(readFileSync(join(dir, taskDir, "task.md"), "utf8")).document;
/** `.knit` 下每个文件的路径和内容摘要，排好序：前后两次一样，就是文件和目录都没有变。 */
const tree = (dir) =>
  readdirSync(join(dir, ".knit"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${relative(dir, file)}`)
    .sort();

test("取消并归档：目录移到当月的归档目录，状态 cancelled，写下原因", (t) => {
  const dir = project(t);
  const task = cancelDraft(dir, { slug: "drop" });
  const child = cancelDraft(dir, { slug: "child", parent: task.id });
  const before = readDirectory(dir, task.dir);
  const archivedDir = `.knit/tasks/archive/${MONTH}/${task.dir.split("/").at(-1)}`;

  assert.deepEqual(knit(dir, "task", "cancel", task.id, "--reason", " 不做了 "), {
    code: 0,
    stdout: `已取消 取消任务（${task.id}）\n${archivedDir}\n`,
    stderr: "",
  });
  assert.equal(existsSync(join(dir, task.dir)), false);
  assert.deepEqual(readDirectory(dir, archivedDir), {
    frontmatter: { ...before.frontmatter, status: "cancelled" },
    requirement: before.requirement,
    result: "已取消：不做了",
  });
  // 取消没有内容要记，不会多出一个空的 record.json。
  assert.deepEqual(readdirSync(join(dir, archivedDir)), ["task.md"]);

  // 子任务不跟着取消。
  const tasks = scanTasks(dir);
  assert.deepEqual(tasks.filter((item) => !item.archived).map((item) => item.id), [child.id]);
  assert.deepEqual(tasks.filter((item) => item.archived).map((item) => [item.id, item.dir]), [[task.id, archivedDir]]);

  // 已完成、有结果的任务：原因接在原来的结果后面；正在环节里的任务取消后环节清空。
  const done = cancelDraft(dir, { slug: "done" });
  writeFileSync(
    join(dir, done.dir, "task.md"),
    renderTaskDocument({ ...readDirectory(dir, done.dir), frontmatter: { ...readDirectory(dir, done.dir).frontmatter, status: "active", stage: "review" }, result: "做了一半。" }),
  );
  assert.equal(cancel(dir, done, "方向变了").kind, "cancelled");
  const cancelled = readDirectory(dir, `.knit/tasks/archive/${MONTH}/${done.dir.split("/").at(-1)}`);
  assert.deepEqual(
    [cancelled.frontmatter.status, cancelled.frontmatter.stage, cancelled.result],
    ["cancelled", null, "做了一半。\n\n已取消：方向变了"],
  );
});

test("已经结束的任务不能取消，文件和目录都不变", (t) => {
  const dir = project(t);
  const task = cancelDraft(dir);
  const open = cancelDraft(dir, { slug: "open" });
  assert.equal(cancel(dir, task).kind, "cancelled");
  const before = tree(dir);
  assert.deepEqual(cancel(dir, task), { kind: "refused", problems: ["任务已经结束（cancelled），不能取消"] });
  assert.deepEqual(cancel(dir, open, "  "), { kind: "refused", problems: ["--reason 不能为空：写为什么不做了"] });
  assert.equal(cancel(dir, { id: "k-000000000000" }).kind, "refused");
  assert.deepEqual(tree(dir), before);

  const delivered = readDirectory(dir, open.dir);
  writeFileSync(join(dir, open.dir, "task.md"), renderTaskDocument({ ...delivered, frontmatter: { ...delivered.frontmatter, status: "delivered" } }));
  const after = tree(dir);
  assert.match(cancel(dir, open).problems[0], /任务已经结束（delivered）/);
  assert.deepEqual(tree(dir), after);
});

const EMPTY_RECORD = { confirmedDigest: null, changedPaths: [], runs: [], authorization: null };

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

  const second = draft(dir, { title: "乙", slug: "b" });
  const first = draft(dir, { title: "甲", slug: "a", priority: "P0" });
  const third = draft(dir, { title: "丙", slug: "c" });
  const archived = draft(dir, { title: "旧的", slug: "old" });
  assert.equal(readyTask(dir, first.id).kind, "ready");
  rewrite(dir, first, (document) => ({ ...document, requirement: `${document.requirement}\n\n- 新加的一条` }));
  rewrite(dir, second, withFrontmatter({ status: "active", stage: "implement" }), (document) => ({
    ...EMPTY_RECORD,
    confirmedDigest: requirementDigest(document),
  }));
  rewrite(dir, archived, withFrontmatter({ status: "delivered" }));
  const archivedMonths = ["2026-10", "2026-09", "2026-12"];
  archivedMonths.forEach((month) => mkdirSync(join(dir, ".knit/tasks/archive", month), { recursive: true }));
  const archiveDoc = read(archived);
  const newest = ".knit/tasks/archive/2026-12/newest";
  const important = ".knit/tasks/archive/2026-09/important";
  const archivedBroken = ".knit/tasks/archive/2026-09/broken";
  for (const [archiveDir, id, priority, createdAt] of [
    [newest, "k-aaaaaaaaaaaa", "P2", "2030-01-02T00:00:00Z"],
    [important, "k-bbbbbbbbbbbb", "P1", "2030-01-04T00:00:00Z"],
    [archivedBroken, "k-cccccccccccc", "PX", "2030-01-01T00:00:00Z"],
  ]) {
    mkdirSync(join(dir, archiveDir));
    writeFileSync(join(dir, archiveDir, "task.md"), renderTaskDocument(withFrontmatter({ id, priority, createdAt })(archiveDoc)));
  }
  rewrite(dir, archived, withFrontmatter({ createdAt: "2030-01-01T00:00:00Z" }));
  renameSync(join(dir, archived.dir), join(dir, ".knit/tasks/archive/2026-10/10-01-old"));
  mkdirSync(join(dir, ".knit/tasks/00-broken"));
  writeFileSync(join(dir, ".knit/tasks/00-broken/task.md"), "只有正文\n");
  writeFileSync(join(dir, third.dir, "record.json"), "{");

  const all = scanTasks(dir, "all");
  assert.deepEqual(scanTasks(dir), all);

  // 若碰到另一组的 task.md，读取目录会报错，而不是安静地被输出过滤掉。
  const archiveTrap = join(dir, ".knit/tasks/archive/2026-09/unread/task.md");
  mkdirSync(archiveTrap, { recursive: true });
  assert.deepEqual(scanTasks(dir, "active"), all.filter((task) => !task.archived));
  const listed = knit(dir, "task", "list");
  assert.equal(listed.code, 0, listed.stderr);
  const lines = listed.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 2), [`P0  ${first.id}  draft  甲（确认后改过需求）`, `P2  ${second.id}  active(implement)  乙`]);
  assert.match(lines[2], /^\.knit\/tasks\/00-broken：task\.md：没有开头字段/);
  assert.match(lines[3], new RegExp(`^${third.dir}：record\\.json：不是合法的 JSON`));
  assert.equal(lines.length, 4);

  rmdirSync(archiveTrap);
  mkdirSync(join(dir, ".knit/tasks/unread/task.md"), { recursive: true });
  assert.deepEqual(scanTasks(dir, "archived"), all.filter((task) => task.archived));
  const listedArchive = knit(dir, "task", "list", "--archive");
  assert.equal(listedArchive.code, 0, listedArchive.stderr);
  const [importantLine, olderLine, newestLine, brokenLine, ...rest] = listedArchive.stdout.trimEnd().split("\n");
  assert.deepEqual([importantLine, olderLine, newestLine], [
    "P1  k-bbbbbbbbbbbb  delivered  旧的", `P2  ${archived.id}  delivered  旧的`, "P2  k-aaaaaaaaaaaa  delivered  旧的",
  ]);
  assert.ok(brokenLine.startsWith(`${archivedBroken}：task.md：字段 priority 的值不对：`), brokenLine);
  assert.deepEqual(rest, []);
});

test("task list：子任务逐层排序，只标出未满足的依赖和未合并的非活跃分支", (t) => {
  const dir = gitProject(t);
  const old = draft(dir, { slug: "delivered" });
  const dropped = draft(dir, { slug: "cancelled" });
  const parent = draft(dir, { title: "父任务" });
  const later = draft(dir, { title: "低优先级子任务", parent: parent.id });
  const child = draft(dir, { title: "高优先级子任务", parent: parent.id, priority: "P0" });
  const grandchild = draft(dir, { title: "孙任务", parent: child.id, dependsOn: [later.id, dropped.id, old.id] });
  const orphan = draft(dir, { title: "父任务已归档", parent: old.id, priority: "P1" });
  assert.equal(cancel(dir, dropped).kind, "cancelled");
  rewrite(dir, old, withFrontmatter({ status: "delivered" }));
  renameSync(join(dir, old.dir), join(dir, ".knit/tasks/archive", MONTH, basename(old.dir)));

  const branch = `knit/${basename(old.dir)}`;
  const tip = git(dir, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "交付");
  for (const name of [branch, `knit/${basename(child.dir)}`, "other"]) git(dir, "branch", name, tip);
  git(dir, "branch", "knit/already-merged", "HEAD");
  const lines = [
    `P1  ${orphan.id}  draft  父任务已归档  父:${old.id}`,
    `P2  ${parent.id}  draft  父任务`,
    `  P0  ${child.id}  draft  高优先级子任务`,
    `    P2  ${grandchild.id}  draft  孙任务  阻塞:${later.id}, ${dropped.id}`,
    `  P2  ${later.id}  draft  低优先级子任务`,
  ];
  const before = [...lines];
  before[3] += `, ${old.id}`;
  const listed = knit(dir, "task", "list");
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trimEnd().split("\n"), [...before, "", "尚未合并进 HEAD 的任务分支，可在当前检出运行：", `  git merge '${branch}'`]);
  git(dir, "merge", "--ff-only", branch);
  assert.deepEqual(knit(dir, "task", "list"), { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" });
});

test("task list：逐个识别批次成员进程，流程损坏或缺失时仍能查看运行态", (t) => {
  const dir = runProject(t);
  const running = draft(dir, { title: "执行中" });
  const waiting = draft(dir, { title: "等待汇总" });
  const members = ["first", "second"].map((executor) => ({ ...runOf(`r-${executor}`, "review", "pass"),
    agent: "pi", batchId: "b-review", executor, resumeId: null }));
  for (const task of [running, waiting]) {
    rewrite(dir, task, withFrontmatter({ status: "active", stage: "review", verification: "independent" }), (doc) => ({
      ...EMPTY_RECORD, confirmedDigest: requirementDigest(doc), runs: members.map((member) => ({
        ...member, id: `${member.id}-${task.id}`, requirementDigest: requirementDigest(doc),
        ...(task === running ? { startedAt: new Date(Date.now() - 180000).toISOString(), endedAt: null, verdict: null }
          : { verdict: member.executor === "first" ? "pass" : "changes_requested" }),
      })),
    }));
  }
  for (const member of record(running).runs) {
    const runDir = join(dir, RUNS_DIR, member.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "worker.json"), JSON.stringify({ pid: process.pid,
      start: member.executor === "first" ? procStartTicks(process.pid) : "another-process" }));
  }
  const expected = `P2  ${running.id}  active(review)  执行中  first:运行中 3m  second:进程已退出\nP2  ${waiting.id}  active(review)  等待汇总`;
  assert.deepEqual(knit(dir, "task", "list"), { code: 0, stdout: `${expected}  待裁决\n`, stderr: "" });
  const workflow = join(dir, ".knit/workflow.yaml");
  writeFileSync(workflow, "stages: [");
  assert.deepEqual(knit(dir, "task", "list"), { code: 0, stdout: `${expected}\n`, stderr: "" });
  rmSync(workflow);
  assert.deepEqual(knit(dir, "task", "list"), { code: 0, stdout: `${expected}\n`, stderr: "" });
});

test("按 ID 查找跳过无关归档的记录与 YAML，同时保留损坏任务和手写 ID 的查找语义", (t) => {
  const root = project(t);
  const active = draft(root);
  const [broken, normal, quoted, alias, , , unread] = writeArchiveHistory(root, read(active));
  const editArchive = (dir, change) => {
    const file = join(dir, "task.md");
    writeFileSync(file, change(readFileSync(file, "utf8")));
  };
  editArchive(quoted, (text) => text.replace(`id: ${basename(quoted)}`, `"id": "${basename(quoted)}" # 手写 ID`));
  const aliasId = "k-ffffffffffff";
  editArchive(alias, (text) => text.replace("title: 任务", `title: &key id\n*key : ${aliasId}`));
  const expected = new Map(scanTasks(root).map((task) => [task.id, task]));
  // 仍是正常输出的顶层键；完整解读这份 YAML 会遇到未定义锚点。
  editArchive(unread, (text) => text.replace("title: 任务", "title: *missing"));
  const unreadRecord = join(unread, "record.json");
  rmSync(unreadRecord);
  mkdirSync(unreadRecord);

  for (const id of [active.id, basename(broken), basename(normal), basename(quoted), aliasId]) {
    assert.equal(expected.has(id), true, id);
    assert.deepEqual(findTask(root, id), expected.get(id));
  }
  assert.equal(findTask(root, basename(alias)), null);
  assert.equal(findTask(root, "k-000000000000"), null);
  const shown = knit(root, "task", "show", basename(broken));
  assert.equal(shown.code, 1);
  assert.match(shown.stderr, /^task\.md：开头字段不是合法的 YAML：/);
});

test("task show：标题、状态、场景数、待澄清数和改动文件", (t) => {
  const dir = project(t);
  const parent = draft(dir, { title: "上级", slug: "parent" });
  const task = draft(dir, { title: "交接只传需求部分", slug: "handoff", parent: parent.id, dependsOn: [parent.id] });
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
          failure: null,
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
  assert.equal(readyTask(dir, parent.id).kind, "ready");
  rewrite(dir, parent, (document) => ({ ...document, requirement: "## 完成条件\n### Requirement: 空的" }));
  const bare = knit(dir, "task", "show", parent.id).stdout;
  assert.match(bare, /^状态: draft（确认后改过需求，需要重新 task ready）$/m);
  assert.match(bare, /^父任务: 无\n依赖: 无\n/m);
  assert.match(bare, /^完成条件: 0 个场景，1 处写法问题\n待澄清: 0 项 blocking，0 项 assumed\n$/m);
  assert.equal(bare.includes("改动文件"), false);

  // 已归档的也能查到。
  mkdirSync(join(dir, ".knit/tasks/archive/2026-10"), { recursive: true });
  renameSync(join(dir, parent.dir), join(dir, ".knit/tasks/archive/2026-10/10-01-parent"));
  assert.match(knit(dir, "task", "show", parent.id).stdout, /^目录: \.knit\/tasks\/archive\/2026-10\/10-01-parent$/m);

  assert.deepEqual(readTask(dir, "k-000000000000"), { kind: "refused", problems: ["没有任务 k-000000000000；用 knit task list 查看现有任务"] });
  writeFileSync(join(dir, task.dir, "record.json"), JSON.stringify({ ...EMPTY_RECORD, owner: "me" }));
  assert.deepEqual(readTask(dir, task.id), { kind: "refused", problems: ["record.json：多了字段 owner"] });
});

test("task.md 写坏了：按 id 的命令说出哪里坏了", (t) => {
  const dir = project(t);
  const task = draft(dir, { title: "写坏的", slug: "broken" });
  const file = join(dir, task.dir, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("priority: P2", "priority: PX"));

  for (const command of [["task", "show"], ["context"], ["run", "status"]]) {
    const result = knit(dir, ...command, task.id);
    assert.equal(result.code, 1, command.join(" "));
    assert.equal(result.stdout, "", command.join(" "));
    assert.match(result.stderr, /^task\.md：字段 priority 的值不对：.*\n$/, command.join(" "));
    assert.equal(result.stderr.includes("没有任务"), false, command.join(" "));
  }
});

test("改过的需求回退 draft，同项目未改的任务仍是 ready", (t) => {
  const dir = project(t);
  const task = draft(dir, { title: "改过需求" });
  const kept = draft(dir, { title: "没改需求", slug: "kept" });
  const confirmed = (document) => ({ ...EMPTY_RECORD, confirmedDigest: requirementDigest(document) });
  rewrite(dir, task, withFrontmatter({ status: "ready" }), confirmed);
  rewrite(dir, kept, withFrontmatter({ status: "ready" }), confirmed);
  const status = (task) => { const stored = findTask(dir, task.id); return currentStatus(stored.document, stored.record); };
  assert.equal(status(task), "ready");
  rewrite(dir, task, (document) => ({ ...document, requirement: `${document.requirement}\n\n- 新加的一条` }));
  assert.equal(status(task), "draft");
  assert.equal(status(kept), "ready");
});

const REFUSED = "独立审查的任务要在审查通过后才能完成；用户明确要求直接完成时，加 --reason <理由>\n";
const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const filesOf = (dir, task) => ["task.md", "record.json"].map((name) => readFileSync(join(dir, task.dir, name), "utf8"));

function prepare(dir, task) {
  const { run, problems } = prepareRun({
    root: dir,
    taskId: task.id,
    workflow: workflowOf(dir),
    config: loadConfig(dir).config,
    model: null,
  });
  assert.deepEqual(problems, []);
  return run;
}
function finish(dir, task, run, { verdict = null, failure = null } = {}) {
  const problems = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure,
    sessionFile: null,
  });
  assert.deepEqual(problems, []);
}
/** 实现正常结束，审查结论 pass。 */
function reviewed(dir, task) {
  finish(dir, task, prepare(dir, task));
  const review = prepare(dir, task);
  assert.equal(review.stage.id, "review");
  finish(dir, task, review, { verdict: "pass" });
}

test("有执行没结束时不能完成或取消", (t) => {
  const dir = runProject(t);
  const task = closeFixture(dir);
  const run = prepare(dir, task);
  const before = filesOf(dir, task);
  const refusal = { kind: "refused", problems: [`任务 ${task.id} 的执行 ${run.id} 还没有结束；等它结束，或运行 knit run cancel ${task.id}`] };
  assert.deepEqual(close(dir, task), refusal);
  assert.deepEqual(cancel(dir, task), refusal);
  assert.deepEqual(filesOf(dir, task), before);
  assert.equal(existsSync(join(dir, ".knit/tasks/archive")), false);
  finish(dir, task, run);
  assert.equal(close(dir, task).kind, "done");
});

test("需求改过之后以前的审查通过不算", (t) => {
  const dir = runProject(t);

  const changed = closeFixture(dir, { verification: "independent" });
  reviewed(dir, changed);
  const file = join(dir, changed.dir, "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(REQUIREMENT, `${REQUIREMENT}\n\n- 改过的需求`));
  assert.equal(readyTask(dir, changed.id).kind, "ready");
  const before = filesOf(dir, changed);
  const refused = close(dir, changed);
  assert.deepEqual(refused, { kind: "refused", problems: [REFUSED.trimEnd()] });
  assert.deepEqual(filesOf(dir, changed), before);

  const unchanged = closeFixture(dir, { verification: "independent" });
  reviewed(dir, unchanged);
  const done = close(dir, unchanged);
  assert.equal(done.kind, "done");

  // 最后一次审查是失败的执行，再往前一次是 pass。
  const failedLater = closeFixture(dir, { verification: "independent" });
  reviewed(dir, failedLater);
  const record = join(dir, failedLater.dir, "record.json");
  const stored = JSON.parse(readFileSync(record, "utf8"));
  const failed = { ...stored.runs.at(-1), id: "r-000000000000", verdict: null, failure: "执行者中途退出" };
  writeFileSync(record, `${JSON.stringify({ ...stored, runs: [...stored.runs, failed] }, null, 2)}\n`);
  const closed = close(dir, failedLater);
  assert.equal(closed.kind, "done");
});

test("在 Git 仓库里交付过的任务显示提交", (t) => {
  const dir = gitProject(t);
  const task = doneTask(dir);
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: 加问候语\n\n说明一行\n");
  assert.equal(deliverTask(dir, task.id, { authorization: "user:1a2b3c4d", messageFile: message }).kind, "delivered");
  // 之后别的提交不影响查到的是哪一次。
  const commit = git(dir, "log", "-1", "--format=%h");
  writeFileSync(join(dir, "later.txt"), "later\n");
  git(dir, "add", "later.txt");
  git(dir, "commit", "-q", "-m", "later");

  assert.equal(taskCommit(readTask(dir, task.id).task), `${commit} feat: 加问候语`);
});

test("没有提交可以显示时没有这一行", (t) => {
  const plain = project(t);
  const delivered = doneTask(plain);
  assert.equal(deliverTask(plain, delivered.id, { authorization: "user:1a2b3c4d" }).kind, "delivered");
  const repository = gitProject(t);
  const done = doneTask(repository);

  assert.equal(taskCommit(readTask(plain, delivered.id).task), null);
  assert.equal(taskCommit(readTask(repository, done.id).task), null);
});
