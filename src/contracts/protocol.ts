import { Type, type Static } from "typebox";

/** 本机 metadata、run 证据、快照与占用的协议版本（OPERATIONS.md）。 */
export const PROTOCOL_VERSION = 1;
export const ProtocolVersionSchema = Type.Integer({ minimum: 1 });

/** CLI JSON 响应终态；业务待处理不是工具崩溃（ARCHITECTURE.md 第9节）。 */
export const OutcomeSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("needs_attention"),
  Type.Literal("error"),
]);
export type Outcome = Static<typeof OutcomeSchema>;

/** 错误与待处理原因；列表含“等”，允许后续按设计补充并同步映射。 */
export const ReasonCodeSchema = Type.Union([
  Type.Literal("invalid_request"),
  Type.Literal("incompatible_version"),
  Type.Literal("busy"),
  Type.Literal("needs_context"),
  Type.Literal("stale_input"),
  Type.Literal("needs_review"),
  Type.Literal("unknown_run"),
  Type.Literal("external_effect_unknown"),
  Type.Literal("io_error"),
  Type.Literal("internal_error"),
]);
export type ReasonCode = Static<typeof ReasonCodeSchema>;

/**
 * 普通 --json 输出的单响应；stdout 只写协议结果，诊断走 stderr。
 * nextActions 给桥接展示下一步，不做无条件重试。
 */
export const CliResponseSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    requestId: Type.String({ minLength: 1 }),
    outcome: OutcomeSchema,
    data: Type.Optional(Type.Unknown()),
    reasonCode: Type.Optional(ReasonCodeSchema),
    nextActions: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type CliResponse = Static<typeof CliResponseSchema>;

/**
 * 显式 --events 的 JSONL 帧；最后一条必须是终态 CliResponse。
 * 与可丢弃的诊断 JSONL 不同，这是传输协议，按 LF 切帧核实。
 */
export const ProtocolEventSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    requestId: Type.String({ minLength: 1 }),
    seq: Type.Integer({ minimum: 0 }),
    at: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    payload: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ProtocolEvent = Static<typeof ProtocolEventSchema>;
