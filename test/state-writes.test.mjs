/**
 * 锁收窄与状态写归属（k-f0d9a8952aff）：任务资料剔除、stale 判定、硬保护路径、
 * run 状态表达的 task_busy、工作树租约与并发登记。
 * 使用真实 Git／文件／worker 子进程和最小 Pi RPC 假实现，不调用真实模型。
 */
import { isRunSettled } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { RestoreService } from "../dist/application/restore.js";
import { StatusService } from "../dist/application/status-service.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";
import { inputsDigestOf } from "../dist/contracts/task-inputs.js";
import { attributedChangedPaths, captureStageBaseline, inspectStageBoundary } from "../dist/application/stage-baseline.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const INPUTS = "## 目标与边界\n\n运行中改写的目标\n";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-state-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.go*\n.fake*\n.home/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** 一个“会话”：独立元数据连接与 LockManager，同一锁根。 */
function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({ store, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  return { store, locks, tasks, coordinator, acceptance: new RunAcceptanceService({ store, locks }) };
}

async function readyTask(dir, s, slug) {
  const task = await s.tasks.newTask({ dir, title: slug, slug, verification: "independent" });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function prepareInput(dir, taskId, phase = "implement") {
  return {
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
  };
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 启动一个停在 waitFile 上的 implement run，返回时阶段基线已冻结。 */
async function startHeld(dir, s, taskId, report = { summary: "实现", changedPaths: ["README.md"] }) {
  const prepared = await s.coordinator.prepare(prepareInput(dir, taskId));
  const actionPath = join(dir, ".fake-action.json");
  writeFileSync(actionPath, JSON.stringify({ waitFile: ".go", writes: [{ path: "README.md", content: "# changed\n" }], report }));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
  assert.equal(started.confirmed, true, started.launch.lastError ?? "");
  const runId = prepared.request.runId;
  await waitFor(() => new RunStore(dir).readState(runId)?.baseline, "阶段基线未冻结");
  return { runId, prepared };
}

async function release(dir, s, runId) {
  writeFileSync(join(dir, ".go"), "");
  return waitFor(async () => {
    const status = await s.coordinator.status({ dir, runId });
    return isRunSettled(status) ? status : null;
  }, "run 未终止");
}

function taskPath(dir, task) {
  return join(dir, ".knit", task.relativePath);
}

function readDoc(dir, task) {
  const file = taskPath(dir, task);
  return parseTaskDocument(readFileSync(file, "utf8"), file);
}

function assertAccepted(status) {
  assert.equal(status.state, "completed", status.result?.failureReason ?? status.reason ?? "");
  assert.equal(status.acceptance?.state, "completed", status.acceptance?.reason ?? "");
  assert.equal(status.acceptance?.reason, "implementation_accepted");
}

function cleanup(dir, ...sessions) {
  for (const s of sessions) s.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

function cliEnv(dir, extra = {}) {
  const env = { ...process.env, HOME: join(dir, ".home"), ...extra };
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  return env;
}

function cli(dir, args, { input = "", env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], { encoding: "utf8", input, env: cliEnv(dir, env) });
  return { code: result.status, body: JSON.parse(result.stdout) };
}

test("A 在主检出运行期间：其它会话可 new／update B，record A；A 仍接收且 inputsDigest 不变", async () => {
  const dir = project("parallel");
  const s = services(dir);
  const other = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const b = await s.tasks.newTask({ dir, title: "B", slug: "task-b", verification: "independent" });
    const { runId } = await startHeld(dir, s, a.taskId);
    const frozen = new RunStore(dir).readInputs(runId).inputsDigest;

    const created = await other.tasks.newTask({ dir, title: "运行中登记", slug: "registered" });
    assert.ok(existsSync(taskPath(dir, created)));
    const updated = await other.tasks.update({ dir, taskId: b.taskId, kind: "clarify", reason: "补充", content: INPUTS });
    assert.equal(updated.applied, "direct");
    const recorded = await other.tasks.record({ dir, taskId: a.taskId, body: "运行中的进展记录" });
    assert.equal(recorded.saved, true);

    const status = await release(dir, s, runId);
    assertAccepted(status);
    assert.equal(status.inputsDigest, frozen);
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"], "并发写入的任务资料不计成果");
    assert.ok(readDoc(dir, a).progressBody.includes("运行中的进展记录"), "接收写回不丢并发记录");
    assert.equal(readDoc(dir, a).frontmatter.stage, "check");
  } finally {
    cleanup(dir, s, other);
  }
});

test("活动 run：未声明 --run 报 task_busy 不写文件；--run + clarify 写入且阶段不变，收尾 stale_input", async () => {
  const dir = project("busy");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { runId } = await startHeld(dir, s, a.taskId);
    const before = readFileSync(taskPath(dir, a), "utf8");
    await assert.rejects(
      () => s.tasks.update({ dir, taskId: a.taskId, kind: "clarify", reason: "未声明", content: INPUTS }),
      (error) => error.guardReason === "task_busy" && error.message.startsWith(`task_busy: run ${runId}`),
    );
    await assert.rejects(
      () => s.tasks.update({ dir, taskId: a.taskId, kind: "clarify", reason: "错的", content: INPUTS, run: "run-000000000000" }),
      (error) => error.guardReason === "task_busy",
    );
    assert.equal(readFileSync(taskPath(dir, a), "utf8"), before, "task_busy 不写文件");

    const updated = await s.tasks.update({ dir, taskId: a.taskId, kind: "clarify", reason: "运行中澄清", content: INPUTS, run: runId });
    assert.equal(updated.applied, "direct");
    assert.equal(updated.stage, "implement", "clarify 就地停留");
    assert.equal(readDoc(dir, a).frontmatter.stage, "implement");

    const status = await release(dir, s, runId);
    assert.equal(status.acceptance?.state, "needs_attention");
    assert.equal(status.acceptance?.reason, "stale_input");
  } finally {
    cleanup(dir, s);
  }
});

test("活动 run + --run + change：needs_attention stale_input，结果与工作区保留；回 start，结束后 ready 重入 implement；run status 有引导", async () => {
  const dir = project("change");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { runId } = await startHeld(dir, s, a.taskId);
    const updated = await s.tasks.update({ dir, taskId: a.taskId, kind: "change", reason: "目标变化", content: INPUTS, run: runId });
    assert.equal(updated.stage, "start");
    assert.equal(readDoc(dir, a).frontmatter.stage, "start");

    const status = await release(dir, s, runId);
    assert.equal(status.acceptance?.state, "needs_attention");
    assert.equal(status.acceptance?.reason, "stale_input");
    assert.equal(status.state, "failed");
    assert.equal(status.reason, "acceptance_stale_input");
    assert.equal(status.result.state, "completed", "结果保留");
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"]);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# changed\n", "工作区保留");
    assert.equal(readDoc(dir, a).frontmatter.stage, "start", "stale 不推进任务");
    assert.deepEqual((await s.store.bindings.get(a.taskId)).lastRunIds, [], "不计为当前规格的成果");

    const view = await new StatusService({ store: s.store, locksRoot: join(dir, ".locks") }).runStatus(dir, runId);
    assert.ok(view.nextActions.some((line) => line.includes(`task ready ${a.taskId}`)), view.nextActions.join("；"));
    assert.ok(view.nextActions.some((line) => line.includes("结果与工作区已保留")));
    const shown = spawnSync(process.execPath, [CLI, "run", "status", runId, "--dir", dir, "--locks", join(dir, ".locks")], { encoding: "utf8", env: cliEnv(dir) });
    assert.match(shown.stdout, /下一步: 重新确认输入后 knit task ready/);

    const ready = await s.tasks.ready({ dir, taskId: a.taskId });
    assert.equal(ready.stage, "implement");
    const next = await s.coordinator.prepare(prepareInput(dir, a.taskId));
    assert.equal(next.reused, false, "旧 run 已结束，开新 run");
  } finally {
    cleanup(dir, s);
  }
});

