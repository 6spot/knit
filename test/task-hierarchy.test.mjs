/**
 * 父子任务关系与父任务总体验收（任务 k-c5f416d61c3d，DESIGN §3.10）。
 * 关系只存子任务 frontmatter.parent（稳定 ID），父级子任务集合派生；
 * 子任务结束不自动使父任务可完成，父任务完成需子任务全部结束且有验收依据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { TaskService, TaskGuardError, locateTaskDocument } from "../dist/application/task-service.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { inputsDigestOf } from "../dist/contracts/task-inputs.js";
import { parentChainContains } from "../dist/domain/task.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-hier-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeService(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const service = new TaskService({ store, locks: new LockManager({ root: join(dir, ".lock-root") }) });
  return { store, service };
}

function guardRejects(promise, reason) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof TaskGuardError, `期望 TaskGuardError，实际 ${error}`);
    assert.equal(error.details.guardReason, reason);
    return true;
  });
}

function documentOf(dir, taskId) {
  const located = locateTaskDocument(dir, taskId);
  return parseTaskDocument(readFileSync(join(located.dir, "task.md"), "utf8"));
}

test("父子任务：创建时挂接、列表派生展示、稳定身份不受改名影响", async () => {
  const dir = gitProject("create");
  const { store, service } = makeService(dir);
  try {
    const parent = await service.newTask({ dir, title: "父任务" });
    assert.equal(parent.parent, null);
    const child = await service.newTask({ dir, title: "子任务", parent: parent.taskId });
    assert.equal(child.parent, parent.taskId);
    assert.equal(documentOf(dir, child.taskId).frontmatter.parent, parent.taskId);

    const list = service.list({ dir });
    const parentRow = list.active.find((t) => t.taskId === parent.taskId);
    const childRow = list.active.find((t) => t.taskId === child.taskId);
    assert.deepEqual(parentRow.children, [child.taskId]);
    assert.deepEqual(parentRow.openChildren, [child.taskId]);
    assert.equal(childRow.parent, parent.taskId);

    // 改名只换目录：关联按稳定 ID，不随目录名变化。
    await service.rename({ dir, taskId: child.taskId, newSlug: "renamed-child", equivalent: true });
    const afterRename = service.list({ dir });
    assert.deepEqual(afterRename.active.find((t) => t.taskId === parent.taskId).children, [child.taskId]);
    assert.equal(afterRename.active.find((t) => t.taskId === child.taskId).parent, parent.taskId);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("父子任务：挂接不改变输入摘要，解除后恢复顶层；旧任务缺 parent 字段可读", async () => {
  const dir = gitProject("attach");
  const { store, service } = makeService(dir);
  try {
    const parent = await service.newTask({ dir, title: "父任务" });
    const child = await service.newTask({ dir, title: "子任务" });
    const path = join(locateTaskDocument(dir, child.taskId).dir, "task.md");
    const before = inputsDigestOf(readFileSync(path, "utf8"));

    const attached = await service.setParent({ dir, taskId: child.taskId, parentId: parent.taskId });
    assert.equal(attached.parent, parent.taskId);
    assert.equal(attached.previous, null);
    assert.deepEqual(attached.children, [child.taskId]);
    const after = inputsDigestOf(readFileSync(path, "utf8"));
    assert.equal(after, before, "结构关系不参与需求摘要，不使检查失效");

    const detached = await service.setParent({ dir, taskId: child.taskId, parentId: null });
    assert.equal(detached.parent, null);
    assert.equal(detached.previous, parent.taskId);
    assert.equal(documentOf(dir, child.taskId).frontmatter.parent, null);

    // 旧记录没有 parent 字段：解析为顶层任务，不报结构错误。
    const legacyPath = join(dir, ".knit", "tasks", "11-04-legacy", "task.md");
    mkdirSync(join(dir, ".knit", "tasks", "11-04-legacy"));
    writeFileSync(
      legacyPath,
      readFileSync(path, "utf8"),
      "utf8",
    );
    const legacy = readFileSync(path, "utf8").replace(/parent: null\n/, "").replace(/^id: .*$/m, "id: k-0000000000aa");
    writeFileSync(legacyPath, legacy, "utf8");
    const parsed = parseTaskDocument(legacy, legacyPath);
    assert.equal(parsed.frontmatter.parent, undefined);
    assert.equal(service.list({ dir }).active.find((t) => t.taskId === "k-0000000000aa").parent, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("父子任务：拒绝自我挂接、成环、已结束的目标", async () => {
  const dir = gitProject("guards");
  const { store, service } = makeService(dir);
  try {
    const a = await service.newTask({ dir, title: "A" });
    const b = await service.newTask({ dir, title: "B", parent: a.taskId });
    const c = await service.newTask({ dir, title: "C", parent: b.taskId });

    await guardRejects(service.setParent({ dir, taskId: a.taskId, parentId: a.taskId }), "parent_cycle");
    await guardRejects(service.setParent({ dir, taskId: a.taskId, parentId: c.taskId }), "parent_cycle");
    await guardRejects(service.setParent({ dir, taskId: b.taskId, parentId: "k-ffffffffffff" }), "parent_missing");
    await guardRejects(service.newTask({ dir, title: "无父任务", parent: "k-ffffffffffff" }), "parent_missing");

    // 父任务不能自身成环：纯函数独立核对链终止与环。
    const chain = new Map([[b.taskId, a.taskId], [c.taskId, b.taskId], [a.taskId, null]]);
    assert.equal(parentChainContains(chain, c.taskId, a.taskId), true);
    assert.equal(parentChainContains(chain, a.taskId, c.taskId), false);
    assert.equal(parentChainContains(chain, c.taskId, c.taskId), false, "不把自身当环");

    // 已结束的任务不能再挂父任务；已结束的任务也不能成为父任务。
    await service.close({ dir, taskId: c.taskId, outcome: "cancelled", runsSettled: true });
    await guardRejects(service.setParent({ dir, taskId: c.taskId, parentId: a.taskId }), "child_not_open");
    await guardRejects(service.setParent({ dir, taskId: a.taskId, parentId: c.taskId }), "parent_not_open");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档一致性：归档父任务不接收新子任务，归档任务关系冻结", async () => {
  const dir = gitProject("archive");
  const { store, service } = makeService(dir);
  const archiveRoot = join(dir, ".knit", "tasks", "archive", "2026-11");
  const archive = (taskId) => {
    mkdirSync(archiveRoot, { recursive: true });
    const located = locateTaskDocument(dir, taskId);
    renameSync(located.dir, join(archiveRoot, basename(located.dir)));
  };
  try {
    const parent = await service.newTask({ dir, title: "父任务" });
    const child = await service.newTask({ dir, title: "子任务", parent: parent.taskId });

    // 取消父任务不自动结束子任务；归档后父子关联仍按稳定 ID 保留。
    await service.close({ dir, taskId: parent.taskId, outcome: "cancelled", runsSettled: true });
    archive(parent.taskId);
    assert.equal(documentOf(dir, child.taskId).frontmatter.parent, parent.taskId);
    assert.equal(service.list({ dir }).active.find((t) => t.taskId === child.taskId).parent, parent.taskId);

    await guardRejects(service.setParent({ dir, taskId: child.taskId, parentId: parent.taskId }), "parent_archived");
    await guardRejects(service.newTask({ dir, title: "新子任务", parent: parent.taskId }), "parent_archived");

    // 归档任务的关系冻结：不能事后解除关联或改挂。
    await service.close({ dir, taskId: child.taskId, outcome: "cancelled", runsSettled: true });
    archive(child.taskId);
    await guardRejects(service.setParent({ dir, taskId: child.taskId, parentId: null }), "child_archived");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("父任务总体验收：子任务未结束拒绝完成；无验收依据拒绝；给出依据后完成并留凭据", async () => {
  const dir = gitProject("accept");
  const { store, service } = makeService(dir);
  try {
    const parent = await service.newTask({ dir, title: "父任务", verification: "self" });
    const childA = await service.newTask({ dir, title: "子A", verification: "none", parent: parent.taskId });
    const childB = await service.newTask({ dir, title: "子B", verification: "none", parent: parent.taskId });

    await service.close({ dir, taskId: childA.taskId, outcome: "completed", runsSettled: true });
    assert.equal(documentOf(dir, parent.taskId).frontmatter.status, "open", "子任务完成不自动结束父任务");
    // 父任务尚未完成实施，但仍先按子任务守卫拒绝：子任务完成不自动使父任务通过。
    await guardRejects(service.close({ dir, taskId: parent.taskId, outcome: "completed", runsSettled: true }), "children_incomplete");

    await service.close({ dir, taskId: childB.taskId, outcome: "completed", runsSettled: true });
    const list = service.list({ dir });
    assert.deepEqual(list.active.find((t) => t.taskId === parent.taskId).openChildren, []);

    // 子任务全部结束但父任务自身未满足完成资格（self 未实施）。
    await assert.rejects(
      () => service.close({ dir, taskId: parent.taskId, outcome: "completed", runsSettled: true, reason: "总体验收通过" }),
      (error) => error instanceof TaskGuardError,
    );

    // 父任务按 none 验证时可直接完成，但仍必须有主会话验收依据。
    const parentNone = await service.newTask({ dir, title: "父任务2", verification: "none" });
    const childC = await service.newTask({ dir, title: "子C", verification: "none", parent: parentNone.taskId });
    await service.close({ dir, taskId: childC.taskId, outcome: "completed", runsSettled: true });
    await guardRejects(
      service.close({ dir, taskId: parentNone.taskId, outcome: "completed", runsSettled: true }),
      "parent_acceptance_missing",
    );
    const accepted = await service.close({
      dir,
      taskId: parentNone.taskId,
      outcome: "completed",
      runsSettled: true,
      reason: "核对子任务成果与整体目标：通过",
    });
    assert.equal(accepted.outcome, "completed");
    const completion = JSON.parse(
      readFileSync(join(dir, ".knit", ".runtime", "completions", `${parentNone.taskId}.json`), "utf8"),
    );
    assert.match(completion.reason, /核对子任务成果/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：task new --parent、task parent 与 list 树形展示", async () => {
  const dir = gitProject("cli");
  const { store, service } = makeService(dir);
  let parentId;
  let childId;
  try {
    const parent = await service.newTask({ dir, title: "父任务" });
    parentId = parent.taskId;
    const created = JSON.parse(
      execFileSync(process.execPath, [CLI, "--json", "task", "new", "--title", "子任务", "--parent", parentId, "--dir", dir], {
        cwd: dir,
        encoding: "utf8",
      }),
    );
    assert.equal(created.outcome, "completed");
    childId = created.data.taskId;
    assert.equal(created.data.parent, parentId);

    const detached = JSON.parse(
      execFileSync(process.execPath, [CLI, "--json", "task", "parent", childId, "--detach", "--dir", dir], {
        cwd: dir,
        encoding: "utf8",
      }),
    );
    assert.equal(detached.data.parent, null);
    assert.equal(detached.data.previous, parentId);

    execFileSync(process.execPath, [CLI, "task", "parent", childId, parentId, "--dir", dir], { cwd: dir, encoding: "utf8" });
    const listed = execFileSync(process.execPath, [CLI, "task", "list", "--dir", dir], { cwd: dir, encoding: "utf8" });
    assert.match(listed, new RegExp(`${parentId}.*\\[子任务 0/1\\]`));
    assert.match(listed, new RegExp(`↳ P2  ${childId}`));

    const childStatus = execFileSync(process.execPath, [CLI, "status", childId, "--dir", dir], { cwd: dir, encoding: "utf8" });
    assert.match(childStatus, new RegExp(`父任务: ${parentId}`));
    const parentStatus = execFileSync(process.execPath, [CLI, "status", parentId, "--dir", dir], { cwd: dir, encoding: "utf8" });
    assert.match(parentStatus, new RegExp(`子任务（0/1 已结束）: ${childId}\\[open\\]`));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
