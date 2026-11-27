import { existsSync } from "node:fs";
import { join } from "node:path";
import { Option, type Command } from "commander";
import { recordedPaths } from "../application/delivery.js";
import { readWorkflow } from "../application/project-config.js";
import { startingWorker } from "../application/run-control.js";
import { archivedTaskHeaders, createTask, findArchivedTasks, scanTasks, shownTaskDirectory, taskCommit } from "../application/task-store.js";
import { taskBranch, taskWorktree } from "../application/worktree.js";
import { cancelTask, closeTask, readyTask, type RequirementProblems } from "../application/task-lifecycle.js";
import { DEFAULT_AGENT } from "../contracts/workflow.js";
import { RUNS_DIR, TASK_PRIORITIES, TASK_VERIFICATIONS, type TaskFrontmatter, type TaskRecord } from "../contracts/task.js";
import { nextStep } from "../domain/progress.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { gitSync, processIdentities, readProcessRegistration, registeredPid, shellQuote } from "../infrastructure/process.js";
import { clarifyStateOf, SCENARIO_FORMAT_EXAMPLE, scenarioStateOf } from "../domain/task-requirements.js";
import { cleanupLines, fail, knitRoot, loadTask, shownStatus, taskLabel } from "./shared.js";

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

interface TaskRow {
  frontmatter: TaskFrontmatter;
  record: TaskRecord;
  stale: boolean;
  line: string;
}

