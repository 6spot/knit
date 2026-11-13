/**
 * 阶段调用边界（任务 k-28296c22647a；OPERATIONS §2.1）。
 * worker 为阶段 Pi 及其子进程注入 `KNIT_STAGE_RUN_ID=<run-id>`；核心在收尾类命令入口检测到它即拒绝，
 * 原因 `stage_context_forbidden`。它与 `KNIT_RUN` 同值但用途分开：`KNIT_RUN` 只是 `task update`
 * 缺省声明的 run，用户可在自己的终端里设置；`KNIT_STAGE_RUN_ID` 只由 worker 注入，出现即说明调用来自阶段内部。
 * 环境标记挡住阶段 Agent 的直接调用，不是沙箱：刻意清除变量绕过时，阶段内提交仍由基线核对判
 * `head_moved_during_stage`，伪造凭据由 HMAC 校验拒绝。
 */
import { GuardError } from "./guard-error.js";

export const STAGE_RUN_ENV = "KNIT_STAGE_RUN_ID";

/** 收尾类动作：交付、归档、worktree 合入／清理、业务关闭、解锁、回收与 run 接收。 */
export type StageForbiddenAction =
  | "deliver"
  | "archive"
  | "worktree merge --apply"
  | "worktree cleanup"
  | "task close"
  | "task rebind --recover"
  | "unlock"
  | "gc --apply"
  | "run accept";

/** 当前进程是否处在阶段运行环境（worker 注入的标记非空）。 */
export function stageRunIdOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[STAGE_RUN_ENV];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 阶段环境内调用收尾类命令即拒绝；不写任何文件、不取锁。 */
export function assertNotInStageContext(action: StageForbiddenAction, env: NodeJS.ProcessEnv = process.env): void {
  const runId = stageRunIdOf(env);
  if (runId === null) return;
  throw new GuardError(
    "stage_context_forbidden",
    `stage_context_forbidden: 阶段运行（${runId}）内不能执行 ${action}；收尾由主会话在阶段结束后处理`,
  );
}
