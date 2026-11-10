/**
 * 凭据完整性、阶段调用边界与交付 hooks 隔离（任务 k-28296c22647a，审计 S8、中等问题 4／5）。
 * 隔离夹具：临时 Git 仓库、临时密钥根（KNIT_KEYS_ROOT）与最小 Pi RPC 假实现；不调用真实模型。
 * 覆盖：篡改 checks/*.json → credential_tampered；旧凭据缺签名 → credential_unsigned；
 * worker 环境调用 deliver 等收尾命令 → stage_context_forbidden；阶段写入的 pre-commit 在 skip 模式不执行；
 * 桥接路径伪造的 user: 引用被拒；凭据扫描覆盖暂存的全部路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { DeliveryService } from "../dist/application/delivery-service.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { RunActivityService } from "../dist/application/run-activity.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { currentEntry, emptyScope, scopeDigest } from "../dist/application/scope.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { projectKeyPath, inspectSealed } from "../dist/infrastructure/credential-seal.js";
import { resolveAuthorization } from "../dist/application/delivery.js";
import { isolatedEnv } from "../dist/adapters/pi/runtime.js";
import { scanCredentials } from "../dist/contracts/credentials.js";
import { sha256Text } from "../dist/infrastructure/fingerprint.js";
import { isRunSettled } from "./helpers/run-settled.mjs";

const NOW = new Date("2026-11-07T10:00:00.000Z");
const BRANCH = "refs/heads/main";
const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");

// 每个测试进程使用独立密钥根：不触碰用户 ~/.knit/keys。
const KEYS_ROOT = mkdtempSync(join(tmpdir(), "knit-keys-"));
process.env.KNIT_KEYS_ROOT = KEYS_ROOT;
test.after(() => rmSync(KEYS_ROOT, { recursive: true, force: true }));

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** 交付夹具：hooks 取缺省（skip）；AGENTS.md 提供项目交付授权章节。 */
function project(name, delivery = { mode: "local" }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-cred-${name}-`)));
  mkdirSync(join(dir, ".knit", "agents"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, ".knit", "standards"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".knit", "config.json"), JSON.stringify({
    schemaVersion: 1,
    client: { default: "pi" },
    agent: { runtime: "pi", resume: "prefer" },
    execution: { host: "local" },
    delivery,
    workflow: { maxRepairRounds: 2 },
    limits: { heartbeatIntervalMs: 5000, heartbeatStaleMs: 30000, cancelGraceMs: 5000, snapshotsMaxBytes: 67108864, storageWarnBytes: 536870912 },
  }, null, 2) + "\n");
  writeFileSync(join(dir, "AGENTS.md"), "# 项目规则\n\n## 交付授权\n\n允许在当前分支按任务范围提交并归档。\n");
  writeFileSync(join(dir, ".knit", "standards", "index.md"), "# 规范索引\n\n- 暂无\n");
  writeFileSync(join(dir, ".knit", "agents", "check.md"), "# 检查角色\n\n核对完成条件。\n");
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(dir, "app.txt"), "old\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  let sequence = 0;
  const hex = () => (++sequence).toString(16).padStart(12, "0").slice(-12);
  const tasks = new TaskService({ store, locks, now: () => NOW, randomHex: hex });
  const delivery = new DeliveryService({ store, locks, now: () => NOW, randomHex: hex });
  return { store, locks, tasks, delivery };
}

/** 构造处在 deliver 阶段、带通过检查凭据的 independent 任务（检查凭据经 RunStore 写入，带本机签名）。 */
async function makeDeliverable(dir, s, { extraScope = [] } = {}) {
  const created = await s.tasks.newTask({ dir, title: "凭据完整性", slug: "cred", branch: BRANCH, verification: "independent" });
  const taskFile = join(dir, ".knit", created.relativePath);
  const doc = parseTaskDocument(readFileSync(taskFile, "utf8"), taskFile);
  writeFileSync(taskFile, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, stage: "deliver" } }));
  writeFileSync(join(dir, "app.txt"), "new\n");
  const plan = await new ContextPlanner({ store: s.store, now: () => NOW, randomHex: () => "abcdef123456" })
    .plan({ dir, taskId: created.taskId, role: "check" });
  const scope = emptyScope(created.taskId, NOW.toISOString());
  for (const path of ["app.txt", ...extraScope]) scope.entries.push(currentEntry(dir, path, { factsKind: true }));
  scope.digest = scopeDigest(scope.entries);
  const runs = new RunStore(dir);
  runs.writeScope(created.taskId, scope);
  const check = {
    schemaVersion: 1,
    taskId: created.taskId,
    runId: `run-${created.taskId.slice(2)}`,
    branch: BRANCH,
    verdict: "pass",
    report: { summary: "通过", verdict: "pass", coverage: ["app.txt"] },
    inputsDigest: plan.inputsDigest,
    standardsDigest: plan.standardsDigest,
    effectiveInputsDigest: plan.effectiveInputsDigest,
    scopeDigest: scope.digest,
    recordedAt: NOW.toISOString(),
  };
  runs.writeCheck(check.runId, check);
  const binding = await s.store.bindings.get(created.taskId);
  await s.store.bindings.save({
    ...binding,
    lastCheckRunId: check.runId,
    confirmedInputsDigest: plan.inputsDigest,
    confirmedStandardsDigest: plan.standardsDigest,
    scope: scope.entries,
    scopeRunIds: [check.runId],
  });
  return { ...created, taskFile, check, runs };
}

function cleanup(s, dir) {
  s.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

function artifactCommits(dir) {
  return git(dir, ["log", "--format=%H", "--fixed-strings", "--grep=Knit-Stage: artifact"]).split("\n").filter(Boolean);
}

/** CLI 子进程环境：清除宿主 Rex／阶段标记，沿用测试密钥根。 */
function cliEnv(extra = {}) {
  const env = { ...process.env, KNIT_KEYS_ROOT: KEYS_ROOT, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith("REX_") || key === "TERM_PROGRAM") delete env[key];
  if (!("KNIT_STAGE_RUN_ID" in extra)) delete env.KNIT_STAGE_RUN_ID;
  return env;
}

function cliJson(args, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args], { encoding: "utf8", env: cliEnv(extra) });
  return { code: result.status, body: result.stdout.trim() === "" ? null : JSON.parse(result.stdout), stderr: result.stderr };
}

test("凭据带本机 HMAC：密钥 0600 在项目外；签名与正文、种类、文件名绑定", async () => {
  const dir = project("seal");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const keyPath = projectKeyPath(dir);
    assert.ok(keyPath.startsWith(KEYS_ROOT), "密钥在密钥根下，不在项目内");
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    const file = task.runs.checkPath(task.check.runId);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.integrity.alg, "hmac-sha256");
    assert.equal(inspectSealed(dir, "check", task.check.runId, raw).verdict, "valid");
    // 挪用到别的 run 名或种类：签名不再成立。
    assert.equal(inspectSealed(dir, "check", "run-000000000000", raw).verdict, "credential_tampered");
    assert.equal(inspectSealed(dir, "completion", task.check.runId, raw).verdict, "credential_tampered");
    assert.deepEqual(task.runs.readCheck(task.check.runId), task.check);
    // 阶段进程环境不传密钥路径覆盖。
    assert.equal("KNIT_KEYS_ROOT" in isolatedEnv(), false);
  } finally {
    cleanup(s, dir);
  }
});

test("篡改 checks/*.json → 交付以 credential_tampered 拒绝，无产物提交", async () => {
  const dir = project("tamper-check");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const file = task.runs.checkPath(task.check.runId);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // 把检查结论改成 pass 以外再改回、或者改覆盖范围：任何改动都使签名失效。
    raw.report.coverage = ["app.txt", "forged.txt"];
    writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "credential_tampered",
    );
    assert.equal(artifactCommits(dir).length, 0, "未产生交付提交");
    // CLI 回执给稳定原因码（needs_review），不当作有效凭据。
    const cli = cliJson(["deliver", task.taskId, "--branch", BRANCH, "--dir", dir, "--locks", join(dir, ".locks")]);
    assert.equal(cli.code, 1);
    assert.equal(cli.body.reasonCode, "needs_review");
    assert.match(cli.body.data.error, /credential_tampered/);
  } finally {
    cleanup(s, dir);
  }
});

test("阶段 Agent 伪造无签名检查凭据（旧格式）→ credential_unsigned，需重建", async () => {
  const dir = project("unsigned");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const file = task.runs.checkPath(task.check.runId);
    const { integrity, ...payload } = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(integrity);
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "credential_unsigned",
    );
    // 本机密钥被删或更换：既有签名一律不再采信。
    rmSync(projectKeyPath(dir));
    writeFileSync(file, JSON.stringify({ ...payload, integrity }, null, 2) + "\n");
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "credential_tampered",
    );
  } finally {
    cleanup(s, dir);
  }
});

test("篡改完成凭据：已关闭任务交付按 credential_tampered 拒绝；实施记录篡改同样不作有效凭据", async () => {
  const dir = project("tamper-completion");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const runs = task.runs;
    runs.writeCompletion(task.taskId, {
      schemaVersion: 1,
      taskId: task.taskId,
      verification: "independent",
      inputsDigest: "x",
      scopeDigest: "y",
      implementRunId: task.check.runId,
      checkRunId: task.check.runId,
      unverified: [],
      reason: null,
      completedAt: NOW.toISOString(),
    });
    const path = runs.completionPath(task.taskId);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.forced = true;
    raw.forcedReason = "伪造";
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
    const doc = parseTaskDocument(readFileSync(task.taskFile, "utf8"), task.taskFile);
    writeFileSync(task.taskFile, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, status: "closed", outcome: "completed" } }));
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "credential_tampered",
    );
    assert.throws(() => runs.readCompletion(task.taskId), (error) => error.guardReason === "credential_tampered");
    // 实施记录：主会话写入带签名，篡改后读取拒绝。
    runs.writeImplementation(task.taskId, {
      schemaVersion: 1,
      taskId: task.taskId,
      executor: "main-session",
      inputsDigest: "x",
      entries: [currentEntry(dir, "app.txt", { factsKind: true })],
      scopeDigest: "y",
      validations: ["ok"],
      unverified: [],
      summary: null,
      recordedAt: NOW.toISOString(),
    });
    const implPath = runs.implementationPath(task.taskId);
    const impl = JSON.parse(readFileSync(implPath, "utf8"));
    impl.validations = ["伪造验证"];
    writeFileSync(implPath, JSON.stringify(impl, null, 2) + "\n");
    assert.throws(() => runs.readImplementation(task.taskId), (error) => error.guardReason === "credential_tampered");
  } finally {
    cleanup(s, dir);
  }
});

test("worker 环境（KNIT_STAGE_RUN_ID）下调用 knit deliver 等收尾命令 → stage_context_forbidden", async () => {
  const dir = project("stage-context");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const stage = { KNIT_STAGE_RUN_ID: "run-0000000000aa" };
    const locks = ["--locks", join(dir, ".locks")];
    const commands = [
      ["deliver", task.taskId, "--branch", BRANCH, "--dir", dir, ...locks],
      ["archive", task.taskId, "--branch", BRANCH, "--dir", dir, ...locks],
      ["task", "close", task.taskId, "--outcome", "cancelled", "--dir", dir],
      ["run", "accept", "run-0000000000bb", "--dir", dir, ...locks],
      ["unlock", "project/abc", "--expect-token", "t", ...locks],
      ["gc", "--apply", "--dir", dir, ...locks],
      ["worktree", "merge", "--task", task.taskId, "--into", BRANCH, "--apply", "--authorization-ref", "user:x", "--dir", dir],
      ["worktree", "cleanup", "--task", task.taskId, "--dir", dir],
    ];
    for (const args of commands) {
      const result = cliJson(args, stage);
      assert.equal(result.code, 1, `${args.slice(0, 2).join(" ")} 应失败: ${result.stderr}`);
      assert.match(result.body?.data?.error ?? "", /stage_context_forbidden/, `${args.slice(0, 2).join(" ")}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.reasonCode, "needs_review");
    }
    // 只读预检仍可用；任务未被关闭、没有交付提交。
    const plan = cliJson(["deliver", task.taskId, "--branch", BRANCH, "--plan", "--dir", dir, ...locks], stage);
    assert.equal(plan.code, 0, plan.stderr);
    assert.equal(parseTaskDocument(readFileSync(task.taskFile, "utf8"), task.taskFile).frontmatter.status, "open");
    assert.equal(artifactCommits(dir).length, 0);
    // 服务层同口径：库调用也拒绝。
    process.env.KNIT_STAGE_RUN_ID = "run-0000000000aa";
    try {
      await assert.rejects(
        () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
        (error) => error.details?.guardReason === "stage_context_forbidden",
      );
      await assert.rejects(
        () => s.tasks.close({ dir, taskId: task.taskId, outcome: "cancelled", runsSettled: true }),
        (error) => error.details?.guardReason === "stage_context_forbidden",
      );
    } finally {
      delete process.env.KNIT_STAGE_RUN_ID;
    }
    // 标记清除后（主会话）可正常交付。
    const result = cliJson(["deliver", task.taskId, "--branch", BRANCH, "--dir", dir, ...locks]);
    assert.equal(result.code, 0, JSON.stringify(result.body));
    assert.equal(result.body.data.caller, "cli-unverified");
  } finally {
    cleanup(s, dir);
  }
});

