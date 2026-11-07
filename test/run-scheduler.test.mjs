/**
 * 任务 k-9cd9a63bd5c5：Worktree 模式下的多任务调度。
 * 隔离夹具：真实 Git 仓库／worktree、真实 worker 子进程、fake Pi RPC；不调用真实模型。
 * 覆盖门槛、就绪集、影响路径重叠、并发上限与调度锁、自动接收与阶段推进、
 * 收尾授权边界、SIGINT 只停派发，以及主检出任务的常规执行回归。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunScheduler } from "../dist/application/run-scheduler.js";
import { defaultConfig, parseConfig } from "../dist/application/config.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { parseImpactSection, impactPathsOverlap } from "../dist/domain/impact.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const MAIN = "refs/heads/main";

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(prefix, overrides = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `knit-sched-${prefix}-`)));
  const root = join(base, "root");
  execFileSync("mkdir", ["-p", root]);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(root, ".knit"), { recursive: true });
  const config = structuredClone(defaultConfig());
  config.execution = { host: "local" };
  config.worktree = { default: "on", cleanup: "manual", ...(overrides.worktree ?? {}) };
  config.delivery = { mode: "local", ...(overrides.delivery ?? {}) };
  config.scheduler = { maxConcurrent: 1, maxAttempts: 3, ...(overrides.scheduler ?? {}) };
  config.phases = { implement: { model: "fake/fake" }, check: { model: "fake/fake" } };
  writeFileSync(join(root, ".knit", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n.knit/worktrees/\n");
  writeFileSync(join(root, "README.md"), "# demo\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return { base, root, locksRoot: join(base, "locks") };
}

function services(dir, locksRoot) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: locksRoot });
  const tasks = new TaskService({ store, locks, randomHex });
  const scheduler = new RunScheduler({ store, locks, locksRoot, randomHex });
  return { store, locks, tasks, scheduler };
}

function action(report, extra = {}) {
  return JSON.stringify({ report, ...extra });
}

const PASS_REPORT = {
  summary: "fake",
  validation: ["fake"],
  blockers: [],
  changedPaths: [],
  unverified: [],
  verdict: "pass",
};

async function readyTask(s, dir, slug, options = {}) {
  const task = await s.tasks.newTask({
    dir,
    title: slug,
    slug,
    branch: MAIN,
    verification: options.verification ?? "self",
  });
  if (options.dependsOn !== undefined) {
    await s.tasks.setDependencies({ dir, taskId: task.taskId, set: options.dependsOn });
  }
  if (options.plan !== undefined) {
    writeFileSync(join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "plan.md"), options.plan);
  }
  if (options.ready !== false) await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function taskStage(root, task) {
  return parseTaskDocument(readFileSync(join(root, ".knit", "tasks", task.relativePath.split("/")[1], "task.md"), "utf8")).frontmatter.stage;
}

function setTaskStage(root, task, stage) {
  const file = join(root, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^stage: .*$/m, `stage: ${stage}`));
}

function setAction(path, report = PASS_REPORT, extra = {}) {
  writeFileSync(path, action(report, extra));
}

async function waitTerminal(root, runId, timeoutMs = 30_000) {
  const runs = new RunStore(root);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = runs.readState(runId);
    if (state !== null && ["completed", "cancelled", "failed"].includes(state.state)) return state;
    if (Date.now() > deadline) throw new Error(`run 未终止: ${state?.state ?? "无状态"}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function cleanup(f) {
  rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

test("配置：scheduler 缺省 1／1，非正整数拒绝且旧配置兼容", () => {
  const defaults = defaultConfig();
  assert.deepEqual(defaults.scheduler, { maxConcurrent: 1, maxAttempts: 1 });
  const parsed = parseConfig(JSON.stringify({ ...defaults, scheduler: { maxConcurrent: 2, maxAttempts: 4 } }));
  assert.deepEqual(parsed.scheduler, { maxConcurrent: 2, maxAttempts: 4 });
  for (const scheduler of [{ maxConcurrent: 0 }, { maxAttempts: 0 }, { maxConcurrent: -1 }, { maxAttempts: 1.5 }]) {
    assert.throws(
      () => parseConfig(JSON.stringify({ ...defaults, scheduler })),
      /config\.json 结构不符合约定/,
      JSON.stringify(scheduler),
    );
  }
  const legacy = structuredClone(defaults);
  delete legacy.scheduler;
  assert.deepEqual(parseConfig(JSON.stringify(legacy)).scheduler, undefined);
});

test("影响路径：区段解析、目录前缀重叠与未知影响", () => {
  const known = parseImpactSection([
    "# plan",
    "",
    "## 影响路径",
    "",
    "- `src/application/task-schedule.ts`",
    "* src/cli/",
    "2. src/domain/impact.ts",
    "",
    "## 验证",
    "- npm test",
  ].join("\n"));
  assert.equal(known.known, true);
  assert.deepEqual(known.paths, ["src/application/task-schedule.ts", "src/cli", "src/domain/impact.ts"]);
  assert.equal(impactPathsOverlap("src/a", "src/a/b.ts"), true);
  assert.equal(impactPathsOverlap("src/a/", "src/a"), true);
  assert.equal(impactPathsOverlap("src/ab", "src/a"), false);
  assert.equal(impactPathsOverlap("src/a.ts", "src/a"), false);
  assert.deepEqual(parseImpactSection(null), { known: false, paths: [] });
  assert.deepEqual(parseImpactSection("# plan\n\n## 其它\n- src/a\n"), { known: false, paths: [] });
  assert.deepEqual(parseImpactSection("## 影响路径\n\n## 验证\n"), { known: false, paths: [] });
  assert.equal(parseImpactSection("## 影响路径\n- src/**/*.ts\n").known, false);
  assert.equal(parseImpactSection("## 影响路径\n- /absolute\n").known, false);
});

