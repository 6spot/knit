/**
 * 工作区执行路由、跨目录查询与会话续做测试（任务 k-1910551e4f50）。
 * 隔离夹具：真实 Git 仓库 + create/handoff/prepare 的 worktree + 最小 Pi RPC 假实现。
 * 覆盖：worktree 内派发、主检出拒绝、未 prepare、现场异常、规则隔离、
 * status/list、跨目录取消与接收、会话 cwd 变化回退、锁与常规路径回归。
 */
import { writeAcceptanceFixture } from "./helpers/scenarios.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { WorktreePrepareService } from "../dist/application/worktree-prepare.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { resolveProjectStart, executionRouteOf, assertExecutionRoute } from "../dist/application/worktree-routing.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { isRunSettled } from "./helpers/run-settled.mjs";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-routing-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  const acceptance = new RunAcceptanceService({ store, locks, randomHex });
  return { store, locks, tasks, coordinator, acceptance };
}

async function readyTask(dir, s, title = "路由任务") {
  const task = await s.tasks.newTask({ dir, title, slug: title.replace(/\s+/g, "-"), verification: "independent" });
  writeAcceptanceFixture(dir, task.taskId);
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function model() {
  return { runtime: "pi", provider: "fake", model: "fake-model" };
}

function prepareInput(dir, taskId, options = {}) {
  const { phase = "implement", ...rest } = options;
  return {
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: model(),
    ...rest,
  };
}

/** 建 worktree → 交接任务资料 → （默认）prepare；返回现场路径与分支。 */
async function setupWorktree(dir, s, taskId, { prepare = true } = {}) {
  const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir, taskId });
  const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(dir) }).handoff({ dir, taskId });
  if (prepare) await new WorktreePrepareService({ store: s.store }).prepare({ dir, taskId });
  return { path: created.worktree.path, branch: created.worktree.branch, taskDir: handed.targetTaskDir, name: created.worktree.relativePath };
}

function actionFile(dir, action) {
  const path = join(dir, ".fake-action.json");
  writeFileSync(path, JSON.stringify(action));
  return path;
}

