import { existsSync } from "node:fs";
import { join } from "node:path";
import { Option, type Command } from "commander";
import { createTask, findTask, scanTasks } from "../application/task-store.js";
import { TASK_PRIORITIES, TASK_VERIFICATIONS, type TaskFrontmatter, type TaskRecord } from "../contracts/task.js";
import { currentStatus, type TaskDocument } from "../domain/task-document.js";
import { clarifyStateOf, scenarioStateOf } from "../domain/task-requirements.js";
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

/** 显示用的状态；`stale` 表示文件里写着已确认，但确认之后需求被改过。 */
function shownStatus(document: TaskDocument, record: TaskRecord): { text: string; stale: boolean } {
  const status = currentStatus(document, record);
  return {
    text: status === "active" ? `active(${document.frontmatter.stage})` : status,
    stale: status !== document.frontmatter.status,
  };
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

  task
    .command("list")
    .description("列出任务")
    .option("--archive", "改列已归档的任务", false)
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { archive: boolean; dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const tasks = scanTasks(root).filter((stored) => stored.archived === options.archive);
      const readable = tasks
        .flatMap((stored) =>
          stored.document === null || stored.record === null
            ? []
            : [{ frontmatter: stored.document.frontmatter, status: shownStatus(stored.document, stored.record) }],
        )
        .sort(
          (a, b) =>
            a.frontmatter.priority.localeCompare(b.frontmatter.priority) ||
            a.frontmatter.createdAt.localeCompare(b.frontmatter.createdAt),
        )
        .map(
          (row) =>
            `${row.frontmatter.priority}  ${row.frontmatter.id}  ${row.status.text}  ${row.frontmatter.title}` +
            (row.status.stale ? "（确认后改过需求）" : ""),
        );
      const broken = tasks
        .filter((stored) => stored.document === null || stored.record === null)
        .map((stored) => `${stored.dir}：${stored.problems[0]}`);
      const lines = [...readable, ...broken];
      process.stdout.write(lines.length === 0 ? "没有任务\n" : lines.map((line) => `${line}\n`).join(""));
    });

  task
    .command("show <id>")
    .description("显示一个任务的情况")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const stored = findTask(root, id);
      if (stored === null) return fail([`没有任务 ${id}；用 knit task list 查看现有任务`]);
      if (stored.document === null || stored.record === null) return fail(stored.problems);
      const frontmatter = stored.document.frontmatter;
      const status = shownStatus(stored.document, stored.record);
      const scenarios = scenarioStateOf(stored.document.requirement);
      const clarify = clarifyStateOf(stored.document.requirement);
      const changed = [
        ...new Set([...stored.record.changedPaths, ...stored.record.runs.flatMap((run) => run.changedPaths)]),
      ].sort();
      const lines = [
        `标题: ${frontmatter.title}`,
        `ID: ${frontmatter.id}`,
        `状态: ${status.text}${status.stale ? "（确认后改过需求，需要重新 task ready）" : ""}`,
        `验证: ${frontmatter.verification}`,
        `优先级: ${frontmatter.priority}`,
        `父任务: ${frontmatter.parent ?? "无"}`,
        `依赖: ${frontmatter.dependsOn.join(", ") || "无"}`,
        `目录: ${stored.dir}`,
        `完成条件: ${scenarios.scenarios.length} 个场景` +
          (scenarios.issues.length > 0 ? `，${scenarios.issues.length} 处写法问题` : ""),
        `待澄清: ${clarify.blocking} 项 blocking，${clarify.assumed} 项 assumed`,
        ...(changed.length > 0 ? [`改动文件（${changed.length}）:`, ...changed.map((path) => `  ${path}`)] : []),
      ];
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });
}
