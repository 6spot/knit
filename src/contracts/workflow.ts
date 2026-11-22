/**
 * `.knit/workflow.yaml` 配置契约（设计 §4／§9／§10）。
 * 描述 YAML 配置、内置 Agent 的参数规格和校验结果。
 * 工作流解析与语义校验在 domain/workflow.ts。
 *
 * 约定：
 * - 注释不属于配置值，也不参与任何比较。
 * - `stages` 的顺序就是流转顺序；`discuss`／`deliver` 是内置锚点，不写进 stages。
 * - `tools` 不写或写标量 `all`（大小写不敏感）表示全部能力放开；空数组 `[]` 表示全部禁用；
 *   非空数组是白名单，列表里不能混入 `all`。
 * - `report` 的值可以是 string／string[]／paths／bool，或非空字符串枚举数组。
 */
import { arr, bool, int, lit, map, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";

export const WORKFLOW_CONFIG_PATH = ".knit/workflow.yaml";

/** 当前唯一支持的配置版本。 */
export const WORKFLOW_CONFIG_VERSION = 1;

/** 内置锚点：discuss 讨论，deliver 收尾；都在主会话里，不可配置、无提示词。 */
export const WORKFLOW_ANCHORS = ["discuss", "deliver"] as const;
export type WorkflowAnchor = (typeof WORKFLOW_ANCHORS)[number];

/** onVerdict 允许跳转的锚点；discuss 不是阶段，跳回起点会绕过阶段计数。 */
export const WORKFLOW_VERDICT_ANCHOR = "deliver" as const;

export function isWorkflowAnchor(value: string): value is WorkflowAnchor {
  return (WORKFLOW_ANCHORS as readonly string[]).includes(value);
}

/** 阶段能力白名单；对应 Pi 的只读、写文件、执行、扩展与网络开关。 */
export const ToolCapabilitySchema = union([
  lit("read"),
  lit("write"),
  lit("exec"),
  lit("external"),
  lit("network"),
]);
export type ToolCapability = Static<typeof ToolCapabilitySchema>;

/** `tools: all` 的标量写法；大小写不敏感（`ALL` 等同），只接受标量，不接受 `[all]`。 */
export const TOOLS_ALL_PATTERN = "^[Aa][Ll][Ll]$";
export const TOOLS_ALL_REGEX = /^all$/i;

/** 阶段 `tools` 原始写法：标量 `all`（全部放开）或能力数组（空数组 = 全部禁用）。 */
export const StageToolsSchema = union([str({ pattern: TOOLS_ALL_PATTERN }), arr(ToolCapabilitySchema)]);
export type StageTools = Static<typeof StageToolsSchema>;

export const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  "read",
  "write",
  "exec",
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

export const AgentNameSchema = union([lit("pi"), lit("antigravity")]);
export type AgentName = Static<typeof AgentNameSchema>;
export const DEFAULT_AGENT = "pi";

const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export const THINKING_LEVELS = ["off", "minimal", ...effortLevels] as const;
export const ThinkingLevelSchema = union(THINKING_LEVELS.map((level) => lit(level)));
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export type AgentSpec = {
  readonly modelPattern: RegExp;
  readonly modelFormat: string;
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly inheritsWorkflowDefaults: boolean;
  readonly modelDefaultLabel: string;
  readonly thinkingDefaultLabel: string;
} & (
  | { readonly modelRequired: true; readonly missingModelMessage: string }
  | { readonly modelRequired: false }
);

export const AGENT_SPECS: Readonly<Record<AgentName, AgentSpec>> = {
  pi: {
    modelPattern: /^[^/]+\/.+$/,
    modelFormat: "provider/模型",
    modelRequired: true,
    missingModelMessage: "没有指定执行者的模型：不在 Pi 会话里时，在 .knit/workflow.yaml 里写 model，或加 --model provider/模型",
    thinkingLevels: THINKING_LEVELS,
    inheritsWorkflowDefaults: true,
    modelDefaultLabel: "（没有指定，用主会话的模型）",
    thinkingDefaultLabel: "（没有指定，用主会话的等级）",
  },
  antigravity: {
    modelPattern: /^(?:[A-Za-z0-9][A-Za-z0-9._:-]*|gemini-api:\/\/[^\s]+\/models\/[A-Za-z0-9._:-]+)$/,
    modelFormat: "Antigravity 模型 ID",
    modelRequired: false,
    thinkingLevels: effortLevels,
    inheritsWorkflowDefaults: false,
    modelDefaultLabel: "（用 agy 的缺省）",
    thinkingDefaultLabel: "（用 agy 的缺省）",
  },
};

/** 单个阶段；未知字段视为拼写错误，整体判为非法配置。 */
export const WorkflowStageConfigSchema = obj({
  id: str({ pattern: WORKFLOW_STAGE_ID_PATTERN }),
  name: opt(str()),
  description: opt(str()),
  agent: opt(AgentNameSchema),
  model: opt(str()),
  thinking: opt(ThinkingLevelSchema),
  /** 项目相对路径；文件是否存在不在这里判断。 */
  prompt: opt(str({ minLength: 1 })),
  /** 不写或 `all` = 全部放开；`[]` = 全部禁用；非空数组 = 白名单。 */
  tools: opt(StageToolsSchema),
  report: opt(map(ReportFieldTypeSchema)),
  /** 报告值 → 阶段 id 或 deliver；语义目标存在性由 domain 校验。 */
  onVerdict: opt(map(str({ minLength: 1 }))),
  /** 回退环访问上限；缺省用顶层的 maxRepairRounds，null 表示无上限。 */
  maxVisits: opt(union([int({ minimum: 0 }), lit(null)])),
});
export type WorkflowStageConfig = Static<typeof WorkflowStageConfigSchema>;

/** 完整配置文件；version 先由 domain 预检，能用更稳定的原因码区分版本问题。 */
export const WorkflowConfigSchema = obj({
  version: lit(WORKFLOW_CONFIG_VERSION),
  /** 供继承流程缺省的 Agent 使用的模型。 */
  model: opt(str({ pattern: AGENT_SPECS[DEFAULT_AGENT].modelPattern.source })),
  /** 供继承流程缺省的 Agent 使用的思考等级。 */
  thinking: opt(ThinkingLevelSchema),
  /** 返工上限：没写 maxVisits 的环节用它；不写是 DEFAULT_MAX_REPAIR_ROUNDS。 */
  maxRepairRounds: opt(int({ minimum: 0 })),
  stages: arr(WorkflowStageConfigSchema, { minItems: 1 }),
});
export type WorkflowConfig = Static<typeof WorkflowConfigSchema>;

/**
 * 问题码：
 * - 任一问题都使整份配置不可用，reason 取问题清单中的首个问题码。
 * - 问题码保持稳定，供命令行展示。
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
  "invalid_agent",
  "invalid_model",
  "invalid_thinking",
  "invalid_max_repair_rounds",
  "duplicate_report_enum",
  "undeclared_verdict_value",
  "unknown_on_verdict_target",
  "unbounded_repair_cycle",
] as const;
export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];

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
