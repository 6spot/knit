/**
 * Pi 桥接工具的同源参数 schema（DESIGN.md 第4.1节、TECHNOLOGY.md 第3节）。
 * 构建时由 scripts/build-bridge-schema.mjs 派生为 dist/contracts/bridge-tools.json；
 * 桥接只读取派生 JSON，不依赖用户项目 node_modules 中的 Knit 依赖。
 */
import { arr, bool, lit, map, obj, opt, str, union } from "@earendil-works/pi-schema";

export const TaskToolSchema = obj(
  {
    action: union([
      lit("list"),
      lit("new"),
      lit("rename"),
      lit("parent"),
      lit("priority"),
      lit("depends"),
      lit("order"),
      lit("next"),
      lit("ready"),
      lit("update"),
      lit("record"),
      lit("close"),
      lit("adopt"),
      lit("verification"),
      lit("use"),
      lit("clear"),
    ]),
    taskId: opt(str({ minLength: 1 })),
    title: opt(str()),
    slug: opt(str()),
    newSlug: opt(str()),
    /** 创建或挂接的父任务稳定身份；解除关联用 detach。 */
    parentId: opt(str({ minLength: 1 })),
    detach: opt(bool()),
    /** 任务自身优先级 P0–P3；缺省 P2。 */
    priority: opt(union([lit("P0"), lit("P1"), lit("P2"), lit("P3")])),
    /** 前置依赖的稳定任务身份；add／remove 增量调整，set 整体替换。 */
    dependsOn: opt(arr(str({ minLength: 1 }))),
    removeDependsOn: opt(arr(str({ minLength: 1 }))),
    setDependsOn: opt(arr(str({ minLength: 1 }))),
    clearDependsOn: opt(bool()),
    /** 调整业务顺序的参照任务或位置。 */
    beforeId: opt(str({ minLength: 1 })),
    afterId: opt(str({ minLength: 1 })),
    position: opt(union([lit("top"), lit("bottom")])),
    branch: opt(str()),
    kind: opt(union([lit("clarify"), lit("change")])),
    body: opt(str()),
    reason: opt(str()),
    outcome: opt(union([lit("completed"), lit("cancelled"), lit("superseded")])),
    runsSettled: opt(bool()),
    applyPending: opt(bool()),
    withdrawPending: opt(bool()),
    expectPending: opt(str()),
    nonEquivalent: opt(bool()),
  },
);

export const ContextToolSchema = obj(
  {
    taskId: str({ minLength: 1 }),
    role: opt(union([lit("implement"), lit("check"), lit("advisory")])),
  },
);

export const RunToolSchema = obj(
  {
    action: union([
      lit("implement"),
      lit("check"),
      lit("advisory"),
      lit("status"),
      lit("list"),
      lit("resume"),
      lit("cancel"),
    ]),
    taskId: opt(str({ minLength: 1 })),
    runId: opt(str({ minLength: 1 })),
    /** 仅讨论建议；交付辅助角色已撤除，交付由主会话协调确定性工具。 */
    mode: opt(lit("discuss")),
    scope: opt(arr(str({ minLength: 1 }))),
    provider: opt(str({ minLength: 1 })),
    model: opt(str({ minLength: 1 })),
    resumeSession: opt(str({ minLength: 1 })),
    newRepairCycle: opt(bool()),
    wait: opt(bool()),
    reason: opt(str()),
  },
);

export const DeliverToolSchema = obj(
  {
    action: union([lit("deliver"), lit("archive"), lit("plan")]),
    taskId: opt(str({ minLength: 1 })),
    taskIds: opt(arr(str({ minLength: 1 }), { minItems: 1 })),
    branch: str({ pattern: "^refs/heads/.+" }),
    authorizationRef: opt(str()),
    retry: opt(bool()),
  },
);

export const StandardsToolSchema = obj(
  {
    action: union([
      lit("list"),
      lit("propose"),
      lit("review"),
      lit("apply"),
      lit("pending"),
      lit("migrate"),
    ]),
    taskId: opt(str({ minLength: 1 })),
    /** 来源说明（讨论、实施发现）；propose 使用。 */
    source: opt(str()),
    title: opt(str()),
    problem: opt(str()),
    evidence: opt(str()),
    scope: opt(str()),
    rule: opt(str()),
    verification: opt(str()),
    decision: opt(union([lit("applied"), lit("deferred"), lit("rejected"), lit("mixed")])),
    reason: opt(str()),
    target: opt(str()),
    targets: opt(arr(str({ minLength: 1 }))),
    candidateId: opt(str()),
  },
);

export const SnapshotToolSchema = obj(
  {
    action: union([lit("show"), lit("restore")]),
    runId: str({ minLength: 1 }),
    path: opt(str({ minLength: 1 })),
    paths: opt(arr(str({ minLength: 1 }))),
    expect: opt(map(str({ minLength: 1 }))),
    index: opt(bool()),
    removeCreated: opt(bool()),
  },
);

export const StatusToolSchema = obj(
  {
    taskId: opt(str({ minLength: 1 })),
    runId: opt(str({ minLength: 1 })),
  },
);

/** 任务规划资料工具（DESIGN §3.4，任务045/048）：要求性内容变化仍须走 task update。 */
export const MaterialToolSchema = obj(
  {
    action: union([lit("list"), lit("read"), lit("save"), lit("delete")]),
    taskId: str({ minLength: 1 }),
    path: opt(str({ minLength: 1 })),
    content: opt(str()),
    expectDigest: opt(str()),
  },
);

export const BRIDGE_TOOL_SCHEMAS = {
  task: TaskToolSchema,
  material: MaterialToolSchema,
  context: ContextToolSchema,
  run: RunToolSchema,
  deliver: DeliverToolSchema,
  standards: StandardsToolSchema,
  snapshot: SnapshotToolSchema,
  status: StatusToolSchema,
} as const;
