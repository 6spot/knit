import test from "node:test";
import assert from "node:assert/strict";
import { digestImpact, isTransitionRefusal, stalenessOf, transition } from "../dist/domain/task.js";
import { DEFAULT_WORKFLOW_YAML, fallbackWorkflowDefinition, parseWorkflow } from "../dist/domain/workflow.js";
import {
  demoteAfterEvent,
  isDeliverable,
  mayStartImplement,
  qualificationOf,
} from "../dist/domain/check.js";
import { mayStartRepairRound, repairDecision } from "../dist/domain/repair.js";
import { completionDecision } from "../dist/domain/completion.js";

const workflow = parseWorkflow(DEFAULT_WORKFLOW_YAML).workflow;
const fallback = fallbackWorkflowDefinition();

const custom = parseWorkflow(
  [
    "version: 1",
    "stages:",
    "  - id: draft",
    "  - id: review",
    "    report:",
    "      verdict: [pass, changes_requested]",
    "    onVerdict:",
    "      changes_requested: draft",
    "  - id: ship",
    "",
  ].join("\n"),
).workflow;

const base = {
  status: "open",
  stage: "start",
  outcome: null,
  branch: "refs/heads/main",
  pendingKind: null,
  verification: "independent",
  visits: {},
  stopReason: null,
};

const at = (stage, extra = {}) => ({ ...base, stage, ...extra });
const stageOf = (result) => {
  assert.equal(isTransitionRefusal(result), false, JSON.stringify(result));
  return result;
};
/** 把转移结果回灌为下一次事件的事实（pendingKind 等未变化字段取基准）。 */
const next = (result) => ({ ...base, ...result });
const reasonOf = (result) => {
  assert.equal(isTransitionRefusal(result), true, JSON.stringify(result));
  return result.reason;
};

/** 不变量：open 无 outcome，closed 必有 outcome（STATES.md 第3节）。 */
function assertTransitionInvariant(t) {
  if (t.status === "open") {
    assert.equal(t.outcome, null, "open 任务不得携带 outcome");
  } else {
    assert.ok(t.outcome !== null, "closed 任务必须有 outcome");
    assert.ok(["completed", "cancelled", "superseded"].includes(t.outcome));
  }
  assert.match(t.stage, /^[a-z][a-z0-9-]{0,31}$/);
  assert.equal(typeof t.visits, "object");
}

test("task ready 从 start 进入配置的第一阶段，非 start 拒绝", () => {
  const ready = stageOf(transition(workflow, at("start"), { kind: "ready" }));
  assertTransitionInvariant(ready);
  assert.equal(ready.stage, "implement");
  assert.deepEqual(ready.visits, { implement: 1 });
  for (const stage of ["implement", "check", "deliver"]) {
    assert.equal(reasonOf(transition(workflow, at(stage), { kind: "ready" })), "phase_mismatch");
  }
  // 自定义流程：第一个阶段就是配置顺序的第一项。
  assert.equal(stageOf(transition(custom, at("start"), { kind: "ready" })).stage, "draft");
});

test("实施接受按验证要求分流：independent→下一阶段，self／none→deliver", () => {
  const independent = stageOf(transition(workflow, at("implement", { visits: { implement: 1 } }), { kind: "implementationAccepted" }));
  assertTransitionInvariant(independent);
  assert.equal(independent.stage, "check");
  assert.deepEqual(independent.visits, { implement: 1, check: 1 });
  assert.equal(
    stageOf(transition(workflow, { ...at("implement"), verification: "self" }, { kind: "implementationAccepted" })).stage,
    "deliver",
  );
  assert.equal(
    stageOf(transition(workflow, { ...at("implement"), verification: "none" }, { kind: "implementationAccepted" })).stage,
    "deliver",
  );
  // 旧记录缺省 independent，保持既有检查语义。
  assert.equal(
    stageOf(transition(workflow, { ...at("implement"), verification: undefined }, { kind: "implementationAccepted" })).stage,
    "check",
  );
  // 任意配置阶段完成都按顺序前进；最后一个阶段之后是 deliver。
  assert.equal(stageOf(transition(workflow, at("check"), { kind: "implementationAccepted" })).stage, "deliver");
  assert.equal(reasonOf(transition(workflow, at("deliver"), { kind: "implementationAccepted" })), "phase_mismatch");
});

