import { Type, type Static } from "typebox";
import { UpdateKindSchema } from "./task-inputs.js";

/**
 * 任务绑定最小结构（DESIGN.md）；
 * 分支与修复计数取不到时为 null，不用零值冒充事实。
 */
export const TaskBindingSchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    repoRoot: Type.String({ minLength: 1 }),
    relativePath: Type.String({ minLength: 1 }),
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    lastRunIds: Type.Array(Type.String({ minLength: 1 })),
    lastCheckRunId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    repairCycleId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    repairRounds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    stopReason: Type.Union([Type.String(), Type.Null()]),
    /** 讨论确认时冻结的输入摘要；未确认为 null（DESIGN.md 第3.8节）。 */
    confirmedInputsDigest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 讨论确认时冻结的正式规范摘要；正式规则变化据此提示检查失效（STATES.md 第8节）。 */
    confirmedStandardsDigest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 按 Task 累积的成果范围；旧记录缺省视为空。条目类型／模式见 ScopeFileSchema（任务027）。 */
    scope: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({ minLength: 1 }),
            digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            absent: Type.Boolean(),
            factsKind: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("link"), Type.Literal("absent")])),
            mode: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    /** 已进入 scope 的 run；恢复不重置。 */
    scopeRunIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** 至多一份待应用输入草案；kind 为空表示无草案（DESIGN.md 第3.8节）。 */
    pendingDraft: Type.Union([
      Type.Object(
        {
          kind: UpdateKindSchema,
          reason: Type.String({ minLength: 1 }),
          content: Type.String(),
          /** 生成草案时的基线输入摘要；应用时核对，已变则不覆盖后来输入。 */
          baselineDigest: Type.String({ minLength: 1 }),
          /** 含生成草案的更新操作 ID 的版本摘要（同内容重建也获得新版本）。 */
          digest: Type.String({ minLength: 1 }),
          createdAt: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type TaskBinding = Static<typeof TaskBindingSchema>;

/** 确定性操作状态（STATES.md 第1节）。 */
export const OperationStateSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("running"),
  Type.Literal("needs_attention"),
  Type.Literal("completed"),
  Type.Literal("abandoned"),
]);
export type OperationState = Static<typeof OperationStateSchema>;

/** 操作意图最小记录；kind 由调用方约定，具体步骤留在对应任务实现。 */
export const DeterministicOperationSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    state: OperationStateSchema,
    reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    recordedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type DeterministicOperation = Static<typeof DeterministicOperationSchema>;
