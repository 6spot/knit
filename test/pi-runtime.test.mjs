import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PiAgentRuntime,
  PiRpcConnection,
  PiConnectionClosedError,
  checkNativeSessionFile,
  decideResume,
  buildRuntimeOptions,
  readEntryRange,
  isolatedEnv,
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

function baseOptions(workspace, extra = {}) {
  return {
    executablePath: PI,
    provider: PROVIDER,
    modelId: MODEL,
    cwd: workspace.root,
    sessionDir: workspace.sessionDir,
    appendSystemPrompt:
      "This is a Knit adapter validation fixture. Follow the precise test request only. Do not inspect home, secrets, unrelated projects or network resources. Do not run git commands.",
    ...extra,
  };
}

test("decideResume 缺失记录时预分配新原生 ID，不冒充可恢复", async () => {
  const decision = await decideResume("native-1", path.join(tmpdir(), "knit-no-such-session.json"));
  assert.equal(decision.action, "create_new");
  assert.equal(decision.reason, "session_file_missing");
  assert.notEqual(decision.nativeSessionId, "native-1");
});

test("decideResume 身份不符时报 id_mismatch，不交另一记录解释", async () => {
  const { root } = makeWorkspace("identity");
  const file = path.join(root, "session.jsonl");
  writeFileSync(file, '{"type":"session","version":3,"id":"other-id","cwd":"/tmp"}\n{"type":"message","id":"e1"}\n');
  const decision = await decideResume("expected-id", file);
  assert.equal(decision.action, "create_new");
  assert.equal(decision.reason, "session_file_id_mismatch");
  assert.equal(decision.check.exists, true);
  assert.equal(decision.check.identity.id, "other-id");
});

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