test("阶段接受按 onVerdict 分流：pass→deliver / changes_requested→implement / blocked 留在 check", () => {
  const pass = stageOf(transition(workflow, at("check"), { kind: "stageAccepted", verdict: "pass" }));
  assertTransitionInvariant(pass);
  assert.equal(pass.stage, "deliver");
  const changes = stageOf(transition(workflow, at("check"), { kind: "stageAccepted", verdict: "changes_requested" }));
  assert.equal(changes.stage, "implement");
  assert.deepEqual(changes.visits, { implement: 1 });
  const blocked = stageOf(transition(workflow, at("check"), { kind: "stageAccepted", verdict: "blocked" }));
  assert.equal(blocked.stage, "check");
  assert.equal(reasonOf(transition(workflow, at("deliver"), { kind: "stageAccepted", verdict: "pass" })), "phase_mismatch");
  // 未知阶段值不在当前配置中：只读展示，转移拒绝。
  assert.equal(reasonOf(transition(workflow, at("review"), { kind: "stageAccepted", verdict: "pass" })), "stage_not_in_workflow");
});

test("自定义阶段顺序与回退边按配置流转", () => {
  const ready = stageOf(transition(custom, at("start"), { kind: "ready" }));
  assert.equal(ready.stage, "draft");
  const review = stageOf(transition(custom, next(ready), { kind: "stageAccepted" }));
  assert.equal(review.stage, "review");
  assert.deepEqual(review.visits, { draft: 1, review: 1 });
  // onVerdict 命中回退目标（回退边合法）。
  const back = stageOf(transition(custom, next(review), { kind: "stageAccepted", verdict: "changes_requested" }));
  assert.equal(back.stage, "draft");
  assert.deepEqual(back.visits, { draft: 2, review: 1 });
  // 未命中走顺序下一阶段。
  const ship = stageOf(transition(custom, next(review), { kind: "stageAccepted", verdict: "pass" }));
  assert.equal(ship.stage, "ship");
  const deliver = stageOf(transition(custom, next(ship), { kind: "stageAccepted" }));
  assert.equal(deliver.stage, "deliver");
  // deliver 锚点不再前进。
  assert.equal(reasonOf(transition(custom, next(deliver), { kind: "stageAccepted" })), "phase_mismatch");
});

test("回退环超过阶段 maxVisits 停止并报告 repair_round_limit，计数不再增长", () => {
  let stage = next(stageOf(transition(custom, at("start"), { kind: "ready" }))); // draft 1
  stage = next(stageOf(transition(custom, stage, { kind: "stageAccepted" }))); // review 1
  for (const round of [1, 2]) {
    stage = next(stageOf(transition(custom, stage, { kind: "stageAccepted", verdict: "changes_requested" })));
    assert.equal(stage.stage, "draft");
    assert.equal(stage.visits.draft, round + 1);
    stage = next(stageOf(transition(custom, stage, { kind: "stageAccepted" })));
    assert.equal(stage.stage, "review");
  }
  // 默认 maxVisits=2（来自 maxRepairRounds）：两轮回退后第三次回退被拒。
  const refused = transition(custom, stage, { kind: "stageAccepted", verdict: "changes_requested" });
  assert.equal(reasonOf(refused), "repair_round_limit");
  assert.equal(refused.stopReason, "repair_round_limit");
});

test("maxVisits: 0 允许首次进入但禁止回退进入", () => {
  const noLoop = parseWorkflow(
    [
      "version: 1",
      "stages:",
      "  - id: draft",
      "  - id: review",
      "    maxVisits: 0",
      "    report:",
      "      verdict: [pass, changes_requested]",
      "    onVerdict:",
      "      changes_requested: draft",
      "",
    ].join("\n"),
  ).workflow;
  const draft = next(stageOf(transition(noLoop, at("start"), { kind: "ready" })));
  const review = next(stageOf(transition(noLoop, draft, { kind: "stageAccepted" })));
  assert.equal(review.stage, "review");
  // review 的再次进入被 maxVisits=0 阻断（首次进入不计数限制）。
  assert.equal(
    reasonOf(transition(noLoop, { ...review, stage: "draft", visits: { draft: 1, review: 1 } }, { kind: "stageAccepted" })),
    "repair_round_limit",
  );
});

