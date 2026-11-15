import { existsSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { Option, type Command } from "commander";
import {
  archiveTask,
  createTask,
  findTask,
  saveTask,
  scanTasks,
  type StoredTask,
} from "../application/task-store.js";
import {
  TASK_PRIORITIES,
  TASK_VERIFICATIONS,
  type TaskFrontmatter,
  type TaskRecord,
  type TaskStatus,
} from "../contracts/task.js";
import { currentStatus, requirementDigest, type TaskDocument } from "../domain/task-document.js";
import { clarifyStateOf, SCENARIO_FORMAT_EXAMPLE, scenarioStateOf } from "../domain/task-requirements.js";
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

interface LoadedTask {
  readonly root: string;
  readonly stored: StoredTask;
  readonly document: TaskDocument;
  readonly record: TaskRecord;
}

/** 按 id 读出一个任务；项目、任务不存在或文件有格式问题时报错并返回 null。 */
function loadTask(dir: string, id: string): LoadedTask | null {
  const root = knitRoot(dir);
  if (root === null) return null;
  const stored = findTask(root, id);
  if (stored === null) {
    fail([`没有任务 ${id}；用 knit task list 查看现有任务`]);
    return null;
  }
  if (stored.document === null || stored.record === null) {
    fail(stored.problems);
    return null;
  }
  return { root, stored, document: stored.document, record: stored.record };
}

/** 需求部分里挡住确认的地方，每处后面跟着怎么改；没有时是空数组。 */
function readyProblems(document: TaskDocument): string[] {
  const clarify = clarifyStateOf(document.requirement);
  const scenarios = scenarioStateOf(document.requirement);
  const unwritten = document.frontmatter.verification === "independent" && scenarios.scenarios.length === 0;
  return [
    ...(clarify.blocking > 0
      ? [
          `「待澄清」里还有 ${clarify.blocking} 项 [blocking]：`,
          ...clarify.blockingItems.map((item) => `  - ${item}`),
          "  和用户定下来之后，把结论写进正文并删掉这一行。",
        ]
      : []),
    ...(scenarios.issues.length > 0
      ? [`「完成条件」的场景有 ${scenarios.issues.length} 处写法问题：`, ...scenarios.issues.map((issue) => `  - ${issue.message}`)]
      : []),
    ...(unwritten
      ? ["独立审查的任务必须把完成条件写成场景；另一条路是把 task.md 开头的 verification 改成 self。"]
      : []),
    ...(scenarios.issues.length > 0 || unwritten ? ["场景的写法：", SCENARIO_FORMAT_EXAMPLE] : []),
  ];
}

/** 这个状态的任务为什么不能记为完成，以及下一步；可以完成时是 null。 */
function closeRefusal(status: TaskStatus, id: string): string | null {
  if (status === "ready" || status === "active") return null;
  if (status === "draft") return `需求还没有确认，或确认之后改过；先运行 knit task ready ${id}`;
  if (status === "done") return "任务已经完成；要改总结直接编辑 task.md 的「结果」";
  return `任务已经结束（${status}），不能再记为完成`;
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
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const frontmatter = loaded.document.frontmatter;
      const status = shownStatus(loaded.document, loaded.record);
      const scenarios = scenarioStateOf(loaded.document.requirement);
      const clarify = clarifyStateOf(loaded.document.requirement);
      const changed = [
        ...new Set([...loaded.record.changedPaths, ...loaded.record.runs.flatMap((run) => run.changedPaths)]),
      ].sort();
      const lines = [
        `标题: ${frontmatter.title}`,
        `ID: ${frontmatter.id}`,
        `状态: ${status.text}${status.stale ? "（确认后改过需求，需要重新 task ready）" : ""}`,
        `验证: ${frontmatter.verification}`,
        `优先级: ${frontmatter.priority}`,
        `父任务: ${frontmatter.parent ?? "无"}`,
        `依赖: ${frontmatter.dependsOn.join(", ") || "无"}`,
        `目录: ${loaded.stored.dir}`,
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
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const status = currentStatus(loaded.document, loaded.record);
      if (status === "ready") return void process.stdout.write("已确认，需求没有变化\n");
      if (status === "active") {
        return fail([`任务正在 ${loaded.document.frontmatter.stage} 环节，需求没有变化，不需要重新确认`]);
      }
      if (status !== "draft") return fail([`任务已经结束（${status}）；要继续做就新建一个任务`]);
      const problems = readyProblems(loaded.document);
      if (problems.length > 0) return fail(problems);
      const conflicts = saveTask(
        loaded.root,
        loaded.stored,
        { ...loaded.document, frontmatter: { ...loaded.document.frontmatter, status: "ready", stage: null } },
        { ...loaded.record, confirmedDigest: requirementDigest(loaded.document) },
      );
      if (conflicts.length > 0) return fail(conflicts);
      const assumed = clarifyStateOf(loaded.document.requirement).assumed;
      process.stdout.write(
        `已确认 ${id}：${scenarioStateOf(loaded.document.requirement).scenarios.length} 个场景\n` +
          (assumed > 0 ? `还有 ${assumed} 项 [assumed] 没有得到用户确认\n` : ""),
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
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const result = options.result.trim();
      if (result === "") return fail(["--result 不能为空：写做成了什么、完成条件是否都满足、怎么验证的"]);
      const refusal = closeRefusal(currentStatus(loaded.document, loaded.record), id);
      if (refusal !== null) return fail([refusal]);
      const unreviewed =
        loaded.document.frontmatter.verification === "independent" &&
        loaded.record.runs.filter((run) => run.verdict !== null).at(-1)?.verdict !== "pass";
      if (unreviewed && options.reason === undefined) {
        return fail(["独立审查的任务要在审查通过后才能完成；用户明确要求直接完成时，加 --reason <理由>"]);
      }
      const paths = options.paths.map((path) => posix.normalize(path));
      const outside = options.paths.filter(
        (path, index) => isAbsolute(path) || paths[index] === ".." || paths[index]?.startsWith("../"),
      );
      if (outside.length > 0) return fail(outside.map((path) => `--paths 要写项目内的相对路径：${path}`));
      const conflicts = saveTask(
        loaded.root,
        loaded.stored,
        {
          frontmatter: { ...loaded.document.frontmatter, status: "done", stage: null },
          requirement: loaded.document.requirement,
          result: unreviewed ? `${result}\n\n没有经过独立审查，直接完成：${options.reason}` : result,
        },
        { ...loaded.record, changedPaths: [...new Set([...loaded.record.changedPaths, ...paths])].sort() },
      );
      if (conflicts.length > 0) return fail(conflicts);
      process.stdout.write(`已完成 ${id}\n`);
    });

  task
    .command("cancel <id>")
    .description("取消一个任务并归档")
    .requiredOption("--reason <原因>", "为什么不做了")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { reason: string; dir: string }) => {
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const reason = options.reason.trim();
      if (reason === "") return fail(["--reason 不能为空：写为什么不做了"]);
      const status = loaded.document.frontmatter.status;
      if (status === "delivered" || status === "cancelled") return fail([`任务已经结束（${status}），不能取消`]);
      const conflicts = saveTask(
        loaded.root,
        loaded.stored,
        {
          frontmatter: { ...loaded.document.frontmatter, status: "cancelled", stage: null },
          requirement: loaded.document.requirement,
          result: [...(loaded.document.result ? [loaded.document.result] : []), `已取消：${reason}`].join("\n\n"),
        },
        loaded.record,
      );
      if (conflicts.length > 0) return fail(conflicts);
      process.stdout.write(`已取消 ${id}\n${archiveTask(loaded.root, loaded.stored)}\n`);
    });
}
