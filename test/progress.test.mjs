import assert from "node:assert/strict";
import { test } from "node:test";
import { countedRuns, dispatchLimit, lastPassedReview, nextStep, resumableRun, stageEntries } from "../dist/domain/progress.js";
import { parseWorkflow } from "../dist/domain/workflow.js";

const DIGEST = "sha256:now";

function workflowOf(lines) {
  const parsed = parseWorkflow(["version: 1", "stages:", ...lines, ""].join("\n"));
  assert.deepEqual(parsed.validation.issues, []);
  return parsed.workflow;
}

const REVIEW = ["  - id: review", "    report:", "      verdict: [pass, changes_requested, blocked]"];
const PLAIN = workflowOf(["  - id: implement", ...REVIEW]);
const JUMPING = workflowOf([
  "  - id: implement",
  ...REVIEW,
  "    onVerdict:",
  "      changes_requested: implement",
  "      blocked: review",
]);

const runOf = (stage, fields = {}) => ({
  id: `r-${stage}`,
  stage,
  startedAt: "2026-11-15T01:00:00.000Z",
  endedAt: "2026-11-15T01:10:00.000Z",
  verdict: null,
  failure: null,
  requirementDigest: DIGEST,
  changedPaths: [],
  sessionFile: null,
  ...fields,
});
const recordOf = (...runs) => ({ confirmedDigest: DIGEST, changedPaths: [], runs, authorization: null });

/** 下一步的写法：环节 id，或者 close。 */
const stepOf = (workflow, verification, record) => {
  const step = nextStep(workflow, verification, record);
  if (step.kind === "close") return "close";
  assert.equal(step.stage, workflow.stages.find((stage) => stage.id === step.stage.id));
  return step.stage.id;
};

test("按顺序往下走", () => {
  const implemented = recordOf(runOf("implement"));
  const passed = recordOf(runOf("implement"), runOf("review", { verdict: "pass" }));

  assert.equal(stepOf(PLAIN, "independent", recordOf()), "implement");
  assert.equal(stepOf(PLAIN, "independent", implemented), "review");
  assert.equal(stepOf(PLAIN, "independent", passed), "close");

  for (const verification of ["self", "none"]) {
    assert.equal(stepOf(PLAIN, verification, recordOf()), "implement");
    assert.equal(stepOf(PLAIN, verification, implemented), "close");
  }

  // 任务要走的环节一个都没有
  assert.equal(stepOf(workflowOf(REVIEW), "self", recordOf()), "close");
  // 最后一次执行的环节已经不在流程里：从头开始
  assert.equal(stepOf(PLAIN, "independent", recordOf(runOf("implement"), runOf("removed"))), "implement");
});

test("按结论跳转", () => {
  const reviewed = (verdict) => recordOf(runOf("implement"), runOf("review", { verdict }));

  assert.equal(stepOf(JUMPING, "independent", reviewed("changes_requested")), "implement");
  assert.equal(stepOf(JUMPING, "independent", reviewed("blocked")), "review");
  // 没有写去向的结论按顺序走
  assert.equal(stepOf(JUMPING, "independent", reviewed("pass")), "close");
  // 去向按全部环节找：不走审查环节的任务也跟着结论走
  assert.equal(stepOf(JUMPING, "self", reviewed("blocked")), "review");

  const toDeliver = workflowOf([
    "  - id: triage",
    "    report:",
    "      outcome: [skip, go]",
    "    onVerdict:",
    "      skip: deliver",
    "  - id: implement",
  ]);
  assert.equal(stepOf(toDeliver, "independent", recordOf(runOf("triage", { verdict: "skip" }))), "close");
  assert.equal(stepOf(toDeliver, "independent", recordOf(runOf("triage", { verdict: "go" }))), "implement");
});

test("未结束批次在重新确认需求或删除环节后仍在跑，无结论环节按全员执行结果推进", () => {
  const workflow = workflowOf([
    "  - id: check", "    tools: [read]", "    executors: [{id: a}, {id: b}]", "    report: {note: string}",
    "  - id: implement",
  ]);
  const record = recordOf(
    runOf("check", { id: "r-a", executor: "a", batchId: "b-1", verdict: "pass" }),
    runOf("check", { id: "r-b", executor: "b", batchId: "b-1", endedAt: null }),
  );
  const changed = { ...record, confirmedDigest: "sha256:later" };
  assert.deepEqual(nextStep(workflow, "independent", changed), { kind: "running", stage: workflow.stages[0] });
  assert.deepEqual(nextStep(PLAIN, "independent", changed), { kind: "running", stage: { id: "check" } });
  record.runs[1].endedAt = record.runs[0].endedAt;
  assert.deepEqual(nextStep(workflow, "independent", record), { kind: "stage", stage: workflow.stages[1] });
  record.runs[1].failure = "执行失败";
  assert.equal(nextStep(workflow, "independent", record).kind, "arbitrate");
});

