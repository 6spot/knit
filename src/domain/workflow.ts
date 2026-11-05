/**
 * `.knit/workflow.yaml` 解析、语义校验与降级（设计 §4／§9／§10）。
 *
 * 纯数据层：只接收 YAML 文本，不读文件、不看配置目录；文件读取由应用层完成。
 * 读取流程：
 * 1. 用 yaml@2.9.0 解析文档；YAML 语法错误带行号，整份配置降级。
 * 2. 预检 version 与 stages，再按 contracts/workflow.ts 的 schema 校验结构。
 * 3. 语义校验：阶段 id、锚点保留字、onVerdict 目标与声明值、回退环上限。
 * 4. 全部通过才返回 mode=config；任一问题返回 mode=fallback，
 *    生效流程为空 stages（start → deliver），并附稳定原因码与全部问题。
 *
 * 注释只影响源文件行号，不影响 WorkflowDefinition；定义中不保存行号，
 * 因此只改注释不会改变解析结果或任何比较结果。
 */
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLError } from "yaml";
import type { ValidationError } from "@earendil-works/pi-schema";
import { schemaErrors } from "../contracts/schema.js";
import {
  WORKFLOW_ANCHORS,
  WORKFLOW_CONFIG_VERSION,
  WORKFLOW_STAGE_ID_REGEX,
  WORKFLOW_VERDICT_ANCHOR,
  WorkflowConfigSchema,
  isReportEnum,
  isWorkflowAnchor,
  type ReportFieldType,
  type ToolCapability,
  type WorkflowAnchor,
  type WorkflowConfig,
  type WorkflowIssue,
  type WorkflowIssueCode,
  type WorkflowMode,
  type WorkflowStageConfig,
  type WorkflowValidation,
} from "../contracts/workflow.js";

/** 与 defaultConfig().workflow.maxRepairRounds 一致；调用方可显式传入配置值。 */
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;

export interface WorkflowStage {
  id: string;
  /** 显示名；配置缺省时等于 id。 */
  name: string;
  /** 本步说明；缺省 null。 */
  description: string | null;
  /** 项目相对提示词路径；缺省 null，表示用核心默认 agent 指令。 */
  prompt: string | null;
  /** 能力白名单；null 表示全部放开。 */
  tools: readonly ToolCapability[] | null;
  /** 额外报告字段；空对象表示只校验固定字段。 */
  report: Readonly<Record<string, ReportFieldType>>;
  /** 报告值 → 阶段 id 或 deliver；未命中走顺序下一阶段。 */
  onVerdict: Readonly<Record<string, string>>;
  /** 生效的访问上限；null 表示无上限（只允许出现在非回退环阶段）。 */
  maxVisits: number | null;
}

export interface WorkflowDefinition {
  version: typeof WORKFLOW_CONFIG_VERSION;
  /** 内置锚点；降级时 stages 为空，流程即 start → deliver。 */
  anchors: readonly WorkflowAnchor[];
  /** 有序阶段；顺序即流转顺序。 */
  stages: readonly WorkflowStage[];
  /** 阶段缺省访问上限；null 表示调用方没有给出有效 config.workflow.maxRepairRounds。 */
  defaultMaxVisits: number | null;
}

export interface ParseWorkflowOptions {
  /**
   * config.workflow.maxRepairRounds 的当前值，作为阶段 maxVisits 的缺省。
   * 缺省用 DEFAULT_MAX_REPAIR_ROUNDS；传入负数或非整数视为没有有效缺省（null）。
   */
  maxRepairRounds?: number;
}

export interface WorkflowLoadResult {
  /** 生效流程：mode=config 时为完整配置；mode=fallback 时 stages 为空。 */
  workflow: WorkflowDefinition;
  mode: WorkflowMode;
  validation: WorkflowValidation;
}

/**
 * 默认流程模板（供 `knit workflow init` 与测试使用）。
 * 顶注释写全字段、能力表、内置锚点和常见错误；注释不参与解析。
 */
