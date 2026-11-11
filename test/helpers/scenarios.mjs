import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateTaskDocument } from "../../dist/application/task-service.js";
import { parseTaskDocument, renderTaskDocument } from "../../dist/application/task-document.js";

/** 合格的单场景输入：供非场景专项测试显式准备 independent 任务。 */
export const ACCEPTANCE_FIXTURE = `## 完成条件

### Requirement: 范围验证

#### Scenario: 核对产出
- WHEN 核对本任务产出
- THEN 产出符合目标与声明的验证
`;
export const SCENARIO_PASS = ["R1.S1 pass：隔离夹具已核对产出"];

/** 旧阶段链路测试的报告夹具（包括 prompts／phases）；场景专项测试不使用此 helper。 */
export function withScenarioReportFixture(value) {
  if (Array.isArray(value)) return value.map(withScenarioReportFixture);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withScenarioReportFixture(item)]));
  if (typeof result.summary === "string" && typeof result.verdict === "string" && result.scenarios === undefined) {
    result.scenarios = SCENARIO_PASS;
  }
  return result;
}

/** 保留其它输入区段；不修改 TaskService 或 fake worker 的业务行为。 */
export function withAcceptanceFixture(inputs) {
  const heading = /^## 完成条件[^\n]*\n[\s\S]*?(?=^#{1,2} |$(?![\s\S]))/m;
  return heading.test(inputs)
    ? inputs.replace(heading, `${ACCEPTANCE_FIXTURE}\n`)
    : `${inputs.trimEnd()}\n\n${ACCEPTANCE_FIXTURE}`;
}

export function writeAcceptanceFixture(dir, taskId) {
  const located = locateTaskDocument(dir, taskId);
  const file = join(located.dir, "task.md");
  const raw = readFileSync(file, "utf8");
  const document = parseTaskDocument(raw);
  writeFileSync(file, renderTaskDocument({ ...document, inputsBody: withAcceptanceFixture(document.inputsBody) }));
}
