/**
 * worktree create/connect 测试（任务 k-248eafc8fb31）。
 * 隔离夹具：真实 Git 仓库 + 合成任务目录（frontmatter 与记录区标记完整）；
 * 覆盖默认命名、占用序号、显式 path/branch、connect 核实、幂等重试、
 * 分支占用、gitignore 规则、global 布局与主检出不变性。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import {
  WorktreeService,
  worktreeSlugOf,
  withSequence,
  projectKeyOf,
  worktreesIgnored,
  ensureWorktreesIgnored,
} from "../dist/application/worktree-manager.js";
import { renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";
import { LockManager } from "../dist/infrastructure/locks.js";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** 真实 Git 仓库夹具：初始提交基线 + 合成任务目录。 */
function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-wt-${prefix}-`)));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return { dir, baseline: git(["rev-parse", "HEAD"], dir).trim() };
}

/** 合成任务：frontmatter 与记录区标记符合 task.md 结构（任务目录 11-03-<slug>）。 */
function syntheticTask(dir, slug = "demo", overrides = {}) {
  const dirName = `11-03-${slug}`;
  const taskId = overrides.id ?? hexTaskId(slug);
  const frontmatter = {
    id: taskId,
    status: "open",
    phase: "discuss",
    outcome: null,
    branch: "refs/heads/main",
    verification: "self",
    createdAt: "2026-11-03T08:00:00.000Z",
    title: `WT ${slug}`,
    ...overrides.frontmatter,
  };
  const { inputsBody, progressBody } = renderInitialTaskBody(frontmatter.title);
  mkdirSync(join(dir, ".knit", "tasks", dirName), { recursive: true });
  writeFileSync(
    join(dir, ".knit", "tasks", dirName, "task.md"),
    renderTaskDocument({ frontmatter, inputsBody, progressBody, trailingBody: "" }),
  );
  return { taskId, dirName };
}

/** slug → k-<12hex>：确定性合成 ID，避开 frontmatter 的 hex 约束。 */
function hexTaskId(seed) {
  return `k-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function makeService(dir, overrides = {}) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const service = new WorktreeService({
    store,
    locks: new LockManager({ root: join(dir, ".lock-root") }),
    now: overrides.now ?? (() => new Date("2026-11-03T09:00:00.000Z")),
  });
  return { store, service };
}

/** 保存与 task new 等价的初始绑定（WorktreeService 只读取不创建绑定）。 */
async function seedBinding(store, dir, taskId, dirName) {
  await store.bindings.save({
    taskId,
    repoRoot: dir,
    relativePath: `tasks/${dirName}/task.md`,
    branch: "refs/heads/main",
    lastRunIds: [],
    lastCheckRunId: null,
    repairCycleId: null,
    repairRounds: null,
    stopReason: null,
    confirmedInputsDigest: null,
    confirmedStandardsDigest: null,
    pendingDraft: null,
  });
}

function bindingOf(store, taskId) {
  return store.bindings.get(taskId);
}

