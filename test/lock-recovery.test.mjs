/**
 * k-6f0616f3779d 崩溃锁自动回收、心跳与 unlock 可用性：真实 Git／worker 子进程与最小 Pi RPC 假实现。
 */
import { isProcessAlive, isRunSettled } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { doctor } from "../dist/application/diagnostics.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");

let counter = 0x500;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix, heartbeatIntervalMs = null) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-lockrec-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  if (heartbeatIntervalMs !== null) {
    const configPath = join(dir, ".knit", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.limits.heartbeatIntervalMs = heartbeatIntervalMs;
    config.limits.heartbeatStaleMs = Math.max(heartbeatIntervalMs * 10, 2_000);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.fake-action.json\n");
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

function prepareInput(dir, taskId) {
  return {
    dir,
    taskId,
    phase: "implement",
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
  };
}

function actionFile(dir, action) {
  const path = join(dir, ".fake-action.json");
  writeFileSync(path, JSON.stringify(action));
  return path;
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
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

/** 启动一个停在 waitFile 的阶段并等到 Pi 运行。 */
async function startHangingRun(s, dir, taskId) {
  const prepared = await s.coordinator.prepare(prepareInput(dir, taskId));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionFile(dir, {
    waitFile: ".never-signal",
    waitTimeoutMs: 120_000,
    writes: [{ path: "README.md", content: "# orphan\n" }],
    report: { summary: "不应完成", changedPaths: ["README.md"] },
  });
  // Pi 收到 prompt 后才进入 waitFile 等待（有计时器保活）；只看 stage-process running 时 prompt 可能尚未送达，
  // 此时强杀 worker 会让忽略 stdin 关闭的假 Pi 因事件循环为空而自然退出。
  const promptFile = join(dir, ".knit", ".runtime", `prompt-${prepared.request.runId}.txt`);
  process.env.KNIT_FAKE_PROMPT_FILE = promptFile;
  let started;
  try {
    started = await s.coordinator.start({ dir, runId: prepared.request.runId });
  } finally {
    delete process.env.KNIT_FAKE_PROMPT_FILE;
  }
  assert.equal(started.confirmed, true);
  const status = await waitFor(async () => {
    const current = await s.coordinator.status({ dir, runId: prepared.request.runId });
    return current.stageProcess?.state === "running" && current.stageProcess.piPid !== null ? current : null;
  }, "阶段未进入 running");
  await waitFor(() => existsSync(promptFile), "假 Pi 未收到 prompt");
  return { runId: prepared.request.runId, piPid: status.stageProcess.piPid };
}

test("SIGKILL worker 后：task new 与 resume 自动回收残留锁并成功，回收可在诊断中查到", async () => {
  const dir = project("sigkill");
  const s = services(dir);
  try {
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    const task = await s.tasks.newTask({ dir, title: "回收任务", slug: "reclaim", verification: "independent" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const old = await startHangingRun(s, dir, task.taskId);
    // 阶段 Pi 登记在执行目录锁与 Session 锁 owner 中。
    const held = s.locks.list();
    const projectEntry = held.find((entry) => entry.scope === "project" && entry.key === dir);
    const sessionEntry = held.find((entry) => entry.scope === "session");
    assert.equal(projectEntry?.owner?.attached?.[0]?.pid, old.piPid, "执行目录锁登记阶段 Pi");
    assert.equal(sessionEntry?.owner?.attached?.[0]?.pid, old.piPid, "Session 锁登记阶段 Pi");

    const launch = new RunStore(dir).readLaunch(old.runId);
    process.kill(launch.handle.pid, "SIGKILL");
    // worker 死后 fake Pi 因 stdin 关闭退出；等两者都不在。
    await waitFor(() => !isProcessAlive(launch.handle.pid) && !isProcessAlive(old.piPid), "worker／Pi 未退出");

    const stale = s.locks.list();
    assert.ok(stale.some((entry) => entry.scope === "project" && entry.processVerdict === "not_alive"));
    assert.ok(stale.some((entry) => entry.scope === "session" && entry.processVerdict === "not_alive"));
    assert.ok(stale.every((entry) => s.locks.reclaimable(entry)), "同一启动周期且确认已死：可回收");
    const report = doctor({ dir, locksRoot: join(dir, ".locks"), piBin: process.execPath });
    const lockCheck = report.checks.find((check) => check.name === "locks");
    assert.equal(lockCheck.status, "warn");
    assert.match(lockCheck.detail, /stale 2（下次取锁可自动回收 2）/);

    // 1) task new 只取 task／state 短锁，不碰工作树租约：残留租约在场也直接成功，且不回收它。
    const created = await s.tasks.newTask({ dir, title: "回收后新任务", slug: "after-reclaim" });
    assert.ok(created.taskId);
    assert.equal(s.locks.listReclaimed().length, 0, "task new 不取工作树租约");

    // 2) resume：不再要求手工 unlock；新 worker 取工作树租约时回收残留租约，
    // 阶段取得同一原生 Session 锁时自动回收旧 Session 锁。
    const resumed = await s.coordinator.resume({ dir, oldRunId: old.runId });
    assert.equal(resumed.resumed, true);
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# recovered\n" }],
      report: { summary: "恢复完成", changedPaths: ["README.md"] },
    });
    await s.coordinator.start({ dir, runId: resumed.request.runId });
    const final = await waitTerminal(s, dir, resumed.request.runId);
    assert.equal(final.state, "completed", JSON.stringify({ reason: final.reason, failure: final.result?.failureReason }));
    const reclaims = s.locks.listReclaimed();
    assert.equal(reclaims.length, 2, JSON.stringify(reclaims.map((record) => record.id)));
    const leaseReclaim = reclaims.find((record) => record.scope === "project");
    assert.ok(leaseReclaim, "工作树租约残留被新 worker 自动回收");
    assert.equal(leaseReclaim.previousOwner.action, "run.prepare");
    assert.equal(leaseReclaim.previousOwner.pid, launch.handle.pid);
    assert.equal(leaseReclaim.reclaimedBy.action, "run.prepare");
    const sessionReclaim = reclaims.find((record) => record.scope === "session");
    assert.ok(sessionReclaim, "Session 残留锁被自动回收");
    assert.equal(sessionReclaim.previousOwner.pid, launch.handle.pid);
    const events = new RunStore(dir).readEvents(resumed.request.runId);
    assert.ok(events.some((event) => event.event === "lock_reclaimed" && event.lockId === sessionReclaim.id), "新 run 事件记录回收");
    assert.equal(s.locks.list().length, 0, "无残留锁");

    // 诊断：doctor 与 knit locks --dir 均可查到回收记录。
    const after = doctor({ dir, locksRoot: join(dir, ".locks"), piBin: process.execPath });
    assert.match(after.checks.find((check) => check.name === "locks").detail, /本项目自动回收 2 次/);
    const listed = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "locks", "--locks", join(dir, ".locks"), "--dir", dir], { encoding: "utf8" }));
    assert.equal(listed.data.reclaimed.length, 2);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL worker 但阶段 Pi 仍存活：不自动回收也不收敛旧 run；Pi 结束后 run implement（prepare+start）自动回收并完成", async () => {
  const dir = project("pi-alive");
  const s = services(dir);
  try {
    process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE = "1";
    const task = await s.tasks.newTask({ dir, title: "Pi 存活", slug: "pi-alive", verification: "independent" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const old = await startHangingRun(s, dir, task.taskId);
    const launch = new RunStore(dir).readLaunch(old.runId);
    process.kill(launch.handle.pid, "SIGKILL");
    await waitFor(() => !isProcessAlive(launch.handle.pid), "worker 未退出");
    assert.equal(isProcessAlive(old.piPid), true, "Pi 忽略 stdin 关闭仍存活");

    // 任务登记不受残留租约影响；需要工作树租约的整树操作仍 lock_busy 并给出核实信息。
    const registered = await s.tasks.newTask({ dir, title: "租约残留时登记", slug: "still-registers" });
    assert.ok(registered.taskId, "task new 不取工作树租约");
    await assert.rejects(
      () => s.locks.acquire({ keys: [{ scope: "project", rawKey: dir }], action: "snapshot.restore" }),
      (error) => {
        assert.equal(error.code, "lock_busy");
        assert.equal(error.details.ownerAction, "run.prepare");
        assert.equal(error.details.ownerPid, launch.handle.pid);
        assert.equal(error.details.processVerdict, "not_alive");
        assert.equal(error.details.attachedAlive, true);
        assert.match(error.message, /进程核实=not_alive（附属进程未结束）/);
        assert.match(error.message, /下一步/);
        return true;
      },
    );
    assert.equal(s.locks.listReclaimed().length, 0, "附属进程存活时不回收");
    // 阶段 Pi 存活：残留锁不可回收（prepare 同样 lock_busy），旧 run 保持活动态。
    assert.ok(s.locks.list().every((entry) => !s.locks.reclaimable(entry)), "附属进程存活：不可回收");
    assert.equal(new RunStore(dir).readState(old.runId).state, "running", "Pi 存活时不收敛旧 run");
    try {
      process.kill(-old.piPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await waitFor(() => !isProcessAlive(old.piPid), "Pi 未退出");
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    // run implement = prepare + start：prepare 把无进程执行的旧 run 收敛为 failed 后新建 run；
    // 可回收的残留租约不判 workspace_busy，由新 worker 取租约时回收。
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    assert.equal(prepared.reused, false, "不复用 worker 已死的旧 run");
    assert.notEqual(prepared.request.runId, old.runId);
    const oldState = new RunStore(dir).readState(old.runId);
    assert.equal(oldState.state, "failed");
    assert.equal(oldState.reason, "worker_exited_before_result");
    assert.ok(new RunStore(dir).readEvents(old.runId).some((event) => event.event === "recovered_without_result" && event.by === "prepare"));
    process.env.KNIT_FAKE_ACTION = actionFile(dir, {
      writes: [{ path: "README.md", content: "# recovered\n" }],
      report: { summary: "恢复完成", changedPaths: ["README.md"] },
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.reused, false, "真实启动新 worker");
    assert.equal(started.confirmed, true);
    const final = await waitTerminal(s, dir, prepared.request.runId);
    assert.equal(final.state, "completed", JSON.stringify({ reason: final.reason, failure: final.result?.failureReason }));
    assert.ok(s.locks.listReclaimed().some((record) => record.scope === "project" && record.reclaimedBy.action === "run.prepare"));
    const events = new RunStore(dir).readEvents(prepared.request.runId);
    assert.ok(events.some((event) => event.event === "lock_reclaimed"), "worker 回收写入新 run 事件");
    assert.equal(s.locks.list().length, 0, "无残留锁");
  } finally {
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL worker 后：CLI knit run implement --wait 自动回收残留锁、收敛旧 run 并到达 completed", async () => {
  const dir = project("cli-run");
  const s = services(dir);
  try {
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    const task = await s.tasks.newTask({ dir, title: "CLI 回收", slug: "cli-reclaim", verification: "independent" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const old = await startHangingRun(s, dir, task.taskId);
    const launch = new RunStore(dir).readLaunch(old.runId);
    process.kill(launch.handle.pid, "SIGKILL");
    await waitFor(() => !isProcessAlive(launch.handle.pid) && !isProcessAlive(old.piPid), "worker／Pi 未退出");
    assert.ok(s.locks.list().length > 0, "残留锁存在");

    const action = actionFile(dir, {
      writes: [{ path: "README.md", content: "# cli recovered\n" }],
      report: { summary: "CLI 恢复完成", changedPaths: ["README.md"] },
    });
    const output = execFileSync(
      process.execPath,
      [CLI, "--json", "run", "implement", "--task", task.taskId, "--local", "--provider", "fake", "--model", "fake-model", "--wait", "--locks", join(dir, ".locks"), "--dir", dir],
      { cwd: dir, encoding: "utf8", env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_ACTION: action }, timeout: 60_000 },
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.outcome, "completed");
    assert.notEqual(parsed.data.request.runId, old.runId, "新建 run，不复用无进程的旧 run");
    assert.equal(parsed.data.reused, false);
    assert.equal(parsed.data.status.state, "completed");
    assert.equal(new RunStore(dir).readState(old.runId).state, "failed", "旧 run 按 resume 语义收敛");
    assert.ok(s.locks.listReclaimed().some((record) => record.scope === "project" && record.reclaimedBy.action === "run.prepare"));
    assert.ok(s.locks.listReclaimed().some((record) => record.scope === "session"), "新阶段回收旧 Session 锁");
    assert.equal(s.locks.list().length, 0, "无残留锁");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("心跳在长阶段中前进；doctor 与 knit locks 区分心跳正常与超时", async () => {
  const dir = project("heartbeat", 100);
  const s = services(dir);
  try {
    delete process.env.KNIT_FAKE_IGNORE_STDIN_CLOSE;
    const task = await s.tasks.newTask({ dir, title: "心跳", slug: "heartbeat", verification: "independent" });
    await s.tasks.ready({ dir, taskId: task.taskId });
    const run = await startHangingRun(s, dir, task.taskId);
    const first = s.locks.list();
    const project0 = first.find((entry) => entry.scope === "project").owner.heartbeatAt;
    const session0 = first.find((entry) => entry.scope === "session").owner.heartbeatAt;
    await waitFor(() => {
      const now = s.locks.list();
      const projectNow = now.find((entry) => entry.scope === "project")?.owner?.heartbeatAt;
      const sessionNow = now.find((entry) => entry.scope === "session")?.owner?.heartbeatAt;
      return projectNow > project0 && sessionNow > session0;
    }, "执行目录锁与 Session 锁心跳都应前进");
    const fresh = doctor({ dir, locksRoot: join(dir, ".locks"), piBin: process.execPath }).checks.find((check) => check.name === "locks");
    assert.match(fresh.detail, /alive 2（心跳正常 2，心跳超 2000ms 0）/);
    const listed = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "locks", "--locks", join(dir, ".locks"), "--dir", dir], { encoding: "utf8" }));
    assert.equal(listed.data.entries.length, 2, "--dir 列出本项目执行目录锁与本项目阶段 Session 锁");
    assert.ok(listed.data.entries.every((entry) => entry.heartbeat === "fresh"));

    // 心跳超时（另一持锁者停止刷新）：只标可疑，仍 alive，不回收。
    const frozen = new LockManager({ root: join(dir, ".locks"), now: () => new Date(Date.now() - 60_000) });
    const stuck = await frozen.acquire({ keys: [{ scope: "task", rawKey: `${dir}::k-frozen` }], action: "frozen" });
    const report = doctor({ dir, locksRoot: join(dir, ".locks"), piBin: process.execPath }).checks.find((check) => check.name === "locks");
    assert.equal(report.status, "warn");
    assert.match(report.detail, /心跳正常 2，心跳超 2000ms 1: task\/[0-9a-f]{32}/);
    const listedStale = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "locks", "--locks", join(dir, ".locks"), "--dir", dir], { encoding: "utf8" }));
    const staleEntry = listedStale.data.entries.find((entry) => entry.scope === "task");
    assert.equal(staleEntry.heartbeat, "stale");
    assert.equal(staleEntry.processVerdict, "alive");
    assert.equal(staleEntry.reclaimable, false);
    frozen.release(stuck);

    writeFileSync(join(dir, ".never-signal"), "go\n");
    await waitTerminal(s, dir, run.runId);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
