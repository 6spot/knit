import { createSessionDraft } from "../application/host-hook.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Option, type Command } from "commander";
import {
  createTask,
  readTask,
  scanTasks,
  shownTaskDirectory,
  taskCommit,
  type LoadedTask,
} from "../application/task-store.js";
import { cancelTask, closeTask, readyTask, type RequirementProblems } from "../application/task-lifecycle.js";
import { cleanupLines } from "./worktree.js";
import {
  TASK_PRIORITIES,
  TASK_VERIFICATIONS,
  type TaskFrontmatter,
  type TaskRecord,
} from "../contracts/task.js";
import { currentStatus, type TaskDocument } from "../domain/task-document.js";
import { clarifyStateOf, SCENARIO_FORMAT_EXAMPLE, scenarioStateOf } from "../domain/task-requirements.js";
import { projectRoot } from "./root.js";

export function fail(problems: readonly string[]): void {
  process.stderr.write(problems.map((problem) => `${problem}\n`).join(""));
  process.exitCode = 1;
}

/** 有 `.knit/` 目录的项目根；没有时报错并返回 null。 */
export function knitRoot(dir: string): string | null {
  const root = projectRoot(dir);
  if (existsSync(join(root, ".knit"))) return root;
  fail(["这个项目里没有 .knit/ 目录；运行 knit init 生成"]);
  return null;
}

/** 按 id 读出一个任务；项目、任务不存在或文件有格式问题时报错并返回 null。 */
export function loadTask(dir: string, id: string): LoadedTask | null {
  const root = knitRoot(dir);
  if (root === null) return null;
  const result = readTask(root, id);
  if (result.kind === "refused") {
    fail(result.problems);
    return null;
  }
  return result.task;
}

/** 显示用的状态；`stale` 表示文件里写着已确认，但确认之后需求被改过。 */
export function shownStatus(document: TaskDocument, record: TaskRecord): { text: string; stale: boolean } {
  const status = currentStatus(document, record);
  return {
    text: status === "active" ? `active(${document.frontmatter.stage})` : status,
    stale: status !== document.frontmatter.status,
  };
}

function requirementLines(problems: RequirementProblems): string[] {
  return [
    ...(problems.blocking > 0
      ? [
          `「待澄清」里还有 ${problems.blocking} 项 [blocking]：`,
          ...problems.blockingItems.map((item) => `  - ${item}`),
          "  和用户定下来之后，把结论写进正文并删掉这一行。",
        ]
      : []),
    ...(problems.scenarioIssues.length > 0
      ? [`「完成条件」的场景有 ${problems.scenarioIssues.length} 处写法问题：`, ...problems.scenarioIssues.map((issue) => `  - ${issue}`)]
      : []),
    ...(problems.missingScenarios ? ["独立审查的任务必须把完成条件写成场景；另一条路是把 task.md 开头的 verification 改成 self。"] : []),
    ...(problems.scenarioIssues.length > 0 || problems.missingScenarios ? ["场景的写法：", SCENARIO_FORMAT_EXAMPLE] : []),
  ];
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
        const input = {
          title: options.title.trim(),
          slug: options.slug,
          verification: options.verification,
          priority: options.priority,
          parent: options.parent ?? null,
          dependsOn: options.dependsOn,
        };
        const { KNIT_HOST, KNIT_HOST_SESSION, KNIT_DRAFT_CHOICE } = process.env;
        const result = KNIT_HOST && KNIT_HOST_SESSION && KNIT_DRAFT_CHOICE
          ? createSessionDraft(root, { host: KNIT_HOST, sessionId: KNIT_HOST_SESSION }, KNIT_DRAFT_CHOICE, input) : createTask(root, input);
        if (result.created === null) return fail(result.problems);
        process.stdout.write(`已创建 ${result.created.id}\n${result.created.file}\n`);
        if (KNIT_HOST && KNIT_HOST_SESSION) {
          const title = "title" in result ? result.title : input.title;
          const status = "status" in result ? result.status : "draft";
          const selected = "selected" in result && result.selected || process.env.KNIT_SELECTED_TASK === result.created.id;
          process.stdout.write(`${title}（${result.created.id}） · ${status} · 当前会话${selected ? "已选中" : "未选中"}新草稿\n[task.md](${result.created.file})\n`);
        }
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
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const frontmatter = loaded.document.frontmatter;
      const status = shownStatus(loaded.document, loaded.record);
      const scenarios = scenarioStateOf(loaded.document.requirement);
      const clarify = clarifyStateOf(loaded.document.requirement);
      const changed = [
        ...new Set([...loaded.record.changedPaths, ...loaded.record.runs.flatMap((run) => run.changedPaths)]),
      ].sort();
      const commit = taskCommit(loaded);
      const lines = [
        `标题: ${frontmatter.title}`,
        `ID: ${frontmatter.id}`,
        `状态: ${status.text}${status.stale ? "（确认后改过需求，需要重新 task ready）" : ""}`,
        `验证: ${frontmatter.verification}`,
        `优先级: ${frontmatter.priority}`,
        `父任务: ${frontmatter.parent ?? "无"}`,
        `依赖: ${frontmatter.dependsOn.join(", ") || "无"}`,
        `目录: ${shownTaskDirectory(loaded)}`,
        ...(commit === null ? [] : [`提交: ${commit}`]),
        `完成条件: ${scenarios.scenarios.length} 个场景` +
          (scenarios.issues.length > 0 ? `，${scenarios.issues.length} 处写法问题` : ""),
        `待澄清: ${clarify.blocking} 项 blocking，${clarify.assumed} 项 assumed`,
        ...(changed.length > 0 ? [`改动文件（${changed.length}）:`, ...changed.map((path) => `  ${path}`)] : []),
      ];
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });

  task
    .command("ready <id>")
    .description("确认一个任务的需求")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const result = readyTask(root, id);
      if (result.kind === "refused") return fail(result.problems);
      if (result.kind === "invalidRequirement") return fail(requirementLines(result));
      if (result.kind === "alreadyReady") return void process.stdout.write("已确认，需求没有变化\n");
      process.stdout.write(
        `已确认 ${id}：${result.scenarios} 个场景\n` +
          (result.assumed > 0 ? `还有 ${result.assumed} 项 [assumed] 没有得到用户确认\n` : ""),
      );
    });

  task
    .command("close <id>")
    .description("把一个任务记为完成，并写下结果")
    .requiredOption("--result <总结>", "做成了什么、完成条件是否都满足、怎么验证的")
    // 占位名用拉丁字母：commander 靠 `\w...>` 认出“可以给多个”，中文占位名认不出来。
    .option("--paths <path...>", "主会话自己改动的文件", [])
    .option("--reason <理由>", "独立审查的任务没有审查通过的记录时，直接完成的理由")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { result: string; paths: string[]; reason?: string; dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const result = closeTask(root, id, options);
      if (result.kind === "refused") return fail(result.problems);
      process.stdout.write(`已完成 ${id}\n`);
    });

  task
    .command("cancel <id>")
    .description("取消一个任务并归档")
    .requiredOption("--reason <原因>", "为什么不做了")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { reason: string; dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const result = cancelTask(root, id, options);
      if (result.kind === "refused") return fail(result.problems);
      const lines = [`已取消 ${id}`, result.archiveDir, ...cleanupLines(root, result.cleanup)];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}
