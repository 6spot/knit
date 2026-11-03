/**
 * 交付／归档操作记录（DESIGN.md 第10节、STATES.md 第11节）。
 * 意图与步骤先落盘；Git、移动与回执分别核验后再标完成。
 */
import { Type, type Static } from "typebox";
import { OperationStateSchema, type DeterministicOperation } from "./metadata.js";

export const DeliveryModeSchema = Type.Union([Type.Literal("deliver"), Type.Literal("archive")]);
export type DeliveryMode = Static<typeof DeliveryModeSchema>;

export const DeliveryCallerSchema = Type.Union([Type.Literal("cli"), Type.Literal("agent")]);
export type DeliveryCaller = Static<typeof DeliveryCallerSchema>;

export const AuthorizationSourceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("explicit_call"),
      Type.Literal("workflow"),
      Type.Literal("user_reference"),
    ]),
    ref: Type.Union([Type.String(), Type.Null()]),
    path: Type.Union([Type.String(), Type.Null()]),
    section: Type.Union([Type.String(), Type.Null()]),
    digest: Type.Union([Type.String(), Type.Null()]),
    /** 核心只能核实来源文件／版本，不能核实人类语义；user_reference 恒 false。 */
    verified: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AuthorizationSource = Static<typeof AuthorizationSourceSchema>;

export const DefaultBranchSchema = Type.Object(
  {
    ref: Type.Union([Type.String(), Type.Null()]),
    source: Type.Union([Type.Literal("config"), Type.Literal("origin_head"), Type.Literal("unknown")]),
    exists: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type DefaultBranch = Static<typeof DefaultBranchSchema>;

export const DeliveryStepSchema = Type.Object(
  {
    stepId: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    state: OperationStateSchema,
    before: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
    after: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
    evidence: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
  },
  { additionalProperties: false },
);
export type DeliveryStep = Static<typeof DeliveryStepSchema>;

export const DeliveryRecordSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    mode: DeliveryModeSchema,
    taskId: Type.String({ minLength: 1 }),
    state: OperationStateSchema,
    reason: Type.Union([Type.String(), Type.Null()]),
    recordedAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    branch: Type.String({ minLength: 1 }),
    caller: DeliveryCallerSchema,
    authorizationRef: Type.Union([Type.String(), Type.Null()]),
    authorization: AuthorizationSourceSchema,
    defaultBranch: DefaultBranchSchema,
    policyVersion: Type.String({ minLength: 1 }),
    taskPath: Type.String({ minLength: 1 }),
    archivePath: Type.Union([Type.String(), Type.Null()]),
    /** 业务产物提交；旧记录为原来的合并工作提交。 */
    workCommit: Type.Union([Type.String(), Type.Null()]),
    /** 任务资料提交；旧记录没有该字段，按 workCommit 的合并语义处理。 */
    metadataCommit: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    archiveCommit: Type.Union([Type.String(), Type.Null()]),
    sealDigest: Type.Union([Type.String(), Type.Null()]),
    steps: Type.Array(DeliveryStepSchema),
  },
  { additionalProperties: false },
);
export type DeliveryRecord = Static<typeof DeliveryRecordSchema>;

export type DeliveryOperation = DeterministicOperation & DeliveryRecord;

export interface DeliveryResult {
  operationId: string;
  taskId: string;
  mode: DeliveryMode;
  state: string;
  reason: string | null;
  branch: string;
  workCommit: string | null;
  metadataCommit: string | null;
  archiveCommit: string | null;
  archivePath: string | null;
  defaultBranch: DefaultBranch;
  authorization: AuthorizationSource;
  needsAttention: boolean;
}
