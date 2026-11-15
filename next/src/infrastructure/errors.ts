/**
 * 基础设施错误：携带稳定错误码，调用方按错误码决定怎么报告。
 * 不吞异常、不静默重试。
 */
export type InfrastructureErrorCode = "version_conflict" | "path_escape";

export class InfrastructureError extends Error {
  constructor(
    readonly code: InfrastructureErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InfrastructureError";
  }
}