test("降级流程（无阶段）按 start → deliver 判定", () => {
  assert.deepEqual(fallback.stages, []);
  const ready = stageOf(transition(fallback, at("start"), { kind: "ready" }));
  assert.equal(ready.stage, "deliver");
  // 在途 run 的旧阶段值继续跑完：任意配置阶段接受都收敛到 deliver。
  assert.equal(stageOf(transition(fallback, at("implement"), { kind: "implementationAccepted" })).stage, "deliver");
  assert.equal(stageOf(transition(fallback, at("check"), { kind: "stageAccepted", verdict: "pass" })).stage, "deliver");
  assert.equal(reasonOf(transition(fallback, at("start"), { kind: "implementationAccepted" })), "phase_mismatch");
});

test("clarify 保持阶段；deliver 因摘要变化按验证要求回最后工作阶段", () => {
  const cases = ["start", "implement", "check"];
  for (const stage of cases) {
    const t = stageOf(transition(workflow, at(stage), { kind: "inputsUpdated", updateKind: "clarify", digestChanged: true }));
    assertTransitionInvariant(t);
    assert.equal(t.stage, stage);
  }
  const deliverStale = stageOf(
    transition(workflow, at("deliver"), { kind: "inputsUpdated", updateKind: "clarify", digestChanged: true }),
  );
  assertTransitionInvariant(deliverStale);
  assert.equal(deliverStale.stage, "check");
  assert.equal(deliverStale.status, "open");
  assert.equal(
    stageOf(
      transition(workflow, { ...at("deliver"), verification: "self" }, { kind: "inputsUpdated", updateKind: "clarify", digestChanged: true }),
    ).stage,
    "implement",
  );
  // self 任务回到最近访问过的工作阶段。
  const visited = stageOf(
    transition(workflow, at("deliver", { visits: { implement: 2, check: 1 }, verification: "self" }), {
      kind: "inputsUpdated",
      updateKind: "clarify",
      digestChanged: true,
    }),
  );
  assert.equal(visited.stage, "check");
  // 摘要未变：不迁移
  assert.equal(
    stageOf(transition(workflow, at("deliver"), { kind: "inputsUpdated", updateKind: "clarify", digestChanged: false })).stage,
    "deliver",
  );
});

test("change 回到 start", () => {
  const t = stageOf(transition(workflow, at("check"), { kind: "inputsUpdated", updateKind: "change", digestChanged: false }));
  assertTransitionInvariant(t);
  assert.equal(t.stage, "start");
  assert.equal(t.status, "open");
});

test("待应用草案存在时阻止代码阶段与交付", () => {
  const withPending = at("implement", { pendingKind: "change" });
  assert.equal(reasonOf(transition(workflow, withPending, { kind: "implementationAccepted" })), "pending_draft_exists");
  assert.equal(reasonOf(transition(workflow, withPending, { kind: "ready" })), "pending_draft_exists");
  assert.equal(reasonOf(transition(workflow, withPending, { kind: "stageAccepted", verdict: "pass" })), "pending_draft_exists");
  assert.equal(reasonOf(transition(workflow, withPending, { kind: "recheckRequested" })), "pending_draft_exists");
  // 草案应用按保存的 kind 走输入更新规则
  const applied = stageOf(
    transition(workflow, { ...withPending, stage: "check" }, { kind: "pendingResolved", updateKind: "change", digestChanged: false }),
  );
  assertTransitionInvariant(applied);
  assert.equal(applied.stage, "start");
});