export const DEFAULT_WORKFLOW_YAML = `# Knit 流程配置 .knit/workflow.yaml
#
# version 必填，当前只支持 1。
# stages 必填，是有序阶段列表（至少一个）；数组顺序就是流转顺序。
# 内置锚点 start（准备／讨论）与 deliver（收尾）不写在 stages 里，id 也不能取这两个值。
#
# 阶段字段：
#   id          必填，^[a-z][a-z0-9-]{0,31}$，全文件唯一；写入 task.md 的 stage。
#   name        可选，显示名；缺省用 id。
#   description 可选，本步说明；用于顶部提示与 workflow show。
#   prompt      可选，项目相对路径；缺省或文件缺失时用核心默认 agent 指令。
#   tools       可选，能力白名单；不写 = 全部放开，写了 = 只允许列出的能力：
#                 read      只读：read／grep／find／ls
#                 write     改文件：write／edit
#                 exec      执行命令：bash（可能间接改文件）
#                 task      任务／上下文工具（knit_*）
#                 external  放开项目扩展、MCP 与技能（显式 opt-in）
#                 network   放开网络（显式 opt-in；默认阶段离线）
#   report      可选，额外报告字段：string／string[]／paths／bool／枚举数组（如 [pass, blocked]）。
#               固定字段 summary／validation／blockers 不需要声明。
#   onVerdict   可选，报告值 → 跳转目标；目标必须是已声明阶段 id 或 deliver。
#               键必须是某个 report 枚举字段声明的值；未命中走顺序下一阶段。
#   maxVisits   可选，阶段访问上限（非负整数）；回退环上缺省用 config.workflow.maxRepairRounds。
#               回退环上所有阶段都没有有限上限时，整份配置降级。
#
# 常见错误（都会降级为 start → deliver，并给出含行号的原因）：
#   - 漏写 version 或写成 2；stages 为空；根节点不是映射
#   - id 大写、超长、重复，或使用保留锚点 start／deliver
#   - tools 写未知能力；report 写未知类型、空枚举数组或重复枚举值
#   - onVerdict 指向不存在的阶段，或键未在 report 枚举中声明
#   - 回退环上所有阶段都缺有限上限（maxVisits 为 null 且没有 workflow.maxRepairRounds）
#   - YAML 缩进错误、冒号后缺空格、重复键
#
# 降级时只对新 run 生效：当前 run 继续跑完并正常接收；生效流程不套提示词，
# 使用默认 agent 行为。knit workflow validate 可查看全部问题与行号。
version: 1
stages:
  - id: implement
    name: 实现
    description: 按 task.md 完成产出并运行范围验证
    prompt: .knit/agents/implement.md
    tools: [read, write, exec]
    report:
      changedPaths: paths
      unverified: string[]
  - id: check
    name: 检查
    description: 独立核对完成条件与实现成果
    prompt: .knit/agents/check.md
    tools: [read, exec]
    report:
      verdict: [pass, changes_requested, blocked]
      coverage: string[]
      changedPaths: paths
      selfVerified: bool
      findings: string[]
      unverified: string[]
    onVerdict:
      changes_requested: implement
      # blocked 保留在本阶段复查，不顺序前进。
      blocked: check
`;

/**
 * 解析并校验配置；任何非法配置都返回可运行的降级定义，不抛异常。
 * `source` 为空、缺字段、类型错误、语义冲突均按 validation.issues 说明。
 */
