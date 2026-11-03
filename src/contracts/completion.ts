/**
 * 业务完成凭据（DESIGN §3.8、STATES §11）。
 * 完成与 Git 收尾分开：凭据只证明当时的任务目标、成果与所需验证，
 * 不表示已有提交、归档或推送。
 */
import { arr, lit, nul, obj, str, union, type Static } from "@earendil-works/pi-schema";
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
    /** self／independent 的最近获准实施；none 可为 null。 */
    implementRunId: union([str({ minLength: 1 }), nul()]),
    /** independent 的通过检查；其他模式可为 null。 */
    checkRunId: union([str({ minLength: 1 }), nul()]),
    /** 用户明确跳过的验证项；none 至少记录一条。 */
    unverified: arr(str({ minLength: 1 })),
    reason: union([str(), nul()]),
    completedAt: str({ minLength: 1 }),
  },
);
export type CompletionFile = Static<typeof CompletionFileSchema>;
