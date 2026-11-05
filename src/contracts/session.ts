import { bool, int, lit, nul, obj, str, union, type Static } from "@earendil-works/pi-schema";
import { WORKFLOW_STAGE_ID_PATTERN } from "./workflow.js";

/**
 * 阶段身份：内置锚点或 `.knit/workflow.yaml` 的阶段 id（设计 §3）。
 * 阶段提示词文件由配置的 `prompt` 决定；“角色”不再独立存在。
 */
export const SessionRoleSchema = str({ minLength: 1, pattern: WORKFLOW_STAGE_ID_PATTERN });
export type SessionRole = Static<typeof SessionRoleSchema>;

/** 原生身份：客户端、预分配原生 ID 与阶段；字段名 role 为历史命名，值即阶段 id。 */
export const NativeSessionRefSchema = obj(
  {
    client: lit("pi"),
    nativeSessionId: str({ minLength: 1 }),
    role: SessionRoleSchema,
  },
);
export type NativeSessionRef = Static<typeof NativeSessionRefSchema>;

/** 引用状态；opening 原因记入本 run 准备结果，不再增加状态值。 */
export const SessionStatusSchema = union([
  lit("opening"),
  lit("available"),
  lit("missing"),
  lit("incompatible"),
]);
export type SessionStatus = Static<typeof SessionStatusSchema>;

/** 主会话或子会话（DESIGN.md 第9.5节）。 */
export const SessionKindSchema = union([lit("main"), lit("sub")]);
export type SessionKind = Static<typeof SessionKindSchema>;

/** 关系来源：Fork／明确切换／恢复兜底／普通登记。 */
export const SessionSourceKindSchema = union([
  lit("fork"),
  lit("switch"),
  lit("resume_fallback"),
  lit("attach"),
]);
export type SessionSourceKind = Static<typeof SessionSourceKindSchema>;

export const SessionSourceSchema = obj(
  {
    kind: SessionSourceKindSchema,
    /** 来源 Knit Session ID；普通登记为 null。 */
    fromSessionId: union([str({ minLength: 1 }), nul()]),
    /** 兜底原因等；无则 null。 */
    reason: union([str(), nul()]),
  },
);
export type SessionSource = Static<typeof SessionSourceSchema>;

/**
 * 主会话任务选择快照（DESIGN.md 第9.1节）。
 * 原生有效路径是权威；索引只保存经核实的快照。
 * persisted=false 表示条目尚未落盘，只待确认，不宣称已保存选择。
 */
export const SelectionSnapshotSchema = obj(
  {
    taskId: union([str({ minLength: 1 }), nul()]),
    branch: union([str({ minLength: 1 }), nul()]),
    /** 关联原生条目引用；未落盘为 null。 */
    entryRef: union([str({ minLength: 1 }), nul()]),
    operationId: str({ minLength: 1 }),
    recordedAt: str({ minLength: 1 }),
    persisted: bool(),
    pendingReason: union([str(), nul()]),
  },
);
export type SelectionSnapshot = Static<typeof SelectionSnapshotSchema>;

/**
 * 统一 Session 索引记录（DESIGN.md 第9.5节）。
 * 只存定位、选择、关系和可确认的指令信息；原始历史仍在所属客户端。
 */
export const SessionRecordSchema = obj(
  {
    /** 首次分配的稳定 Knit Session ID（s- + 12 hex）。 */
    knitSessionId: str({ minLength: 1, pattern: "^s-[0-9a-f]{12}$" }),
    protocolVersion: int({ minimum: 1 }),
    ref: NativeSessionRefSchema,
    kind: SessionKindSchema,
    status: SessionStatusSchema,
    /** 稳定记录位置；未知为 null（客户端尚未落盘）。 */
    sessionFile: union([str({ minLength: 1 }), nul()]),
    /** 父 Knit Session ID；主会话为 null。 */
    parentSessionId: union([str({ minLength: 1 }), nul()]),
    source: union([SessionSourceSchema, nul()]),
    taskId: union([str({ minLength: 1 }), nul()]),
    branch: union([str({ minLength: 1 }), nul()]),
    runId: union([str({ minLength: 1 }), nul()]),
    /** 原 cwd；用于防止临时目录／迁移后误选。 */
    cwd: str({ minLength: 1 }),
    /** 会话检查点条目引用；无则 null。 */
    checkpoint: union([str({ minLength: 1 }), nul()]),
    /** 主会话选择快照；子会话为 null。 */
    selection: union([SelectionSnapshotSchema, nul()]),
    /** 不可用／不可恢复原因；正常为 null。 */
    reason: union([str(), nul()]),
    lastVerifiedAt: union([str({ minLength: 1 }), nul()]),
    /** 原生记录当前是否可读取（最近一次核实）。 */
    nativeReadable: bool(),
    /** 关联运行的已知状态；未知为 null。 */
    relatedRunState: union([str({ minLength: 1 }), nul()]),
    recordedAt: str({ minLength: 1 }),
  },
);
export type SessionRecord = Static<typeof SessionRecordSchema>;

/** 稳定 Knit Session ID：s- + 12 hex；与任务 ID 前缀区分。 */
export function newKnitSessionId(randomHex: (bytes: number) => string): string {
  return `s-${randomHex(6)}`;
}