export function parseWorkflow(source: string, options: ParseWorkflowOptions = {}): WorkflowLoadResult {
  const defaultMaxVisits = resolveDefaultMaxVisits(options.maxRepairRounds);
  const lineCounter = new LineCounter();
  let document;
  try {
    document = parseDocument(source, { lineCounter });
  } catch (error) {
    return fallbackResult(defaultMaxVisits, [unexpectedYamlIssue(error)]);
  }
  if (document.errors.length > 0) {
    return fallbackResult(defaultMaxVisits, document.errors.map((error) => yamlIssue(error)));
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return fallbackResult(defaultMaxVisits, [unexpectedYamlIssue(error)]);
  }

  const positions = new SourcePositions(lineCounter);
  if (document.contents !== null) positions.index(document.contents);

  if (!isRecord(raw)) {
    return fallbackResult(defaultMaxVisits, [
      makeIssue("invalid_structure", positions.at(""), "", "配置根必须是映射（key: value）"),
    ]);
  }

  if (raw.version !== WORKFLOW_CONFIG_VERSION) {
    return fallbackResult(defaultMaxVisits, [
      makeIssue(
        "unsupported_version",
        positions.at("/version"),
        "/version",
        `version 只支持 ${WORKFLOW_CONFIG_VERSION}（当前为 ${describeValue(raw.version)}）`,
      ),
    ]);
  }

  if (!Array.isArray(raw.stages)) {
    const code: WorkflowIssueCode = raw.stages === undefined ? "empty_stages" : "invalid_structure";
    return fallbackResult(defaultMaxVisits, [
      makeIssue(
        code,
        positions.at("/stages"),
        "/stages",
        raw.stages === undefined ? "缺少 stages；至少需要声明一个阶段" : "stages 必须是有序数组",
      ),
    ]);
  }
  if (raw.stages.length === 0) {
    return fallbackResult(defaultMaxVisits, [
      makeIssue("empty_stages", positions.at("/stages"), "/stages", "stages 不能为空；至少需要声明一个阶段"),
    ]);
  }

  const structuralProblems = schemaErrors(WorkflowConfigSchema, raw);
  if (structuralProblems.length > 0) {
    return fallbackResult(
      defaultMaxVisits,
      structuralProblems.map((error) => schemaIssue(error, positions)),
    );
  }

  const config = raw as unknown as WorkflowConfig;
  const semanticProblems = validateSemantics(config, defaultMaxVisits, positions);
  if (semanticProblems.length > 0) {
    return fallbackResult(defaultMaxVisits, semanticProblems);
  }

  return {
    workflow: workflowFromConfig(config, defaultMaxVisits),
    mode: "config",
    validation: { ok: true, issues: [], reason: null },
  };
}

/** 降级定义：没有阶段，流程只含内置锚点 start → deliver；不套任何提示词。 */
export function fallbackWorkflowDefinition(
  defaultMaxVisits: number | null = DEFAULT_MAX_REPAIR_ROUNDS,
): WorkflowDefinition {
  return {
    version: WORKFLOW_CONFIG_VERSION,
    anchors: WORKFLOW_ANCHORS,
    stages: [],
    defaultMaxVisits,
  };
}

interface SourcePosition {
  line: number;
  column: number;
}

/** 由 YAML AST 建立 JSON Pointer → 源位置的索引；注释与空行不进入索引。 */
class SourcePositions {
  private readonly positions = new Map<string, SourcePosition>();

  constructor(private readonly lineCounter: LineCounter) {}

  index(node: Node, pointer = "", fallback: SourcePosition = { line: 1, column: 1 }): void {
    const position = this.positionOf(node, fallback);
    this.positions.set(pointer, position);
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : "";
        const child = joinPointer(pointer, key);
        const keyPosition = this.positionOf(pair.key, position);
        this.positions.set(child, keyPosition);
        if (isNode(pair.value)) this.index(pair.value, child, keyPosition);
      }
      return;
    }
    if (isSeq(node)) {
      for (const [index, item] of node.items.entries()) {
        if (isNode(item)) this.index(item, joinPointer(pointer, String(index)), position);
      }
    }
  }

  at(pointer: string): SourcePosition {
    let current = pointer;
    while (true) {
      const found = this.positions.get(current);
      if (found !== undefined) return found;
      if (current === "") return { line: 1, column: 1 };
      const cut = current.lastIndexOf("/");
      current = cut <= 0 ? "" : current.slice(0, cut);
    }
  }

  private positionOf(node: unknown, fallback: SourcePosition): SourcePosition {
    if (typeof node !== "object" || node === null) return fallback;
    const range = (node as Node).range;
    if (!range) return fallback;
    const position = this.lineCounter.linePos(range[0]);
    return { line: position.line, column: position.col };
  }
}

