import { arr, bool, int, lit, map, nul, obj, str, union, type Static } from "@earendil-works/pi-schema";

/** 单路径恢复预览：只描述计划，不携带文件正文或疑似凭据。 */
export const RestorePathStateSchema = obj(
  {
    kind: union([
      lit("absent"),
      lit("file"),
      lit("symlink"),
      lit("directory"),
      lit("submodule"),
      lit("other"),
    ]),
    fingerprint: str({ minLength: 1 }),
    mode: union([int({ minimum: 0 }), nul()]),
    size: union([int({ minimum: 0 }), nul()]),
  },
);
export type RestorePathState = Static<typeof RestorePathStateSchema>;

export const RestoreIndexStateSchema = obj(
  {
    present: bool(),
    mode: union([int({ minimum: 0 }), nul()]),
    oid: union([str({ minLength: 1 }), nul()]),
  },
);
export type RestoreIndexState = Static<typeof RestoreIndexStateSchema>;

export const RestoreActionSchema = union([
  lit("restore"),
  lit("delete"),
  lit("keep"),
]);
export type RestoreAction = Static<typeof RestoreActionSchema>;

export const RestorePathPlanSchema = obj(
  {
    path: str({ minLength: 1 }),
    /** 源快照中的 worktree 状态；修改前用于对照。 */
    snapshot: RestorePathStateSchema,
    /** 当前 worktree 状态；执行前必须与 --expect 匹配。 */
    current: RestorePathStateSchema,
    /** 当前 index 状态；即使 worktree 相同，--index 也可能需要更新。 */
    index: RestoreIndexStateSchema,
    snapshotIndex: RestoreIndexStateSchema,
    action: RestoreActionSchema,
    indexAction: union([lit("set"), lit("remove"), lit("unchanged"), lit("ignored")]),
    /** 必须处理的保护条件；null 表示可直接执行。 */
    guard: union([lit("remove_created_required"), lit("unsupported"), lit("task_input"), nul()]),
    reason: union([str(), nul()]),
  },
);
export type RestorePathPlan = Static<typeof RestorePathPlanSchema>;

export const RestoreRecordSchema = obj(
  {
    schemaVersion: lit(1),
    operationId: str({ pattern: "^restore-[0-9a-f]{12}$" }),
    runId: str({ pattern: "^run-[0-9a-f]{12}$" }),
    taskId: str({ minLength: 1 }),
    state: union([
      lit("running"),
      lit("completed"),
      lit("needs_attention"),
      lit("failed"),
    ]),
    root: str({ minLength: 1 }),
    branch: union([str({ minLength: 1 }), nul()]),
    headBefore: union([str({ minLength: 1 }), nul()]),
    headAfter: union([str({ minLength: 1 }), nul()]),
    snapshotDigest: str({ minLength: 1 }),
    index: bool(),
    removeCreated: bool(),
    expect: map(str({ minLength: 1 })),
    plans: arr(RestorePathPlanSchema),
    results: arr(
      obj(
        {
          path: str({ minLength: 1 }),
          status: union([lit("done"), lit("skipped"), lit("failed")]),
          after: RestorePathStateSchema,
          indexAfter: RestoreIndexStateSchema,
          reason: union([str(), nul()]),
        },
      ),
    ),
    reason: union([str(), nul()]),
    createdAt: str({ minLength: 1 }),
    updatedAt: str({ minLength: 1 }),
  },
);
export type RestoreRecord = Static<typeof RestoreRecordSchema>;
