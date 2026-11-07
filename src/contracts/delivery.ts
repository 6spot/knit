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

export const DeliveryMessageSourceSchema = union([lit("agent"), lit("template")]);
export type DeliveryMessageSource = Static<typeof DeliveryMessageSourceSchema>;

/** 已持久化的最终提交说明：重试复用，不随新文件静默改词。 */
export const DeliveryMessageSchema = obj(
  {
    source: DeliveryMessageSourceSchema,
    text: str({ minLength: 1 }),
  },
);
export type DeliveryMessage = Static<typeof DeliveryMessageSchema>;

export const DeliveryMessagesSchema = obj(
  {
    artifact: opt(DeliveryMessageSchema),
    metadata: opt(DeliveryMessageSchema),
    archive: opt(DeliveryMessageSchema),
  },
);
export type DeliveryMessages = Static<typeof DeliveryMessagesSchema>;

/** worktree 收尾跟进：合入与清理的步骤结果；旧记录缺省。 */
export const DeliveryWorktreeMergeSchema = obj({
  status: str({ minLength: 1 }),
  reason: union([str(), nul()]),
  opId: union([str(), nul()]),
  commit: union([str(), nul()]),
});
export type DeliveryWorktreeMerge = Static<typeof DeliveryWorktreeMergeSchema>;

export const DeliveryWorktreeCleanupSchema = obj({
  status: str({ minLength: 1 }),
  reason: union([str(), nul()]),
  opId: union([str(), nul()]),
});
export type DeliveryWorktreeCleanup = Static<typeof DeliveryWorktreeCleanupSchema>;

export const DeliveryWorktreeFollowUpSchema = obj({
  merge: opt(DeliveryWorktreeMergeSchema),
  cleanup: opt(DeliveryWorktreeCleanupSchema),
  pending: arr(union([lit("merge"), lit("cleanup")])),
});
export type DeliveryWorktreeFollowUp = Static<typeof DeliveryWorktreeFollowUpSchema>;

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
    /** 按阶段持久化的最终提交说明；旧记录没有该字段。 */
    messages: opt(DeliveryMessagesSchema),
    /** worktree 合入／清理跟进；旧记录没有该字段。 */
    worktree: opt(DeliveryWorktreeFollowUpSchema),
    steps: arr(DeliveryStepSchema),
  },
);
export type DeliveryRecord = Static<typeof DeliveryRecordSchema>;

export type DeliveryOperation = DeterministicOperation & DeliveryRecord;

export interface DeliveryCommitMessage {
  source: DeliveryMessageSource;
  subject: string;
}

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
  /** worktree 合入／清理跟进；无 worktree 或旧操作记录为 null。 */
  worktree?: DeliveryWorktreeFollowUp | null;
  /** 三类提交的文案来源与首行；旧操作记录可为 null。 */
  messages: {
    artifact: DeliveryCommitMessage | null;
    metadata: DeliveryCommitMessage | null;
    archive: DeliveryCommitMessage | null;
  };
}
