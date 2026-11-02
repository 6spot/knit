import type { CliResponse, Outcome, ReasonCode } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

/**
 * 原因码的处理分类；业务流程按此选择展示与重试策略。
 * invalid_request／incompatible_version／internal_error 属请求或实现错误，
 * busy／io_error 可在条件消失后重试，其余需要对应处理流程而不是盲目重试。
 */
export type ReasonKind = "request" | "transient" | "process" | "internal";

const REASON_KIND: Record<ReasonCode, ReasonKind> = {
  invalid_request: "request",
  incompatible_version: "request",
  busy: "transient",
  io_error: "transient",
  needs_context: "process",
  stale_input: "process",
  needs_review: "process",
  unknown_run: "process",
  external_effect_unknown: "process",
  internal_error: "internal",
};

export function kindOfReason(reason: ReasonCode): ReasonKind {
  return REASON_KIND[reason];
}

/** reasonCode 到默认 outcome 的映射；调用方可据业务事实改用别的 outcome，但必须显式。 */
export function outcomeForReason(reason: ReasonCode): Outcome {
  switch (REASON_KIND[reason]) {
    case "request":
    case "internal":
      return "error";
    case "transient":
      return "blocked";
    case "process":
      return "needs_attention";
  }
}

export function errorResponse(requestId: string, reason: ReasonCode, message: string): CliResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    outcome: "error",
    reasonCode: reason,
    data: { message },
  };
}
