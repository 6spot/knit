/**
 * 业务完成凭据（DESIGN §3.8、STATES §11）。
 * 完成与 Git 收尾分开：凭据只证明当时的任务目标、成果与所需验证，
 * 不表示已有提交、归档或推送。
 */
import { arr, bool, lit, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { VerificationModeSchema } from "./task-inputs.js";

export const CompletionFileSchema = obj(
  {
    schemaVersion: lit(1),
    taskId: str({ minLength: 1 }),
    verification: VerificationModeSchema,
    /** 完成时的输入区摘要（含验证要求，不含 status/phase/outcome/branch）。 */
    inputsDigest: str({ minLength: 1 }),
    /** 完成时的成果范围摘要。 */
    scopeDigest: str({ minLength: 1 }),
    /** self／independent 的实施事实来源；旧凭据缺省按 run 处理。 */
    implementedBy: opt(union([lit("run"), lit("record"), lit("forced")])),
    /** self／independent 的最近获准实施；record／forced 可为 null。 */
    implementRunId: union([str({ minLength: 1 }), nul()]),
    /** independent 的通过检查；其他模式可为 null。 */
    checkRunId: union([str({ minLength: 1 }), nul()]),
    /** 用户明确跳过的验证项；none 至少记录一条。 */
    unverified: arr(str({ minLength: 1 })),
    /** 用户强制完成：跳过完成资格证据核对，原因必填。 */
    forced: opt(bool()),
    forcedReason: opt(union([str(), nul()])),
    reason: union([str(), nul()]),
    completedAt: str({ minLength: 1 }),
  },
);
export type CompletionFile = Static<typeof CompletionFileSchema>;