test("取消／替代不隐式重开；completed 复查仅显式入口", () => {
  const closedCancelled = { status: "closed", stage: "implement", outcome: "cancelled", branch: "refs/heads/main", pendingKind: null, visits: {}, stopReason: null };
  const closedSuperseded = { ...closedCancelled, stage: "check", outcome: "superseded" };
  const closedCompleted = { ...closedCancelled, stage: "deliver", outcome: "completed" };
  const events = [
    { kind: "inputsUpdated", updateKind: "clarify", digestChanged: true },
    { kind: "inputsUpdated", updateKind: "change", digestChanged: true },
    { kind: "ready" },
    { kind: "implementationAccepted" },
    { kind: "stageAccepted", verdict: "pass" },
    { kind: "recheckRequested" },
    { kind: "completed" },
  ];
  for (const [facts, reason] of [
    [closedCancelled, "outcome_cancelled"],
    [closedSuperseded, "outcome_superseded"],
  ]) {
    for (const event of events) {
      assert.equal(reasonOf(transition(workflow, facts, event)), reason, JSON.stringify(event));
    }
  }
  assert.equal(reasonOf(transition(workflow, closedCompleted, { kind: "ready" })), "outcome_completed");
  // 未归档 completed 的显式复查
  const reopened = stageOf(transition(workflow, closedCompleted, { kind: "recheckCompleted" }));
  assertTransitionInvariant(reopened);
  assert.equal(reopened.stage, "check");
  assert.equal(reasonOf(transition(workflow, at("check", { status: "open" }), { kind: "recheckCompleted" })), "task_not_open");
  assert.equal(reasonOf(transition(workflow, closedCancelled, { kind: "recheckCompleted" })), "task_not_open");
});

test("recheck 仅最后阶段／deliver 合法，早期阶段明确拒绝", () => {
  const fromCheck = stageOf(transition(workflow, at("check"), { kind: "recheckRequested" }));
  assertTransitionInvariant(fromCheck);
  assert.equal(fromCheck.stage, "check");
  assert.equal(fromCheck.visits.check, 1);
  const fromDeliver = stageOf(transition(workflow, at("deliver"), { kind: "recheckRequested" }));
  assertTransitionInvariant(fromDeliver);
  assert.equal(fromDeliver.stage, "check");
  assert.equal(reasonOf(transition(workflow, at("start"), { kind: "recheckRequested" })), "phase_mismatch");
  assert.equal(reasonOf(transition(workflow, at("implement"), { kind: "recheckRequested" })), "phase_mismatch");
  // 自定义流程的复查目标是声明报告字段的检查阶段。
  assert.equal(stageOf(transition(custom, at("deliver"), { kind: "recheckRequested" })).stage, "review");
});

test("业务关闭：完成只从 deliver，取消／替代保留停止位置", () => {
  const done = stageOf(transition(workflow, at("deliver"), { kind: "completed" }));
  assertTransitionInvariant(done);
  assert.equal(done.stage, "deliver");
  assert.equal(done.outcome, "completed");
  // none 任务无需 ready：complete 事件只落业务状态，资格由 completion 层核对。
  const noneDone = stageOf(transition(workflow, at("start", { verification: "none" }), { kind: "completed" }));
  assert.equal(noneDone.status, "closed");
  assert.equal(noneDone.stage, "deliver");
  const cancelled = stageOf(transition(workflow, at("implement"), { kind: "closed", outcome: "cancelled" }));
  assertTransitionInvariant(cancelled);
  assert.equal(cancelled.stage, "implement");
  const superseded = stageOf(transition(workflow, at("check"), { kind: "closed", outcome: "superseded" }));
  assertTransitionInvariant(superseded);
  assert.equal(superseded.outcome, "superseded");
});

test("adopt 保持早期阶段，deliver 回到最后工作阶段并清 completed", () => {
  for (const stage of ["start", "implement", "check"]) {
    const t = stageOf(transition(workflow, at(stage), { kind: "adopted" }));
    assertTransitionInvariant(t);
    assert.equal(t.stage, stage);
  }
  const fromDeliver = stageOf(transition(workflow, at("deliver"), { kind: "adopted" }));
  assertTransitionInvariant(fromDeliver);
  assert.equal(fromDeliver.stage, "check");
  assert.equal(
    stageOf(transition(workflow, { ...at("deliver"), verification: "self" }, { kind: "adopted" })).stage,
    "implement",
  );
  const completed = { status: "closed", stage: "deliver", outcome: "completed", branch: "refs/heads/main", pendingKind: null, visits: {}, stopReason: null };
  const reopened = stageOf(transition(workflow, completed, { kind: "adopted" }));
  assert.equal(reopened.status, "open");
  assert.equal(reopened.outcome, null);
  assert.equal(reopened.stage, "check");
  assert.equal(reasonOf(transition(workflow, { ...completed, outcome: "cancelled" }, { kind: "adopted" })), "outcome_cancelled");
});

