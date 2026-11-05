import { arr, bool, int, lit, map, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { UpdateKindSchema } from "./task-inputs.js";

/**
 * 任务绑定最小结构（DESIGN.md）；
 * 分支与修复计数取不到时为 null，不用零值冒充事实。
 */
export const TaskBindingSchema = obj(
  {
    taskId: str({ minLength: 1 }),
    repoRoot: str({ minLength: 1 }),
    relativePath: str({ minLength: 1 }),
    branch: union([str({ minLength: 1 }), nul()]),
    lastRunIds: arr(str({ minLength: 1 })),
    lastCheckRunId: union([str({ minLength: 1 }), nul()]),
    repairCycleId: union([str({ minLength: 1 }), nul()]),
    repairRounds: union([int({ minimum: 0 }), nul()]),
    stopReason: union([str(), nul()]),
    /** 阶段访问计数：阶段 id → 已进入次数（设计 §5.3）；旧记录缺省视为空。 */
    stageVisits: opt(map(int({ minimum: 0 }))),
    /** 最近获准实施及其冻结输入／成果；self 完成凭据的来源。 */
    lastImplement: opt(
      union([
        obj(
          {
            runId: str({ minLength: 1 }),
            inputsDigest: str({ minLength: 1 }),
            scopeDigest: str({ minLength: 1 }),
          },
        ),
        nul(),
      ]),
    ),
    /** 讨论确认时冻结的输入摘要；未确认为 null（DESIGN.md 第3.8节）。 */
    confirmedInputsDigest: union([str({ minLength: 1 }), nul()]),
    /** 讨论确认时冻结的正式规范摘要；正式规则变化据此提示检查失效（STATES.md 第8节）。 */
    confirmedStandardsDigest: union([str({ minLength: 1 }), nul()]),
    /** 按 Task 累积的成果范围；旧记录缺省视为空。条目类型／模式见 ScopeFileSchema（任务027）。 */
    scope: opt(
      arr(
        obj(
          {
            path: str({ minLength: 1 }),
            digest: union([str({ minLength: 1 }), nul()]),
            absent: bool(),
            factsKind: opt(union([lit("file"), lit("directory"), lit("link"), lit("absent")])),
            mode: opt(union([str({ minLength: 1 }), nul()])),
          },
        ),
      ),
    ),
    /** 已进入 scope 的 run；恢复不重置。 */
    scopeRunIds: opt(arr(str({ minLength: 1 }))),
    /** 至多一份待应用输入草案；kind 为空表示无草案（DESIGN.md 第3.8节）。 */
    pendingDraft: union([
      obj(
        {
          kind: UpdateKindSchema,
          reason: str({ minLength: 1 }),
          content: str(),
          /** 生成草案时的基线输入摘要；应用时核对，已变则不覆盖后来输入。 */
          baselineDigest: str({ minLength: 1 }),
          /** 含生成草案的更新操作 ID 的版本摘要（同内容重建也获得新版本）。 */
          digest: str({ minLength: 1 }),
          createdAt: str({ minLength: 1 }),
        },
      ),
      nul(),
    ]),
    /** 本机 Worktree 登记（任务 k-248eafc8fb31）；主检出 binding 主字段不变。 */
    worktree: opt(
      obj(
        {
          layout: union([lit("project"), lit("global")]),
          /** 项目内为绝对路径，project 布局同时记 relativePath 线索。 */
          path: str({ minLength: 1 }),
          relativePath: opt(str({ minLength: 1 })),
          branch: str({ minLength: 1 }),
          baseline: str({ minLength: 1 }),
          createdAt: str({ minLength: 1 }),
          registeredAt: str({ minLength: 1 }),
          /** 任务资料已完整交接并核验（任务 k-19b5cad5c106）；此后权威资料在 worktree。 */
          active: opt(bool()),
          /** 最近一次成功交接时间；binding.branch 切换随该次交接生效。 */
          handoffAt: opt(union([str({ minLength: 1 }), nul()])),
          /** 最近一次成功交接的操作 ID（transfers/<opId>/ 回执入口）。 */
          lastHandoffOp: opt(union([str({ minLength: 1 }), nul()])),
          /** 公共资料复制与环境初始化完成（任务 k-e48b7df14115）；prepare 回执位于 .runtime/worktree-prepare/<opId>/。 */
          preparedAt: opt(union([str({ minLength: 1 }), nul()])),
          /** 最近一次成功 prepare 的操作 ID（worktree-prepare/<opId>/ 回执入口）。 */
          lastPrepareOp: opt(union([str({ minLength: 1 }), nul()])),
          /** 项目／worktree 移动后最近一次成功修复时间（worktree-repair/<opId>/ 回执入口）；no-op 不写。 */
          repairedAt: opt(union([str({ minLength: 1 }), nul()])),
          /** 最近一次成功修复的操作 ID。 */
          lastRepairOp: opt(union([str({ minLength: 1 }), nul()])),
          /** 最近一次授权合入完成时间（任务 k-200ec35a4ae0）；旧记录缺省。 */
          mergedAt: opt(union([str({ minLength: 1 }), nul()])),
          /** 最近一次合入操作 ID（worktree-merge/<opId>/ 回执入口）。 */
          lastMergeOp: opt(union([str({ minLength: 1 }), nul()])),
        },
      ),
    ),
  },
);
export type TaskBinding = Static<typeof TaskBindingSchema>;

/** 确定性操作状态（STATES.md 第1节）。 */
export const OperationStateSchema = union([
  lit("planned"),
  lit("running"),
  lit("needs_attention"),
  lit("completed"),
  lit("abandoned"),
]);
export type OperationState = Static<typeof OperationStateSchema>;

/** 操作意图最小记录；kind 由调用方约定，具体步骤留在对应任务实现。 */
export const DeterministicOperationSchema = obj(
  {
    operationId: str({ minLength: 1 }),
    kind: str({ minLength: 1 }),
    state: OperationStateSchema,
    reason: opt(union([str(), nul()])),
    recordedAt: str({ minLength: 1 }),
  },
);
export type DeterministicOperation = Static<typeof DeterministicOperationSchema>;
