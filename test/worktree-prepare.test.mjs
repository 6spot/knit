/**
 * worktree prepare 测试（任务 k-e48b7df14115；WORKTREE.md §6.7 公共资料与环境准备）。
 * 隔离夹具：临时仓库 + worktree create + config.worktree。覆盖完整 prepare、
 * 目标本地修改停止、目标缺失落位、符号链接停止、目标越界拒绝、白名单外不复制、
 * 步骤失败即停、中断恢复与 --rerun、幂等 no-op、拒绝项、边界与目录递归展开。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreePrepareService } from "../dist/application/worktree-prepare.js";
import { parseConfig } from "../dist/application/config.js";
import { renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";
import { LockManager } from "../dist/infrastructure/locks.js";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function hexTaskId(seed) {
  return `k-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

/** 真实 Git 仓库夹具：初始提交基线 + .knit/tasks 容器（无 config，按需写入）。 */
function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-wp-${prefix}-`)));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return { dir, baseline: git(["rev-parse", "HEAD"], dir).trim() };
}

/** 合成任务：task.md 已提交，frontmatter 与记录区标记完整。 */
function syntheticTask(dir, slug, overrides = {}) {
  const dirName = `11-03-${slug}`;
  const taskId = overrides.id ?? hexTaskId(`wp-${slug}`);
  const frontmatter = {
    id: taskId,
    status: "open",
    phase: "discuss",
    outcome: null,
    branch: "refs/heads/main",
    verification: "self",
    createdAt: "2026-11-03T08:00:00.000Z",
    title: `WP ${slug}`,
    ...overrides.frontmatter,
  };
  const { inputsBody, progressBody } = renderInitialTaskBody(frontmatter.title);
  const taskDir = join(dir, ".knit", "tasks", dirName);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.md"), renderTaskDocument({ frontmatter, inputsBody, progressBody, trailingBody: "" }));
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "task"], dir);
  return { taskId, dirName, taskDir };
}

/** 项目 config：完整必需节 + 指定 worktree 节。 */
function makeConfig(worktree) {
  return {
    schemaVersion: 1,
    client: { default: "pi" },
    agent: { runtime: "pi", resume: "prefer" },
    execution: { host: "local" },
    delivery: { mode: "local" },
    workflow: { maxRepairRounds: 2 },
    limits: {
      heartbeatIntervalMs: 5000,
      heartbeatStaleMs: 30000,
      cancelGraceMs: 5000,
      snapshotsMaxBytes: 67108864,
      storageWarnBytes: 536870912,
    },
    ...(worktree === undefined ? {} : { worktree }),
  };
}

function writeConfig(dir, worktree) {
  writeFileSync(join(dir, ".knit", "config.json"), JSON.stringify(makeConfig(worktree), null, 2) + "\n");
}

function makeServices(dir, overrides = {}) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".lock-root") });
  const now = overrides.now ?? (() => new Date("2026-11-03T12:00:00.000Z"));
  const worktrees = new WorktreeService({ store, locks, now });
  const prepare = new WorktreePrepareService({ store, locks, now });
  return { store, locks, worktrees, prepare };
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

function receiptJson(dir, opId) {
  return JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "worktree-prepare", opId, "receipt.json"), "utf8"));
}

function manifestJson(dir, opId) {
  return JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "worktree-prepare", opId, "manifest.json"), "utf8"));
}

function journalLines(dir, opId) {
  const raw = readFileSync(join(dir, ".knit", ".runtime", "worktree-prepare", opId, "journal.jsonl"), "utf8");
  return raw.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function prepareOpIds(dir) {
  const root = join(dir, ".knit", ".runtime", "worktree-prepare");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith("op-"));
}

test("a) 完整 prepare：白名单复制+步骤执行+回执+binding.preparedAt；复制保留源文件；无 Git 提交产生", async () => {
  const { dir } = project("full");
  const task = syntheticTask(dir, "full");
  // 已提交基线文件：源随后未提交修改（目标=基线 → 应用源快照）
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "shared.md"), "shared v1\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "shared baseline"], dir);
  writeFileSync(join(dir, "docs", "shared.md"), "shared v2\n");
  // 基线之外的未跟踪本机文件：目标缺失 → 落位
  writeFileSync(join(dir, "toolrc.local"), "tool=1\n");
  writeConfig(dir, {
    copy: [{ path: "docs/shared.md" }, { path: "toolrc.local" }],
    postCreate: [{ name: "init", command: "echo prepared > prepared.log" }],
  });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const headAtCreate = git(["rev-parse", "HEAD"], dir).trim();
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const headBefore = git(["rev-parse", "HEAD"], dir).trim();
    const result = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    assert.equal(result.copied, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.worktreePath, wt.worktree.path);
    assert.equal(result.finishedAt, "2026-11-03T12:00:00.000Z");
    // 落位：基线一致的文件应用源快照，缺失文件直接落位；源文件保留在主检出
    assert.equal(readFileSync(join(wt.worktree.path, "docs", "shared.md"), "utf8"), "shared v2\n");
    assert.equal(readFileSync(join(wt.worktree.path, "toolrc.local"), "utf8"), "tool=1\n");
    assert.equal(readFileSync(join(dir, "docs", "shared.md"), "utf8"), "shared v2\n", "复制保留源文件");
    // 步骤在目标 worktree 执行
    assert.equal(readFileSync(join(wt.worktree.path, "prepared.log"), "utf8"), "prepared\n");
    assert.equal(existsSync(join(dir, "prepared.log")), false, "步骤不得在主检出现场执行");
    // 回执：manifest 逐项来源/目标/基线指纹/源指纹/结果
    const receipt = receiptJson(dir, result.opId);
    assert.equal(receipt.taskId, task.taskId);
    assert.equal(receipt.baseline, headAtCreate, "基线取 create 时主检出 HEAD");
    assert.equal(receipt.branch, wt.worktree.branch);
    assert.ok(receipt.finishedAt !== null);
    assert.ok(typeof receipt.manifestSha256 === "string" && receipt.manifestSha256.length === 64);
    const manifest = manifestJson(dir, result.opId);
    assert.equal(manifest.entries.length, 2);
    const sharedEntry = manifest.entries.find((entry) => entry.target === "docs/shared.md");
    assert.equal(sharedEntry.source, "docs/shared.md");
    assert.equal(sharedEntry.baselineSha256, createHash("sha256").update("shared v1\n").digest("hex"));
    assert.equal(sharedEntry.sourceSha256, createHash("sha256").update("shared v2\n").digest("hex"));
    assert.equal(sharedEntry.result, "copied");
    const localEntry = manifest.entries.find((entry) => entry.target === "toolrc.local");
    assert.equal(localEntry.baselineSha256, null, "基线缺失路径指纹为 null");
    // journal 覆盖 plan/copy/verify/步骤/finish
    const steps = journalLines(dir, result.opId);
    assert.ok(steps.some((line) => line.stepId === "plan" && line.kind === "planned"));
    assert.ok(steps.some((line) => line.stepId === "copy" && line.kind === "applied"));
    assert.ok(steps.some((line) => line.stepId === "init" && line.kind === "planned"));
    assert.ok(steps.some((line) => line.stepId === "init" && line.kind === "applied" && line.exit === 0));
    assert.ok(steps.some((line) => line.stepId === "finish" && line.kind === "completed"));
    // binding 更新：preparedAt + lastPrepareOp；主字段不变
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.worktree.preparedAt, "2026-11-03T12:00:00.000Z");
    assert.equal(binding.worktree.lastPrepareOp, result.opId);
    assert.equal(binding.branch, "refs/heads/main", "不改分支");
    // 边界：无 Git 提交产生
    assert.equal(git(["rev-parse", "HEAD"], dir).trim(), headBefore);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b) 目标被本地修改 → 停止报告，保留两边（op 创建前停止，现场不被触碰）", async () => {
  const { dir } = project("conflict");
  const task = syntheticTask(dir, "conflict");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "shared.md"), "shared\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "shared"], dir);
  writeConfig(dir, { copy: [{ path: "docs/shared.md" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const targetFile = join(wt.worktree.path, "docs", "shared.md");
    writeFileSync(targetFile, "local edit\n");
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "prepare_conflict");
        assert.match(error.message, /本地修改/);
        return true;
      },
    );
    // 两边保留：目标本地修改不被覆盖，源文件原样
    assert.equal(readFileSync(targetFile, "utf8"), "local edit\n");
    assert.equal(readFileSync(join(dir, "docs", "shared.md"), "utf8"), "shared\n");
    assert.equal(prepareOpIds(dir).length, 0, "规划期停止不创建 op");
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.worktree.preparedAt, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("c) 目标不存在 → 复制落位（.env 等本机文件显式列入才复制）", async () => {
  const { dir } = project("absent");
  const task = syntheticTask(dir, "absent");
  writeFileSync(join(dir, ".env"), "SECRET=local-only\n");
  writeConfig(dir, { copy: [{ path: ".env" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    assert.equal(existsSync(join(wt.worktree.path, ".env")), false, "create 后目标缺失");
    const result = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    assert.equal(readFileSync(join(wt.worktree.path, ".env"), "utf8"), "SECRET=local-only\n");
    // 未列入白名单的本机文件不复制
    writeFileSync(join(dir, ".env.local"), "OTHER=1\n");
    assert.equal(existsSync(join(wt.worktree.path, ".env.local")), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d) 符号链接条目 → 停止报告（条目级与目录展开内均停止）", async () => {
  const { dir } = project("symlink");
  const task = syntheticTask(dir, "symlink");
  writeFileSync(join(dir, "real.txt"), "real\n");
  symlinkSync("real.txt", join(dir, "link.txt"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "a.txt"), "a\n");
  symlinkSync("../real.txt", join(dir, "assets", "nested-link.txt"));
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    // 条目级符号链接
    writeConfig(dir, { copy: [{ path: "link.txt" }] });
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "prepare_conflict");
        assert.match(error.message, /符号链接/);
        return true;
      },
    );
    // 目录展开内符号链接
    writeConfig(dir, { copy: [{ path: "assets" }] });
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "prepare_conflict");
        assert.match(error.message, /nested-link\.txt/);
        return true;
      },
    );
    assert.equal(prepareOpIds(dir).length, 0);
    assert.equal(existsSync(join(wt.worktree.path, "link.txt")), false);
    assert.equal(existsSync(join(wt.worktree.path, "assets")), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e) target 越界（../）与绝对路径 → 拒绝", async () => {
  const { dir } = project("escape");
  const task = syntheticTask(dir, "escape");
  writeFileSync(join(dir, "shared.txt"), "shared\n");
  writeConfig(dir, { copy: [{ path: "shared.txt", target: "../outside.txt" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "prepare_path_escape");
        return true;
      },
    );
    assert.equal(existsSync(join(dir, "outside.txt")), false, "越界目标不得落盘");
    assert.equal(existsSync(join(wt.worktree.path, "outside.txt")), false);
    // 绝对路径目标同样拒绝
    writeConfig(dir, { copy: [{ path: "shared.txt", target: "/tmp/knit-escape-absolute.txt" }] });
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => error.guardReason === "prepare_path_escape",
    );
    // 来源越界同样拒绝
    writeConfig(dir, { copy: [{ path: "../main-secret.txt" }] });
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => error.guardReason === "prepare_path_escape",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("f) 未列入白名单的本机文件不复制", async () => {
  const { dir } = project("whitelist");
  const task = syntheticTask(dir, "whitelist");
  writeFileSync(join(dir, "listed.txt"), "listed\n");
  writeFileSync(join(dir, "secret.env"), "SECRET=1\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  writeConfig(dir, { copy: [{ path: "listed.txt" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const result = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    assert.equal(result.copied, 1);
    assert.ok(existsSync(join(wt.worktree.path, "listed.txt")));
    assert.equal(existsSync(join(wt.worktree.path, "secret.env")), false);
    assert.equal(existsSync(join(wt.worktree.path, "other.txt")), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g) 步骤失败即停 + journal 完整 + 已成功步骤保留 + 恢复入口", async () => {
  const { dir } = project("stepfail");
  const task = syntheticTask(dir, "stepfail");
  writeConfig(dir, {
    copy: [],
    postCreate: [
      { name: "ok", command: "echo ok > ok.log" },
      { name: "boom", command: "echo boom >&2; exit 3" },
      { name: "never", command: "echo never > never.log" },
    ],
  });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "prepare_step_failed");
        assert.match(error.message, /boom/);
        assert.match(error.message, /worktree-prepare/, "报告恢复入口（回执目录）");
        assert.match(error.message, /--rerun boom/);
        return true;
      },
    );
    const opId = prepareOpIds(dir)[0];
    // 已成功步骤保留，失败后步骤未执行
    assert.ok(existsSync(join(wt.worktree.path, "ok.log")));
    assert.equal(existsSync(join(wt.worktree.path, "never.log")), false);
    // journal 完整：planned+applied(ok)、planned+failed(boom)、无 never
    const steps = journalLines(dir, opId);
    assert.ok(steps.some((line) => line.stepId === "ok" && line.kind === "applied" && line.exit === 0));
    const boomFailed = steps.find((line) => line.stepId === "boom" && line.kind === "failed");
    assert.ok(boomFailed, "boom 有 failed journal");
    assert.equal(boomFailed.exit, 3);
    assert.match(boomFailed.stderr, /boom/);
    assert.ok(!steps.some((line) => line.stepId === "never"));
    // 回执：boom=failed，never=pending，未完成
    const receipt = receiptJson(dir, opId);
    assert.equal(receipt.finishedAt, null);
    assert.equal(receipt.steps.find((step) => step.name === "ok").outcome, "success");
    assert.equal(receipt.steps.find((step) => step.name === "boom").outcome, "failed");
    assert.equal(receipt.steps.find((step) => step.name === "never").outcome, "pending");
    // 绑定不更新
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.worktree.preparedAt, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("h) 中断恢复：未完成 op 续做，已复制/已成功跳过；--rerun 单步重跑", async () => {
  const { dir } = project("resume");
  const task = syntheticTask(dir, "resume");
  writeFileSync(join(dir, "one.txt"), "one\n");
  writeFileSync(join(dir, "two.txt"), "two\n");
  writeConfig(dir, {
    copy: [{ path: "one.txt" }, { path: "two.txt" }],
    postCreate: [
      { name: "step1", command: "echo a >> counter.txt" },
      { name: "step2", command: "echo b >> counter.txt" },
    ],
  });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const first = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(first.mode, "completed");
    // 模拟中断：finish 前崩溃——回退 finishedAt 与步骤2结果、绑定未更新、抹去一份已复制目标
    const receiptPath = join(dir, ".knit", ".runtime", "worktree-prepare", first.opId, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.finishedAt = null;
    receipt.steps.find((step) => step.name === "step2").outcome = "pending";
    receipt.steps.find((step) => step.name === "step2").exit = null;
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    const binding = await store.bindings.get(task.taskId);
    await store.bindings.save({ ...binding, worktree: { ...binding.worktree, preparedAt: null, lastPrepareOp: null } });
    rmSync(join(wt.worktree.path, "two.txt"));
    // counter.txt 回退到仅 step1 已执行的状态（step2 的副作用按未发生处理）
    writeFileSync(join(wt.worktree.path, "counter.txt"), "a\n");
    assert.equal(readFileSync(join(wt.worktree.path, "counter.txt"), "utf8"), "a\n");

    const resumed = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(resumed.mode, "resumed");
    assert.equal(resumed.opId, first.opId);
    // 已复制项按指纹跳过；被抹去的重新落位
    assert.equal(resumed.copied, 1);
    assert.equal(resumed.skipped, 1);
    assert.equal(readFileSync(join(wt.worktree.path, "one.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(wt.worktree.path, "two.txt"), "utf8"), "two\n");
    // 已成功步骤不盲目重跑：counter.txt 不重复出现 "a"；未记录步骤继续执行
    assert.equal(readFileSync(join(wt.worktree.path, "counter.txt"), "utf8"), "a\nb\n");
    // 收尾：回执与绑定更新
    const after = receiptJson(dir, first.opId);
    assert.ok(after.finishedAt !== null);
    const bindingAfter = await store.bindings.get(task.taskId);
    assert.equal(bindingAfter.worktree.lastPrepareOp, first.opId);
    assert.ok(bindingAfter.worktree.preparedAt !== null);

    // --rerun 单步重跑：再次制造未完成 op，强制重跑 step1（外部副作用按实际状态决定）
    const second = JSON.parse(readFileSync(receiptPath, "utf8"));
    second.finishedAt = null;
    writeFileSync(receiptPath, JSON.stringify(second, null, 2) + "\n");
    await store.bindings.save({ ...bindingAfter, worktree: { ...bindingAfter.worktree, preparedAt: null, lastPrepareOp: null } });
    const rerun = await prepare.prepare({ dir, taskId: task.taskId, rerun: "step1" });
    assert.equal(rerun.mode, "resumed");
    assert.equal(readFileSync(join(wt.worktree.path, "counter.txt"), "utf8"), "a\nb\na\n", "step1 被显式重跑");
    assert.equal(readFileSync(join(wt.worktree.path, "counter.txt").replace("counter.txt", "one.txt"), "utf8"), "one\n");
    // --rerun 未知步骤拒绝
    const third = JSON.parse(readFileSync(receiptPath, "utf8"));
    third.finishedAt = null;
    writeFileSync(receiptPath, JSON.stringify(third, null, 2) + "\n");
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId, rerun: "nope" }),
      (error) => error.guardReason === "prepare_unknown_step",
    );

    // 收尾崩溃窗口：回执已完成但绑定更新被中断 → 认领已完成回执，不盲目重跑步骤
    // （上一步拒绝把回执留成了未完成态，先恢复为已完成）
    const completed = JSON.parse(readFileSync(receiptPath, "utf8"));
    completed.finishedAt = "2026-11-03T12:00:00.000Z";
    writeFileSync(receiptPath, JSON.stringify(completed, null, 2) + "\n");
    const counterBefore = readFileSync(join(wt.worktree.path, "counter.txt"), "utf8");
    const bindingNow = await store.bindings.get(task.taskId);
    await store.bindings.save({ ...bindingNow, worktree: { ...bindingNow.worktree, preparedAt: null, lastPrepareOp: null } });
    const adopted = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(adopted.mode, "no_op");
    assert.equal(adopted.opId, first.opId);
    assert.equal(readFileSync(join(wt.worktree.path, "counter.txt"), "utf8"), counterBefore, "已成功步骤不重跑");
    const bindingAdopted = await store.bindings.get(task.taskId);
    assert.equal(bindingAdopted.worktree.lastPrepareOp, first.opId);
    assert.ok(bindingAdopted.worktree.preparedAt !== null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("i) 幂等 no-op：成功后重跑报告已一致；空配置首跑也落 preparedAt", async () => {
  const { dir } = project("idem");
  const task = syntheticTask(dir, "idem");
  writeFileSync(join(dir, "one.txt"), "one\n");
  writeConfig(dir, {
    copy: [{ path: "one.txt" }],
    postCreate: [{ name: "only", command: "echo once > only.log" }],
  });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const first = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(first.mode, "completed");
    const second = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(second.mode, "no_op");
    assert.equal(second.opId, first.opId);
    assert.equal(second.copied, 0);
    // no-op 不产生新 op，不重复步骤副作用
    assert.equal(prepareOpIds(dir).length, 1);
    assert.equal(readFileSync(join(wt.worktree.path, "only.log"), "utf8"), "once\n");
    const binding = await store.bindings.get(task.taskId);
    assert.equal(binding.worktree.lastPrepareOp, first.opId);

    // 空配置：首跑无工作可做 → no-op 但落回执与 preparedAt（供执行前置检查判定）
    writeConfig(dir, undefined); // 无 worktree 节 = 无白名单无步骤
    const other = syntheticTask(dir, "empty", { id: hexTaskId("wp-empty") });
    await seedBinding(store, dir, other.taskId, other.dirName);
    await worktrees.create({ dir, taskId: other.taskId });
    const emptyFirst = await prepare.prepare({ dir, taskId: other.taskId });
    assert.equal(emptyFirst.mode, "no_op");
    assert.equal(emptyFirst.copied, 0);
    assert.equal(emptyFirst.steps.length, 0);
    const emptyBinding = await store.bindings.get(other.taskId);
    assert.ok(emptyBinding.worktree.preparedAt !== null && emptyBinding.worktree.preparedAt !== undefined);
    const emptyAgain = await prepare.prepare({ dir, taskId: other.taskId });
    assert.equal(emptyAgain.mode, "no_op");
    assert.equal(emptyAgain.opId, emptyFirst.opId);
    assert.equal(prepareOpIds(dir).length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("j) 未登记 worktree、缺绑定、归档任务拒绝", async () => {
  const { dir } = project("guards");
  const task = syntheticTask(dir, "guards");
  writeConfig(dir, { copy: [{ path: "a.txt" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    // 缺少 worktree 登记
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => {
        assert.equal(error.guardReason, "unknown_binding");
        assert.match(error.message, /worktree create 或 connect/);
        return true;
      },
    );
    await worktrees.create({ dir, taskId: task.taskId });
    // 归档任务拒绝：先在 open 状态建好 worktree，再归档任务目录
    const archiveMonth = join(dir, ".knit", "tasks", "archive", "2026-11");
    mkdirSync(archiveMonth, { recursive: true });
    const archived = syntheticTask(dir, "archived", { id: hexTaskId("wp-archived") });
    await seedBinding(store, dir, archived.taskId, archived.dirName);
    await worktrees.create({ dir, taskId: archived.taskId });
    const archivedMarkdown = readFileSync(join(archived.taskDir, "task.md"), "utf8");
    rmSync(archived.taskDir, { recursive: true, force: true });
    mkdirSync(join(archiveMonth, archived.dirName), { recursive: true });
    writeFileSync(join(archiveMonth, archived.dirName, "task.md"), archivedMarkdown);
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: archived.taskId }),
      (error) => error.guardReason === "task_archived",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("k) 边界：.knit/.runtime 与 .git 白名单拒绝；worktree 无 .runtime；HEAD 不变", async () => {
  const { dir } = project("boundary");
  const task = syntheticTask(dir, "boundary");
  writeFileSync(join(dir, "fine.txt"), "fine\n");
  mkdirSync(join(dir, ".knit", ".runtime", "junk"), { recursive: true });
  writeFileSync(join(dir, ".knit", ".runtime", "junk", "x.bin"), "runtime data\n");
  writeConfig(dir, { copy: [{ path: ".knit/.runtime/junk/x.bin" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const headBefore = git(["rev-parse", "HEAD"], dir).trim();
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    await assert.rejects(
      () => prepare.prepare({ dir, taskId: task.taskId }),
      (error) => error.guardReason === "prepare_path_escape",
    );
    assert.equal(existsSync(join(wt.worktree.path, ".knit", ".runtime")), false, "worktree 不产生 .runtime 副本");
    // 合法白名单成功后也不带 .runtime，不产生 Git 提交，不改分支
    writeConfig(dir, { copy: [{ path: "fine.txt" }] });
    const result = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    assert.equal(existsSync(join(wt.worktree.path, ".knit", ".runtime")), false);
    assert.equal(git(["rev-parse", "HEAD"], dir).trim(), headBefore);
    assert.equal(git(["rev-parse", "HEAD"], wt.worktree.path).trim(), headBefore);
    assert.equal(git(["symbolic-ref", "HEAD"], dir).trim(), "refs/heads/main");
    assert.equal(git(["symbolic-ref", "HEAD"], wt.worktree.path).trim(), wt.worktree.branch);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("l) 目录白名单递归展开 + 逐文件指纹", async () => {
  const { dir } = project("recursive");
  const task = syntheticTask(dir, "recursive");
  mkdirSync(join(dir, "assets", "sub", "deep"), { recursive: true });
  writeFileSync(join(dir, "assets", "a.txt"), "a\n");
  writeFileSync(join(dir, "assets", "sub", "b.txt"), "b\n");
  writeFileSync(join(dir, "assets", "sub", "deep", "c.txt"), "c\n");
  // 显式 target 改变落位根
  writeConfig(dir, { copy: [{ path: "assets", target: "vendor/assets" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    const result = await prepare.prepare({ dir, taskId: task.taskId });
    assert.equal(result.mode, "completed");
    assert.equal(result.copied, 3);
    assert.equal(readFileSync(join(wt.worktree.path, "vendor", "assets", "a.txt"), "utf8"), "a\n");
    assert.equal(readFileSync(join(wt.worktree.path, "vendor", "assets", "sub", "b.txt"), "utf8"), "b\n");
    assert.equal(readFileSync(join(wt.worktree.path, "vendor", "assets", "sub", "deep", "c.txt"), "utf8"), "c\n");
    // manifest 逐文件指纹（目录本身不记条目）
    const manifest = manifestJson(dir, result.opId);
    assert.equal(manifest.entries.length, 3);
    const deep = manifest.entries.find((entry) => entry.target === "vendor/assets/sub/deep/c.txt");
    assert.equal(deep.source, "assets/sub/deep/c.txt");
    assert.equal(deep.sourceSha256, createHash("sha256").update("c\n").digest("hex"));
    assert.equal(deep.result, "copied");
    assert.ok(!manifest.entries.some((entry) => entry.target === "vendor/assets"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktreePrepareCurrent：未登记/未准备为 false，preparedAt 后为 true", async () => {
  const { dir } = project("current");
  const task = syntheticTask(dir, "current");
  writeFileSync(join(dir, "one.txt"), "one\n");
  writeConfig(dir, { copy: [{ path: "one.txt" }] });
  const { store, worktrees, prepare } = makeServices(dir);
  await seedBinding(store, dir, task.taskId, task.dirName);
  try {
    const { worktreePrepareCurrent } = await import("../dist/application/worktree-prepare.js");
    let binding = await store.bindings.get(task.taskId);
    assert.equal(worktreePrepareCurrent(binding), false, "未登记 worktree");
    const wt = await worktrees.create({ dir, taskId: task.taskId });
    binding = await store.bindings.get(task.taskId);
    assert.equal(worktreePrepareCurrent(binding), false, "已登记未准备");
    await prepare.prepare({ dir, taskId: task.taskId });
    binding = await store.bindings.get(task.taskId);
    assert.equal(worktreePrepareCurrent(binding), true);
    void wt;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config.worktree 节：schema 接受合法配置并归一缺省；结构不符拒绝", () => {
  const config = parseConfig(JSON.stringify(makeConfig({
    copy: [{ path: "docs", target: "wt-docs" }],
    postCreate: [{ name: "init", command: "npm install" }],
  })));
  assert.deepEqual(config.worktree.copy, [{ path: "docs", target: "wt-docs" }]);
  assert.deepEqual(config.worktree.postCreate, [{ name: "init", command: "npm install" }]);
  // 无 worktree 节 = 无白名单无步骤
  const bare = parseConfig(JSON.stringify(makeConfig(undefined)));
  assert.equal(bare.worktree, undefined);
  // 结构不符：copy 非数组 / postCreate 缺 command / 未知类型
  assert.throws(() => parseConfig(JSON.stringify(makeConfig({ copy: "docs" }))), (error) => error.code === "io_error");
  assert.throws(() => parseConfig(JSON.stringify(makeConfig({ postCreate: [{ command: 3 }] }))), (error) => error.code === "io_error");
});