test("纯记录与等价改名不使检查失效；运行引用、候选、模型用量不进摘要", () => {
  const recorded = transition(workflow, at("check"), { kind: "recordWritten" });
  assert.equal(recorded.stage, "check");
  assert.equal(stalenessOf({ kind: "inputs", digestChanged: false }), null);
  assert.equal(stalenessOf({ kind: "inputs", digestChanged: true }), "stale");
  assert.equal(digestImpact({ kind: "record" }), null);
  assert.equal(digestImpact({ kind: "runReference" }), null);
  assert.equal(digestImpact({ kind: "standardsCandidate" }), null);
  assert.equal(digestImpact({ kind: "modelOrUsage" }), null);
  assert.equal(digestImpact({ kind: "rename", equivalent: true }), null);
  assert.equal(digestImpact({ kind: "rename", equivalent: false }), "stale");
  for (const source of [
    { kind: "effectiveRules" },
    { kind: "artifacts" },
    { kind: "branch" },
    { kind: "restore" },
  ]) {
    assert.equal(stalenessOf(source), "stale");
  }
});

const credential = {
  runId: "r-check-1",
  taskId: "k-abc",
  branch: "refs/heads/main",
  inputsDigest: "d1",
  scopeDigest: "s1",
  verdict: "pass",
  evidenceComplete: true,
};

const baseFacts = {
  lastCheckRunId: "r-check-1",
  lastCheckRunState: "completed",
  currentTaskId: "k-abc",
  currentBranch: "refs/heads/main",
  currentInputsDigest: "d1",
  currentScopeDigest: "s1",
  credentialAvailable: true,
};

test("无凭据或缺范围是 missing，不猜通过", () => {
  const none = qualificationOf(credential, { ...baseFacts, lastCheckRunId: null });
  assert.equal(none.qualification, "missing");
  assert.equal(isDeliverable(none), false);
  const absent = qualificationOf(credential, { ...baseFacts, credentialAvailable: false });
  assert.equal(absent.qualification, "missing");
  assert.equal(absent.allowed, true);
  // 凭据记录缺失（lastCheckRunState null）按 missing
  const noState = qualificationOf(credential, { ...baseFacts, lastCheckRunState: null });
  assert.equal(noState.qualification, "missing");
});

test("最新检查尚未结束是 pending，不能借更早 pass 收尾", () => {
  const pending = qualificationOf(credential, { ...baseFacts, lastCheckRunState: "running" });
  assert.equal(pending.qualification, "pending");
  assert.equal(isDeliverable(pending), false);
  assert.equal(mayStartImplement(pending), false);
});

test("pass 且身份／输入／成果匹配是 valid", () => {
  const valid = qualificationOf(credential, baseFacts);
  assert.equal(valid.qualification, "valid");
  assert.equal(isDeliverable(valid), true);
  assert.equal(mayStartImplement(valid), true);
});

test("changes_requested 与 blocked 是 blocked；证据缺失也是 blocked", () => {
  for (const verdict of ["changes_requested", "blocked"]) {
    const q = qualificationOf({ ...credential, verdict }, baseFacts);
    assert.equal(q.qualification, "blocked");
    assert.equal(isDeliverable(q), false);
  }
  const noEvidence = qualificationOf({ ...credential, evidenceComplete: false }, baseFacts);
  assert.equal(noEvidence.qualification, "blocked");
});

test("身份／输入／成果／分支失配是 stale", () => {
  const cases = [
    { currentTaskId: "k-other" },
    { currentBranch: "refs/heads/other" },
    { currentInputsDigest: "d2" },
    { currentScopeDigest: "s2" },
  ];
  for (const patch of cases) {
    const q = qualificationOf(credential, { ...baseFacts, ...patch });
    assert.equal(q.qualification, "stale", JSON.stringify(patch));
    assert.equal(isDeliverable(q), false);
    // stale 可以复查（获准实施／检查）
    assert.equal(mayStartImplement(q), true);
  }
});

