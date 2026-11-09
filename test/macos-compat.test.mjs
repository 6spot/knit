/**
 * macOS 开发环境兼容（任务 k-fd956a1c3dc0）：在任意平台用可注入条件模拟 macOS 触发点。
 * - 进程组信号：killpg 在 macOS 对僵尸组返回 EPERM；
 * - Rex bridge socket：sun_path 104 字节上限，超长回退 $TMPDIR 短路径；
 * - /var → /private/var 符号链接：路径规范化与 worktree connect；
 * - CLI：run resume／resume、run cancel／cancel 共用实现，已终态取消语义一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalProcessGroup } from "../dist/adapters/pi/index.js";
import {
  BridgeClient,
  BridgeServer,
  ensureSocketDirectory,
  rexSocketPath,
  rexSocketPathFor,
  unixSocketPathLimit,
} from "../dist/adapters/rex/index.js";
import { canonicalPath, samePath } from "../dist/infrastructure/paths.js";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { WorktreeService } from "../dist/application/worktree-manager.js";
import { renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli", "knit.js");
const TEMPLATES = join(ROOT, "assets", "templates", ".knit");

function errno(code) {
  const error = new Error(`kill ${code}`);
  error.code = code;
  return error;
}

/** 记录调用并按脚本返回／抛错的假 kill。 */
function scriptedKill(script) {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    const step = script.shift();
    if (step !== undefined && step !== null) throw errno(step);
  };
  return { kill, calls };
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** 模拟 macOS 临时目录：<base>/var 是指向 <base>/private/var 的符号链接，返回别名路径。 */
function aliasedTmp(prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `knit-mac-${prefix}-`)));
  mkdirSync(join(base, "private", "var", "folders", "T"), { recursive: true });
  symlinkSync(join("private", "var"), join(base, "var"));
  return { base, alias: join(base, "var", "folders", "T"), real: join(base, "private", "var", "folders", "T") };
}

test("进程组信号：ESRCH 视为已结束；EPERM 在已退出时视为已结束，未退出时回退组长 pid", () => {
  let fake = scriptedKill([null]);
  assert.equal(signalProcessGroup(4242, "SIGTERM", { exited: false, kill: fake.kill }), true);
  assert.deepEqual(fake.calls, [[-4242, "SIGTERM"]]);

  fake = scriptedKill(["ESRCH"]);
  assert.equal(signalProcessGroup(4242, "SIGKILL", { exited: false, kill: fake.kill }), false);
  assert.deepEqual(fake.calls, [[-4242, "SIGKILL"]]);

  // macOS：组长已退出（僵尸）时 killpg 返回 EPERM；已观察到退出则不再抛错、也不再发信号。
  fake = scriptedKill(["EPERM"]);
  assert.equal(signalProcessGroup(4242, "SIGKILL", { exited: true, kill: fake.kill }), false);
  assert.deepEqual(fake.calls, [[-4242, "SIGKILL"]]);

  // 尚未观察到退出：退而向组长 pid 发信号。
  fake = scriptedKill(["EPERM", null]);
  assert.equal(signalProcessGroup(4242, "SIGTERM", { exited: false, kill: fake.kill }), true);
  assert.deepEqual(fake.calls, [[-4242, "SIGTERM"], [4242, "SIGTERM"]]);

  fake = scriptedKill(["EPERM", "ESRCH"]);
  assert.equal(signalProcessGroup(4242, "SIGTERM", { exited: false, kill: fake.kill }), false);
  fake = scriptedKill(["EPERM", "EPERM"]);
  assert.equal(signalProcessGroup(4242, "SIGTERM", { exited: false, kill: fake.kill }), false);

  // 其它错误照实抛出。
  fake = scriptedKill(["EINVAL"]);
  assert.throws(() => signalProcessGroup(4242, "SIGTERM", { exited: false, kill: fake.kill }), /EINVAL/);
});

