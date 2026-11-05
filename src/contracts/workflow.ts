/**
 * `.knit/workflow.yaml` 配置契约（设计 §4／§9／§10）。
 * 本模块只描述 YAML 的原始结构、校验结果与运行模式；
 * 解析、语义校验、默认值与降级推导在 domain/workflow.ts。
 *
 * 约定：
 * - 注释不属于配置值，也不参与任何比较。
 * - `stages` 的顺序就是流转顺序；`start`／`deliver` 是内置锚点，不写进 stages。
 * - 不写 `tools` 表示全部能力放开；写了就是白名单。
 * - `report` 的值可以是 string／string[]／paths／bool，或非空字符串枚举数组。
 */
import { arr, bool, int, lit, map, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";

export const WORKFLOW_CONFIG_PATH = ".knit/workflow.yaml";

/** 当前唯一支持的配置版本。 */
export const WORKFLOW_CONFIG_VERSION = 1;

/** 内置锚点：start 准备／讨论，deliver 收尾；不可配置、无提示词。 */
export const WORKFLOW_ANCHORS = ["start", "deliver"] as const;
export type WorkflowAnchor = (typeof WORKFLOW_ANCHORS)[number];

/** onVerdict 允许跳转的锚点；start 不是阶段，跳回起点会绕过阶段计数。 */
export const WORKFLOW_VERDICT_ANCHOR = "deliver" as const;

export function isWorkflowAnchor(value: string): value is WorkflowAnchor {
  return (WORKFLOW_ANCHORS as readonly string[]).includes(value);
}

/** 运行模式：config 按配置执行；fallback 使用 start → deliver 的降级流程。 */
export const WorkflowModeSchema = union([lit("config"), lit("fallback")]);
export type WorkflowMode = Static<typeof WorkflowModeSchema>;

/** 阶段能力白名单；对应 Pi 的只读、写文件、执行、任务、扩展与网络开关。 */
export const ToolCapabilitySchema = union([
  lit("read"),
  lit("write"),
  lit("exec"),
  lit("task"),
  lit("external"),
  lit("network"),
]);
export type ToolCapability = Static<typeof ToolCapabilitySchema>;

export const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  "read",
  "write",
  "exec",
  "task",
  "external",
  "network",
];

export const REPORT_SCALAR_TYPES = ["string", "string[]", "paths", "bool"] as const;

/**
 * 额外报告字段类型；字符串枚举用数组表示（如 [pass, changes_requested]）。
 * 空数组与重复值由 domain 校验给出可读原因，schema 只负责形状。
 */
export const ReportFieldTypeSchema = union([
  lit("string"),
  lit("string[]"),
  lit("paths"),
  lit("bool"),
  arr(str({ minLength: 1 })),
]);
export type ReportFieldType = Static<typeof ReportFieldTypeSchema>;

export function isReportEnum(type: ReportFieldType): type is string[] {
  return Array.isArray(type);
}

/** 阶段 id：小写字母开头，后续小写字母、数字或连字符，最长 32。 */
export const WORKFLOW_STAGE_ID_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
export const WORKFLOW_STAGE_ID_REGEX = /^[a-z][a-z0-9-]{0,31}$/;

/** 单个阶段；未知字段视为拼写错误，整体判为非法配置。 */
export const WorkflowStageConfigSchema = obj({
  id: str({ pattern: WORKFLOW_STAGE_ID_PATTERN }),
  name: opt(str()),
  description: opt(str()),
  /** 项目相对路径；文件缺失由核心用默认 agent 指令，不在这里判降级。 */
  prompt: opt(str({ minLength: 1 })),
  tools: opt(arr(ToolCapabilitySchema)),
  report: opt(map(ReportFieldTypeSchema)),
  /** 报告值 → 阶段 id 或 deliver；语义目标存在性由 domain 校验。 */
  onVerdict: opt(map(str({ minLength: 1 }))),
  /** 回退环访问上限；缺省用 config.workflow.maxRepairRounds，null 表示无上限。 */
  maxVisits: opt(union([int({ minimum: 0 }), lit(null)])),
});
export type WorkflowStageConfig = Static<typeof WorkflowStageConfigSchema>;

/** 完整配置文件；version 先由 domain 预检，能用更稳定的原因码区分版本问题。 */
export const WorkflowConfigSchema = obj({
  version: lit(WORKFLOW_CONFIG_VERSION),
  stages: arr(WorkflowStageConfigSchema, { minItems: 1 }),
});
export type WorkflowConfig = Static<typeof WorkflowConfigSchema>;

/**
 * 降级原因码与问题码：
 * - 任一问题都会使整份配置降级，reason 取问题清单中的首个原因。
 * - 原因码保持稳定，供 CLI、run 记录与 doctor 展示。
 */
export const WORKFLOW_ISSUE_CODES = [
  "yaml_parse_error",
  "invalid_structure",
  "unsupported_version",
  "empty_stages",
  "invalid_stage_id",
  "reserved_stage_id",
  "duplicate_stage_id",
  "invalid_tools",
  "invalid_report",
  "invalid_on_verdict",
  "invalid_max_visits",
  "duplicate_report_enum",
  "undeclared_verdict_value",
  "unknown_on_verdict_target",
  "unbounded_repair_cycle",
] as const;
export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];
export type WorkflowFallbackReason = WorkflowIssueCode;

export const WorkflowIssueCodeSchema = union(
  WORKFLOW_ISSUE_CODES.map((code) => lit(code)),
);

export const WorkflowIssueSchema = obj({
  code: WorkflowIssueCodeSchema,
  /** YAML 源文件中的 1 起始行号；问题没有具体位置时为 1。 */
  line: int({ minimum: 1 }),
  /** 1 起始列号；同样用于定位。 */
  column: int({ minimum: 1 }),
  /** 指向 YAML 值的 JSON Pointer；根为空串。 */
  path: str(),
  /** 已包含“第 N 行：”的可读说明。 */
  message: str({ minLength: 1 }),
});
export type WorkflowIssue = Static<typeof WorkflowIssueSchema>;

/**
 * 校验结果：ok=false 时 issues 非空、reason 为首个问题码；
 * ok=true 时 issues 为空、reason 为 null。
 */
export const WorkflowValidationSchema = obj({
  ok: bool(),
  issues: arr(WorkflowIssueSchema),
  reason: union([WorkflowIssueCodeSchema, lit(null)]),
});
export type WorkflowValidation = Static<typeof WorkflowValidationSchema>;
