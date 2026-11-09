/**
 * k-836997c84864：resume 真启动、Rex auto 回退 local、status／context 的确定性 nextAction，
 * 以及 task close 不再要求手传 --runs-settled。真实 Git／worker 子进程，fake Pi 与 fake rex CLI。
 */
import { isProcessAlive, isRunSettled } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { StatusService, taskNextAction } from "../dist/application/status-service.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { StageRunner } from "../dist/application/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli", "knit.js");
const TEMPLATES = join(ROOT, "assets", "templates", ".knit");
const FAKE_PI = join(ROOT, "test", "fixtures", "fake-pi.mjs");
const FAKE_REX = join(ROOT, "test", "fixtures", "fake-rex.mjs");

let counter = 0x9a0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-resume-rex-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.fake-action.json\n.rex-bin/\n.fake-rex.log\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  return { store, locks, tasks, coordinator };
}

function prepareInput(dir, taskId, extra = {}) {
  return {
    dir,
    taskId,
    phase: "implement",
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
    ...extra,
  };
}

function actionFile(dir, action) {
  const path = join(dir, ".fake-action.json");
  writeFileSync(path, JSON.stringify(action));
  return path;
}

async function waitFor(predicate, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitTerminal(s, dir, runId) {
  return waitFor(async () => {
    const status = await s.coordinator.status({ dir, runId });
    return isRunSettled(status) ? status : null;
  }, `run 未终止: ${runId}`);
}

function cli(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 90_000,
  });
  const parsed = result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  return { code: result.status ?? 1, parsed, stderr: result.stderr };
}

/** 启动一个停在 waitFile 的阶段，等 Pi 收到 prompt。 */
async function startHangingRun(s, dir, taskId) {
  const prepared = await s.coordinator.prepare(prepareInput(dir, taskId));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionFile(dir, {
    waitFile: ".never-signal",
    waitTimeoutMs: 120_000,
    report: { summary: "不应完成", changedPaths: [] },
  });
  const promptFile = join(dir, ".knit", ".runtime", `prompt-${prepared.request.runId}.txt`);
  process.env.KNIT_FAKE_PROMPT_FILE = promptFile;
  try {
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.confirmed, true);
  } finally {
    delete process.env.KNIT_FAKE_PROMPT_FILE;
  }
  const status = await waitFor(async () => {
    const current = await s.coordinator.status({ dir, runId: prepared.request.runId });
    return current.stageProcess?.state === "running" && current.stageProcess.piPid !== null ? current : null;
  }, "阶段未进入 running");
  await waitFor(() => existsSync(promptFile), "假 Pi 未收到 prompt");
  return { runId: prepared.request.runId, piPid: status.stageProcess.piPid };
}

/** Rex 环境：fake rex 放进 REX_BIN_DIR，探测与浮层创建都成功，块内进程立即退出。 */
function rexEnv(dir) {
  const bin = join(dir, ".rex-bin");
  mkdirSync(bin, { recursive: true });
  const rex = join(bin, "rex");
  writeFileSync(rex, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_REX}" "$@"\n`);
  chmodSync(rex, 0o755);
  return {
    REX_SESSION: "fake-session",
    REX_BLOCK: "fake-block",
    REX_BIN_DIR: bin,
    // RexApi 默认可执行文件名为 rex：放在 PATH 前面。
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_REX_LOG: join(dir, ".fake-rex.log"),
  };
}

