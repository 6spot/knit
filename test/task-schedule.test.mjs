/**
 * 任务优先级、前置依赖与稳定执行顺序（任务 k-802d3edc053c，DESIGN §3.11）。
 * 排序只读 createdAt 与 order；依赖未满足时实施入口不启动；优先级与用户指定不绕过依赖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { TaskService, TaskGuardError, locateTaskDocument } from "../dist/application/task-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { inputsDigestOf } from "../dist/contracts/task-inputs.js";

const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function gitProject(prefix, { templates = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-schedule-${prefix}-`)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  if (templates) cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  else mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeService(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".lock-root") });
  const service = new TaskService({ store, locks, randomHex });
  return { store, service, locks };
}

function guardRejects(promise, reason) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof TaskGuardError, `期望 TaskGuardError，实际 ${error}`);
    assert.equal(error.details.guardReason, reason);
    return true;
  });
}

function fileOf(dir, taskId) {
  return join(locateTaskDocument(dir, taskId).dir, "task.md");
}

function documentOf(dir, taskId) {
  return parseTaskDocument(readFileSync(fileOf(dir, taskId), "utf8"));
}

function cli(dir, ...args) {
  return execFileSync(process.execPath, [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") },
  });
}

const ids = (list) => list.active.map((task) => task.taskId);

test("默认 P2 与旧任务兼容：调度字段不改变需求摘要", async () => {
  const dir = gitProject("default");
  const { store, service } = makeService(dir);
  try {
    const other = await service.newTask({ dir, title: "其它", now: new Date("2026-01-01T00:00:00.000Z") });
    const task = await service.newTask({ dir, title: "默认", now: new Date("2026-01-02T00:00:00.000Z") });
    const frontmatter = documentOf(dir, task.taskId).frontmatter;
    assert.equal(task.priority, "P2");
    assert.equal(frontmatter.priority, "P2");
    assert.deepEqual(frontmatter.dependsOn, []);
    assert.equal(frontmatter.order, null);

    // 优先级、依赖与业务顺序是调度事实：变更不使已确认输入或检查 stale。
    const digest = inputsDigestOf(readFileSync(fileOf(dir, task.taskId), "utf8"));
    await service.setPriority({ dir, taskId: task.taskId, priority: "P0" });
    await service.setDependencies({ dir, taskId: task.taskId, add: [other.taskId] });
    await service.reorder({ dir, taskId: task.taskId, position: { top: true } });
    assert.equal(inputsDigestOf(readFileSync(fileOf(dir, task.taskId), "utf8")), digest);
    const row = service.list({ dir }).active.find((entry) => entry.taskId === task.taskId);
    assert.equal(row.priority, "P0");
    assert.deepEqual(row.dependsOn, [other.taskId]);
    assert.notEqual(row.order, null);

    // 旧记录缺 priority／dependsOn／order：按 P2、无依赖、沿用创建先后读取，不伪造。
    const legacy = await service.newTask({ dir, title: "旧任务", now: new Date("2025-12-01T00:00:00.000Z") });
    const legacyFile = fileOf(dir, legacy.taskId);
    writeFileSync(
      legacyFile,
      readFileSync(legacyFile, "utf8").replace(/^(priority|dependsOn|order):.*(?:\n\s+- .*)*\n/gm, ""),
    );
    const legacyRow = service.list({ dir }).active.find((entry) => entry.taskId === legacy.taskId);
    assert.equal(legacyRow.priority, "P2");
    assert.deepEqual(legacyRow.dependsOn, []);
    assert.equal(legacyRow.order, null);
    assert.deepEqual(legacyRow.blocked, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("执行顺序：P0→P3、同级按真实创建先后、人工调整与改名不改序", async () => {
  const dir = gitProject("order");
  const { store, service } = makeService(dir);
  try {
    const a = await service.newTask({ dir, title: "A", now: new Date("2026-01-01T00:00:00.000Z") });
    const b = await service.newTask({ dir, title: "B", now: new Date("2026-01-02T00:00:00.000Z") });
    const c = await service.newTask({ dir, title: "C", priority: "P0", now: new Date("2026-01-03T00:00:00.000Z") });
    assert.deepEqual(ids(service.list({ dir })), [c.taskId, a.taskId, b.taskId]);

    const moved = await service.reorder({ dir, taskId: b.taskId, position: { before: a.taskId } });
    assert.deepEqual(moved.order, [c.taskId, b.taskId, a.taskId]);
    assert.deepEqual(ids(service.list({ dir })), [c.taskId, b.taskId, a.taskId]);
    // 原始创建时间不被排序调整改写。
    assert.equal(documentOf(dir, a.taskId).frontmatter.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(documentOf(dir, b.taskId).frontmatter.createdAt, "2026-01-02T00:00:00.000Z");

    await service.rename({ dir, taskId: a.taskId, newSlug: "renamed", equivalent: true });
    assert.deepEqual(ids(service.list({ dir })), [c.taskId, b.taskId, a.taskId]);

    // 高优先级不受业务顺序影响：P0 的 C 即使排在末尾仍是第一项。
    await service.reorder({ dir, taskId: c.taskId, position: { bottom: true } });
    assert.deepEqual(ids(service.list({ dir })), [c.taskId, b.taskId, a.taskId]);
    assert.equal(service.next({ dir }).next, c.taskId);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("人工顺序只作用于同优先级分组：跨级参照拒绝，不改变同级或其它组先后", async () => {
  const dir = gitProject("order-scope");
  const { store, service } = makeService(dir);
  try {
    const a = await service.newTask({ dir, title: "A", priority: "P1", now: new Date("2026-01-01T00:00:00.000Z") });
    const b = await service.newTask({ dir, title: "B", priority: "P1", now: new Date("2026-01-02T00:00:00.000Z") });
    const c = await service.newTask({ dir, title: "C", priority: "P2", now: new Date("2026-01-03T00:00:00.000Z") });
    const d = await service.newTask({ dir, title: "D", priority: "P2", now: new Date("2026-01-04T00:00:00.000Z") });

    // P1 的 A 已经在 P2 的 D 之前，跨级调整没有可写的业务顺序，必须拒绝而不是把 A 移到 B 之后。
    await guardRejects(service.reorder({ dir, taskId: a.taskId, position: { before: d.taskId } }), "order_reference_priority_mismatch");
    assert.deepEqual(ids(service.list({ dir })), [a.taskId, b.taskId, c.taskId, d.taskId]);
    assert.equal(documentOf(dir, c.taskId).frontmatter.order, null);
    assert.equal(documentOf(dir, d.taskId).frontmatter.order, null);

    // 同组内调整正常生效，其它优先级完全不写入 order。
    const moved = await service.reorder({ dir, taskId: b.taskId, position: { top: true } });
    assert.deepEqual(moved.order, [b.taskId, a.taskId, c.taskId, d.taskId]);
    assert.deepEqual(ids(service.list({ dir })), [b.taskId, a.taskId, c.taskId, d.taskId]);
    assert.equal(documentOf(dir, b.taskId).frontmatter.order, 10);
    assert.equal(documentOf(dir, a.taskId).frontmatter.order, 20);
    assert.equal(documentOf(dir, c.taskId).frontmatter.order, null);
    assert.equal(documentOf(dir, d.taskId).frontmatter.order, null);

    // --bottom 是目标分组内的末尾，不是全局末尾，也不翻转其它组。
    await service.reorder({ dir, taskId: b.taskId, position: { bottom: true } });
    assert.deepEqual(ids(service.list({ dir })), [a.taskId, b.taskId, c.taskId, d.taskId]);
    assert.equal(documentOf(dir, c.taskId).frontmatter.order, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("列表与执行入口一致：父子优先级不同仍按稳定顺序展示", async () => {
  const dir = gitProject("list-consistency");
  const { store, service } = makeService(dir);
  try {
    const parent = await service.newTask({ dir, title: "父任务", now: new Date("2026-01-01T00:00:00.000Z") });
    const child = await service.newTask({ dir, title: "紧急子任务", priority: "P0", parent: parent.taskId, now: new Date("2026-01-02T00:00:00.000Z") });

    // 父子层级不覆盖优先级：子任务 P0 在父任务 P2 之前。
    assert.deepEqual(ids(service.list({ dir })), [child.taskId, parent.taskId]);
    assert.deepEqual(service.next({ dir }).entries.map((entry) => entry.taskId), [child.taskId, parent.taskId]);

    const listRows = cli(dir, "task", "list").split("\n").filter((line) => /^\s+(↳ )?P[0-3]\s+k-/.test(line));
    const listIds = listRows.map((line) => line.match(/k-[0-9a-f]{12}/)?.[0]);
    assert.deepEqual(listIds, [child.taskId, parent.taskId], "task list 行顺序与 next 相同");
    assert.match(listRows[0] ?? "", new RegExp(`\\[父任务 ${parent.taskId}\\]`), "子任务行标注父任务稳定 ID");
    assert.match(listRows[1] ?? "", /\[子任务 0\/1\]/, "父任务行标注子任务进度");

    const nextRows = cli(dir, "task", "next").split("\n").filter((line) => /^P[0-3]\s+k-/.test(line));
    assert.deepEqual(nextRows.map((line) => line.match(/k-[0-9a-f]{12}/)?.[0]), [child.taskId, parent.taskId]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("前置依赖：未完成即阻塞 ready，可诊断；完成后放行", async () => {
  const dir = gitProject("depends");
  const { store, service } = makeService(dir);
  try {
    const prerequisite = await service.newTask({ dir, title: "前置", verification: "none", now: new Date("2026-01-01T00:00:00.000Z") });
    const dependent = await service.newTask({ dir, title: "后置", now: new Date("2026-01-02T00:00:00.000Z") });
    await service.setDependencies({ dir, taskId: dependent.taskId, add: [prerequisite.taskId] });

    const blocked = service.list({ dir }).active.find((entry) => entry.taskId === dependent.taskId).blocked;
    assert.deepEqual(blocked.map((entry) => [entry.taskId, entry.problem]), [[prerequisite.taskId, "dependency_not_completed"]]);
    await guardRejects(service.ready({ dir, taskId: dependent.taskId }), "dependency_unmet");

    const next = service.next({ dir });
    assert.deepEqual(next.entries.map((entry) => [entry.taskId, entry.executable]), [
      [prerequisite.taskId, true],
      [dependent.taskId, false],
    ]);
    assert.deepEqual(next.entries.find((entry) => entry.taskId === dependent.taskId).blocked, blocked);
    assert.equal(next.next, prerequisite.taskId);

    await service.close({ dir, taskId: prerequisite.taskId, outcome: "completed", runsSettled: true });
    assert.deepEqual(service.list({ dir }).active.find((entry) => entry.taskId === dependent.taskId).blocked, []);
    const readied = await service.ready({ dir, taskId: dependent.taskId });
    assert.equal(readied.stage, "implement");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("依赖结构：自依赖、缺失与成环拒绝；取消的前置保持可诊断阻塞", async () => {
  const dir = gitProject("guards");
  const { store, service } = makeService(dir);
  try {
    const a = await service.newTask({ dir, title: "A" });
    const b = await service.newTask({ dir, title: "B" });
    await guardRejects(service.setDependencies({ dir, taskId: a.taskId, add: [a.taskId] }), "dependency_self");
    await guardRejects(service.setDependencies({ dir, taskId: a.taskId, add: ["k-000000000000"] }), "dependency_missing");
    await service.setDependencies({ dir, taskId: a.taskId, add: [b.taskId] });
    await guardRejects(service.setDependencies({ dir, taskId: b.taskId, add: [a.taskId] }), "dependency_cycle");

    // 前置被取消：永不满足，保留具体原因，不静默移除依赖。
    await service.close({ dir, taskId: b.taskId, outcome: "cancelled", runsSettled: true });
    const blocked = service.list({ dir }).active.find((entry) => entry.taskId === a.taskId).blocked;
    assert.deepEqual(blocked.map((entry) => [entry.taskId, entry.problem, entry.outcome]), [[b.taskId, "dependency_not_completed", "cancelled"]]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实施入口：优先级与用户指定都不绕过未完成依赖", async () => {
  const dir = gitProject("entry", { templates: true });
  const { store, service, locks } = makeService(dir);
  try {
    const prerequisite = await service.newTask({ dir, title: "前置", verification: "self" });
    const dependent = await service.newTask({ dir, title: "后置", verification: "self" });
    await service.ready({ dir, taskId: dependent.taskId });
    await service.setPriority({ dir, taskId: dependent.taskId, priority: "P0" });
    await service.setDependencies({ dir, taskId: dependent.taskId, add: [prerequisite.taskId] });

    const coordinator = new RunCoordinator({ store, locks, lockRoot: join(dir, ".lock-root"), prepareOnly: true, randomHex });
    await assert.rejects(
      coordinator.prepare({
        dir,
        taskId: dependent.taskId,
        phase: "implement",
        initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
        model: { runtime: "pi", provider: "test", model: "fake" },
      }),
      (error) => {
        assert.equal(error.guardReason, "dependency_unmet");
        assert.match(error.message, new RegExp(prerequisite.taskId));
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