test("候选错位与已接纳后失败不回退旧 pass 的语义", () => {
  // 传入凭据不是绑定候选：拒绝判定而不是静默通过
  const mismatch = qualificationOf({ ...credential, runId: "r-old" }, baseFacts);
  assert.deepEqual(mismatch, { allowed: false, reason: "superseded_by_newer_check" });
  // 已接纳后的检查 run 失败：无新结论，资格不得为 valid
  const failedRun = qualificationOf(credential, { ...baseFacts, lastCheckRunState: "failed" });
  assert.notEqual(failedRun.qualification, "valid");
  assert.equal(isDeliverable(failedRun), false);
});

test("事件降级只把 valid 变 stale；pending 不被事件跳过", () => {
  assert.equal(demoteAfterEvent("valid", "stale"), "stale");
  assert.equal(demoteAfterEvent("valid", null), "valid");
  assert.equal(demoteAfterEvent("pending", "stale"), "pending");
  assert.equal(demoteAfterEvent("stale", "stale"), "stale");
  assert.equal(demoteAfterEvent("blocked", "stale"), "blocked");
  assert.equal(demoteAfterEvent("missing", "stale"), "missing");
});

const repairFacts = { repairCycleId: "c1", repairRounds: 0, stopReason: null };

test("修复轮累计且上限 2 时第三轮拒绝并写 stopReason", () => {
  const r1 = repairDecision(repairFacts, { kind: "repairRoundCompleted", repairCycleId: "c1" }, 2);
  assert.equal(r1.allowed, true);
  assert.deepEqual(r1.outcome, { changed: true, repairCycleId: "c1", repairRounds: 1, stopReason: null });
  const r2 = repairDecision({ ...repairFacts, repairRounds: 1 }, { kind: "repairRoundCompleted", repairCycleId: "c1" }, 2);
  assert.deepEqual(r2.outcome, { changed: true, repairCycleId: "c1", repairRounds: 2, stopReason: null });
  const r3 = repairDecision({ ...repairFacts, repairRounds: 2 }, { kind: "repairRoundCompleted", repairCycleId: "c1" }, 2);
  assert.equal(r3.allowed, false);
  assert.equal(r3.reason, "round_limit_reached");
  assert.deepEqual(r3.outcome, { changed: true, repairCycleId: "c1", repairRounds: 2, stopReason: "repair_round_limit" });
  // 上限后不再自动开轮：stopReason 已写，具体拒绝原因是周期已停
  const blocked = mayStartRepairRound({ ...repairFacts, repairRounds: 2, stopReason: "repair_round_limit" }, 2);
  assert.deepEqual(blocked, { allowed: false, reason: "cycle_stopped" });
  // 计数达上限但 stopReason 尚未写（如并发竞态）时仍拒
  const atLimit = mayStartRepairRound({ ...repairFacts, repairRounds: 2, stopReason: null }, 2);
  assert.deepEqual(atLimit, { allowed: false, reason: "round_limit_reached" });
});

test("clarify 与 resume 不重置不累计；周期错位拒绝", () => {
  const mid = { repairCycleId: "c1", repairRounds: 1, stopReason: null };
  const clarified = repairDecision(mid, { kind: "clarified" }, 2);
  assert.deepEqual(clarified.outcome, { changed: false });
  const resumed = repairDecision(mid, { kind: "resumed" }, 2);
  assert.deepEqual(resumed.outcome, { changed: false });
  // 旧周期事件与新周期事实错位：拒绝，不污染计数。
  // 同轮重复完成事件由调用方以结果幂等接收（RunPort.acceptResult）保证不重复。
  const staleCycle = repairDecision(mid, { kind: "repairRoundCompleted", repairCycleId: "c0" }, 2);
  assert.deepEqual(staleCycle, { allowed: false, reason: "cycle_mismatch" });
  const noCycle = repairDecision({ repairCycleId: null, repairRounds: null, stopReason: null }, { kind: "repairRoundCompleted", repairCycleId: "c1" }, 2);
  assert.deepEqual(noCycle, { allowed: false, reason: "cycle_mismatch" });
});

