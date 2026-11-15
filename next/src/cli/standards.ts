import type { Command } from "commander";
import { loadStandards } from "../application/standards-store.js";
import { WORKFLOW_ANCHORS } from "../contracts/workflow.js";
import type { Standard } from "../domain/standards.js";
import { projectRoot } from "./root.js";
import { loadWorkflow } from "./workflow.js";

/** 第三项：适用的环节，或者这份规范为什么不会注入。 */
function stagesColumn(standard: Standard, known: readonly string[]): string {
  if (standard.problems.length > 0) return `开头声明有问题，不会注入：${standard.problems[0]}`;
  if (standard.stages.length === 0) return "没有声明适用的环节，不会注入";
  const unknown = standard.stages.filter((stage) => !known.includes(stage));
  return `${standard.stages.join(", ")}${unknown.length === 0 ? "" : `（流程里没有的环节：${unknown.join("、")}）`}`;
}

/** 规范文件由人手工修改，这里只提供查看。 */
export function registerStandardsCommands(program: Command): void {
  program
    .command("standards")
    .description("查看项目规范")
    .command("list")
    .description("列出规范和各自适用的环节，标出不会注入的")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string }) => {
      const workflow = loadWorkflow(options.dir);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const known = [...workflow.stages.map((stage) => stage.id), ...WORKFLOW_ANCHORS];
      const lines = loadStandards(projectRoot(options.dir)).map(
        (standard) => `${standard.path}  ${standard.title}  ${stagesColumn(standard, known)}`,
      );
      process.stdout.write(`${lines.length === 0 ? "没有规范" : lines.join("\n")}\n`);
    });
}
