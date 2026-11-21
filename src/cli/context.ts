import type { Command } from "commander";
import { loadStandards } from "../application/standards-store.js";
import { sessionStage } from "../domain/progress.js";
import { standardsForStage, type Standard } from "../domain/standards.js";
import { currentStatus } from "../domain/task-document.js";
import { statusLines } from "./run.js";
import { knitRoot, loadTask } from "./task.js";
import { loadWorkflow } from "./workflow.js";

export function registerContextCommand(program: Command): void {
  program
    .command("context [id]")
    .description("主会话每轮收到的讨论规范；指定任务时追加状态、下一步和当前环节的补充规范")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string | undefined, options: { dir: string }) => {
      if (id === undefined) {
        const root = knitRoot(options.dir);
        if (root === null) return;
        process.stdout.write(`${standardLines(loadStandards(root), "discuss").join("\n")}\n`);
        return;
      }
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const workflow = loadWorkflow(loaded.root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const { root, document, record } = loaded;
      const standards = loadStandards(root);
      const discussionPaths = new Set(standardsForStage(standards, "discuss").map((standard) => standard.path));
      const stage = sessionStage(workflow, document.frontmatter.verification, record, currentStatus(document, record));
      // 这里不能有每次运行都会变的内容：任务和规范没变时，输出要逐字不变。
      const lines = [
        ...standardLines(standards, "discuss"),
        ...statusLines(root, workflow, document, record),
        `目录: ${loaded.stored.dir}`,
        ...(stage === null || stage === "discuss"
          ? []
          : standardLines(standards.filter((standard) => !discussionPaths.has(standard.path)), stage)),
      ];
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });
}

/** 适用这个环节的规范，写法和交接内容里的一样。 */
function standardLines(available: readonly Standard[], stage: string): string[] {
  const standards = standardsForStage(available, stage);
  if (standards.length === 0) return [`规范（${stage} 环节）: 没有`];
  return [
    `规范（${stage} 环节）:`,
    standards
      .map((standard) => `<standard path="${standard.path}" title="${standard.title}">\n${standard.body}\n</standard>`)
      .join("\n\n"),
  ];
}
