/**
 * REX 自动呈现：宿主解析优先级、默认探测分类、prepare 落盘与回退可见性。
 * 隔离夹具使用真实 Git／SQLite；rex CLI 用本地假脚本，不连接真实 Rex server。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectHost, probeRexHost, resolveRexExecutable, HostProbeError } from "../dist/application/host-selection.js";
import { defaultConfig, parseConfig } from "../dist/application/config.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { TaskService } from "../dist/application/task-service.js";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { RunStore } from "../dist/infrastructure/run-store.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli", "knit.js");
const TEMPLATES = join(ROOT, "assets", "templates", ".knit");
const REQUIRED_METHODS = [
  "session.new_layer",
  "session.set_layer_state",
  "session.float_block",
  "session.view",
  "session.list_blocks",
  "session.describe_block",
  "session.close_layer",
];

let sequence = 0;
const randomHex = () => {
  sequence += 1;
  return sequence.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-host-${prefix}-`)));
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

function setHost(dir, host) {
  const path = join(dir, ".knit", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.execution.host = host;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function services(dir, options = {}) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({
    store,
    randomHex,
    lockRoot: join(dir, ".locks"),
    ...options,
  });
  return { store, locks, tasks, coordinator };
}

async function readyTask(s, dir, title = "宿主任务") {
  const task = await s.tasks.newTask({ dir, title, slug: title, verification: "self" });
  await s.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function prepareInput(dir, taskId, extra = {}) {
  return {
    dir,
    taskId,
    phase: "implement",
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "fake", model: "fake" },
    ...extra,
  };
}

/** 可执行假 rex：按 FAKE_REX_MODE 返回方法列表、缺方法或连接失败。 */
function fakeRex(binDir, mode = "ok") {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "rex");
  const body =
    mode === "missing_methods"
      ? `console.log(JSON.stringify({ methods: [{ name: "session.view" }] }));`
      : mode === "connection_failed"
        ? `process.stderr.write("server unavailable\\n"); process.exit(1);`
        : `console.log(JSON.stringify({ methods: ${JSON.stringify(REQUIRED_METHODS.map((name) => ({ name })))} }));`;
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function rexEnv(binDir) {
  return {
    PATH: "/usr/bin:/bin",
    REX_SESSION: "session:test",
    REX_BLOCK: "block:test",
    REX_BIN_DIR: binDir,
  };
}

function withoutRexEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  delete env.REX_BIN_DIR;
  return env;
}

test("宿主解析优先级：显式 > 配置 > auto；local 不探测", async () => {
  let probes = 0;
  const ok = async () => {
    probes += 1;
  };
  const fail = async () => {
    probes += 1;
    throw new Error("探测失败");
  };

  assert.deepEqual(await selectHost({ explicit: "local", config: "rex", probe: fail }), {
    host: "local",
    source: "explicit",
    fallbackReason: null,
  });
  assert.equal(probes, 0, "显式 local 不探测");

  assert.deepEqual(await selectHost({ explicit: "rex", config: "local", probe: ok }), {
    host: "rex",
    source: "explicit",
    fallbackReason: null,
  });
  assert.equal(probes, 1);

  assert.deepEqual(await selectHost({ config: "local", probe: fail }), {
    host: "local",
    source: "config",
    fallbackReason: null,
  });
  assert.equal(probes, 1, "配置 local 不探测");

  assert.deepEqual(await selectHost({ config: "rex", probe: ok }), {
    host: "rex",
    source: "config",
    fallbackReason: null,
  });
  assert.equal(probes, 2);

  assert.deepEqual(await selectHost({ config: "auto", probe: ok }), {
    host: "rex",
    source: "auto",
    fallbackReason: null,
  });
  assert.deepEqual(await selectHost({ config: null, probe: ok }), {
    host: "rex",
    source: "auto",
    fallbackReason: null,
  });
  assert.deepEqual(await selectHost({ probe: fail }), {
    host: "local",
    source: "auto",
    fallbackReason: "探测失败",
  });
});