test("停止后迟到事件不改变事实；新周期授权清零并清 stopReason", () => {
  const stopped = { repairCycleId: "c1", repairRounds: 1, stopReason: "repair_round_limit" };
  const late = repairDecision(stopped, { kind: "repairRoundCompleted", repairCycleId: "c1" }, 2);
  assert.equal(late.allowed, false);
  assert.equal(late.reason, "cycle_stopped");
  const restarted = repairDecision(stopped, { kind: "newCycleAuthorized", repairCycleId: "c2" }, 2);
  assert.deepEqual(restarted.outcome, { changed: true, repairCycleId: "c2", repairRounds: 0, stopReason: null });
  const fresh = mayStartRepairRound({ repairCycleId: "c2", repairRounds: 0, stopReason: null }, 2);
  assert.deepEqual(fresh, { allowed: true });
});

test("取消旧 run 只影响其对应周期，不暂停后来新开的周期", () => {
  const newCycle = { repairCycleId: "c2", repairRounds: 1, stopReason: null };
  // 旧周期 c1 的事件到达时事实已是 c2：不匹配即拒绝，c2 不受影响
  const stale = repairDecision(newCycle, { kind: "repairRoundCompleted", repairCycleId: "c1" }, 2);
  assert.deepEqual(stale, { allowed: false, reason: "cycle_mismatch" });
  // 对当前周期的停止仍有效
  const stop = repairDecision(newCycle, { kind: "stopped", stopReason: "user_paused" }, 2);
  assert.deepEqual(stop.outcome, { changed: true, repairCycleId: "c2", repairRounds: 1, stopReason: "user_paused" });
});

test("上限 0 与非法上限", () => {
  const zero = repairDecision(repairFacts, { kind: "repairRoundCompleted", repairCycleId: "c1" }, 0);
  assert.equal(zero.allowed, false);
  assert.equal(zero.reason, "round_limit_reached");
  assert.equal(zero.outcome?.stopReason, "repair_round_limit");
  const invalid = repairDecision(repairFacts, { kind: "repairRoundCompleted", repairCycleId: "c1" }, -1);
  assert.deepEqual(invalid, { allowed: false, reason: "max_rounds_invalid" });
  assert.deepEqual(mayStartRepairRound(repairFacts, -1), { allowed: false, reason: "max_rounds_invalid" });
});

test("完成资格：self 需要匹配的获准实施，independent 需要有效检查，none 明确记录未验证", () => {
  const base = {
    status: "open",
    stage: "deliver",
    outcome: null,
    pendingKind: null,
    verification: "self",
    confirmedInputsDigest: "in",
    currentInputsDigest: "in",
    currentScopeDigest: "scope",
    scopeCurrent: true,
    lastImplement: { runId: "run-1", inputsDigest: "in", scopeDigest: "scope" },
    checkQualification: "missing",
    checkRunId: null,
  };
  const self = completionDecision(base);
  assert.equal(self.allowed, true);
  assert.equal(self.mode, "self");
  assert.deepEqual(completionDecision({ ...base, stage: "check" }), { allowed: false, reason: "phase_mismatch" });
  assert.deepEqual(completionDecision({ ...base, lastImplement: null }), { allowed: false, reason: "implementation_missing" });
  assert.deepEqual(completionDecision({ ...base, lastImplement: { runId: "run-1", inputsDigest: "old", scopeDigest: "scope" } }), { allowed: false, reason: "implementation_stale" });
  const independent = completionDecision({ ...base, verification: "independent", checkQualification: "valid", checkRunId: "run-check" });
  assert.equal(independent.allowed, true);
  assert.equal(independent.mode, "independent");
  assert.deepEqual(completionDecision({ ...base, verification: "independent" }), { allowed: false, reason: "check_missing" });
  const none = completionDecision({ ...base, verification: "none", confirmedInputsDigest: null, lastImplement: null });
  assert.equal(none.allowed, true);
  assert.match(none.unverified[0], /verification=none/);
});
