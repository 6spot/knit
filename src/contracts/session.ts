import { Type, type Static } from "typebox";

/** 阶段角色；实施与检查分离，advisory 不推进业务。 */
export const SessionRoleSchema = Type.Union([
  Type.Literal("implement"),
  Type.Literal("check"),
  Type.Literal("advisory"),
]);
export type SessionRole = Static<typeof SessionRoleSchema>;

/** 原生身份：客户端、预分配原生 ID 与角色；不包含凭据。 */
export const NativeSessionRefSchema = Type.Object(
  {
    client: Type.Literal("pi"),
    nativeSessionId: Type.String({ minLength: 1 }),
    role: SessionRoleSchema,
  },
  { additionalProperties: false },
);
export type NativeSessionRef = Static<typeof NativeSessionRefSchema>;

/** 引用状态；opening 原因记入本 run 准备结果，不再增加状态值。 */
export const SessionStatusSchema = Type.Union([
  Type.Literal("opening"),
  Type.Literal("available"),
  Type.Literal("missing"),
  Type.Literal("incompatible"),
]);
export type SessionStatus = Static<typeof SessionStatusSchema>;

/** 主会话或子会话（DESIGN.md 第9.5节）。 */
export const SessionKindSchema = Type.Union([Type.Literal("main"), Type.Literal("sub")]);
export type SessionKind = Static<typeof SessionKindSchema>;

/** 关系来源：Fork／明确切换／恢复兜底／普通登记。 */
export const SessionSourceKindSchema = Type.Union([
  Type.Literal("fork"),
  Type.Literal("switch"),
  Type.Literal("resume_fallback"),
  Type.Literal("attach"),
]);
export type SessionSourceKind = Static<typeof SessionSourceKindSchema>;

export const SessionSourceSchema = Type.Object(
  {
    kind: SessionSourceKindSchema,
    /** 来源 Knit Session ID；普通登记为 null。 */
    fromSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 兜底原因等；无则 null。 */
    reason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SessionSource = Static<typeof SessionSourceSchema>;

/**
 * 主会话任务选择快照（DESIGN.md 第9.1节）。
 * 原生有效路径是权威；索引只保存经核实的快照。
 * persisted=false 表示条目尚未落盘，只待确认，不宣称已保存选择。
 */
export const SelectionSnapshotSchema = Type.Object(
  {
    taskId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 关联原生条目引用；未落盘为 null。 */
    entryRef: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    operationId: Type.String({ minLength: 1 }),
    recordedAt: Type.String({ minLength: 1 }),
    persisted: Type.Boolean(),
    pendingReason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SelectionSnapshot = Static<typeof SelectionSnapshotSchema>;

/**
 * 统一 Session 索引记录（DESIGN.md 第9.5节）。
 * 只存定位、选择、关系和可确认的指令信息；原始历史仍在所属客户端。
 */
export const SessionRecordSchema = Type.Object(
  {
    /** 首次分配的稳定 Knit Session ID（s- + 12 hex）。 */
    knitSessionId: Type.String({ minLength: 1, pattern: "^s-[0-9a-f]{12}$" }),
    protocolVersion: Type.Integer({ minimum: 1 }),
    ref: NativeSessionRefSchema,
    kind: SessionKindSchema,
    status: SessionStatusSchema,
    /** 稳定记录位置；未知为 null（客户端尚未落盘）。 */
    sessionFile: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 父 Knit Session ID；主会话为 null。 */
    parentSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    source: Type.Union([SessionSourceSchema, Type.Null()]),
    taskId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    runId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 原 cwd；用于防止临时目录／迁移后误选。 */
    cwd: Type.String({ minLength: 1 }),
    /** 会话检查点条目引用；无则 null。 */
    checkpoint: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 主会话选择快照；子会话为 null。 */
    selection: Type.Union([SelectionSnapshotSchema, Type.Null()]),
    /** 不可用／不可恢复原因；正常为 null。 */
    reason: Type.Union([Type.String(), Type.Null()]),
    lastVerifiedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 原生记录当前是否可读取（最近一次核实）。 */
    nativeReadable: Type.Boolean(),
    /** 关联运行的已知状态；未知为 null。 */
    relatedRunState: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    recordedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type SessionRecord = Static<typeof SessionRecordSchema>;

/** 稳定 Knit Session ID：s- + 12 hex；与任务 ID 前缀区分。 */
export function newKnitSessionId(randomHex: (bytes: number) => string): string {
  return `s-${randomHex(6)}`;
}