test("外部接收判 stale_input 时收敛未终态 run，任务不再被占用", async () => {
  const dir = project("settle");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { request } = await s.coordinator.prepare(prepareInput(dir, a.taskId));
    const runs = new RunStore(dir);
    const now = new Date().toISOString();
    runs.writeInputs(request.runId, {
      schemaVersion: 1, runId: request.runId, taskId: a.taskId, phase: "implement", frozenAt: now, planId: "ctx-000000000001",
      inputsDigest: "stale", standardsDigest: request.expected.standardsDigest, effectiveInputsDigest: "stale",
      taskDocumentDigest: "stale", sections: [], excluded: [], toolPolicy: request.toolPolicy,
    });
    runs.writeState(request.runId, {
      schemaVersion: 1, runId: request.runId, taskId: a.taskId, phase: "implement", state: "running",
      worker: { workerId: "w-000000000001", pid: process.pid, bootId: "boot", procStartTicks: null, hostname: "test" },
      claimedAt: now, updatedAt: now, prepared: true, preparedAt: now, snapshot: null, reason: null,
    });
    runs.writeResult(request.runId, {
      schemaVersion: 1, runId: request.runId, taskId: a.taskId, phase: "implement", state: "completed",
      report: { summary: "x", changedPaths: [] }, reportSummary: "x",
      nativeEntries: { startEntryId: null, leafEntryId: null }, usage: { inputTokens: null, outputTokens: null }, session: null,
      actualChangedPaths: [], acceptanceOperationId: request.acceptanceOperationId, recordedAt: now, failureReason: null,
    });
    const accepted = await s.acceptance.accept({ dir, runId: request.runId });
    assert.equal(accepted.accepted, false);
    assert.equal(accepted.reason, "stale_input");
    assert.equal(runs.readState(request.runId).state, "failed");
    const updated = await s.tasks.update({ dir, taskId: a.taskId, kind: "clarify", reason: "不用声明", content: INPUTS });
    assert.equal(updated.applied, "direct", "收敛后不再要求 --run");
  } finally {
    cleanup(dir, s);
  }
});

