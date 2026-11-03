/**
 * 业务完成凭据（DESIGN §3.8、STATES §11）。
 * 完成与 Git 收尾分开：凭据只证明当时的任务目标、成果与所需验证，
 * 不表示已有提交、归档或推送。
 */
import { Type, type Static } from "typebox";
import { VerificationModeSchema } from "./task-inputs.js";

export const CompletionFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: Type.String({ minLength: 1 }),
    verification: VerificationModeSchema,
    /** 完成时的输入区摘要（含验证要求，不含 status/phase/outcome/branch）。 */
    inputsDigest: Type.String({ minLength: 1 }),
    /** 完成时的成果范围摘要。 */
    scopeDigest: Type.String({ minLength: 1 }),
    /** self／independent 的最近获准实施；none 可为 null。 */
    implementRunId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** independent 的通过检查；其他模式可为 null。 */
    checkRunId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 用户明确跳过的验证项；none 至少记录一条。 */
    unverified: Type.Array(Type.String({ minLength: 1 })),
    reason: Type.Union([Type.String(), Type.Null()]),
    completedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CompletionFile = Static<typeof CompletionFileSchema>;
