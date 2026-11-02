/**
 * run 接收检查点（任务018）。
 * 在改 Task／binding／scope／check 前落盘完整目标；重入按该记录幂等收敛，
 * 不重新调用模型，也不把半写入当成功。它只是操作恢复证据，不替代业务权威。
 */
import { Type, type Static } from "typebox";
import { TaskBindingSchema } from "./metadata.js";
import { CheckFileSchema, ScopeFileSchema } from "./run.js";

export const AcceptanceStateSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    phase: Type.Union([
      Type.Literal("discuss"),
      Type.Literal("implement"),
      Type.Literal("check"),
      Type.Literal("deliver"),
    ]),
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("cancelled"),
      Type.Literal("superseded"),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type AcceptanceState = Static<typeof AcceptanceStateSchema>;

export const AcceptanceJournalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    sourceTaskSha256: Type.String({ minLength: 64, maxLength: 64 }),
    inputsDigest: Type.String({ minLength: 1 }),
    standardsDigest: Type.String({ minLength: 1 }),
    effectiveInputsDigest: Type.String({ minLength: 1 }),
    source: AcceptanceStateSchema,
    target: AcceptanceStateSchema,
    bindingBefore: TaskBindingSchema,
    bindingAfter: TaskBindingSchema,
    scopeBefore: ScopeFileSchema,
    scopeAfter: ScopeFileSchema,
    check: Type.Union([CheckFileSchema, Type.Null()]),
    reason: Type.String({ minLength: 1 }),
    verdict: Type.Union([
      Type.Literal("pass"),
      Type.Literal("changes_requested"),
      Type.Literal("blocked"),
      Type.Null(),
    ]),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type AcceptanceJournal = Static<typeof AcceptanceJournalSchema>;
