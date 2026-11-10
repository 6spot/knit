/**
 * 跨机 rebind（任务 k-434714cbbb68）：clone／换机后按 task.md 重建本机绑定，
 * 按 verification 回到需要证据的阶段；ready 不再无绑定时静默推进。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { StatusService } from "../dist/application/status-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunStore } from "../dist/infrastructure/run-store.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const NOW = new Date("2026-11-07T12:00:00.000Z");
let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-rebind-${prefix}-`)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(dir, "app.txt"), "old\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const service = new TaskService({
    store,
    locks: new LockManager({ root: join(dir, ".lock-root") }),
    now: () => NOW,
    randomHex,
  });
  return { store, service };
}

/** 关闭元数据库并移除 runtime，模拟 clone 后只保留 Git 内 task.md 的新机器。 */
function simulateClone(setup) {
  setup.store.close();
  rmSync(join(setup.dir, ".knit", ".runtime"), { recursive: true, force: true });
}

function cli(dir, args) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") },
  });
  let body = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = null;
  }
  return { code: result.status, body, stdout: result.stdout, stderr: result.stderr };
}

test("clone 后 self 任务 rebind：status／list 指向 rebind，降级到首个工作阶段后可 implement 并 close", async () => {
  const dir = project("self");
  const first = services(dir);
  const task = await first.service.newTask({ dir, title: "跨机自检任务", slug: "rebind-self", verification: "self" });
  await first.service.ready({ dir, taskId: task.taskId });
  const file = join(dir, ".knit", task.relativePath);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^stage: implement$/m, "stage: deliver"));
  simulateClone({ ...first, dir });

  const second = services(dir);
  try {
    const status = await new StatusService({ store: second.store }).taskStatus(dir, task.taskId);
    assert.equal(status.binding, null);
    assert.equal(status.nextAction?.kind, "binding_missing");
    assert.deepEqual(status.nextAction?.commands, [`knit task rebind ${task.taskId}`]);

    const listed = await second.service.missingBindings({ dir });
    assert.deepEqual(listed.map((entry) => entry.taskId), [task.taskId]);
    const listJson = cli(dir, ["task", "list"]);
    assert.equal(listJson.code, 0);
    assert.deepEqual(listJson.body.data.bindingMissing.map((entry) => entry.taskId), [task.taskId]);
    assert.equal(listJson.body.data.bindingMissing[0].kind, "binding_missing");
    assert.match(listJson.body.data.bindingMissing[0].stage, /^deliver$/);
    const context = cli(dir, ["context", "--task", task.taskId, "--stage", "implement"]);
    assert.equal(context.code, 0);
    assert.equal(context.body.data.nextAction?.kind, "binding_missing");

    const rebind = cli(dir, ["task", "rebind", task.taskId]);
    assert.equal(rebind.code, 0);
    assert.equal(rebind.body.data.rebound, true);
    assert.equal(rebind.body.data.originalStage, "deliver");
    assert.equal(rebind.body.data.stage, "implement");
    const after = await new StatusService({ store: second.store }).taskStatus(dir, task.taskId);
    assert.equal(after.stage, "implement");
    assert.notEqual(after.binding, null);
    assert.equal(after.binding.stageVisits?.implement ?? 0, 0, "rebind 不消耗 stageVisits");
    const record = readFileSync(file, "utf8");
    assert.match(record, /### 跨机重建本机绑定/);
    assert.match(record, /- 原阶段: deliver/);
    assert.match(record, /- 现阶段: implement（降级）/);
    assert.match(record, /- 阶段访问计数: 不消耗/);
    assert.match(record, /- 确认输入摘要: [0-9a-f]{12}/);

    writeFileSync(join(dir, "app.txt"), "new\n");
    const implemented = cli(dir, ["task", "implement", task.taskId, "--path", "app.txt", "--validation", "node --test test/app.test.mjs：1 passed"]);
    assert.equal(implemented.code, 0);
    assert.equal(implemented.body.data.paths[0], "app.txt");
    const closed = cli(dir, ["task", "close", task.taskId, "--outcome", "completed", "--reason", "跨机重建后自检通过"]);
    assert.equal(closed.code, 0);
    assert.equal(closed.body.data.status, "closed");
    assert.equal(closed.body.data.outcome, "completed");
    assert.equal(closed.body.data.verification, "self");
    assert.equal(closed.body.data.forced, false);
    assert.equal(new RunStore(dir).readCompletion(task.taskId)?.implementedBy, "record");
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clone 后 independent 任务 rebind 回到检查阶段，check run 可派发", async () => {
  const dir = project("independent");
  const first = services(dir);
  const task = await first.service.newTask({ dir, title: "跨机独立检查", slug: "rebind-independent", verification: "independent" });
  await first.service.ready({ dir, taskId: task.taskId });
  const file = join(dir, ".knit", task.relativePath);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^stage: implement$/m, "stage: deliver"));
  simulateClone({ ...first, dir });

  const second = services(dir);
  try {
    const rebind = cli(dir, ["task", "rebind", task.taskId]);
    assert.equal(rebind.code, 0);
    assert.equal(rebind.body.data.originalStage, "deliver");
    assert.equal(rebind.body.data.stage, "check");
    const record = readFileSync(file, "utf8");
    assert.match(record, /回到检查阶段 check/);
    const status = await new StatusService({ store: second.store }).taskStatus(dir, task.taskId);
    assert.equal(status.stage, "check");
    assert.equal(status.binding.stageVisits?.check ?? 0, 0, "rebind 不消耗 stageVisits");
    assert.equal(status.binding.lastCheckRunId, null);

    // 与 run check --task 相同的派发入口：在检查阶段可以发布 check run。
    const coordinator = new RunCoordinator({
      store: second.store,
      randomHex,
      now: () => NOW,
      lockRoot: join(dir, ".lock-root"),
    });
    const prepared = await coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "check",
      presentation: "local",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "test", model: "fake" },
    });
    assert.equal(prepared.request.phase, "check");
    assert.equal(prepared.request.taskId, task.taskId);
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task ready 在无绑定时报 binding_missing，不静默推进 stage；start 上 rebind 不消耗访问计数", async () => {
  const dir = project("ready");
  const first = services(dir);
  const task = await first.service.newTask({ dir, title: "无绑定就绪", slug: "rebind-ready", verification: "self" });
  simulateClone({ ...first, dir });

  const second = services(dir);
  try {
    const file = join(dir, ".knit", task.relativePath);
    const before = readFileSync(file, "utf8");
    const ready = cli(dir, ["task", "ready", task.taskId]);
    assert.equal(ready.code, 1);
    assert.equal(ready.body.reasonCode, "invalid_request");
    assert.match(ready.body.data.error, /binding_missing/);
    assert.match(ready.body.data.error, /task rebind/);
    assert.equal(readFileSync(file, "utf8"), before, "拒绝路径不改 task.md");

    const rebind = cli(dir, ["task", "rebind", task.taskId]);
    assert.equal(rebind.code, 0);
    assert.equal(rebind.body.data.originalStage, "start");
    assert.equal(rebind.body.data.stage, "start");
    const rebound = await second.store.bindings.get(task.taskId);
    assert.notEqual(rebound, null);
    assert.deepEqual(rebound.stageVisits ?? {}, {});
    const confirmed = cli(dir, ["task", "ready", task.taskId]);
    assert.equal(confirmed.code, 0);
    assert.equal(confirmed.body.data.stage, "implement");
    const binding = await second.store.bindings.get(task.taskId);
    assert.equal(binding.stageVisits?.implement ?? 0, 1, "rebind 未额外占用 implement 访问");
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task implement 在无绑定时一并重建绑定并降级，self 任务登记实施后可直接 close", async () => {
  const dir = project("implement");
  const first = services(dir);
  const task = await first.service.newTask({ dir, title: "直接登记实施", slug: "rebind-implement", verification: "self" });
  await first.service.ready({ dir, taskId: task.taskId });
  const file = join(dir, ".knit", task.relativePath);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^stage: implement$/m, "stage: deliver"));
  simulateClone({ ...first, dir });

  const second = services(dir);
  try {
    writeFileSync(join(dir, "app.txt"), "new\n");
    const implemented = cli(dir, ["task", "implement", task.taskId, "--path", "app.txt", "--validation", "手动复跑通过"]);
    assert.equal(implemented.code, 0, implemented.stderr);
    assert.equal(implemented.body.data.bindingRebuilt, true);
    assert.equal(implemented.body.data.stage, "implement");
    const record = readFileSync(file, "utf8");
    assert.match(record, /- 入口: task implement/);
    const closed = cli(dir, ["task", "close", task.taskId, "--outcome", "completed", "--reason", "实施记录已登记"]);
    assert.equal(closed.code, 0);
    assert.equal(closed.body.data.verification, "self");
    assert.equal(closed.body.data.forced, false);
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clone 后未归档 completed 的 self 任务 rebind 重开并重建资格", async () => {
  const dir = project("completed");
  const first = services(dir);
  const task = await first.service.newTask({ dir, title: "跨机完成凭据", slug: "rebind-completed", verification: "self" });
  await first.service.ready({ dir, taskId: task.taskId });
  const file = join(dir, ".knit", task.relativePath);
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace(/^status: open$/m, "status: closed")
      .replace(/^stage: implement$/m, "stage: deliver")
      .replace(/^outcome: null$/m, "outcome: completed"),
  );
  simulateClone({ ...first, dir });

  const second = services(dir);
  try {
    const status = await new StatusService({ store: second.store }).taskStatus(dir, task.taskId);
    assert.equal(status.nextAction?.kind, "binding_missing");
    const rebind = cli(dir, ["task", "rebind", task.taskId]);
    assert.equal(rebind.code, 0);
    assert.equal(rebind.body.data.originalStatus, "closed");
    assert.equal(rebind.body.data.status, "open");
    assert.equal(rebind.body.data.stage, "implement");
    const record = readFileSync(file, "utf8");
    assert.match(record, /- 原状态: closed\/completed；重开后为 open/);

    writeFileSync(join(dir, "app.txt"), "new\n");
    const implemented = cli(dir, ["task", "implement", task.taskId, "--path", "app.txt", "--validation", "重新核对通过"]);
    assert.equal(implemented.code, 0);
    const closed = cli(dir, ["task", "close", task.taskId, "--outcome", "completed", "--reason", "重建后重新收尾"]);
    assert.equal(closed.code, 0);
    assert.equal(closed.body.data.outcome, "completed");
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adopt 先补建的空绑定：rebind 补足确认摘要并按 verification 降级，不再卡在 inputs_not_confirmed", async () => {
  const dir = project("adopt-first");
  const first = services(dir);
  const task = await first.service.newTask({ dir, title: "先 adopt 再重建", slug: "rebind-adopt", verification: "self", branch: "refs/heads/main" });
  await first.service.ready({ dir, taskId: task.taskId });
  const file = join(dir, ".knit", task.relativePath);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^stage: implement$/m, "stage: deliver"));
  simulateClone({ ...first, dir });

  const second = services(dir);
  try {
    const adopted = cli(dir, ["task", "adopt", task.taskId]);
    assert.equal(adopted.code, 0);
    const empty = await second.store.bindings.get(task.taskId);
    assert.notEqual(empty, null);
    assert.equal(empty.confirmedInputsDigest, null);
    const emptyStatus = await new StatusService({ store: second.store }).taskStatus(dir, task.taskId);
    assert.equal(emptyStatus.nextAction?.kind, "binding_missing");

    const rebind = cli(dir, ["task", "rebind", task.taskId]);
    assert.equal(rebind.code, 0);
    assert.equal(rebind.body.data.rebound, true);
    assert.equal(rebind.body.data.stage, "implement");
    const repaired = await second.store.bindings.get(task.taskId);
    assert.equal(typeof repaired.confirmedInputsDigest, "string");

    writeFileSync(join(dir, "app.txt"), "new\n");
    const implemented = cli(dir, ["task", "implement", task.taskId, "--path", "app.txt", "--validation", "补足后复核通过"]);
    assert.equal(implemented.code, 0);
    const closed = cli(dir, ["task", "close", task.taskId, "--outcome", "completed", "--reason", "补足本机资格"]);
    assert.equal(closed.code, 0);
    assert.equal(closed.body.data.verification, "self");
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("桥接参数 schema 暴露 task rebind action", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "dist", "contracts", "bridge-tools.json"), "utf8"));
  const actions = schema.task.properties.action.anyOf.map((entry) => entry.const);
  assert.ok(actions.includes("rebind"));
});