test("worker 被杀 → resume 真启动新 run 并完成接收（CLI run resume 与顶层 resume 同一实现；--no-start 只准备）", async () => {
  const dir = project("resume-start");
  const s = services(dir);
  try {
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    const task = await s.tasks.newTask({ dir, title: "恢复真启动", slug: "resume-start", verification: "self" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const old = await startHangingRun(s, dir, task.taskId);
    const launch = new RunStore(dir).readLaunch(old.runId);
    process.kill(launch.handle.pid, "SIGKILL");
    await waitFor(() => !isProcessAlive(launch.handle.pid) && !isProcessAlive(old.piPid), "worker／Pi 未退出");
    assert.ok(s.locks.list().length > 0, "残留锁存在（由新 worker 自动回收）");

    // status 对 worker 已退出、无结果的 run 给出 resume 出口。
    const before = await new StatusService({ store: s.store, locksRoot: join(dir, ".locks") }).taskStatus(dir, task.taskId);
    assert.equal(before.nextAction?.kind, "run_worker_exited", JSON.stringify(before.nextAction));
    assert.deepEqual(before.nextAction.commands, [`knit run resume ${old.runId}`]);

    // --no-start：保留只准备的行为，launch 停在 planned。
    const action = actionFile(dir, {
      writes: [{ path: "README.md", content: "# resumed\n" }],
      report: { summary: "恢复完成", changedPaths: ["README.md"] },
    });
    const env = { KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_ACTION: action };
    const prepared = cli(dir, ["run", "resume", old.runId, "--no-start", "--locks", join(dir, ".locks")], env);
    assert.equal(prepared.parsed?.outcome, "completed", prepared.stderr);
    assert.equal(prepared.parsed.data.resumed, true);
    assert.equal(prepared.parsed.data.started, false);
    assert.equal(prepared.parsed.data.launch.state, "planned");
    const preparedRun = prepared.parsed.data.request.runId;
    const notStarted = await new StatusService({ store: s.store, locksRoot: join(dir, ".locks") }).taskStatus(dir, task.taskId);
    assert.equal(notStarted.nextAction?.kind, "run_not_started");
    assert.equal(notStarted.nextAction.commands[0], `knit run start ${preparedRun}`);
    // 未启动的新 run 交给顶层 resume：prepare 复用该活动 run 并真启动（默认 start）。
    const resumed = cli(dir, ["resume", task.taskId, "--wait", "--locks", join(dir, ".locks")], env);
    assert.equal(resumed.parsed?.outcome, "completed", resumed.stderr);
    assert.equal(resumed.parsed.data.started, true);
    assert.equal(resumed.parsed.data.request.runId, preparedRun, "复用只准备的 run，不另起执行");
    assert.equal(resumed.parsed.data.launch.state, "confirmed");
    assert.equal(resumed.parsed.data.status.state, "completed");
    const final = await waitTerminal(s, dir, preparedRun);
    assert.equal(final.state, "completed", JSON.stringify({ reason: final.reason, failure: final.result?.failureReason }));
    assert.equal(final.acceptance?.state, "completed", "新 run 已接收");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# resumed\n");
    assert.equal(new RunStore(dir).readState(old.runId).state, "failed", "旧 run 收敛");
    assert.ok(s.locks.listReclaimed().some((record) => record.scope === "project"), "残留租约被新 worker 自动回收");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI run resume 默认真启动：返回 launch 已确认的新 run，--wait 观察到 completed 并已接收", async () => {
  const dir = project("resume-cli");
  const s = services(dir);
  try {
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    const task = await s.tasks.newTask({ dir, title: "CLI 恢复", slug: "resume-cli", verification: "self" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const old = await startHangingRun(s, dir, task.taskId);
    const launch = new RunStore(dir).readLaunch(old.runId);
    process.kill(launch.handle.pid, "SIGKILL");
    await waitFor(() => !isProcessAlive(launch.handle.pid) && !isProcessAlive(old.piPid), "worker／Pi 未退出");

    const action = actionFile(dir, {
      writes: [{ path: "README.md", content: "# cli resumed\n" }],
      report: { summary: "CLI 恢复完成", changedPaths: ["README.md"] },
    });
    const resumed = cli(dir, ["run", "resume", old.runId, "--wait", "--locks", join(dir, ".locks")], { KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_ACTION: action });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.parsed.outcome, "completed");
    const data = resumed.parsed.data;
    assert.equal(data.resumed, true);
    assert.equal(data.started, true, "prepare 之后执行与 run implement 相同的 start");
    assert.equal(data.confirmed, true);
    assert.equal(data.launch.state, "confirmed", "返回 launch 已确认的状态，不再停在 planned");
    assert.ok(data.launch.attempts >= 1);
    assert.equal(data.status.state, "completed");
    const newRunId = data.request.runId;
    const final = await waitTerminal(s, dir, newRunId);
    assert.equal(final.acceptance?.state, "completed");

    // 已收敛：task close 不带 --runs-settled 也能完成。
    const closed = cli(dir, ["task", "close", task.taskId, "--outcome", "completed", "--reason", "恢复后完成"]);
    assert.equal(closed.parsed?.outcome, "completed", JSON.stringify(closed.parsed) + closed.stderr);
    assert.equal(closed.parsed.data.outcome, "completed");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto 选中 Rex 但 worker 未报到：同一 run 以 local 重启并完成，记录回退原因与 Rex 诊断", async () => {
  const dir = project("rex-fallback");
  const s = services(dir);
  const saved = { ...process.env };
  try {
    const env = rexEnv(dir);
    Object.assign(process.env, env);
    const task = await s.tasks.newTask({ dir, title: "Rex 回退", slug: "rex-fallback", verification: "self" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const action = actionFile(dir, {
      writes: [{ path: "README.md", content: "# local fallback\n" }],
      report: { summary: "回退 local 完成", changedPaths: ["README.md"] },
    });
    const run = cli(dir, ["run", "implement", "--task", task.taskId, "--provider", "fake", "--model", "fake-model", "--wait", "--locks", join(dir, ".locks")], {
      ...env,
      KNIT_PI_BIN: FAKE_PI,
      KNIT_FAKE_ACTION: action,
    });
    assert.equal(run.parsed?.outcome, "completed", run.stderr);
    const runId = run.parsed.data.request.runId;
    assert.equal(run.parsed.data.request.presentation, "rex", "auto 选中 Rex");
    assert.equal(run.parsed.data.request.presentationSource, "auto");
    const final = await waitTerminal(s, dir, runId);
    assert.equal(final.state, "completed", JSON.stringify({ reason: final.reason, failure: final.result?.failureReason }));
    assert.equal(final.acceptance?.state, "completed");
    assert.equal(final.presentation, "local", "实际呈现回退为 local");
    assert.equal(final.presentationFallbackReason, "rex_worker_not_started");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# local fallback\n");
    const events = new RunStore(dir).readEvents(runId);
    assert.ok(events.some((event) => event.event === "presentation_fallback" && event.reason === "rex_worker_not_started"));
    const diagnostics = new RunStore(dir).readRexDiagnostics(runId);
    assert.equal(diagnostics?.kind, "rex_start_failed");
    assert.match(diagnostics.detail, /block=block-1/, "块状态写进诊断");
    assert.match(diagnostics.detail, /已退出/);
    assert.match(diagnostics.stderrTail, /fake rex block failed/, "Rex 侧屏幕尾部写进诊断");
    assert.match(readFileSync(env.FAKE_REX_LOG, "utf8"), /^capture$/m);
    const view = await new StatusService({ store: s.store, locksRoot: join(dir, ".locks") }).runStatus(dir, runId);
    assert.equal(view.rexDiagnostics?.failure, diagnostics.failure);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显式 --rex：worker 未报到不回退，失败原因与原始诊断保留", async () => {
  const dir = project("rex-explicit");
  const s = services(dir);
  const saved = { ...process.env };
  try {
    const env = rexEnv(dir);
    Object.assign(process.env, env);
    const task = await s.tasks.newTask({ dir, title: "显式 Rex", slug: "rex-explicit", verification: "self" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const action = actionFile(dir, {
      writes: [{ path: "README.md", content: "# must not run\n" }],
      report: { summary: "不应执行", changedPaths: ["README.md"] },
    });
    const run = cli(dir, ["run", "implement", "--task", task.taskId, "--rex", "--provider", "fake", "--model", "fake-model", "--wait", "--locks", join(dir, ".locks")], {
      ...env,
      KNIT_PI_BIN: FAKE_PI,
      KNIT_FAKE_ACTION: action,
    });
    assert.notEqual(run.parsed, null, run.stderr);
    const runId = run.parsed.data.request.runId;
    const final = await waitTerminal(s, dir, runId);
    assert.equal(final.state, "failed");
    assert.equal(final.presentation, "rex", "显式 --rex 不回退");
    assert.equal(final.presentationFallbackReason, null);
    assert.match(final.result?.failureReason ?? "", /^rex_start_failed:rex_worker_not_started/);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n", "未以 local 执行");
    assert.ok(!new RunStore(dir).readEvents(runId).some((event) => event.event === "presentation_fallback"));
    const diagnostics = new RunStore(dir).readRexDiagnostics(runId);
    assert.match(diagnostics?.stderrTail ?? "", /fake rex block failed/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StageRunner：launcher 装配抛错时保留原始错误；auto 无副作用回退，已有副作用不回退", async () => {
  const dir = project("rex-throw");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "装配抛错", slug: "rex-throw", verification: "self" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const plan = await new ContextPlanner({ store: s.store }).plan({ dir, taskId: task.taskId, role: "implement" });
    const coordinator = new RunCoordinator({ store: s.store, randomHex, lockRoot: join(dir, ".locks"), hostProbe: async () => {} });
    const launcherThrowing = (sideEffect) => () => ({
      async execute() {
        if (sideEffect) writeFileSync(join(dir, "README.md"), "# side effect\n");
        throw new Error("spawn rex ENOENT: original cause");
      },
      async stop() {},
      async steer() {},
      async terminate() {},
      async closeLayer() {},
      async dispose() {},
      status() {
        return null;
      },
      diagnostics() {
        return null;
      },
    });
    const runFor = async (presentationSource, sideEffect) => {
      const prepared = await coordinator.prepare(prepareInput(dir, task.taskId, { presentation: "rex" }));
      const request = { ...prepared.request, presentationSource };
      const fallbacks = [];
      // local 回退用一个立即失败的运行时替身：只验证确实走到了 local 分支。
      const runtimeFactory = () => ({
        processId: null,
        sessionFile: null,
        stderrDiagnostics: { tail: "", truncated: false },
        async start() {
          return { ok: false, failure: "fake_local_marker", detail: "local 分支已进入" };
        },
        async dispose() {},
      });
      const execution = await new StageRunner({
        root: dir,
        request,
        plan,
        inputs: {},
        store: s.store,
        runs: new RunStore(dir),
        rexLauncherFactory: launcherThrowing(sideEffect),
        runtimeFactory,
        onPresentationFallback: (presentation, reason) => fallbacks.push({ presentation, reason }),
      }).execute();
      // 每个场景独立：撤销 run 记录，避免下一次 prepare 复用活动 run。
      rmSync(join(dir, ".knit", ".runtime", "runs", prepared.request.runId), { recursive: true, force: true });
      return { execution, fallbacks, runId: prepared.request.runId };
    };

    // 1) 显式 rex：不回退；原始错误首行保留在 result 摘要，原因码不变。
    const explicit = await runFor("explicit", false);
    assert.equal(explicit.execution.result.failureReason, "rex_start_failed:rex_launcher_error");
    assert.match(explicit.execution.result.reportSummary ?? "", /spawn rex ENOENT: original cause/);
    assert.deepEqual(explicit.fallbacks, []);

    // 2) auto 且无副作用：回退 local（运行时替身的失败标记证明进入了 local 分支）。
    const auto = await runFor("auto", false);
    assert.deepEqual(auto.fallbacks, [{ presentation: "local", reason: "rex_worker_not_started" }]);
    assert.equal(auto.execution.result.failureReason, "runtime_start_failed:fake_local_marker");

    // 3) auto 但本 run 已产生工作区改动：不回退，按 Rex 启动失败收敛。
    const dirty = await runFor("auto", true);
    assert.deepEqual(dirty.fallbacks, []);
    assert.equal(dirty.execution.result.failureReason, "rex_start_failed:rex_launcher_error");
    writeFileSync(join(dir, "README.md"), "# demo\n");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nextAction：stale／deliver 场景非空，覆盖待接收、needs_attention、锁残留与无绑定", async () => {
  const dir = project("next-action");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "出口提示", slug: "next-action", verification: "self" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# done\n" }],
      report: { summary: "完成", changedPaths: ["README.md"] },
    });
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    await s.coordinator.start({ dir, runId: prepared.request.runId });
    const final = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(final.acceptance?.state, "completed");
    const status = new StatusService({ store: s.store, locksRoot: join(dir, ".locks") });
    const delivered = await status.taskStatus(dir, task.taskId);
    assert.equal(delivered.stage, "deliver");
    assert.equal(delivered.nextAction?.kind, "stage");
    assert.match(delivered.nextAction.commands[0], /knit task close .* --outcome completed/);

    // 审计 S3：deliver 阶段输入被直接改动（stale）——status 不再是空 blockers，而是 update 出口。
    const file = join(dir, ".knit", task.relativePath);
    writeFileSync(file, readFileSync(file, "utf8").replace("## 目标与边界", "## 目标与边界\n\n交付前补充一句"));
    const stale = await status.taskStatus(dir, task.taskId);
    assert.equal(stale.nextAction?.kind, "inputs_changed", JSON.stringify(stale.nextAction));
    assert.ok(stale.nextAction.commands.some((command) => command.includes("--kind clarify")));
    assert.ok(stale.nextAction.commands.some((command) => command.includes("--kind change")));
    // context CLI 同步给出同一 nextAction。
    const context = cli(dir, ["context", "--task", task.taskId, "--stage", "implement"]);
    assert.equal(context.parsed?.outcome, "completed", context.stderr);
    assert.equal(context.parsed.data.nextAction?.kind, "inputs_changed");
    // 人读 status 输出同样显示下一步。
    const text = spawnSync(process.execPath, [CLI, "status", task.taskId, "--locks", join(dir, ".locks"), "--dir", dir], { encoding: "utf8" });
    assert.match(text.stdout, /下一步（inputs_changed）/);

    // 纯函数覆盖其它出口。
    const base = {
      taskId: task.taskId,
      status: "open",
      stage: "implement",
      verification: "self",
      archived: false,
      binding: { ...delivered.binding, pendingDraft: null, confirmedInputsDigest: "d1" },
      currentInputsDigest: "d1",
      runs: [],
      lockResidue: null,
      workflow: { stages: [{ id: "implement" }] },
      checkerRepaired: false,
    };
    const runView = (overrides) => ({
      runId: "run-000000000001",
      phase: "implement",
      state: "completed",
      launchState: "confirmed",
      workerVerdict: "not_alive",
      stageProcessVerdict: "not_alive",
      result: { state: "completed" },
      acceptance: { state: "completed", reason: "implementation_accepted" },
      nextActions: [],
      ...overrides,
    });
    assert.equal(taskNextAction({ ...base, binding: null }).kind, "binding_missing");
    const pending = taskNextAction({ ...base, runs: [runView({ state: "running", acceptance: null })] });
    assert.equal(pending.kind, "run_pending_acceptance");
    assert.deepEqual(pending.commands, ["knit run accept run-000000000001"]);
    const unaccepted = taskNextAction({ ...base, runs: [runView({ acceptance: null })] });
    assert.equal(unaccepted.kind, "run_pending_acceptance");
    const attention = taskNextAction({ ...base, runs: [runView({ acceptance: { state: "needs_attention", reason: "unattributed_paths:a.txt" } })] });
    assert.equal(attention.kind, "run_needs_attention");
    assert.match(attention.summary, /unattributed_paths:a\.txt/);
    assert.ok(attention.commands.some((command) => command.includes("--include")));
    const lock = taskNextAction({ ...base, lockResidue: { id: "project/abc", token: "tok1", verdict: "unknown", reclaimable: false } });
    assert.equal(lock.kind, "lock_residue");
    assert.ok(lock.commands.some((command) => command === "knit unlock project/abc --expect-token tok1 --force"));
    const staleRun = taskNextAction({ ...base, stage: "deliver", runs: [runView({ acceptance: { state: "needs_attention", reason: "stale_input" } })] });
    assert.equal(staleRun.kind, "inputs_changed");
    assert.equal(staleRun.runId, "run-000000000001");
    const alive = taskNextAction({ ...base, runs: [runView({ state: "running", result: null, acceptance: null, workerVerdict: "alive" })] });
    assert.equal(alive.kind, "run_active");
    const stageAlive = taskNextAction({ ...base, runs: [runView({ state: "running", result: null, acceptance: null, stageProcessVerdict: "alive" })] });
    assert.equal(stageAlive.kind, "run_stage_alive");
    assert.equal(taskNextAction({ ...base, status: "closed" }), null);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task close：注入 run 仓储时不带 runsSettled 也按核心事实判定；活动 run 仍拒绝", async () => {
  const dir = project("close-settled");
  const s = services(dir);
  try {
    const task = await s.tasks.newTask({ dir, title: "无需手传", slug: "close-settled", verification: "none" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    // 活动（已准备未启动）run：核心核对为未收敛。
    await assert.rejects(
      () => s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", reason: "x" }),
      (error) => error.guardReason === "runs_unsettled" || /runs_unsettled/.test(String(error.details?.guardReason ?? error.message)),
    );
    // 兼容参数不能绕过核心核对。
    await assert.rejects(
      () => s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", reason: "x", runsSettled: true }),
      (error) => /runs_unsettled|收敛/.test(String(error.details?.guardReason ?? error.message)),
    );
    await s.coordinator.cancel({ dir, runId: prepared.request.runId, reason: "测试收敛" });
    const cancelled = new RunStore(dir).readState(prepared.request.runId);
    if (cancelled === null || !["cancelled", "failed", "completed"].includes(cancelled.state)) {
      // 未认领的 planned run 没有 state：直接写终态模拟收敛。
      const now = new Date().toISOString();
      new RunStore(dir).writeState(prepared.request.runId, {
        schemaVersion: 1,
        runId: prepared.request.runId,
        taskId: task.taskId,
        phase: "implement",
        state: "cancelled",
        worker: { workerId: "w", pid: 1, bootId: "b", procStartTicks: null, hostname: "h" },
        claimedAt: now,
        updatedAt: now,
        prepared: false,
        preparedAt: null,
        snapshot: null,
        reason: "cancel_requested",
      });
    }
    const closed = await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", reason: "已收敛" });
    assert.equal(closed.outcome, "completed");
    // 未注入仓储的库调用仍须显式声明（无法自证）。
    const bare = new TaskService({ store: s.store, locks: s.locks, randomHex });
    const other = await bare.newTask({ dir, title: "库调用", slug: "bare-close", verification: "none" });
    await assert.rejects(
      () => bare.close({ dir, taskId: other.taskId, outcome: "completed" }),
      (error) => /runs_unsettled/.test(String(error.details?.guardReason ?? error.guardReason ?? error.message)),
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI resume／run resume 暴露 --no-start 与 --wait；task close 的 --runs-settled 标为兼容参数", () => {
  for (const args of [["resume", "--help"], ["run", "resume", "--help"]]) {
    const help = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--no-start/);
    assert.match(help.stdout, /--wait/);
  }
  const close = spawnSync(process.execPath, [CLI, "task", "close", "--help"], { encoding: "utf8" });
  assert.match(close.stdout, /--runs-settled\s+兼容参数/);
});
