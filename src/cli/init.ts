import type { Command } from "commander";
import { initProject } from "../application/init.js";
import { legacyStandardCopies } from "../application/standards-store.js";
import { projectRoot } from "./root.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("生成项目流程、角色文件和配置；通用规范随安装包加载")
    .option("--pi", "安装 Pi 项目桥接")
    .option("--agy", "安装 Antigravity 项目插件")
    .option("--workbuddy", "安装 WorkBuddy 桌面端主会话钩子")
    .option("--force", "备份并恢复流程、角色文件以及本次指定或已有的宿主桥接")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string; force?: boolean; pi?: boolean; agy?: boolean; workbuddy?: boolean }) => {
      const root = projectRoot(options.dir);
      const result = initProject(root, options.force, options);
      const lines = [
        ...section("已生成:", result.created),
        ...section("已恢复成模板:", result.restored),
        ...(result.backupDir === null ? [] : [`备份: ${result.backupDir}/`]),
        ...section("已有，没有动:", result.kept),
        ...section("旧版通用规范副本（保留原文，已停用；请把项目定制迁入另名的项目规范）:", legacyStandardCopies(root)),
        ...(result.task === null
          ? []
          : [`初始化任务: ${result.task.id}（${result.task.file}）`]),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}

/** 没有内容的一段整段不出现。 */
function section(title: string, targets: readonly string[]): string[] {
  return targets.length === 0 ? [] : [title, ...targets.map((target) => `  ${target}`)];
}