function validateSemantics(
  config: WorkflowConfig,
  defaultMaxVisits: number | null,
  positions: SourcePositions,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const stageIndexById = new Map<string, number>();
  const duplicateIds = new Set<string>();

  config.stages.forEach((stage, index) => {
    const idPointer = `/stages/${index}/id`;
    if (!WORKFLOW_STAGE_ID_REGEX.test(stage.id)) {
      // schema 已覆盖，保留兜底以免未来放宽 schema 时漏检。
      issues.push(
        makeIssue(
          "invalid_stage_id",
          positions.at(idPointer),
          idPointer,
          `阶段 id "${stage.id}" 不符合规则 ^[a-z][a-z0-9-]{0,31}$`,
        ),
      );
    }
    if (isWorkflowAnchor(stage.id)) {
      issues.push(
        makeIssue(
          "reserved_stage_id",
          positions.at(idPointer),
          idPointer,
          `阶段 id "${stage.id}" 是内置锚点，不能作为阶段 id`,
        ),
      );
    }
    const existing = stageIndexById.get(stage.id);
    if (existing === undefined) {
      stageIndexById.set(stage.id, index);
    } else {
      duplicateIds.add(stage.id);
      issues.push(
        makeIssue(
          "duplicate_stage_id",
          positions.at(idPointer),
          idPointer,
          `阶段 id "${stage.id}" 重复（首次出现在第 ${existing + 1} 个阶段）`,
        ),
      );
    }
  });

  // 目标存在性必须在全部 id 收集完后判断，允许前向引用。
  config.stages.forEach((stage, index) => {
    const reportPointer = `/stages/${index}/report`;
    for (const [field, type] of Object.entries(stage.report ?? {})) {
      if (!isReportEnum(type)) continue;
      const pointer = joinPointer(reportPointer, field);
      if (type.length === 0) {
        issues.push(
          makeIssue("invalid_report", positions.at(pointer), pointer, `报告字段 "${field}" 的枚举数组不能为空`),
        );
        continue;
      }
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const value of type) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
      }
      if (duplicates.size > 0) {
        issues.push(
          makeIssue(
            "duplicate_report_enum",
            positions.at(pointer),
            pointer,
            `报告字段 "${field}" 的枚举值重复：${[...duplicates].join("、")}`,
          ),
        );
      }
    }

    const declaredVerdicts = new Set<string>();
    for (const type of Object.values(stage.report ?? {})) {
      if (isReportEnum(type)) for (const value of type) declaredVerdicts.add(value);
    }
    for (const [value, target] of Object.entries(stage.onVerdict ?? {})) {
      const pointer = joinPointer(`/stages/${index}/onVerdict`, value);
      const position = positions.at(pointer);
      if (!declaredVerdicts.has(value)) {
        issues.push(
          makeIssue(
            "undeclared_verdict_value",
            position,
            pointer,
            `onVerdict 键 "${value}" 未在 report 的枚举字段中声明`,
          ),
        );
      }
      if (target !== WORKFLOW_VERDICT_ANCHOR && !stageIndexById.has(target)) {
        issues.push(
          makeIssue(
            "unknown_on_verdict_target",
            position,
            pointer,
            `onVerdict 目标 "${target}" 不存在；只能是已声明阶段 id 或 ${WORKFLOW_VERDICT_ANCHOR}`,
          ),
        );
      }
    }
  });

  if (duplicateIds.size === 0) {
    // 只有“无上限”阶段之间成环才真正无法停止；环上只要有一个有限上限节点，
    // 转移层到点后会停下。这样不把“环上某个阶段显式 null、其他阶段有默认上限”误判为坏配置。
    const unlimited = new Set<string>();
    config.stages.forEach((stage) => {
      const effectiveLimit = stage.maxVisits === undefined ? defaultMaxVisits : stage.maxVisits;
      if (effectiveLimit === null) unlimited.add(stage.id);
    });
    for (const id of cyclicStageIds(config.stages, unlimited)) {
      const index = stageIndexById.get(id);
      if (index === undefined) continue;
      const stage = config.stages[index];
      if (stage === undefined) continue;
      const pointer = stage.maxVisits === undefined ? `/stages/${index}` : `/stages/${index}/maxVisits`;
      issues.push(
        makeIssue(
          "unbounded_repair_cycle",
          positions.at(pointer),
          pointer,
          `阶段 "${id}" 所在回退环没有任何有限访问上限（maxVisits 与 workflow.maxRepairRounds 均为 null）`,
        ),
      );
    }
  }

  return issues;
}

