/**
 * 交付／归档操作记录（DESIGN.md 第10节、STATES.md 第11节）。
 * 意图与步骤先落盘；Git、移动与回执分别核验后再标完成。
 */
import { arr, bool, lit, map, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { OperationStateSchema, type DeterministicOperation } from "./metadata.js";

export const DeliveryModeSchema = union([lit("deliver"), lit("archive")]);
export type DeliveryMode = Static<typeof DeliveryModeSchema>;

export const DeliveryCallerSchema = union([lit("cli"), lit("agent")]);
export type DeliveryCaller = Static<typeof DeliveryCallerSchema>;

export const AuthorizationSourceSchema = obj(
  {
    kind: union([
      lit("explicit_call"),
      lit("workflow"),
      lit("user_reference"),
    ]),
    ref: union([str(), nul()]),
    path: union([str(), nul()]),
    section: union([str(), nul()]),
    digest: union([str(), nul()]),
    /** 核心只能核实来源文件／版本，不能核实人类语义；user_reference 恒 false。 */
    verified: bool(),
  },
);
export type AuthorizationSource = Static<typeof AuthorizationSourceSchema>;

export const DefaultBranchSchema = obj(
  {
    ref: union([str(), nul()]),
    source: union([lit("config"), lit("origin_head"), lit("unknown")]),
    exists: bool(),
  },
);
export type DefaultBranch = Static<typeof DefaultBranchSchema>;

export const DeliveryStepSchema = obj(
  {
    stepId: str({ minLength: 1 }),
    kind: str({ minLength: 1 }),
    state: OperationStateSchema,
    before: union([map(str()), nul()]),
    after: union([map(str()), nul()]),
    evidence: union([map(str()), nul()]),
  },
);
export type DeliveryStep = Static<typeof DeliveryStepSchema>;

export const DeliveryRecordSchema = obj(
  {
    operationId: str({ minLength: 1 }),
    kind: str({ minLength: 1 }),
    mode: DeliveryModeSchema,
    taskId: str({ minLength: 1 }),
    state: OperationStateSchema,
    reason: union([str(), nul()]),
    recordedAt: str({ minLength: 1 }),
    updatedAt: str({ minLength: 1 }),
    branch: str({ minLength: 1 }),
    caller: DeliveryCallerSchema,
    authorizationRef: union([str(), nul()]),
    authorization: AuthorizationSourceSchema,
    defaultBranch: DefaultBranchSchema,
    policyVersion: str({ minLength: 1 }),
    taskPath: str({ minLength: 1 }),
    archivePath: union([str(), nul()]),
    /** 业务产物提交；旧记录为原来的合并工作提交。 */
    workCommit: union([str(), nul()]),
    /** 任务资料提交；旧记录没有该字段，按 workCommit 的合并语义处理。 */
    metadataCommit: opt(union([str(), nul()])),
    archiveCommit: union([str(), nul()]),
    sealDigest: union([str(), nul()]),
    steps: arr(DeliveryStepSchema),
  },
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