test("Rex socket：sun_path 上限按平台；超长回退 $TMPDIR 短路径且同一 run 目录稳定", () => {
  assert.equal(unixSocketPathLimit("darwin"), 103);
  assert.equal(unixSocketPathLimit("freebsd"), 103);
  assert.equal(unixSocketPathLimit("linux"), 107);

  const shortRun = "/tmp/p/.knit/.runtime/runs/run-000000000001";
  assert.equal(rexSocketPathFor(shortRun, { limit: 103 }), rexSocketPath(shortRun));

  // 典型 macOS 临时目录下的 run 目录：/var/folders/... 拼上 .knit/.runtime/runs/<id>/rex/bridge.sock 超过 104 字节。
  const longRun = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/knit-rex-project-launcher-AbCdEf/.knit/.runtime/runs/run-000000000001";
  assert.ok(Buffer.byteLength(rexSocketPath(longRun)) > 103);
  const fallback = rexSocketPathFor(longRun, { limit: 103, tmpDirs: ["/tmp"], owner: "501" });
  const digest = createHash("sha256").update(longRun, "utf8").digest("hex").slice(0, 16);
  assert.equal(fallback, join("/tmp", "knit-rex-501", `${digest}.sock`));
  assert.ok(Buffer.byteLength(fallback) <= 103);
  assert.equal(rexSocketPathFor(longRun, { limit: 103, tmpDirs: ["/tmp"], owner: "501" }), fallback, "同一 run 目录稳定");
  assert.notEqual(rexSocketPathFor(`${longRun}x`, { limit: 103, tmpDirs: ["/tmp"], owner: "501" }), fallback, "不同 run 目录不冲突");

  // $TMPDIR 过长时改试下一个候选（缺省 /tmp）。
  const tooLong = `/${"t".repeat(120)}`;
  assert.equal(rexSocketPathFor(longRun, { limit: 103, tmpDirs: [tooLong, "/tmp"], owner: "501" }), fallback);
  // 全部候选过长：如实报错，不静默截断。
  assert.throws(
    () => rexSocketPathFor(longRun, { limit: 103, tmpDirs: [tooLong], owner: "501" }),
    /超过平台上限 103 字节.*TMPDIR/,
  );
});

