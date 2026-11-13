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

/**
 * 调用路径：bridge＝桥接带本会话原生记录调用（`user:` 引用已按真实用户消息核对）；
 * cli-unverified＝直接 CLI 调用，授权声明未经会话核对（DESIGN §10.1）。旧记录缺省按 cli-unverified。
 */
export const DeliveryInvocationSchema = union([lit("bridge"), lit("cli-unverified")]);
export type DeliveryInvocation = Static<typeof DeliveryInvocationSchema>;

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
    /**
     * 核心只能核实来源文件／版本或消息存在，不能核实人类语义。
     * user_reference 仅在桥接路径按本会话真实用户消息核对通过时为 true（path／section／digest 记会话文件、条目 ID 与正文摘要）。
     */
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
    /** 调用路径；旧记录缺省按 cli-unverified。 */
    invocation: opt(DeliveryInvocationSchema),
    defaultBranch: DefaultBranchSchema,
    policyVersion: str({ minLength: 1 }),
    /** 显式策略复核的追加历史；旧策略和授权不丢失。 */
    policyRecoveries: opt(arr(obj({
      previousPolicy: str({ minLength: 1 }),
      currentPolicy: str({ minLength: 1 }),
      authorization: AuthorizationSourceSchema,
      branch: str({ minLength: 1 }),
      recordedAt: str({ minLength: 1 }),
      verifiedCommits: arr(str({ minLength: 1 })),
    }))),
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
  /** 回执中的调用路径：直接 CLI 为 cli-unverified，桥接为 bridge。 */
  caller: DeliveryInvocation;
  /** 交付提交的 hooks 策略与自上次交付以来新增或修改的 hook；旧结果缺省。 */
  hooks?: {
    mode: "skip" | "run";
    dir: string | null;
    baseline: "recorded" | "none" | "invalid";
    changes: Array<{ name: string; change: "added" | "modified" }>;
  };
  needsAttention: boolean;
  /** worktree 合入／清理跟进；无 worktree 或旧操作记录为 null。 */
  worktree?: DeliveryWorktreeFollowUp | null;
  /**
   * 正常交付已完成但没有产物提交（workCommit 为空）；与 noArtifactReason／noArtifactNotice 一起
   * 区分“声明无产物”“成果路径已无待提交改动”等情况（审计 F4）。其它情况为 false。
   */
  noArtifactCommit?: boolean;
  /** 完成凭据中的原因（声明无产物、强制或完成说明）；无产物提交时才给出。 */
  noArtifactReason?: string | null;
  /** 人读提示“本次交付没有产物提交…”；有产物提交时为 null。 */
  noArtifactNotice?: string | null;
  /** 三类提交的文案来源与首行；旧操作记录可为 null。 */
  messages: {
    artifact: DeliveryCommitMessage | null;
    metadata: DeliveryCommitMessage | null;
    archive: DeliveryCommitMessage | null;
  };
}
