import { Type, type Static } from "typebox";
import { SessionRoleSchema } from "./session.js";

/**
 * 上下文计划（DESIGN.md 第8.1节、ARCHITECTURE.md ContextPlanner）。
 * 分层输入：需求、规范／角色、纯记录与背景资料分开；
 * 每项含稳定来源 ID、作用域、优先级与内容指纹，发布后不改。
 */
export const ContextSectionKindSchema = Type.Union([
  Type.Literal("task-inputs"),
  Type.Literal("progress"),
  Type.Literal("workflow"),
  Type.Literal("role"),
  Type.Literal("runtime"),
  Type.Literal("standard"),
  Type.Literal("pending-draft"),
  Type.Literal("standard-candidate"),
]);
export type ContextSectionKind = Static<typeof ContextSectionKindSchema>;

/** 注入途径：系统提示、用户消息或受控资源加载。 */
export const InjectionModeSchema = Type.Union([
  Type.Literal("system"),
  Type.Literal("user"),
  Type.Literal("resource"),
]);
export type InjectionMode = Static<typeof InjectionModeSchema>;

export const ContextSectionSchema = Type.Object(
  {
    /** 稳定来源 ID：kind + 项目相对路径（或草案版本摘要）。 */
    sourceId: Type.String({ minLength: 1 }),
    kind: ContextSectionKindSchema,
    /** 项目相对路径；草案等无独立文件时为 null。 */
    path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 内容指纹（SHA-256）；不可读时为 null 并记入 blockers／excluded。 */
    digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    bytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    /** 是否属于本次任务的有效需求输入。 */
    required: Type.Boolean(),
    /** 背景资料（历史记录、未生效草案、候选规则）不参与需求摘要。 */
    background: Type.Boolean(),
    /** 是否计入 inputsDigest；记录区与草案不计入。 */
    countsTowardInputs: Type.Boolean(),
    /** 优先级：数字小者先注入。 */
    priority: Type.Integer({ minimum: 0 }),
    mode: InjectionModeSchema,
  },
  { additionalProperties: false },
);
export type ContextSection = Static<typeof ContextSectionSchema>;

export const ContextExclusionSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1 }),
    path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ContextExclusion = Static<typeof ContextExclusionSchema>;

/** 工具策略按角色给出；首版实施可写，检查与 advisory 只读。 */
export const ToolPolicySchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("write"), Type.Literal("read")]),
    allow: Type.Array(Type.String({ minLength: 1 })),
    deny: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ToolPolicy = Static<typeof ToolPolicySchema>;

export const ContextPlanSchema = Type.Object(
  {
    planId: Type.String({ minLength: 1, pattern: "^ctx-[0-9a-f]{12}$" }),
    taskId: Type.String({ minLength: 1 }),
    role: SessionRoleSchema,
    /** 冻结输入摘要（任务输入区）；背景资料不计入。 */
    inputsDigest: Type.String({ minLength: 1 }),
    /** 正式规范整体摘要；候选、记录与未生效草案不计入。 */
    standardsDigest: Type.String({ minLength: 1 }),
    /** 检查凭据使用的整体输入身份：任务输入区 + 正式规范。 */
    effectiveInputsDigest: Type.String({ minLength: 1 }),
    /** 任务文档整体指纹，用于核实文件版本。 */
    taskDocumentDigest: Type.String({ minLength: 1 }),
    sections: Type.Array(ContextSectionSchema),
    excluded: Type.Array(ContextExclusionSchema),
    createdAt: Type.String({ minLength: 1 }),
    /** 参数与必需指令就绪即可发起首轮调用；available 不是前置条件。 */
    ready: Type.Boolean(),
    blockers: Type.Array(Type.String({ minLength: 1 })),
    toolPolicy: ToolPolicySchema,
  },
  { additionalProperties: false },
);
export type ContextPlan = Static<typeof ContextPlanSchema>;

export function newContextPlanId(randomHex: (bytes: number) => string): string {
  return `ctx-${randomHex(6)}`;
}
