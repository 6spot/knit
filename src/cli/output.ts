/** CLI 输出格式化：人类可读为主，--json 输出协议响应（stdout 只写协议结果）。 */
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import type { CliResponse, Outcome, ReasonCode } from "../contracts/protocol.js";
import { GuardError } from "../application/guard-error.js";

export function jsonResponse(requestId: string, outcome: Outcome, data?: unknown, reasonCode?: ReasonCode, nextActions?: string[]): CliResponse {
  const response: CliResponse = { protocolVersion: PROTOCOL_VERSION, requestId, outcome };
  if (data !== undefined) response.data = data;
  if (reasonCode !== undefined) response.reasonCode = reasonCode;
  if (nextActions !== undefined) response.nextActions = nextActions;
  return response;
}

export function emit(response: CliResponse): void {
  process.stdout.write(JSON.stringify(response, null, 2) + "\n");
}

/** 应用层错误到协议 reasonCode 的映射（应用层唯一映射点）。 */
export function reasonForError(error: unknown): ReasonCode {
  if (error instanceof GuardError) {
    const guard = String(error.details?.guardReason ?? "");
    if (guard === "task_busy" || guard === "workspace_busy") return guard;
    if (
      guard === "pending_draft_exists" ||
      guard === "no_pending_draft" ||
      guard === "runs_unsettled" ||
      guard === "check_not_passed" ||
      guard === "standards_review_required" ||
      guard === "standards_apply_required" ||
      guard === "authorization_changed" ||
      guard === "policy_changed"
    ) {
      return "needs_review";
    }
    if (guard === "external_effect_unknown") return "external_effect_unknown";
    if (
      guard.startsWith("hook_") ||
      guard === "git_failed" ||
      guard === "git_commit_failed" ||
      guard === "archive_commit_failed" ||
      guard === "commit_scope_mismatch" ||
      guard === "archive_scope_mismatch" ||
      guard === "commit_parent_mismatch" ||
      guard === "archive_parent_mismatch" ||
      guard === "commit_message_mismatch" ||
      guard === "commit_not_created" ||
      guard === "archive_commit_not_created" ||
      guard === "step_effect_missing" ||
      guard === "archive_target_exists" ||
      guard === "archive_move_unknown" ||
      guard === "archive_target_missing" ||
      guard === "archive_path_missing"
    ) {
      return "external_effect_unknown";
    }
    if (guard === "check_stale" || guard === "stale_scope" || guard === "stale_input" || guard === "branch_changed" || guard === "repo_mismatch") {
      return "stale_input";
    }
    if (
      guard === "worktree_mismatch" ||
      guard === "worktree_invalid" ||
      guard === "worktree_not_ready" ||
      guard === "worktree_dirty_source" ||
      guard === "worktree_merge_required" ||
      guard === "execution_dir_mismatch" ||
      guard === "git_occupied" ||
      guard === "path_occupied" ||
      guard === "branch_mismatch" ||
      guard === "task_archived" ||
      guard === "unknown_binding" ||
      guard === "gitignore_rule_unavailable" ||
      guard === "handoff_conflict" ||
      guard === "handoff_backup_corrupt" ||
      guard === "prepare_conflict" ||
      guard === "prepare_path_escape" ||
      guard === "prepare_step_failed" ||
      guard === "prepare_state_mismatch"
    ) {
      return "needs_review";
    }
    if (
      guard === "snapshot_not_ready" ||
      guard === "snapshot_index_unavailable" ||
      guard === "snapshot_baseline_unavailable" ||
      guard === "remove_created_required" ||
      guard === "unsupported_path" ||
      guard === "task_closed" ||
      guard === "task_not_managed"
    ) {
      return "needs_review";
    }
    // 请求事实不成立／身份冲突：参数错误，不按需人工复核处理。
    return "invalid_request";
  }
  const code = (error as { code?: string })?.code;
  switch (code) {
    case "version_conflict":
      // 草案／基线不匹配语义上是 stale_input；文件版本冲突是旧基线 incompatible_version。
      return (error as { details?: { guardReason?: string } }).details?.guardReason === "stale_input" ? "stale_input" : "incompatible_version";
    case "lock_busy":
      return "busy";
    case "path_escape":
    case "multiple_session_locks":
      return "invalid_request";
    case "git_unavailable":
    case "lock_token_mismatch":
    case "lock_owner_unknown":
    case "lock_fs_unsupported":
      return "needs_review";
    case "io_error":
    default:
      return "io_error";
  }
}

export function outcomeForError(error: unknown): Outcome {
  const reason = reasonForError(error);
  if (reason === "busy" || reason === "task_busy" || reason === "workspace_busy" || reason === "io_error") return "blocked";
  if (reason === "external_effect_unknown") return "needs_attention";
  return "error";
}

/** 人类可读计划行；--force 预览的覆盖项显式标为“覆盖”。 */
export function formatPlanItem(item: { path: string; action: string; reason: string; overwrite?: boolean }): string {
  const actionLabel: Record<string, string> = {
    create: "创建",
    keep: "沿用",
    update: "更新",
    conflict: "冲突",
  };
  const label = item.overwrite ? "覆盖" : (actionLabel[item.action] ?? item.action);
  return `  ${label}  ${item.path}  — ${item.reason}`;
}
