import { arr, int, lit, obj, opt, str, union, unknown, type Static } from "@earendil-works/pi-schema";

/** 本机 metadata、run 证据、快照与占用的协议版本（OPERATIONS.md）。 */
export const PROTOCOL_VERSION = 1;
export const ProtocolVersionSchema = int({ minimum: 1 });

/** CLI JSON 响应终态；业务待处理不是工具崩溃（ARCHITECTURE.md 第9节）。 */
export const OutcomeSchema = union([
  lit("accepted"),
  lit("completed"),
  lit("blocked"),
  lit("needs_attention"),
  lit("error"),
]);
export type Outcome = Static<typeof OutcomeSchema>;

/** 错误与待处理原因；列表含“等”，允许后续按设计补充并同步映射。 */
export const ReasonCodeSchema = union([
  lit("invalid_request"),
  lit("incompatible_version"),
  lit("busy"),
  lit("needs_context"),
  lit("stale_input"),
  lit("needs_review"),
  lit("unknown_run"),
  lit("external_effect_unknown"),
  lit("io_error"),
  lit("internal_error"),
]);
export type ReasonCode = Static<typeof ReasonCodeSchema>;

/**
 * 普通 --json 输出的单响应；stdout 只写协议结果，诊断走 stderr。
 * nextActions 给桥接展示下一步，不做无条件重试。
 */
export const CliResponseSchema = obj(
  {
    protocolVersion: ProtocolVersionSchema,
    requestId: str({ minLength: 1 }),
    outcome: OutcomeSchema,
    data: opt(unknown()),
    reasonCode: opt(ReasonCodeSchema),
    nextActions: opt(arr(str())),
  },
);
export type CliResponse = Static<typeof CliResponseSchema>;

/**
 * 显式 --events 的 JSONL 帧；最后一条必须是终态 CliResponse。
 * 与可丢弃的诊断 JSONL 不同，这是传输协议，按 LF 切帧核实。
 */
export const ProtocolEventSchema = obj(
  {
    protocolVersion: ProtocolVersionSchema,
    requestId: str({ minLength: 1 }),
    seq: int({ minimum: 0 }),
    at: str({ minLength: 1 }),
    kind: str({ minLength: 1 }),
    payload: opt(unknown()),
  },
);
export type ProtocolEvent = Static<typeof ProtocolEventSchema>;
