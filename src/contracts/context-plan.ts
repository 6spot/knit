import { arr, bool, int, lit, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { SessionRoleSchema } from "./session.js";
import { ToolCapabilitySchema } from "./workflow.js";

/**
 * 上下文计划（DESIGN.md 第8.1节、ARCHITECTURE.md ContextPlanner）。
 * 分层输入：需求、规范／角色、纯记录与背景资料分开；
 * 每项含稳定来源 ID、作用域、优先级与内容指纹，发布后不改。
 */
export const ContextSectionKindSchema = union([
  lit("task-inputs"),
  lit("progress"),
  lit("role"),
  lit("runtime"),
  lit("standard"),
  lit("pending-draft"),
  lit("standard-candidate"),
  lit("planning-material"),
]);
export type ContextSectionKind = Static<typeof ContextSectionKindSchema>;

/** 注入途径：系统提示、用户消息或受控资源加载。 */
export const InjectionModeSchema = union([
  lit("system"),
  lit("user"),
  lit("resource"),
]);
export type InjectionMode = Static<typeof InjectionModeSchema>;

export const ContextSectionSchema = obj(
  {
    /** 稳定来源 ID：kind + 项目相对路径（或草案版本摘要）。 */
    sourceId: str({ minLength: 1 }),
    kind: ContextSectionKindSchema,
    /** 项目相对路径；草案等无独立文件时为 null。 */
    path: union([str({ minLength: 1 }), nul()]),
    /** 内容指纹（SHA-256）；不可读时为 null 并记入 blockers／excluded。 */
    digest: union([str({ minLength: 1 }), nul()]),
    bytes: union([int({ minimum: 0 }), nul()]),
    /** 是否属于本次任务的有效需求输入。 */
    required: bool(),
    /** 背景资料（历史记录、未生效草案、候选规则）不参与需求摘要。 */
    background: bool(),
    /** 是否计入 inputsDigest；记录区与草案不计入。 */
    countsTowardInputs: bool(),
    /** 优先级：数字小者先注入。 */
    priority: int({ minimum: 0 }),
    mode: InjectionModeSchema,
  },
);
export type ContextSection = Static<typeof ContextSectionSchema>;

export const ContextExclusionSchema = obj(
  {
    sourceId: str({ minLength: 1 }),
    path: union([str({ minLength: 1 }), nul()]),
    reason: str({ minLength: 1 }),
  },
);
export type ContextExclusion = Static<typeof ContextExclusionSchema>;

/**
 * 工具策略按阶段能力给出（设计 §7）：
 * - `capabilities: null` = 阶段未写 `tools`，全部放开；
 * - 其余数组是白名单，`allow` 是展开后的 Pi 工具名／模式，`deny` 供展示与诊断。
 */
export const ToolPolicySchema = obj(
  {
    mode: union([lit("write"), lit("read")]),
    allow: arr(str({ minLength: 1 })),
    deny: arr(str({ minLength: 1 })),
    /** 生效能力白名单；null 表示全部放开，缺省为旧计划（按 allow／deny 解释）。 */
    capabilities: opt(union([arr(ToolCapabilitySchema), nul()])),
  },
);
export type ToolPolicy = Static<typeof ToolPolicySchema>;

/** 明确授权为成果的正式规范：路径与冻结旧版本摘要（任务037）。 */
export const AuthorizedStandardOutputSchema = obj(
  {
    path: str({ minLength: 1 }),
    frozenDigest: str({ minLength: 1 }),
    /** 冻结的旧版本内容；计划内复核与接收按此重建授权分节（任务037）。 */
    frozenContent: str(),
  },
);
export type AuthorizedStandardOutput = Static<typeof AuthorizedStandardOutputSchema>;

export const ContextPlanSchema = obj(
  {
    planId: str({ minLength: 1, pattern: "^ctx-[0-9a-f]{12}$" }),
    taskId: str({ minLength: 1 }),
    role: SessionRoleSchema,
    /** 每轮上下文最上方的提示行：流程、当前阶段、本步目标与完成条件。 */
    stageBrief: opt(str()),
    /** 冻结输入摘要（任务输入区）；背景资料不计入。 */
    inputsDigest: str({ minLength: 1 }),
    /** 正式规范整体摘要；候选、记录与未生效草案不计入。 */
    standardsDigest: str({ minLength: 1 }),
    /** 检查凭据使用的整体输入身份：任务输入区 + 正式规范。 */
    effectiveInputsDigest: str({ minLength: 1 }),
    /** 任务文档整体指纹，用于核实文件版本。 */
    taskDocumentDigest: str({ minLength: 1 }),
    sections: arr(ContextSectionSchema),
    excluded: arr(ContextExclusionSchema),
    createdAt: str({ minLength: 1 }),
    /** 参数与必需指令就绪即可发起首轮调用；available 不是前置条件。 */
    ready: bool(),
    blockers: arr(str({ minLength: 1 })),
    toolPolicy: ToolPolicySchema,
    /** 本任务明确授权为成果的正式规范及冻结旧版本；空表示无授权（任务037）。 */
    authorizedStandardOutputs: arr(AuthorizedStandardOutputSchema),
  },
);
export type ContextPlan = Static<typeof ContextPlanSchema>;

export function newContextPlanId(randomHex: (bytes: number) => string): string {
  return `ctx-${randomHex(6)}`;
}