test("--pending：活动 run 中不需要 --run，只存草案；不是默认行为", async () => {
  const dir = project("pending");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { runId } = await startHeld(dir, s, a.taskId);
    const digest = inputsDigestOf(readFileSync(taskPath(dir, a), "utf8"));
    const saved = await s.tasks.update({ dir, taskId: a.taskId, kind: "clarify", reason: "草案", content: INPUTS, pending: true });
    assert.equal(saved.applied, "pending_saved");
    assert.equal(inputsDigestOf(readFileSync(taskPath(dir, a), "utf8")), digest, "草案不改输入");
    const withdrawn = await s.tasks.update({ dir, taskId: a.taskId, expectPending: saved.pendingDraftDigest, withdrawReason: "撤回" });
    assert.equal(withdrawn.applied, "pending_withdrawn");
    assertAccepted(await release(dir, s, runId));
  } finally {
    cleanup(dir, s);
  }
});

test("CLI：task_busy reason、--run 优先于 KNIT_RUN、KNIT_RUN 可声明、--pending 不需声明", async () => {
  const dir = project("cli");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { runId } = await startHeld(dir, s, a.taskId);
    const update = (extra, env) => cli(dir, ["task", "update", a.taskId, "--kind", "clarify", ...extra], { input: INPUTS, env });

    const busy = update([]);
    assert.equal(busy.code, 1);
    assert.equal(busy.body.reasonCode, "task_busy");
    assert.equal(busy.body.outcome, "blocked");
    assert.match(busy.body.data.error, new RegExp(`^task_busy: run ${runId}`));

    assert.equal(update(["--run", "run-000000000000"], { KNIT_RUN: runId }).body.reasonCode, "task_busy", "显式 --run 优先于环境变量");
    const pending = update(["--pending"]);
    assert.equal(pending.body.data.applied, "pending_saved");
    assert.equal(cli(dir, ["task", "update", a.taskId, "--withdraw-pending", "--expect-pending", pending.body.data.pendingDraftDigest, "--reason", "撤回"]).code, 0);
    const declared = update([], { KNIT_RUN: runId });
    assert.equal(declared.code, 0, JSON.stringify(declared.body));
    assert.equal(declared.body.data.applied, "direct");
    await release(dir, s, runId);
  } finally {
    cleanup(dir, s);
  }
});

