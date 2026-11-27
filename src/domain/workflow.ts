/**
 * `.knit/workflow.yaml` 的解析与语义校验。
 *
 * 纯数据层：只接收 YAML 文本，不读文件、不看配置目录；文件读取由调用方完成。
 * 读取流程：
 * 1. 用 yaml 解析文档；YAML 语法错误带行号。
 * 2. 预检 version 与 stages，再按 contracts/workflow.ts 的 schema 校验结构。
 * 3. 校验执行器的参数、ID 和并行工具权限，再核对阶段 ID、onVerdict 跳转和回退环上限。
 * 4. 全部通过才返回流程定义；任一问题都不返回流程定义，只给出稳定问题码与全部问题。
 *
 * 注释只影响源文件行号，不影响 WorkflowDefinition；定义中不保存行号，
 * 因此只改注释不会改变解析结果或任何比较结果。
 */
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLError } from "yaml";
import type { ValidationError } from "@earendil-works/pi-schema";
import { projectRelative } from "../infrastructure/paths.js";
import { checkSchema, schemaErrors } from "../contracts/primitives.js";
import {
  WORKFLOW_ANCHORS,
  WORKFLOW_CONFIG_VERSION,
  WORKFLOW_STAGE_ID_REGEX,
  WORKFLOW_VERDICT_ANCHOR,
  TOOLS_ALL_REGEX,
  AGENT_SPECS,
  AgentNameSchema,
  DEFAULT_AGENT,
  type AgentName,
  WorkflowConfigSchema,
  isReportEnum,
  isWorkflowAnchor,
  type ReportFieldType,
  type ToolCapability,
  type ThinkingLevel,
  type WorkflowAnchor,
  type WorkflowConfig,
  type WorkflowIssue,
  type WorkflowIssueCode,
  type WorkflowStageConfig,
  type WorkflowValidation,
} from "../contracts/workflow.js";

/** 缺省的返工上限；调用方可显式传入配置值。 */
export const DEFAULT_MAX_REPAIR_ROUNDS = 5;

export interface WorkflowExecutor {
  id: string;
  agent: AgentName | null;
  model: string | null;
  thinking: ThinkingLevel | null;
  /** 项目相对提示词路径；缺省 null，表示用核心默认 agent 指令。 */
  prompt: string | null;
}

export interface WorkflowStage extends Pick<WorkflowExecutor, "agent" | "model" | "thinking" | "prompt"> {
  id: string;
  /** 显示名；配置缺省时等于 id。 */
  name: string;
  /** 本步说明；缺省 null。 */
  description: string | null;
  resume: boolean;
  readonly sharedPrompt?: string;
  executors: readonly WorkflowExecutor[];
  /** 能力白名单；null 表示全部放开（不写或 `all`），空数组表示全部禁用。 */
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
  /** 内置锚点：流程固定从 discuss 开始、到 deliver 结束。 */
  anchors: readonly WorkflowAnchor[];
  /** 有序阶段；顺序即流转顺序。 */
  stages: readonly WorkflowStage[];
  /** Pi 环节的流程缺省。 */
  model: string | null;
  thinking: ThinkingLevel | null;
  /** 阶段缺省访问上限：文件顶层的 maxRepairRounds，没写时是 DEFAULT_MAX_REPAIR_ROUNDS。 */
  defaultMaxVisits: number;
}

/** 内置锚点显示名；配置阶段仍用各自声明的 name。 */
export const WORKFLOW_ANCHOR_NAMES: Readonly<Record<WorkflowAnchor, string>> = {
  discuss: "讨论",
  deliver: "收尾",
};

/** 阶段显示名：内置锚点用固定名，配置阶段用 name，缺失退回 id。 */
export function workflowStageDisplayName(workflow: WorkflowDefinition, stage: string): string {
  if (isWorkflowAnchor(stage)) return WORKFLOW_ANCHOR_NAMES[stage];
  return workflow.stages.find((entry) => entry.id === stage)?.name ?? stage;
}

export function workflowPrompts(workflow: WorkflowDefinition): string[] {
  return [...new Set(workflow.stages.flatMap((stage) => [stage.sharedPrompt ?? stage.prompt, ...stage.executors.map((executor) => executor.prompt)]
    .filter((path) => path !== null)))];
}