test("显式／配置 rex 探测失败不回退；auto 失败只在派发前回退", async () => {
  const fail = async () => {
    throw new HostProbeError("cli_missing", "未找到可执行的 rex CLI");
  };
  await assert.rejects(
    selectHost({ explicit: "rex", probe: fail }),
    (error) => error.guardReason === "rex_unavailable" && /显式 --rex 不可用/.test(error.message) && /rex CLI/.test(error.message),
  );
  await assert.rejects(
    selectHost({ config: "rex", probe: fail }),
    (error) => error.guardReason === "rex_unavailable" && /execution\.host=rex 不可用/.test(error.message),
  );
  assert.deepEqual(await selectHost({ config: "auto", probe: fail }), {
    host: "local",
    source: "auto",
    fallbackReason: "未找到可执行的 rex CLI",
  });
});

test("默认探测：环境缺失、CLI 缺失、连接失败、缺方法分类且成功复用 RexApi", async () => {
  await assert.rejects(
    probeRexHost({ PATH: "/usr/bin:/bin" }),
    (error) => error instanceof HostProbeError && error.kind === "missing_environment",
  );
  await assert.rejects(
    probeRexHost({ REX_SESSION: "s", REX_BLOCK: "b", PATH: join(ROOT, "no-such-bin") }),
    (error) => error instanceof HostProbeError && error.kind === "cli_missing",
  );

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "knit-host-bin-")));
  try {
    const missing = fakeRex(join(workspace, "missing"), "missing_methods");
    assert.equal(resolveRexExecutable(rexEnv(join(workspace, "missing"))), missing);
    await assert.rejects(
      probeRexHost(rexEnv(join(workspace, "missing"))),
      (error) => error instanceof HostProbeError && error.kind === "missing_methods" && /缺少必需方法/.test(error.message),
    );

    fakeRex(join(workspace, "broken"), "connection_failed");
    await assert.rejects(
      probeRexHost(rexEnv(join(workspace, "broken"))),
      (error) => error instanceof HostProbeError && error.kind === "connection_failed" && /不可连接/.test(error.message),
    );

    fakeRex(join(workspace, "ok"));
    assert.equal(await probeRexHost(rexEnv(join(workspace, "ok"))), undefined);
    assert.equal(await selectHost({ config: "auto", env: rexEnv(join(workspace, "ok")) }).then((value) => value.host), "rex");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("默认配置为 auto；旧 local 仍是显式本地，未知 host 由 schema 拒绝", () => {
  assert.equal(defaultConfig().execution.host, "auto");
  assert.equal(parseConfig(JSON.stringify({ ...defaultConfig(), execution: { host: "local" } })).execution.host, "local");
  assert.throws(
    () => parseConfig(JSON.stringify({ ...defaultConfig(), execution: { host: "remote" } })),
    (error) => error.code === "io_error",
  );
});

test("prepare：auto 探测成功落盘 rex，普通环境回退 local 并保留原因", async () => {
  const successDir = project("auto-rex");
  const success = services(successDir, { env: rexEnv(join(successDir, ".fake-rex-ok")) });
  try {
    fakeRex(join(successDir, ".fake-rex-ok"));
    const task = await readyTask(success, successDir, "auto-rex");
    // 默认探测使用注入 env；不传 --rex。
    const prepared = await success.coordinator.prepare(prepareInput(successDir, task.taskId));
    assert.equal(prepared.request.presentation, "rex");
    assert.equal(prepared.request.presentationSource, "auto");
    assert.equal(prepared.request.presentationFallbackReason, null);
    assert.equal((await success.coordinator.status({ dir: successDir, runId: prepared.request.runId })).presentation, "rex");
  } finally {
    success.store.close();
    rmSync(successDir, { recursive: true, force: true });
  }

  const fallbackDir = project("auto-local");
  const fallback = services(fallbackDir, { env: {} });
  try {
    const task = await readyTask(fallback, fallbackDir, "auto-local");
    const prepared = await fallback.coordinator.prepare(prepareInput(fallbackDir, task.taskId));
    assert.equal(prepared.request.presentation, "local");
    assert.equal(prepared.request.presentationSource, "auto");
    assert.match(prepared.request.presentationFallbackReason ?? "", /REX_SESSION／REX_BLOCK/);
    const status = await fallback.coordinator.status({ dir: fallbackDir, runId: prepared.request.runId });
    assert.equal(status.presentation, "local");
    assert.equal(status.presentationSource, "auto");
    assert.match(status.presentationFallbackReason ?? "", /REX_SESSION／REX_BLOCK/);

    const list = spawnSync(process.execPath, [CLI, "run", "list", "--dir", fallbackDir], {
      encoding: "utf8",
      env: withoutRexEnv(),
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /host=local source=auto/);
    assert.match(list.stdout, /fallback=.*REX_SESSION/);

    const statusText = spawnSync(process.execPath, [CLI, "run", "status", prepared.request.runId, "--dir", fallbackDir], {
      encoding: "utf8",
      env: withoutRexEnv(),
    });
    assert.equal(statusText.status, 0, statusText.stderr);
    assert.match(statusText.stdout, /呈现: local（来源 auto）/);
    assert.match(statusText.stdout, /回退原因: .*REX_SESSION/);
  } finally {
    fallback.store.close();
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

test("explicit rex／host=rex 失败不回退；--local 覆盖配置 rex 不探测", async () => {
  const dir = project("explicit");
  setHost(dir, "rex");
  const failingProbe = async () => {
    throw new HostProbeError("cli_missing", "未找到可执行的 rex CLI（REX_BIN_DIR 或 PATH）");
  };
  const s = services(dir, { hostProbe: failingProbe });
  try {
    const task = await readyTask(s, dir, "explicit");
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId, { presentation: "rex" })),
      (error) => error.guardReason === "rex_unavailable" && /显式 --rex 不可用/.test(error.message),
    );
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId)),
      (error) => error.guardReason === "rex_unavailable" && /execution\.host=rex 不可用/.test(error.message),
    );
    const local = await s.coordinator.prepare(prepareInput(dir, task.taskId, { presentation: "local" }));
    assert.equal(local.request.presentation, "local");
    assert.equal(local.request.presentationSource, "explicit");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活动 run 的 presentation 不可变", async () => {
  const dir = project("immutable");
  setHost(dir, "local");
  const s = services(dir, { hostProbe: async () => {} });
  try {
    const task = await readyTask(s, dir, "immutable");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, { presentation: "rex" }));
    assert.equal(prepared.request.presentation, "rex");
    await assert.rejects(
      s.coordinator.prepare(prepareInput(dir, task.taskId, { presentation: "local" })),
      (error) => error.guardReason === "invalid_request" && /已有活动 run 使用 rex 呈现/.test(error.message),
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume 沿用旧 run 的 presentation，不重新探测宿主", async () => {
  const dir = project("resume");
  setHost(dir, "local");
  let failProbe = false;
  let probes = 0;
  const probe = async () => {
    probes += 1;
    if (failProbe) throw new HostProbeError("missing_environment", "不应再次探测");
  };
  const s = services(dir, { hostProbe: probe });
  try {
    const task = await readyTask(s, dir, "resume");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, { presentation: "rex" }));
    assert.equal(prepared.request.presentation, "rex");
    assert.equal(probes, 1);
    failProbe = true;
    const resumed = await s.coordinator.resume({ dir, oldRunId: prepared.request.runId });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.request?.presentation, "rex");
    assert.equal(resumed.request?.presentationSource, "explicit");
    assert.equal(probes, 1, "resume 不重新探测");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：无 --rex 时按 execution.host=auto 与环境自动使用 Rex", async () => {
  const dir = project("cli-auto");
  const s = services(dir, { env: {} });
  try {
    const task = await readyTask(s, dir, "cli-auto");
    const binDir = join(dir, ".fake-rex-cli");
    fakeRex(binDir);
    const prepared = spawnSync(
      process.execPath,
      [CLI, "--json", "run", "prepare", "--task", task.taskId, "--stage", "implement", "--provider", "fake", "--model", "fake", "--dir", dir],
      { encoding: "utf8", env: { ...process.env, ...rexEnv(binDir) } },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    const response = JSON.parse(prepared.stdout);
    assert.equal(response.outcome, "completed", prepared.stdout);
    assert.equal(response.data.request.presentation, "rex");
    assert.equal(response.data.request.presentationSource, "auto");
    assert.equal(response.data.request.presentationFallbackReason, null);

    const list = spawnSync(process.execPath, [CLI, "run", "list", "--dir", dir], {
      encoding: "utf8",
      env: withoutRexEnv(),
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /host=rex source=auto/);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：--rex 与 --local 冲突报 invalid_request；帮助与桥接不再强制本地", () => {
  const dir = project("cli");
  try {
    const conflict = spawnSync(
      process.execPath,
      [CLI, "--json", "run", "implement", "--task", "k-0123456789ab", "--rex", "--local", "--dir", dir],
      { encoding: "utf8", env: withoutRexEnv() },
    );
    assert.equal(conflict.status, 1, conflict.stderr);
    assert.equal(JSON.parse(conflict.stdout).reasonCode, "invalid_request");
    assert.match(JSON.parse(conflict.stdout).data.error, /--rex 与 --local 不能同时使用/);

    for (const command of ["prepare", "implement", "check"]) {
      const help = spawnSync(process.execPath, [CLI, "run", command, "--help"], { encoding: "utf8" });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /--rex/);
      assert.match(help.stdout, /--local/);
    }
    const topHelp = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    assert.equal(topHelp.status, 0, topHelp.stderr);
    assert.doesNotMatch(topHelp.stdout, /^  assist/m, "assist 命令已删除");

    const bridge = readFileSync(join(ROOT, "assets", "templates", "pi", "extensions", "knit.ts"), "utf8");
    assert.equal(bridge, readFileSync(join(ROOT, ".pi", "extensions", "knit.ts"), "utf8"), "两份桥接保持一致");
    assert.match(bridge, /env: \{ \.\.\.process\.env/, "桥接继承 Rex 环境");
    const runTool = bridge.slice(bridge.indexOf('name: "knit_run"'), bridge.indexOf('name: "knit_deliver"'));
    assert.doesNotMatch(runTool, /--rex|--local/, "knit_run 不强制宿主，按配置／环境自动生效");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("桥接通知：仅需处理时唤醒，completed+accepted 以 nextTurn 进入下一轮", () => {
  const bridge = readFileSync(join(ROOT, "assets", "templates", "pi", "extensions", "knit.ts"), "utf8");
  assert.equal(bridge, readFileSync(join(ROOT, ".pi", "extensions", "knit.ts"), "utf8"), "两份桥接保持一致");

  const rule = bridge.match(/const needsAction = ([^;]+);/);
  assert.ok(rule, "桥接显式计算 needsAction");
  const needsAction = new Function("noticeState", "acceptanceState", `return (${rule[1]});`);
  assert.equal(needsAction("failed", null), true, "失败需处理");
  assert.equal(needsAction("cancelled", null), true, "取消需处理");
  assert.equal(needsAction("completed", null), true, "完成但结果未接收需处理");
  assert.equal(needsAction("completed", "pending"), true, "结果待接收需处理");
  assert.equal(needsAction("completed", "completed"), false, "完成且已接收不唤醒");

  const delivery = bridge.match(/needsAction\s*\?\s*(\{[^}]*\})\s*:\s*(\{[^}]*\})/);
  assert.ok(delivery, "投递策略按 needsAction 分流");
  assert.match(delivery[1], /deliverAs: "followUp".*triggerTurn: true/, "需处理走 followUp 并唤醒");
  assert.match(delivery[2], /deliverAs: "nextTurn".*triggerTurn: false/, "被动通知只进入下一轮上下文");
  assert.doesNotMatch(bridge, /ctx\.isIdle|busy \?/, "不再按 busy 无差别唤醒");

  const design = readFileSync(join(ROOT, "docs", "design", "DESIGN.md"), "utf8");
  const section = design.slice(design.indexOf("### 9.3"), design.indexOf("### 9.4"));
  assert.match(section, /失败、取消或结果待接收/, "DESIGN §9.3 记录唤醒条件");
  assert.match(section, /nextTurn/, "DESIGN §9.3 记录被动投递");
});
