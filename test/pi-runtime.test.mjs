import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PiAgentRuntime,
  PiRpcConnection,
  PiConnectionClosedError,
  buildPiArgs,
  checkNativeSessionFile,
  isolatedEnv,
  signalProcessGroup,
} from "../dist/adapters/pi/index.js";

const PI = process.env.PI_EXECUTABLE ?? "pi";
const PROVIDER = process.env.PI_PROVIDER ?? "magpie";
const MODEL = process.env.PI_MODEL ?? "group/openai";

function piAvailable() {
  const probe = spawnSync(PI, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return probe.status === 0;
}

function makeWorkspace(name) {
  const root = mkdtempSync(path.join(tmpdir(), `knit-pi-${name}-`));
  const sessionDir = path.join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir };
}

const HAS_PI = piAvailable();

test("checkNativeSessionFile 识别合法文件与损坏文件", async () => {
  const { root } = makeWorkspace("check");
  const good = path.join(root, "good.jsonl");
  writeFileSync(good, '{"type":"session","version":3,"id":"sid-9","cwd":"/tmp/x"}\n{"type":"model_change","id":"m1"}\n');
  const goodCheck = await checkNativeSessionFile(good, "sid-9");
  assert.equal(goodCheck.exists, true);
  assert.equal(goodCheck.problem, null);
  assert.equal(goodCheck.identity.cwd, "/tmp/x");
  assert.equal(goodCheck.entryCount, 2);

  const bad = path.join(root, "bad.jsonl");
  writeFileSync(bad, "not json at all\n");
  const badCheck = await checkNativeSessionFile(bad, "sid-9");
  assert.equal(badCheck.problem, "empty");

  const empty = path.join(root, "empty.jsonl");
  writeFileSync(empty, "");
  assert.equal((await checkNativeSessionFile(empty, "sid-9")).problem, "empty");
});

test("isolatedEnv 移除主会话变量并设置离线标志", () => {
  const env = isolatedEnv({ EXTRA: "1" });
  assert.equal(env.PI_SESSION_ID, undefined);
  assert.equal(env.PI_SESSION_FILE, undefined);
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(env.EXTRA, "1");
});

test("连接在进程被杀后以 PiConnectionClosedError 拒绝未决请求并给出真实信号", { timeout: 60_000 }, async (t) => {
  if (!HAS_PI) { t.skip("本机无 pi CLI"); return; }
  const { root } = makeWorkspace("eof");
  const connection = new PiRpcConnection(
    PI,
    ["--mode", "rpc", "--offline", "--no-extensions", "--no-approve", "--no-tools", "--no-session", "--provider", PROVIDER, "--model", MODEL],
    { cwd: root, env: isolatedEnv() },
  );
  try {
    const pending = connection.call("get_state", {}, 20_000);
    connection.killProcessGroup("SIGKILL");
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof PiConnectionClosedError);
      assert.equal(error.exit?.signal, "SIGKILL");
      return true;
    });
    const exit = await connection.waitExit(5_000);
    assert.equal(exit?.signal, "SIGKILL");
  } finally {
    connection.killProcessGroup("SIGKILL");
  }
});

test("连接层把非 JSON 与非对象帧归入 invalidFrames，不作响应或事件", { timeout: 30_000 }, async (t) => {
  const { root } = makeWorkspace("frames");
  const script = [
    "process.stdout.write('{\"type\":\"response\",\"id\":\"a1\",\"success\":true}\\n')",
    "process.stdout.write('not-json-at-all\\n')",
    "process.stdout.write('[1,2,3]\\n')",
  ].join(";");
  const connection = new PiRpcConnection(process.execPath, ["-e", script], { cwd: root, env: {} });
  try {
    await connection.waitExit(5_000);
    assert.ok(connection.invalidFrames.includes("not-json-at-all"));
    assert.ok(connection.invalidFrames.includes("[1,2,3]"));
    assert.equal(connection.events.length, 0);
  } finally {
    connection.killProcessGroup("SIGKILL");
  }
});

