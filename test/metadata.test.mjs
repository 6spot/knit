/**
 * 生产 SqliteMetadataStore 验证（任务004：SQLite 为唯一元数据权威）。
 * 覆盖：关联写入原子性、重复接收不多计、两进程竞争无丢失更新、
 * 崩溃后回滚、busy 冲突如实报错、只读不写。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

function makeRoot(name) {
  return mkdtempSync(path.join(tmpdir(), `knit-meta-${name}-`));
}

/** 启动 rival 子进程；exit promise 立即挂接，避免早退后永久等待。 */
function spawnRival(script, dbPath) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, DIST, dbPath],
    { cwd: path.dirname(dbPath) },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, exit, stderr: () => stderr };
}

const IMPORT = "const { SqliteMetadataStore } = await import(process.argv[1] + '/infrastructure/sqlite-metadata-store.js');";

function makeBinding(taskId, overrides = {}) {
  return {
    taskId,
    repoRoot: "/tmp/knit-proj",
    relativePath: `tasks/${taskId}.md`,
    branch: "knit/main",
    lastRunIds: [],
    lastCheckRunId: null,
    repairCycleId: null,
    repairRounds: null,
    stopReason: null,
    confirmedInputsDigest: null,
    confirmedStandardsDigest: null,
    pendingDraft: null,
    ...overrides,
  };
}

const REF = { client: "pi", nativeSessionId: "native-s-1", role: "implement" };