test("阶段窗口直接编辑 A 的记录区：仍接收，task.md 不进 changedPaths", async () => {
  const dir = project("edit-a");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { runId } = await startHeld(dir, s, a.taskId);
    const doc = readDoc(dir, a);
    writeFileSync(taskPath(dir, a), renderTaskDocument({ ...doc, progressBody: `${doc.progressBody.trimEnd()}\n\n直接编辑的记录\n` }));
    const status = await release(dir, s, runId);
    assertAccepted(status);
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"]);
    assert.ok(readDoc(dir, a).progressBody.includes("直接编辑的记录"));
  } finally {
    cleanup(dir, s);
  }
});

test("阶段窗口直接编辑 A 的输入区：不判越界，收尾 stale_input", async () => {
  const dir = project("edit-a-input");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { runId } = await startHeld(dir, s, a.taskId);
    const doc = readDoc(dir, a);
    writeFileSync(taskPath(dir, a), renderTaskDocument({ ...doc, inputsBody: INPUTS }));
    const status = await release(dir, s, runId);
    assert.equal(status.result.state, "completed", status.result.failureReason ?? "");
    assert.equal(status.acceptance?.reason, "stale_input");
  } finally {
    cleanup(dir, s);
  }
});

test("阶段窗口直接编辑 B 的 task.md 与资料：A 仍接收", async () => {
  const dir = project("edit-b");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const b = await s.tasks.newTask({ dir, title: "B", slug: "task-b" });
    const { runId } = await startHeld(dir, s, a.taskId);
    const doc = readDoc(dir, b);
    writeFileSync(taskPath(dir, b), renderTaskDocument({ ...doc, inputsBody: INPUTS }));
    writeFileSync(join(taskPath(dir, b), "..", "plan.md"), "# 计划\n");
    const status = await release(dir, s, runId);
    assertAccepted(status);
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"]);
  } finally {
    cleanup(dir, s);
  }
});

for (const [name, path, mutate] of [
  ["config.json", ".knit/config.json", (text) => `${text}\n`],
  ["workflow.yaml", ".knit/workflow.yaml", (text) => `${text}# 运行中改流程\n`],
  ["agents", ".knit/agents/implement.md", (text) => `${text}\n改提示词\n`],
  ["standards", ".knit/standards/index.md", (text) => `${text}\n改规范\n`],
]) {
  test(`阶段窗口改 ${name}：仍判 protected_path_modified`, async () => {
    const dir = project(`hard-${name.replace(/\W/g, "")}`);
    const s = services(dir);
    try {
      const a = await readyTask(dir, s, "task-a");
      const { runId } = await startHeld(dir, s, a.taskId);
      writeFileSync(join(dir, path), mutate(readFileSync(join(dir, path), "utf8")));
      const status = await release(dir, s, runId);
      assert.equal(status.state, "failed");
      assert.equal(status.result.failureReason, `protected_path_modified:${path}`);
      assert.equal(readDoc(dir, a).frontmatter.stage, "implement");
    } finally {
      cleanup(dir, s);
    }
  });
}

