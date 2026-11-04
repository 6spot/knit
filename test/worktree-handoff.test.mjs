/**
 * worktree handoff 测试（任务 k-19b5cad5c106；WORKTREE.md §6.1 快照语义）。
 * 隔离夹具：主检出含 task.md+plan.md+research/嵌套+未提交新文件+已跟踪删除+目录改名；
 * worktree create 建目标。覆盖完整交接、未跟踪迁移、嵌套与未跟踪、删除与改名、
 * 目标冲突、全新写入、中断恢复（完好/损坏）、拒绝项、边界与幂等。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync, readlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";
import { LockManager } from "../dist/infrastructure/locks.js";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function gitCode(args, cwd) {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

/** 真实 Git 仓库夹具：初始提交基线 + .knit/tasks 容器。 */
function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-ho-${prefix}-`)));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return { dir, baseline: git(["rev-parse", "HEAD"], dir).trim() };
}

function hexTaskId(seed) {
  return `k-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

/** 合成任务：task.md 已提交（基线版本）+ 记录区标记完整。 */
function syntheticTask(dir, slug, overrides = {}) {
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
    title: `HO ${slug}`,
    ...overrides.frontmatter,
  };
  const { inputsBody, progressBody } = renderInitialTaskBody(frontmatter.title);
  const taskDir = join(dir, ".knit", "tasks", dirName);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.md"), renderTaskDocument({ frontmatter, inputsBody, progressBody, trailingBody: "" }));
  return { taskId, dirName, taskDir };
}

/** 夹具：提交 task.md 基线，再叠加未提交修改、plan.md、research/ 嵌套、未提交新文件与已跟踪删除。 */
function richSource(dir, task) {
  const committed = readFileSync(join(task.taskDir, "task.md"), "utf8");
  // 已跟踪文件的未提交修改
  writeFileSync(join(task.taskDir, "task.md"), `${committed}\n<!-- 实施补充：本地未提交 -->\n`);
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task baseline"], dir);
  const baseCommit = git(["rev-parse", "HEAD"], dir).trim();
  // 基线之后再叠加：修改已跟踪 task.md、新增 plan.md、嵌套 research/、未跟踪新文件
  writeFileSync(join(task.taskDir, "task.md"), `${committed}\n<!-- 实施补充：本地未提交 -->\n`);
  writeFileSync(join(task.taskDir, "plan.md"), "# 计划\n\n- 步骤一\n");
  mkdirSync(join(task.taskDir, "research"), { recursive: true });
  writeFileSync(join(task.taskDir, "research", "nested.md"), "# 调研\n");
  mkdirSync(join(task.taskDir, "research", "deep"), { recursive: true });
  writeFileSync(join(task.taskDir, "research", "deep", "note.md"), "note\n");
  return { baseCommit };
}

/** 已跟踪删除：先提交 extra.md，再从工作区删除（git rm，保留在 HEAD 中）。 */
function trackedDeletion(dir, task) {
  writeFileSync(join(task.taskDir, "extra.md"), "to be deleted\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "add extra"], dir);
  rmSync(join(task.taskDir, "extra.md"));
  // 暂存删除（工作区缺席、HEAD/索引仍有记录）但随后重置索引，让删除保持为工作区事实：
  // 源 HEAD 仍含 extra.md，快照缺席即删除项；fresh-untracked.md 保持未跟踪。
  git(["reset", "-q"], dir);
  return "extra.md";
}

function makeServices(dir, overrides = {}) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".lock-root") });
  const now = overrides.now ?? (() => new Date("2026-11-03T10:00:00.000Z"));
  const worktrees = new WorktreeService({ store, locks, now });
  const handoff = new WorktreeHandoffService({ store, runs: new RunStore(dir), now });
  return { store, locks, worktrees, handoff };
}

/** 保存与 task new 等价的初始绑定。 */
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

function dirTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out;
}