/**
 * 阶段图：顺序边 i → i+1，加上 onVerdict 目标边；返回位于任一环上的阶段 id。
 * `only` 非空时只保留这些节点，用来检查“无上限阶段”子图是否仍有环。
 */
function cyclicStageIds(
  stages: readonly WorkflowStageConfig[],
  only?: ReadonlySet<string>,
): ReadonlySet<string> {
  const known = new Set(stages.map((stage) => stage.id));
  const included = (id: string): boolean => known.has(id) && (only === undefined || only.has(id));
  const adjacency = new Map<string, string[]>();
  stages.forEach((stage, index) => {
    if (!included(stage.id)) return;
    const targets = new Set<string>();
    const next = stages[index + 1];
    if (next !== undefined && included(next.id)) targets.add(next.id);
    for (const target of Object.values(stage.onVerdict ?? {})) {
      if (target !== WORKFLOW_VERDICT_ANCHOR && included(target)) targets.add(target);
    }
    adjacency.set(stage.id, [...targets]);
  });

  let counter = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();

  const visit = (id: string): void => {
    indices.set(id, counter);
    lowLinks.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);

    for (const next of adjacency.get(id) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(next)!));
      } else if (onStack.has(next)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(next)!));
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1 || (adjacency.get(id) ?? []).includes(id)) {
      for (const memberId of component) cyclic.add(memberId);
    }
  };

  for (const id of adjacency.keys()) {
    if (!indices.has(id)) visit(id);
  }
  return cyclic;
}

function workflowFromConfig(config: WorkflowConfig, defaultMaxVisits: number | null): WorkflowDefinition {
  return {
    version: WORKFLOW_CONFIG_VERSION,
    anchors: WORKFLOW_ANCHORS,
    stages: config.stages.map((stage) => normalizeStage(stage, defaultMaxVisits)),
    defaultMaxVisits,
  };
}

function normalizeStage(stage: WorkflowStageConfig, defaultMaxVisits: number | null): WorkflowStage {
  return {
    id: stage.id,
    name: stage.name !== undefined && stage.name.length > 0 ? stage.name : stage.id,
    description: stage.description ?? null,
    prompt: stage.prompt ?? null,
    tools: stage.tools === undefined ? null : [...stage.tools],
    report: copyReport(stage.report ?? {}),
    onVerdict: { ...(stage.onVerdict ?? {}) },
    maxVisits: stage.maxVisits === undefined ? defaultMaxVisits : stage.maxVisits,
  };
}

function copyReport(report: Readonly<Record<string, ReportFieldType>>): Record<string, ReportFieldType> {
  const copy: Record<string, ReportFieldType> = {};
  for (const [field, type] of Object.entries(report)) {
    copy[field] = isReportEnum(type) ? [...type] : type;
  }
  return copy;
}