test("同一检出第二个任务 prepare：workspace_busy 不生成 run；同任务复用；worker 持租约时 restore／deliver 被拒", async () => {
  const dir = project("lease");
  const s = services(dir);
  const other = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const b = await readyTask(dir, s, "task-b");
    const { runId } = await startHeld(dir, s, a.taskId);
    const before = new RunStore(dir).listRunIds();

    await assert.rejects(
      () => other.coordinator.prepare(prepareInput(dir, b.taskId)),
      (error) => error.guardReason === "workspace_busy" && /^workspace_busy:/.test(error.message),
    );
    assert.deepEqual(new RunStore(dir).listRunIds(), before, "不生成新 run 记录");
    const again = await other.coordinator.prepare(prepareInput(dir, a.taskId));
    assert.equal(again.reused, true);
    assert.equal(again.request.runId, runId);

    const prepared = spawnSync(process.execPath, [CLI, "--json", "run", "prepare", "--task", b.taskId, "--stage", "implement", "--provider", "fake", "--model", "fake-model", "--locks", join(dir, ".locks"), "--dir", dir], { encoding: "utf8", env: cliEnv(dir) });
    assert.equal(prepared.status, 1, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).reasonCode, "workspace_busy");

    const restore = new RestoreService({ store: other.store, locks: other.locks });
    const preview = await restore.preview({ dir, runId, paths: ["README.md"] });
    await assert.rejects(
      () => restore.restore({ dir, runId, paths: ["README.md"], expect: { "README.md": preview.plans[0].current.fingerprint } }),
      (error) => error.code === "lock_busy",
    );
    await assert.rejects(
      () => new DeliveryService({ store: other.store, locks: other.locks }).deliver({ dir, taskId: b.taskId, branch: "refs/heads/main" }),
      (error) => error.code === "lock_busy",
    );
    assertAccepted(await release(dir, s, runId));
    await waitFor(() => !s.locks.inspect({ scope: "project", rawKey: dir }).exists, "租约未释放");
    assert.equal((await other.coordinator.prepare(prepareInput(dir, b.taskId))).reused, false, "租约释放后可派发");
  } finally {
    cleanup(dir, s, other);
  }
});

test("worker 只持租约：任务短锁与 state 锁运行中都空闲，locks／doctor 可见 state 范围", async () => {
  const dir = project("scopes");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const { runId } = await startHeld(dir, s, a.taskId);
    const scopes = s.locks.list().map((entry) => entry.scope);
    assert.ok(scopes.includes("project"));
    assert.equal(scopes.includes("task"), false, "任务不被长租约占用");
    assert.equal(scopes.includes("state"), false);
    await release(dir, s, runId);

    const held = await s.locks.acquire({ keys: [{ scope: "state", rawKey: dir }], action: "test.hold" });
    try {
      const listed = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "locks", "--locks", join(dir, ".locks"), "--dir", dir], { encoding: "utf8" }));
      assert.ok(listed.data.entries.some((entry) => entry.scope === "state" && entry.key === dir && entry.id.startsWith("state/")));
      await assert.rejects(
        () => s.tasks.newTask({ dir, title: "state 占用", slug: "busy" }),
        (error) => error.code === "lock_busy" && error.details.scope === "state",
      );
    } finally {
      s.locks.release(held);
    }
  } finally {
    cleanup(dir, s);
  }
});

test("两个独立 CLI 进程并发 task new：不同 ID、不同目录、binding 都在", async () => {
  const dir = project("concurrent");
  const s = services(dir);
  try {
    await s.tasks.newTask({ dir, title: "种子", slug: "seed" });
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, "--json", "task", "new", "--title", "并发", "--slug", "same", "--dir", dir], { env: cliEnv(dir), stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.on("close", (code) => resolve({ code, body: JSON.parse(out) }));
      });
    const [first, second] = await Promise.all([run(), run()]);
    assert.equal(first.code, 0, JSON.stringify(first.body));
    assert.equal(second.code, 0, JSON.stringify(second.body));
    assert.notEqual(first.body.data.taskId, second.body.data.taskId);
    assert.notEqual(first.body.data.relativePath, second.body.data.relativePath);
    for (const { body } of [first, second]) {
      assert.ok(existsSync(join(dir, ".knit", body.data.relativePath)));
      assert.notEqual(await s.store.bindings.get(body.data.taskId), null, "binding 无丢写");
    }
    assert.equal(readdirSync(join(dir, ".knit", "tasks")).filter((name) => name.endsWith("same") || name.includes("same-")).length, 2);
  } finally {
    cleanup(dir, s);
  }
});

