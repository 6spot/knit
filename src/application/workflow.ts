/**
 * 生效流程读取（设计 §4／§9）：把 `.knit/workflow.yaml` 读成 `WorkflowDefinition`。
 *
 * - 文件存在：按配置解析；任一问题降级为 start → deliver（domain/workflow.ts 给出问题与行号）。
 * - 文件缺失：使用内置默认模板（与 `knit workflow init` 生成的默认流程一致），
 *   不算降级，保证尚未初始化流程配置的项目行为不变。
 * - 阶段缺省上限取 `config.workflow.maxRepairRounds`；配置不可读时用内置缺省。
 *
 * 本模块只做 IO 装配；解析、校验与降级判定在 domain/workflow.ts。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import type { RunStageDefinition } from "../contracts/run.js";
import { DEFAULT_WORKFLOW_YAML, parseWorkflow, type WorkflowDefinition, type WorkflowLoadResult, type WorkflowStage } from "../domain/workflow.js";
import { isDecisionStage } from "../domain/report.js";
import type { WorkflowMode } from "../contracts/workflow.js";
import { defaultConfig, parseConfig } from "./config.js";

/** 项目配置里的修复轮次上限；读不到或非法时用内置缺省，不阻塞流程读取。 */
export function workflowMaxRepairRounds(root: string): number {
  try {
    return parseConfig(readFileSync(join(root, ".knit", "config.json"), "utf8")).workflow.maxRepairRounds;
  } catch {
    return defaultConfig().workflow.maxRepairRounds;
  }
}

/** 读取生效流程与降级诊断；文件缺失按内置默认模板（config 模式）处理。 */
export function loadWorkflow(root: string): WorkflowLoadResult {
  const options = { maxRepairRounds: workflowMaxRepairRounds(root) };
  const path = join(root, WORKFLOW_CONFIG_PATH);
  if (!existsSync(path)) return parseWorkflow(DEFAULT_WORKFLOW_YAML, options);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return parseWorkflow("", options);
  }
  return parseWorkflow(source, options);
}

/** 常用入口：只取生效定义，诊断由 `loadWorkflow` 提供。 */
export function workflowOf(root: string): WorkflowDefinition {
  return loadWorkflow(root).workflow;
}

/** 阶段定义；不存在返回 null（锚点或旧值）。 */
export function workflowStageOf(workflow: WorkflowDefinition, stage: string): WorkflowDefinition["stages"][number] | null {
  return workflow.stages.find((entry) => entry.id === stage) ?? null;
}

/**
 * 冻结 prepare 时的生效阶段定义（设计 §9）。run 请求保存这份快照后，
 * 配置在途降级或改动不再影响该 run 的提示词、报告声明、结论语义与工具面。
 * 返回全新普通对象，避免后续配置对象被修改时影响已发布请求。
 */
export function freezeStageDefinition(stage: WorkflowStage | null): RunStageDefinition | null {
  if (stage === null) return null;
  return {
    id: stage.id,
    name: stage.name,
    description: stage.description,
    prompt: stage.prompt,
    tools: stage.tools === null ? null : [...stage.tools],
    report: Object.fromEntries(
      Object.entries(stage.report).map(([field, type]) => [field, Array.isArray(type) ? [...type] : type]),
    ),
    onVerdict: { ...stage.onVerdict },
    maxVisits: stage.maxVisits,
    decision: isDecisionStage(stage),
  };
}

/** 配置声明的业务阶段 id（不含内置锚点）；顺序即流转顺序。 */
export function workflowStageIds(workflow: WorkflowDefinition): string[] {
  return workflow.stages.map((stage) => stage.id);
}

/** 核心对外给出的合法阶段清单；读取配置失败时用来说明可用目标。 */
export function legalStageList(workflow: WorkflowDefinition, includeAnchors = true): string {
  const ids = [...(includeAnchors ? workflow.anchors : []), ...workflowStageIds(workflow)];
  return ids.length === 0 ? "无" : ids.join("、");
}

const ANCHOR_NAMES: Record<string, string> = {
  start: "准备",
  deliver: "收尾",
};

const ANCHOR_DESCRIPTIONS: Record<string, string> = {
  start: "需求澄清、任务选择与实施授权",
  deliver: "交付协调、归档与结果汇报",
};

function displayNameOf(workflow: WorkflowDefinition, stage: string, frozen: WorkflowStage | null = null): string {
  if (stage in ANCHOR_NAMES) return ANCHOR_NAMES[stage]!;
  return workflowStageOf(workflow, stage)?.name ?? (frozen?.id === stage ? frozen.name : stage);
}

function completionConditionOf(
  workflow: WorkflowDefinition,
  stage: string,
  frozen: WorkflowStage | null = null,
): string {
  const definition = workflowStageOf(workflow, stage) ?? (frozen?.id === stage ? frozen : null);
  if (stage === "start") {
    const first = workflow.stages[0];
    return first === undefined ? "直接进入收尾" : `ready → ${first.name}`;
  }
  if (stage === "deliver") return "业务完成并收尾";
  if (definition === null) return "阶段不在生效流程中；写操作拒绝";
  // 配置在途降级：冻结阶段仍按该 run 的定义执行，完成后进入收尾（设计 §9）。
  if (workflow.stages.length === 0) return `完成后 → ${displayNameOf(workflow, "deliver")}`;
  const entries = Object.entries(definition.onVerdict);
  const nextIndex = workflow.stages.findIndex((entry) => entry.id === stage) + 1;
  const next = workflow.stages[nextIndex]?.name ?? displayNameOf(workflow, "deliver", frozen);
  const parts = entries.map(
    ([value, target]) => `${value} → ${displayNameOf(workflow, target, frozen)}`,
  );
  if (parts.length === 0) return `完成后 → ${next}`;
  parts.push(`其他 → ${next}`);
  return parts.join("；");
}

/**
 * 每轮上下文最上方的提示行（设计 §5.5）：只使用 `name`／`description` 渲染，
 * agent 不需要解析 id 或配置结构。降级时把原因直接写在流程行，禁止静默。
 * 传入冻结阶段时，名称／说明取冻结值：在途 run 不受配置降级影响。
 */
export function stageBriefOf(
  workflow: WorkflowDefinition,
  stage: string,
  mode: WorkflowMode,
  fallbackReason: string | null = null,
  frozenStage: WorkflowStage | null = null,
): string {
  const chain = ["准备", ...workflow.stages.map((entry) => entry.name), "收尾"].join(" → ");
  const current = displayNameOf(workflow, stage, frozenStage);
  const definition = workflowStageOf(workflow, stage);
  const effective = definition ?? (frozenStage?.id === stage ? frozenStage : null);
  const fallbackLegacy = mode === "fallback" && effective === null && !(stage in ANCHOR_NAMES);
  const configuredGoal = stage in ANCHOR_DESCRIPTIONS ? ANCHOR_DESCRIPTIONS[stage] : effective?.description;
  const goal = fallbackLegacy
    ? "配置降级：按默认 agent 行为执行"
    : configuredGoal !== undefined && configuredGoal !== null && configuredGoal !== ""
      ? configuredGoal
      : effective === null
        ? "按当前任务资料执行"
        : `执行 ${effective.name}`;
  const completion = fallbackLegacy
    ? "完成后 → 收尾"
    : completionConditionOf(workflow, stage, frozenStage);
  const modeNote = mode === "fallback" ? `（配置降级：${fallbackReason ?? "invalid_config"}）` : "";
  return [
    `流程：${chain}${modeNote} ｜ 当前：${current}`,
    `本步目标：${goal}`,
    `完成条件：${completion}`,
  ].join("\n");
}
