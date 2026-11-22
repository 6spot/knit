import type { Command } from "commander";
import { renderStandard } from "../application/handoff.js";
import { buildSessionContext } from "../application/session-context.js";
import type { Standard } from "../domain/standards.js";
import { statusLines } from "./run.js";
import { fail, knitRoot } from "./task.js";

export function registerContextCommand(program: Command): void {
  program
    .command("context [id]")
    .description("主会话每轮收到的讨论规范；指定任务时追加状态、下一步和当前环节的补充规范")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string | undefined, options: { dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const context = buildSessionContext(root, id);
      if (context.kind === "refused") return fail(context.problems);
      const task = context.task;
      const lines = [
        ...standardLines("discuss", context.discussion),
        ...(task === null ? [] : [...statusLines(task.status), `目录: ${task.dir}`]),
        ...(task?.supplement == null ? [] : standardLines(task.supplement.stage, task.supplement.standards)),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}

function standardLines(stage: string, standards: readonly Standard[]): string[] {
  if (standards.length === 0) return [`规范（${stage} 环节）: 没有`];
  return [`规范（${stage} 环节）:`, standards.map(renderStandard).join("\n\n")];
}
