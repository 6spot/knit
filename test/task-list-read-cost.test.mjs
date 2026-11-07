/** task list／next 分区缓存：归档侧 O(月份) stat、分区复用、显式失效与语义等价（任务 k-3d730c8907b3）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService, markTaskListArchiveChanged, renderInitialTaskBody } from "../dist/application/task-service.js";
import { StatusService } from "../dist/application/status-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-read-cost-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeService(dir, onListIo) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const service = new TaskService({
    store,
    locks: new LockManager({ root: join(dir, ".lock-root") }),
    onListIo,
  });
  return { store, service };
}

function archiveMarkdown(overrides = {}) {
  const frontmatter = {
    id: "k-aaaaaaaaaaaa",
    status: "closed",
    stage: "deliver",
    outcome: "completed",
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    title: "归档任务",
    ...overrides,
  };
  return renderTaskDocument({
    frontmatter,
    ...renderInitialTaskBody(frontmatter.title),
    trailingBody: "",
  });
}

function writeArchive(dir, month, name, markdown) {
  const archiveDir = join(dir, ".knit", "tasks", "archive", month, name);
  mkdirSync(archiveDir, { recursive: true });
  const file = join(archiveDir, "task.md");
  writeFileSync(file, markdown);
  return file;
}

function archiveStats(events) {
  const archiveRoot = `${join(".knit", "tasks", "archive")}`;
  return events.filter(
    (event) =>
      event.kind === "stat" &&
      event.path.includes(archiveRoot) &&
      !event.path.endsWith("task.md"),
  );
}

function archiveTaskReads(events) {
  return events.filter((event) => event.kind === "read" && event.path.includes(`${join("tasks", "archive")}`) && event.path.endsWith("task.md"));
}

function archiveTaskStats(events) {
  return events.filter(
    (event) => event.kind === "stat" && event.path.includes(`${join("tasks", "archive")}`) && event.path.endsWith("task.md"),
  );
}

function activeTaskReads(events) {
  return events.filter((event) => {
    if (event.kind !== "read" || !event.path.endsWith("task.md")) return false;
    const parts = event.path.split("/");
    const index = parts.lastIndexOf("tasks");
    return index !== -1 && parts[index + 1] !== "archive";
  });
}

function cli(dir, args) {
  const env = { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") };
  return execFileSync(process.execPath, [CLI, ...args, "--dir", dir], { encoding: "utf8", env });
}

function cliJson(dir, args) {
  return JSON.parse(cli(dir, ["--json", ...args]));
}

test("分区指纹：命中不 stat／read 归档 task.md，指纹变化只重扫对应分区", async () => {
  const dir = gitProject("partition");
  let events = [];
  const { store, service } = makeService(dir, (event) => events.push(event));
  try {
    const activeA = await service.newTask({ dir, title: "活跃甲", slug: "active-a", now: new Date("2026-01-01T00:00:00Z") });
    await service.newTask({ dir, title: "活跃乙", slug: "active-b", now: new Date("2026-01-02T00:00:00Z") });
    writeArchive(dir, "2026-10", "10-01-old-a", archiveMarkdown({ id: "k-100000000001", title: "旧档案甲" }));
    writeArchive(dir, "2026-10", "10-02-old-b", archiveMarkdown({ id: "k-100000000002", title: "旧档案乙" }));
    writeArchive(dir, "2026-11", "11-01-old-c", archiveMarkdown({ id: "k-100000000003", title: "旧档案丙" }));
    writeArchive(dir, "2026-11", "11-02-old-d", archiveMarkdown({ id: "k-100000000004", title: "旧档案丁" }));

    const cold = service.list({ dir });
    assert.equal(cold.active.length, 2);
    assert.equal(cold.archived.length, 4);
    assert.ok(events.some((event) => event.kind === "read" && event.path.endsWith("task.md")), "首次读取必须读任务文件");

    events = [];
    const warm = service.list({ dir });
    assert.deepEqual(warm, cold, "缓存命中结果与首次读取一致");
    assert.equal(archiveTaskReads(events).length, 0, "命中不读取归档 task.md");
    assert.equal(archiveTaskStats(events).length, 0, "命中不 stat 归档 task.md");
    const archiveRoot = join(realpathSync(dir), ".knit", "tasks", "archive");
    const statPaths = archiveStats(events).map((event) => event.path).sort();
    assert.deepEqual(statPaths, [archiveRoot, join(archiveRoot, "2026-10"), join(archiveRoot, "2026-11")].sort(), "归档侧只 stat 根与月份目录");
    assert.equal(events.filter((event) => event.kind === "read").length, 0, "完全命中不读取任何任务文件");

    // 活跃任务就地修改：只重扫活跃分区，不读归档。
    const fileA = join(dir, ".knit", activeA.relativePath);
    const before = readFileSync(fileA, "utf8");
    writeFileSync(fileA, before.replace("活跃甲", "活跃丙"));
    utimesSync(fileA, new Date("2026-11-02T00:00:00Z"), new Date("2026-11-02T00:00:05Z"));
    events = [];
    const afterActiveEdit = service.list({ dir });
    assert.equal(afterActiveEdit.active.find((task) => task.taskId === activeA.taskId).title, "活跃丙");
    assert.equal(archiveTaskReads(events).length, 0, "活跃变化不重读归档");
    assert.equal(archiveTaskStats(events).length, 0, "活跃变化不 stat 归档 task.md");
    assert.equal(archiveStats(events).length, (2 + 1) * 2, "活跃变化只需 O(月份) 归档 stat（读取前后各一次核验）");
    assert.equal(activeTaskReads(events).length, 2, "活跃分区整体重扫两道活跃任务");

    // 归档新增：只重扫归档分区，不读活跃任务。
    writeArchive(dir, "2026-11", "11-03-new", archiveMarkdown({ id: "k-100000000005", title: "新档案" }));
    events = [];
    const afterArchiveAdd = service.list({ dir });
    assert.equal(afterArchiveAdd.archived.length, 5);
    assert.ok(afterArchiveAdd.archived.some((task) => task.taskId === "k-100000000005"));
    assert.equal(activeTaskReads(events).length, 0, "归档变化不重读活跃任务");
    assert.equal(archiveTaskReads(events).length, 5, "归档分区整体重扫五条归档");
    assert.equal(archiveTaskStats(events).length, 0, "重扫读取归档 task.md，不额外 stat");
    assert.equal(archiveStats(events).length, (2 + 1) * 2);

    assert.deepEqual(service.list({ dir }), afterArchiveAdd, "归档新增后重复读取稳定");

    // 归档目录名与指纹无关联：写一份未归档任务后再读，活跃分区只多读这一条。
    const activeC = await service.newTask({ dir, title: "活跃丁", slug: "active-c", now: new Date("2026-01-03T00:00:00Z") });
    events = [];
    const afterActiveAdd = service.list({ dir });
    assert.ok(afterActiveAdd.active.some((task) => task.taskId === activeC.taskId));
    assert.equal(archiveTaskReads(events).length, 0);
    assert.equal(activeTaskReads(events).length, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("语义等价：归档子任务参与父进度、dependency_archived 与冷／热结果逐字一致", async () => {
  const dir = gitProject("semantics");
  const { store, service } = makeService(dir);
  try {
    const parent = await service.newTask({ dir, title: "父任务", now: new Date("2026-01-01T00:00:00Z") });
    const child = await service.newTask({ dir, title: "归档子任务", parent: parent.taskId, now: new Date("2026-01-02T00:00:00Z") });

    // 无归档夹具：默认视图、--json 与 next 只含活跃事实。
    const noArchive = service.list({ dir });
    assert.equal(noArchive.archived.length, 0);
    assert.deepEqual(noArchive.problems, []);
    assert.deepEqual(noArchive.active.find((task) => task.taskId === parent.taskId).children, [child.taskId]);
    assert.deepEqual(service.next({ dir }).entries.map((entry) => [entry.taskId, entry.executable]), [
      [parent.taskId, true],
      [child.taskId, true],
    ]);

    // 归档子任务（status=open）仍参与父任务 children／openChildren。
    const monthDir = join(dir, ".knit", "tasks", "archive", "2026-11");
    mkdirSync(monthDir, { recursive: true });
    const childDir = dirname(join(dir, ".knit", child.relativePath));
    renameSync(childDir, join(monthDir, basename(childDir)));
    writeArchive(dir, "2026-10", "10-01-prerequisite", archiveMarkdown({
      id: "k-200000000001",
      status: "open",
      stage: "start",
      outcome: null,
      title: "归档前置",
    }));
    writeArchive(dir, "2026-10", "10-02-done", archiveMarkdown({ id: "k-200000000002", outcome: "completed" }));
    const dependent = await service.newTask({ dir, title: "依赖归档前置", now: new Date("2026-01-03T00:00:00Z") });
    await service.setDependencies({ dir, taskId: dependent.taskId, add: ["k-200000000001"] });
    // 损坏归档只在读取投影时记 problems，不阻断列表其余条目。
    writeArchive(dir, "2026-10", "10-03-broken", "broken-not-yaml\n");

    const warm = service.list({ dir });
    assert.equal(warm.archived.length, 3);
    assert.equal(warm.problems.length, 1);
    assert.match(warm.problems[0].path, /tasks\/archive\/2026-10\/10-03-broken\/task\.md$/);
    assert.match(warm.problems[0].message, /frontmatter/);
    const parentRow = warm.active.find((task) => task.taskId === parent.taskId);
    assert.deepEqual(parentRow.children, [child.taskId]);
    assert.deepEqual(parentRow.openChildren, [child.taskId], "归档且未结束的子任务仍计入父进度");
    const dependentRow = warm.active.find((task) => task.taskId === dependent.taskId);
    assert.deepEqual(dependentRow.blocked.map((blocker) => [blocker.taskId, blocker.problem, blocker.status, blocker.outcome]), [
      ["k-200000000001", "dependency_archived", "open", null],
    ]);
    const next = service.next({ dir });
    assert.equal(next.entries.find((entry) => entry.taskId === dependent.taskId).executable, false);
    assert.equal(next.next, parent.taskId);

    // 冷进程（CLI）重算结果与热缓存一致：默认／--archive／next 三份输出逐字段比对。
    const listPayload = cliJson(dir, ["task", "list"]).data;
    assert.deepEqual(listPayload.active, JSON.parse(JSON.stringify(warm.active)));
    assert.equal(listPayload.archivedCount, warm.archived.length);
    assert.deepEqual(listPayload.problems, warm.problems);
    const archivePayload = cliJson(dir, ["task", "list", "--archive"]).data;
    assert.deepEqual(archivePayload.archived, JSON.parse(JSON.stringify(warm.archived)));
    assert.equal(archivePayload.archivedCount, warm.archived.length);
    assert.deepEqual(archivePayload.problems, warm.problems);
    const nextPayload = cliJson(dir, ["task", "next"]).data;
    assert.deepEqual(nextPayload.entries, JSON.parse(JSON.stringify(next.entries)));
    assert.equal(nextPayload.next, next.next);

    const text = cli(dir, ["task", "list"]);
    assert.match(text, /^进行中 2 · 待归档 0 · 已取消 0 · 阻塞 1 · 归档 3（knit task list --archive）$/m);
    assert.match(text, /^列表问题（1）：$/m);
    assert.match(text, /tasks\/archive\/2026-10\/10-03-broken\/task\.md/);
    const archiveText = cli(dir, ["task", "list", "--archive"]);
    assert.match(archiveText, /^归档 2026-11（1）$/m);
    assert.match(archiveText, /^归档 2026-10（2）$/m);
    assert.match(archiveText, /归档子任务/);
    assert.match(archiveText, /归档前置/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显式失效：原地改归档不自动失效，Knit 标记／跨月移动／还原后立即生效", async () => {
  const dir = gitProject("invalidate");
  const { store, service } = makeService(dir);
  try {
    const active = await service.newTask({ dir, title: "活跃任务", now: new Date("2026-01-01T00:00:00Z") });
    const archivedFile = writeArchive(dir, "2026-10", "10-01-edit", archiveMarkdown({ id: "k-300000000001", title: "Old title" }));
    assert.equal(service.list({ dir }).archived[0].title, "Old title");
    assert.equal(service.list({ dir }).active.length, 1);

    // 已知限制：绕过 Knit 原地改已归档 task.md 不改月份目录结构，不自动失效。
    writeFileSync(archivedFile, readFileSync(archivedFile, "utf8").replace("Old title", "New title"));
    assert.equal(service.list({ dir }).archived[0].title, "Old title", "原地改写归档不自动失效（已记录限制）");

    // Knit 自身操作写显式失效标记后，下一次读取必须重算归档分区。
    markTaskListArchiveChanged(dir, "test:archive-content-changed");
    assert.ok(existsSync(join(dir, ".knit", ".runtime", "task-list", "archive.invalidation")), "显式失效标记已落盘");
    assert.equal(service.list({ dir }).archived[0].title, "New title", "显式标记使归档索引失效");

    // 跨月移动：月份目录 stat 改变，归档分区重算。
    const movedMonth = join(dir, ".knit", "tasks", "archive", "2026-11");
    mkdirSync(movedMonth, { recursive: true });
    renameSync(dirname(archivedFile), join(movedMonth, "10-01-edit"));
    const afterMonthMove = service.list({ dir });
    assert.equal(afterMonthMove.archived[0].relativePath, "tasks/archive/2026-11/10-01-edit");

    // 还原到活跃区：归档移除、活跃新增，立即反映。
    const activeTarget = join(dir, ".knit", "tasks", "10-01-edit");
    renameSync(join(movedMonth, "10-01-edit"), activeTarget);
    const afterRestore = service.list({ dir });
    assert.equal(afterRestore.archived.length, 0);
    assert.ok(afterRestore.active.some((task) => task.taskId === "k-300000000001"));
    assert.ok(afterRestore.active.some((task) => task.taskId === active.taskId));

    // 再次归档：目录结构变化，归档分区重算。
    renameSync(activeTarget, join(movedMonth, "10-01-edit"));
    const afterArchive = service.list({ dir });
    assert.equal(afterArchive.archived.length, 1);
    assert.equal(afterArchive.active.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status 概览与 task list 共用分区缓存：概览填充后列表命中不重读", async () => {
  const dir = gitProject("status-cache");
  let events = [];
  const { store, service } = makeService(dir, (event) => events.push(event));
  try {
    await service.newTask({ dir, title: "概览活跃任务", now: new Date("2026-01-01T00:00:00Z") });
    writeArchive(dir, "2026-10", "10-01-status", archiveMarkdown({ id: "k-400000000001", title: "概览归档任务" }));

    const statusService = new StatusService({ store });
    const overview = await statusService.overview(dir);
    assert.equal(overview.tasks.length, 2);
    const archivedRow = overview.tasks.find((task) => task.taskId === "k-400000000001");
    assert.equal(archivedRow.archived, true);
    assert.equal(archivedRow.relativePath, "tasks/archive/2026-10/10-01-status");

    // status 概览已填充同一分区缓存：随后 list 只做指纹 stat，不读取任何 task.md。
    events = [];
    const list = service.list({ dir });
    assert.equal(list.active.length, 1);
    assert.equal(list.archived.length, 1);
    assert.equal(events.filter((event) => event.kind === "read").length, 0, "status 概览与 list 共用缓存");
    assert.equal(archiveTaskReads(events).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("规模：数百条归档下默认 list／next 只随月份数做归档 stat，耗时诊断", async () => {
  const months = 12;
  const perMonth = 40;
  const dir = gitProject("scale");
  const events = [];
  const { store, service } = makeService(dir, (event) => events.push(event));
  try {
    for (let index = 0; index < 3; index += 1) {
      await service.newTask({ dir, title: `活跃任务 ${index}`, now: new Date(`2026-01-0${index + 1}T00:00:00Z`) });
    }
    for (let month = 1; month <= months; month += 1) {
      const label = `2026-${String(month).padStart(2, "0")}`;
      for (let index = 0; index < perMonth; index += 1) {
        const id = `k-${String(month).padStart(2, "0")}${String(index).padStart(10, "0")}`;
        writeArchive(dir, label, `${String(month).padStart(2, "0")}-01-task-${index}`, archiveMarkdown({ id, title: `归档 ${label}-${index}` }));
      }
    }
    // 冷启动填充分区缓存。
    assert.equal(service.list({ dir }).archived.length, months * perMonth);

    events.length = 0;
    const measure = (fn) => {
      const started = process.hrtime.bigint();
      const result = fn();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      return { result, elapsedMs };
    };
    const listWarm = measure(() => service.list({ dir }));
    const listEvents = [...events];
    events.length = 0;
    const nextWarm = measure(() => service.next({ dir }));
    const nextEvents = [...events];

    assert.equal(listWarm.result.archived.length, months * perMonth);
    assert.equal(archiveTaskReads(listEvents).length, 0);
    assert.equal(archiveTaskStats(listEvents).length, 0);
    assert.equal(archiveStats(listEvents).length, months + 1, "归档 stat 次数 = 根目录 + 月份目录");
    assert.equal(archiveTaskReads(nextEvents).length, 0);
    assert.equal(archiveStats(nextEvents).length, months + 1);
    assert.equal(nextWarm.result.entries.length, 3);
    console.log(
      `[规模诊断] 归档 ${months * perMonth} 条／${months} 个月：list ${listWarm.elapsedMs.toFixed(2)}ms、next ${nextWarm.elapsedMs.toFixed(2)}ms；归档 stat ${archiveStats(listEvents).length} 次，归档 task.md stat ${archiveTaskStats(listEvents).length} 次`,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
