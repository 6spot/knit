import test from "node:test";
import assert from "node:assert/strict";
import {
  onAdopt,
  onCheckAccepted,
  onComplete,
  onCloseWithOutcome,
  onImplementationAccepted,
  onInputsUpdated,
  onPendingResolved,
  onReady,
  onRecheckCompleted,
  onRecheckRequested,
  onRecordWritten,
  digestImpact,
  stalenessOf,
} from "../dist/domain/task.js";
import {
  demoteAfterEvent,
  isDeliverable,
  mayStartImplement,
  qualificationOf,
} from "../dist/domain/check.js";
import { mayStartRepairRound, repairDecision } from "../dist/domain/repair.js";
import { completionDecision } from "../dist/domain/completion.js";

const openDiscuss = { status: "open", phase: "discuss", outcome: null, branch: "refs/heads/main", pendingKind: null };
const openImplement = { ...openDiscuss, phase: "implement" };
const openCheck = { ...openDiscuss, phase: "check" };
const openDeliver = { ...openDiscuss, phase: "deliver" };
const closedCompleted = { status: "closed", phase: "deliver", outcome: "completed", branch: "refs/heads/main", pendingKind: null };
const closedCancelled = { status: "closed", phase: "implement", outcome: "cancelled", branch: "refs/heads/main", pendingKind: null };
const closedSuperseded = { status: "closed", phase: "check", outcome: "superseded", branch: "refs/heads/main", pendingKind: null };

/** 不变量：open 无 outcome，closed 必有 outcome（STATES.md 第3节）。 */
function assertTransitionInvariant(t) {
  if (t.status === "open") {
    assert.equal(t.outcome, null, "open 任务不得携带 outcome");
  } else {
    assert.ok(t.outcome !== null, "closed 任务必须有 outcome");
    assert.ok(["completed", "cancelled", "superseded"].includes(t.outcome));
  }
  assert.ok(["discuss", "implement", "check", "deliver"].includes(t.phase));
}

test("task ready 仅从 discuss 推进", () => {
  const ok = onReady(openDiscuss);
  assertTransitionInvariant(ok);
  assert.equal(ok.phase, "implement");
  for (const facts of [openImplement, openCheck, openDeliver]) {
    assert.deepEqual(onReady(facts), { allowed: false, reason: "phase_mismatch" });
  }
});

test("实施接受仅从 implement 推进并进入 check", () => {
  const ok = onImplementationAccepted(openImplement);
  assertTransitionInvariant(ok);
  assert.equal(ok.phase, "check");
  assert.equal(onImplementationAccepted(openCheck)?.allowed, false);
  assert.equal(onImplementationAccepted(openDeliver)?.allowed, false);
});

test("实施接受按任务验证要求分流：independent→check，self／none→deliver", () => {
  const selfTask = onImplementationAccepted({ ...openImplement, verification: "self" });
  assert.equal(selfTask.phase, "deliver");
  const noneTask = onImplementationAccepted({ ...openImplement, verification: "none" });
  assert.equal(noneTask.phase, "deliver");
  const independent = onImplementationAccepted({ ...openImplement, verification: "independent" });
  assert.equal(independent.phase, "check");
  // 旧记录缺省 independent，保持既有检查语义。
  assert.equal(onImplementationAccepted(openImplement).phase, "check");
});

test("check 接受按结论分流 pass→deliver / changes_requested→implement / blocked 保留", () => {
  const pass = onCheckAccepted(openCheck, "pass");
  assertTransitionInvariant(pass);
  assert.equal(pass.phase, "deliver");
  const changes = onCheckAccepted(openCheck, "changes_requested");
  assert.equal(changes.phase, "implement");
  const blocked = onCheckAccepted(openCheck, "blocked");
  assert.equal(blocked.phase, "check");
  assert.equal(onCheckAccepted(openImplement, "pass")?.allowed, false);
});

test("clarify 保持早期 phase；deliver 因摘要变化回 open/check", () => {
  const cases = [
    [openDiscuss, "discuss"],
    [openImplement, "implement"],
    [openCheck, "check"],
  ];
  for (const [facts, phase] of cases) {
    const t = onInputsUpdated(facts, "clarify", true);
    assertTransitionInvariant(t);
    assert.equal(t.phase, phase);
  }
  const deliverStale = onInputsUpdated(openDeliver, "clarify", true);
  assertTransitionInvariant(deliverStale);
  assert.equal(deliverStale.phase, "check");
  assert.equal(deliverStale.status, "open");
  assert.equal(onInputsUpdated({ ...openDeliver, verification: "self" }, "clarify", true).phase, "implement");
  assert.equal(onInputsUpdated({ ...openDeliver, verification: "none" }, "clarify", true).phase, "implement");
  // 摘要未变：不迁移
  const unchanged = onInputsUpdated(openDeliver, "clarify", false);
  assert.equal(unchanged.phase, "deliver");
});