test("连接层有界等待 stderr 收敛，流结束后冻结尾部", { timeout: 30_000 }, async () => {
  const { root } = makeWorkspace("stderr-settle");
  const script = [
    "process.stderr.write('startup detail: model missing\\n')",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const connection = new PiRpcConnection(process.execPath, ["-e", script], { cwd: root, env: {} });
  try {
    // 等子进程真正写出启动证据再测试关闭等待；并行全量测试时启动可能超过 100ms，
    // 不能在它尚未执行脚本时杀掉并假定 stderr 已有内容。
    const deadline = Date.now() + 5_000;
    while (!connection.stderrDiagnostics.tail.includes("startup detail: model missing") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(connection.stderrDiagnostics.tail, /startup detail: model missing/, "子进程已就绪");
    // 进程存活、stderr 未关闭：有界等待超时返回 false，不无限阻塞。
    assert.equal(await connection.waitStderrClose(100), false);
    assert.equal(connection.stderrSettled, false);
    connection.killProcessGroup("SIGKILL");
    assert.equal(await connection.waitStderrClose(5_000), true);
    assert.equal(connection.stderrSettled, true);
    const diagnostics = connection.stderrDiagnostics;
    assert.match(diagnostics.tail, /startup detail: model missing/);
    assert.equal(diagnostics.truncated, false);
    // 流结束后快照冻结，不再随数据变化。
    assert.deepEqual(connection.snapshotStderr(), diagnostics);
  } finally {
    connection.killProcessGroup("SIGKILL");
  }
});

test("runtime 启动失败后 dispose 保留 stderr 尾部快照且幂等", { timeout: 30_000 }, async () => {
  const workspace = makeWorkspace("stderr-dispose");
  // 独立假 pi：get_state 成功、set_model 先写 stderr 再回错误，用于固定“响应早于 stderr 读取”的顺序。
  const executable = path.join(workspace.root, "fake-pi-start-fail.mjs");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'import { createInterface } from "node:readline";',
      "const rl = createInterface({ input: process.stdin });",
      'rl.on("line", (line) => {',
      "  let request;",
      "  try { request = JSON.parse(line); } catch { return; }",
      '  if (request.type === "get_state") {',
      '    process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true, data: { sessionId: "s1", sessionFile: null, model: { provider: "p", id: "m" } } }) + "\\n");',
      "    return;",
      "  }",
      '  if (request.type === "set_model") {',
      '    process.stderr.write("Error: Model not found: p/m\\n");',
      '    process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: false, error: "Model not found: p/m" }) + "\\n");',
      "    return;",
      "  }",
      '  process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true, data: {} }) + "\\n");',
      "});",
    ].join("\n") + "\n",
  );
  chmodSync(executable, 0o755);
  const runtime = new PiAgentRuntime({
    executablePath: executable,
    provider: "p",
    modelId: "m",
    cwd: workspace.root,
    sessionDir: workspace.sessionDir,
  });
  try {
    const check = await runtime.start(10_000);
    assert.equal(check.ok, false);
    assert.equal(check.failure, "set_model_rejected");
    await runtime.dispose(2_000);
    // 连接已释放，仍能读到最终尾部而不是空值。
    assert.equal(runtime.connectionForTests, null);
    assert.match(runtime.stderrDiagnostics.tail, /Model not found: p\/m/);
    assert.equal(runtime.stderrDiagnostics.truncated, false);
    // 重复 dispose 幂等，且不丢失快照。
    assert.equal(await runtime.dispose(2_000), null);
    assert.match(runtime.stderrDiagnostics.tail, /Model not found: p\/m/);
  } finally {
    await runtime.dispose(1_000).catch(() => null);
  }
});

// ---------------------------------------------------------------------------
// 进程组信号（来自 test/macos-compat.test.mjs）

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

// ---------------------------------------------------------------------------
// 能力 → Pi 启动参数（来自 test/stage-contract.test.mjs）

