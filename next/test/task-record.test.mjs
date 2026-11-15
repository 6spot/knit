import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskRecord, renderTaskRecord } from "../dist/domain/task-record.js";

const runOf = (id, failure) => ({
  id,
  stage: "implement",
  startedAt: "2026-11-15T01:00:00.000Z",
  endedAt: "2026-11-15T01:10:00.000Z",
  verdict: null,
  failure,
  requirementDigest: "x",
  changedPaths: [],
  sessionFile: null,
});

test("带失败原因的记录写出再读回不变", () => {
  const record = {
    confirmedDigest: "x",
    changedPaths: [],
    runs: [runOf("r-1", "执行者启动失败：模型不存在"), runOf("r-2", null)],
    authorization: null,
  };
  const rendered = renderTaskRecord(record);
  assert.deepEqual(parseTaskRecord(rendered), { record, problems: [] });
  for (const run of JSON.parse(rendered).runs) {
    assert.deepEqual(Object.keys(run), [
      "id",
      "stage",
      "startedAt",
      "endedAt",
      "verdict",
      "failure",
      "requirementDigest",
      "changedPaths",
      "sessionFile",
    ]);
  }
});

test("缺少失败原因字段的记录读不进来", () => {
  const { failure, ...withoutFailure } = runOf("r-1", null);
  const parsed = parseTaskRecord(
    JSON.stringify({ confirmedDigest: "x", changedPaths: [], runs: [withoutFailure], authorization: null }),
  );
  assert.equal(parsed.record, null);
  assert.ok(parsed.problems.some((problem) => problem.includes("failure")), JSON.stringify(parsed.problems));
});