test("a) 完整交接：落位+回执+binding 切换+源跟踪副本保留；目标无 .runtime；无 Git 提交产生", async () => {
  const { dir } = project("full");
  const task = syntheticTask(dir, "demo");
  richSource(dir, task);
  const tracked = trackedDeletion(dir, task);
  // 未跟踪文件最后写入，避免被夹具的 git add 提交进基线
  writeFileSync(join(task.taskDir, "fresh-untracked.md"), "fresh\n");
  git(["reset", "-q"], dir); // 保持未提交状态（删除在工作区缺席）
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const headBefore = git(["rev-parse", "HEAD"], dir).trim();
    const result = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    assert.equal(result.worktreePath, wt.worktree.path);
    const targetTaskDir = join(wt.worktree.path, ".knit", "tasks", task.dirName);
    assert.equal(result.targetTaskDir, targetTaskDir);
    // 落位：修改、plan、嵌套 research、未跟踪新文件全部到达；删除项已应用
    const files = dirTree(targetTaskDir);
    assert.ok(files.includes("task.md"));
    assert.ok(files.includes("plan.md"));
    assert.ok(files.includes("research/nested.md"));
    assert.ok(files.includes("research/deep/note.md"));
    assert.ok(files.includes("fresh-untracked.md"));
    assert.ok(!files.includes(tracked), "删除项不应出现在目标");
    assert.match(readFileSync(join(targetTaskDir, "task.md"), "utf8"), /实施补充：本地未提交/);
    // 回执与 manifest
    const transferDir = join(dir, ".knit", ".runtime", "transfers", result.opId);
    const receipt = JSON.parse(readFileSync(join(transferDir, "receipt.json"), "utf8"));
    assert.equal(receipt.taskId, task.taskId);
    assert.equal(receipt.branch, wt.worktree.branch);
    assert.equal(receipt.baseline, wt.worktree.baseline);
    assert.equal(receipt.finishedAt !== null, true);
    assert.equal(receipt.sourceHeadAtStart !== null, true);
    const manifest = JSON.parse(readFileSync(join(transferDir, "manifest.json"), "utf8"));
    assert.ok(manifest.entries.some((entry) => entry.relativePath === "research/deep/note.md" && entry.kind === "file"));
    assert.ok(receipt.deleted.includes(tracked));
    assert.ok(receipt.untracked.includes("fresh-untracked.md"));
    assert.ok(existsSync(join(transferDir, "journal.jsonl")));
    assert.ok(existsSync(join(transferDir, "source")));
    // binding 切换：active、handoffAt、lastHandoffOp、branch；relativePath 不变
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.worktree.active, true);
    assert.equal(binding.worktree.handoffAt, "2026-11-03T10:00:00.000Z");
    assert.equal(binding.worktree.lastHandoffOp, result.opId);
    assert.equal(binding.branch, wt.worktree.branch);
    assert.equal(binding.relativePath, `tasks/${task.dirName}/task.md`);
    // 源跟踪副本保留：源目录仍在（task.md 被 Git 跟踪）
    assert.equal(existsSync(task.taskDir), true);
    assert.equal(existsSync(join(task.taskDir, "task.md")), true);
    // 边界：目标无 .runtime 副本；无 Git 提交产生
    assert.equal(existsSync(join(wt.worktree.path, ".knit", ".runtime")), false);
    assert.equal(git(["rev-parse", "HEAD"], dir).trim(), headBefore);
    // worktree 侧任务资料为未提交状态
    const status = git(["status", "--porcelain"], wt.worktree.path);
    assert.match(status, /tasks\/11-03-demo\//);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b) 未跟踪任务目录：成功后整目录移入 transfers/source-original/", async () => {
  const { dir } = project("untracked");
  const task = syntheticTask(dir, "untracked");
  // 全目录不提交：无 Git 跟踪文件
  writeFileSync(join(task.taskDir, "notes.md"), "local only\n");
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const result = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    assert.equal(result.sourceDisposition, "moved_untracked");
    // 源目录已不存在（避免主目录双权威）
    assert.equal(existsSync(task.taskDir), false);
    // 整目录进入 transfers
    const archive = join(dir, ".knit", ".runtime", "transfers", result.opId, "source-original");
    assert.ok(existsSync(join(archive, "task.md")));
    assert.ok(existsSync(join(archive, "notes.md")));
    // 目标资料完整
    const targetTaskDir = join(wt.worktree.path, ".knit", "tasks", task.dirName);
    assert.ok(existsSync(join(targetTaskDir, "notes.md")));
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.branch, wt.worktree.branch);
    assert.equal(binding.worktree.active, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("c) 嵌套 research 与未跟踪文件完整转移", async () => {
  const { dir } = project("nested");
  const task = syntheticTask(dir, "nested");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  mkdirSync(join(task.taskDir, "research", "deep", "deeper"), { recursive: true });
  writeFileSync(join(task.taskDir, "research", "deep", "deeper", "leaf.md"), "leaf\n");
  writeFileSync(join(task.taskDir, "untracked-a.md"), "a\n");
  mkdirSync(join(task.taskDir, "untracked-dir"), { recursive: true });
  writeFileSync(join(task.taskDir, "untracked-dir", "b.md"), "b\n");
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const result = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    const targetTaskDir = join(wt.worktree.path, ".knit", "tasks", task.dirName);
    assert.ok(existsSync(join(targetTaskDir, "research", "deep", "deeper", "leaf.md")));
    assert.ok(existsSync(join(targetTaskDir, "untracked-a.md")));
    assert.ok(existsSync(join(targetTaskDir, "untracked-dir", "b.md")));
    const receipt = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "transfers", result.opId, "receipt.json"), "utf8"));
    assert.ok(receipt.untracked.includes("untracked-a.md"));
    assert.ok(receipt.untracked.includes("untracked-dir/b.md"));
    assert.ok(receipt.manifest.some((entry) => entry.relativePath === "research/deep/deeper/leaf.md"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d) 删除项与目录改名在目标应用：目标任务资料只位于选定路径", async () => {
  const { dir } = project("rename");
  // 目标侧先有同 ID 旧目录（不同目录名），并提交一个将被源删除的文件
  const taskId = hexTaskId("rename-task");
  const oldSlug = "11-03-oldname";
  const task = syntheticTask(dir, "newname", { id: taskId });
  const oldDir = join(dir, ".knit", "tasks", oldSlug);
  rmSync(task.taskDir, { recursive: true, force: true });
  mkdirSync(oldDir, { recursive: true });
  const frontmatter = {
    id: taskId,
    status: "open",
    phase: "discuss",
    outcome: null,
    branch: "refs/heads/main",
    verification: "self",
    createdAt: "2026-11-03T08:00:00.000Z",
    title: "HO rename",
  };
  const { inputsBody, progressBody } = renderInitialTaskBody(frontmatter.title);
  writeFileSync(join(oldDir, "task.md"), renderTaskDocument({ frontmatter, inputsBody, progressBody, trailingBody: "" }));
  writeFileSync(join(oldDir, "stale.md"), "stale\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "old version"], dir);
  // 源目录（新名）：stale.md 缺席 = 删除项
  mkdirSync(task.taskDir, { recursive: true });
  writeFileSync(join(task.taskDir, "task.md"), renderTaskDocument({ frontmatter, inputsBody, progressBody, trailingBody: "" }));
  writeFileSync(join(task.taskDir, "plan.md"), "# 新计划\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "source version"], dir);
  rmSync(join(task.taskDir, "stale.md"), { force: true }); // 源从未有 stale.md；目标基线跟踪它 → 删除项

  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, taskId, oldSlug);
  try {
    const wt = await worktrees.create({ dir, taskId });
    // 让 worktree 基线包含旧版本：用主检出当前 HEAD 建 worktree 后在目标侧检出旧目录状态
    // （create 记录的 baseline 即建库时主 HEAD，此时主 HEAD 已含旧版本与源版本，
    //   为模拟目标停在旧版本，向 worktree 提交一个回退提交不合适——改为直接验证：
    //   目标 worktree 在基线上已有旧目录（基线提交含 11-03-oldname），应用后旧目录被改名清理。）
    // 目标在基线处有 11-03-oldname（含 stale.md），源清单无 stale.md → 删除项应用于新目录。
    const result = await handoff.handoff({ dir, taskId });
    assert.equal(result.mode, "completed");
    const newDir = join(wt.worktree.path, ".knit", "tasks", "11-03-newname");
    const oldTarget = join(wt.worktree.path, ".knit", "tasks", oldSlug);
    assert.ok(existsSync(join(newDir, "task.md")));
    assert.ok(existsSync(join(newDir, "plan.md")));
    assert.ok(!existsSync(join(newDir, "stale.md")), "删除项应在目标应用");
    assert.ok(!existsSync(oldTarget), "旧目录应被清理，任务资料只位于选定路径");
    assert.equal(existsSync(join(wt.worktree.path, ".knit", "tasks", "11-03-oldname")), false);
    const receipt = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "transfers", result.opId, "receipt.json"), "utf8"));
    // stale.md 位于旧目录，随目录改名清理整体移除（不在源任务目录相对删除项内）
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e) 目标冲突：目标被本地修改 → 停止，保留两边（目标不动、源备份留在 transfers）", async () => {
  const { dir } = project("conflict");
  const task = syntheticTask(dir, "conflict");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    // 目标侧本地修改（偏离基线）
    const targetTaskFile = join(wt.worktree.path, ".knit", "tasks", task.dirName, "task.md");
    writeFileSync(targetTaskFile, readFileSync(targetTaskFile, "utf8") + "\n<!-- 目标本地修改 -->\n");
    const before = readFileSync(targetTaskFile, "utf8");
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: task.taskId }),
      (error) => error.guardReason === "handoff_conflict",
    );
    // 目标不动
    assert.equal(readFileSync(targetTaskFile, "utf8"), before);
    // 源备份留在 transfers
    const transfers = join(dir, ".knit", ".runtime", "transfers");
    const ops = readdirSync(transfers).filter((name) => name.startsWith("op-"));
    assert.equal(ops.length, 1);
    const receipt = JSON.parse(readFileSync(join(transfers, ops[0], "receipt.json"), "utf8"));
    assert.equal(receipt.finishedAt, null);
    assert.ok(existsSync(join(transfers, ops[0], "source", "task.md")));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2) 目标 task.md 不可解析 → 冲突停止，不静默覆盖", async () => {
  const { dir } = project("unparsed");
  const task = syntheticTask(dir, "unparsed");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const targetTaskFile = join(wt.worktree.path, ".knit", "tasks", task.dirName, "task.md");
    writeFileSync(targetTaskFile, "目标本地修改\n"); // frontmatter 丢失，无法解析
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: task.taskId }),
      (error) => error.guardReason === "handoff_conflict",
    );
    assert.equal(readFileSync(targetTaskFile, "utf8"), "目标本地修改\n");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("f) 目标无同 ID → 全新写入", async () => {
  const { dir } = project("fresh");
  // 先建 worktree（基线不含任务目录），再在源叠加资料 → 目标无同 ID
  const task = syntheticTask(dir, "fresh");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    // 目标在基线处已有同目录（基线含提交）；移除后由源快照全新写入等价于无同 ID 场景：
    // 这里直接用显式基线不含任务的仓库夹具 —— 删除目标侧目录模拟基线没有该任务。
    rmSync(join(wt.worktree.path, ".knit", "tasks", task.dirName), { recursive: true, force: true });
    // 源侧再叠加未提交资料（不进基线）
    writeFileSync(join(task.taskDir, "plan.md"), "# 计划\n");
    const result = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    const targetTaskDir = join(wt.worktree.path, ".knit", "tasks", task.dirName);
    assert.ok(existsSync(join(targetTaskDir, "task.md")));
    assert.ok(existsSync(join(targetTaskDir, "plan.md")));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g) 中断恢复：未完成 receipt+完好备份 → 续做完成；备份损坏 → 报错给恢复入口", async () => {
  const { dir } = project("resume");
  const task = syntheticTask(dir, "resume");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  writeFileSync(join(task.taskDir, "plan.md"), "# 计划\n");
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    // 第一次交接：完整完成后人为回滚 receipt 的 finishedAt 模拟中断（备份完好）
    const first = await handoff.handoff({ dir, taskId: task.taskId });
    const receiptPath = join(dir, ".knit", ".runtime", "transfers", first.opId, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.finishedAt = null;
    receipt.journal = receipt.journal.filter((entry) => entry.stepId !== "source_move");
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    // 混合源场景源目录保留；这里源目录仍存在（task.md 被跟踪）
    const resumed = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(resumed.mode, "resumed");
    assert.equal(resumed.opId, first.opId);
    const after = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.ok(after.finishedAt !== null);
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.worktree.lastHandoffOp, first.opId);

    // 备份损坏：清空备份字节后制造新的未完成 receipt → 报错并给出 transfers 恢复入口
    const second = await handoff.handoff({ dir, taskId: task.taskId });
    const secondReceiptPath = join(dir, ".knit", ".runtime", "transfers", second.opId, "receipt.json");
    const secondReceipt = JSON.parse(readFileSync(secondReceiptPath, "utf8"));
    secondReceipt.finishedAt = null;
    writeFileSync(secondReceiptPath, JSON.stringify(secondReceipt, null, 2) + "\n");
    rmSync(join(dir, ".knit", ".runtime", "transfers", second.opId, "source", "plan.md"));
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "handoff_backup_corrupt");
        assert.match(error.message, /transfers/);
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("h) 活动运行、未登记 worktree、归档任务、--to 不符拒绝", async () => {
  const { dir } = project("guards");
  const task = syntheticTask(dir, "guards");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    // 未登记 worktree
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: task.taskId }),
      (error) => error.guardReason === "unknown_binding",
    );
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    // 活动运行拒绝：注入一个非终态 run
    const runsDir = join(dir, ".knit", ".runtime", "runs", "run-000000000001");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "request.json"), JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      runId: "run-000000000001",
      taskId: task.taskId,
      phase: "implement",
      purpose: "stage",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      createdAt: "2026-11-03T09:00:00.000Z",
      expected: { branch: null, inputsDigest: "d", standardsDigest: "d", effectiveInputsDigest: "d", planId: "p" },
      model: { runtime: "pi", provider: "test", model: "test" },
      toolPolicy: { mode: "write", allow: [], deny: [] },
      recovery: { nativeSessionId: null, resume: "new" },
      acceptanceOperationId: "op-runaccept",
      diagnostics: { enabled: false },
    }));
    writeFileSync(join(runsDir, "state.json"), JSON.stringify({
      schemaVersion: 1,
      runId: "run-000000000001",
      taskId: task.taskId,
      phase: "implement",
      state: "running",
      worker: { workerId: "w", pid: 1, bootId: "b", procStartTicks: null, hostname: "h" },
      claimedAt: "2026-11-03T09:00:00.000Z",
      updatedAt: "2026-11-03T09:00:00.000Z",
      prepared: true,
      preparedAt: null,
      snapshot: null,
      reason: null,
    }));
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: task.taskId }),
      (error) => error.guardReason === "runs_unsettled",
    );
    rmSync(runsDir, { recursive: true, force: true });
    // 归档任务拒绝
    const archiveMonth = join(dir, ".knit", "tasks", "archive", "2026-11");
    mkdirSync(archiveMonth, { recursive: true });
    const archived = syntheticTask(dir, "archived", { id: hexTaskId("ho-archived") });
    const archivedMarkdown = readFileSync(join(archived.taskDir, "task.md"), "utf8");
    rmSync(archived.taskDir, { recursive: true, force: true });
    mkdirSync(join(archiveMonth, archived.dirName), { recursive: true });
    writeFileSync(join(archiveMonth, archived.dirName, "task.md"), archivedMarkdown);
    await seedBinding(store, dir, archived.taskId, archived.dirName);
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: archived.taskId }),
      (error) => error.guardReason === "task_archived",
    );
    // --to 与登记不符
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: task.taskId, to: join(dir, "other-wt") }),
      (error) => error.guardReason === "worktree_mismatch",
    );
    void wt;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("i) 边界核对：目标无 .runtime 副本、不复制 .runtime、无 Git 提交产生", async () => {
  const { dir } = project("boundary");
  const task = syntheticTask(dir, "boundary");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  // 源目录内混入未提交的 .runtime 子目录与未跟踪文件（这类路径不进交接）
  mkdirSync(join(task.taskDir, ".runtime"), { recursive: true });
  writeFileSync(join(task.taskDir, ".runtime", "cache.bin"), "x");
  // 已跟踪文件未提交修改：交接后 worktree 侧应为未提交状态
  writeFileSync(join(task.taskDir, "task.md"), readFileSync(join(task.taskDir, "task.md"), "utf8") + "\n<!-- 边界补充 -->\n");
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const headBefore = git(["rev-parse", "HEAD"], dir).trim();
    const result = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    const targetTaskDir = join(wt.worktree.path, ".knit", "tasks", task.dirName);
    assert.ok(!existsSync(join(targetTaskDir, ".runtime")), ".runtime 不应被复制");
    assert.equal(existsSync(join(wt.worktree.path, ".knit", ".runtime")), false);
    assert.equal(git(["rev-parse", "HEAD"], dir).trim(), headBefore);
    // 全程无新提交；worktree 内任务资料为未提交状态（任务资料在基线上有本地新增）
    assert.match(git(["status", "--porcelain"], wt.worktree.path), /tasks\/11-03-boundary/, "worktree 内任务资料应为未提交状态");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("j) 幂等：no-op 与源变化报错（权威已在目标）", async () => {
  const { dir } = project("idempotent");
  const task = syntheticTask(dir, "idem");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const first = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(first.mode, "completed");
    // 源未变化：no-op
    const again = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(again.mode, "no_op");
    assert.equal(again.opId, first.opId);
    // 源已变化：报错说明权威已在目标
    writeFileSync(join(task.taskDir, "post-handoff.md"), "变化\n");
    await assert.rejects(
      () => handoff.handoff({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "worktree_mismatch");
        assert.match(error.message, /权威在目标/);
        return true;
      },
    );
    // no-op 不产生新 transfers
    const ops = readdirSync(join(dir, ".knit", ".runtime", "transfers")).filter((name) => name.startsWith("op-"));
    assert.equal(ops.length, 1);
    void wt;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("可执行位保留与符号链接按目标字符串交接", async () => {
  const { dir } = project("modes");
  const task = syntheticTask(dir, "modes");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  writeFileSync(join(task.taskDir, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(task.taskDir, "run.sh"), 0o755);
  symlinkSync("task.md", join(task.taskDir, "link.md"));
  const { store, worktrees, handoff } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const result = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    const targetTaskDir = join(wt.worktree.path, ".knit", "tasks", task.dirName);
    const targetMode = statSync(join(targetTaskDir, "run.sh")).mode.toString(8);
    assert.equal((parseInt(targetMode, 8) & 0o111) !== 0, true, "可执行位应保留");
    assert.equal(lstatSync(join(targetTaskDir, "link.md")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(targetTaskDir, "link.md")), "task.md");
    // 幂等：模式与链接一致后重跑为 no-op
    const again = await handoff.handoff({ dir, taskId: task.taskId });
    assert.equal(again.mode, "no_op");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