test("批次全员通过按顺序推进，修改流程后仍须裁决已入账的分歧", () => {
  const workflow = workflowOf([...REVIEW, "    tools: [read]", "    executors: [{id: a}, {id: b}]",
    "    onVerdict: {pass: deliver}", "  - id: assemble"]);
  const record = recordOf(
    runOf("review", { id: "r-a", batchId: "b-1", verdict: "pass", endedAt: "2026-11-15T01:15:00.000Z" }),
    runOf("review", { id: "r-b", batchId: "b-1", verdict: "pass" }),
  );
  assert.equal(stepOf(workflow, "independent", record), "assemble");
  assert.equal(lastPassedReview(record).id, "r-a");
  record.runs[1].verdict = "changes_requested";
  for (const updated of [workflow, workflowOf(["  - id: review"]), workflowOf(["  - id: implement"])]) {
    const step = nextStep(updated, "independent", record);
    assert.equal(step.kind, "arbitrate");
    assert.deepEqual(step.reports.map(({ run }) => run.id), ["r-a", "r-b"]);
  }
  assert.equal(lastPassedReview(record), undefined);
});

test("不算数的执行不影响下一步", () => {
  const record = recordOf(
    runOf("implement"),
    runOf("review", { failure: "执行者中途退出" }),
    runOf("review", { endedAt: null }),
    runOf("review", { verdict: "pass", requirementDigest: "sha256:before" }),
  );
  assert.deepEqual(countedRuns(record), [record.runs[0]]);
  assert.deepEqual(nextStep(PLAIN, "independent", record), { kind: "stage", stage: PLAIN.stages[1] });
  assert.deepEqual(nextStep(PLAIN, "independent", recordOf(runOf("review", { endedAt: null }))),
    { kind: "stage", stage: PLAIN.stages[0] });

  const changed = { ...record, confirmedDigest: "sha256:later" };
  assert.deepEqual(countedRuns(changed), []);
  assert.equal(stepOf(PLAIN, "independent", changed), "implement");
});

/** 实现、审查两个环节，审查不通过回到实现；`implement` 是加在实现环节下面的行。 */
function repairWorkflow(implement = []) {
  const parsed = parseWorkflow(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      ...implement,
      "  - id: review",
      "    report:",
      "      verdict: [pass, changes_requested, blocked]",
      "    onVerdict:",
      "      changes_requested: implement",
      "      blocked: review",
      "",
    ].join("\n"),
  );
  assert.deepEqual(parsed.validation.issues, []);
  return parsed.workflow;
}
/** 实现、审查交替各做 `rounds` 次，每次审查的结论都是 changes_requested。 */
const rounds = (count) =>
  recordOf(...Array.from({ length: count }, () => [runOf("implement"), runOf("review", { verdict: "changes_requested" })]).flat());

test("留在原环节和失败后重做不算新的进入", () => {
  const record = recordOf(
    runOf("implement"),
    runOf("review", { verdict: "blocked" }),
    runOf("review", { verdict: "changes_requested" }),
    runOf("implement", { failure: "执行者中途退出" }),
    runOf("implement"),
  );
  assert.equal(stageEntries(record, "implement"), 2);
  assert.equal(stageEntries(record, "review"), 1);
  assert.equal(stageEntries(record, "deploy"), 0);
  assert.equal(stageEntries(recordOf(), "implement"), 0);
});

test("到上限时返回 limit", () => {
  const workflow = repairWorkflow();
  assert.equal(workflow.stages[0].maxVisits, 5);

  assert.deepEqual(nextStep(workflow, "independent", rounds(6)), { kind: "limit", stage: workflow.stages[0], entries: 6 });
  assert.deepEqual(nextStep(workflow, "independent", rounds(5)), { kind: "stage", stage: workflow.stages[0] });

  // 留在原环节不判断上限：审查已经进入 7 次，blocked 之后还是审查
  const blocked = rounds(7);
  blocked.runs.at(-1).verdict = "blocked";
  assert.equal(stageEntries(blocked, "review"), 7);
  assert.deepEqual(nextStep(workflow, "independent", blocked), { kind: "stage", stage: workflow.stages[1] });
});

