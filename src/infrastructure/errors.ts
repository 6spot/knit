/**
 * 基础设施错误：携带稳定错误码，应用层映射到协议 ReasonCode。
 * 不吞异常、不静默重试；busy／io_error 可在条件消失后重试。
 */
export type InfrastructureErrorCode =
  | "version_conflict"
  | "lock_busy"
  | "lock_token_mismatch"
  | "lock_owner_unknown"
  | "lock_fs_unsupported"
  | "multiple_session_locks"
  | "path_escape"
  | "git_unavailable"
  | "io_error"
  | "stage_not_in_workflow"
  | "tool_capability_unavailable"
  /** 凭据完整性校验失败（credential_tampered／credential_unsigned，见 credential-seal.ts）。 */
  | "credential_integrity";

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
