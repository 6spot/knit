/**
 * 改动来源归属、外部改动隔离与失败残留继承（任务 k-fdfd8c171736，审计 F2／S3）。
 * 真实 Git／worker 子进程与最小 Pi RPC 假实现；假实现把 write／edit／bash 记入原生会话。
 */
import { isRunSettled } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { StatusService } from "../dist/application/status-service.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { classifyChangedPaths } from "../dist/domain/attribution.js";
import { readToolWriteTargets } from "../dist/adapters/pi/native-entries.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const BRANCH = "refs/heads/main";

let counter = 0x500;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-attr-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.fake*\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  const acceptance = new RunAcceptanceService({ store, locks, randomHex });
  return { store, locks, tasks, coordinator, acceptance };
}

async function readyTask(dir, s, title, verification = "self") {
  const task = await s.tasks.newTask({ dir, title, slug: title, branch: BRANCH, verification });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

async function startRun(s, dir, taskId, action, phase = "implement") {
  const prepared = await s.coordinator.prepare({
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake-model" },
  });
  const actionPath = join(dir, ".fake-action.json");
  writeFileSync(actionPath, JSON.stringify(action));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
  assert.equal(started.confirmed, true);
  return prepared.request.runId;
}

async function waitTerminal(s, dir, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await s.coordinator.status({ dir, runId });
    if (isRunSettled(status)) return status;
    if (Date.now() > deadline) throw new Error(`run 未终止: ${status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function cleanup(dir, s) {
  s.store.close();
  rmSync(dir, { recursive: true, force: true });
}

function scopePaths(dir, taskId) {
  return (new RunStore(dir).readScope(taskId)?.entries ?? []).map((entry) => entry.path).sort();
}

function stageOf(dir, task) {
  const raw = readFileSync(join(dir, ".knit", task.relativePath), "utf8");
  return /^stage: (.+)$/m.exec(raw)?.[1];
}

test("归属单元：三类路径、残留继承与报告不实", () => {
  const base = { actual: ["a.txt", "b.txt", "user.txt"], reported: ["a.txt", "b.txt"], toolPaths: ["a.txt"], residue: [] };
  const outcome = classifyChangedPaths(base);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.attributed, ["a.txt"]);
  assert.deepEqual(outcome.unattributed, ["b.txt"], "报告列出的 bash 产物来源不明");
  assert.deepEqual(outcome.external, ["user.txt"], "未列出、非工具写入的是外部改动");

  // 会话不可读：全部来源不明（含未列出的），不判外部改动。
  const unknown = classifyChangedPaths({ ...base, toolPaths: null });
  assert.deepEqual(unknown.unattributed, ["a.txt", "b.txt", "user.txt"]);
  assert.deepEqual(unknown.external, []);

  // 工具写入却漏报仍是报告不实。
  const unlisted = classifyChangedPaths({ actual: ["a.txt"], reported: [], toolPaths: ["a.txt"], residue: [] });
  assert.equal(unlisted.reason, "changed_paths_mismatch:a.txt");

  // 残留：指纹未变且工具写入 → 沿用；指纹已变或来源不明 → 交主会话确认；非残留虚报 → zero_diff。
  const residue = [
    { path: "r1.txt", current: true, toolWritten: true },
    { path: "r2.txt", current: false, toolWritten: true },
    { path: "r3.txt", current: true, toolWritten: false },
  ];
  const inherit = classifyChangedPaths({ actual: [], reported: ["r1.txt", "r2.txt", "r3.txt"], toolPaths: [], residue });
  assert.equal(inherit.ok, true);
  assert.deepEqual(inherit.inherited, ["r1.txt"]);
  assert.deepEqual(inherit.unattributed, ["r2.txt", "r3.txt"]);
  const bogus = classifyChangedPaths({ actual: [], reported: ["nope.txt"], toolPaths: [], residue });
  assert.equal(bogus.reason, "changed_paths_mismatch:zero_diff");
});

test("原生会话解析：只认 write／edit 成功调用，范围从起点条目之后", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knit-attr-native-")));
  try {
    const file = join(dir, "s.jsonl");
    const lines = [
      { type: "session", id: "sid", version: 3 },
      { type: "message", id: "e0", message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "write", arguments: { path: "old.txt" } }] } },
      { type: "message", id: "e1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "w.txt" } }, { type: "toolCall", id: "c2", name: "edit", arguments: { path: "./e.txt" } }] } },
      { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "echo > b.txt" } }] } },
      { type: "message", id: "e3", message: { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "write", arguments: { path: "failed.txt" } }] } },
      { type: "message", id: "e4", message: { role: "toolResult", toolCallId: "c4", toolName: "write", isError: true, content: [] } },
    ];
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    assert.deepEqual(readToolWriteTargets(file, "e0"), { problem: null, paths: ["w.txt", "./e.txt"] });
    assert.deepEqual(readToolWriteTargets(file, null).paths, ["old.txt", "w.txt", "./e.txt"]);
    assert.equal(readToolWriteTargets(file, "missing").problem, "range_unknown");
    assert.equal(readToolWriteTargets(join(dir, "none.jsonl"), null).problem, "unreadable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F2：用户并发写入且 Agent 未列 → 接收成功，路径进 externalChanges，不进 scope 和产物提交", async () => {
  const dir = project("external");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "external");
    const runId = await startRun(s, dir, task.taskId, {
      writes: [{ path: "README.md", content: "# agent\n" }],
      external: [{ path: "user.txt", content: "user\n" }, { path: "a.txt", content: "a user edit\n" }],
      report: { summary: "改 README", changedPaths: ["README.md"] },
    });
    const status = await waitTerminal(s, dir, runId);
    assert.equal(status.state, "completed", status.result.failureReason ?? "");
    assert.equal(status.acceptance.state, "completed");
    assert.equal(status.result.attribution.source, "native_session");
    assert.deepEqual(status.result.externalChanges, ["a.txt", "user.txt"]);
    assert.deepEqual(scopePaths(dir, task.taskId), ["README.md"]);
    assert.equal(stageOf(dir, task), "deliver");

    // 外部文件在接收后继续变化也不影响本任务（不核其指纹）。
    writeFileSync(join(dir, "user.txt"), "user again\n");
    await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    const plan = await delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.deepEqual(plan.tasks[0].artifacts, ["README.md"]);
    assert.deepEqual(plan.tasks[0].externalChanges, ["a.txt", "user.txt"], "交付预检提醒外部改动");
    const result = await delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    const committed = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.workCommit]).split("\n").filter(Boolean);
    assert.deepEqual(committed, ["README.md"], "产物提交只含 scope 路径");
    const dirty = git(dir, ["status", "--porcelain"]);
    assert.match(dirty, /user\.txt/);
    assert.match(dirty, / M a\.txt/);
  } finally {
    cleanup(dir, s);
  }
});

test("F2：Agent 列出外部写入的文件 → 来源不明挂起 unattributed_paths，--include 后进 scope", async () => {
  const dir = project("include");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "include");
    const runId = await startRun(s, dir, task.taskId, {
      writes: [
        { path: "README.md", content: "# agent\n" },
        { path: "gen.txt", content: "generated\n", via: "bash" },
      ],
      report: { summary: "改 README 并生成文件", changedPaths: ["README.md", "gen.txt"] },
    });
    const status = await waitTerminal(s, dir, runId);
    assert.equal(status.result.state, "completed", status.result.failureReason ?? "");
    assert.deepEqual(status.result.attribution.unattributedPaths, ["gen.txt"]);
    assert.equal(status.acceptance.state, "needs_attention");
    assert.equal(status.acceptance.reason, "unattributed_paths:gen.txt");
    assert.deepEqual(scopePaths(dir, task.taskId), [], "挂起时不并入 scope");
    assert.equal(stageOf(dir, task), "implement");
    const view = await new StatusService({ store: s.store, locksRoot: join(dir, ".locks") }).runStatus(dir, runId);
    assert.ok(view.nextActions.some((line) => line.includes(`knit run accept ${runId} --include gen.txt`)));

    // 不属于来源不明集合的路径拒绝；同一路径不能既并入又排除。
    await assert.rejects(
      () => s.acceptance.accept({ dir, runId, decision: { include: ["README.md"], exclude: [], confirmedBy: "t", reason: null } }),
      (error) => error.guardReason === "path_not_unattributed",
    );
    await assert.rejects(
      () => s.acceptance.accept({ dir, runId, decision: { include: ["gen.txt"], exclude: ["gen.txt"], confirmedBy: "t", reason: null } }),
      (error) => error.guardReason === "invalid_request",
    );

    // 确认后按当前指纹并入（确认前内容又变化也按当前指纹）。
    writeFileSync(join(dir, "gen.txt"), "generated v2\n");
    const cli = spawnSync(process.execPath, [CLI, "--json", "run", "accept", runId, "--include", "gen.txt", "--reason", "构建产物", "--by", "main-session", "--dir", dir, "--locks", join(dir, ".locks")], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const response = JSON.parse(cli.stdout);
    assert.equal(response.data.accepted, true);
    const runs = new RunStore(dir);
    assert.deepEqual(scopePaths(dir, task.taskId), ["README.md", "gen.txt"]);
    const entry = runs.readScope(task.taskId).entries.find((item) => item.path === "gen.txt");
    assert.equal(entry.digest.length, 64);
    const confirmation = runs.readAttributionConfirmation(runId);
    assert.deepEqual(confirmation.include, ["gen.txt"]);
    assert.equal(confirmation.confirmedBy, "main-session");
    assert.equal(confirmation.reason, "构建产物");
    assert.equal(stageOf(dir, task), "deliver");
    assert.equal((await s.coordinator.status({ dir, runId })).state, "completed");
    // 已完成接收后不再改写确认。
    await assert.rejects(
      () => s.acceptance.accept({ dir, runId, decision: { include: [], exclude: ["gen.txt"], confirmedBy: "t", reason: null } }),
      (error) => error.guardReason === "already_accepted",
    );
  } finally {
    cleanup(dir, s);
  }
});

test("F2：来源不明路径 --exclude 后不进 scope、不进交付", async () => {
  const dir = project("exclude");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "exclude");
    const runId = await startRun(s, dir, task.taskId, {
      writes: [
        { path: "README.md", content: "# agent\n" },
        { path: "user.txt", content: "user\n", via: "bash" },
      ],
      report: { summary: "列出了 user.txt", changedPaths: ["README.md", "user.txt"] },
    });
    const status = await waitTerminal(s, dir, runId);
    assert.equal(status.acceptance.reason, "unattributed_paths:user.txt");
    const accepted = await s.acceptance.accept({ dir, runId, decision: { include: [], exclude: ["user.txt"], confirmedBy: "t", reason: "用户自己的文件" } });
    assert.equal(accepted.accepted, true, accepted.reason ?? "");
    assert.deepEqual(scopePaths(dir, task.taskId), ["README.md"]);
    await s.tasks.close({ dir, taskId: task.taskId, outcome: "completed", runsSettled: true });
    const delivery = new DeliveryService({ store: s.store, locks: s.locks, randomHex });
    const plan = await delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.deepEqual(plan.tasks[0].externalChanges, ["user.txt"], "被排除的路径在交付预检中提醒");
    const result = await delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    const committed = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.workCommit]).split("\n").filter(Boolean);
    assert.deepEqual(committed, ["README.md"]);
    assert.match(git(dir, ["status", "--porcelain"]), /user\.txt/);
  } finally {
    cleanup(dir, s);
  }
});

test("S3：失败 run 留下文件，下一轮声明继承 → 接收成功，scope 含该路径", async () => {
  const dir = project("residue");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "residue");
    // 第一轮：真实写入两个文件，但把累计成果之外的路径也列进报告 → changed_paths_mismatch 失败。
    const first = await startRun(s, dir, task.taskId, {
      writes: [
        { path: "src.txt", content: "partial\n" },
        { path: "README.md", content: "# partial\n" },
      ],
      report: { summary: "列错路径", changedPaths: ["src.txt", "README.md", "missing.txt"] },
    });
    const firstStatus = await waitTerminal(s, dir, first);
    assert.equal(firstStatus.state, "failed");
    assert.match(firstStatus.result.failureReason, /^changed_paths_mismatch:/);
    const runs = new RunStore(dir);
    assert.deepEqual(runs.readResidue(task.taskId).entries.map((entry) => entry.path), ["README.md", "src.txt"]);

    // 第二轮：继续这份工作——改 src.txt（本 run 改动），README.md 沿用残留，并新增一个文件。
    const second = await startRun(s, dir, task.taskId, {
      writes: [
        { path: "src.txt", content: "done\n" },
        { path: "more.txt", content: "more\n" },
      ],
      report: { summary: "续做并继承残留", changedPaths: ["src.txt", "README.md", "more.txt"] },
    });
    const secondStatus = await waitTerminal(s, dir, second);
    assert.equal(secondStatus.state, "completed", secondStatus.result.failureReason ?? "");
    assert.equal(secondStatus.acceptance.state, "completed");
    assert.deepEqual(secondStatus.result.attribution.inheritedPaths, ["README.md"]);
    assert.deepEqual(scopePaths(dir, task.taskId), ["README.md", "more.txt", "src.txt"]);
    assert.equal(runs.readResidue(task.taskId).entries.length, 0, "并入后残留被消费");
    assert.equal(stageOf(dir, task), "deliver");
  } finally {
    cleanup(dir, s);
  }
});

test("S3：残留指纹已变 → 按本 run 改动处理；被外部改动的残留需主会话确认", async () => {
  const dir = project("residue-drift");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "residue-drift");
    const first = await startRun(s, dir, task.taskId, {
      writes: [{ path: "x.txt", content: "x1\n" }, { path: "y.txt", content: "y1\n" }],
      report: { summary: "漏报", changedPaths: [] },
    });
    assert.equal((await waitTerminal(s, dir, first)).state, "failed");
    // 用户在两轮之间改了 y.txt；第二轮 Agent 又写了 x.txt。
    writeFileSync(join(dir, "y.txt"), "y user\n");
    const second = await startRun(s, dir, task.taskId, {
      writes: [{ path: "x.txt", content: "x2\n" }],
      report: { summary: "续做", changedPaths: ["x.txt", "y.txt"] },
    });
    const status = await waitTerminal(s, dir, second);
    assert.equal(status.result.state, "completed", status.result.failureReason ?? "");
    assert.deepEqual(status.result.attribution.attributedPaths, ["x.txt"], "指纹已变且本 run 写入 → 按本 run 改动");
    assert.deepEqual(status.result.attribution.unattributedPaths, ["y.txt"], "被外部改动的残留来源不明");
    assert.equal(status.acceptance.reason, "unattributed_paths:y.txt");
    const accepted = await s.acceptance.accept({ dir, runId: second, decision: { include: ["y.txt"], exclude: [], confirmedBy: "t", reason: null } });
    assert.equal(accepted.accepted, true, accepted.reason ?? "");
    assert.deepEqual(scopePaths(dir, task.taskId), ["x.txt", "y.txt"]);
    assert.equal(new RunStore(dir).readResidue(task.taskId).entries.length, 0);
  } finally {
    cleanup(dir, s);
  }
});
