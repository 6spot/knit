import assert from "node:assert/strict";
import { test } from "node:test";
import { countedRuns, nextStep } from "../dist/domain/progress.js";
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

test("不算数的执行不影响下一步", () => {
  const record = recordOf(
    runOf("implement"),
    runOf("review", { failure: "执行者中途退出" }),
    runOf("review", { endedAt: null }),
    runOf("review", { verdict: "pass", requirementDigest: "sha256:before" }),
  );
  assert.deepEqual(countedRuns(record), [record.runs[0]]);
  assert.equal(stepOf(PLAIN, "independent", record), "review");

  const changed = { ...record, confirmedDigest: "sha256:later" };
  assert.deepEqual(countedRuns(changed), []);
  assert.equal(stepOf(PLAIN, "independent", changed), "implement");
});
