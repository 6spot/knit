import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { CliResponseSchema, OutcomeSchema, PROTOCOL_VERSION, ReasonCodeSchema } from "../dist/contracts/protocol.js";
import { RunRequestSchema, RunResultSchema, RunStateSchema } from "../dist/contracts/run.js";
import { SessionRecordSchema, SessionStatusSchema } from "../dist/contracts/session.js";
import { TaskBindingSchema } from "../dist/contracts/metadata.js";
import { errorResponse, kindOfReason, outcomeForReason } from "../dist/contracts/errors.js";
import { validateCliResponse } from "../dist/contracts/validate.js";
import { LfFrameDecoder } from "../dist/contracts/frames.js";

const legalResponse = { protocolVersion: PROTOCOL_VERSION, requestId: "req-1", outcome: "completed" };
const encoder = new TextEncoder();

test("协议版本常量为 1", () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test("合法响应与请求通过 schema 校验", () => {
  assert.ok(Value.Check(CliResponseSchema, legalResponse));
  assert.ok(Value.Check(RunRequestSchema, { taskId: "t1", phase: "implement" }));
  assert.ok(
    Value.Check(SessionRecordSchema, {
      knitSessionId: "s-0123456789ab",
      protocolVersion: 1,
      ref: { client: "pi", nativeSessionId: "s1", role: "implement" },
      kind: "main",
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
      recordedAt: "2026-11-01T00:00:00Z",
    }),
  );
  assert.ok(
    Value.Check(TaskBindingSchema, {
      taskId: "t1",
      repoRoot: "/repo",
      relativePath: "tasks/t1.md",
      branch: null,
      lastRunIds: [],
      lastCheckRunId: null,
      repairCycleId: null,
      repairRounds: null,
      stopReason: null,
      confirmedInputsDigest: null,
      confirmedStandardsDigest: null,
      pendingDraft: null,
    }),
  );
});

test("额外字段与缺字段被拒绝", () => {
  assert.equal(Value.Check(CliResponseSchema, { ...legalResponse, extra: true }), false);
  assert.equal(Value.Check(CliResponseSchema, { protocolVersion: 1, outcome: "completed" }), false);
});

test("非法枚举被拒绝", () => {
  assert.equal(Value.Check(OutcomeSchema, "ok"), false);
  assert.equal(Value.Check(ReasonCodeSchema, "not_a_reason"), false);
  assert.equal(Value.Check(RunRequestSchema, { taskId: "t1", phase: "discuss" }), false);
  assert.equal(Value.Check(RunStateSchema, "starting"), false);
  assert.equal(Value.Check(SessionStatusSchema, "closed"), false);
});

test("终态结果 schema 拒绝非终态 run 状态", () => {
  const base = { runId: "r1", taskId: "t1", phase: "check", state: "completed", reportSummary: null };
  assert.ok(Value.Check(RunResultSchema, base));
  assert.equal(Value.Check(RunResultSchema, { ...base, state: "running" }), false);
});

test("未知协议版本被识别为 incompatible_version", () => {
  assert.deepEqual(validateCliResponse(legalResponse), { ok: true });
  assert.deepEqual(
    validateCliResponse({ ...legalResponse, protocolVersion: PROTOCOL_VERSION + 1 }),
    { ok: false, reason: "incompatible_version" },
  );
  assert.deepEqual(validateCliResponse({ ...legalResponse, protocolVersion: 0 }), {
    ok: false,
    reason: "incompatible_version",
  });
});

test("JSON 序列化往返后 schema 仍可用于核心校验", () => {
  const response = errorResponse("req-2", "busy", "执行占用被持有");
  const roundTrip = JSON.parse(new TextDecoder().decode(encoder.encode(JSON.stringify(response))));
  assert.ok(Value.Check(CliResponseSchema, roundTrip));
  assert.equal(Value.Check(CliResponseSchema, { ...roundTrip, outcome: "nope" }), false);
  const result = { runId: "r1", taskId: "t1", phase: "implement", state: "cancelled", reportSummary: null };
  const parsed = JSON.parse(JSON.stringify(result));
  assert.ok(Value.Check(RunResultSchema, parsed));
});

test("错误模式组合映射 outcome 与分类", () => {
  assert.equal(outcomeForReason("invalid_request"), "error");
  assert.equal(outcomeForReason("incompatible_version"), "error");
  assert.equal(outcomeForReason("internal_error"), "error");
  assert.equal(outcomeForReason("busy"), "blocked");
  assert.equal(outcomeForReason("io_error"), "blocked");
  assert.equal(outcomeForReason("needs_context"), "needs_attention");
  assert.equal(outcomeForReason("stale_input"), "needs_attention");
  assert.equal(outcomeForReason("needs_review"), "needs_attention");
  assert.equal(outcomeForReason("unknown_run"), "needs_attention");
  assert.equal(outcomeForReason("external_effect_unknown"), "needs_attention");
  assert.equal(kindOfReason("busy"), "transient");
  assert.equal(kindOfReason("internal_error"), "internal");
});

test("errorResponse 结构完整且可校验", () => {
  const response = errorResponse("req-3", "unknown_run", "run 不存在");
  assert.equal(response.outcome, "error");
  assert.equal(response.reasonCode, "unknown_run");
  assert.equal(response.data.message, "run 不存在");
  assert.ok(Value.Check(CliResponseSchema, response));
});

test("帧解码只按 LF 切分，不受 U+2028/U+2029 影响", () => {
  const decoder = new LfFrameDecoder();
  const frames = decoder.push(encoder.encode('{"a":1}\u2028{"b":2}\u2029{"c":3}\n{"d":4}\n'));
  assert.deepEqual(frames, ['{"a":1}\u2028{"b":2}\u2029{"c":3}', '{"d":4}']);
  assert.equal(decoder.end(), null);
});

test("多字节 UTF-8 跨块不乱码", () => {
  const decoder = new LfFrameDecoder();
  const bytes = encoder.encode('{"text":"中文内容"}\n');
  const first = decoder.push(bytes.slice(0, 10));
  const second = decoder.push(bytes.slice(10));
  assert.deepEqual(first, []);
  assert.deepEqual(second, ['{"text":"中文内容"}']);
});

test("尾部半行不作完整帧，空行被跳过", () => {
  const decoder = new LfFrameDecoder();
  assert.deepEqual(decoder.push(encoder.encode("line1\n\nline2\nhalf")), ["line1", "line2"]);
  assert.equal(decoder.end(), "half");
});
