/**
 * 阶段 Session 恢复与兜底（DESIGN.md 9.4）。
 * prefer：优先恢复原生会话；原记录缺失／损坏／不兼容时，
 * 同客户端预分配新原生 ID 新建会话从任务资料续做。
 * 旧引用与原因保留；不重置任务阶段／修复次数／scope（那是核心的职责）。
 */
import { randomUUID } from "node:crypto";
import { checkNativeSessionFile, type NativeFileCheck } from "./native-file.js";
import type { PiRuntimeOptions } from "./runtime.js";
import { PiAgentRuntime } from "./runtime.js";

export type ResumeDecision =
  | { action: "resume"; nativeSessionId: string; sessionFile: string; check: NativeFileCheck }
  | { action: "create_new"; nativeSessionId: string; reason: string; check: NativeFileCheck | null };

/**
 * 恢复预检：文件存在、身份一致才允许 --session 恢复。
 * CLI 对不存在路径可能成功打开空会话（实测限制1），因此必须先做本检查。
 */
export async function decideResume(
  expectedNativeId: string,
  sessionFile: string | null,
): Promise<ResumeDecision> {
  if (sessionFile === null || sessionFile === "") {
    return {
      action: "create_new",
      nativeSessionId: randomUUID(),
      reason: "no_session_file_recorded",
      check: null,
    };
  }
  const check = await checkNativeSessionFile(sessionFile, expectedNativeId);
  if (check.exists && check.problem === null) {
    return { action: "resume", nativeSessionId: expectedNativeId, sessionFile, check };
  }
  const reason =
    check.problem === null
      ? "session_file_missing"
      : `session_file_${check.problem}`;
  return { action: "create_new", nativeSessionId: randomUUID(), reason, check };
}

export interface ResumeLaunch {
  runtime: PiAgentRuntime;
  decision: ResumeDecision;
}

/** 按决策构造启动参数：resume 用原文件，create_new 用预分配新 ID。 */
export function buildRuntimeOptions(
  base: PiRuntimeOptions,
  decision: ResumeDecision,
): PiRuntimeOptions {
  if (decision.action === "resume") {
    return { ...base, sessionId: decision.nativeSessionId, sessionFile: decision.sessionFile };
  }
  return { ...base, sessionId: decision.nativeSessionId, sessionFile: undefined };
}