test("change 回 open/discuss", () => {
  const t = onInputsUpdated(openCheck, "change", false);
  assertTransitionInvariant(t);
  assert.equal(t.phase, "discuss");
  assert.equal(t.status, "open");
});

test("待应用草案存在时阻止代码阶段与交付", () => {
  const withPending = { ...openImplement, pendingKind: "change" };
  assert.deepEqual(onImplementationAccepted(withPending), { allowed: false, reason: "pending_draft_exists" });
  assert.deepEqual(onReady(withPending), { allowed: false, reason: "pending_draft_exists" });
  assert.deepEqual(onCheckAccepted(withPending, "pass"), { allowed: false, reason: "pending_draft_exists" });
  assert.deepEqual(onRecheckRequested(withPending), { allowed: false, reason: "pending_draft_exists" });
  // 草案应用按保存的 kind 走 InputsUpdated 规则
  const applied = onPendingResolved(withPending, "change", false);
  assertTransitionInvariant(applied);
  assert.equal(applied.phase, "discuss");
});

test("取消／替代不隐式重开；completed 复查仅显式入口", () => {
  for (const [facts, reason] of [
    [closedCancelled, "outcome_cancelled"],
    [closedSuperseded, "outcome_superseded"],
  ]) {
    const refusal = { allowed: false, reason };
    assert.deepEqual(onInputsUpdated(facts, "clarify", true), refusal);
    assert.deepEqual(onInputsUpdated(facts, "change", true), refusal);
    assert.equal(onReady(facts)?.allowed, false);
    assert.equal(onImplementationAccepted(facts)?.allowed, false);
    assert.equal(onCheckAccepted(facts, "pass")?.allowed, false);
    assert.equal(onRecheckRequested(facts)?.allowed, false);
    assert.equal(onComplete(facts)?.allowed, false);
  }
  assert.equal(onReady(closedCompleted)?.allowed, false);
  // 未归档 completed 的显式复查
  const reopened = onRecheckCompleted(closedCompleted);
  assertTransitionInvariant(reopened);
  assert.equal(reopened.phase, "check");
  assert.equal(onRecheckCompleted(openCheck), null); // open 任务不是该入口
  assert.equal(onRecheckCompleted(closedCancelled)?.allowed, false);
});

test("recheck 仅 check/deliver 合法，discuss/implement 明确拒绝", () => {
  const fromCheck = onRecheckRequested(openCheck);
  assertTransitionInvariant(fromCheck);
  assert.equal(fromCheck.phase, "check");
  const fromDeliver = onRecheckRequested(openDeliver);
  assertTransitionInvariant(fromDeliver);
  assert.equal(fromDeliver.phase, "check");
  assert.deepEqual(onRecheckRequested(openDiscuss), { allowed: false, reason: "phase_mismatch" });
  assert.deepEqual(onRecheckRequested(openImplement), { allowed: false, reason: "phase_mismatch" });
});

test("业务关闭：取消／替代保留停止位置", () => {
  const done = onComplete(openDeliver);
  assertTransitionInvariant(done);
  assert.equal(done.outcome, "completed");
  const cancelled = onCloseWithOutcome(openImplement, "cancelled");
  assertTransitionInvariant(cancelled);
  assert.equal(cancelled.phase, "implement");
  const superseded = onCloseWithOutcome(openCheck, "superseded");
  assertTransitionInvariant(superseded);
  assert.equal(superseded.outcome, "superseded");
});

test("adopt 保持 discuss/implement/check，deliver 回 open/check 并清 completed", () => {
  const cases = [
    [openDiscuss, "discuss"],
    [openImplement, "implement"],
    [openCheck, "check"],
  ];
  for (const [facts, phase] of cases) {
    const t = onAdopt(facts);
    assertTransitionInvariant(t);
    assert.equal(t.phase, phase);
  }
  const deliverCompleted = { status: "closed", phase: "deliver", outcome: "completed", branch: "refs/heads/main", pendingKind: null };
  const fromDeliver = onAdopt(deliverCompleted);
  assertTransitionInvariant(fromDeliver);
  assert.equal(fromDeliver.phase, "check");
  assert.equal(fromDeliver.outcome, null);
  assert.equal(fromDeliver.status, "open");
  assert.equal(onAdopt({ ...deliverCompleted, verification: "self" }).phase, "implement");
});

test("纯记录与等价改名不使检查失效；运行引用、候选、模型用量不进摘要", () => {
  assert.equal(onRecordWritten(openCheck).phase, "check");
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
    phase: "deliver",
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
  assert.deepEqual(completionDecision({ ...base, phase: "check" }), { allowed: false, reason: "phase_mismatch" });
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
