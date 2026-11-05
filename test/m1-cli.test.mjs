/**
 * 015 M1 CLI／桥接资源测试：真实 Git、真实子进程、fake Pi 仅用于阶段执行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { BRIDGE_TOOL_SCHEMAS } from "../dist/contracts/bridge-tools.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli", "knit.js");
const FAKE_PI = join(ROOT, "test", "fixtures", "fake-pi.mjs");

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-015-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  execFileSync(process.execPath, [CLI, "init", "--client", "pi", "--dir", dir], { encoding: "utf8" });
  return dir;
}

function cli(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function jsonCli(dir, args, env = {}) {
  const result = cli(dir, ["--json", ...args], env);
  const parsed = result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  return { ...result, parsed };
}

function newTask(dir, title = "M1 smoke") {
  const created = jsonCli(dir, ["task", "new", "--title", title, "--slug", "m1"]);
  assert.equal(created.parsed.outcome, "completed", created.stderr);
  return created.parsed.data;
}

function fakeAction(dir, value) {
  const path = join(dir, "fake-action.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("task adopt：接管当前完整分支，纯分支变化改绑并使旧检查失效", () => {
  const dir = project("adopt");
  try {
    const task = newTask(dir);
    const file = join(dir, ".knit", task.relativePath);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^branch: .*$/m, "branch: null"));
    const adopted = jsonCli(dir, ["task", "adopt", task.taskId, "--branch", "current"]);
    assert.equal(adopted.parsed.outcome, "completed", adopted.stderr);
    assert.equal(adopted.parsed.data.branch, "refs/heads/main");
    assert.equal(adopted.parsed.data.adopted, true);
    assert.match(readFileSync(file, "utf8"), /^branch: refs\/heads\/main$/m);
    const again = jsonCli(dir, ["task", "adopt", task.taskId, "--branch", "current"]);
    assert.equal(again.parsed.data.adopted, false);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^branch: .*$/m, "branch: refs/heads/other"));
    const rebound = jsonCli(dir, ["task", "adopt", task.taskId, "--branch", "current"]);
    assert.equal(rebound.parsed.outcome, "completed", rebound.stderr);
    assert.equal(rebound.parsed.data.adopted, true);
    assert.equal(rebound.parsed.data.previousBranch, "refs/heads/other");
    assert.equal(rebound.parsed.data.checkInvalidated, true);
    assert.match(readFileSync(file, "utf8"), /^branch: refs\/heads\/main$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start：在项目 cwd 启动 Pi，保留 -- 后的参数，不自动批准信任", () => {
  const dir = project("start");
  try {
    const bin = join(dir, "fake-pi.sh");
    writeFileSync(bin, "#!/bin/sh\nprintf '%s|%s' \"$PWD\" \"$*\" > start-args.txt\n");
    chmodSync(bin, 0o755);
    const result = spawnSync(process.execPath, [CLI, "--json", "start", "--bin", bin, "--dir", dir, "--", "--foo", "bar"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcome, "completed");
    assert.equal(readFileSync(join(dir, "start-args.txt"), "utf8"), `${dir}|--foo bar`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status：按月归档任务进入项目概览，与 task list／按 ID status 一致（任务041）", () => {
  const dir = project("status-archive");
  try {
    const task = newTask(dir);
    const closed = jsonCli(dir, ["task", "close", task.taskId, "--outcome", "cancelled", "--runs-settled"]);
    assert.equal(closed.parsed.outcome, "completed", closed.stderr);
    // 模拟按月归档：移动任务目录到 archive/YYYY-MM/。
    const month = "2026-11";
    const taskDirName = task.relativePath.split("/").slice(1, -1).join("/");
    mkdirSync(join(dir, ".knit", "tasks", "archive", month), { recursive: true });
    renameSync(join(dir, ".knit", "tasks", taskDirName), join(dir, ".knit", "tasks", "archive", month, taskDirName));
    // 项目概览列出归档任务。
    const overview = jsonCli(dir, ["status"]);
    const listed = overview.parsed.data.tasks.find((entry) => entry.taskId === task.taskId);
    assert.notEqual(listed, undefined, "归档任务出现在项目状态概览");
    assert.equal(listed.archived, true);
    assert.match(listed.relativePath, /^tasks\/archive\/2026-11\//);
    // 与 task list、按 ID status 一致。
    const list = jsonCli(dir, ["task", "list"]);
    assert.ok(list.parsed.data.archived.some((entry) => entry.taskId === task.taskId));
    const byId = jsonCli(dir, ["status", task.taskId]);
    assert.equal(byId.parsed.data.taskId, task.taskId);
    assert.equal(byId.parsed.data.archived, true);
    // 非任务目录（无 task.md）与损坏文件不阻塞概览。
    mkdirSync(join(dir, ".knit", "tasks", "archive", "2026-10", "broken-task"), { recursive: true });
    writeFileSync(join(dir, ".knit", "tasks", "archive", "2026-10", "broken-task", "task.md"), "broken-not-yaml\n");
    const robust = jsonCli(dir, ["status"]);
    assert.equal(robust.parsed.outcome, "completed");
    assert.equal(robust.parsed.data.tasks.filter((entry) => entry.archived).length, 1, "损坏任务不计入概览");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status/doctor/storage：只读查询不接收结果、不写数据库", () => {
  const dir = project("status");
  try {
    const task = newTask(dir);
    const db = join(dir, ".knit", ".runtime", "metadata.db");
    const before = statSync(db);
    const status = jsonCli(dir, ["status", task.taskId]);
    assert.equal(status.parsed.outcome, "completed");
    assert.equal(status.parsed.data.taskId, task.taskId);
    assert.equal(status.parsed.data.runs.length, 0);
    const overview = jsonCli(dir, ["status"]);
    assert.equal(overview.parsed.data.tasks.length, 1);
    const doctor = jsonCli(dir, ["doctor", "--pi-bin", process.execPath]);
    assert.equal(doctor.parsed.outcome, "completed", JSON.stringify(doctor.parsed.data?.checks));
    mkdirSync(join(dir, ".knit", ".runtime", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".knit", ".runtime", "sessions", "native.jsonl"), '{"type":"session"}\n');
    const storage = jsonCli(dir, ["storage"]);
    assert.equal(storage.parsed.outcome, "completed");
    assert.ok(storage.parsed.data.database.counts.bindings >= 1);
    assert.ok(storage.parsed.data.nativeSessions.bytes > 0, "storage 统计原生资料但单列，不重复相加");
    const after = statSync(db);
    assert.equal(after.size, before.size, "只读查询不改变数据库大小");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run implement + status --events：真实 worker 终态观察，事件流不接收结果", async () => {
  const dir = project("run");
  try {
    const task = newTask(dir);
    assert.equal(jsonCli(dir, ["task", "ready", task.taskId]).parsed.outcome, "completed");
    const action = fakeAction(dir, { report: { summary: "done", changedPaths: [], findings: [], unverified: [] } });
    const prepared = jsonCli(dir, ["--dev", "run", "prepare", "--task", task.taskId, "--stage", "implement", "--client", "pi", "--native", "main-native", "--provider", "fake", "--model", "fake"]);
    assert.equal(prepared.parsed.outcome, "completed", prepared.stderr);
    assert.equal(prepared.parsed.data.request.recovery.nativeSessionId, null, "发起方 native 不是阶段恢复目标");
    const run = jsonCli(dir, ["--dev", "run", "implement", "--task", task.taskId, "--provider", "fake", "--model", "fake", "--wait"], {
      KNIT_PI_BIN: FAKE_PI,
      KNIT_FAKE_ACTION: action,
    });
    assert.equal(run.parsed.outcome, "completed", run.stderr);
    assert.match(run.stderr, /knit\.worker\.diag/, "--dev 转发 worker 结构化 stderr");
    const runId = run.parsed.data.request.runId;
    const status = jsonCli(dir, ["status", "--run", runId]);
    assert.equal(status.parsed.data.result.state, "completed");
    assert.equal(status.parsed.data.branch, "refs/heads/main", "观察投影保留发起分支");
    const resumed = jsonCli(dir, ["resume", "--run", runId]);
    assert.equal(resumed.parsed.outcome, "completed");
    assert.equal(resumed.parsed.data.resumed, false);
    assert.equal(resumed.parsed.data.accepted, true);
    const events = cli(dir, ["status", "--run", runId, "--events", "--interval", "100"]);
    assert.equal(events.code, 0, events.stderr);
    assert.match(events.stdout, /"type":"knit\.terminal"/);
    assert.match(events.stdout, /"state":"completed"/);
    const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
    try {
      const binding = await store.bindings.get(task.taskId);
      assert.equal(binding.lastCheckRunId, null, "观察事件不接收结果、不写检查凭据");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assist／advisory 链路已删除：未知命令不创建 run、不推进 Task", () => {
  const dir = project("assist-removed");
  try {
    const task = newTask(dir);
    const result = jsonCli(dir, ["assist", "discuss", "--task", task.taskId, "--provider", "fake", "--model", "fake", "--wait"], {
      KNIT_PI_BIN: FAKE_PI,
    });
    assert.equal(result.code, 1);
    assert.equal(result.parsed, null, "未知命令不输出成功协议");
    assert.match(result.stderr, /unknown command 'assist'|未知命令 "assist"/);
    const status = jsonCli(dir, ["status", task.taskId]);
    assert.equal(status.parsed.data.stage, "start", "删除入口不推进业务阶段");
    assert.equal(status.parsed.data.runs.length, 0);
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "runs")), false, "不落盘 run 目录");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run check --scope：非正式只读检查不建 Task／binding；副作用失败", async () => {
  const dir = project("informal");
  try {
    const action = fakeAction(dir, { report: { summary: "范围通过", verdict: "pass", coverage: ["a.txt"], findings: [], unverified: [] } });
    const result = jsonCli(dir, ["run", "check", "--scope", "a.txt", "--provider", "fake", "--model", "fake"], {
      KNIT_PI_BIN: FAKE_PI,
      KNIT_FAKE_ACTION: action,
    });
    assert.equal(result.parsed.outcome, "completed", result.stderr);
    assert.equal(result.parsed.data.report.verdict, "pass");
    assert.ok(result.parsed.data.checkId.startsWith("chk-"));
    const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
    try {
      const tasks = await store.bindings.list();
      assert.equal(tasks.length, 0, "非正式检查不创建 Task 绑定");
    } finally {
      store.close();
    }
    const sideEffect = fakeAction(dir, {
      writes: [{ path: "a.txt", content: "changed\n" }],
      report: { summary: "不应写文件", verdict: "pass", coverage: ["a.txt"], findings: [], unverified: [] },
    });
    const failed = jsonCli(dir, ["run", "check", "--scope", "a.txt", "--provider", "fake", "--model", "fake"], {
      KNIT_PI_BIN: FAKE_PI,
      KNIT_FAKE_ACTION: sideEffect,
    });
    assert.equal(failed.parsed.outcome, "needs_attention");
    assert.equal(failed.parsed.data.failureReason, "check_side_effect");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "changed\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dev：写命令生成私有 JSONL；只读命令不建诊断目录，日志失败不吞业务", () => {
  const dir = project("dev-log");
  try {
    const list = cli(dir, ["--dev", "--json", "task", "list"]);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "diagnostics")), false, "只读 --dev 不建日志");
    const created = jsonCli(dir, ["--dev", "task", "new", "--title", "诊断", "--slug", "diag"]);
    assert.equal(created.parsed.outcome, "completed", created.stderr);
    const root = join(dir, ".knit", ".runtime", "diagnostics");
    assert.ok(existsSync(root));
    const folders = readdirSync(root);
    assert.ok(folders.length > 0);
    const files = readdirSync(join(root, folders[0])).filter((name) => name.endsWith(".jsonl"));
    assert.ok(files.length > 0);
    const logPath = join(root, folders[0], files[0]);
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, folders[0])).mode & 0o777, 0o700);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].event, "command_start");
    assert.ok(lines.some((line) => line.event === "command_end" && line.exitCode === 0));
    assert.equal(lines.some((line) => typeof line.content === "string" || typeof line.prompt === "string"), false);
    const withDev = jsonCli(dir, ["--dev", "task", "list"]);
    const plain = jsonCli(dir, ["task", "list"]);
    assert.deepEqual(withDev.parsed.data, plain.parsed.data, "--dev 不改变业务投影");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel --operation：只放弃未执行效果的 planned 操作", async () => {
  const dir = project("cancel-op");
  try {
    const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
    try {
      await store.operations.save({ operationId: "op-000000000001", kind: "test.operation", state: "planned", recordedAt: new Date().toISOString() });
      await store.operations.save({ operationId: "op-000000000002", kind: "test.operation", state: "running", recordedAt: new Date().toISOString() });
    } finally {
      store.close();
    }
    const planned = jsonCli(dir, ["cancel", "--operation", "op-000000000001", "--reason", "test"]);
    assert.equal(planned.parsed.outcome, "completed");
    assert.equal(planned.parsed.data.state, "abandoned");
    const running = jsonCli(dir, ["cancel", "--operation", "op-000000000002"]);
    assert.equal(running.parsed.outcome, "needs_attention");
    assert.equal(running.parsed.reasonCode, "external_effect_unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dev：stdout 仍是单一协议响应，诊断只写 stderr 且白名单", () => {
  const dir = project("dev");
  try {
    const result = cli(dir, ["--dev", "--json", "task", "list"]);
    assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.protocolVersion, 1);
    const lines = result.stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(lines.length >= 2);
    assert.deepEqual(lines.map((line) => line.event), ["command_start", "command_end"]);
    assert.equal(lines[0].command, "task list");
    assert.equal(lines[0].type, "knit.diag");
    assert.equal("argv" in lines[0], false);
    assert.equal("dir" in lines[0], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("桥接 schema 由同源 pi-schema 定义派生，模板读取安装包内 JSON", () => {
  const derived = JSON.parse(readFileSync(join(ROOT, "dist", "contracts", "bridge-tools.json"), "utf8"));
  for (const [name, schema] of Object.entries(BRIDGE_TOOL_SCHEMAS)) {
    assert.deepEqual(derived[name], JSON.parse(JSON.stringify(schema)), `schema 同源: ${name}`);
  }
  const template = readFileSync(join(ROOT, "assets", "templates", "pi", "extensions", "knit.ts"), "utf8");
  assert.match(template, /bridge-tools\.json/);
  assert.doesNotMatch(template, /typebox/i);
  assert.match(template, /knit_task/);
  assert.match(template, /knit_run/);
  assert.match(template, /knit_context/);
  assert.match(template, /knit_workflow/);
  assert.match(template, /knit_deliver/);
  const runSchema = JSON.parse(JSON.stringify(BRIDGE_TOOL_SCHEMAS.run));
  const contextSchema = JSON.parse(JSON.stringify(BRIDGE_TOOL_SCHEMAS.context));
  assert.equal("mode" in runSchema.properties, false, "桥接不再暴露 assist mode");
  assert.equal("anyOf" in runSchema.properties.action, false, "run.action 不静态枚举阶段，由配置派生");
  assert.equal("role" in contextSchema.properties, false, "context 目标改用 stage，不再保留 role 静态枚举");
  assert.equal("anyOf" in contextSchema.properties.stage, false, "context.stage 由配置派生");
  assert.equal(JSON.stringify(runSchema).includes("advisory"), false);
  assert.equal(JSON.stringify(contextSchema).includes("advisory"), false);
  assert.ok(BRIDGE_TOOL_SCHEMAS.workflow, "新增 knit_workflow schema");
  assert.match(template, /workflow", "show"/);
  assert.doesNotMatch(template, /workflow\.md/, "turn context 不再引用已删除的 workflow.md");
  assert.doesNotMatch(template, /assist|advisory/, "assist／advisory 入口已删除");
  assert.doesNotMatch(template, /params\.mode\b/, "knit_run 不再有 mode 参数");
  assert.match(template, /knit_snapshot/);
  assert.match(template, /knit\.selection/);
  assert.match(template, /notice_skipped_branch/);
  assert.match(template, /knit\.bridge\.observer/);
  assert.match(template, /knit dev on\|off/);
  assert.match(template, /followUp/);
});

test("locks/unlock：只读列举、token 校验与显式强解，不改项目业务状态", async () => {
  const root = mkdtempSync(join(tmpdir(), "knit-015-locks-"));
  try {
    const { LockManager } = await import("../dist/infrastructure/locks.js");
    const manager = new LockManager({ root });
    const acquired = await manager.acquire({ keys: [{ scope: "project", rawKey: "/tmp/knit-lock-cli" }], action: "test" });
    const listed = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "locks", "--locks", root], { encoding: "utf8" }));
    assert.equal(listed.outcome, "completed");
    assert.equal(listed.data.entries.length, 1);
    assert.equal(listed.data.entries[0].owner.token, acquired.token);
    assert.equal(listed.data.entries[0].key, "/tmp/knit-lock-cli");
    let wrong;
    try {
      execFileSync(process.execPath, [CLI, "--json", "unlock", "--scope", "project", "--key", "/tmp/knit-lock-cli", "--expect-token", "wrong", "--locks", root], { encoding: "utf8" });
      assert.fail("错误 token 必须失败");
    } catch (error) {
      wrong = JSON.parse(error.stdout);
    }
    assert.equal(wrong.outcome, "error", JSON.stringify(wrong));
    assert.equal(wrong.reasonCode, "needs_review");
    const unlocked = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI, "--json", "unlock", "--scope", "project", "--key", "/tmp/knit-lock-cli", "--expect-token", acquired.token, "--force", "--locks", root],
        { encoding: "utf8" },
      ),
    );
    assert.equal(unlocked.outcome, "completed");
    assert.equal(unlocked.data.removed, true);
    assert.equal(manager.list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