test("阶段写入的 .git/hooks/pre-commit 在交付时不执行（skip 缺省），并在交付前列出", async () => {
  const dir = project("hooks-skip");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const marker = join(dir, "..", `${task.taskId}-hook-ran`);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    const plan = await s.delivery.plan([{ dir, taskId: task.taskId, branch: BRANCH }]);
    assert.equal(plan.hooks.mode, "skip");
    assert.deepEqual(plan.hooks.changes, [{ name: "pre-commit", change: "added" }]);
    assert.equal(plan.hooks.baseline, "none");
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.ok(result.workCommit, "产物提交已生成（hook 若执行会以 exit 1 拒绝）");
    assert.equal(existsSync(marker), false, "pre-commit 未执行");
    assert.deepEqual(result.hooks.changes, [{ name: "pre-commit", change: "added" }]);
    // 交付后记录 hooks 基线：同一 hook 不再被列出；之后修改才列为 modified。
    const second = await makeDeliverable(dir, s);
    const quiet = await s.delivery.plan([{ dir, taskId: second.taskId, branch: BRANCH }]);
    assert.equal(quiet.hooks.baseline, "recorded");
    assert.deepEqual(quiet.hooks.changes, []);
    writeFileSync(hook, `#!/bin/sh\necho changed >> '${marker}'\n`);
    const changed = await s.delivery.plan([{ dir, taskId: second.taskId, branch: BRANCH }]);
    assert.deepEqual(changed.hooks.changes, [{ name: "pre-commit", change: "modified" }]);
    rmSync(marker, { force: true });
  } finally {
    cleanup(s, dir);
  }
});