test("活动 run 中 rename／implement 由 run 状态拒绝；其它任务不受影响", async () => {
  const dir = project("guards");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const b = await s.tasks.newTask({ dir, title: "B", slug: "task-b" });
    const { runId } = await startHeld(dir, s, a.taskId);
    await assert.rejects(() => s.tasks.rename({ dir, taskId: a.taskId, newSlug: "moved", equivalent: true }), (error) => error.guardReason === "task_busy");
    await assert.rejects(
      () => s.tasks.implement({ dir, taskId: a.taskId, paths: ["README.md"], validations: ["x"] }),
      (error) => error.guardReason === "task_busy",
    );
    const renamed = await s.tasks.rename({ dir, taskId: b.taskId, newSlug: "b-moved", equivalent: true });
    assert.match(renamed.to, /b-moved$/);
    assertAccepted(await release(dir, s, runId));
  } finally {
    cleanup(dir, s);
  }
});

test("阶段进程收到 KNIT_RUN；报告如实列出任务资料也不判 changed_paths_mismatch", async () => {
  const dir = project("env");
  const s = services(dir);
  try {
    const a = await readyTask(dir, s, "task-a");
    const prepared = await s.coordinator.prepare(prepareInput(dir, a.taskId));
    const actionPath = join(dir, ".fake-action.json");
    writeFileSync(actionPath, JSON.stringify({
      writes: [{ path: "README.md", content: "# changed\n" }],
      exec: [["sh", "-c", "printf %s \"$KNIT_RUN\" > .fake-env"]],
      report: { summary: "实现", changedPaths: ["README.md", `.knit/${a.relativePath}`] },
    }));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionPath;
    const runId = prepared.request.runId;
    await s.coordinator.start({ dir, runId });
    const status = await waitFor(async () => {
      const current = await s.coordinator.status({ dir, runId });
      return isRunSettled(current) ? current : null;
    }, "run 未终止");
    assertAccepted(status);
    assert.deepEqual(status.result.actualChangedPaths, ["README.md"]);
    assert.equal(readFileSync(join(dir, ".fake-env"), "utf8"), runId);
  } finally {
    cleanup(dir, s);
  }
});

test("归属单元：任务资料整体剔除，其余 .knit 保留", () => {
  assert.deepEqual(
    attributedChangedPaths([
      ".knit/tasks/11-07-a/task.md",
      ".knit/tasks/11-07-a/research/x.md",
      ".knit/tasks/archive/2026-11/11-01-b/task.md",
      ".knit/config.json",
      ".knit/standards/x.md",
      "src/a.ts",
    ]),
    [".knit/config.json", ".knit/standards/x.md", "src/a.ts"],
  );
});

test("敏感区单元：短锁写入的他任务凭据与新 run 目录不计；本任务凭据只放行删除", () => {
  const dir = project("boundary");
  try {
    const runtime = join(dir, ".knit", ".runtime");
    const own = "k-00000000000a";
    const other = "k-00000000000b";
    mkdirSync(join(runtime, "completions"), { recursive: true });
    mkdirSync(join(runtime, "implementations"), { recursive: true });
    mkdirSync(join(runtime, "runs", "run-00000000aa01"), { recursive: true });
    writeFileSync(join(runtime, "runs", "run-00000000aa01", "state.json"), JSON.stringify({ state: "running", reason: null }));
    writeFileSync(join(runtime, "completions", `${own}.json`), "{}\n");
    const context = { executionDir: dir, root: dir, runId: "run-00000000aa01", taskId: own };
    const baseline = captureStageBaseline(context);
    writeFileSync(join(runtime, "completions", `${other}.json`), "{}\n");
    writeFileSync(join(runtime, "implementations", `${other}.json`), "{}\n");
    mkdirSync(join(runtime, "runs", "run-00000000aa02"), { recursive: true });
    writeFileSync(join(runtime, "runs", "run-00000000aa02", "request.json"), "{}\n");
    rmSync(join(runtime, "completions", `${own}.json`));
    assert.deepEqual(inspectStageBoundary(baseline, context).facts.protectedPaths, []);

    writeFileSync(join(runtime, "completions", `${own}.json`), "{\"forged\":1}\n");
    assert.deepEqual(inspectStageBoundary(baseline, context).facts.protectedPaths, [`.knit/.runtime/completions/${own}.json`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
