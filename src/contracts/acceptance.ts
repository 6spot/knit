/**
 * run 接收检查点（任务018）。
 * 在改 Task／binding／scope／check 前落盘完整目标；重入按该记录幂等收敛，
 * 不重新调用模型，也不把半写入当成功。它只是操作恢复证据，不替代业务权威。
 */
import { lit, nul, obj, str, union, type Static } from "@earendil-works/pi-schema";
import { TaskBindingSchema } from "./metadata.js";
import { CheckFileSchema, ScopeFileSchema } from "./run.js";

export const AcceptanceStateSchema = obj(
  {
    status: union([lit("open"), lit("closed")]),
    phase: union([
      lit("discuss"),
      lit("implement"),
      lit("check"),
      lit("deliver"),
    ]),
    outcome: union([
      lit("completed"),
      lit("cancelled"),
      lit("superseded"),
      nul(),
    ]),
  },
);
export type AcceptanceState = Static<typeof AcceptanceStateSchema>;

export const AcceptanceJournalSchema = obj(
  {
    schemaVersion: lit(1),
    operationId: str({ minLength: 1 }),
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    sourceTaskSha256: str({ minLength: 64, maxLength: 64 }),
    inputsDigest: str({ minLength: 1 }),
    standardsDigest: str({ minLength: 1 }),
    effectiveInputsDigest: str({ minLength: 1 }),
    source: AcceptanceStateSchema,
    target: AcceptanceStateSchema,
    bindingBefore: TaskBindingSchema,
    bindingAfter: TaskBindingSchema,
    scopeBefore: ScopeFileSchema,
    scopeAfter: ScopeFileSchema,
    check: union([CheckFileSchema, nul()]),
    reason: str({ minLength: 1 }),
    verdict: union([
      lit("pass"),
      lit("changes_requested"),
      lit("blocked"),
      nul(),
    ]),
    createdAt: str({ minLength: 1 }),
  },
);
export type AcceptanceJournal = Static<typeof AcceptanceJournalSchema>;