/** 非提交类 hook：add／reset／status 刷新 index 触发 post-index-change，引用变更触发 reference-transaction。 */
function installIndexHooks(dir, marker) {
  for (const name of ["post-index-change", "reference-transaction"]) {
    const hook = join(dir, ".git", "hooks", name);
    writeFileSync(hook, `#!/bin/sh\necho ${name} >> '${marker}'\n`);
    chmodSync(hook, 0o755);
  }
}

test("skip 模式：交付与归档全程（add／reset／commit）不触发 post-index-change／reference-transaction", async () => {
  const dir = project("index-hooks");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    // 标记放在 .git 内：不进入工作区状态，随夹具目录清理。
    const marker = join(dir, ".git", "index-hook-ran");
    installIndexHooks(dir, marker);
    // 对照：hook 在该仓库确实生效（Knit 之外的 git 操作会触发）。
    git(dir, ["read-tree", "HEAD"]);
    assert.equal(existsSync(marker), true, "对照：直接 git read-tree 触发 post-index-change");
    rmSync(marker, { force: true });
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.ok(result.workCommit);
    assert.ok(result.archiveCommit, "归档提交（含 add 与封存标记 reset）已生成");
    assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  } finally {
    cleanup(s, dir);
  }
});

test("run 模式：同一 post-index-change 在交付中照常执行（对照）", async () => {
  const dir = project("index-hooks-run", { mode: "local", hooks: "run" });
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const marker = join(dir, ".git", "index-hook-ran");
    installIndexHooks(dir, marker);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.match(readFileSync(marker, "utf8"), /post-index-change/);
  } finally {
    cleanup(s, dir);
  }
});

