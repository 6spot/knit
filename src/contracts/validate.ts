import { CliResponseSchema } from "./protocol.js";
import { Value } from "typebox/value";
import { PROTOCOL_VERSION } from "./protocol.js";

/**
 * 响应收发双方的结构与版本核实；
 * 增量传输侧先经 LfFrameDecoder 切帧，再由此校验单个响应对象。
 */
export type ResponseValidation =
  | { ok: true }
  | { ok: false; reason: "incompatible_version" }
  | { ok: false; reason: "invalid_request"; problems: string[] };

export function validateCliResponse(value: unknown): ResponseValidation {
  if (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value &&
    (value as { protocolVersion?: unknown }).protocolVersion !== PROTOCOL_VERSION
  ) {
    return { ok: false, reason: "incompatible_version" };
  }
  if (Value.Check(CliResponseSchema, value)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "invalid_request",
    problems: [...Value.Errors(CliResponseSchema, value)].map(
      (e) => `${("path" in e && typeof e.path === "string" ? e.path : "") || "(root)"}: ${e.message}`,
    ),
  };
}
