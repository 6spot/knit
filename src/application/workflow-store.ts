/** 从项目根读取流程配置，返回校验问题，不产生终端输出。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { parseWorkflow, type WorkflowDefinition } from "../domain/workflow.js";

export function readWorkflow(root: string): {
  readonly workflow: WorkflowDefinition | null;
  readonly problems: readonly string[];
} {
  const file = join(root, WORKFLOW_CONFIG_PATH);
  if (!existsSync(file)) return { workflow: null, problems: [`${WORKFLOW_CONFIG_PATH} 不存在；运行 knit init 生成`] };
  const loaded = parseWorkflow(readFileSync(file, "utf8"));
  return { workflow: loaded.workflow, problems: loaded.validation.issues.map((issue) => issue.message) };
}
