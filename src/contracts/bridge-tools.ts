/**
 * Pi 桥接工具的同源参数 schema（DESIGN.md 第4.1节、TECHNOLOGY.md 第3节）。
 * 构建时由 scripts/build-bridge-schema.mjs 派生为 dist/contracts/bridge-tools.json；
 * 桥接只读取派生 JSON，不依赖用户项目 node_modules 中的 Knit 依赖。
 */
import { Type } from "typebox";

export const TaskToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("new"),
      Type.Literal("rename"),
      Type.Literal("ready"),
      Type.Literal("update"),
      Type.Literal("record"),
      Type.Literal("close"),
      Type.Literal("adopt"),
      Type.Literal("use"),
      Type.Literal("clear"),
    ]),
    taskId: Type.Optional(Type.String({ minLength: 1 })),
    title: Type.Optional(Type.String()),
    slug: Type.Optional(Type.String()),
    newSlug: Type.Optional(Type.String()),
    branch: Type.Optional(Type.String()),
    kind: Type.Optional(Type.Union([Type.Literal("clarify"), Type.Literal("change")])),
    body: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    outcome: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("superseded")])),
    runsSettled: Type.Optional(Type.Boolean()),
    applyPending: Type.Optional(Type.Boolean()),
    withdrawPending: Type.Optional(Type.Boolean()),
    expectPending: Type.Optional(Type.String()),
    nonEquivalent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ContextToolSchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    role: Type.Optional(Type.Union([Type.Literal("implement"), Type.Literal("check"), Type.Literal("advisory")])),
  },
  { additionalProperties: false },
);

export const RunToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("implement"),
      Type.Literal("check"),
      Type.Literal("advisory"),
      Type.Literal("status"),
      Type.Literal("list"),
      Type.Literal("resume"),
      Type.Literal("cancel"),
    ]),
    taskId: Type.Optional(Type.String({ minLength: 1 })),
    runId: Type.Optional(Type.String({ minLength: 1 })),
    mode: Type.Optional(Type.Union([Type.Literal("discuss"), Type.Literal("deliver")])),
    scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    resumeSession: Type.Optional(Type.String({ minLength: 1 })),
    newRepairCycle: Type.Optional(Type.Boolean()),
    wait: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const DeliverToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("deliver"), Type.Literal("archive")]),
    taskId: Type.String({ minLength: 1 }),
    branch: Type.String({ pattern: "^refs/heads/.+" }),
    authorizationRef: Type.Optional(Type.String()),
    retry: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const StandardsToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("propose"),
      Type.Literal("review"),
      Type.Literal("apply"),
      Type.Literal("pending"),
    ]),
    taskId: Type.Optional(Type.String({ minLength: 1 })),
    title: Type.Optional(Type.String()),
    problem: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    rule: Type.Optional(Type.String()),
    verification: Type.Optional(Type.String()),
    decision: Type.Optional(Type.Union([Type.Literal("applied"), Type.Literal("deferred"), Type.Literal("rejected"), Type.Literal("mixed")])),
    reason: Type.Optional(Type.String()),
    target: Type.Optional(Type.String()),
    targets: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    candidateId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SnapshotToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("show"), Type.Literal("restore")]),
    runId: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    expect: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }))),
    index: Type.Optional(Type.Boolean()),
    removeCreated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const StatusToolSchema = Type.Object(
  {
    taskId: Type.Optional(Type.String({ minLength: 1 })),
    runId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** 任务规划资料工具（DESIGN §3.4，任务045/048）：要求性内容变化仍须走 task update。 */
export const MaterialToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("save"), Type.Literal("delete")]),
    taskId: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
    content: Type.Optional(Type.String()),
    expectDigest: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
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