test("续聊按需求、环节、执行器和 Agent 匹配，不依赖成功计数", () => {
  const target = { stage: "implement", agent: "pi" };
  const success = runOf("implement", { resumeId: "old" });
  const failure = runOf("implement", { resumeId: "latest", failure: "执行者出错：HTTP 429" });
  const unrelated = [
    runOf("review", { resumeId: "other-stage" }),
    runOf("implement", { resumeId: "other-executor", executor: "a" }),
    runOf("implement", { resumeId: "other-agent", agent: "antigravity" }),
    runOf("implement", { resumeId: "other-digest", requirementDigest: "old" }),
    runOf("implement", { resumeId: "running", endedAt: null }),
    runOf("implement", { resumeId: null }),
    runOf("implement", { resumeId: "" }),
  ];
  assert.equal(resumableRun(recordOf(success, failure, ...unrelated), target), failure);
  assert.equal(resumableRun(recordOf(...unrelated), target), undefined);
  assert.equal(resumableRun(recordOf(...unrelated), { ...target, executor: "a" }), unrelated[1]);
  assert.equal(resumableRun(recordOf(...unrelated), { ...target, agent: "antigravity" }), unrelated[2]);
  for (const reason of ["报告读不出来：格式错误", "执行者中途退出", "执行者被中止", "已取消", null]) {
    const latest = { ...failure, failure: reason };
    assert.equal(resumableRun(recordOf(success, latest), target), latest);
  }
  for (const reason of ["执行者提交了改动：HEAD 从 abc 变成 def", "执行者改了受保护的文件：.knit/config.json",
    "执行清理失败：无法删除临时文件", "执行者出错：HTTP 429；执行清理失败：无法删除临时文件",
    "执行者出错：HTTP 429；执行者提交了改动：HEAD 从 abc 变成 def"]) {
    for (const resumeId of [null, success.resumeId, "different"]) {
      assert.equal(resumableRun(recordOf(success, { ...failure, failure: reason, resumeId }), target), undefined, reason);
    }
  }
});

test("连续失败的审查续聊不消耗返工次数，也不提前通过", () => {
  const workflow = workflowOf(["  - id: implement", ...REVIEW, "    maxVisits: 0"]);
  const implement = runOf("implement");
  const target = { stage: "review", agent: "pi" };
  const failed = ["执行者出错：HTTP 429", "报告读不出来：缺少 json"].map((failure) => runOf("review", { failure, resumeId: "same" }));
  for (const count of [1, 2]) {
    const record = recordOf(implement, ...failed.slice(0, count));
    assert.equal(resumableRun(record, target), failed[count - 1]);
    assert.deepEqual(countedRuns(record), [implement]);
    assert.equal(stageEntries(record, "review"), 0);
    assert.equal(dispatchLimit(record, workflow.stages[1], "implement"), null);
    assert.equal(stepOf(workflow, "independent", record), "review");
    assert.equal(lastPassedReview(record), undefined);
  }
  const pass = runOf("review", { verdict: "pass", resumeId: "same" });
  const record = recordOf(implement, ...failed, pass);
  assert.deepEqual(countedRuns(record), [implement, pass]);
  assert.equal(stageEntries(record, "review"), 1);
  assert.equal(stepOf(workflow, "independent", record), "close");
  assert.equal(lastPassedReview(record), pass);
});

test("上限可以改，也可以不设", () => {
  const none = repairWorkflow(["    maxVisits: 0"]);
  assert.deepEqual(nextStep(none, "independent", rounds(1)), { kind: "limit", stage: none.stages[0], entries: 1 });
  // 上限是 0 也能进入第一次
  assert.deepEqual(nextStep(none, "independent", recordOf()), { kind: "stage", stage: none.stages[0] });

  const unlimited = repairWorkflow(["    maxVisits: null"]);
  assert.deepEqual(nextStep(unlimited, "independent", rounds(1)), { kind: "stage", stage: unlimited.stages[0] });
  assert.deepEqual(nextStep(unlimited, "independent", rounds(9)), { kind: "stage", stage: unlimited.stages[0] });

  const reconfirmed = { ...rounds(1), confirmedDigest: "sha256:later" };
  assert.equal(stageEntries(reconfirmed, "implement"), 0);
  assert.deepEqual(nextStep(none, "independent", reconfirmed), { kind: "stage", stage: none.stages[0] });
});
