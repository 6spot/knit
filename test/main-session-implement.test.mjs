/** 主会话实施事实：无 worker run 的完成路径与强制收口（任务 k-795f3804775e）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunStore } from "../dist/infrastructure/run-store.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const NOW = new Date("2026-11-06T12:00:00.000Z");

function gitProject(name) {
  const dir = mkdtempSync(join(tmpdir(), `knit-impl-${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  writeFileSync(join(dir, "app.txt"), "old\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeService(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const service = new TaskService({
    store,
    locks: new LockManager({ root: join(dir, ".lock-root") }),
    now: () => NOW,
    randomHex: () => "000000000001",
  });
  return { store, service };
}

test("task implement：ready 后记录实施事实即可完成，不需要 implement run", async () => {
  const dir = gitProject("record");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "record", verification: "self" });
    writeFileSync(join(dir, "app.txt"), "new\n");
    await service.ready({ dir, taskId });
    const recorded = await service.implement({
      dir,
      taskId,
      paths: ["app.txt"],
      validations: ["node --test test/app.test.mjs：1 passed"],
      summary: "主会话实施",
    });
    assert.equal(recorded.executor, "main-session");
    assert.equal(recorded.validations, 1);
    const file = new RunStore(dir).readImplementation(taskId);
    assert.equal(file?.taskId, taskId);
    assert.equal(file?.entries[0]?.path, "app.txt");
    assert.equal((await store.bindings.get(taskId)).scopeRunIds.length, 0);
    assert.equal(new RunStore(dir).readScope(taskId).entries[0].source, "main-session-implementation");
    assert.equal(recorded.stage, "implement", "self 登记不推进工作阶段");
    const closed = await service.close({ dir, taskId, outcome: "completed", runsSettled: true });
    assert.equal(closed.status, "closed");
    assert.equal(closed.outcome, "completed");
    assert.equal(closed.verification, "self");
    assert.equal(closed.forced, false);
    const completion = new RunStore(dir).readCompletion(taskId);
    assert.equal(completion?.implementedBy, "record");
    assert.equal(completion?.implementRunId, null);
    assert.equal(completion?.forced, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task implement：记录后改动成果，完成资格失效", async () => {
  const dir = gitProject("stale");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "stale", verification: "self" });
    writeFileSync(join(dir, "app.txt"), "new\n");
    await service.ready({ dir, taskId });
    await service.implement({ dir, taskId, paths: ["app.txt"], validations: ["手动检查通过"] });
    writeFileSync(join(dir, "app.txt"), "changed after record\n");
    await assert.rejects(
      () => service.close({ dir, taskId, outcome: "completed", runsSettled: true }),
      (error) => error.details?.guardReason === "implementation_stale",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task implement：输入更新清理实施记录；没有验证或路径时拒绝", async () => {
  const dir = gitProject("inputs");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "inputs", verification: "self" });
    await service.ready({ dir, taskId });
    await service.implement({ dir, taskId, paths: ["app.txt"], validations: ["检查通过"] });
    const recordPath = new RunStore(dir).implementationPath(taskId);
    assert.equal(existsSync(recordPath), true);
    await service.update({ dir, taskId, kind: "clarify", reason: "补充范围", content: "" });
    assert.equal(existsSync(recordPath), false, "输入变化清理旧实施记录");
    await assert.rejects(
      () => service.implement({ dir, taskId, paths: ["app.txt"], validations: [] }),
      (error) => error.details?.guardReason === "invalid_request",
    );
    await assert.rejects(
      () => service.implement({ dir, taskId, paths: [], validations: ["检查通过"] }),
      (error) => error.details?.guardReason === "invalid_request",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task close --force：无实施记录也能完成，凭据带原因与 forced", async () => {
  const dir = gitProject("force");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "force", verification: "self" });
    await assert.rejects(
      () => service.close({ dir, taskId, outcome: "completed", runsSettled: true, force: true }),
      (error) => error.details?.guardReason === "invalid_request",
    );
    const closed = await service.close({
      dir,
      taskId,
      outcome: "completed",
      runsSettled: true,
      force: true,
      reason: "用户要求直接收口",
    });
    assert.equal(closed.forced, true);
    const completion = new RunStore(dir).readCompletion(taskId);
    assert.equal(completion?.forced, true);
    assert.equal(completion?.forcedReason, "用户要求直接收口");
    assert.ok(completion?.unverified.some((item) => item.includes("强制")));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task close --force：independent 不能跳过正式检查", async () => {
  const dir = gitProject("force-independent");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "force-independent", verification: "independent" });
    await assert.rejects(
      () => service.close({ dir, taskId, outcome: "completed", runsSettled: true, force: true, reason: "跳过" }),
      (error) => error.details?.guardReason === "invalid_request",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：task implement 记录实施事实，task close --force 报告强制", async () => {
  const dir = gitProject("cli");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "cli", verification: "self" });
    writeFileSync(join(dir, "app.txt"), "new\n");
    await service.ready({ dir, taskId });
    const recorded = JSON.parse(
      execFileSync(process.execPath, [
        CLI,
        "--json",
        "task",
        "implement",
        taskId,
        "--path",
        "app.txt",
        "--validation",
        "手动检查通过",
        "--dir",
        dir,
      ], { encoding: "utf8" }),
    );
    assert.equal(recorded.outcome, "completed");
    assert.equal(recorded.data.validations, 1);
    const closed = JSON.parse(
      execFileSync(process.execPath, [
        CLI,
        "--json",
        "task",
        "close",
        taskId,
        "--outcome",
        "completed",
        "--runs-settled",
        "--force",
        "--reason",
        "用户要求直接收口",
        "--dir",
        dir,
      ], { encoding: "utf8" }),
    );
    assert.equal(closed.outcome, "completed");
    assert.equal(closed.data.forced, true);
    const text = execFileSync(process.execPath, [CLI, "task", "close", "--help"], { encoding: "utf8" });
    assert.match(text, /--force/);
    const record = new RunStore(dir).readImplementation(taskId);
    assert.equal(record?.validations[0], "手动检查通过");
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "new\n");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
