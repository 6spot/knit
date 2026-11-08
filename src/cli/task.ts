/** task 命令组：new/rename/list/search/record/implement/ready/update/close（DESIGN.md 第4.1节）。 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { RunActivityService } from "../application/run-activity.js";
import { TaskService, type TaskListResult, type TaskSummary, type TaskUpdateResult } from "../application/task-service.js";
import type { TaskListProblem } from "../application/task-history.js";
import { workflowOf } from "../application/workflow.js";
import { workflowStageDisplayName } from "../domain/workflow.js";
import { displayWidth, padDisplay } from "./display.js";
import { SessionService } from "../application/session-service.js";
import { searchHistory } from "../application/history-search.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cliMainRoot } from "./root.js";
import { gitSync } from "../infrastructure/process.js";

const RUNTIME_DIR = ".knit/.runtime";
const VERIFICATIONS = new Set(["none", "self", "independent"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const ARCHIVE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 可重复选项收集。 */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `task list` 默认视图：未归档任务按业务状态分段，归档只给条数与入口。 */
interface TaskListActiveView {
  root: string;
  scope: "active";
  active: TaskSummary[];
  archivedCount: number;
  problems: TaskListProblem[];
}

/** `task list --archive` 视图：按月分组的归档条目。 */
interface TaskListArchiveView {
  root: string;
  scope: "archive";
  archived: TaskSummary[];
  archivedCount: number;
  month?: string;
  problems: TaskListProblem[];
}

/** 归档路径里的月份与创建月日：tasks/archive/2026-11/11-02-slug。 */
function archiveLocation(relativePath: string): { month: string; date: string } | null {
  const match = /^tasks\/archive\/(\d{4}-\d{2})\/(\d{2}-\d{2})-/.exec(relativePath);
  return match === null ? null : { month: match[1] ?? "", date: match[2] ?? "" };
}

/** 默认视图：进行中／待归档／已取消三段，固定列对齐；阻塞只计数。 */
function renderActiveList(view: TaskListActiveView, dir: string): void {
  const workflow = workflowOf(cliMainRoot(dir));
  const groups = [
    { title: "进行中", rows: view.active.filter((task) => task.status === "open") },
    { title: "待归档", rows: view.active.filter((task) => task.status !== "open" && task.outcome !== "cancelled" && task.outcome !== "superseded") },
    { title: "已取消", rows: view.active.filter((task) => task.status !== "open" && (task.outcome === "cancelled" || task.outcome === "superseded")) },
  ].map((group) => ({
    title: group.title,
    blocked: group.rows.filter((task) => task.blocked.length > 0).length,
    rows: group.rows.map((task) => ({
      priority: task.priority,
      taskId: task.taskId,
      stage: workflowStageDisplayName(workflow, task.stage),
      title: task.title,
    })),
  }));
  const cells = groups.flatMap((group) => group.rows);
  const priorityWidth = Math.max(displayWidth("优先级"), ...cells.map((row) => displayWidth(row.priority)));
  const taskIdWidth = Math.max(displayWidth("ID"), ...cells.map((row) => displayWidth(row.taskId)));
  const stageWidth = Math.max(displayWidth("阶段"), ...cells.map((row) => displayWidth(row.stage)));
  const line = (row: { priority: string; taskId: string; stage: string; title: string }): string =>
    `  ${padDisplay(row.priority, priorityWidth)}  ${padDisplay(row.taskId, taskIdWidth)}  ${padDisplay(row.stage, stageWidth)}  ${row.title}`;
  let headerPrinted = false;
  for (const group of groups) {
    console.log(`${group.title}（${group.rows.length}）`);
    if (group.rows.length === 0) continue;
    if (!headerPrinted) {
      console.log(`  ${padDisplay("优先级", priorityWidth)}  ${padDisplay("ID", taskIdWidth)}  ${padDisplay("阶段", stageWidth)}  标题`);
      headerPrinted = true;
    }
    for (const row of group.rows) console.log(line(row));
  }
  console.log(`进行中 ${groups[0]?.rows.length ?? 0} · 待归档 ${groups[1]?.rows.length ?? 0} · 已取消 ${groups[2]?.rows.length ?? 0} · 阻塞 ${groups[0]?.blocked ?? 0} · 归档 ${view.archivedCount}（knit task list --archive）`);
  if (view.problems.length > 0) {
    console.log(`列表问题（${view.problems.length}）：`);
    for (const problem of view.problems) console.log(`  ${problem.path}  ${problem.message}`);
  }
}