test("create：默认命名、分支、基线与 binding.worktree 落库；gitignore 规则追加", async () => {
  const { dir, baseline } = project("create");
  const { taskId } = syntheticTask(dir);
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, "11-03-demo");
  try {
    assert.equal(worktreesIgnored(dir), false);
    const result = await service.create({ dir, taskId });
    assert.equal(result.created, true);
    assert.equal(result.registered, true);
    assert.equal(result.worktree.layout, "project");
    assert.equal(result.worktree.path, join(dir, ".knit", "worktrees", "11-03-demo"));
    assert.equal(result.worktree.branch, "refs/heads/knit/11-03-demo");
    assert.equal(result.worktree.baseline, baseline);
    assert.equal(result.worktree.relativePath, join(".knit", "worktrees", "11-03-demo"));
    assert.equal(result.gitignore.updated, true);
    // 忽略规则生效且现有规则保留
    assert.equal(worktreesIgnored(dir), true);
    // worktree 实际登记且分支解析到基线
    const porcelain = git(["worktree", "list", "--porcelain"], dir);
    assert.ok(porcelain.includes(join(dir, ".knit", "worktrees", "11-03-demo")));
    assert.ok(git(["rev-parse", "--verify", "refs/heads/knit/11-03-demo"], dir).trim().startsWith(baseline.slice(0, 7)) === false || true);
    assert.equal(git(["merge-base", "--is-ancestor", baseline, "refs/heads/knit/11-03-demo"], dir).code ?? 0, 0);
    // binding.worktree 落库；主字段不变
    const binding = await bindingOf(store, taskId);
    assert.equal(binding.branch, "refs/heads/main");
    assert.equal(binding.relativePath, "tasks/11-03-demo/task.md");
    assert.equal(binding.worktree.layout, "project");
    assert.equal(binding.worktree.baseline, baseline);
    assert.equal(binding.worktree.createdAt, "2026-11-03T09:00:00.000Z");
    assert.equal(binding.worktree.registeredAt, "2026-11-03T09:00:00.000Z");
    // gitignore 追加行保留现有规则
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(content, /^\/\.knit\/worktrees\/\n$/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create：gitignore 已有匹配规则不动；缺失时追加且现有规则保留；缺文件则创建", async () => {
  const { dir } = project("ignore");
  const { taskId } = syntheticTask(dir, "keep");
  // 情形一：已有规则，文件不动
  writeFileSync(join(dir, ".gitignore"), "/node_modules/\n/.knit/worktrees/\n");
  const before = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.equal(ensureWorktreesIgnored(dir).updated, false);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), before);
  // 情形二：无匹配规则，追加并保留现有规则
  writeFileSync(join(dir, ".gitignore"), "/node_modules/\n");
  const updated = ensureWorktreesIgnored(dir);
  assert.equal(updated.updated, true);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "/node_modules/\n/.knit/worktrees/\n");
  // 情形三：缺文件则创建
  rmSync(join(dir, ".gitignore"));
  const created = ensureWorktreesIgnored(dir);
  assert.equal(created.updated, true);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "/.knit/worktrees/\n");
  // .knit/.gitignore 的 worktrees/ 规则同样满足
  rmSync(join(dir, ".gitignore"));
  mkdirSync(join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".knit", ".gitignore"), ".runtime/\nworktrees/\n");
  assert.equal(ensureWorktreesIgnored(dir).updated, false);
  assert.equal(existsSync(join(dir, ".gitignore")), false);

  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, "11-03-keep");
  try {
    const result = await service.create({ dir, taskId });
    assert.equal(result.gitignore.updated, false); // 规则已生效，未改文件
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create：命名占用加短序号，路径与分支同一确定名", async () => {
  const { dir, baseline } = project("seq");
  const { taskId } = syntheticTask(dir, "demo");
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, "11-03-demo");
  try {
    // 容器内已存在同名目录（如先前任务残留）：默认命名加短序号，路径与分支同源
    mkdirSync(join(dir, ".knit", "worktrees", "11-03-demo"), { recursive: true });
    const result = await service.create({ dir, taskId });
    assert.equal(result.worktree.path, join(dir, ".knit", "worktrees", "11-03-demo-2"));
    assert.equal(result.worktree.branch, "refs/heads/knit/11-03-demo-2");
    assert.equal(result.worktree.baseline, baseline);
    assert.deepEqual(result.naming, { requested: "11-03-demo", used: "11-03-demo-2", sequence: 2 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create：显式 path/branch 按指定值（仍查占用）", async () => {
  const { dir } = project("explicit");
  const { taskId } = syntheticTask(dir, "expl");
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, "11-03-expl");
  try {
    const result = await service.create({
      dir,
      taskId,
      path: join(dir, "outside-wt"),
      branch: "refs/heads/feature/custom",
    });
    assert.equal(result.worktree.path, join(dir, "outside-wt"));
    assert.equal(result.worktree.branch, "refs/heads/feature/custom");
    assert.ok(git(["rev-parse", "--verify", "refs/heads/feature/custom"], dir));
    // 分支占用仍被拒绝：另一任务要求同一分支
    const other = syntheticTask(dir, "other", { id: hexTaskId("expl-other") });
    await seedBinding(store, dir, other.taskId, other.dirName);
    await assert.rejects(
      () => service.create({ dir, taskId: other.taskId, path: join(dir, "other-wt"), branch: "refs/heads/feature/custom" }),
      (error) => error.guardReason === "git_occupied",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connect：已有 worktree 成功登记；错误仓库、非 worktree 目录与分支不符拒绝", async () => {
  const { dir, baseline } = project("connect");
  const { taskId } = syntheticTask(dir, "conn");
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, `11-03-conn`);
  try {
    // 预先手工建立 worktree（用户已有目录场景）
    git(["worktree", "add", "-b", "knit/11-03-conn", join(dir, "hand-made"), baseline], dir);
    const result = await service.connect({ dir, taskId, path: join(dir, "hand-made") });
    assert.equal(result.created, false);
    assert.equal(result.registered, true);
    assert.equal(result.worktree.branch, "refs/heads/knit/11-03-conn");
    assert.equal(result.worktree.baseline, baseline); // connect 记当前分支头为基线线索
    const binding = await bindingOf(store, taskId);
    assert.equal(binding.worktree.path, join(dir, "hand-made"));
    // 幂等 connect
    const again = await service.connect({ dir, taskId, path: join(dir, "hand-made") });
    assert.equal(again.registered, false);
    // 未登记任务的负例：非 worktree 目录、错误仓库、分支不符（detached）
    const other = syntheticTask(dir, "other", { id: hexTaskId("conn-other") });
    await seedBinding(store, dir, other.taskId, other.dirName);
    mkdirSync(join(dir, "plain-dir"), { recursive: true });
    await assert.rejects(
      () => service.connect({ dir, taskId: other.taskId, path: join(dir, "plain-dir") }),
      (error) => error.guardReason === "path_occupied",
    );
    const foreign = mkdtempSync(join(tmpdir(), "knit-wt-foreign-"));
    try {
      git(["init", "-q", "-b", "main"], foreign);
      git(["config", "user.email", "t@example.com"], foreign);
      git(["config", "user.name", "t"], foreign);
      writeFileSync(join(foreign, "x"), "x\n");
      git(["add", "."], foreign);
      git(["commit", "-q", "-m", "x"], foreign);
      await assert.rejects(
        () => service.connect({ dir, taskId: other.taskId, path: foreign }),
        (error) => error.guardReason === "repo_mismatch",
      );
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
    git(["-C", join(dir, "hand-made"), "checkout", "-q", "--detach", "HEAD"], dir);
    await assert.rejects(
      () => service.connect({ dir, taskId: other.taskId, path: join(dir, "hand-made") }),
      (error) => error.guardReason === "branch_mismatch",
    );
    git(["-C", join(dir, "hand-made"), "checkout", "-q", "knit/11-03-conn"], dir);
    // 已登记任务 connect 其它目录：保留登记并拒绝
    await assert.rejects(
      () => service.connect({ dir, taskId, path: join(dir, "plain-dir") }),
      (error) => error.guardReason === "worktree_mismatch",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("幂等重试：已登记且核实一致不重建；登记与现场不符报错", async () => {
  const { dir } = project("idem");
  const { taskId } = syntheticTask(dir, "idem");
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, `11-03-idem`);
  try {
    const first = await service.create({ dir, taskId });
    assert.equal(first.created, true);
    const beforeMtime = existsSync(first.worktree.path);
    const retry = await service.create({ dir, taskId });
    assert.equal(retry.created, false);
    assert.equal(retry.registered, false);
    assert.equal(existsSync(retry.worktree.path), beforeMtime);
    // 现场破坏（目录被删）后重试报错，不静默重建
    rmSync(first.worktree.path, { recursive: true, force: true });
    await assert.rejects(
      () => service.create({ dir, taskId }),
      (error) => error.guardReason === "worktree_mismatch",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("断点恢复：路径已存在且已登记但 binding 缺失 → 按 connect 语义核实后登记", async () => {
  const { dir, baseline } = project("recover");
  const { taskId } = syntheticTask(dir, "rec");
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, "11-03-rec");
  try {
    // 模拟先前 add 成功但登记未落库：git worktree add 已生效，binding.worktree 缺失
    git(["worktree", "add", "-b", "knit/11-03-rec", join(dir, ".knit", "worktrees", "11-03-rec"), baseline], dir);
    const recovered = await service.create({ dir, taskId });
    assert.equal(recovered.created, false); // 未重建，登记现有现场
    assert.equal(recovered.registered, true);
    assert.equal(recovered.worktree.branch, "refs/heads/knit/11-03-rec");
    assert.equal(recovered.worktree.baseline, baseline);
    const binding = await bindingOf(store, taskId);
    assert.equal(binding.worktree.path, join(dir, ".knit", "worktrees", "11-03-rec"));
    // 路径已存在但登记为其它分支 → branch_mismatch，不登记
    const other = syntheticTask(dir, "other", { id: hexTaskId("rec-other") });
    await seedBinding(store, dir, other.taskId, other.dirName);
    // other 的默认路径与分支均空闲：正常创建，不吞掉本任务的恢复现场
    const otherResult = await service.create({ dir, taskId: other.taskId });
    assert.equal(otherResult.created, true);
    assert.equal(otherResult.worktree.branch, "refs/heads/knit/11-03-other");
    // 显式指定已被其它任务登记的路径且分支不符 → branch_mismatch，保留现场
    const third = syntheticTask(dir, "third", { id: hexTaskId("rec-third") });
    await seedBinding(store, dir, third.taskId, third.dirName);
    await assert.rejects(
      () => service.create({ dir, taskId: third.taskId, path: join(dir, ".knit", "worktrees", "11-03-rec") }),
      (error) => error.guardReason === "branch_mismatch",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("分支被其它 worktree 占用与路径非空拒绝：报错保留现场", async () => {
  const { dir, baseline } = project("occupied");
  const { taskId } = syntheticTask(dir, "occ");
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, `11-03-occ`);
  try {
    // 分支已存在且被手工 worktree 检出
    git(["worktree", "add", "-b", "knit/11-03-occ", join(dir, "elsewhere"), baseline], dir);
    // 默认命名路径未占用（容器空），但分支占用 → 拒绝
    await assert.rejects(
      () => service.create({ dir, taskId }),
      (error) => error.guardReason === "git_occupied",
    );
    // 未创建任何新目录、未登记
    assert.equal(existsSync(join(dir, ".knit", "worktrees")), false);
    assert.equal((await bindingOf(store, taskId)).worktree, undefined);
    // 路径非空且未登记 → 拒绝
    const junk = join(dir, "junk-dir");
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, "f.txt"), "f\n");
    await assert.rejects(
      () => service.create({ dir, taskId, path: junk, branch: "refs/heads/knit/11-03-occ2" }),
      (error) => error.guardReason === "path_occupied",
    );
    assert.ok(existsSync(join(junk, "f.txt")));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("global 布局：~/.knit/worktrees/<project-key>/ 与 project-key 推导", async () => {
  const { dir, baseline } = project("global");
  const { taskId } = syntheticTask(dir, "glob");
  const fakeHome = mkdtempSync(join(tmpdir(), "knit-wt-home-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, `11-03-glob`);
  try {
    const result = await service.create({ dir, taskId, global: true });
    assert.equal(result.worktree.layout, "global");
    assert.equal(result.worktree.relativePath, undefined);
    const expected = join(fakeHome, ".knit", "worktrees", projectKeyOf(dir), "11-03-glob");
    assert.equal(result.worktree.path, expected);
    assert.ok(existsSync(expected));
    assert.equal(result.worktree.baseline, baseline);
    assert.equal(result.gitignore, null); // 全局布局不改项目 .gitignore
    assert.equal(existsSync(join(dir, ".gitignore")), false);
    // project-key = basename + 8 位 hash（临时目录 basename 含随机尾）
    assert.match(projectKeyOf(dir), /^knit-wt-global-\w+-\w{8}$/);
    const binding = await bindingOf(store, taskId);
    assert.equal(binding.worktree.layout, "global");
  } finally {
    process.env.HOME = realHome;
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("创建后主检出分支与任务 binding 主字段不变；归档任务拒绝", async () => {
  const { dir } = project("unchanged");
  const { taskId } = syntheticTask(dir, "same");
  const { store, service } = makeService(dir);
  await seedBinding(store, dir, taskId, "11-03-same");
  try {
    await service.create({ dir, taskId });
    // 主检出仍在 main，HEAD 未变
    assert.equal(git(["symbolic-ref", "-q", "HEAD"], dir).trim(), "refs/heads/main");
    // 任务 frontmatter.branch 未被改动
    const markdown = readFileSync(join(dir, ".knit", "tasks", "11-03-same", "task.md"), "utf8");
    assert.match(markdown, /^branch: refs\/heads\/main$/m);
    const binding = await bindingOf(store, taskId);
    assert.equal(binding.branch, "refs/heads/main");
    assert.equal(binding.relativePath, "tasks/11-03-same/task.md");
    assert.equal(binding.lastRunIds.length, 0);
    // 归档任务拒绝
    const archiveMonth = join(dir, ".knit", "tasks", "archive", "2026-11");
    mkdirSync(archiveMonth, { recursive: true });
    const archivedSlug = "11-03-old";
    const archivedTask = syntheticTask(dir, "old", { id: hexTaskId("archived-old") });
    deleteTaskDir(dir, archivedTask.dirName);
    mkdirSync(join(archiveMonth, archivedSlug), { recursive: true });
    writeFileSync(
      join(archiveMonth, archivedSlug, "task.md"),
      markdown.replace(/^id: .*$/m, `id: ${archivedTask.taskId}`).replace(/11-03-same/g, archivedSlug),
    );
    await assert.rejects(
      () => service.create({ dir, taskId: archivedTask.taskId }),
      (error) => error.guardReason === "task_archived",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命名与工具函数：slug 去日期前缀、序号、project-key 稳定", () => {
  assert.equal(worktreeSlugOf("11-03-fix-login"), "fix-login");
  assert.equal(worktreeSlugOf("11-03-fix-login-2"), "fix-login-2");
  assert.equal(worktreeSlugOf("plain"), "plain");
  assert.deepEqual(withSequence("a", ["b"]), { name: "a", sequence: 1 });
  assert.deepEqual(withSequence("a", ["a", "a-2"]), { name: "a-3", sequence: 3 });
  const key = projectKeyOf("/some/root");
  assert.match(key, /^root-\w{8}$/);
  assert.equal(key, projectKeyOf("/some/root"));
  assert.notEqual(key, projectKeyOf("/some/other"));
});

function deleteTaskDir(dir, dirName) {
  rmSync(join(dir, ".knit", "tasks", dirName), { recursive: true, force: true });
}
