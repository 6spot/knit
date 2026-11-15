import { existsSync } from "node:fs";
import { join } from "node:path";
import { Option, type Command } from "commander";
import { createTask } from "../application/task-store.js";
import { TASK_PRIORITIES, TASK_VERIFICATIONS, type TaskFrontmatter } from "../contracts/task.js";
import { projectRoot } from "./root.js";

function fail(problems: readonly string[]): void {
  process.stderr.write(problems.map((problem) => `${problem}\n`).join(""));
  process.exitCode = 1;
}

/** 有 `.knit/` 目录的项目根；没有时报错并返回 null。 */
function knitRoot(dir: string): string | null {
  const root = projectRoot(dir);
  if (existsSync(join(root, ".knit"))) return root;
  fail(["这个项目里没有 .knit/ 目录；运行 knit init 生成"]);
  return null;
}

export function registerTaskCommands(program: Command): void {
  const task = program.command("task").description("创建、查看和结束任务");

  task
    .command("new")
    .description("创建一个任务")
    .requiredOption("--title <标题>", "任务标题")
    .option("--slug <名称>", "目录名里的名称", "task")
    .addOption(new Option("--verification <方式>", "验证方式").choices(TASK_VERIFICATIONS).default("self"))
    .addOption(new Option("--priority <优先级>", "优先级").choices(TASK_PRIORITIES).default("P2"))
    .option("--parent <id>", "上级任务")
    .option("--depends-on <id...>", "要先完成的任务", [])
    .option("--dir <目录>", "项目目录", process.cwd())
    .action(
      (options: {
        title: string;
        slug: string;
        verification: TaskFrontmatter["verification"];
        priority: TaskFrontmatter["priority"];
        parent?: string;
        dependsOn: string[];
        dir: string;
      }) => {
        const root = knitRoot(options.dir);
        if (root === null) return;
        if (options.title.trim() === "") return fail(["--title 不能为空"]);
        const result = createTask(root, {
          title: options.title.trim(),
          slug: options.slug,
          verification: options.verification,
          priority: options.priority,
          parent: options.parent ?? null,
          dependsOn: options.dependsOn,
        });
        if (result.created === null) return fail(result.problems);
        process.stdout.write(`已创建 ${result.created.id}\n${result.created.file}\n`);
      },
    );
}