async function startRun(s, { mainRoot, executionDir, taskId, phase = "implement", action, recovery }) {
  const prepared = await s.coordinator.prepare(prepareInput(mainRoot, taskId, {
    phase,
    ...(executionDir === undefined ? {} : { executionDir }),
    ...(recovery === undefined ? {} : { recovery }),
  }));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionFile(mainRoot, action);
  const started = await s.coordinator.start({ dir: mainRoot, runId: prepared.request.runId });
  assert.equal(started.confirmed, true, `worker 未确认: ${started.launch.lastError ?? ""}`);
  const deadline = Date.now() + 20_000;
  let status;
  for (;;) {
    status = await s.coordinator.status({ dir: mainRoot, runId: prepared.request.runId });
    if (isRunSettled(status)) break;
    if (Date.now() > deadline) throw new Error(`run 未终止: ${status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { prepared, started, status, runId: prepared.request.runId };
}

function taskFileIn(taskDir) {
  return join(taskDir, "task.md");
}

test("a) worktree 内派发实施：cwd=worktree；run 产物、pi-sessions 与元数据仍在主检出；worktree 无 .knit/.runtime", async () => {
  const dir = project("dispatch");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "dispatch in worktree");
    const wt = await setupWorktree(dir, s, task.taskId);
    const { prepared, status } = await startRun(s, {
      mainRoot: dir,
      executionDir: wt.path,
      taskId: task.taskId,
      action: {
        writes: [{ path: "README.md", content: "# changed in worktree\n" }],
        report: { summary: "worktree change", changedPaths: ["README.md"] },
      },
    });
    assert.equal(prepared.request.expected.executionDir, wt.path);
    assert.equal(prepared.request.expected.branch, wt.branch);
    assert.equal(status.state, "completed");
    assert.equal(status.result.state, "completed");
    assert.equal(status.result.branch, wt.branch);
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"]);

    // run 产物与 pi-sessions 固定在主检出。
    const runs = new RunStore(dir);
    assert.ok(existsSync(join(runs.runDir(prepared.request.runId), "snapshot", "manifest.json")));
    assert.ok(existsSync(join(dir, ".knit", ".runtime", "pi-sessions")));
    assert.ok(readdirSync(join(dir, ".knit", ".runtime", "pi-sessions")).length > 0);
    // worktree 内不产生运行数据。
    assert.equal(existsSync(join(wt.path, ".knit", ".runtime")), false);
    // 代码改动落在 worktree；主检出未被改成 worktree 内容。
    assert.equal(readFileSync(join(wt.path, "README.md"), "utf8"), "# changed in worktree\n");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n");
    // 任务资料权威在 worktree：接收写回 worktree 的 task.md（进入 check）。
    const document = parseTaskDocument(readFileSync(taskFileIn(wt.taskDir), "utf8"));
    assert.equal(document.frontmatter.stage, "check");
    // frontmatter 保留源分支事实（任务由 task new 创建时为 null），不作 worktree 路由否决依据。
    assert.equal(document.frontmatter.branch, null);
    assert.equal(existsSync(join(dir, ".knit", "tasks", basename(wt.taskDir), "task.md")), false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("b) 主检出对 worktree-active 任务派发 → execution_dir_mismatch", async () => {
  const dir = project("mismatch");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "mismatch");
    const wt = await setupWorktree(dir, s, task.taskId);
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId)),
      (error) => error.guardReason === "execution_dir_mismatch" && /请 cd 到实际执行目录/.test(error.message),
    );
    // 从 worktree 起点派发通过路由核对（不启动，仅证明不是一律拒绝）。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, { executionDir: wt.path }));
    assert.equal(prepared.request.expected.branch, wt.branch);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("c) 未 prepare 的任务从 worktree 派发 → worktree_not_ready", async () => {
  const dir = project("notready");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "not ready");
    const wt = await setupWorktree(dir, s, task.taskId, { prepare: false });
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId, { executionDir: wt.path })),
      (error) => error.guardReason === "worktree_not_ready" && /knit worktree prepare/.test(error.message),
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("d) 目录被删除／未登记／分支不符 → worktree_invalid:<原因>，不回退主检出", async () => {
  const dir = project("invalid");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "invalid");
    const wt = await setupWorktree(dir, s, task.taskId);

    // 分支不符
    git(wt.path, ["checkout", "-q", "-b", "other-branch"]);
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId, { executionDir: wt.path })),
      (error) => error.guardReason === "worktree_invalid" && /登记分支不符/.test(error.message),
    );
    git(wt.path, ["checkout", "-q", wt.branch.replace("refs/heads/", "")]);

    // 未登记（目录仍在，但 porcelain 已无该路径）
    rmSync(wt.path, { recursive: true, force: true });
    git(dir, ["worktree", "prune"]);
    mkdirSync(wt.path, { recursive: true });
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId, { executionDir: wt.path })),
      (error) => error.guardReason === "worktree_invalid" && /未在 git worktree list 中/.test(error.message),
    );

    // 目录缺失
    rmSync(wt.path, { recursive: true, force: true });
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId)),
      (error) => error.guardReason === "worktree_invalid" && /登记路径缺失/.test(error.message),
    );
    // 主检出没有被当作替代执行目录。
    assert.equal(existsSync(join(dir, ".knit", "tasks", basename(wt.taskDir), "task.md")), false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("e) 规则隔离：worktree 各自 HEAD 的 .knit 规则生效，主检出未提交改动不进入", async () => {
  const dir = project("rules");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "rules");
    const wt = await setupWorktree(dir, s, task.taskId);
    // 主检出未提交改动
    writeFileSync(join(dir, ".knit", "standards", "index.md"), "主检出未提交规则\n");
    // worktree 在自己分支提交另一份规则
    writeFileSync(join(wt.path, ".knit", "standards", "index.md"), "worktree HEAD 规则\n");
    git(wt.path, ["add", ".knit/standards/index.md"]);
    git(wt.path, ["commit", "-q", "-m", "worktree rules"]);

    const planWorktree = await new ContextPlanner({ store: s.store }).plan({ dir: wt.path, taskId: task.taskId, role: "implement" });
    assert.equal(planWorktree.ready, true);
    const standards = planWorktree.sections.filter((section) => section.kind === "standard");
    const contents = standards.map((section) => readFileSync(join(wt.path, section.path), "utf8")).join("\n");
    assert.ok(contents.includes("worktree HEAD 规则"));
    assert.equal(contents.includes("主检出未提交规则"), false);

    // 派发冻结的输入同样来自 worktree，不使用主检出的未提交改动。
    const { prepared, status } = await startRun(s, {
      mainRoot: dir,
      executionDir: wt.path,
      taskId: task.taskId,
      action: {
        writes: [{ path: "README.md", content: "# rules\n" }],
        report: { summary: "rules", changedPaths: ["README.md"] },
      },
    });
    assert.equal(status.state, "completed");
    const inputs = new RunStore(dir).readInputs(prepared.request.runId);
    assert.equal(inputs.standardsDigest, planWorktree.standardsDigest);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("f) worktree list 含 invalid 条目与原因；worktree status 字段完整（跨目录）", async () => {
  const dir = project("query");
  const s = services(dir);
  try {
    const okTask = await readyTask(dir, s, "query ok");
    const ok = await setupWorktree(dir, s, okTask.taskId);
    const badTask = await readyTask(dir, s, "query bad");
    const bad = await setupWorktree(dir, s, badTask.taskId);
    rmSync(bad.path, { recursive: true, force: true });

    const listed = spawnSync(process.execPath, [CLI, "worktree", "list", "--json", "--dir", ok.path], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    const listData = JSON.parse(listed.stdout).data;
    assert.equal(listData.mainRoot, dir);
    const valid = listData.entries.find((entry) => entry.taskId === okTask.taskId);
    assert.equal(valid.state, "worktree");
    assert.equal(valid.dir, ok.path);
    assert.equal(valid.branch, ok.branch);
    assert.equal(valid.layout, "project");
    assert.equal(valid.prepared, true);
    assert.equal(valid.active, true);
    assert.equal(valid.problem, null);
    const invalid = listData.entries.find((entry) => entry.taskId === badTask.taskId);
    assert.equal(invalid.state, "invalid");
    assert.match(invalid.problem, /登记路径缺失/);

    const status = spawnSync(process.execPath, [CLI, "worktree", "status", "--task", okTask.taskId, "--json", "--dir", ok.path], { encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    const statusData = JSON.parse(status.stdout).data;
    assert.equal(statusData.state, "worktree");
    assert.equal(statusData.dir, ok.path);
    assert.equal(statusData.branch, ok.branch);
    assert.equal(statusData.layout, "project");
    assert.equal(statusData.prepared, true);
    assert.equal(statusData.active, true);
    assert.equal(statusData.problem, null);
    assert.equal(statusData.mainRoot, dir);

    // 从主检出查询同一路由，结果一致（跨目录）。
    const fromMain = spawnSync(process.execPath, [CLI, "worktree", "status", "--task", okTask.taskId, "--json", "--dir", dir], { encoding: "utf8" });
    assert.equal(JSON.parse(fromMain.stdout).data.dir, ok.path);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("g) 从主检出按 runId 接收与取消 worktree 内的 run", async () => {
  const dir = project("ownership");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "ownership");
    const wt = await setupWorktree(dir, s, task.taskId);
    const impl = await startRun(s, {
      mainRoot: dir,
      executionDir: wt.path,
      taskId: task.taskId,
      action: {
        writes: [{ path: "README.md", content: "# done\n" }],
        report: { summary: "done", changedPaths: ["README.md"] },
      },
    });
    assert.equal(impl.status.state, "completed");
    // 主检出按 runId 接收（worker 已自动接收，此处为幂等重放）。
    const accepted = await s.acceptance.accept({ dir, runId: impl.runId });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.duplicate, true);

    // 新准备一个 check run（不启动），从主检出取消成功。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, { phase: "check", executionDir: wt.path }));
    const cancelled = await s.coordinator.cancel({ dir, runId: prepared.request.runId, reason: "from main checkout" });
    assert.equal(cancelled.requested, true);
    assert.ok(existsSync(join(new RunStore(dir).runDir(prepared.request.runId), "cancel.json")));
    // run 产物归属主检出，执行目录没有运行数据。
    assert.equal(existsSync(join(wt.path, ".knit", ".runtime")), false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("h) 会话续做：cwd 变化 → 新会话（保留阶段／修复轮次／scope）；cwd 不变 → 原会话恢复", async () => {
  const dir = project("session");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "session resume");
    // 主检出内实施失败一次，留下 cwd=mainRoot 的会话。
    const first = await startRun(s, {
      mainRoot: dir,
      taskId: task.taskId,
      action: { report: { summary: "missing changedPaths" } },
    });
    assert.equal(first.status.state, "failed");
    const sessionsAfterFirst = await s.store.sessions.list({ taskId: task.taskId });
    const firstSession = sessionsAfterFirst.find((record) => record.runId === first.runId);
    assert.ok(firstSession !== undefined);
    assert.equal(firstSession.cwd, dir);

    const before = await s.store.bindings.get(task.taskId);
    const wt = await setupWorktree(dir, s, task.taskId);

    // cwd 变化：worktree 内派发，恢复旧原生会话 → 按 resume=prefer 回退新会话。
    const second = await startRun(s, {
      mainRoot: dir,
      executionDir: wt.path,
      taskId: task.taskId,
      recovery: { nativeSessionId: firstSession.ref.nativeSessionId, resume: "prefer" },
      action: { report: { summary: "missing changedPaths" } },
    });
    assert.equal(second.status.state, "failed");
    const sessionsAfterSecond = await s.store.sessions.list({ taskId: task.taskId });
    const secondSession = sessionsAfterSecond.find((record) => record.runId === second.runId);
    assert.ok(secondSession !== undefined);
    assert.notEqual(secondSession.knitSessionId, firstSession.knitSessionId);
    assert.equal(secondSession.cwd, wt.path);
    assert.equal(secondSession.source.kind, "resume_fallback");
    assert.equal(secondSession.source.reason, "cwd_mismatch");
    assert.equal(secondSession.source.fromSessionId, firstSession.knitSessionId);

    const after = await s.store.bindings.get(task.taskId);
    const afterDocument = parseTaskDocument(readFileSync(taskFileIn(wt.taskDir), "utf8"));
    assert.equal(afterDocument.frontmatter.stage, "implement");
    assert.equal(after.repairCycleId, before.repairCycleId);
    assert.equal(after.repairRounds, before.repairRounds);
    assert.deepEqual(after.scope ?? [], before.scope ?? []);

    // cwd 不变：同一 worktree 再派发，恢复第二会话。
    const third = await startRun(s, {
      mainRoot: dir,
      executionDir: wt.path,
      taskId: task.taskId,
      recovery: { nativeSessionId: secondSession.ref.nativeSessionId, resume: "prefer" },
      action: { report: { summary: "missing changedPaths" } },
    });
    assert.equal(third.status.state, "failed");
    const thirdSession = (await s.store.sessions.list({ taskId: task.taskId })).find((record) => record.runId === third.runId);
    assert.equal(thirdSession.ref.nativeSessionId, secondSession.ref.nativeSessionId);
    assert.equal(thirdSession.cwd, wt.path);
    assert.equal(third.status.result.session.nativeSessionId, secondSession.ref.nativeSessionId);
    assert.equal(third.status.result.session.resumeAction, "resume");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("i) 执行目录锁键：主检出与 worktree 分离，同一执行目录仍互斥", async () => {
  const dir = project("lock");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "lock");
    const wt = await setupWorktree(dir, s, task.taskId);
    const root = resolveProjectStart(wt.path).mainRoot;
    assert.equal(root, dir);

    // 主检出侧取得项目执行占用；worktree 执行目录是不同键，可并行（任务17）。
    const mainHolder = new LockManager({ root: join(dir, ".locks") });
    const held = await mainHolder.acquire({
      keys: [{ scope: "project", rawKey: dir }],
      action: "run.prepare",
    });
    try {
      const fromWorktree = new LockManager({ root: join(dir, ".locks") });
      const wtLock = await fromWorktree.acquire({
        keys: [{ scope: "project", rawKey: wt.path }],
        action: "run.prepare",
      });
      // 同一 worktree 执行目录的第二个占用仍被拒绝。
      await assert.rejects(
        new LockManager({ root: join(dir, ".locks") }).acquire({
          keys: [{ scope: "project", rawKey: wt.path }],
          action: "run.prepare",
        }),
        (error) => error.code === "lock_busy",
      );
      fromWorktree.release(wtLock);
    } finally {
      mainHolder.release(held);
    }
    // 释放后同一执行目录键可再取（派发不被目录改变）。
    const after = new LockManager({ root: join(dir, ".locks") });
    const again = await after.acquire({ keys: [{ scope: "project", rawKey: wt.path }], action: "run.prepare" });
    after.release(again);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("j) 非 Git 与主检出常规路径回归", async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "knit-routing-plain-")));
  try {
    const start = resolveProjectStart(plain);
    assert.equal(start.mainRoot, plain);
    assert.equal(start.executionDir, plain);
    assert.equal(start.linkedWorktree, false);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }

  const dir = project("regular");
  const s = services(dir);
  try {
    const start = resolveProjectStart(dir);
    assert.equal(start.mainRoot, dir);
    assert.equal(start.executionDir, dir);
    assert.equal(start.linkedWorktree, false);

    const task = await readyTask(dir, s, "regular");
    const binding = await s.store.bindings.get(task.taskId);
    const route = executionRouteOf(binding, dir);
    assert.equal(route.state, "main");
    assert.equal(route.dir, dir);
    assert.equal(route.branch, binding.branch);
    assert.doesNotThrow(() => assertExecutionRoute(route, dir));

    // 主检出常规派发仍然成功，产物与 pi-sessions 都在主检出。
    const { prepared, status } = await startRun(s, {
      mainRoot: dir,
      taskId: task.taskId,
      action: {
        writes: [{ path: "README.md", content: "# regular\n" }],
        report: { summary: "regular", changedPaths: ["README.md"] },
      },
    });
    assert.equal(status.state, "completed");
    assert.equal(prepared.request.expected.executionDir, dir);
    assert.ok(existsSync(join(new RunStore(dir).runDir(prepared.request.runId), "snapshot", "manifest.json")));
    assert.ok(readdirSync(join(dir, ".knit", ".runtime", "pi-sessions")).length > 0);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