test("buildRuntimeOptions 按 decision 选择 --session 或预分配新 ID", () => {
  const base = baseOptions({ root: "/r", sessionDir: "/s" });
  const resumeOpts = buildRuntimeOptions(base, {
    action: "resume",
    nativeSessionId: "n1",
    sessionFile: "/sf/old.jsonl",
    check: { exists: true, identity: null, entryCount: 0, problem: null },
  });
  assert.equal(resumeOpts.sessionFile, "/sf/old.jsonl");
  assert.equal(resumeOpts.sessionId, "n1");
  const freshOpts = buildRuntimeOptions(base, {
    action: "create_new",
    nativeSessionId: "n2",
    reason: "session_file_missing",
    check: null,
  });
  assert.equal(freshOpts.sessionFile, undefined);
  assert.equal(freshOpts.sessionId, "n2");
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

if (HAS_PI) {
  test("真实模型冒烟：非法模型经 set_model 拒绝，不静默替换（零模型请求）", { timeout: 60_000 }, async (t) => {
    const workspace = makeWorkspace("badmodel");
    const runtime = new PiAgentRuntime(
      baseOptions(workspace, { modelId: `knit-not-a-model-${Date.now()}` }),
    );
    try {
      const check = await runtime.start();
      assert.equal(check.ok, false, "未登记模型不应启动成功");
      assert.equal(check.failure, "set_model_rejected");
    } finally {
      await runtime.dispose();
    }
  });

  let smokeSessionFile = null;
  let smokeNativeId = null;

  test("真实模型冒烟：prompt 稳定结束、文本与用量可读、条目范围可定位", { timeout: 300_000 }, async (t) => {
    const workspace = makeWorkspace("smoke");
    const runtime = new PiAgentRuntime(baseOptions(workspace));
    try {
      const check = await runtime.start();
      assert.equal(check.ok, true, `start 失败: ${check.failure} ${check.detail}`);
      assert.notEqual(runtime.nativeSessionId, null);
      assert.notEqual(runtime.sessionFile, null);
      smokeSessionFile = runtime.sessionFile;
      smokeNativeId = runtime.nativeSessionId;

      const observation = await runtime.prompt("Reply with exactly one word: PONG");
      assert.equal(observation.settled, true, "未观察到 agent_settled");
      assert.equal(observation.aborted, false);
      assert.match(await runtime.getLastAssistantText(), /PONG/);

      const stats = await runtime.getStats();
      assert.ok(stats !== null, "get_session_stats 无数据");
      assert.ok(stats.tokens !== undefined, "stats 缺少 tokens");

      const range = await readEntryRange(runtime.sessionFile, null);
      assert.notEqual(range.leafEntryId, null, "原生日志未出现条目");
      assert.notEqual(range.startEntryId, null);
    } finally {
      await runtime.dispose();
    }
  });

  test("真实模型冒烟：受控工具取消在 agent_settled(aborted) 且子进程真实结束", { timeout: 300_000 }, async (t) => {
    const workspace = makeWorkspace("cancel");
    const runtime = new PiAgentRuntime(baseOptions(workspace, { tools: ["bash"] }));
    try {
      const check = await runtime.start();
      assert.equal(check.ok, true, `start 失败: ${check.failure} ${check.detail}`);
      const nonce = `KNIT_TEST_${Date.now()}`;
      const command = `python3 -u -c 'import os,time;print("${nonce} "+str(os.getpid()),flush=True);time.sleep(120)'`;
      void runtime.prompt(
        `Use the bash tool to run exactly this command and wait for it to finish:\n${command}`,
      );
      const deadline = Date.now() + 180_000;
      let childPid = null;
      while (childPid === null && Date.now() < deadline) {
        for (const event of runtime.events()) {
          if (event.type !== "tool_execution_update") continue;
          const content = event.partialResult?.content ?? [];
          for (const block of content) {
            const match = /(\d+)\s*$/.exec(String(block.text ?? "").replace(nonce, "").trim());
            if (String(block.text ?? "").includes(nonce) && match) childPid = Number(match[1]);
          }
        }
        if (childPid === null) await new Promise((r) => setTimeout(r, 200));
      }
      assert.notEqual(childPid, null, "未在工具输出中观察到受控子进程 PID");
      assert.equal(spawnSync("ps", ["-p", String(childPid)], { encoding: "utf8" }).status, 0, "子进程未运行");

      const abortResult = await runtime.abort();
      assert.equal(abortResult.queueCleared, true);
      assert.equal(abortResult.aborted, true);
      const observation = await runtime.waitSettled(120_000);
      assert.equal(observation.settled, true, "abort 后未稳定结束");
      assert.equal(observation.aborted, true, "agent_settled 未标记 aborted");

      const childDeadline = Date.now() + 10_000;
      while (Date.now() < childDeadline) {
        if (spawnSync("ps", ["-p", String(childPid)], { encoding: "utf8" }).status !== 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.notEqual(
        spawnSync("ps", ["-p", String(childPid)], { encoding: "utf8" }).status, 0,
        "abort 后受控子进程仍存活",
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("真实模型冒烟：兜底新建会话读任务文件续做，新记录落在稳定目录", { timeout: 300_000 }, async (t) => {
    const workspace = makeWorkspace("fallback");
    writeFileSync(path.join(workspace.root, "TASK-SAMPLE.md"), "# 样例任务\n目标标记：KNIT_FALLBACK_OK_7f3a\n");
    // 模拟旧记录缺失后的兜底：预分配新原生 ID 新建会话。
    const decision = await decideResume("native-missing", null);
    assert.equal(decision.action, "create_new");
    const runtime = new PiAgentRuntime(
      baseOptions(workspace, { sessionId: decision.nativeSessionId, tools: ["read"] }),
    );
    try {
      const check = await runtime.start();
      assert.equal(check.ok, true, `start 失败: ${check.failure} ${check.detail}`);
      assert.equal(runtime.nativeSessionId, decision.nativeSessionId, "应使用预分配 ID");
      const observation = await runtime.prompt(
        "Read the file TASK-SAMPLE.md in the current directory and reply with only the marker line it contains.",
      );
      assert.equal(observation.settled, true);
      assert.match(await runtime.getLastAssistantText(), /KNIT_FALLBACK_OK_7f3a/);
      // 新原生记录落在稳定 session 目录，文件身份与预分配 ID 一致。
      assert.notEqual(runtime.sessionFile, null);
      assert.ok(runtime.sessionFile.startsWith(workspace.sessionDir + path.sep), "会话文件不在稳定 session 目录");
      const fileCheck = await checkNativeSessionFile(runtime.sessionFile, decision.nativeSessionId);
      assert.equal(fileCheck.exists, true, "新会话文件未落在稳定目录");
      assert.equal(fileCheck.problem, null);
      const range = await readEntryRange(runtime.sessionFile, null);
      assert.notEqual(range.leafEntryId, null);
    } finally {
      await runtime.dispose();
    }
  });

  test("真实模型冒烟：旧原生记录按原客户端恢复且历史可读（零模型请求）", { timeout: 120_000 }, async (t) => {
    assert.notEqual(smokeSessionFile, null, "依赖前一个冒烟产生的会话文件");
    assert.ok(existsSync(smokeSessionFile), "冒烟会话文件不存在");
    const decision = await decideResume(smokeNativeId, smokeSessionFile);
    assert.equal(decision.action, "resume", `恢复预检失败: ${decision.reason ?? ""}`);

    const workspace = makeWorkspace("resume");
    const options = buildRuntimeOptions(baseOptions(workspace), decision);
    const runtime = new PiAgentRuntime(options);
    try {
      const check = await runtime.start();
      assert.equal(check.ok, true, `恢复启动失败: ${check.failure} ${check.detail}`);
      assert.equal(runtime.nativeSessionId, smokeNativeId, "恢复后原生 ID 不一致");
      const messages = await runtime.getMessages();
      assert.ok(messages.length > 0, "恢复会话历史为空");
    } finally {
      await runtime.dispose();
    }
  });
}
