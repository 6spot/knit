import type { Command } from "commander";
import { loadStandards } from "../application/standards-store.js";
import { sessionStage } from "../domain/progress.js";
import { standardsForStage } from "../domain/standards.js";
import { currentStatus } from "../domain/task-document.js";
import { statusLines } from "./run.js";
import { loadTask } from "./task.js";
import { loadWorkflow } from "./workflow.js";

export function registerContextCommand(program: Command): void {
  program
    .command("context <id>")
    .description("主会话每轮收到的内容：任务的状态、下一步和当前环节的规范")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { dir: string }) => {
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const workflow = loadWorkflow(loaded.root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const { root, document, record } = loaded;
      // 这里不能有每次运行都会变的内容：任务的状态没变时，输出要逐字不变。
      const lines = [
        ...statusLines(root, workflow, document, record),
        `目录: ${loaded.stored.dir}`,
        ...standardLines(
          root,
          sessionStage(workflow, document.frontmatter.verification, record, currentStatus(document, record)),
        ),
      ];
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });
}

/** 适用这个环节的规范，写法和交接内容里的一样；任务已经结束（没有环节）时什么都没有。 */
function standardLines(root: string, stage: string | null): string[] {
  if (stage === null) return [];
  const standards = standardsForStage(loadStandards(root), stage);
  if (standards.length === 0) return [`规范（${stage} 环节）: 没有`];
  return [
    `规范（${stage} 环节）:`,
    standards
      .map((standard) => `<standard path="${standard.path}" title="${standard.title}">\n${standard.body}\n</standard>`)
      .join("\n\n"),
  ];
}
