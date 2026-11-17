import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStep, stageEntries } from "../dist/domain/progress.js";
import { parseWorkflow } from "../dist/domain/workflow.js";

const DIGEST = "sha256:now";

/** 实现、审查两个环节，审查不通过回到实现；`implement` 是加在实现环节下面的行。 */
function workflowOf(implement = []) {
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
  const workflow = workflowOf();
  assert.equal(workflow.stages[0].maxVisits, 5);

  assert.deepEqual(nextStep(workflow, "independent", rounds(6)), { kind: "limit", stage: workflow.stages[0], entries: 6 });
  assert.deepEqual(nextStep(workflow, "independent", rounds(5)), { kind: "stage", stage: workflow.stages[0] });

  // 留在原环节不判断上限：审查已经进入 7 次，blocked 之后还是审查
  const blocked = rounds(7);
  blocked.runs.at(-1).verdict = "blocked";
  assert.equal(stageEntries(blocked, "review"), 7);
  assert.deepEqual(nextStep(workflow, "independent", blocked), { kind: "stage", stage: workflow.stages[1] });
});

test("上限可以改，也可以不设", () => {
  const none = workflowOf(["    maxVisits: 0"]);
  assert.deepEqual(nextStep(none, "independent", rounds(1)), { kind: "limit", stage: none.stages[0], entries: 1 });
  // 上限是 0 也能进入第一次
  assert.deepEqual(nextStep(none, "independent", recordOf()), { kind: "stage", stage: none.stages[0] });

  const unlimited = workflowOf(["    maxVisits: null"]);
  assert.deepEqual(nextStep(unlimited, "independent", rounds(1)), { kind: "stage", stage: unlimited.stages[0] });
  assert.deepEqual(nextStep(unlimited, "independent", rounds(9)), { kind: "stage", stage: unlimited.stages[0] });

  const reconfirmed = { ...rounds(1), confirmedDigest: "sha256:later" };
  assert.equal(stageEntries(reconfirmed, "implement"), 0);
  assert.deepEqual(nextStep(none, "independent", reconfirmed), { kind: "stage", stage: none.stages[0] });
});