function makeSessionRecord(overrides = {}) {
  return {
    knitSessionId: "s-0123456789ab",
    protocolVersion: 1,
    ref: REF,
    kind: "sub",
    status: "opening",
    sessionFile: null,
    parentSessionId: null,
    source: null,
    taskId: null,
    branch: null,
    runId: null,
    cwd: "/repo",
    checkpoint: null,
    selection: null,
    reason: null,
    lastVerifiedAt: null,
    nativeReadable: false,
    relatedRunState: null,
    recordedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

test("关联写入：同一短事务更新 Session/binding/operation，同提交同回滚", async () => {
  const root = makeRoot("linked");
  const store = new SqliteMetadataStore(path.join(root, "meta.db"));
  try {
    await store.withTransaction(async () => {
      await store.sessions.save(makeSessionRecord({ status: "opening", taskId: "task-1", runId: "run-1" }));
      await store.bindings.save(makeBinding("task-1", { lastRunIds: ["run-1"] }));
      await store.operations.save({
        operationId: "op-1",
        kind: "git_commit",
        state: "running",
        reason: null,
        recordedAt: "2026-11-01T00:00:00.000Z",
      });
    });
    assert.equal((await store.sessions.get(REF)).runId, "run-1");
    assert.deepEqual((await store.bindings.get("task-1")).lastRunIds, ["run-1"]);
    assert.equal((await store.operations.get("op-1")).state, "running");

    // 中途失败：事务回滚，三张表都不留半提交状态。
    await assert.rejects(
      store.withTransaction(async () => {
        await store.bindings.save(makeBinding("task-1", { lastRunIds: ["run-1", "run-2"] }));
        await store.operations.setState("op-1", "completed");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual((await store.bindings.get("task-1")).lastRunIds, ["run-1"], "回滚后不留 run-2");
    assert.equal((await store.operations.get("op-1")).state, "running", "回滚后状态不变");
  } finally {
    store.close();
  }
});

test("重复接收不多计：幂等追加同 ID 只计一次", async () => {
  const root = makeRoot("idempotent");
  const store = new SqliteMetadataStore(path.join(root, "meta.db"));
  try {
    const appendOnce = async (runId) =>
      store.withTransaction(async () => {
        const binding = (await store.bindings.get("task-1")) ?? makeBinding("task-1");
        if (!binding.lastRunIds.includes(runId)) {
          await store.bindings.save({ ...binding, lastRunIds: [...binding.lastRunIds, runId] });
        }
      });
    await appendOnce("run-1");
    await appendOnce("run-1");
    assert.deepEqual((await store.bindings.get("task-1")).lastRunIds, ["run-1"]);
  } finally {
    store.close();
  }
});

test("两进程竞争：并发追加无丢失更新，计数为两者之和", async () => {
  const root = makeRoot("contended");
  const dbPath = path.join(root, "meta.db");
  const seed = new SqliteMetadataStore(dbPath);
  await seed.bindings.save(makeBinding("task-1"));
  seed.close();

  const rival = spawnRival(
    `${IMPORT}
    const store = new SqliteMetadataStore(process.argv[2]);
    for (let i = 0; i < 20; i++) {
      await store.withTransaction(async () => {
        const b = await store.bindings.get('task-1');
        await store.bindings.save({ ...b, lastRunIds: [...b.lastRunIds, 'rival-' + i] });
      });
    }
    store.close();`,
    dbPath,
  );

  const store = new SqliteMetadataStore(dbPath);
  let childResult = null;
  try {
    for (let i = 0; i < 20; i++) {
      await store.withTransaction(async () => {
        const b = await store.bindings.get("task-1");
        await store.bindings.save({ ...b, lastRunIds: [...b.lastRunIds, `local-${i}`] });
      });
    }
  } finally {
    childResult = await rival.exit;
    store.close();
  }
  assert.equal(childResult.code, 0, `对手进程应正常结束: ${childResult.stderr}`);

  const check = new SqliteMetadataStore(dbPath, { timeoutMs: 5_000 });
  try {
    const final = await check.bindings.get("task-1");
    assert.equal(final.lastRunIds.length, 40, `并发后应为40条，实际 ${final.lastRunIds.length}`);
    assert.equal(new Set(final.lastRunIds).size, 40, "不得有丢失或重复写入");
  } finally {
    check.close();
  }
});

test("崩溃回滚：持有未提交写事务的进程死亡后，库可打开且未提交数据不可见", async () => {
  const root = makeRoot("crash");
  const dbPath = path.join(root, "meta.db");
  const seed = new SqliteMetadataStore(dbPath);
  await seed.bindings.save(makeBinding("task-1", { stopReason: "before-crash" }));
  seed.close();

  // 子进程在事务内写入后长睡，保证被杀时事务必然未提交。
  const victim = spawnRival(
    `${IMPORT}
    const store = new SqliteMetadataStore(process.argv[2]);
    await store.withTransaction(async () => {
      const b = await store.bindings.get('task-1');
      await store.bindings.save({ ...b, stopReason: 'crash-partial' });
      await new Promise((r) => setTimeout(r, 10_000));
    });
    console.log('unexpected-commit');`,
    dbPath,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  victim.child.kill("SIGKILL");
  const exit = await victim.exit;
  assert.equal(exit.signal, "SIGKILL", "崩溃进程被强杀");
  assert.equal(exit.stdout.includes("unexpected-commit"), false, "进程在提交前被杀");

  const recovery = new SqliteMetadataStore(dbPath, { timeoutMs: 5_000 });
  try {
    const binding = await recovery.bindings.get("task-1");
    assert.equal(binding.stopReason, "before-crash", "未提交写入必须回滚");
    await recovery.bindings.save(makeBinding("task-1", { stopReason: "recovered" }));
    assert.equal((await recovery.bindings.get("task-1")).stopReason, "recovered", "恢复后可正常写入");
  } finally {
    recovery.close();
  }
});

test("busy 冲突如实报错，不静默吞掉；释放后可写", async () => {
  const root = makeRoot("busy");
  const dbPath = path.join(root, "meta.db");
  const a = new SqliteMetadataStore(dbPath);
  await a.bindings.save(makeBinding("task-1"));
  const b = new SqliteMetadataStore(dbPath, { timeoutMs: 200 });
  const holder = new SqliteMetadataStore(dbPath);
  try {
    // 同进程第二连接持有写事务；b 的短事务在 200ms timeout 后必须报错。
    holder.db.exec("BEGIN IMMEDIATE");
    let busyError = null;
    try {
      await b.withTransaction(async () => {
        await b.bindings.save(makeBinding("task-1", { stopReason: "should-not-land" }));
      });
    } catch (error) {
      busyError = error;
    }
    assert.ok(busyError !== null, "busy 时必须抛错");
    assert.match(String(busyError.message ?? busyError), /locked/i);
    holder.db.exec("ROLLBACK");
    await b.withTransaction(async () => {
      await b.bindings.save(makeBinding("task-1", { stopReason: "after-release" }));
    });
    assert.equal((await b.bindings.get("task-1")).stopReason, "after-release");
  } finally {
    holder.close();
    a.close();
    b.close();
  }
});

test("只读路径不写库：连续读取后主库与 WAL 字节不变", async () => {
  const root = makeRoot("readonly");
  const dbPath = path.join(root, "meta.db");
  const store = new SqliteMetadataStore(dbPath);
  await store.withTransaction(async () => {
    await store.sessions.save(makeSessionRecord({ status: "available", taskId: "task-1" }));
    await store.bindings.save(makeBinding("task-1"));
  });
  const dbBefore = readFileSync(dbPath).toString("hex");
  const walBefore = readFileSync(`${dbPath}-wal`).toString("hex");

  for (let i = 0; i < 10; i++) {
    await store.sessions.get(REF);
    await store.bindings.get("task-1");
    await store.operations.get("op-x");
  }
  assert.equal(readFileSync(dbPath).toString("hex"), dbBefore, "主库文件不得因读取变化");
  assert.equal(readFileSync(`${dbPath}-wal`).toString("hex"), walBefore, "WAL 不得因读取追加");
  store.close();
});