const BASE = {
  executablePath: "pi",
  provider: "p",
  modelId: "m",
  cwd: "/repo",
  sessionDir: "/repo/.knit/.runtime/pi-sessions",
  sessionId: "native-1",
};

function argsOf(extra) {
  return buildPiArgs({ ...BASE, ...extra });
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("能力→Pi 参数：缺省收紧，external 放开扩展／MCP／技能，network 放开离线", () => {
  const restrictive = argsOf({ capabilities: ["read"], tools: ["read", "grep", "find", "ls"] });
  assert.ok(restrictive.includes("--offline"));
  assert.ok(restrictive.includes("--no-mcp"));
  assert.ok(restrictive.includes("--no-skills"));
  assert.ok(restrictive.includes("--no-extensions"));
  assert.equal(valueOf(restrictive, "--tools"), "read,grep,find,ls");

  const external = argsOf({
    capabilities: ["read", "external"],
    tools: null,
    toolAdditions: ["read", "grep", "find", "ls"],
    excludeTools: ["write", "edit", "bash", "powershell"],
  });
  assert.ok(external.includes("--offline"), "external 不自动放开网络");
  assert.equal(external.includes("--no-mcp"), false);
  assert.equal(external.includes("--no-skills"), false);
  assert.equal(external.includes("--no-extensions"), false);
  // external 用只增项保留未知扩展工具，再用 exclude 限制内置工具。
  assert.equal(valueOf(external, "--tools"), "+read,+grep,+find,+ls");
  assert.equal(valueOf(external, "--exclude-tools"), "write,edit,bash,powershell");

  const network = argsOf({ capabilities: ["network"], tools: ["bash"] });
  assert.equal(network.includes("--offline"), false);
  assert.ok(network.includes("--no-mcp"));
  const env = isolatedEnv({}, { offline: false });
  assert.equal("PI_OFFLINE" in env, false, "network 时环境不注入 PI_OFFLINE");
});

test("能力→Pi 参数：空能力全部禁用（--no-tools，离线并禁用扩展／MCP／技能）", () => {
  const disabled = argsOf({ capabilities: [], tools: [] });
  for (const flag of ["--no-tools", "--offline", "--no-mcp", "--no-skills", "--no-extensions"]) {
    assert.equal(disabled.includes(flag), true, `全部禁用应带 ${flag}`);
  }
  assert.equal(disabled.includes("--tools"), false);

  // 全部放开（流程文件里不写 tools 或写 all）：不传 --tools／--no-tools。
  const unrestricted = argsOf({ capabilities: null, tools: null });
  assert.equal(unrestricted.includes("--no-tools"), false);
  assert.equal(unrestricted.includes("--tools"), false);
  assert.equal(unrestricted.includes("--offline"), false);
});

test("能力→Pi 参数：未写 tools 表示全部放开；显式加载项目扩展", () => {
  const all = argsOf({ capabilities: null, tools: null });
  for (const flag of ["--offline", "--no-mcp", "--no-skills", "--no-extensions", "--no-tools"]) {
    assert.equal(all.includes(flag), false, `全部放开不应带 ${flag}`);
  }
  assert.equal(all.includes("--tools"), false);

  const explicit = argsOf({
    capabilities: ["read"],
    tools: ["knit_*"],
    extensionPaths: ["/repo/.pi/extensions/knit.ts"],
  });
  assert.equal(valueOf(explicit, "--tools"), "knit_*");
  assert.equal(explicit.includes("--no-extensions"), true, "未声明 external 仍关闭自动发现");
  const extensionIndex = explicit.indexOf("--extension");
  assert.notEqual(extensionIndex, -1);
  assert.equal(explicit[extensionIndex + 1], "/repo/.pi/extensions/knit.ts");
});

test("能力→Pi 参数：不带 --no-context-files，执行者照常读 AGENTS.md", () => {
  for (const capabilities of [null, [], ["read"], ["read", "write", "exec"], ["external", "network"]]) {
    assert.equal(argsOf({ capabilities, tools: null }).includes("--no-context-files"), false, JSON.stringify(capabilities));
  }
});