test("delivery.hooks: run 时保留用户 hooks（显式选择）", async () => {
  const dir = project("hooks-run", { mode: "local", hooks: "run" });
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const marker = join(dir, "..", `${task.taskId}-hook-run`);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\n`);
    chmodSync(hook, 0o755);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.hooks.mode, "run");
    assert.equal(existsSync(marker), true, "run 模式执行仓库 hook");
    rmSync(marker, { force: true });
  } finally {
    cleanup(s, dir);
  }
});

test("worker 端到端：阶段进程收到 KNIT_STAGE_RUN_ID，阶段内调用 knit deliver 被拒", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knit-cred-e2e-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.fake*\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  let counter = 0x7c0000;
  const randomHex = () => (++counter).toString(16).padStart(12, "0").slice(-12);
  const tasks = new TaskService({ store, locks: new LockManager({ root: join(dir, ".locks") }), randomHex, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  const actionPath = join(dir, "..", `${counter}-cred-action.json`);
  try {
    const task = await tasks.newTask({ dir, title: "阶段边界", slug: "stage-boundary", verification: "self" });
    await tasks.ready({ dir, taskId: task.taskId });
    const prepared = await coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "implement",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "fake", model: "fake-model" },
    });
    const runId = prepared.request.runId;
    // 阶段内：记录环境标记，并尝试直接调用 knit deliver（不带 --caller agent）。
    writeFileSync(actionPath, JSON.stringify({
      writes: [{ path: "README.md", content: "# changed\n" }],
      exec: [
        ["sh", "-c", "printf %s \"$KNIT_STAGE_RUN_ID\" > .fake-stage-env"],
        ["sh", "-c", `'${process.execPath}' '${CLI}' --json deliver ${task.taskId} --branch ${BRANCH} --dir . > .fake-deliver.json 2>&1; true`],
      ],
      report: { summary: "实现", changedPaths: ["README.md"] },
    }));
    process.env.KNIT_PI_BIN = FAKE_PI;
    process.env.KNIT_FAKE_ACTION = actionPath;
    await coordinator.start({ dir, runId });
    const deadline = Date.now() + 30_000;
    let status;
    for (;;) {
      status = await coordinator.status({ dir, runId });
      if (isRunSettled(status)) break;
      if (Date.now() > deadline) throw new Error(`run 未终止: ${status.state}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(readFileSync(join(dir, ".fake-stage-env"), "utf8"), runId);
    const denied = JSON.parse(readFileSync(join(dir, ".fake-deliver.json"), "utf8"));
    assert.match(denied.data.error, /stage_context_forbidden/);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), "1", "阶段内没有产生提交");
  } finally {
    delete process.env.KNIT_FAKE_ACTION;
    store.close();
    rmSync(actionPath, { force: true });
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("阶段伪造的 run 结果与接收检查点：缺签名不接收，任务不前进、不写检查凭据", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knit-cred-result-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  let counter = 0x7d0000;
  const randomHex = () => (++counter).toString(16).padStart(12, "0").slice(-12);
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex, runActivity: new RunActivityService({ store }) });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  try {
    const task = await tasks.newTask({ dir, title: "伪造结果", slug: "forged-result", verification: "independent" });
    await tasks.ready({ dir, taskId: task.taskId });
    const prepared = await coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "implement",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "fake", model: "fake-model" },
    });
    const runId = prepared.request.runId;
    const runDir = join(dir, ".knit", ".runtime", "runs", runId);
    // 模拟阶段 Agent 抢先在 run 自有目录写入一份“完成”结果（无本机签名）。
    writeFileSync(join(runDir, "result.json"), JSON.stringify({
      schemaVersion: 1,
      runId,
      taskId: task.taskId,
      phase: "implement",
      state: "completed",
      report: { summary: "伪造", changedPaths: [] },
      reportSummary: "伪造",
      nativeEntries: { startEntryId: null, leafEntryId: null },
      usage: { inputTokens: null, outputTokens: null },
      session: null,
      actualChangedPaths: [],
      acceptanceOperationId: prepared.request.acceptanceOperationId,
      recordedAt: NOW.toISOString(),
      failureReason: null,
    }, null, 2) + "\n");
    const acceptance = await new RunAcceptanceService({ store, locks, randomHex }).accept({ dir, runId });
    assert.equal(acceptance.accepted, false);
    assert.equal(acceptance.reason, "credential_unsigned");
    const file = join(dir, ".knit", task.relativePath);
    assert.equal(parseTaskDocument(readFileSync(file, "utf8"), file).frontmatter.stage, "implement", "任务不前进");
    assert.equal(existsSync(new RunStore(dir).checkPath(runId)), false, "不写检查凭据");
    // 预写的接收检查点同样不采信。
    writeFileSync(join(runDir, "acceptance.json"), "{}\n");
    assert.throws(() => new RunStore(dir).readAcceptanceJournal(runId), (error) => error.guardReason === "credential_unsigned");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