export interface WorkflowLoadResult {
  /** 流程定义；配置有问题时为 null，问题见 validation.issues。 */
  workflow: WorkflowDefinition | null;
  validation: WorkflowValidation;
}

/**
 * 解析并校验配置；配置有问题时 workflow 为 null，不抛异常。
 * `source` 为空、缺字段、类型错误、语义冲突均按 validation.issues 说明。
 */
export function parseWorkflow(source: string): WorkflowLoadResult {
  const lineCounter = new LineCounter();
  let document;
  try {
    document = parseDocument(source, { lineCounter });
  } catch (error) {
    return invalidResult([unexpectedYamlIssue(error)]);
  }
  if (document.errors.length > 0) {
    return invalidResult(document.errors.map((error) => yamlIssue(error)));
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return invalidResult([unexpectedYamlIssue(error)]);
  }

  const positions = new SourcePositions(lineCounter);
  if (document.contents !== null) positions.index(document.contents);

  if (!isRecord(raw)) {
    return invalidResult([
      makeIssue("invalid_structure", positions.at(""), "", "配置根必须是映射（key: value）"),
    ]);
  }

  if (raw.version !== WORKFLOW_CONFIG_VERSION) {
    return invalidResult([
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
    return invalidResult([
      makeIssue(
        code,
        positions.at("/stages"),
        "/stages",
        raw.stages === undefined ? "缺少 stages；至少需要声明一个阶段" : "stages 必须是有序数组",
      ),
    ]);
  }
  if (raw.stages.length === 0) {
    return invalidResult([
      makeIssue("empty_stages", positions.at("/stages"), "/stages", "stages 不能为空；至少需要声明一个阶段"),
    ]);
  }

  const fieldProblems = [
    ...schemaErrors(WorkflowConfigSchema, raw).map((error) => schemaIssue(error, positions, raw)),
    ...raw.stages.flatMap((stage: unknown, index) => stageExecutorIssues(stage, `/stages/${index}`, positions)),
  ];
  if (fieldProblems.length > 0) return invalidResult(fieldProblems);

  const config = raw as unknown as WorkflowConfig;
  const semanticProblems = validateSemantics(config, positions);
  if (semanticProblems.length > 0) {
    return invalidResult(semanticProblems);
  }

  return {
    workflow: workflowFromConfig(config),
    validation: { ok: true, issues: [], reason: null },
  };
}

function stageExecutorIssues(stage: unknown, pointer: string, positions: SourcePositions): WorkflowIssue[] {
  if (!isRecord(stage)) return [];
  if (stage.executors === undefined) return targetParameterIssues(stage, pointer, positions);

  const issues = ["agent", "model", "thinking"].flatMap((field) => {
    if (stage[field] === undefined) return [];
    const path = `${pointer}/${field}`;
    return [makeIssue("conflicting_executor_fields", positions.at(path), path,
      `${readablePath(path)} 与 executors 互斥，请把 ${field} 写在对应的执行器中`)];
  });
  if (!Array.isArray(stage.executors)) return issues;

  const seen = new Set<string>();
  stage.executors.forEach((executor: unknown, index) => {
    if (!isRecord(executor)) return;
    const item = `${pointer}/executors/${index}`;
    issues.push(...targetParameterIssues(executor, item, positions));
    if (executor.id !== undefined && typeof executor.id !== "string") return;
    const id = executorId(executor.id, index);
    if (seen.has(id)) {
      const path = `${item}/id`;
      issues.push(makeIssue("duplicate_executor_id", positions.at(path), path,
        `${readablePath(path)} 的执行器 id "${id}" 重复，请指定环节内唯一的 id`));
    }
    seen.add(id);
  });
  if (stage.executors.length >= 2) {
    const writeIndex = Array.isArray(stage.tools) ? stage.tools.indexOf("write") : -1;
    if (stage.tools === undefined || writeIndex >= 0 || (typeof stage.tools === "string" && TOOLS_ALL_REGEX.test(stage.tools))) {
      const path = `${pointer}/tools${writeIndex >= 0 ? `/${writeIndex}` : ""}`;
      issues.push(makeIssue("parallel_stage_requires_readonly_tools", positions.at(path), path, parallelToolsMessage(readablePath(path))));
    }
  }
  return issues;
}

function executorId(id: string | undefined, index: number): string {
  return id ?? `executor-${index + 1}`;
}

function parallelToolsMessage(path: string): string {
  return `${path} 所在的并行环节必须只读，不得含 write。请显式配置 tools: [read, exec] 或 tools: [read]`;
}

function targetParameterIssues(fields: Record<string, unknown>, pointer: string, positions: SourcePositions): WorkflowIssue[] {
  const target = validateAgentTarget({
    agent: checkSchema(AgentNameSchema, fields.agent) ? fields.agent : null,
    model: typeof fields.model === "string" ? fields.model : null,
    thinking: typeof fields.thinking === "string" ? fields.thinking : null,
  });
  const issues: WorkflowIssue[] = [];
  if (target.modelProblem !== null) {
    const path = `${pointer}/model`;
    issues.push(makeIssue("invalid_model", positions.at(path), path, `${readablePath(path)} ${target.modelProblem}`));
  }
  if (target.thinkingProblem !== null) {
    const path = `${pointer}/thinking`;
    issues.push(makeIssue("invalid_thinking", positions.at(path), path, `${readablePath(path)} ${target.thinkingProblem}`));
  }
  return issues;
}

/** 配置省略 agent 时逐字段接受任一规格，派发时传入实际 agent 和生效的参数。 */
export function validateAgentTarget(target: {
  readonly agent: AgentName | null;
  readonly model: string | null;
  readonly thinking: string | null;
}) {
  const spec = AGENT_SPECS[target.agent ?? DEFAULT_AGENT];
  const candidates = target.agent === null ? Object.values(AGENT_SPECS) : [spec];
  const levels = target.agent === null
    ? [...new Set(candidates.flatMap((candidate) => candidate.thinkingLevels))]
    : spec.thinkingLevels;
  const model = target.model;
  const thinking = levels.find((level) => level === target.thinking) ?? null;
  return {
    modelProblem: model !== null && !candidates.some((candidate) => candidate.modelPattern.test(model))
      ? `要写成 ${spec.modelFormat}` : null,
    thinkingProblem: target.thinking !== null && thinking === null ? `只允许 ${levels.join("／")}` : null,
    thinking,
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

  index(node: Node, pointer = "", inherited: SourcePosition = { line: 1, column: 1 }): void {
    const position = this.positionOf(node, inherited);
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

  private positionOf(node: unknown, inherited: SourcePosition): SourcePosition {
    if (typeof node !== "object" || node === null) return inherited;
    const range = (node as Node).range;
    if (!range) return inherited;
    const position = this.lineCounter.linePos(range[0]);
    return { line: position.line, column: position.col };
  }
}

function validateSemantics(config: WorkflowConfig, positions: SourcePositions): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const stageIndexById = new Map<string, number>();
  const duplicateIds = new Set<string>();

  config.stages.forEach((stage, index) => {
    const stagePointer = `/stages/${index}`;
    const checkPrompt = (prompt: string | undefined, owner: string) => {
      if (prompt === undefined || projectRelative(prompt) !== null) return;
      const path = `${owner}/prompt`;
      issues.push(makeIssue("invalid_structure", positions.at(path), path, `${readablePath(path)} 必须是项目内的相对路径`));
    };
    checkPrompt(stage.prompt, stagePointer);
    stage.executors?.forEach((executor, i) => checkPrompt(executor.prompt, `${stagePointer}/executors/${i}`));
    const idPointer = `${stagePointer}/id`;
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

    const verdict = stage.report?.verdict;
    const declaredVerdicts = Array.isArray(verdict) ? verdict : [];
    if (stage.onVerdict && Object.keys(stage.onVerdict).length === 0 && !Array.isArray(verdict)) {
      const pointer = `/stages/${index}/onVerdict`;
      issues.push(makeIssue("undeclared_verdict_value", positions.at(pointer), pointer, "onVerdict 要求 report.verdict 为枚举字段"));
    }
    for (const [value, target] of Object.entries(stage.onVerdict ?? {})) {
      const pointer = joinPointer(`/stages/${index}/onVerdict`, value);
      const position = positions.at(pointer);
      if (!declaredVerdicts.includes(value)) {
        issues.push(
          makeIssue(
            "undeclared_verdict_value",
            position,
            pointer,
            `onVerdict 键 "${value}" 未在 report.verdict 枚举中声明`,
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
    // 转移层到点后会停下。没写 maxVisits 的环节用返工上限，总是有限的。
    const unlimited = new Set(config.stages.filter((stage) => stage.maxVisits === null).map((stage) => stage.id));
    for (const id of cyclicStageIds(config.stages, unlimited)) {
      const pointer = `/stages/${stageIndexById.get(id)}/maxVisits`;
      issues.push(
        makeIssue(
          "unbounded_repair_cycle",
          positions.at(pointer),
          pointer,
          `阶段 "${id}" 所在回退环上每个环节的 maxVisits 都是 null，返工停不下来`,
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

function workflowFromConfig(config: WorkflowConfig): WorkflowDefinition {
  const defaultMaxVisits = config.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
  return {
    version: WORKFLOW_CONFIG_VERSION,
    anchors: WORKFLOW_ANCHORS,
    stages: config.stages.map((stage) => normalizeStage(stage, defaultMaxVisits)),
    model: config.model ?? null,
    thinking: config.thinking ?? null,
    defaultMaxVisits,
  };
}

function normalizeStage(stage: WorkflowStageConfig, defaultMaxVisits: number): WorkflowStage {
  const executors = (stage.executors ?? [{ ...stage, id: undefined }]).map((executor, index) => ({
    id: executorId(executor.id, index),
    agent: executor.agent ?? null,
    model: executor.model ?? null,
    thinking: executor.thinking ?? null,
    prompt: executor.prompt ?? stage.prompt ?? null,
  }));
  const single = executors.length === 1 ? executors[0] : undefined;
  const prompt = single?.prompt ?? stage.prompt ?? null;
  return {
    id: stage.id,
    name: stage.name !== undefined && stage.name.length > 0 ? stage.name : stage.id,
    description: stage.description ?? null,
    resume: stage.resume ?? false,
    executors,
    agent: single?.agent ?? null,
    model: single?.model ?? null,
    thinking: single?.thinking ?? null,
    prompt,
    ...(stage.prompt && stage.prompt !== prompt ? { sharedPrompt: stage.prompt } : {}),
    tools: normalizeTools(stage.tools),
    report: copyReport(stage.report ?? {}),
    onVerdict: { ...(stage.onVerdict ?? {}) },
    maxVisits: stage.maxVisits === undefined ? defaultMaxVisits : stage.maxVisits,
  };
}

/**
 * `tools` 语义：不写或标量 `all`（大小写不敏感）→ null（全部放开）；
 * `[]` → 空能力（全部禁用）；非空数组 → 白名单。schema 已拒绝列表里的 `all`。
 */
function normalizeTools(tools: WorkflowStageConfig["tools"]): ToolCapability[] | null {
  if (tools === undefined) return null;
  if (typeof tools === "string") return null;
  return [...tools];
}

function copyReport(report: Readonly<Record<string, ReportFieldType>>): Record<string, ReportFieldType> {
  const copy: Record<string, ReportFieldType> = {};
  for (const [field, type] of Object.entries(report)) {
    copy[field] = isReportEnum(type) ? [...type] : type;
  }
  return copy;
}

function invalidResult(problems: readonly WorkflowIssue[]): WorkflowLoadResult {
  const issues = orderedIssues(problems);
  return {
    workflow: null,
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

function schemaIssue(error: ValidationError, positions: SourcePositions, raw: unknown): WorkflowIssue {
  const code = schemaIssueCode(error.path);
  return makeIssue(code, positions.at(error.path), error.path, schemaIssueMessage(code, error, raw));
}

function schemaIssueCode(pointer: string): WorkflowIssueCode {
  const segments = pointerSegments(pointer);
  if (segments[0] === "version") return "unsupported_version";
  if (segments[0] === "model") return "invalid_model";
  if (segments[0] === "thinking") return "invalid_thinking";
  if (segments[0] === "maxRepairRounds") return "invalid_max_repair_rounds";
  if (segments[0] === "stages" && segments.length >= 3) {
    const executorField = segments[2] === "executors";
    if (executorField && segments.length <= 4) return "invalid_executors";
    const field = executorField ? segments[4] : segments[2];
    if (field === "id") return executorField ? "invalid_executor_id" : "invalid_stage_id";
    if (field === "agent") return "invalid_agent";
    if (field === "model") return "invalid_model";
    if (field === "thinking") return "invalid_thinking";
    switch (segments[2]) {
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

function schemaIssueMessage(code: WorkflowIssueCode, error: ValidationError, raw: unknown): string {
  const path = readablePath(error.path);
  if (code === "invalid_tools") return toolsIssueMessage(error.path, path, raw);
  switch (code) {
    case "invalid_executors":
      return `${path} 配置无效，executors 必须是非空数组，每项为执行器配置映射`;
    case "invalid_executor_id":
      return `${path} 不符合执行器 id 规则 ${WORKFLOW_STAGE_ID_REGEX.source}`;
    case "invalid_stage_id":
      return `${path} 缺失或不符合阶段 id 规则 ^[a-z][a-z0-9-]{0,31}$`;
    case "invalid_report":
      return `${path} 含无效报告类型；只允许 string／string[]／paths／bool 或非空字符串枚举数组`;
    case "invalid_on_verdict":
      return `${path} 的跳转目标必须是非空字符串`;
    case "invalid_max_visits":
      return `${path} 必须是非负整数或 null`;
    case "invalid_agent":
      return `${path} 只允许 ${Object.keys(AGENT_SPECS).join("／")}`;
    case "invalid_model":
      return `${path} ${error.path === "/model" ? `要写成 ${AGENT_SPECS[DEFAULT_AGENT].modelFormat}` : "必须是模型 ID 字符串"}`;
    case "invalid_thinking": {
      const stageAgent = valueAtPointer(raw, error.path.replace(/\/thinking$/, "/agent"));
      const spec = AGENT_SPECS[checkSchema(AgentNameSchema, stageAgent) ? stageAgent : DEFAULT_AGENT];
      return `${path} 只允许 ${spec.thinkingLevels.join("／")}`;
    }
    case "invalid_max_repair_rounds":
      return "maxRepairRounds 必须是非负整数";
    case "unsupported_version":
      return `version 只支持 ${WORKFLOW_CONFIG_VERSION}`;
    default:
      if (error.keyword === "additionalProperties") return `${path} 不是已知配置字段`;
      return `${path} 不符合配置结构（${error.message}）`;
  }
}

function toolsIssueMessage(pointer: string, path: string, raw: unknown): string {
  const segments = pointerSegments(pointer);
  const executors = valueAtPointer(raw, `/stages/${segments[1]}/executors`);
  const parallel = Array.isArray(executors) && executors.length >= 2;
  const value = valueAtPointer(raw, pointer);
  const isElement = segments.length > 3;
  if (isElement && typeof value === "string" && TOOLS_ALL_REGEX.test(value)) {
    if (parallel) return `${path} 不能在能力列表里写 all；请显式配置只读能力数组，如 tools: [read, exec]`;
    return `${path} 不能在能力列表里写 all；全部放开请写标量 tools: all 或不写 tools，全部禁用写 tools: []`;
  }
  if (!isElement) {
    if (parallel) return `${path} 的值 ${describeValue(value)} 无效；请显式配置只读能力数组，如 tools: [read, exec]`;
    return `${path} 只能是标量 all（全部放开）或能力数组（[] 为全部禁用）；能力只允许 read／write／exec／external／network`;
  }
  return `${path} 含无效能力 ${describeValue(value)}；只允许 ${parallel ? "read／exec／external／network" : "read／write／exec／external／network"}`;
}

function valueAtPointer(raw: unknown, pointer: string): unknown {
  let current: unknown = raw;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isRecord(current)) current = current[segment];
    else return undefined;
  }
  return current;
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
