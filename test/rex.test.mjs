import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BridgeClient,
  BridgeServer,
  REX_REQUIRED_METHODS,
  RexApi,
  acquireOwnerLock,
  activeRexStatus,
  finishRun,
  readLatestRexWorkerResult,
  readRexAssociation,
  readRexWorkerManifest,
  readRexWorkerResult,
  readRexWorkerState,
  rexAssociationPath,
  rexDirectory,
  rexManifestPath,
  rexOwnerPath,
  rexResultPath,
  rexStatePath,
  writeRexAssociation,
  writeRexPrompt,
  writeRexWorkerManifest,
  writeRexWorkerResult,
  writeRexWorkerState,
} from "../dist/adapters/rex/index.js";
import registerRexWorker, { workerManifestPath } from "../dist/adapters/rex/worker-extension.js";
import { RexLauncher, buildRexPiArgs, rexLabel } from "../dist/application/rex-launcher.js";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { StageRunner } from "../dist/application/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const TEMPLATES = join(ROOT, "assets", "templates", ".knit");
let hexCounter = 0;
const randomHex = () => {
  hexCounter += 1;
  return hexCounter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-rex-project-${prefix}-`)));
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

function tempWorkspace(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), `knit-rex-${prefix}-`)));
}

function makeRun(dir, seed = randomBytes(6).toString("hex")) {
  const runId = `run-${seed}`;
  const runDirectory = join(dir, ".knit", ".runtime", "runs", runId);
  mkdirSync(runDirectory, { recursive: true });
  return { runId, runDirectory };
}

function manifestFor(dir, runId, runDirectory, overrides = {}) {
  const directory = rexDirectory(runDirectory);
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId,
    taskId: "k-0123456789ab",
    phase: "implement",
    sessionId: `session-${runId}`,
    instance: `rex-${randomBytes(6).toString("hex")}`,
    label: rexLabel(runId),
    cwd: dir,
    runDirectory,
    directory,
    socketPath: join(directory, "bridge.sock"),
    promptPath: join(directory, "prompt.txt"),
    statePath: join(directory, "state.json"),
    ownerPath: join(directory, "owner.json"),
    closeOnSettle: false,
    createdAt,
    ...overrides,
  };
}

function stateFor(runId, overrides = {}) {
  return {
    schemaVersion: 1,
    runId,
    instance: "rex-test",
    status: "idle",
    run: 0,
    resultRevision: 0,
    pid: process.pid,
    sessionFile: null,
    runStartLeaf: null,
    leafId: null,
    block: null,
    suppressedRevision: 0,
    error: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("等待条件超时");
}

test("Rex bridge：status/subscribe/steer/stop 往返与超限帧拒绝", async () => {
  const dir = tempWorkspace("bridge");
  const socketPath = join(dir, "bridge.sock");
  const states = [];
  let snapshot = { status: "idle", run: 0 };
  let steered = null;
  let stopped = false;
  const server = new BridgeServer(socketPath, () => snapshot, (request) => {
    if (request.method === "steer") {
      steered = request.message;
      snapshot = { status: "running", run: 1 };
      server.publish();
      return { accepted: true, run: 1 };
    }
    if (request.method === "stop") {
      stopped = true;
      return { accepted: true, run: 1 };
    }
    return snapshot;
  });
  await server.listen();
  const client = await BridgeClient.connect(socketPath, (state) => states.push(state), () => {});
  try {
    assert.deepEqual(await client.call("status"), snapshot);
    await client.call("subscribe");
    const steer = await client.call("steer", "请检查边界条件");
    assert.deepEqual(steer, { accepted: true, run: 1 });
    assert.equal(steered, "请检查边界条件");
    await waitUntil(() => states.length > 0);
    assert.equal(states.at(-1).status, "running");
    assert.deepEqual(await client.call("stop"), { accepted: true, run: 1 });
    assert.equal(stopped, true);
    await assert.rejects(client.call("steer", "x".repeat(260 * 1024)), /单帧上限/);
  } finally {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rex state：manifest/state/result 往返、owner 单实例与 assistant 提取", async () => {
  const dir = tempWorkspace("state");
  const { runId, runDirectory } = makeRun(dir);
  const manifest = manifestFor(dir, runId, runDirectory);
  try {
    writeRexWorkerManifest(rexManifestPath(runDirectory), manifest);
    assert.equal(readRexWorkerManifest(rexManifestPath(runDirectory)).sessionId, manifest.sessionId);
    writeRexPrompt(manifest.promptPath, "阶段 prompt\n");
    assert.equal(readFileSync(manifest.promptPath, "utf8"), "阶段 prompt\n");

    const state = stateFor(runId, { status: "running", run: 1 });
    writeRexWorkerState(rexStatePath(runDirectory), state);
    assert.equal(readRexWorkerState(rexStatePath(runDirectory)).status, "running");

    const result = {
      schemaVersion: 1,
      runId,
      revision: 1,
      outcome: "completed",
      text: "done",
      error: null,
      sessionFile: "/tmp/session.jsonl",
      leafId: "leaf-1",
      completedAt: new Date().toISOString(),
    };
    writeRexWorkerResult(rexDirectory(runDirectory), result);
    assert.equal(readRexWorkerResult(rexResultPath(runDirectory, 1)).text, "done");
    assert.equal(readLatestRexWorkerResult(rexDirectory(runDirectory)).revision, 1);

    const ownerPath = rexOwnerPath(runDirectory);
    const release = acquireOwnerLock(ownerPath);
    assert.throws(() => acquireOwnerLock(ownerPath), /存活 owner/);
    release();

    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: "run" } },
      { id: "a1", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "报告" }] } },
    ];
    const completed = finishRun(stateFor(runId, { run: 1, runStartLeaf: "u1", sessionFile: "/tmp/s.jsonl" }), branch, false, "a1");
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.text, "报告");
    assert.equal(completed.revision, 1);
    const aborted = finishRun(stateFor(runId, { run: 2, runStartLeaf: "u1" }), branch, true, "a1");
    assert.equal(aborted.outcome, "aborted");
    const errored = finishRun(stateFor(runId, { run: 3, runStartLeaf: "u1" }), [
      { id: "a2", type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } },
    ], false, "a2");
    assert.equal(errored.outcome, "error");
    assert.equal(errored.error, "boom");
    assert.equal(activeRexStatus("running"), true);
    assert.equal(activeRexStatus("completed"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RexApi：list/call 封装、newLayer 参数与缺能力报错", async () => {
  const calls = [];
  const methods = REX_REQUIRED_METHODS.map((name) => ({ name }));
  const exec = async (args) => {
    calls.push(args);
    if (args.includes("list")) return { stdout: JSON.stringify({ methods }) };
    const index = args.indexOf("call");
    const method = args[index + 1];
    const payload = JSON.parse(args[index + 2]);
    if (method === "session.new_layer") {
      return { stdout: JSON.stringify({ layer_id: "layer-1", block_ids: ["block-1"], revision: 4 }) };
    }
    if (method === "session.view") {
      return {
        stdout: JSON.stringify({
          windows: [{ layers: [{ layer_id: "layer-1", kind: "tiled", blocks: [{ block_id: "block-1" }] }] }],
        }),
      };
    }
    if (method === "session.list_blocks") {
      return { stdout: JSON.stringify({ blocks: [{ block_id: "block-1", label: "knit run-0123456789ab" }] }) };
    }
    if (method === "session.describe_block") {
      return { stdout: JSON.stringify({ block: { window_id: "window-1", label: "x", host_id: "h1" } }) };
    }
    if (method === "com.superlogical.terminal.process") {
      return { stdout: JSON.stringify({ last_exit: null }) };
    }
    return { stdout: JSON.stringify({ session_id: payload.session_id ?? null }) };
  };
  const api = new RexApi({ session: "rex-session-1", exec, watch: () => ({ stop() {} }) });
  await api.check();
  const layer = await api.newLayer({
    bounds: [0.5, 0.5, 0.4, 0.4],
    label: "knit run-0123456789ab",
    command: ["/usr/bin/env", "X=1", "pi"],
    cwd: "/repo",
    pathPrepend: ["/bin"],
  });
  assert.deepEqual(layer, { layerId: "layer-1", blockIds: ["block-1"], revision: 4 });
  const newLayerCall = calls.find((args) => args.includes("session.new_layer"));
  const payload = JSON.parse(newLayerCall.at(-1));
  assert.equal(payload.session_id, "rex-session-1");
  assert.equal(payload.layout.block.label, "knit run-0123456789ab");
  assert.deepEqual(payload.layout.block.options.command, ["/usr/bin/env", "X=1", "pi"]);
  assert.equal(payload.layout.block.options.exit.on_completion, false);
  assert.deepEqual((await api.view()).layers[0].blockIds, ["block-1"]);
  assert.equal((await api.listBlocks())[0].label, "knit run-0123456789ab");
  assert.equal((await api.describeBlock("block-1")).windowId, "window-1");
  assert.equal((await api.process("block-1")).running, true);

  const missing = new RexApi({
    exec: async () => ({ stdout: JSON.stringify({ methods: methods.filter((m) => m.name !== "session.float_block") }) }),
  });
  await assert.rejects(missing.check(), /session\.float_block/);
});

test("buildRexPiArgs：TUI、扩展、会话与模型参数及 env 注入", () => {
  const args = buildRexPiArgs({
    executablePath: "pi",
    sessionId: "native-1",
    sessionFile: null,
    sessionDir: "/repo/.knit/.runtime/pi-sessions",
    provider: "magpie",
    modelId: "group/openai",
    tools: ["read", "bash"],
    systemPrompt: "system",
    extensionPath: "/pkg/dist/adapters/rex/worker-extension.js",
    manifestPath: "/repo/.knit/.runtime/runs/run-0123456789ab/rex/manifest.json",
    runId: "run-0123456789ab",
    agentDir: "/home/me/.pi/agent",
  });
  assert.equal(args[0], "/usr/bin/env");
  assert.ok(args.includes("PI_KNIT_REX_WORKER=1"));
  assert.ok(args.includes("PI_KNIT_REX_MANIFEST=/repo/.knit/.runtime/runs/run-0123456789ab/rex/manifest.json"));
  assert.ok(args.includes("KNIT_RUN=run-0123456789ab"));
  assert.ok(args.includes("--mode"));
  assert.equal(args[args.indexOf("--mode") + 1], "text");
  assert.equal(args[args.indexOf("--extension") + 1], "/pkg/dist/adapters/rex/worker-extension.js");
  assert.equal(args[args.indexOf("--session-id") + 1], "native-1");
  assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
  const resume = buildRexPiArgs({
    executablePath: "pi",
    sessionId: "native-1",
    sessionFile: "/sessions/old.jsonl",
    sessionDir: "/repo/.knit/.runtime/pi-sessions",
    provider: "p",
    modelId: "m",
    tools: [],
    systemPrompt: "s",
    extensionPath: "/e.js",
    manifestPath: "/m.json",
    runId: "run-0123456789ab",
  });
  assert.equal(resume[resume.indexOf("--session") + 1], "/sessions/old.jsonl");
  assert.ok(resume.includes("--no-tools"));
  assert.ok(rexLabel("run-0123456789ab").startsWith("knit run-"));
  assert.ok(rexLabel("x".repeat(80)).length <= 60);
});

test("RexLauncher：创建浮层、写入 rex.json、bridge 等待与 steer", async () => {
  const dir = tempWorkspace("launcher");
  const { runId, runDirectory } = makeRun(dir);
  const sessionId = `session-${runId}`;
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: dir }) + "\n");

  let created = false;
  let completed = false;
  let server = null;
  let simulatedState = null;
  const steers = [];
  const layerStates = [];
  const session = { sessionFile };
  const methods = REX_REQUIRED_METHODS.map((name) => ({ name }));
  const exec = async (args) => {
    if (args.includes("list")) return { stdout: JSON.stringify({ methods }) };
    const index = args.indexOf("call");
    const method = args[index + 1];
    const payload = JSON.parse(args[index + 2]);
    if (method === "session.list_blocks") {
      return {
        stdout: JSON.stringify({
          blocks: created ? [{ block_id: "block-1", label: rexLabel(runId) }] : [],
        }),
      };
    }
    if (method === "session.new_layer") {
      created = true;
      const manifest = readRexWorkerManifest(rexManifestPath(runDirectory));
      simulatedState = stateFor(runId, {
        instance: manifest.instance,
        status: "running",
        run: 1,
        sessionFile,
        runStartLeaf: null,
      });
      server = new BridgeServer(manifest.socketPath, () => simulatedState, (request) => {
        if (request.method === "steer") {
          steers.push(request.message);
          return { accepted: true, run: simulatedState.run };
        }
        if (request.method === "stop") {
          simulatedState = { ...simulatedState, status: "aborted" };
          return { accepted: true, run: simulatedState.run };
        }
        return simulatedState;
      });
      await server.listen();
      server.publish();
      setTimeout(() => {
        if (simulatedState.status === "aborted") return;
        writeRexWorkerResult(manifest.directory, {
          schemaVersion: 1,
          runId,
          revision: 1,
          outcome: "completed",
          text: "```json\n{\"summary\":\"rex done\",\"changedPaths\":[]}\n```",
          error: null,
          sessionFile,
          leafId: "a1",
          completedAt: new Date().toISOString(),
        });
        simulatedState = { ...simulatedState, status: "completed", resultRevision: 1, leafId: "a1" };
        completed = true;
        server.publish();
      }, 300);
      return {
        stdout: JSON.stringify({
          layer_id: "layer-1",
          block_ids: ["block-1"],
          revision: 1,
          payload,
        }),
      };
    }
    if (method === "session.view") {
      return {
        stdout: JSON.stringify({
          windows: [{ layers: [{ layer_id: "layer-1", kind: "floating", blocks: [{ block_id: "block-1" }] }] }],
        }),
      };
    }
    if (method === "session.set_layer_state") {
      layerStates.push(payload);
      return { stdout: "{}" };
    }
    if (method === "com.superlogical.terminal.process") {
      return { stdout: JSON.stringify({ last_exit: completed ? 0 : null }) };
    }
    if (method === "session.close_layer") return { stdout: "{}" };
    return { stdout: "{}" };
  };
  const api = new RexApi({ session: "rex-session", exec, watch: () => ({ stop() {} }) });
  const pids = [];
  const launcher = new RexLauncher({
    root: dir,
    runId,
    taskId: "k-0123456789ab",
    phase: "implement",
    sessionId,
    sessionFile: null,
    provider: "fake",
    modelId: "fake",
    tools: [],
    systemPrompt: "system",
    userPrompt: "user prompt",
    cwd: dir,
    sessionDir: join(dir, "sessions"),
    executablePath: "pi",
    rex: api,
    pollIntervalMs: 25,
    cancelGraceMs: 500,
    closeOnSettle: false,
    onPid: (pid) => pids.push(pid),
  });
  try {
    const executionPromise = launcher.execute();
    await waitUntil(() => launcher.status()?.status === "running");
    assert.equal(launcher.status().run, 1);
    await launcher.steer("检查边界");
    const execution = await executionPromise;
    assert.equal(execution.settled, true);
    assert.equal(execution.aborted, false);
    assert.equal(execution.failure, null);
    assert.equal(execution.result.outcome, "completed");
    assert.match(execution.text, /rex done/);
    assert.equal(execution.sessionFile, sessionFile);
    assert.equal(execution.pid, process.pid);
    assert.deepEqual(steers, ["检查边界"]);
    assert.ok(pids.includes(process.pid));
    assert.equal(layerStates.at(-1).state, "minimized");
    const association = readRexAssociation(rexAssociationPath(runDirectory));
    assert.equal(association.blockId, "block-1");
    assert.equal(association.layerId, "layer-1");
    assert.equal(association.label, rexLabel(runId));
  } finally {
    await launcher.dispose();
    if (server !== null) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RexLauncher：bridge 断开时进程兜底节流与退出读取", async () => {
  const dir = tempWorkspace("fallback");
  const { runId, runDirectory } = makeRun(dir);
  const manifest = manifestFor(dir, runId, runDirectory);
  writeRexWorkerManifest(rexManifestPath(runDirectory), manifest);
  const association = {
    schemaVersion: 1,
    runId,
    sessionId: manifest.sessionId,
    instance: manifest.instance,
    blockId: "block-1",
    layerId: "layer-1",
    label: manifest.label,
    socketPath: manifest.socketPath,
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  };
  writeRexAssociation(rexAssociationPath(runDirectory), association);
  writeRexWorkerState(rexStatePath(runDirectory), stateFor(runId, {
    instance: manifest.instance,
    status: "running",
    run: 1,
    pid: process.pid + 100_000,
  }));
  const processCalls = [];
  const methods = REX_REQUIRED_METHODS.map((name) => ({ name }));
  let exited = false;
  const exec = async (args) => {
    if (args.includes("list")) return { stdout: JSON.stringify({ methods }) };
    const index = args.indexOf("call");
    const method = args[index + 1];
    if (method === "session.list_blocks") {
      return { stdout: JSON.stringify({ blocks: [{ block_id: "block-1", label: manifest.label }] }) };
    }
    if (method === "com.superlogical.terminal.process") {
      processCalls.push(Date.now());
      return { stdout: JSON.stringify({ last_exit: exited ? 0 : null }) };
    }
    return { stdout: "{}" };
  };
  const api = new RexApi({ session: "rex-session", exec, watch: () => ({ stop() {} }) });
  const launcher = new RexLauncher({
    root: dir,
    runId,
    taskId: "k-0123456789ab",
    phase: "implement",
    sessionId: manifest.sessionId,
    provider: "p",
    modelId: "m",
    tools: [],
    systemPrompt: "s",
    userPrompt: "u",
    cwd: dir,
    sessionDir: join(dir, "sessions"),
    executablePath: "pi",
    rex: api,
    pollIntervalMs: 20,
    cancelGraceMs: 60_000,
    startupTimeoutMs: 60_000,
    // socket 不存在：bridge 连接短超时后进入兜底路径。
    bridgeConnectTimeoutMs: 100,
  });
  // 进程退出前先在体外确定结果写盘时机；execute 里的节流兜底只负责观察退出。
  const executionPromise = launcher.execute();
  let execution;
  try {
    // 节流：约 2 秒（pollIntervalMs 20ms × 100）一次，3 秒内只有个位数调用。
    await waitUntil(() => processCalls.length >= 2, 10_000);
    assert.ok(processCalls.length < 60, `兜底查询未节流：${processCalls.length} 次`);
    // 进程退出后先读结果文件，不直接按 exited 失败收敛。
    exited = true;
    writeRexWorkerResult(rexDirectory(runDirectory), {
      schemaVersion: 1,
      runId,
      revision: 1,
      outcome: "completed",
      text: "fallback done",
      error: null,
      sessionFile: null,
      leafId: null,
      completedAt: new Date().toISOString(),
    });
    execution = await Promise.race([
      executionPromise,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("execute 未收敛")), 10_000)),
    ]);
    assert.equal(execution.settled, true);
    assert.equal(execution.text, "fallback done");
    assert.equal(execution.failure, null);
  } catch (error) {
    // 兜底等待的 promise 不能悬挂测试进程；异常路径同样先终止 launcher。
    exited = true;
    writeRexWorkerResult(rexDirectory(runDirectory), {
      schemaVersion: 1,
      runId,
      revision: 1,
      outcome: "completed",
      text: "unblock",
      error: null,
      sessionFile: null,
      leafId: null,
      completedAt: new Date().toISOString(),
    });
    await executionPromise.catch(() => {});
    throw error;
  } finally {
    await launcher.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RexLauncher：恢复发现进程已退先读结果，身份不符拒绝冒认", async () => {
  const dir = tempWorkspace("recover");
  const { runId, runDirectory } = makeRun(dir);
  const manifest = manifestFor(dir, runId, runDirectory);
  writeRexWorkerManifest(rexManifestPath(runDirectory), manifest);
  const association = {
    schemaVersion: 1,
    runId,
    sessionId: manifest.sessionId,
    instance: manifest.instance,
    blockId: "block-1",
    layerId: "layer-1",
    label: manifest.label,
    socketPath: manifest.socketPath,
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  };
  writeRexAssociation(rexAssociationPath(runDirectory), association);
  writeRexWorkerResult(rexDirectory(runDirectory), {
    schemaVersion: 1,
    runId,
    revision: 1,
    outcome: "completed",
    text: "already done",
    error: null,
    sessionFile: "/tmp/s.jsonl",
    leafId: null,
    completedAt: new Date().toISOString(),
  });
  const methods = REX_REQUIRED_METHODS.map((name) => ({ name }));
  const exec = async (args) => {
    if (args.includes("list")) return { stdout: JSON.stringify({ methods }) };
    const index = args.indexOf("call");
    const method = args[index + 1];
    if (method === "session.list_blocks") {
      return { stdout: JSON.stringify({ blocks: [{ block_id: "block-1", label: manifest.label }] }) };
    }
    if (method === "com.superlogical.terminal.process") {
      return { stdout: JSON.stringify({ last_exit: 0 }) };
    }
    return { stdout: "{}" };
  };
  const api = new RexApi({ session: "rex-session", exec, watch: () => ({ stop() {} }) });
  try {
    const launcher = new RexLauncher({
      root: dir,
      runId,
      taskId: "k-0123456789ab",
      phase: "implement",
      sessionId: manifest.sessionId,
      provider: "p",
      modelId: "m",
      tools: [],
      systemPrompt: "s",
      userPrompt: "u",
      cwd: dir,
      sessionDir: join(dir, "sessions"),
      executablePath: "pi",
      rex: api,
    });
    const discovery = await launcher.discover();
    assert.equal(discovery.state, "completed");
    assert.equal(discovery.result.text, "already done");
    launcher.dispose();

    // manifest 身份与 rex.json 不一致：不得按 label 冒认另一个会话。
    writeRexWorkerManifest(rexManifestPath(runDirectory), { ...manifest, sessionId: "other-session" });
    const mismatchLauncher = new RexLauncher({
      root: dir,
      runId,
      taskId: "k-0123456789ab",
      phase: "implement",
      sessionId: "other-session",
      provider: "p",
      modelId: "m",
      tools: [],
      systemPrompt: "s",
      userPrompt: "u",
      cwd: dir,
      sessionDir: join(dir, "sessions"),
      executablePath: "pi",
      rex: api,
    });
    assert.equal((await mismatchLauncher.discover()).state, "identity_mismatch");
    await mismatchLauncher.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function extensionHarness(prefix) {
  const dir = tempWorkspace(prefix);
  const { runId, runDirectory } = makeRun(dir);
  const manifest = manifestFor(dir, runId, runDirectory);
  writeRexWorkerManifest(rexManifestPath(runDirectory), manifest);
  writeRexPrompt(manifest.promptPath, "冻结的阶段 prompt\n");
  const handlers = new Map();
  const sent = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(content, options = {}) {
      sent.push({ content, options });
    },
  };
  const entries = [];
  const ctx = {
    mode: "tui",
    sessionManager: {
      getSessionId: () => manifest.sessionId,
      getSessionFile: () => join(dir, "session.jsonl"),
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries,
    },
    aborted: false,
    shutDown: false,
    abort() {
      this.aborted = true;
    },
    shutdown() {
      this.shutDown = true;
    },
    ui: { notify() {} },
  };
  return { dir, runId, runDirectory, manifest, handlers, sent, pi, ctx, entries };
}

test("worker-extension：TUI/身份校验、prompt 注入、bridge status/steer、settle 写结果", async () => {
  const harness = extensionHarness("ext-complete");
  const previousWorker = process.env.PI_KNIT_REX_WORKER;
  const previousManifest = process.env.PI_KNIT_REX_MANIFEST;
  process.env.PI_KNIT_REX_WORKER = "1";
  process.env.PI_KNIT_REX_MANIFEST = rexManifestPath(harness.runDirectory);
  try {
    assert.equal(workerManifestPath(), rexManifestPath(harness.runDirectory));
    registerRexWorker(harness.pi);
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].content, "冻结的阶段 prompt\n");

    const client = await BridgeClient.connect(harness.manifest.socketPath, () => {}, () => {});
    try {
      const status = await client.call("status");
      assert.equal(status.runId, harness.runId);
      assert.equal(status.status, "running");
      assert.equal(status.run, 1);
      assert.deepEqual(await client.call("steer", "继续"), { accepted: true, run: 1 });
      assert.equal(harness.sent.at(-1).options.deliverAs, "steer");

      harness.entries.push(
        { id: "u1", type: "message", message: { role: "user", content: "prompt" } },
        {
          id: "a1",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "```json\n{\"summary\":\"ok\",\"changedPaths\":[]}\n```" }],
          },
        },
      );
      await harness.handlers.get("agent_settled")({ aborted: false }, harness.ctx);
      const result = readLatestRexWorkerResult(rexDirectory(harness.runDirectory));
      assert.equal(result.outcome, "completed");
      assert.match(result.text, /"summary":"ok"/);
      assert.equal(readRexWorkerState(rexStatePath(harness.runDirectory)).status, "completed");
      assert.equal(readRexWorkerState(rexStatePath(harness.runDirectory)).resultRevision, 1);
    } finally {
      client.close();
    }
    await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
    assert.equal(readRexWorkerState(rexStatePath(harness.runDirectory)).status, "closed");
    assert.equal(existsSync(rexOwnerPath(harness.runDirectory)), false);
  } finally {
    if (previousWorker === undefined) delete process.env.PI_KNIT_REX_WORKER;
    else process.env.PI_KNIT_REX_WORKER = previousWorker;
    if (previousManifest === undefined) delete process.env.PI_KNIT_REX_MANIFEST;
    else process.env.PI_KNIT_REX_MANIFEST = previousManifest;
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

test("worker-extension：stop 触发 abort，settle 记为 aborted；非 TUI 拒绝启动", async () => {
  const harness = extensionHarness("ext-stop");
  const previousWorker = process.env.PI_KNIT_REX_WORKER;
  const previousManifest = process.env.PI_KNIT_REX_MANIFEST;
  process.env.PI_KNIT_REX_WORKER = "1";
  process.env.PI_KNIT_REX_MANIFEST = rexManifestPath(harness.runDirectory);
  try {
    registerRexWorker(harness.pi);
    await harness.handlers.get("session_start")({}, harness.ctx);
    const client = await BridgeClient.connect(harness.manifest.socketPath, () => {}, () => {});
    try {
      assert.deepEqual(await client.call("stop"), { accepted: true, run: 1 });
      assert.equal(harness.ctx.aborted, true);
      harness.entries.push({
        id: "a1",
        type: "message",
        message: { role: "assistant", stopReason: "aborted", content: [] },
      });
      await harness.handlers.get("agent_settled")({ aborted: true }, harness.ctx);
      const result = readLatestRexWorkerResult(rexDirectory(harness.runDirectory));
      assert.equal(result.outcome, "aborted");
      assert.deepEqual(await client.call("stop"), { accepted: false, reason: "not_running", run: 1 });
    } finally {
      client.close();
    }
    await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
  } finally {
    if (previousWorker === undefined) delete process.env.PI_KNIT_REX_WORKER;
    else process.env.PI_KNIT_REX_WORKER = previousWorker;
    if (previousManifest === undefined) delete process.env.PI_KNIT_REX_MANIFEST;
    else process.env.PI_KNIT_REX_MANIFEST = previousManifest;
    rmSync(harness.dir, { recursive: true, force: true });
  }

  const nonTui = extensionHarness("ext-nontui");
  process.env.PI_KNIT_REX_WORKER = "1";
  process.env.PI_KNIT_REX_MANIFEST = rexManifestPath(nonTui.runDirectory);
  try {
    registerRexWorker(nonTui.pi);
    nonTui.ctx.mode = "print";
    await nonTui.handlers.get("session_start")({}, nonTui.ctx);
    assert.equal(nonTui.ctx.shutDown, true);
    assert.equal(nonTui.ctx.aborted, false);
    assert.equal(workerManifestPath(), rexManifestPath(nonTui.runDirectory));
  } finally {
    if (previousWorker === undefined) delete process.env.PI_KNIT_REX_WORKER;
    else process.env.PI_KNIT_REX_WORKER = previousWorker;
    if (previousManifest === undefined) delete process.env.PI_KNIT_REX_MANIFEST;
    else process.env.PI_KNIT_REX_MANIFEST = previousManifest;
    rmSync(nonTui.dir, { recursive: true, force: true });
  }
});

test("RunCoordinator：presentation=rex 写入不可变 request 并被 status 投影", async () => {
  const dir = project("presentation");
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), hostProbe: async () => {} });
  try {
    const task = await tasks.newTask({ dir, title: "rex presentation", slug: "rex-presentation", verification: "independent" });
    await tasks.ready({ dir, taskId: task.taskId });
    const prepared = await coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "implement",
      presentation: "rex",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "fake", model: "fake" },
    });
    assert.equal(prepared.request.presentation, "rex");
    assert.equal(prepared.request.presentationSource, "explicit");
    assert.equal(prepared.request.presentationFallbackReason, null);
    assert.equal(new RunStore(dir).readRequest(prepared.request.runId).presentation, "rex");
    const status = await coordinator.status({ dir, runId: prepared.request.runId });
    assert.equal(status.presentation, "rex");
    assert.equal(status.presentationSource, "explicit");
    assert.equal(status.presentationFallbackReason, null);
    assert.equal(status.state, "claimed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StageRunner Rex 分支：注入 launcher 后仍走报告/差异/原生范围与 result 发布", async () => {
  const dir = project("stagerun");
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  try {
    const task = await tasks.newTask({ dir, title: "rex stage", slug: "rex-stage", verification: "independent" });
    await tasks.ready({ dir, taskId: task.taskId });
    const planner = new ContextPlanner({ store });
    const plan = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(plan.ready, true);
    const coordinator = new RunCoordinator({ store, randomHex, lockRoot: join(dir, ".locks"), hostProbe: async () => {} });
    const prepared = await coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "implement",
      presentation: "rex",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "fake", model: "fake" },
    });
    const missing = [];
    const launcherFactory = (options) => {
      missing.push(options.sessionId);
      return {
        async execute() {
          const sessionFile = join(dir, ".knit", ".runtime", "pi-sessions", `fake_${options.sessionId}.jsonl`);
          mkdirSync(dirname(sessionFile), { recursive: true });
          writeFileSync(
            sessionFile,
            [
              JSON.stringify({ type: "session", version: 3, id: options.sessionId, cwd: dir }),
              JSON.stringify({
                id: "a1",
                parentId: null,
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "stop",
                  content: [{ type: "text", text: "```json\n{\"summary\":\"rex 修改 README\",\"changedPaths\":[\"README.md\"]}\n```" }],
                },
              }),
            ].join("\n") + "\n",
          );
          writeFileSync(join(dir, "README.md"), "# changed by rex\n");
          return {
            settled: true,
            aborted: false,
            exit: null,
            text: "```json\n{\"summary\":\"rex 修改 README\",\"changedPaths\":[\"README.md\"]}\n```",
            sessionFile,
            pid: process.pid,
            usage: { inputTokens: null, outputTokens: null },
            result: { outcome: "completed" },
            failure: null,
          };
        },
        async stop() {},
        async steer() {},
        async terminate() {},
        async dispose() {},
        status() {
          return null;
        },
      };
    };
    const runner = new StageRunner({
      root: dir,
      request: prepared.request,
      plan,
      inputs: {},
      store,
      runs: new RunStore(dir),
      rexLauncherFactory: launcherFactory,
    });
    const execution = await runner.execute();
    assert.equal(missing.length, 1);
    assert.equal(execution.result.state, "completed");
    assert.equal(execution.result.failureReason, null);
    assert.deepEqual(execution.result.actualChangedPaths, ["README.md"]);
    assert.equal(execution.result.session.nativeReadable, true);
    assert.equal(execution.result.nativeEntries.leafEntryId, "a1");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：run implement/check 暴露 --rex 与 --local 开关", () => {
  for (const command of ["implement", "check"]) {
    const result = spawnSync(process.execPath, [join(ROOT, "dist", "cli", "knit.js"), "run", command, "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--rex/);
    assert.match(result.stdout, /--local/);
  }
});