/** 归档视图：按月分组、组内按创建月日倒序；异常与跨机历史只做汇总。 */
function renderArchiveList(view: TaskListArchiveView): void {
  const rows = view.archived.map((task) => {
    const location = archiveLocation(task.relativePath);
    return {
      month: location?.month ?? "未知",
      date: location?.date ?? "-",
      taskId: task.taskId,
      outcome: task.outcome ?? "-",
      title: task.title,
    };
  });
  const dateWidth = Math.max(displayWidth("日期"), ...rows.map((row) => displayWidth(row.date)));
  const taskIdWidth = Math.max(displayWidth("ID"), ...rows.map((row) => displayWidth(row.taskId)));
  const outcomeWidth = Math.max(displayWidth("结论"), ...rows.map((row) => displayWidth(row.outcome)));
  const line = (row: (typeof rows)[number]): string =>
    `  ${padDisplay(row.date, dateWidth)}  ${padDisplay(row.taskId, taskIdWidth)}  ${padDisplay(row.outcome, outcomeWidth)}  ${row.title}`;
  const months = [...new Set(rows.map((row) => row.month))].sort().reverse();
  if (months.length === 0) console.log(view.month === undefined ? "归档（0）" : `归档 ${view.month}（0）`);
  for (const month of months) {
    const group = rows.filter((row) => row.month === month).sort((left, right) => right.date.localeCompare(left.date));
    console.log(`归档 ${month}（${group.length}）`);
    if (month === months[0]) {
      console.log(`  ${padDisplay("日期", dateWidth)}  ${padDisplay("ID", taskIdWidth)}  ${padDisplay("结论", outcomeWidth)}  标题`);
    }
    for (const row of group) console.log(line(row));
  }
  const invalid = view.archived.filter((task) => task.history?.kind === "invalid");
  const gitHistory = view.archived.filter((task) => task.history?.kind === "git-history").length;
  const abnormal = invalid.length + view.problems.length;
  if (gitHistory > 0 || abnormal > 0) {
    console.log(`跨机历史 ${gitHistory} 条 · 档案异常 ${abnormal} 条`);
    for (const task of invalid) console.log(`  ${task.relativePath}/task.md  ${(task.history?.problems ?? []).join("；")}`);
    for (const problem of view.problems) console.log(`  ${problem.path}  ${problem.message}`);
  }
}

function openStore(dir: string): SqliteMetadataStore {
  // 元数据库固定在主检出；worktree 内不新建。
  return new SqliteMetadataStore(join(cliMainRoot(dir), RUNTIME_DIR, "metadata.db"));
}

function summarizeUpdate(result: TaskUpdateResult): string {
  switch (result.applied) {
    case "direct":
      return `已按 ${result.inputsDigest.slice(0, 12)} 应用更新`;
    case "pending_saved":
      return `已保存待应用草案 ${result.pendingDraftDigest?.slice(0, 12)}（输入未改；run 结束后 --apply-pending --expect-pending 应用）`;
    case "pending_applied":
      return `已应用待应用草案；输入摘要 ${result.inputsDigest.slice(0, 12)}`;
    case "pending_withdrawn":
      return "已撤回待应用草案；冻结输入与阶段不变";
  }
}

