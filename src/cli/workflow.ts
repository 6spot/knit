import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { WORKFLOW_CONFIG_PATH, isReportEnum } from "../contracts/workflow.js";
import { WORKFLOW_ANCHOR_NAMES, parseWorkflow, type WorkflowDefinition, type WorkflowStage } from "../domain/workflow.js";
import { projectRoot } from "./root.js";

/** 读取并校验项目的流程文件；文件不存在或有问题时把原因写到标准错误，返回 null。 */
export function loadWorkflow(dir: string): WorkflowDefinition | null {
  const file = join(projectRoot(dir), WORKFLOW_CONFIG_PATH);
  if (!existsSync(file)) {
    process.stderr.write(`${WORKFLOW_CONFIG_PATH} 不存在；运行 knit init 生成\n`);
    return null;
  }
  const loaded = parseWorkflow(readFileSync(file, "utf8"));
  if (loaded.workflow === null) {
    process.stderr.write(loaded.validation.issues.map((issue) => `${issue.message}\n`).join(""));
  }
  return loaded.workflow;
}

function chainLine(workflow: WorkflowDefinition): string {
  const names = [WORKFLOW_ANCHOR_NAMES.discuss, ...workflow.stages.map((stage) => stage.name), WORKFLOW_ANCHOR_NAMES.deliver];
  return `流程: ${names.join(" → ")}`;
}

function stageLines(stage: WorkflowStage, index: number): string[] {
  const report = Object.entries(stage.report).map(
    (entry) => `${entry[0]}(${isReportEnum(entry[1]) ? entry[1].join("|") : entry[1]})`,
  );
  const jumps = Object.entries(stage.onVerdict).map((entry) => `${entry[0]} → ${entry[1]}`);
  const tools = stage.tools === null ? "全部放开" : stage.tools.length === 0 ? "全部禁用" : stage.tools.join("、");
  return [
    `  ${index + 1}. ${stage.id}（${stage.name}）`,
    ...(stage.description === null ? [] : [`     说明: ${stage.description}`]),
    `     角色文件: ${stage.prompt ?? "（没有指定）"}`,
    `     模型: ${stage.model ?? "（没有指定，派发时加 --model）"}`,
    `     工具: ${tools}`,
    ...(report.length === 0 ? [] : [`     报告字段: ${report.join("、")}`]),
    ...(jumps.length === 0 ? [] : [`     按结论跳转: ${jumps.join("；")}`]),
    `     进入次数上限: ${stage.maxVisits === null ? "无" : String(stage.maxVisits)}`,
  ];
}

/** 流程文件由人手工修改，这里只提供查看和校验两个只读命令。 */
export function registerWorkflowCommands(program: Command): void {
  const workflow = program.command("workflow").description(`查看和校验 ${WORKFLOW_CONFIG_PATH}`);

  workflow
    .command("show")
    .description("显示流程和每个环节的配置")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string }) => {
      const loaded = loadWorkflow(options.dir);
      if (loaded === null) {
        process.exitCode = 1;
        return;
      }
      const lines = [chainLine(loaded), `环节（${loaded.stages.length}）：`, ...loaded.stages.flatMap(stageLines)];
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  workflow
    .command("validate")
    .description("校验流程文件，有问题时逐条给出行号")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string }) => {
      const loaded = loadWorkflow(options.dir);
      if (loaded === null) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`配置有效\n${chainLine(loaded)}\n`);
    });
}