test("Rex socket：回退目录按 0700 创建，非目录或符号链接拒绝；短路径上 bridge 可往返", async () => {
  // 放在 /tmp 下的短目录：与 $TMPDIR 长度无关（macOS 的 /var/folders/... 较长）。
  const workspace = realpathSync(mkdtempSync(join("/tmp", "kms-")));
  try {
    const longRun = join(workspace, "x".repeat(120), ".knit", ".runtime", "runs", "run-000000000001");
    const socketPath = rexSocketPathFor(longRun, { limit: unixSocketPathLimit(), tmpDirs: [workspace], owner: "t" });
    assert.ok(socketPath.startsWith(join(workspace, "knit-rex-t")));
    const server = new BridgeServer(socketPath, () => ({ status: "idle", run: 0 }), () => ({ status: "idle", run: 0 }));
    await server.listen();
    try {
      const directory = join(workspace, "knit-rex-t");
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      const client = await BridgeClient.connect(socketPath, () => {}, () => {});
      try {
        assert.deepEqual(await client.call("status"), { status: "idle", run: 0 });
      } finally {
        client.close();
      }
    } finally {
      await server.close();
    }
    assert.equal(existsSync(socketPath), false, "关闭后清理 socket");

    writeFileSync(join(workspace, "not-dir"), "x");
    assert.throws(() => ensureSocketDirectory(join(workspace, "not-dir", "a.sock")), /不是目录/);
    mkdirSync(join(workspace, "elsewhere"));
    symlinkSync(join(workspace, "elsewhere"), join(workspace, "linked"));
    assert.throws(() => ensureSocketDirectory(join(workspace, "linked", "a.sock")), /不是目录/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("路径规范化：/var → /private/var 别名视为同一位置；不存在的尾段原样拼回", () => {
  const { base, alias, real } = aliasedTmp("canon");
  try {
    assert.equal(canonicalPath(alias), real);
    assert.equal(canonicalPath(join(alias, "not", "yet")), join(real, "not", "yet"));
    assert.equal(samePath(alias, real), true);
    assert.equal(samePath(join(alias, "a"), join(real, "a")), true);
    assert.equal(samePath(join(alias, "a"), join(real, "b")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("worktree connect：经符号链接别名给出的目录与 git 报告的真实路径一致即通过，并按真实路径登记", async () => {
  const { base, alias, real } = aliasedTmp("wt");
  const dir = join(real, "repo");
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  const taskId = "k-0000000000aa";
  const frontmatter = {
    id: taskId,
    status: "open",
    phase: "discuss",
    outcome: null,
    branch: "refs/heads/main",
    verification: "self",
    createdAt: "2026-11-03T08:00:00.000Z",
    title: "WT alias",
  };
  const { inputsBody, progressBody } = renderInitialTaskBody(frontmatter.title);
  mkdirSync(join(dir, ".knit", "tasks", "11-03-alias"), { recursive: true });
  writeFileSync(join(dir, ".knit", "tasks", "11-03-alias", "task.md"), renderTaskDocument({ frontmatter, inputsBody, progressBody, trailingBody: "" }));
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  try {
    await store.bindings.save({
      taskId,
      repoRoot: dir,
      relativePath: "tasks/11-03-alias/task.md",
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
    const service = new WorktreeService({ store, locks: new LockManager({ root: join(base, "locks") }), now: () => new Date("2026-11-03T09:00:00.000Z") });
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["worktree", "add", "-q", "-b", "knit/11-03-alias", join(real, "wt-hand"), head]);
    // 用户经别名路径（macOS 的 /var/...）指定目录：git 报告的是 /private/var/...。
    const result = await service.connect({ dir: join(alias, "repo"), taskId, path: join(alias, "wt-hand") });
    assert.equal(result.registered, true);
    assert.equal(result.worktree.path, join(real, "wt-hand"));
    assert.equal(result.worktree.branch, "refs/heads/knit/11-03-alias");
    assert.equal(result.worktree.layout, "global");
    const again = await service.connect({ dir: join(alias, "repo"), taskId, path: join(alias, "wt-hand") });
    assert.equal(again.registered, false, "别名与真实路径视为同一登记");
    const viaReal = await service.connect({ dir, taskId, path: join(real, "wt-hand") });
    assert.equal(viaReal.registered, false);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-mac-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** 普通终端环境：去掉 REX_*／TERM_PROGRAM，CLI 结果与是否在 Rex 终端内无关。 */
function plainEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("REX_") || key === "TERM_PROGRAM" || key === "TERM_PROGRAM_VERSION") delete env[key];
  }
  return env;
}

function cli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: plainEnv() });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

test("CLI：cancel 对已终态 run 两个入口一致返回 requested=false／already_terminal，人读写“run 已结束，无需取消”", async () => {
  const dir = project("cancel");
  let sequence = 0;
  const randomHex = () => (++sequence).toString(16).padStart(12, "0").slice(-12);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  try {
    const tasks = new TaskService({ store, locks: new LockManager({ root: join(dir, ".locks") }), randomHex });
    const task = await tasks.newTask({ dir, title: "取消", slug: "cancel", verification: "self" });
    await tasks.ready({ dir, taskId: task.taskId });
    const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), hostProbe: async () => { throw new Error("local"); } });
    const prepared = await coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "implement",
      presentation: "local",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "fake", model: "fake" },
    });
    const runId = prepared.request.runId;
    const runs = new RunStore(dir);
    const now = new Date().toISOString();
    runs.writeState(runId, {
      schemaVersion: 1,
      runId,
      taskId: task.taskId,
      phase: "implement",
      state: "failed",
      worker: { workerId: "stub-worker", pid: 1, bootId: "stub-boot", procStartTicks: null, hostname: "stub-host" },
      claimedAt: now,
      updatedAt: now,
      prepared: true,
      preparedAt: now,
      snapshot: { state: "ready", digest: null, entries: null, reason: null },
      reason: "test_terminal",
    });
    store.close();

    for (const args of [["cancel", "--run", runId], ["run", "cancel", runId]]) {
      const json = cli(["--json", ...args, "--dir", dir]);
      assert.equal(json.code, 0, json.stderr);
      const parsed = JSON.parse(json.stdout);
      assert.equal(parsed.outcome, "completed", `${args.join(" ")}：已结束无需处理`);
      assert.equal(parsed.data.requested, false);
      assert.equal(parsed.data.reason, "already_terminal");
      assert.equal(parsed.data.state, "failed");
      const text = cli([...args, "--dir", dir]);
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, new RegExp(`run ${runId}: run 已结束，无需取消（failed）`));
    }
    // 两个入口暴露相同选项。
    for (const args of [["cancel", "--help"], ["run", "cancel", "--help"]]) {
      const help = cli(args);
      assert.match(help.stdout, /--reason/);
      assert.match(help.stdout, /--terminate/);
    }
    // resume：顶层与 run 子命令暴露同一锁根选项（执行路径由源码共用测试与 stage／m1-cli 用例覆盖，此处不启动 worker）。
    for (const args of [["resume", "--help"], ["run", "resume", "--help"]]) {
      const help = cli(args);
      assert.equal(help.code, 0, help.stderr);
      assert.match(help.stdout, /--locks/);
      assert.match(help.stdout, /--dir/);
    }
  } finally {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 源码：run resume／resume 与 run cancel／cancel 共用 run-control 实现", () => {
  const runSource = readFileSync(join(ROOT, "src", "cli", "run.ts"), "utf8");
  const resumeSource = readFileSync(join(ROOT, "src", "cli", "resume.ts"), "utf8");
  for (const source of [runSource, resumeSource]) {
    assert.match(source, /from "\.\/run-control\.js"/);
    assert.match(source, /resumeRun\(/);
    assert.match(source, /cancelRun\(/);
    assert.doesNotMatch(source, /coordinator\.(resume|cancel)\(/, "不再各自调用协调器");
  }
});