export function registerTaskCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const task = program.command("task").description("任务身份、输入与记录管理");

  const withStore = async <T>(requestId: string, dir: string, fn: (store: SqliteMetadataStore) => Promise<T>, render: (result: T) => void, failureCode?: (result: T) => boolean): Promise<void> => {
    const store = openStore(dir);
    try {
      const result = await fn(store);
      if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
      else render(result);
      if (failureCode?.(result) === true) process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
      if (jsonMode()) {
        emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
      } else {
        console.error(`knit: ${message}`);
        process.exitCode = 1;
      }
    } finally {
      store.close();
    }
  };

  const withService = async <T>(requestId: string, dir: string, fn: (service: TaskService, store: SqliteMetadataStore) => Promise<T>, render: (result: T) => void, failureCode?: (result: T) => boolean): Promise<void> => {
    const store = openStore(dir);
    try {
      const service = new TaskService({ store, runActivity: new RunActivityService({ store }) });
      const result = await fn(service, store);
      if (jsonMode()) {
        emit(jsonResponse(requestId, "completed", result));
      } else {
        render(result);
      }
      if (failureCode?.(result) === true) process.exitCode = 1;
    } catch (error) {
      const reason = reasonForError(error);
      const outcome = outcomeForError(error);
      const message = error instanceof Error ? error.message : String(error);
      if (jsonMode()) {
        emit(jsonResponse(requestId, outcome, { error: message }, reason));
      } else {
        console.error(`knit: ${message}`);
      }
      process.exitCode = 1;
    } finally {
      store.close();
    }
  };

  task
    .command("new")
    .description("创建任务：稳定 ID、MM-DD-<slug> 目录与初始记录")
    .option("--title <title>", "任务标题", "未命名任务")
    .option("--slug <slug>", "目录名 slug（默认 task）")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .option("--branch <branch>", "绑定完整本地分支引用（默认当前分支）")
    .option("--verification <mode>", "完成验证：none、self 或 independent", "self")
    .option("--parent <taskId>", "挂接已存在的父任务（稳定身份）")
    .option("--priority <priority>", "任务自身优先级：P0、P1、P2 或 P3", "P2")
    .option("--depends-on <ids>", "前置依赖任务 ID（逗号分隔）")
    .action(async (options) => {
      const requestId = `task-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!VERIFICATIONS.has(options.verification)) {
        const reason = `未知 --verification "${options.verification}"`;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      const current = gitSync(["symbolic-ref", "-q", "HEAD"], options.dir);
      const branch = options.branch ?? (current.code === 0 && current.stdout.trim() !== "" ? current.stdout.trim() : null);
      const priority = String(options.priority ?? "P2").toUpperCase();
      if (!PRIORITIES.has(priority)) {
        const reason = `未知 --priority "${options.priority}"`;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      const dependsOn = options.dependsOn === undefined ? [] : String(options.dependsOn).split(",").map((id) => id.trim()).filter((id) => id !== "");
      await withService(requestId, options.dir, (service) => service.newTask({ dir: options.dir, title: options.title, slug: options.slug, branch, verification: options.verification, parent: options.parent ?? null, priority: priority as "P0" | "P1" | "P2" | "P3", dependsOn }), (result) => {
        console.log(`任务已创建: ${result.taskId}`);
        console.log(`目录: ${result.relativePath}`);
        console.log(`完成验证: ${options.verification}`);
        console.log(`优先级: ${result.priority}`);
        if (result.dependsOn.length > 0) console.log(`前置依赖: ${result.dependsOn.join(", ")}`);
        if (result.parent !== null) console.log(`父任务: ${result.parent}`);
      });
    });

  task
    .command("parent <taskId> [parentTaskId]")
    .description("挂接父任务或解除关联：只改结构关系，不使输入摘要失效")
    .option("--detach", "解除当前父任务关联")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, parentTaskId, options) => {
      const requestId = `task-parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (options.detach === true && parentTaskId !== undefined) {
        const reason = "--detach 与父任务 ID 不能同时提供";
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      if (options.detach !== true && (typeof parentTaskId !== "string" || parentTaskId === "")) {
        const reason = "需要父任务 ID，或用 --detach 解除关联";
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      const parentId = options.detach === true ? null : parentTaskId;
      await withService(requestId, options.dir, (service) => service.setParent({ dir: options.dir, taskId, parentId }), (result) => {
        console.log(`${result.taskId} 父任务: ${result.previous ?? "无"} → ${result.parent ?? "无"}`);
        if (result.children.length > 0) console.log(`该父任务子任务: ${result.children.join(", ")}`);
      });
    });

  task
    .command("priority <taskId> <priority>")
    .description("设置任务自身优先级：P0 最高，未指定默认 P2")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, priorityArg, options) => {
      const requestId = `task-priority-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const priority = String(priorityArg ?? "").toUpperCase();
      if (!PRIORITIES.has(priority)) {
        const reason = `未知优先级 "${priorityArg}"（P0、P1、P2、P3）`;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      await withService(requestId, options.dir, (service) => service.setPriority({ dir: options.dir, taskId, priority: priority as "P0" | "P1" | "P2" | "P3" }), (result) => {
        console.log(`${result.taskId} 优先级: ${result.previous} → ${result.priority}${result.changed ? "" : "（未变化）"}`);
      });
    });

  const listOf = (values: unknown): string[] =>
    (Array.isArray(values) ? values : []).flatMap((value) => String(value).split(",")).map((id) => id.trim()).filter((id) => id !== "");

  task
    .command("depends <taskId>")
    .description("设置前置依赖：未完成的前置任务阻塞实施启动")
    .option("--add <ids...>", "新增前置依赖任务 ID")
    .option("--remove <ids...>", "移除前置依赖任务 ID")
    .option("--set <ids...>", "整体替换前置依赖")
    .option("--clear", "清空前置依赖")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-depends-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (options.clear !== true && listOf(options.set).length === 0 && listOf(options.add).length === 0 && listOf(options.remove).length === 0) {
        const reason = "task depends 需要 --add／--remove／--set 或 --clear";
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      await withService(requestId, options.dir, (service) => service.setDependencies({
        dir: options.dir,
        taskId,
        set: options.clear === true ? [] : listOf(options.set).length > 0 ? listOf(options.set) : undefined,
        add: listOf(options.add),
        remove: listOf(options.remove),
      }), (result) => {
        console.log(`${result.taskId} 前置依赖: ${result.previous.length === 0 ? "无" : result.previous.join(", ")} → ${result.dependsOn.length === 0 ? "无" : result.dependsOn.join(", ")}`);
        for (const blocker of result.blocked) console.log(`  阻塞: ${blocker.taskId}（${blocker.problem}）`);
      });
    });

  task
    .command("order <taskId>")
    .description("在优先级分组内调整业务执行顺序；不改写原始创建时间")
    .option("--before <taskId>", "排在指定任务之前（须与目标同优先级）")
    .option("--after <taskId>", "排在指定任务之后（须与目标同优先级）")
    .option("--top", "排到本优先级分组最前")
    .option("--bottom", "排到本优先级分组最后")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const choices = [options.before !== undefined, options.after !== undefined, options.top === true, options.bottom === true].filter(Boolean).length;
      if (choices !== 1) {
        const reason = "task order 需要 --before/--after/--top/--bottom 之一";
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      const position = options.before !== undefined
        ? { before: options.before }
        : options.after !== undefined
          ? { after: options.after }
          : options.top === true
            ? { top: true as const }
            : { bottom: true as const };
      await withService(requestId, options.dir, (service) => service.reorder({ dir: options.dir, taskId, position }), (result) => {
        console.log(`业务执行顺序（${result.order.length}）: ${result.order.join(" → ")}`);
        console.log(`写入顺序号: ${result.updated.length === 0 ? "无变化" : result.updated.join(", ")}`);
      });
    });

  task
    .command("next")
    .description("按稳定执行顺序列出活跃任务与不能启动的原因")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = `task-next-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(requestId, options.dir, (service) => Promise.resolve(service.next({ dir: options.dir })), (result) => {
        if (result.entries.length === 0) {
          console.log("（没有活跃任务）");
          return;
        }
        for (const entry of result.entries) {
          const blocked = entry.blocked.map((blocker) => `${blocker.taskId}(${blocker.problem})`).join(", ");
          console.log(`${entry.priority}  ${entry.taskId}  [${entry.stage}]  ${entry.title}${blocked === "" ? "" : `  ⛔ ${blocked}`}`);
        }
        console.log(`下一项: ${result.next ?? "无（全部被前置依赖阻塞）"}`);
      });
    });

  task
    .command("adopt <taskId>")
    .description("接管当前可见分支：不切分支，不附带提交授权")
    .option("--branch <branch>", "完整 refs/heads/... 或 current", "current")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      await withService(
        `task-adopt-${Date.now()}`,
        options.dir,
        async (service) => service.adopt({ dir: options.dir, taskId, branch: options.branch }),
        (result) => {
          console.log(`任务 ${result.taskId}: ${result.adopted ? "已接管" : "已绑定"} ${result.branch}`);
          if (result.previousBranch === null) console.log("原分支: 无（首次接管）");
          else if (result.previousBranch !== result.branch) console.log(`原分支: ${result.previousBranch}`);
          if (result.checkInvalidated) console.log(`旧检查已失效；阶段保持 ${result.stage}`);
        },
      );
    });

  task
    .command("rename <taskId> <newSlug>")
    .description("按稳定 ID 改目录名；等价移动不影响检查资格")
    .option("--dir <dir>", "项目目录", ".")
    .option("--non-equivalent", "声明不等价改名（将使检查 stale）")
    .action(async (taskId, newSlug, options) => {
      const requestId = `task-rename-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(requestId, options.dir, (service) => service.rename({ dir: options.dir, taskId, newSlug, equivalent: !options.nonEquivalent }), (result) => {
        console.log(`任务目录: ${result.from} → ${result.to}${result.equivalent ? "（等价移动）" : "（非等价：检查失效待复查）"}`);
      });
    });

  task
    .command("list")
    .description("列出进行中／待归档／已取消任务；归档用 --archive 按月查看")
    .option("--dir <dir>", "项目目录", ".")
    .option("--archive", "列出归档任务（按月分组）")
    .option("--month <month>", "只列指定归档月份 YYYY-MM（隐含 --archive）")
    .action(async (options) => {
      const month = typeof options.month === "string" ? options.month : undefined;
      if (month !== undefined && !ARCHIVE_MONTH_PATTERN.test(month)) {
        console.error(`knit: 非法归档月份 ${month}，应为 YYYY-MM`);
        process.exitCode = 1;
        return;
      }
      const archiveView = options.archive === true || month !== undefined;
      const requestId = `task-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(
        requestId,
        options.dir,
        (service): Promise<TaskListActiveView | TaskListArchiveView> => {
          const result: TaskListResult = service.list({ dir: options.dir });
          // 月份过滤同时约束问题明细：其它月份的诊断不混进本次视图。
          const problems = month === undefined ? result.problems : result.problems.filter((problem) => problem.path.includes(`/archive/${month}/`));
          if (archiveView) {
            const archived = month === undefined ? result.archived : result.archived.filter((task) => archiveLocation(task.relativePath)?.month === month);
            const payload: TaskListArchiveView = { root: result.root, scope: "archive", archived, archivedCount: result.archived.length, problems };
            return Promise.resolve(month === undefined ? payload : { ...payload, month });
          }
          return Promise.resolve({ root: result.root, scope: "active", active: result.active, archivedCount: result.archived.length, problems });
        },
        (view) => {
          if (view.scope === "archive") renderArchiveList(view);
          else renderActiveList(view, options.dir);
        },
      );
    });

  task
    .command("search <query...>")
    .description("只读检索任务、归档、run 记录与 Git 历史")
    .option("--scope <scope>", "检索范围：task、archive、run 或 git；缺省全部")
    .option("--limit <n>", "最多返回条数（默认 20，上限 100）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (query: string[], options) => {
      const requestId = `task-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const hits = searchHistory({
          dir: options.dir,
          query,
          scope: options.scope,
          limit: options.limit === undefined ? undefined : Number(options.limit),
        });
        if (jsonMode()) {
          // 无匹配返回空数组；不写任务、runtime 或索引。
          emit(jsonResponse(requestId, "completed", hits));
          return;
        }
        if (hits.length === 0) {
          console.log(`未找到匹配记录: ${query.join(" ")}`);
          return;
        }
        console.log(`匹配记录（${hits.length}）:`);
        for (const hit of hits) {
          const location = hit.kind === "run" ? `  (${hit.path}${hit.line === null ? "" : `:${hit.line}`})` : "";
          console.log(`  [${hit.kind}] ${hit.ref}${location}${hit.taskId === null ? "" : `  ${hit.taskId}`}  ${hit.snippet}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
        else console.error(`knit: ${message}`);
        process.exitCode = 1;
      }
    });

  task
    .command("record <taskId>")
    .description("写任务记录区（只改记录，不使检查失效）")
    .option("--file <path>", "记录正文文件；缺省读 stdin")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-record-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body = options.file ? readFileSync(options.file, "utf8") : await readStdin();
      await withService(requestId, options.dir, (service) => service.record({ dir: options.dir, taskId, body }), (result) => {
        if (result.saved) console.log(`记录已写入: ${taskId}`);
        else console.log(`未保存（${result.reason ?? "sealed"}）：封存结束后按原意图重试`);
      }, (result) => !result.saved);
    });

  task
    .command("implement <taskId>")
    .description("记录主会话／用户实施事实：输入摘要、成果路径指纹与实际验证（无 worker run 的完成路径）")
    .option("--path <path>", "实际改动路径（可重复）", collect, [] as string[])
    .option("--validation <text>", "实际运行的验证与结果（可重复）", collect, [] as string[])
    .option("--unverified <text>", "已知未验证项（可重复）", collect, [] as string[])
    .option("--summary <text>", "实施摘要")
    .option("--by <executor>", "执行者：main-session 或 user", "main-session")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-implement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!["main-session", "user"].includes(options.by)) {
        const reason = `未知 --by "${options.by}"`;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      await withService(
        requestId,
        options.dir,
        (service) =>
          service.implement({
            dir: options.dir,
            taskId,
            paths: options.path,
            validations: options.validation,
            unverified: options.unverified,
            summary: options.summary ?? null,
            executor: options.by,
          }),
        (result) => {
          console.log(`实施事实已记录: ${result.taskId}（${result.executor}）· 路径 ${result.paths.length} · 验证 ${result.validations}`);
        },
      );
    });

  const material = task.command("material").description("任务规划资料：plan/design/research（task.md 仍是业务状态唯一权威）");

  material
    .command("list <taskId>")
    .description("列出任务规划资料")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-material-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(requestId, options.dir, (service) => service.listMaterials({ dir: options.dir, taskId }), (entries) => {
        if (entries.length === 0) console.log("（无规划资料）");
        for (const entry of entries) console.log(`${entry.path}  ${entry.digest?.slice(0, 12) ?? ""}  ${entry.bytes ?? 0}B`);
      });
    });

  material
    .command("read <taskId> <path>")
    .description("读取单个任务规划资料")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, path, options) => {
      const requestId = `task-material-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(requestId, options.dir, (service) => service.readMaterial({ dir: options.dir, taskId, path }), (file) => {
        if (!file.exists) {
          console.error(`knit: 资料不存在: ${file.path}`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(file.content ?? "");
      });
    });

  material
    .command("save <taskId> <path>")
    .description("创建或整体覆盖任务规划资料；要求性内容变化须走 task update --kind")
    .option("--file <path>", "内容文件；缺省读 stdin")
    .option("--expect-digest <digest>", "乐观版本核对；不匹配报 version_conflict")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, path, options) => {
      const requestId = `task-material-save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const content = options.file ? readFileSync(options.file, "utf8") : await readStdin();
      await withService(
        requestId,
        options.dir,
        (service) => service.saveMaterial({ dir: options.dir, taskId, path, content, expectDigest: options.expectDigest }),
        (result) => console.log(`${result.created ? "已创建" : "已更新"}: ${result.path} (${result.digest.slice(0, 12)})`),
      );
    });

  material
    .command("delete <taskId> <path>")
    .description("删除 research/ 下的任务资料；plan/design 不提供单独删除")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, path, options) => {
      const requestId = `task-material-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(requestId, options.dir, (service) => service.deleteMaterial({ dir: options.dir, taskId, path }), (result) => {
        if (!result.removed) {
          console.error(`knit: 资料不存在: ${path}`);
          process.exitCode = 1;
          return;
        }
        console.log(`已删除: ${path}`);
      });
    });

  task
    .command("ready [taskId]")
    .description("保存讨论确认：discuss → implement，冻结当前输入摘要")
    .option("--session <knitSessionId>", "主会话 Knit Session ID；省略 taskId 时使用其已落盘选择")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-ready-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let resolvedTaskId = typeof taskId === "string" ? taskId.trim() : "";
      const rejectBeforeResolve = (reason: string, message: string): void => {
        process.exitCode = 1;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${message}（${reason}）`);
      };
      if (resolvedTaskId === "") {
        const sessionId = typeof options.session === "string" ? options.session.trim() : "";
        if (sessionId === "") {
          rejectBeforeResolve(
            "task_id_required",
            "缺少 taskId：knit task ready <taskId>；或先 knit task use <taskId> --session <id> 再用 --session 解析",
          );
          return;
        }
        const store = openStore(options.dir);
        try {
          const resolution = await new SessionService({ store }).resolveSelection(options.dir, sessionId);
          if (resolution.effective && typeof resolution.taskId === "string" && resolution.taskId !== "") {
            resolvedTaskId = resolution.taskId;
          } else {
            const record = await store.sessions.getByKnitId(sessionId);
            const pending =
              resolution.reason === "selection_not_persisted" ||
              (record !== null && record.selection !== null && record.selection.persisted === false);
            rejectBeforeResolve(
              pending ? "selection_pending" : "selection_missing",
              pending
                ? "当前会话的任务选择尚未落盘：先结束当前轮次让选择落盘，或直接提供 <taskId>"
                : "当前会话没有可用任务选择：先 knit task use <taskId> --session <id>，或直接提供 <taskId>",
            );
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
          else console.error(`knit: ${message}`);
          process.exitCode = 1;
          return;
        } finally {
          store.close();
        }
      }
      await withService(requestId, options.dir, (service) => service.ready({ dir: options.dir, taskId: resolvedTaskId }), (result) => {
        console.log(`讨论已确认: ${result.taskId} → ${result.stage}`);
        console.log(`冻结输入摘要: ${result.confirmedInputsDigest.slice(0, 12)}`);
      });
    });

  task
    .command("update <taskId>")
    .description("输入更新：--kind clarify/change（活动 run 中需 --run <id>；--pending 只存草案），或 --apply-pending/--withdraw-pending --expect-pending <digest>")
    .option("--kind <kind>", "clarify 或 change")
    .option("--file <path>", "输入正文文件；缺省读 stdin")
    .option("--reason <text>", "更新／撤回理由", "")
    .option("--run <runId>", "目标有活动 run 时声明该 run（缺省读环境变量 KNIT_RUN）；运行中改输入，收尾判 stale_input")
    .option("--pending", "只保存待应用草案，不改输入（不需要 --run）；之后 --apply-pending 应用")
    .option("--apply-pending", "应用待应用草案")
    .option("--withdraw-pending", "撤回待应用草案（需 --reason）")
    .option("--expect-pending <digest>", "草案版本摘要")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const hasPendingMode = Boolean(options.applyPending || options.withdrawPending);
      if (!hasPendingMode && !options.kind) {
        const reason = "task update 需要 --kind clarify/change 或 --apply-pending/--withdraw-pending";
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      const kind = options.kind;
      if (!hasPendingMode && kind !== "clarify" && kind !== "change") {
        const reason = `未知 --kind "${kind ?? ""}"`;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      const content = hasPendingMode ? "" : options.file ? readFileSync(options.file, "utf8") : await readStdin();
      await withService(
        requestId,
        options.dir,
        (service) =>
          service.update({
            dir: options.dir,
            taskId,
            kind,
            reason: options.reason,
            content,
            run: hasPendingMode ? null : (options.run ?? process.env.KNIT_RUN ?? null) || null,
            pending: !hasPendingMode && options.pending === true,
            expectPending: options.expectPending,
            withdrawReason: options.withdrawPending ? options.reason || "未提供理由" : undefined,
          }),
        (result) => {
          console.log(`${taskId}: ${summarizeUpdate(result)}`);
          console.log(`stage: ${result.stage}  status: ${result.status}`);
        },
      );
    });

  task
    .command("verification <taskId>")
    .description("设置完成验证要求（仅讨论阶段）：none、self 或 independent")
    .requiredOption("--mode <mode>", "none、self 或 independent")
    .option("--reason <reason>", "调整理由")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-verification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!VERIFICATIONS.has(options.mode)) {
        const reason = `未知 --mode "${options.mode}"`;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      await withService(
        requestId,
        options.dir,
        (service) => service.setVerification({ dir: options.dir, taskId, verification: options.mode, reason: options.reason }),
        (result) => {
          console.log(`任务 ${result.taskId}: 完成验证 ${result.changed ? "已更新为 " : "保持 "}${result.verification}`);
        },
      );
    });

  task
    .command("close <taskId>")
    .description("业务结束：--outcome completed/cancelled/superseded；不等于已提交归档")
    .requiredOption("--outcome <outcome>", "completed、cancelled 或 superseded")
    .option("--reason <reason>", "完成判断或结束说明；写入完成凭据")
    .option("--runs-settled", "确认该任务活动／未知运行与待接收结果已收敛", false)
    .option("--force", "强制完成：跳过完成资格证据核对，必须在 --reason 写明原因", false)
    .option("--no-artifacts", "显式声明本任务没有产物：空 scope 的 self／independent 才能完成，必须在 --reason 写明原因")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!["completed", "cancelled", "superseded"].includes(options.outcome)) {
        const reason = `未知 --outcome "${options.outcome}"`;
        if (jsonMode()) emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
        else console.error(`knit: ${reason}`);
        process.exitCode = 1;
        return;
      }
      await withService(
        requestId,
        options.dir,
        (service) =>
          service.close({
            dir: options.dir,
            taskId,
            outcome: options.outcome,
            reason: options.reason,
            runsSettled: options.runsSettled === true,
            force: options.force === true,
            noArtifacts: options.artifacts === false,
          }),
        (result) => {
          console.log(`任务已关闭: ${result.taskId} → ${result.status}/${result.outcome}${result.verification ? `（${result.verification}${result.forced ? "，强制" : ""}${result.artifacts === "none" ? "，声明无产物" : ""}）` : ""}${result.pendingWithdrawn ? "（未应用草案已撤回留记录）" : ""}`);
        },
      );
    });

  task
    .command("use <taskId>")
    .description("主会话选择任务：条目已落盘并核实才生效，否则只待确认")
    .requiredOption("--session <knitSessionId>", "主会话 Knit Session ID")
    .option("--operation-id <id>", "选择操作 ID（重试去重）")
    .option("--entry <entryId>", "已写入的原生条目引用")
    .option("--persisted", "条目已落盘并核实", false)
    .option("--branch <branch>", "选择时的分支")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (taskId, options) => {
      const requestId = `task-use-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withStore(requestId, options.dir, async (store) => {
        const service = new SessionService({ store });
        return service.useTask({
          dir: options.dir,
          knitSessionId: options.session,
          taskId,
          ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
          ...(options.entry === undefined ? {} : { entryRef: options.entry }),
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          persisted: Boolean(options.persisted),
        });
      }, (result) => {
        console.log(
          result.effectiveTaskId === null
            ? `选择待确认: ${result.selection.taskId}（原生条目未落盘）`
            : `已选择任务: ${result.effectiveTaskId}`,
        );
      });
    });

  task
    .command("clear")
    .description("主会话清除任务选择：追加空选择事件，不能让更早选择复活")
    .requiredOption("--session <knitSessionId>", "主会话 Knit Session ID")
    .option("--operation-id <id>", "选择操作 ID（重试去重）")
    .option("--entry <entryId>", "已写入的原生条目引用")
    .option("--persisted", "条目已落盘并核实", false)
    .option("--branch <branch>", "选择时的分支")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = `task-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withStore(requestId, options.dir, async (store) => {
        const service = new SessionService({ store });
        return service.clearTask({
          dir: options.dir,
          knitSessionId: options.session,
          ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
          ...(options.entry === undefined ? {} : { entryRef: options.entry }),
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          persisted: Boolean(options.persisted),
        });
      }, (result) => {
        console.log(result.selection.persisted ? "已清除任务选择" : "已清除任务选择（待确认）");
      });
    });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