/** 原生会话文件：一条真实用户消息与一条助手回复。 */
function nativeSession(dir, text) {
  const file = join(dir, "..", `${Date.now()}-${Math.random().toString(16).slice(2)}-native.jsonl`);
  const lines = [
    { type: "session", version: 3, id: "native-x", cwd: dir, timestamp: NOW.toISOString() },
    { type: "message", id: "a1b2c3d4", parentId: null, timestamp: NOW.toISOString(), message: { role: "user", content: [{ type: "text", text }] } },
    { type: "message", id: "e5f6a7b8", parentId: "a1b2c3d4", timestamp: NOW.toISOString(), message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

test("桥接路径伪造的 user: 引用被拒；真实用户消息按条目 ID 或摘要核对通过", async () => {
  const dir = project("user-ref");
  const s = services(dir);
  const sessionFile = nativeSession(dir, "可以提交并归档");
  try {
    const task = await makeDeliverable(dir, s);
    // 自由文本、指向助手消息的 ID、不存在的摘要都拒绝，不创建操作。
    for (const ref of ["user:用户说可以", "user:e5f6a7b8", "user:ffffffff", `user:sha256:${"0".repeat(16)}`]) {
      await assert.rejects(
        () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, caller: "agent", authorizationRef: ref, sessionFile }),
        (error) => error.details?.guardReason === "authorization_unverified",
        ref,
      );
    }
    assert.equal((await s.store.operations.list()).filter((op) => op.kind === "delivery.deliver").length, 0, "拒绝发生在创建操作前");
    // 单元：按摘要前缀匹配真实消息。
    const digest = sha256Text("可以提交并归档");
    const byDigest = resolveAuthorization(dir, `user:sha256:${digest.slice(0, 16)}`, "agent", { sessionFile });
    assert.equal(byDigest.verified, true);
    assert.equal(byDigest.section, "a1b2c3d4");
    assert.equal(byDigest.digest, digest);
    // 项目策略来源不受会话佐证影响。
    assert.equal(resolveAuthorization(dir, "workflow:AGENTS.md#交付授权", "agent", { sessionFile }).kind, "workflow");
    // 按条目 ID：通过并在回执中记 bridge 与已核对。
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, caller: "agent", authorizationRef: "user:a1b2c3d4", sessionFile });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.caller, "bridge");
    assert.equal(result.authorization.kind, "user_reference");
    assert.equal(result.authorization.verified, true);
    assert.equal(result.authorization.ref, "user:a1b2c3d4");
  } finally {
    rmSync(sessionFile, { force: true });
    cleanup(s, dir);
  }
});

