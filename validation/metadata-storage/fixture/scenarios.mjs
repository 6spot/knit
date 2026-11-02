/**
 * 共享契约套件：对任一 MetadataStore 实现执行相同场景（任务004同路径比较）。
 * payload 用 src/contracts 的真实 schema 校验；版本字段是本次比较专用附加字段，
 * 不属于严格 schema，产品接入时按 DESIGN 6/7 节的投影规则另行定稿。
 */
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { RunRequestSchema, RunResultSchema, NativeEntryRangeSchema } from "../../../dist/contracts/run.js";
import { SessionRecordSchema, NativeSessionRefSchema } from "../../../dist/contracts/session.js";
import { TaskBindingSchema, DeterministicOperationSchema } from "../../../dist/contracts/metadata.js";

function checkPayload(schema, value) {
  if (Value.Check(schema, value)) return { ok: true };
  return {
    ok: false,
    errors: [...Value.Errors(schema, value)].map(
      (e) => `${"path" in e && typeof e.path === "string" ? e.path : "(root)"}: ${e.message}`,
    ),
  };
}

function makeRef(role) {
  return { client: "pi", nativeSessionId: `native-${role}-${Math.random().toString(36).slice(2, 8)}`, role };
}

function makeSessionRecord(ref, overrides = {}) {
  return {
    ref,
    status: "opening",
    taskId: "task-1",
    runId: null,
    reason: null,
    recordedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBinding(overrides = {}) {
  return {
    taskId: "task-1",
    repoRoot: "/tmp/knit-fixture",
    relativePath: "tasks/task-1.md",
    branch: "knit/task-1",
    lastRunIds: [],
    lastCheckRunId: null,
    repairCycleId: null,
    repairRounds: null,
    stopReason: null,
    ...overrides,
  };
}

function makeOperation(operationId, overrides = {}) {
  return {
    operationId,
    kind: "git_commit",
    state: "planned",
    reason: null,
    recordedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeResult(runId, state, reportSummary) {
  return { runId, taskId: "task-1", phase: "check", state, reportSummary };
}

const RUN_ID = "run-scenario";

/**
 * 场景一：接收检查结果 = 同一短事务更新 Session 关联、binding、operation；重复接收不多计。
 */
async function scenarioLinkedCommit(store, t) {
  const ref = makeRef("check");
  const runId = `${RUN_ID}-linked`;
  const opId = `op-linked-${t}`;
  const request = { taskId: "task-1", phase: "check" };
  assert.equal(checkPayload(RunRequestSchema, request).ok, true);
  await store.withTransaction(async () => {
    store.runs.create(runId, request);
    store.sessions.register(ref, { status: "opening", taskId: "task-1", runId, reason: null, recordedAt: "2026-11-01T00:00:00.000Z" });
    const binding = (await store.bindings.get("task-1")) ?? makeBinding();
    const nextRuns = binding.lastRunIds.includes(runId) ? binding.lastRunIds : [...binding.lastRunIds, runId];
    await store.bindings.save({ ...binding, lastRunIds: nextRuns, lastCheckRunId: runId });
    await store.operations.save(makeOperation(opId, { state: "running" }));
  });
  const stored = await store.sessions.get(ref);
  assert.equal(checkPayload(SessionRecordSchema, stored).ok, true, "SessionRecord 应符合 schema");
  assert.equal(stored.runId, runId);

  const first = await store.runs.acceptResult(runId, makeResult(runId, "completed", "first"));
  assert.equal(first, true, "首次接收应成功");
  const second = await store.runs.acceptResult(runId, makeResult(runId, "completed", "duplicate-should-not-apply"));
  assert.equal(second, false, "重复接收应被拒");
  const result = await store.runs.getResult(runId);
  assert.equal(checkPayload(RunResultSchema, result).ok, true, "RunResult 应符合 schema");
  assert.equal(result.reportSummary, "first", "终态只裁定一次");
  const bindingAfter = await store.bindings.get("task-1");
  assert.equal(bindingAfter.lastRunIds.filter((id) => id === runId).length, 1, "重复接收不多计 run 引用");
  await store.operations.setState(opId, "completed", "verified");
  assert.equal((await store.operations.get(opId)).state, "completed");
}

/**
 * 场景二：两进程竞争同一 binding 版本（乐观检查）。
 * 对手进程与本进程各持 expectedVersion=0 写入；拒绝方重读重试后成功。
 */
async function scenarioTwoProcessContention(store, t, spawnRival) {
  const rivalScript = `
    const { makeStore } = await import(process.argv[1] + '/store-factory.mjs');
    const store = await makeStore(process.argv[2]);
    const firstTry = await store.executeStoreTransaction(0, async (s, binding) => {
      await s.bindings.save({ ...(binding ?? { taskId: 'task-1', lastRunIds: [], branch: null, repoRoot: '/tmp/knit-fixture', relativePath: 'tasks/task-1.md', lastCheckRunId: null, repairCycleId: null, repairRounds: null, stopReason: null }), stopReason: 'rival' });
    });
    let final = firstTry;
    if (!firstTry) {
      const rebased = await store.bindings.get('task-1');
      final = await store.executeStoreTransaction(rebased?.version ?? 1, async (s, binding) => {
        await s.bindings.save({ ...(binding ?? {}), taskId: 'task-1', stopReason: 'rival' });
      });
    }
    console.log(JSON.stringify({ ok: final === true || firstTry === true }));
    await store.close();
    process.exit(0);
  `;
  const rival = await spawnRival(rivalScript, t);
  let localOk = await store.executeStoreTransaction(0, async (s, binding) => {
    await s.bindings.save({ ...(binding ?? makeBinding()), stopReason: "local" });
  });
  if (localOk !== true) {
    const rebased = await store.bindings.get("task-1");
    localOk = await store.executeStoreTransaction(rebased?.version ?? 0, async (s, binding) => {
      await s.bindings.save({ ...binding, stopReason: "local" });
    });
  }
  const rivalResult = JSON.parse((await rival.completed).stdout.trim().split("\n").at(-1));
  assert.equal(rivalResult.ok, true, "对手进程最终应写入成功");
  assert.equal(localOk, true, "本进程重试后应写入成功");
  const final = await store.bindings.get("task-1");
  assert.ok(final, "binding 必须存在");
  assert.equal(final.version, 2, `两进程各成功一次，版本应为2，实际 ${final.version}`);
  assert.ok(["local", "rival"].includes(final.stopReason), "最终 stopReason 是其中一次成功写入");
}

/**
 * 场景三：取消／完成竞争 —— 两进程同时 acceptResult，恰好一方胜出。
 */
async function scenarioCancelCompleteRace(store, t, spawnRival) {
  const runId = `${RUN_ID}-race`;
  await store.runs.create(runId, { taskId: "task-1", phase: "implement" });
  const rivalScript = `
    const { makeStore } = await import(process.argv[1] + '/store-factory.mjs');
    const store = await makeStore(process.argv[2]);
    const accepted = await store.runs.acceptResult('${runId}', {
      runId: '${runId}', taskId: 'task-1', phase: 'implement',
      state: 'cancelled', reportSummary: 'rival-cancel',
    });
    console.log(JSON.stringify({ accepted }));
    await store.close();
    process.exit(0);
  `;
  const rival = await spawnRival(rivalScript, t);
  const localAccepted = await store.runs.acceptResult(
    runId,
    makeResult(runId, "completed", "local-complete"),
  );
  const rivalResult = JSON.parse((await rival.completed).stdout.trim().split("\n").at(-1));
  assert.notEqual(localAccepted, rivalResult.accepted, "取消与完成竞争：恰好一方胜出");
  const winner = await store.runs.getResult(runId);
  assert.ok(winner, "必须有唯一胜出终态");
  assert.equal(winner.reportSummary, localAccepted ? "local-complete" : "rival-cancel");
}

/**
 * 场景四：Git 成功回执丢失 —— operation 意图先落盘，恢复时核实补记，不重复 commit。
 */
async function scenarioGitReceiptLost(store, t) {
  const opId = `op-git-${t}`;
  const operation = makeOperation(opId, { kind: "git_commit", state: "running" });
  assert.equal(checkPayload(DeterministicOperationSchema, operation).ok, true);
  await store.operations.save(operation); // 意图先落盘
  // 模拟：Git 真实提交成功，但进程在写回执前死亡。恢复方读到 running，
  // 核实外部效果（本夹具以 reason 标记替代真实 Git 核实），同 ID 幂等补记。
  const recovered = await store.operations.get(opId);
  assert.equal(recovered.state, "running");
  // 恢复流程：看到 planned/running 就核实外部效果（真实 Git 在此核对实际 OID）并同 ID 补记；
  // 已 completed 则跳过，不重复执行 Git。
  let gitCalls = 0;
  const recoverOrExecute = async () => {
    const op = await store.operations.get(opId);
    if (op !== null && (op.state === "planned" || op.state === "running")) {
      gitCalls++;
      await store.operations.save({ ...op, state: "completed", reason: "verified-external-oid" });
    }
  };
  await recoverOrExecute();
  await recoverOrExecute();
  assert.equal(gitCalls, 1, "核实补记一次，completed 后不再重复执行 Git");
  const again = await store.operations.get(opId);
  assert.equal(again.state, "completed");
  assert.equal(again.reason, "verified-external-oid");
}

/**
 * 场景五：只读查询不落盘 —— 全量读取后目录快照不变。
 */
async function scenarioReadOnly(store, t, snapshotDir) {
  const before = await snapshotDir(store.root);
  const bindings = await store.bindings.list();
  assert.ok(Array.isArray(bindings));
  await store.runs.getState(RUN_ID);
  await store.runs.getResult(RUN_ID);
  await store.entryRanges.getRange(`${RUN_ID}-range`);
  const after = await snapshotDir(store.root);
  assert.deepEqual(after, before, "只读路径不得改动任何文件");
}

/**
 * 场景六：崩溃后恢复 —— 崩溃进程的事务中止，恢复方仍能打开、写入并收敛。
 */
async function scenarioCrashRecovery(makeFreshStore, t, spawnRival) {
  const victim = await spawnRival(
    `
    const { makeStore } = await import(process.argv[1] + '/store-factory.mjs');
    const store = await makeStore(process.argv[2]);
    await store.crashInsideTransaction();
  `,
    t,
  );
  const exit = await victim.completed;
  assert.equal(exit.code, 9, "崩溃进程以注入的退出码结束");
  const store = await makeFreshStore();
  const opId = `op-crash-${t}`;
  await store.withTransaction(async () => {
    await store.operations.save(makeOperation(opId, { state: "running", reason: "recovering" }));
  });
  const op = await store.operations.get(opId);
  assert.equal(op.state, "running");
  await store.operations.setState(opId, "completed", "recovered");
  assert.equal((await store.operations.get(opId)).state, "completed");
}

/**
 * 场景七：schema 校验 —— 合法与非法 payload 双向验证（两实现共用同一校验器）。
 */
async function scenarioSchemaValidation(store, t) {
  assert.equal(checkPayload(SessionRecordSchema, makeSessionRecord(makeRef("advisory"))).ok, true);
  const badSession = { ...makeSessionRecord(makeRef("advisory")), status: "not-a-status" };
  assert.equal(checkPayload(SessionRecordSchema, badSession).ok, false, "非法状态必须被拒");
  assert.equal(checkPayload(TaskBindingSchema, makeBinding()).ok, true);
  assert.equal(checkPayload(TaskBindingSchema, makeBinding({ repairRounds: -1 })).ok, false, "负修复轮数必须被拒");
  const result = makeResult("run-x", "failed", null);
  assert.equal(checkPayload(RunResultSchema, result).ok, true);
  assert.equal(checkPayload(RunResultSchema, { ...result, state: "running" }).ok, false, "RunResult 只接受终态");
  assert.equal(checkPayload(NativeEntryRangeSchema, { startEntryId: null, leafEntryId: null }).ok, true);
}

/**
 * 场景八：原生条目范围登记与读取（可空端点如实，更新覆盖）。
 */
async function scenarioEntryRange(store, t) {
  const runId = `${RUN_ID}-range`;
  await store.runs.create(runId, { taskId: "task-1", phase: "implement" });
  await store.entryRanges.setRange(runId, { startEntryId: null, leafEntryId: null });
  const empty = await store.entryRanges.getRange(runId);
  assert.deepEqual(empty, { startEntryId: null, leafEntryId: null }, "取不到的端点如实 null");
  await store.entryRanges.setRange(runId, { startEntryId: "entry-1", leafEntryId: "entry-9" });
  const filled = await store.entryRanges.getRange(runId);
  assert.deepEqual(filled, { startEntryId: "entry-1", leafEntryId: "entry-9" });
}

/**
 * 全部场景依序执行；返回场景计数（供报告用，不参与业务守卫）。
 */
export async function runScenarios(store, t, helpers) {
  const counters = { scenarioCount: 0, txCount: 0, ioCount: 0 };
  await scenarioLinkedCommit(store, t);
  counters.txCount += 1;
  await scenarioTwoProcessContention(store, t, helpers.spawnRival);
  counters.txCount += 1;
  await scenarioCancelCompleteRace(store, t, helpers.spawnRival);
  counters.txCount += 1;
  await scenarioGitReceiptLost(store, t);
  counters.ioCount += 1;
  await scenarioReadOnly(store, t, helpers.snapshotDir);
  await scenarioCrashRecovery(helpers.makeFreshStore, t, helpers.spawnRival);
  await scenarioSchemaValidation(store, t);
  await scenarioEntryRange(store, t);
  counters.scenarioCount = 8;
  return counters;
}
