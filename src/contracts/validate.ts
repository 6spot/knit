import { CliResponseSchema } from "./protocol.js";
import { checkSchema, schemaErrors } from "./schema.js";
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
  if (checkSchema(CliResponseSchema, value)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "invalid_request",
    problems: [...schemaErrors(CliResponseSchema, value)].map((e) => `${e.path || "(root)"}: ${e.message}`),
  };
}