test("门槛：worktree.default=off 时不派发、不接收并原样退出", async () => {
  const f = fixture("gate", { worktree: { default: "off" } });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "gate-off");
    const result = await s.scheduler.run({ dir: f.root, mode: "once" });
    assert.equal(result.gate, "disabled");
    assert.match(result.message ?? "", /worktree 模式未开启/);
    assert.equal(result.dispatched.length, 0);
    assert.deepEqual(new RunStore(f.root).listRunIds(), []);
    assert.equal(taskStage(f.root, task), "implement");
    const scheduleLocks = new LockManager({ root: f.locksRoot }).list().filter((entry) => entry.key === `schedule:${f.root}`);
    assert.deepEqual(scheduleLocks, []);
  } finally {
    s.store.close();
    cleanup(f);
  }
});

test("CLI：门槛关闭时输出说明并退出 0；--once 与 --until-idle 互斥", () => {
  const f = fixture("cli-gate", { worktree: { default: "off" } });
  try {
    const result = spawnSync(process.execPath, [
      CLI, "run", "schedule", "--once", "--json", "--locks", f.locksRoot, "--dir", f.root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.outcome, "completed");
    assert.equal(response.data.gate, "disabled");
    assert.match(response.data.message, /worktree 模式未开启/);
    const conflict = spawnSync(process.execPath, [
      CLI, "run", "schedule", "--once", "--until-idle", "--json", "--locks", f.locksRoot, "--dir", f.root,
    ], { encoding: "utf8" });
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stdout).outcome, "error");
  } finally {
    cleanup(f);
  }
});

test("调度锁：同一项目同时只有一个调度循环", async () => {
  const f = fixture("lock");
  const s = services(f.root, f.locksRoot);
  const holder = new LockManager({ root: f.locksRoot });
  try {
    await readyTask(s, f.root, "lock-task", { plan: "## 影响路径\n\n- src/a\n" });
    const held = await holder.acquire({ keys: [{ scope: "project", rawKey: `schedule:${f.root}` }], action: "test.hold" });
    try {
      await assert.rejects(
        () => s.scheduler.run({ dir: f.root, mode: "once" }),
        (error) => error.code === "lock_busy",
      );
      assert.deepEqual(new RunStore(f.root).listRunIds(), []);
    } finally {
      holder.release(held);
    }
  } finally {
    s.store.close();
    cleanup(f);
  }
});

