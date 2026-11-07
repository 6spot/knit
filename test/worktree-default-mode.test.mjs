/**
 * Worktree 默认开关与收尾配置（任务 k-da9973a69c20；DESIGN §6/§10/§13）。
 * 隔离夹具：真实 Git 仓库与 worktree，不调用模型。覆盖配置缺省／枚举、派发前自动
 * 创建与脏守卫、任务级 on／off、已有绑定复用、非首阶段不创建，以及交付串联合入／清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { WorktreeHandoffService } from "../dist/application/worktree-handoff.js";
import { WorktreePrepareService } from "../dist/application/worktree-prepare.js";
import { WorktreeMergeService } from "../dist/application/worktree-merge.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { defaultConfig, parseConfig, worktreeSettingsOf } from "../dist/application/config.js";
import { parseTaskDocument } from "../dist/application/task-document.js";
import { inputsDigestOf } from "../dist/contracts/task-inputs.js";
import { emptyScope } from "../dist/application/scope.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const MAIN = "refs/heads/main";
const AUTHORIZATION = "workflow:AGENTS.md#交付";

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configWith(overrides = {}) {
  const config = structuredClone(defaultConfig());
  config.worktree = { ...(config.worktree ?? {}), ...(overrides.worktree ?? {}) };
  config.delivery = { ...config.delivery, ...(overrides.delivery ?? {}) };
  return config;
}

function fixture(prefix, overrides = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `knit-wd-${prefix}-`)));
  const root = join(base, "root");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(root, ".knit"), { recursive: true });
  writeFileSync(join(root, ".knit", "config.json"), `${JSON.stringify(configWith(overrides), null, 2)}\n`);
  writeFileSync(join(root, "AGENTS.md"), "# 项目规则\n\n## 交付\n\n允许在当前分支按任务范围提交并归档。\n");
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n.knit/worktrees/\n");
  writeFileSync(join(root, "README.md"), "# demo\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return { base, root, locksRoot: join(base, "locks") };
}

function services(dir, locksRoot) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: locksRoot });
  const tasks = new TaskService({ store, locks, now: () => new Date("2026-11-06T10:00:00.000Z"), randomHex });
  const coordinator = new RunCoordinator({ store, locks, randomHex, lockRoot: locksRoot });
  return { store, locks, tasks, coordinator };
}

function prepareInput(dir, taskId, phase = "implement", extra = {}) {
  return {
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
    ...extra,
  };
}

async function readyTask(s, dir, slug, options = {}) {
  const task = await s.tasks.newTask({
    dir,
    title: options.title ?? slug,
    slug,
    branch: MAIN,
    verification: options.verification ?? "self",
  });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function taskFile(dir, task) {
  return join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
}

function markClosed(taskPath, branch, stage = "deliver") {
  const text = readFileSync(taskPath, "utf8")
    .replace(/^status: .*$/m, "status: closed")
    .replace(/^outcome: .*$/m, "outcome: completed")
    .replace(/^stage: .*$/m, `stage: ${stage}`)
    .replace(/^branch: .*$/m, `branch: ${branch}`);
  writeFileSync(taskPath, text);
}

function writeCompletion(root, taskId, taskPath, verification = "none") {
  new RunStore(root).writeCompletion(taskId, {
    schemaVersion: 1,
    taskId,
    verification,
    inputsDigest: inputsDigestOf(readFileSync(taskPath, "utf8")),
    scopeDigest: emptyScope(taskId, "2026-11-06T10:00:00.000Z").digest,
    implementRunId: null,
    checkRunId: null,
    unverified: verification === "none" ? ["none"] : [],
    reason: null,
    completedAt: "2026-11-06T10:00:00.000Z",
  });
}

test("配置：默认值、旧配置兼容与枚举非法值拒绝", () => {
  const defaults = defaultConfig();
  assert.equal(defaults.worktree?.default, "off");
  assert.equal(defaults.worktree?.cleanup, "manual");
  assert.equal(defaults.delivery.mode, "local");
  assert.deepEqual(worktreeSettingsOf(defaults), { default: "off", cleanup: "manual", deliveryMode: "local" });

  const legacy = structuredClone(defaults);
  delete legacy.worktree;
  const parsed = parseConfig(JSON.stringify(legacy));
  assert.deepEqual(worktreeSettingsOf(parsed), { default: "off", cleanup: "manual", deliveryMode: "local" });

  for (const [mutate, label] of [
    [(c) => (c.worktree.default = "yes"), "worktree.default"],
    [(c) => (c.worktree.cleanup = "always"), "worktree.cleanup"],
    [(c) => (c.delivery.mode = "push"), "delivery.mode"],
  ]) {
    const invalid = structuredClone(defaults);
    mutate(invalid);
    assert.throws(() => parseConfig(JSON.stringify(invalid)), /config\.json 结构不符合约定/, label);
  }
});

test("默认 on：首个阶段 prepare 自动创建、交接并准备 worktree，请求记录策略", async () => {
  const f = fixture("auto-on", { worktree: { default: "on" } });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "auto-on");
    const prepared = await s.coordinator.prepare(prepareInput(f.root, task.taskId));
    const binding = await s.store.bindings.get(task.taskId);
    assert.ok(binding.worktree, "binding 已登记 worktree");
    assert.equal(binding.worktree.active, true);
    assert.equal(typeof binding.worktree.preparedAt, "string");
    assert.equal(binding.branch, binding.worktree.branch);
    assert.equal(prepared.request.expected.executionDir, binding.worktree.path);
    assert.equal(prepared.request.expected.branch, binding.worktree.branch);
    assert.deepEqual(prepared.request.worktree, { policy: "on", source: "config" });
    assert.equal(existsSync(join(binding.worktree.path, ".knit", "tasks", task.relativePath.split("/")[1], "task.md")), true);
    // 幂等：再次 prepare 复用同一 run，不重复创建或准备。
    const again = await s.coordinator.prepare(prepareInput(f.root, task.taskId));
    assert.equal(again.reused, true);
    assert.equal(again.request.runId, prepared.request.runId);
    assert.equal((await s.store.bindings.get(task.taskId)).worktree.path, binding.worktree.path);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("默认 off 不创建；--worktree on 覆盖创建，--worktree off 抑制默认 on", async () => {
  const off = fixture("auto-off");
  const sOff = services(off.root, off.locksRoot);
  try {
    const task = await readyTask(sOff, off.root, "auto-off");
    const prepared = await sOff.coordinator.prepare(prepareInput(off.root, task.taskId));
    const binding = await sOff.store.bindings.get(task.taskId);
    assert.equal(binding.worktree, undefined);
    assert.equal(prepared.request.expected.executionDir, off.root);
    assert.deepEqual(prepared.request.worktree, { policy: "off", source: "config" });
  } finally {
    sOff.store.close();
    rmSync(off.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }

  const explicit = fixture("explicit-on");
  const sOn = services(explicit.root, explicit.locksRoot);
  try {
    const task = await readyTask(sOn, explicit.root, "explicit-on");
    const prepared = await sOn.coordinator.prepare(prepareInput(explicit.root, task.taskId, "implement", {
      worktree: { policy: "on", source: "explicit" },
    }));
    const binding = await sOn.store.bindings.get(task.taskId);
    assert.ok(binding.worktree);
    assert.equal(prepared.request.expected.executionDir, binding.worktree.path);
    assert.deepEqual(prepared.request.worktree, { policy: "on", source: "explicit" });
  } finally {
    sOn.store.close();
    rmSync(explicit.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }

  const suppressed = fixture("explicit-off", { worktree: { default: "on" } });
  const sSuppressed = services(suppressed.root, suppressed.locksRoot);
  try {
    const task = await readyTask(sSuppressed, suppressed.root, "explicit-off");
    const prepared = await sSuppressed.coordinator.prepare(prepareInput(suppressed.root, task.taskId, "implement", {
      worktree: { policy: "off", source: "explicit" },
    }));
    const binding = await sSuppressed.store.bindings.get(task.taskId);
    assert.equal(binding.worktree, undefined);
    assert.equal(prepared.request.expected.executionDir, suppressed.root);
    assert.deepEqual(prepared.request.worktree, { policy: "off", source: "explicit" });
  } finally {
    sSuppressed.store.close();
    rmSync(suppressed.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("脏守卫：任务目录之外有改动时拒绝且不写 request；非首阶段不触发", async () => {
  const dirty = fixture("dirty", { worktree: { default: "on" } });
  const sDirty = services(dirty.root, dirty.locksRoot);
  try {
    const task = await readyTask(sDirty, dirty.root, "dirty");
    writeFileSync(join(dirty.root, "untracked.txt"), "local\n");
    await assert.rejects(
      () => sDirty.coordinator.prepare(prepareInput(dirty.root, task.taskId)),
      (error) => error.guardReason === "worktree_dirty_source",
    );
    const binding = await sDirty.store.bindings.get(task.taskId);
    assert.equal(binding.worktree, undefined);
    assert.deepEqual(new RunStore(dirty.root).listRunIds(), []);
  } finally {
    sDirty.store.close();
    rmSync(dirty.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }

  const later = fixture("later", { worktree: { default: "on" } });
  const sLater = services(later.root, later.locksRoot);
  try {
    const task = await readyTask(sLater, later.root, "later");
    const file = taskFile(later.root, task);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^stage: .*$/m, "stage: check"));
    const prepared = await sLater.coordinator.prepare(prepareInput(later.root, task.taskId, "check"));
    assert.equal((await sLater.store.bindings.get(task.taskId)).worktree, undefined);
    assert.deepEqual(prepared.request.worktree, { policy: "on", source: "config" });
    assert.equal(prepared.request.expected.executionDir, later.root);
  } finally {
    sLater.store.close();
    rmSync(later.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("已有绑定优先：off 不删除绑定，prepare 直接使用已交接的 worktree", async () => {
  const f = fixture("existing", { worktree: { default: "on" } });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "existing");
    const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir: f.root, taskId: task.taskId });
    await new WorktreeHandoffService({ store: s.store, runs: new RunStore(f.root) }).handoff({ dir: f.root, taskId: task.taskId });
    await new WorktreePrepareService({ store: s.store, locks: s.locks }).prepare({ dir: f.root, taskId: task.taskId });
    const prepared = await s.coordinator.prepare(prepareInput(f.root, task.taskId, "implement", {
      executionDir: created.worktree.path,
      worktree: { policy: "off", source: "explicit" },
    }));
    const binding = await s.store.bindings.get(task.taskId);
    assert.ok(binding.worktree);
    assert.equal(binding.worktree.path, created.worktree.path);
    assert.equal(prepared.request.expected.executionDir, created.worktree.path);
    assert.deepEqual(prepared.request.worktree, { policy: "off", source: "explicit" });
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("交付串联：delivery.mode=merge 先合入，after-merge 交付后清理", async () => {
  const f = fixture("chain", { delivery: { mode: "merge" }, worktree: { cleanup: "after-merge" } });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "chain", { verification: "none" });
    const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir: f.root, taskId: task.taskId });
    const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(f.root) }).handoff({ dir: f.root, taskId: task.taskId });
    const wt = created.worktree;
    writeFileSync(join(wt.path, "feature.txt"), "feature\n");
    git(wt.path, ["add", "feature.txt"]);
    git(wt.path, ["commit", "-q", "-m", "feature"]);
    markClosed(join(handed.targetTaskDir, "task.md"), wt.branch);
    writeCompletion(f.root, task.taskId, join(handed.targetTaskDir, "task.md"), "none");
    git(wt.path, ["add", "-A"]);
    git(wt.path, ["commit", "-q", "-m", "close task"]);

    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    const result = await delivery.deliver({ dir: f.root, taskId: task.taskId, branch: MAIN, authorizationRef: AUTHORIZATION });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.worktree?.merge?.status, "merged");
    assert.equal(result.worktree?.cleanup?.status, "removed");
    assert.deepEqual(result.worktree?.pending, []);
    assert.equal(existsSync(wt.path), false, "worktree 已清理");
    const binding = await s.store.bindings.get(task.taskId);
    assert.equal(binding.worktree, undefined);
    assert.equal(existsSync(join(f.root, ".knit", "worktrees")), true);
    assert.equal(git(f.root, ["log", "-1", "--format=%s"]).startsWith("chore(task): archive "), true);
    assert.equal(existsSync(join(f.root, result.archivePath, "task.md")), true);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("交付未授权合入：仍活动的 worktree 任务停止并说明待合入", async () => {
  const f = fixture("pending");
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "pending", { verification: "none" });
    const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir: f.root, taskId: task.taskId });
    const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(f.root) }).handoff({ dir: f.root, taskId: task.taskId });
    assert.ok(created.worktree);
    assert.ok(handed.targetTaskDir);
    const file = join(handed.targetTaskDir, "task.md");
    markClosed(file, created.worktree.branch);
    writeCompletion(f.root, task.taskId, file, "none");
    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    await assert.rejects(
      () => delivery.deliver({ dir: f.root, taskId: task.taskId, branch: MAIN, authorizationRef: AUTHORIZATION }),
      (error) => error.guardReason === "worktree_merge_required",
    );
    assert.equal((await s.store.bindings.get(task.taskId)).worktree?.active, true);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("合入无 worktree 的任务：配置 merge 记为 noop 并说明", async () => {
  const f = fixture("noop", { delivery: { mode: "merge" } });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "noop", { verification: "none" });
    const file = taskFile(f.root, task);
    markClosed(file, MAIN);
    writeCompletion(f.root, task.taskId, file, "none");
    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    const result = await delivery.deliver({ dir: f.root, taskId: task.taskId, branch: MAIN, authorizationRef: AUTHORIZATION });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.worktree?.merge?.status, "noop");
    assert.match(result.worktree?.merge?.reason ?? "", /没有 worktree/);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("手动 create --allow-dirty 可越过脏守卫；未加标志时拒绝", async () => {
  const f = fixture("allow-dirty");
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "allow-dirty");
    writeFileSync(join(f.root, "untracked.txt"), "local\n");
    const service = new WorktreeService({ store: s.store, locks: s.locks });
    await assert.rejects(
      () => service.create({ dir: f.root, taskId: task.taskId, guardDirty: true }),
      (error) => error.guardReason === "worktree_dirty_source",
    );
    const created = await service.create({ dir: f.root, taskId: task.taskId, guardDirty: true, allowDirty: true });
    assert.equal(created.created, true);
    assert.equal(existsSync(created.worktree.path), true);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("清理失败保留 worktree 与现场；retry 只补清理，不重复交付", async () => {
  const f = fixture("cleanup-retry", {
    delivery: { mode: "merge" },
    worktree: { cleanup: "after-merge" },
  });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "cleanup-retry", { verification: "none" });
    const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir: f.root, taskId: task.taskId });
    const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(f.root) }).handoff({ dir: f.root, taskId: task.taskId });
    const wt = created.worktree;
    writeFileSync(join(wt.path, "feature.txt"), "feature\n");
    git(wt.path, ["add", "feature.txt"]);
    git(wt.path, ["commit", "-q", "-m", "feature"]);
    markClosed(join(handed.targetTaskDir, "task.md"), wt.branch);
    writeCompletion(f.root, task.taskId, join(handed.targetTaskDir, "task.md"), "none");
    git(wt.path, ["add", "-A"]);
    git(wt.path, ["commit", "-q", "-m", "close task"]);
    // 忽略文件不参与 merge 的源脏检查，但 cleanup 会阻断；用于验证“失败保留现场”。
    writeFileSync(join(wt.path, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(wt.path, "ignored.txt"), "kept\n");
    git(wt.path, ["add", ".gitignore"]);
    git(wt.path, ["commit", "-q", "-m", "ignore rule"]);

    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    const first = await delivery.deliver({ dir: f.root, taskId: task.taskId, branch: MAIN, authorizationRef: AUTHORIZATION });
    assert.equal(first.state, "completed", first.reason ?? "");
    assert.equal(first.worktree?.merge?.status, "merged");
    assert.equal(first.worktree?.cleanup?.status, "blocked_dirty");
    assert.deepEqual(first.worktree?.pending, ["cleanup"]);
    assert.equal(first.needsAttention, true);
    assert.equal(existsSync(wt.path), true, "清理失败保留 worktree");
    const mergeCommit = git(f.root, ["rev-parse", "HEAD"]);

    rmSync(join(wt.path, "ignored.txt"));
    const second = await delivery.deliver({ dir: f.root, taskId: task.taskId, branch: MAIN, authorizationRef: AUTHORIZATION });
    assert.equal(second.worktree?.cleanup?.status, "removed");
    assert.deepEqual(second.worktree?.pending, []);
    assert.equal(second.needsAttention, false);
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), mergeCommit, "重试未重复交付提交");
    assert.equal(existsSync(wt.path), false);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("失败路径：detached HEAD 阻止自动创建，返回原因且不写 request", async () => {
  const f = fixture("detached", { worktree: { default: "on" } });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "detached");
    git(f.root, ["checkout", "-q", "--detach"]);
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(f.root, task.taskId)),
      (error) => error.guardReason === "detached_head",
    );
    assert.equal((await s.store.bindings.get(task.taskId)).worktree, undefined);
    assert.deepEqual(new RunStore(f.root).listRunIds(), []);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("自动准备失败后从主检出重试：续做 prepare，不重复创建 worktree", async () => {
  const f = fixture("prepare-retry", {
    worktree: { default: "on", postCreate: [{ name: "gate", command: "test -f go" }] },
  });
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "prepare-retry");
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(f.root, task.taskId)),
      (error) => error.guardReason === "prepare_step_failed",
    );
    const binding = await s.store.bindings.get(task.taskId);
    assert.ok(binding.worktree, "create + handoff 已生效");
    assert.equal(binding.worktree.preparedAt, undefined);
    assert.deepEqual(new RunStore(f.root).listRunIds(), []);
    writeFileSync(join(binding.worktree.path, "go"), "ready\n");
    const prepared = await s.coordinator.prepare(prepareInput(f.root, task.taskId));
    assert.equal(prepared.request.expected.executionDir, binding.worktree.path);
    const after = await s.store.bindings.get(task.taskId);
    assert.equal(after.worktree.path, binding.worktree.path);
    assert.equal(typeof after.worktree.preparedAt, "string");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("CLI：run prepare --worktree on 覆盖项目默认，非法值拒绝", async () => {
  const f = fixture("cli-flag");
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "cli-flag");
    const prepared = spawnSync(process.execPath, [
      CLI, "--json", "run", "prepare", "--task", task.taskId, "--stage", "implement",
      "--provider", "fake", "--model", "fake", "--worktree", "on", "--dir", f.root,
    ], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const response = JSON.parse(prepared.stdout);
    assert.equal(response.data.request.worktree.policy, "on");
    assert.equal(response.data.request.worktree.source, "explicit");
    assert.notEqual(response.data.request.expected.executionDir, f.root);

    const invalid = spawnSync(process.execPath, [
      CLI, "--json", "run", "prepare", "--task", task.taskId, "--stage", "implement",
      "--provider", "fake", "--model", "fake", "--worktree", "maybe", "--dir", f.root,
    ], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).reasonCode, "invalid_request");
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("未授权合入／清理：已合入任务完成本地交付并报告待清理", async () => {
  const f = fixture("pending-cleanup");
  const s = services(f.root, f.locksRoot);
  try {
    const task = await readyTask(s, f.root, "pending-cleanup", { verification: "none" });
    const created = await new WorktreeService({ store: s.store, locks: s.locks }).create({ dir: f.root, taskId: task.taskId });
    const handed = await new WorktreeHandoffService({ store: s.store, runs: new RunStore(f.root) }).handoff({ dir: f.root, taskId: task.taskId });
    const wt = created.worktree;
    writeFileSync(join(wt.path, "feature.txt"), "feature\n");
    git(wt.path, ["add", "feature.txt"]);
    git(wt.path, ["commit", "-q", "-m", "feature"]);
    markClosed(join(handed.targetTaskDir, "task.md"), wt.branch);
    writeCompletion(f.root, task.taskId, join(handed.targetTaskDir, "task.md"), "none");
    git(wt.path, ["add", "-A"]);
    git(wt.path, ["commit", "-q", "-m", "close task"]);
    const merged = await new WorktreeMergeService({ store: s.store, locks: s.locks }).merge({
      dir: f.root, taskId: task.taskId, into: MAIN, apply: true, authorizationRef: AUTHORIZATION,
    });
    assert.equal(merged.status, "merged", merged.reason ?? "");

    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    const result = await delivery.deliver({ dir: f.root, taskId: task.taskId, branch: MAIN, authorizationRef: AUTHORIZATION });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.needsAttention, false);
    assert.equal(result.worktree?.merge?.status, "noop");
    assert.equal(result.worktree?.cleanup?.status, "manual");
    assert.deepEqual(result.worktree?.pending, ["cleanup"]);
    assert.equal(existsSync(wt.path), true, "未授权时不擅自清理");
    assert.equal((await s.store.bindings.get(task.taskId)).worktree?.active, false);
  } finally {
    s.store.close();
    rmSync(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