function fallbackResult(
  defaultMaxVisits: number | null,
  problems: readonly WorkflowIssue[],
): WorkflowLoadResult {
  const issues = orderedIssues(problems);
  return {
    workflow: fallbackWorkflowDefinition(defaultMaxVisits),
    mode: "fallback",
    validation: {
      ok: false,
      issues,
      reason: issues[0]?.code ?? "invalid_structure",
    },
  };
}

function orderedIssues(problems: readonly WorkflowIssue[]): WorkflowIssue[] {
  const unique = new Map<string, WorkflowIssue>();
  for (const problem of problems) {
    const key = `${problem.code}\u0000${problem.path}\u0000${problem.message}`;
    if (!unique.has(key)) unique.set(key, problem);
  }
  return [...unique.values()].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    const byPath = a.path.localeCompare(b.path);
    return byPath !== 0 ? byPath : a.code.localeCompare(b.code);
  });
}

function makeIssue(
  code: WorkflowIssueCode,
  position: SourcePosition,
  path: string,
  message: string,
): WorkflowIssue {
  return {
    code,
    line: Math.max(1, position.line),
    column: Math.max(1, position.column),
    path,
    message: `第 ${Math.max(1, position.line)} 行：${message}`,
  };
}

function yamlIssue(error: YAMLError): WorkflowIssue {
  const position = error.linePos?.[0] ?? { line: 1, col: 1 };
  const detail = error.message.split("\n")[0] ?? "YAML 解析失败";
  return makeIssue("yaml_parse_error", { line: position.line, column: position.col }, "", `YAML 解析失败：${detail}`);
}

function unexpectedYamlIssue(error: unknown): WorkflowIssue {
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return makeIssue("yaml_parse_error", { line: 1, column: 1 }, "", `YAML 解析失败：${message ?? "未知错误"}`);
}

function schemaIssue(error: ValidationError, positions: SourcePositions): WorkflowIssue {
  const code = schemaIssueCode(error.path);
  return makeIssue(code, positions.at(error.path), error.path, schemaIssueMessage(code, error));
}

function schemaIssueCode(pointer: string): WorkflowIssueCode {
  const segments = pointerSegments(pointer);
  if (segments[0] === "version") return "unsupported_version";
  if (segments[0] === "stages" && segments.length >= 3) {
    switch (segments[2]) {
      case "id":
        return "invalid_stage_id";
      case "tools":
        return "invalid_tools";
      case "report":
        return "invalid_report";
      case "onVerdict":
        return "invalid_on_verdict";
      case "maxVisits":
        return "invalid_max_visits";
      default:
        return "invalid_structure";
    }
  }
  return "invalid_structure";
}

function schemaIssueMessage(code: WorkflowIssueCode, error: ValidationError): string {
  const path = readablePath(error.path);
  switch (code) {
    case "invalid_stage_id":
      return `${path} 缺失或不符合阶段 id 规则 ^[a-z][a-z0-9-]{0,31}$`;
    case "invalid_tools":
      return `${path} 含无效能力；只允许 read／write／exec／task／external／network`;
    case "invalid_report":
      return `${path} 含无效报告类型；只允许 string／string[]／paths／bool 或非空字符串枚举数组`;
    case "invalid_on_verdict":
      return `${path} 的跳转目标必须是非空字符串`;
    case "invalid_max_visits":
      return `${path} 必须是非负整数或 null`;
    case "unsupported_version":
      return `version 只支持 ${WORKFLOW_CONFIG_VERSION}`;
    default:
      if (error.keyword === "additionalProperties") return `${path} 不是已知配置字段`;
      return `${path} 不符合配置结构（${error.message}）`;
  }
}

function resolveDefaultMaxVisits(value: number | undefined): number | null {
  if (value === undefined) return DEFAULT_MAX_REPAIR_ROUNDS;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === undefined) return "缺失";
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function joinPointer(pointer: string, segment: string): string {
  return `${pointer}/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readablePath(pointer: string): string {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return "配置根";
  let result = "";
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) result += `[${segment}]`;
    else result += result === "" ? segment : `.${segment}`;
  }
  return result;
}
