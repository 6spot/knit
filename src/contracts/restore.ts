import { Type, type Static } from "typebox";

/** 单路径恢复预览：只描述计划，不携带文件正文或疑似凭据。 */
export const RestorePathStateSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("absent"),
      Type.Literal("file"),
      Type.Literal("symlink"),
      Type.Literal("directory"),
      Type.Literal("submodule"),
      Type.Literal("other"),
    ]),
    fingerprint: Type.String({ minLength: 1 }),
    mode: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    size: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RestorePathState = Static<typeof RestorePathStateSchema>;

export const RestoreIndexStateSchema = Type.Object(
  {
    present: Type.Boolean(),
    mode: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    oid: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RestoreIndexState = Static<typeof RestoreIndexStateSchema>;

export const RestoreActionSchema = Type.Union([
  Type.Literal("restore"),
  Type.Literal("delete"),
  Type.Literal("keep"),
]);
export type RestoreAction = Static<typeof RestoreActionSchema>;

export const RestorePathPlanSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    /** 源快照中的 worktree 状态；修改前用于对照。 */
    snapshot: RestorePathStateSchema,
    /** 当前 worktree 状态；执行前必须与 --expect 匹配。 */
    current: RestorePathStateSchema,
    /** 当前 index 状态；即使 worktree 相同，--index 也可能需要更新。 */
    index: RestoreIndexStateSchema,
    snapshotIndex: RestoreIndexStateSchema,
    action: RestoreActionSchema,
    indexAction: Type.Union([Type.Literal("set"), Type.Literal("remove"), Type.Literal("unchanged"), Type.Literal("ignored")]),
    /** 必须处理的保护条件；null 表示可直接执行。 */
    guard: Type.Union([Type.Literal("remove_created_required"), Type.Literal("unsupported"), Type.Literal("task_input"), Type.Null()]),
    reason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RestorePathPlan = Static<typeof RestorePathPlanSchema>;

export const RestoreRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: Type.String({ pattern: "^restore-[0-9a-f]{12}$" }),
    runId: Type.String({ pattern: "^run-[0-9a-f]{12}$" }),
    taskId: Type.String({ minLength: 1 }),
    state: Type.Union([
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("needs_attention"),
      Type.Literal("failed"),
    ]),
    root: Type.String({ minLength: 1 }),
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    headBefore: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    headAfter: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    snapshotDigest: Type.String({ minLength: 1 }),
    index: Type.Boolean(),
    removeCreated: Type.Boolean(),
    expect: Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 })),
    plans: Type.Array(RestorePathPlanSchema),
    results: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          status: Type.Union([Type.Literal("done"), Type.Literal("skipped"), Type.Literal("failed")]),
          after: RestorePathStateSchema,
          indexAfter: RestoreIndexStateSchema,
          reason: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    reason: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type RestoreRecord = Static<typeof RestoreRecordSchema>;
