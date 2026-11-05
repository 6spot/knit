/**
 * 生效流程读取（设计 §4／§9）：把 `.knit/workflow.yaml` 读成 `WorkflowDefinition`。
 *
 * - 文件存在：按配置解析；任一问题降级为 start → deliver（domain/workflow.ts 给出问题与行号）。
 * - 文件缺失：使用内置默认模板（与 `knit workflow init` 生成的默认四环节一致），
 *   不算降级，保证尚未初始化流程配置的项目行为不变。
 * - 阶段缺省上限取 `config.workflow.maxRepairRounds`；配置不可读时用内置缺省。
 *
 * 本模块只做 IO 装配；解析、校验与降级判定在 domain/workflow.ts。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { DEFAULT_WORKFLOW_YAML, parseWorkflow, type WorkflowDefinition, type WorkflowLoadResult } from "../domain/workflow.js";
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