function taskListLines(root: string, archive: boolean, grep?: string, limit?: number): string[] {
  const keyword = grep?.toLowerCase();
  const matches = (fields: TaskFrontmatter) => keyword === undefined || fields.id.toLowerCase().includes(keyword) || fields.title.toLowerCase().includes(keyword);
  const lineOf = (fields: TaskFrontmatter, status: string) => `${fields.priority}  ${fields.id}  ${status}  ${fields.title}`;
  const footer = (count: number, hasBrokenTasks = false) => [
    ...(limit !== undefined && count > limit ? [`仅显示前 ${limit} 条，共 ${count} 条`] : []),
    ...(count === 0 && grep !== undefined ? ["没有匹配的任务"] : []),
    ...(count === 0 && grep === undefined && !hasBrokenTasks ? ["没有任务"] : []),
  ];
  if (archive) {
    const fields = archivedTaskHeaders(root).filter(matches).sort((a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    return [...fields.slice(0, limit).map((task) => lineOf(task, task.status === "active" ? `active(${task.stage})` : task.status)), ...footer(fields.length)];
  }
  const tasks = scanTasks(root, "active");
  const broken: string[] = [];
  const rows = tasks.flatMap((task) => {
    if (task.document === null || task.record === null) {
      broken.push(`${task.dir}：${task.problems[0]}`);
      return [];
    }
    const frontmatter = task.document.frontmatter;
    if (!matches(frontmatter)) return [];
    const status = shownStatus(task.document, task.record);
    const line = lineOf(frontmatter, status.text) +
      (status.stale ? "（确认后改过需求）" : "");
    return [{ frontmatter, record: task.record, stale: status.stale, line }];
  });
  rows.sort((a, b) => a.frontmatter.priority.localeCompare(b.frontmatter.priority) ||
    Date.parse(a.frontmatter.createdAt) - Date.parse(b.frontmatter.createdAt));
  const registrations = rows.flatMap((row) => row.record.runs.filter((run) => run.endedAt === null).map((run) => ({
    id: run.id, worker: readProcessRegistration(join(root, RUNS_DIR, run.id, "worker.json")),
  })));
  const identities = processIdentities(registrations.flatMap(({ worker }) => worker === null ? [] : [worker.pid]));
  const liveRuns = new Set(registrations.filter(({ worker }) => registeredPid(worker, identities) !== null).map((run) => run.id));

  const unmerged = new Set(gitSync(["for-each-ref", "--no-merged=HEAD", "--format=%(refname:lstrip=2)", "refs/heads/knit/"], root)
    .stdout.split("\n").filter(Boolean));
  const activeIds = new Set(tasks.map((task) => task.id));
  const dependencies = rows.flatMap((row) => row.frontmatter.dependsOn).filter((id) => !activeIds.has(id));
  const satisfied = new Set([...findArchivedTasks(root, dependencies)]
    .filter((task) => task.document?.frontmatter.status === "delivered" && !unmerged.has(taskBranch(task.dir)))
    .map((task) => task.id));

  const workflow = readWorkflow(root).workflow;
  const ids = new Set(rows.map((row) => row.frontmatter.id));
  const children = Map.groupBy(rows, (row) => ids.has(row.frontmatter.parent ?? "") ? row.frontmatter.parent : null);
  const lines: string[] = [];
  const visited = new Set<TaskRow>();
  function visit(row: TaskRow, depth: number): void {
    if (visited.has(row) || (limit !== undefined && lines.length >= limit)) return;
    visited.add(row);
    const parent = row.frontmatter.parent;
    const blocked = row.frontmatter.dependsOn.filter((id) => !satisfied.has(id));
    lines.push("  ".repeat(depth) + [row.line,
      ...(parent !== null && !ids.has(parent) ? [`父:${parent}`] : []),
      ...(blocked.length ? [`阻塞:${blocked.join(", ")}`] : []),
      ...runLabels(root, row, workflow, liveRuns),
    ].join("  "));
    children.get(row.frontmatter.id)?.forEach((child) => visit(child, depth + 1));
  }
  children.get(null)?.forEach((row) => visit(row, 0));
  // 手写 parent 形成环时，这组任务也要可见。
  rows.forEach((row) => visit(row, 0));
  lines.push(...footer(rows.length, broken.length > 0));
  const activeBranches = new Set(tasks.map((task) => taskBranch(task.dir)));
  const leftover = [...unmerged].filter((branch) => !activeBranches.has(branch));
  if (leftover.length) lines.push("", "尚未合并进 HEAD 的任务分支，可在当前检出运行：",
    ...leftover.map((branch) => `  git merge --no-edit ${shellQuote(branch)}`));
  lines.push(...broken.slice(0, 5));
  if (broken.length > 5) lines.push(`另有 ${broken.length - 5} 个损坏目录未列出`);
  return lines;
}

function runLabels(root: string, row: TaskRow, workflow: WorkflowDefinition | null, liveRuns: ReadonlySet<string>): string[] {
  const runs = row.record.runs.filter((run) => run.endedAt === null);
  if (!runs.length) {
    const status = row.frontmatter.status;
    return workflow !== null && !row.stale && (status === "ready" || status === "active") &&
      nextStep(workflow, row.frontmatter.verification, row.record).kind === "arbitrate" ? ["待裁决"] : [];
  }
  return runs.map((run) => {
    const member = runs.length > 1 ? `${run.executor ?? run.id}:` : "";
    if (startingWorker(root, row.frontmatter.id, run)) return `${member}正在启动`;
    if (!liveRuns.has(run.id)) return `${member}进程已退出`;
    const minutes = Math.floor((Date.now() - Date.parse(run.startedAt)) / 60000);
    return `${member}运行中 ${minutes >= 1 ? `${minutes}m` : "<1m"}`;
  });
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
        const label = taskLabel(result.created.title, result.created.id);
        process.stdout.write(`已创建 ${label}\n${result.created.file}\n`);
        if (process.env.KNIT_HOST && process.env.KNIT_HOST_SESSION) {
          process.stdout.write(`${label} · draft · 当前会话未选中新草稿\n[task.md](${result.created.file})\n`);
        }
      },
    );

  task
    .command("list")
    .description("列出任务")
    .option("--archive", "改列已归档的任务", false)
    .option("--limit <数量>", "最多显示的匹配任务数（正整数）")
    .option("--grep <关键词>", "按 ID 或标题筛选任务，忽略大小写")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { archive: boolean; dir: string; limit?: string; grep?: string }) => {
      if (options.limit !== undefined && (!/^[1-9]\d*$/.test(options.limit) || !Number.isSafeInteger(Number(options.limit)))) {
        return fail(["--limit 需要正整数"]);
      }
      const root = knitRoot(options.dir);
      if (root === null) return;
      const lines = taskListLines(root, options.archive, options.grep, options.limit === undefined ? undefined : Number(options.limit));
      process.stdout.write(`${lines.join("\n")}\n`);
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
      const changed = recordedPaths(loaded.record);
      const worktree = taskWorktree(loaded.root, loaded.stored.dir);
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
        ...(existsSync(join(worktree.path, ".git")) ? [`Worktree: ${worktree.path}（${worktree.branch}）`] : []),
        ...(commit === null ? [] : [`提交: ${commit}`]),
        `完成条件: ${scenarios.scenarios.length} 个场景` +
          (scenarios.issues.length > 0 ? `，${scenarios.issues.length} 处写法问题` : ""),
        `待澄清: ${clarify.blocking} 项 blocking，${clarify.assumed} 项 assumed`,
        ...clarify.blockingItems.map((item) => `  - ${item}`),
        ...(loaded.record.runs.length ? [`执行历史（${loaded.record.runs.length} 次）:`, ...loaded.record.runs.map((run) => {
          const result = run.endedAt === null ? "进行中" : run.failure !== null ? `失败: ${run.failure}`
            : run.verdict !== null ? `结论: ${run.verdict}` : "正常结束";
          return `  ${run.id}  ${run.stage}${run.batchId && run.executor ? `/${run.executor}` : ""}  Agent: ${run.agent ?? DEFAULT_AGENT}  ${result.replace(/\s*[\r\n]+\s*/g, " ")}`;
        })] : []),
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
      const label = taskLabel(result.title, id);
      if (result.kind === "alreadyReady") return void process.stdout.write(`已确认 ${label}，需求没有变化\n`);
      process.stdout.write(
        `已确认 ${label}：${result.scenarios} 个场景\n` +
          (result.assumed > 0 ? `还有 ${result.assumed} 项 [assumed] 没有得到用户确认\n` : ""),
      );
    });

  task
    .command("close <id>")
    .description("完成任务并写下结果，或给 done 任务补录改动文件")
    .option("--result <总结>", "完成 ready 或 active 任务时必填：做成了什么、完成条件是否都满足、怎么验证的")
    // 占位名用拉丁字母：commander 靠 `\w...>` 认出“可以给多个”，中文占位名认不出来。
    .option("--paths <path...>", "主会话自己改动的文件", [])
    .option("--reason <理由>", "独立审查的任务没有审查通过的记录时，直接完成的理由")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { result?: string; paths: string[]; reason?: string; dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const result = closeTask(root, id, options);
      if (result.kind === "refused") return fail(result.problems);
      const label = taskLabel(result.title, id);
      process.stdout.write(result.kind === "pathsRegistered" ? `已补录 ${label}的改动路径：${result.paths.join("、")}\n` : `已完成 ${label}\n`);
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
      const lines = [`已取消 ${taskLabel(result.title, id)}`, result.archiveDir, ...cleanupLines(root, result.cleanup)];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}
