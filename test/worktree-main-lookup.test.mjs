import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { TaskService, locateTaskDocument } from "../dist/application/task-service.js";
import { StatusService } from "../dist/application/status-service.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { SessionService, SELECTION_ENTRY_TYPE } from "../dist/application/session-service.js";
import { buildSessionContext } from "../dist/application/session-context.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { WorktreePrepareService } from "../dist/application/worktree-prepare.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
async function fixture({ ready = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knit-main-lookup-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  cpSync(join(import.meta.dirname, "..", "assets", "templates", ".knit"), join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n");
  writeFileSync(join(dir, "README.md"), "baseline\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "fixture"]);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks });
  const ordinary = await tasks.newTask({ dir, title: "ordinary", priority: "P2" });
  const task = await tasks.newTask({ dir, title: "routed", priority: "P1", branch: "refs/heads/main", verification: "self" });
  if (ready) await tasks.ready({ dir, taskId: task.taskId });
  const oldDir = locateTaskDocument(dir, task.taskId).dir;
  const oldBody = readFileSync(join(oldDir, "task.md"));
  const created = await new WorktreeService({ store, locks }).create({ dir, taskId: task.taskId });
  const handed = await new WorktreeHandoffService({ store, runs: new RunStore(dir) }).handoff({ dir, taskId: task.taskId });
  await new WorktreePrepareService({ store }).prepare({ dir, taskId: task.taskId });
  const wt = created.worktree.path;
  return { dir, wt, task, ordinary, oldDir, oldBody, taskDir: handed.targetTaskDir, store, locks, tasks,
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function cli(dir, args, input) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], { encoding: "utf8", input });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
}
function nativeFile(f) {
  const file = join(f.dir, ".knit", ".runtime", "main.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "lookup-main", cwd: f.dir, timestamp: "2026-11-14T00:00:00.000Z" }) + "\n");
  return file;
}
function appendSelection(file, id, parentId, taskId) {
  writeFileSync(file, JSON.stringify({ type: "custom", customType: SELECTION_ENTRY_TYPE, id, parentId, timestamp: "2026-11-14T00:00:01.000Z", data: { taskId, branch: "refs/heads/main", operationId: id } }) + "\n", { flag: "a" });
}

test("R1.S1–S3 / R4.S1: 主检出与 Worktree 按绑定读取最新任务，排序去重及写入落点一致", async () => {
  const f = await fixture();
  try {
    // 保留迁出前副本；目标改名后仍以 taskId 识别。
    mkdirSync(f.oldDir, { recursive: true });
    writeFileSync(join(f.oldDir, "task.md"), f.oldBody);
    await f.tasks.rename({ dir: f.dir, taskId: f.task.taskId, newSlug: "latest", equivalent: true });
    const target = locateTaskDocument(f.dir, f.task.taskId, f.store.bindings.listSync()).dir;
    assert.notEqual(basename(target), basename(f.oldDir));
    const file = join(target, "task.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("title: routed", "title: latest-worktree"));
    for (const path of ["plan.md", "design.md", "research/route.md"]) {
      cli(f.dir, ["task", "material", "save", f.task.taskId, path], `# actual ${path}\n`);
      assert.deepEqual(await f.tasks.readMaterial({ dir: f.dir, taskId: f.task.taskId, path }), await f.tasks.readMaterial({ dir: f.wt, taskId: f.task.taskId, path }));
    }
    const list = cli(f.dir, ["task", "list"]);
    assert.deepEqual(list.active.map((t) => t.taskId), [f.task.taskId, f.ordinary.taskId]);
    assert.equal(list.active[0].title, "latest-worktree");
    assert.equal(realpathSync(join(f.dir, ".knit", list.active[0].relativePath)), target);
    assert.deepEqual(cli(f.dir, ["task", "list", "--archive"]).archived, []);
    const main = cli(f.dir, ["status", f.task.taskId]);
    const worktree = cli(f.wt, ["status", f.task.taskId]);
    assert.deepEqual(main, worktree);
    assert.equal(main.branch, (await f.store.bindings.get(f.task.taskId)).worktree.branch);
    assert.equal(main.stage, "implement");
    assert.equal(main.title, "latest-worktree");
    await f.tasks.record({ dir: f.dir, taskId: f.task.taskId, body: "actual routed record" });
    assert.match(readFileSync(file, "utf8"), /actual routed record/);
    assert.deepEqual(readFileSync(join(f.oldDir, "task.md")), f.oldBody);
    await f.tasks.update({ dir: f.dir, taskId: f.task.taskId, kind: "clarify", content: "# Latest inputs\n\n## 完成条件\n\n- verified\n" });
    await assert.rejects(f.tasks.ready({ dir: f.dir, taskId: f.task.taskId }), (error) => error.guardReason === "phase_mismatch");
    assert.match(readFileSync(file, "utf8"), /Latest inputs/);
    assert.equal((await f.tasks.readInputs({ dir: f.wt, taskId: f.task.taskId })).inputsDigest, (await f.tasks.readInputs({ dir: f.dir, taskId: f.task.taskId })).inputsDigest);
    assert.equal(existsSync(join(f.wt, ".knit", ".runtime")), false);
  } finally { f.cleanup(); }
});

test("R2.S1–S3 / R3.S2 / R4.S2: 原主 Session 原生 use/reload/context/clear；规则隔离和分支失效", async () => {
  const f = await fixture();
  try {
    for (const path of ["plan.md", "design.md", "research/route.md"]) await f.tasks.saveMaterial({ dir: f.dir, taskId: f.task.taskId, path, content: `# execution ${path}\n` });
    writeFileSync(join(f.dir, ".knit", "standards", "index.md"), "# main-uncommitted-only\n");
    writeFileSync(join(f.wt, ".knit", "standards", "index.md"), "# execution-rule-only\n");
    const workflow = join(f.wt, ".knit", "workflow.yaml");
    writeFileSync(workflow, readFileSync(workflow, "utf8").replace("name: 实现", "name: 执行检出阶段"));
    writeFileSync(join(f.wt, ".knit", "agents", "implement.md"), "# execution-stage-prompt-only\n");
    writeFileSync(join(f.dir, ".knit", "agents", "implement.md"), "# main-stage-prompt-only\n");
    const file = nativeFile(f);
    const sessions = new SessionService({ store: f.store, locks: f.locks });
    const attached = await sessions.attach({ dir: f.dir, nativeSessionId: "lookup-main", sessionFile: file, kind: "main", role: "implement" });
    const id = attached.record.knitSessionId;
    const pending = cli(f.dir, ["task", "use", f.task.taskId, "--session", id]);
    assert.equal(pending.selection.persisted, false);
    assert.equal((await sessions.resolveSelection(f.dir, id)).effective, false);
    appendSelection(file, "use-1", null, f.task.taskId);
    cli(f.dir, ["task", "use", f.task.taskId, "--session", id, "--persisted", "--entry", "use-1", "--operation-id", "use-1"]);
    const reload = await new SessionService({ store: f.store, locks: f.locks }).attach({ dir: f.dir, nativeSessionId: "lookup-main", sessionFile: file, kind: "main", role: "implement" });
    assert.equal(reload.record.cwd, f.dir);
    assert.equal(reload.record.knitSessionId, id);
    const context = cli(f.dir, ["session", "context", id]);
    assert.equal(context.taskId, f.task.taskId);
    assert.equal(context.task.stageName, "执行检出阶段");
    assert.equal(context.branch, "refs/heads/main");
    assert.equal(context.task.branch, (await f.store.bindings.get(f.task.taskId)).worktree.branch);
    assert.deepEqual(context.materials.map((m) => m.path).sort(), ["design.md", "plan.md", "research/route.md"]);
    const plan = cli(f.dir, ["context", "--task", f.task.taskId, "--stage", "implement"]);
    const contents = plan.sections.filter((s) => s.path !== null).map((s) => {
      const content = readFileSync(join(f.dir, s.path), "utf8");
      // 任务输入与 research 会转换后计算摘要；正式规则使用原始字节。
      if (s.kind === "standard") assert.equal(s.digest, createHash("sha256").update(content).digest("hex"));
      return content;
    }).join("\n");
    assert.ok(contents.includes("execution-rule-only"));
    assert.ok(!contents.includes("main-uncommitted-only"));
    assert.ok(contents.includes("execution-stage-prompt-only"));
    assert.ok(!contents.includes("main-stage-prompt-only"));
    writeFileSync(join(f.wt, "README.md"), "worktree implementation\n");
    cli(f.dir, ["task", "implement", f.task.taskId, "--path", "README.md", "--validation", "isolated verification"]);
    const mainStatus = cli(f.dir, ["status", f.task.taskId]);
    assert.equal(mainStatus.scopeCount, 1);
    assert.deepEqual(mainStatus, cli(f.wt, ["status", f.task.taskId]));
    for (const path of ["plan.md", "design.md", "research/route.md"]) assert.ok(contents.includes(`execution ${path}`));
    const snapshots = () => ({ head: git(f.dir, ["rev-parse", "HEAD"]), index: readFileSync(join(f.dir, ".git", "index")), task: readFileSync(join(f.taskDir, "task.md")), binding: f.store.bindings.listSync(), session: readFileSync(file), scope: new RunStore(f.dir).readScope(f.task.taskId), completion: new RunStore(f.dir).readCompletionIfIntact(f.task.taskId), implementation: new RunStore(f.dir).readImplementation(f.task.taskId), runs: new RunStore(f.dir).listRunIds() });
    const before = snapshots();
    const sessionBefore = await f.store.sessions.getByKnitId(id);
    assert.ok(sessionBefore, "主会话记录必须真实存在，才能核对只读查询无副作用");
    assert.equal(sessionBefore.knitSessionId, id);
    for (let n = 0; n < 2; n++) {
      f.tasks.list({ dir: f.dir });
      await new StatusService({ store: f.store }).taskStatus(f.dir, f.task.taskId);
      await new ContextPlanner({ store: f.store }).plan({ dir: f.dir, taskId: f.task.taskId });
      await buildSessionContext({ store: f.store, dir: f.dir, knitSessionId: id });
    }
    assert.deepEqual(snapshots(), before);
    assert.deepEqual(await f.store.sessions.getByKnitId(id), sessionBefore);
    git(f.dir, ["switch", "-qc", "other-main"]);
    assert.equal((await sessions.resolveSelection(f.dir, id)).reason, "branch_changed");
    git(f.dir, ["switch", "-q", "main"]);
    appendSelection(file, "clear-1", "use-1", null);
    cli(f.dir, ["task", "clear", "--session", id, "--persisted", "--entry", "clear-1", "--operation-id", "clear-1"]);
    assert.equal(cli(f.dir, ["session", "context", id]).taskId, null);
    assert.equal((await sessions.resolveSelection(f.dir, id)).taskId, null);
    assert.equal(existsSync(join(f.wt, ".knit", ".runtime")), false);
  } finally { f.cleanup(); }
});

for (const fromMain of [true, false]) test(`R4.S1: ${fromMain ? "主检出" : "Worktree"} ready 读取实际规范且不新建运行资料`, async () => {
  const f = await fixture({ ready: false });
  try {
    writeFileSync(join(f.wt, ".knit", "standards", "index.md"), "# ready execution standards\n");
    const result = await f.tasks.ready({ dir: fromMain ? f.dir : f.wt, taskId: f.task.taskId });
    assert.equal(result.stage, "implement");
    const plan = await new ContextPlanner({ store: f.store }).plan({ dir: f.dir, taskId: f.task.taskId });
    assert.equal(result.confirmedStandardsDigest, plan.standardsDigest);
    assert.equal(locateTaskDocument(f.wt, f.task.taskId).document.frontmatter.stage, "implement");
    assert.equal(existsSync(join(f.wt, ".knit", ".runtime")), false);
  } finally { f.cleanup(); }
});

test("R5.S1: 原始故障路径分别覆盖 list/status/use/context", async (t) => {
  const f = await fixture();
  try {
    await t.test("list", () => assert.equal(f.tasks.list({ dir: f.dir }).active.filter((task) => task.taskId === f.task.taskId).length, 1));
    await t.test("status", async () => assert.equal((await new StatusService({ store: f.store }).taskStatus(f.dir, f.task.taskId)).taskId, f.task.taskId));
    await t.test("context", async () => assert.equal((await new ContextPlanner({ store: f.store }).plan({ dir: f.dir, taskId: f.task.taskId })).ready, true));
    await t.test("use", async () => {
      const sessions = new SessionService({ store: f.store, locks: f.locks });
      const attached = await sessions.attach({ dir: f.dir, nativeSessionId: "lookup-main", sessionFile: nativeFile(f), kind: "main", role: "implement" });
      const result = await sessions.useTask({ dir: f.dir, knitSessionId: attached.record.knitSessionId, taskId: f.task.taskId, persisted: false });
      assert.equal(result.selection.taskId, f.task.taskId);
    });
  } finally { f.cleanup(); }
});

for (const fault of ["missing", "unregistered", "branch", "ownership", "git-ownership", "duplicate", "identity"]) test(`R3.S1 / R1.S3: ${fault} 登记明确拒绝且不回退旧副本`, async () => {
  const f = await fixture();
  try {
    mkdirSync(f.oldDir, { recursive: true });
    writeFileSync(join(f.oldDir, "task.md"), f.oldBody);
    const binding = await f.store.bindings.get(f.task.taskId);
    if (fault === "missing") rmSync(f.wt, { recursive: true, force: true });
    if (fault === "unregistered") {
      const target = join(f.dir, "not-registered");
      mkdirSync(target);
      binding.worktree.path = target;
      await f.store.bindings.save(binding);
    }
    if (fault === "branch") git(f.wt, ["switch", "-qc", "wrong-branch"]);
    if (fault === "ownership") { binding.repoRoot = join(f.dir, "other-project"); await f.store.bindings.save(binding); }
    if (fault === "git-ownership") {
      const other = join(f.dir, "foreign-repository");
      mkdirSync(other);
      git(other, ["init", "-q", "-b", "foreign"]);
      writeFileSync(join(f.wt, ".git"), `gitdir: ${join(other, ".git")}\n`);
    }
    if (fault === "duplicate") cpSync(f.taskDir, join(f.wt, ".knit", "tasks", "duplicate"), { recursive: true });
    if (fault === "identity") writeFileSync(join(f.taskDir, "task.md"), readFileSync(join(f.taskDir, "task.md"), "utf8").replace(f.task.taskId, "k-000000000000"));
    const expectedPath = binding.worktree.path;
    const check = (error) => /登记路径/.test(error.message) && error.message.includes(expectedPath) && !/任务不存在/.test(error.message);
    assert.throws(() => f.tasks.list({ dir: f.dir }), check);
    assert.deepEqual(cli(f.dir, ["task", "list", "--archive"]).archived, []);
    await assert.rejects(new StatusService({ store: f.store }).taskStatus(f.dir, f.task.taskId), check);
    await assert.rejects(new ContextPlanner({ store: f.store }).plan({ dir: f.dir, taskId: f.task.taskId }), check);
    const sessions = new SessionService({ store: f.store, locks: f.locks });
    const attached = await sessions.attach({ dir: f.dir, nativeSessionId: "lookup-main", sessionFile: nativeFile(f), kind: "main", role: "implement" });
    await assert.rejects(sessions.useTask({ dir: f.dir, knitSessionId: attached.record.knitSessionId, taskId: f.task.taskId, persisted: false }), check);
    assert.deepEqual(readFileSync(join(f.oldDir, "task.md")), f.oldBody);
    assert.deepEqual(await f.store.bindings.get(f.task.taskId), binding);
  } finally { f.cleanup(); }
});