test("--once：按稳定顺序派发，路径重叠跳过；活动 run 计入上限", async () => {
  const f = fixture("once", { scheduler: { maxConcurrent: 1, maxAttempts: 3 } });
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath, PASS_REPORT, { waitFile: ".wait-once" });
  try {
    const first = await readyTask(s, f.root, "first", { plan: "## 影响路径\n\n- src/a\n" });
    const second = await readyTask(s, f.root, "second", { plan: "## 影响路径\n\n- src/a/b.ts\n" });
    const third = await readyTask(s, f.root, "third", { plan: "## 影响路径\n\n- src/b\n" });
    const result = await s.scheduler.run({ dir: f.root, mode: "once", maxConcurrent: 1 });
    assert.equal(result.dispatched.length, 1);
    assert.equal(result.dispatched[0].taskId, first.taskId);
    assert.equal(result.accepted.length, 0, "--once 不接收");
    assert.ok(result.skipped.some((item) => item.taskId === second.taskId && item.reason === `path_overlap:${first.taskId}`));
    assert.ok(result.skipped.some((item) => item.taskId === third.taskId && item.reason === "concurrency_limit"));
    const runs = new RunStore(f.root).listRunIds();
    assert.equal(runs.length, 1);
    const binding = await s.store.bindings.get(first.taskId);
    writeFileSync(join(binding.worktree.path, ".wait-once"), "go\n");
    await waitTerminal(f.root, runs[0]);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("就绪集：start、依赖阻塞与待应用草案不派发", async () => {
  const f = fixture("ready");
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath);
  try {
    const start = await readyTask(s, f.root, "start-task", { ready: false });
    const blocker = await readyTask(s, f.root, "blocker", { ready: false });
    const blocked = await readyTask(s, f.root, "blocked", { plan: "## 影响路径\n\n- src/b\n" });
    await s.tasks.setDependencies({ dir: f.root, taskId: blocked.taskId, set: [blocker.taskId] });
    const draft = await readyTask(s, f.root, "draft", { plan: "## 影响路径\n\n- src/c\n" });
    const binding = await s.store.bindings.get(draft.taskId);
    const stamp = new Date().toISOString();
    await s.store.bindings.save({
      ...binding,
      pendingDraft: {
        kind: "clarify",
        reason: "test",
        content: "x",
        baselineDigest: "a".repeat(64),
        digest: "d".repeat(64),
        createdAt: stamp,
      },
    });
    const result = await s.scheduler.run({ dir: f.root, mode: "once" });
    assert.equal(result.dispatched.length, 0);
    const reasons = new Map(result.skipped.map((item) => [item.taskId, item.reason]));
    assert.equal(reasons.get(start.taskId), "stage_start");
    assert.match(reasons.get(blocked.taskId) ?? "", /^dependency_blocked:/);
    assert.equal(reasons.get(draft.taskId), "pending_draft");
    assert.equal(taskStage(f.root, start), "start");
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("循环：独立任务自动接收 implement → check → deliver，未授权时停在交付前", async () => {
  const f = fixture("loop");
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath);
  try {
    const task = await readyTask(s, f.root, "loop-task", {
      verification: "independent",
      plan: "## 影响路径\n\n- src/a\n",
    });
    const result = await s.scheduler.run({ dir: f.root, mode: "until-idle", pollIntervalMs: 25 });
    assert.equal(result.accepted.length, 2, JSON.stringify(result.events));
    const phases = new RunStore(f.root).listRunIds().map((runId) => new RunStore(f.root).readRequest(runId)?.phase);
    assert.deepEqual(phases.sort(), ["check", "implement"]);
    const binding = await s.store.bindings.get(task.taskId);
    const document = parseTaskDocument(readFileSync(join(binding.worktree.path, ".knit/tasks", task.relativePath.split("/")[1], "task.md"), "utf8"));
    assert.equal(document.frontmatter.stage, "deliver");
    assert.equal(document.frontmatter.status, "open");
    assert.equal(result.closed.length, 0);
    assert.deepEqual(result.pendingDelivery, [task.taskId]);
    assert.equal(existsSync(binding.worktree.path), true);
    // 显式提交授权：独立检查凭据产生在 worktree 分支，合入后仍应可交付。
    const delivered = await s.scheduler.run({
      dir: f.root,
      mode: "until-idle",
      pollIntervalMs: 25,
      authorizationRef: "user:loop-test",
    });
    assert.deepEqual(delivered.delivered, [task.taskId], JSON.stringify(delivered.events));
    assert.deepEqual(delivered.needsAttention, []);
    const after = await s.store.bindings.get(task.taskId);
    assert.equal(after.worktree?.active, false);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("收尾：配置只授权合入／清理，缺少提交授权时自动关闭但停在交付前", async () => {
  const f = fixture("config-only", { delivery: { mode: "merge" }, worktree: { cleanup: "after-merge" } });
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath);
  try {
    const task = await readyTask(s, f.root, "config-only", { plan: "## 影响路径\n\n- src/a\n" });
    const first = await s.scheduler.run({ dir: f.root, mode: "until-idle", pollIntervalMs: 25 });
    assert.deepEqual(first.closed, [task.taskId]);
    assert.deepEqual(first.pendingDelivery, [task.taskId]);
    assert.deepEqual(first.delivered, []);
    assert.ok(first.events.some((event) => event.action === "pending_delivery_authorization" && /config:/.test(event.authorization ?? "")));
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.worktree.active, true);
    const document = parseTaskDocument(readFileSync(join(binding.worktree.path, ".knit/tasks", task.relativePath.split("/")[1], "task.md"), "utf8"));
    assert.equal(document.frontmatter.status, "closed");
    assert.equal(document.frontmatter.outcome, "completed");
    assert.equal(git(f.root, ["log", "-1", "--format=%s"]), "init");
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("收尾：显式授权后自动 close + deliver + merge + cleanup 并记录来源", async () => {
  const f = fixture("deliver", { delivery: { mode: "merge" }, worktree: { cleanup: "after-merge" } });
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath);
  try {
    const task = await readyTask(s, f.root, "deliver-task", { plan: "## 影响路径\n\n- src/a\n" });
    const first = await s.scheduler.run({ dir: f.root, mode: "until-idle", pollIntervalMs: 25 });
    assert.deepEqual(first.closed, [task.taskId]);
    // 关闭写入 worktree 任务资料；合入前把任务资料提交到执行分支（主会话收尾的等效事实），
    // 让源工作区满足既有 merge／cleanup 的干净守卫。
    const before = await s.store.bindings.get(task.taskId);
    git(before.worktree.path, ["add", "-A"]);
    git(before.worktree.path, ["commit", "-q", "-m", "close task"]);
    const second = await s.scheduler.run({
      dir: f.root,
      mode: "until-idle",
      pollIntervalMs: 25,
      authorizationRef: "user:scheduler-test",
    });
    assert.deepEqual(second.delivered, [task.taskId], JSON.stringify(second.events));
    assert.deepEqual(second.needsAttention, []);
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding?.worktree, undefined, "交付后 worktree 绑定已清理");
    assert.equal(git(f.root, ["log", "-1", "--format=%s"]).startsWith("chore(task): archive "), true);
    assert.ok(second.events.some((event) => event.action === "delivered" && event.authorization === "user:scheduler-test"));
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("交付失败：worktree 源脏时保留现场并记录待处理，不冒充已交付", async () => {
  const f = fixture("deliver-fail");
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  writeFileSync(actionPath, action({
    ...PASS_REPORT,
    changedPaths: ["src/a/one.txt"],
  }, { writes: [{ path: "src/a/one.txt", content: "one\n" }] }));
  try {
    const task = await readyTask(s, f.root, "deliver-fail", { plan: "## 影响路径\n\n- src/a\n" });
    const first = await s.scheduler.run({ dir: f.root, mode: "until-idle", pollIntervalMs: 25 });
    assert.deepEqual(first.pendingDelivery, [task.taskId]);
    const binding = await s.store.bindings.get(task.taskId);
    // 合入守卫拒绝源 worktree 中任务目录之外的未提交改动。
    writeFileSync(join(binding.worktree.path, "src", "dirty.txt"), "dirty\n");
    const second = await s.scheduler.run({
      dir: f.root,
      mode: "until-idle",
      pollIntervalMs: 25,
      authorizationRef: "user:deliver-fail",
    });
    assert.deepEqual(second.delivered, []);
    assert.ok(second.needsAttention.some((item) => item.taskId === task.taskId && /blocked_dirty|worktree_merge_blocked/.test(item.reason)), JSON.stringify(second.events));
    const after = await s.store.bindings.get(task.taskId);
    assert.equal(after.worktree?.active, true);
    assert.equal(existsSync(binding.worktree.path), true);
    assert.equal(git(f.root, ["log", "-1", "--format=%s"]), "init");
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("SIGINT：只停派发与接收，活动 run 保留且不自动取消", async () => {
  const f = fixture("sigint");
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath, PASS_REPORT, { waitFile: ".wait-sigint" });
  try {
    await readyTask(s, f.root, "sigint-task", { plan: "## 影响路径\n\n- src/a\n" });
    const controller = new AbortController();
    const pending = s.scheduler.run({ dir: f.root, mode: "until-idle", pollIntervalMs: 25, signal: controller.signal });
    const runs = new RunStore(f.root);
    const deadline = Date.now() + 20_000;
    while (runs.listRunIds().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const runId = runs.listRunIds()[0];
    assert.ok(runId);
    while ((runs.readState(runId)?.state ?? "") !== "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
    const result = await pending;
    assert.equal(result.interrupted, true);
    assert.equal(result.dispatched.length, 1);
    assert.equal(result.accepted.length, 0);
    const state = runs.readState(runId);
    assert.equal(state?.state, "running");
    assert.equal(existsSync(join(f.root, ".wait-sigint")), false);
    // 放行 fake Pi 后等待 worker 结束，避免清理夹具时仍有子进程。
    const binding = (await s.store.bindings.list()).find((item) => item.taskId === result.dispatched[0].taskId);
    writeFileSync(join(binding.worktree.path, ".wait-sigint"), "go\n");
    await waitTerminal(f.root, runId);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("未知影响：无 plan 的任务独占运行，已派发后不再派发其它任务", async () => {
  const f = fixture("unknown", { scheduler: { maxConcurrent: 2, maxAttempts: 3 } });
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath, PASS_REPORT, { waitFile: ".wait-unknown" });
  try {
    const unknown = await readyTask(s, f.root, "unknown", {}); // 无 plan.md
    const known = await readyTask(s, f.root, "known", { plan: "## 影响路径\n\n- src/b\n" });
    const result = await s.scheduler.run({ dir: f.root, mode: "once", maxConcurrent: 2 });
    assert.equal(result.dispatched.length, 1);
    assert.equal(result.dispatched[0].taskId, unknown.taskId);
    assert.ok(result.skipped.some((item) => item.taskId === known.taskId && item.reason === `unknown_impact_block:${unknown.taskId}`));
    const binding = await s.store.bindings.get(unknown.taskId);
    writeFileSync(join(binding.worktree.path, ".wait-unknown"), "go\n");
    await waitTerminal(f.root, result.dispatched[0].runId);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("并发上限：手动派发的活动 run 计入，达到上限后不再派发", async () => {
  const f = fixture("manual-count", { scheduler: { maxConcurrent: 1, maxAttempts: 3 } });
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath, PASS_REPORT, { waitFile: ".wait-manual" });
  try {
    const manual = await readyTask(s, f.root, "manual", { plan: "## 影响路径\n\n- src/manual\n" });
    const waiting = await readyTask(s, f.root, "waiting", { plan: "## 影响路径\n\n- src/waiting\n" });
    const prepared = await s.scheduler.coordinator.prepare({
      dir: f.root,
      taskId: manual.taskId,
      phase: "implement",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: f.root },
      model: { runtime: "pi", provider: "fake", model: "fake" },
    });
    await s.scheduler.coordinator.start({ dir: f.root, runId: prepared.request.runId });
    const runs = new RunStore(f.root);
    const deadline = Date.now() + 20_000;
    while ((runs.readState(prepared.request.runId)?.state ?? "") !== "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = await s.scheduler.run({ dir: f.root, mode: "once", maxConcurrent: 1 });
    assert.equal(result.dispatched.length, 0);
    assert.ok(result.skipped.some((item) => item.taskId === waiting.taskId && item.reason === "concurrency_limit"));
    const binding = await s.store.bindings.get(manual.taskId);
    writeFileSync(join(binding.worktree.path, ".wait-manual"), "go\n");
    await waitTerminal(f.root, prepared.request.runId);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});

test("派发失败：单个任务失败不阻塞其它任务；执行目录错配按原因跳过", async () => {
  const f = fixture("failure");
  const s = services(f.root, f.locksRoot);
  const actionPath = join(f.base, "action.json");
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  setAction(actionPath);
  try {
    const checkTask = await readyTask(s, f.root, "check-task", { verification: "independent", plan: "## 影响路径\n\n- src/check\n" });
    setTaskStage(f.root, checkTask, "check");
    const implementTask = await readyTask(s, f.root, "implement-task", { plan: "## 影响路径\n\n- src/impl\n" });
    // check 阶段模型未配置：dispatch_failed；implement 仍应派发。
    const config = JSON.parse(readFileSync(join(f.root, ".knit", "config.json"), "utf8"));
    delete config.phases.check;
    writeFileSync(join(f.root, ".knit", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    git(f.root, ["add", ".knit/config.json"]);
    git(f.root, ["commit", "-q", "-m", "drop check model"]);
    const result = await s.scheduler.run({ dir: f.root, mode: "once", maxConcurrent: 2 });
    assert.ok(result.dispatched.some((item) => item.taskId === implementTask.taskId), JSON.stringify(result.events));
    assert.ok(result.needsAttention.some((item) => item.taskId === checkTask.taskId && /model_required/.test(item.reason)));
    const runId = result.dispatched.find((item) => item.taskId === implementTask.taskId).runId;
    await waitTerminal(f.root, runId);
  } finally {
    delete process.env.KNIT_PI_BIN;
    delete process.env.KNIT_FAKE_ACTION;
    s.store.close();
    cleanup(f);
  }
});