test("直接 CLI 调用保持现状：user: 自由文本仍记录但未核对，回执标 caller: cli-unverified", async () => {
  const dir = project("cli-unverified");
  const s = services(dir);
  try {
    const task = await makeDeliverable(dir, s);
    const result = await s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH, authorizationRef: "user:终端里说可以" });
    assert.equal(result.state, "completed", result.reason ?? "");
    assert.equal(result.caller, "cli-unverified");
    assert.equal(result.authorization.verified, false);
    const archived = readFileSync(join(dir, result.archivePath, "task.md"), "utf8");
    assert.match(archived, /- 调用: cli-unverified/);
  } finally {
    cleanup(s, dir);
  }
});

test("凭据扫描覆盖产物提交的全部暂存路径：scope 目录下的新文件命中即暂停", async () => {
  const dir = project("scan-staged");
  const s = services(dir);
  try {
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg", "keep.txt"), "keep\n");
    git(dir, ["add", "pkg"]);
    git(dir, ["commit", "-q", "-m", "pkg"]);
    const task = await makeDeliverable(dir, s, { extraScope: ["pkg"] });
    // scope 只登记目录 pkg；目录内新增文件会随 git add -A 进入产物提交。
    const sample = ["AK", "IA", "IOSFODNN7", "EXAMP", "LE"].join("");
    writeFileSync(join(dir, "pkg", "new.txt"), `id=${sample}\n`);
    await assert.rejects(
      () => s.delivery.deliver({ dir, taskId: task.taskId, branch: BRANCH }),
      (error) => error.details?.guardReason === "credential_scan_hit" && /pkg\/new\.txt/.test(error.message) && !error.message.includes(sample),
    );
    assert.equal(artifactCommits(dir).length, 0);
  } finally {
    cleanup(s, dir);
  }
});

test("本任务新增源码与测试通过凭据扫描（generic_secret_assignment 零命中）", () => {
  const root = join(import.meta.dirname, "..");
  for (const path of [
    "src/infrastructure/credential-seal.ts",
    "src/application/stage-context.ts",
    "test/credential-integrity.test.mjs",
  ]) {
    assert.deepEqual(scanCredentials(readFileSync(join(root, path), "utf8")), [], path);
  }
});
