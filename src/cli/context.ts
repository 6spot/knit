import { Option, type Command } from "commander";
import { hostProjectRoot, selectHostTask } from "../application/host-hook.js";
import { buildSessionContext } from "../application/session-context.js";
import { contextLines } from "../application/session-output.js";
import { fail, knitRoot } from "./task.js";

export function registerContextCommand(program: Command): void {
  program
    .command("context [id]")
    .description("主会话每轮收到的讨论规范；指定任务时追加状态、下一步和当前环节的补充规范")
    .addOption(new Option("--use <id>", "为当前宿主会话选中任务").conflicts("unuse"))
    .option("--unuse", "清除当前宿主会话的任务选择")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string | undefined, options: { dir: string; use?: string; unuse?: boolean }) => {
      if (options.use !== undefined || options.unuse) {
        if (id !== undefined) return fail(["选择任务时请使用 knit context --use <id> 或 knit context --unuse"]);
        const host = process.env.KNIT_HOST;
        const sessionId = process.env.KNIT_HOST_SESSION;
        if (!host || !sessionId) return fail(["选择任务需要 KNIT_HOST 和 KNIT_HOST_SESSION"]);
        const root = hostProjectRoot(options.dir);
        if (root === null) return fail(["这个项目里没有 .knit/ 目录"]);
        const problems = selectHostTask(root, { host, sessionId }, options.use ?? null);
        if (problems.length) return fail(problems);
        process.stdout.write(options.unuse ? "已取消选中\n" : `已选中 ${options.use}\n`);
        return;
      }
      const root = knitRoot(options.dir);
      if (root === null) return;
      const context = buildSessionContext(root, id);
      if (context.kind === "refused") return fail(context.problems);
      process.stdout.write(`${contextLines(context).join("\n")}\n`);
    });
}
