import type { Command } from "commander";
import { initProject } from "../application/init.js";
import { WORKFLOW_CONFIG_PATH } from "../contracts/workflow.js";
import { projectRoot } from "./root.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("把流程、角色文件和配置生成到项目里；已有的文件不动")
    .option("--force", "把流程和角色文件恢复成模板的内容，覆盖之前先备份；配置、规范和任务不动")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string; force?: boolean }) => {
      const result = initProject(projectRoot(options.dir), options.force === true);
      const lines = [
        ...section("已生成:", result.created),
        ...section("已恢复成模板:", result.restored),
        ...(result.backupDir === null ? [] : [`备份: ${result.backupDir}/`]),
        ...section("已有，没有动:", result.kept),
        ...([...result.created, ...result.restored].includes(WORKFLOW_CONFIG_PATH)
          ? [`下一步: 在 ${WORKFLOW_CONFIG_PATH} 里写上执行者的模型（model: provider/模型），再运行 knit workflow validate`]
          : []),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}

/** 没有内容的一段整段不出现。 */
function section(title: string, targets: readonly string[]): string[] {
  return targets.length === 0 ? [] : [title, ...targets.map((target) => `  ${target}`)];
}
