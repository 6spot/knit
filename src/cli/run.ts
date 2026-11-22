import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { builtinAgents } from "../adapters/agents.js";
import { cancelRun, startRun, waitRun } from "../application/run-control.js";
import { loadConfig } from "../application/config.js";
import { executeRun } from "../application/run-execute.js";
import { limitNotice, RUNS_DIR } from "../application/run-prepare.js";
import { livePane, liveWorker } from "../application/run-process.js";
import { findTask } from "../application/task-store.js";
import { taskWorktree } from "../application/worktree.js";
import { checkSchema } from "../contracts/schema.js";
import type { TaskRecord, TaskRun } from "../contracts/task.js";
import { AgentNameSchema } from "../contracts/workflow.js";
import { nextStep } from "../domain/progress.js";
import { currentStatus, type TaskDocument } from "../domain/task-document.js";
import type { WorkflowDefinition } from "../domain/workflow.js";

import { fail, knitRoot, loadTask, shownStatus } from "./task.js";
import { loadWorkflow } from "./workflow.js";

/** 一次执行的情况。 */
function runLines(root: string, workflow: WorkflowDefinition, taskId: string, run: TaskRun | undefined): string[] {
  if (run === undefined) return ["还没有派发过"];
  const dir = `${RUNS_DIR}/${run.id}`;
  // 执行记录里的环节已经不在流程里时用它的 id。
  const stage = workflow.stages.find((item) => item.id === run.stage)?.name ?? run.stage;
  const agent = `Agent: ${run.agent ?? "pi"}`;
  if (run.endedAt !== null) {
    return [
      `上一次: ${stage}（${run.id}）`,
      run.failure !== null ? `失败: ${run.failure}` : run.verdict !== null ? `结论: ${run.verdict}` : "结果: 正常结束",
      ...(existsSync(join(root, dir, "report.md")) ? [`报告: ${dir}/report.md`] : []),
      `改动文件: ${run.changedPaths.length} 个`,
      agent,
    ];
  }
  const pane = livePane(root, run.id) !== null;
  return liveWorker(root, run.id) === null
    ? [
        `执行 ${run.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${taskId} 记为失败`,
        agent,
        // 窗格里的执行者由 Rex 启动，后台进程退出后仍可能在运行。
        ...(pane
          ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格还开着，执行者还在里面；knit run cancel 会把它一起停掉`]
          : []),
      ]
    : [
        `正在跑: ${stage}（${run.id}），开始于 ${run.startedAt}`,
        `会话记录: ${dir}/session/`,
        agent,
        ...(pane ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格（最小化着）`] : []),
      ];
}

/** “下一步”那一行，到返工上限时后面还跟着各轮的报告和可以走的路；任务已经结束时没有。 */
function nextLine(workflow: WorkflowDefinition, document: TaskDocument, record: TaskRecord): string[] {
  const { id, verification } = document.frontmatter;
  const status = currentStatus(document, record);
  if (status === "draft") return [`下一步: 先确认需求（knit task ready ${id}）`];
  if (status === "done") return [`下一步: 用户授权后交付（knit deliver ${id}）`];
  if (status !== "ready" && status !== "active") return [];
  const step = nextStep(workflow, verification, record);
  if (step.kind === "close") return [`下一步: 核对之后运行 knit task close ${id}`];
  if (step.kind === "limit") {
    const [first, ...rest] = limitNotice(id, workflow, record, step);
    return [`下一步: ${first}`, ...rest];
  }
  return [`下一步: 派发${step.stage.name}环节（knit run start ${id}）`];
}

/** `knit run status` 的输出：任务、状态、上一次或正在跑的执行、下一步。 */
export function statusLines(
  root: string,
  workflow: WorkflowDefinition,
  document: TaskDocument,
  record: TaskRecord,
): string[] {
  const last = record.runs.at(-1);
  const stored = findTask(root, document.frontmatter.id);
  const worktree = stored == null ? null : taskWorktree(root, stored.dir);
  return [
    `任务: ${document.frontmatter.title}（${document.frontmatter.id}）`,
    `状态: ${shownStatus(document, record).text}`,
    ...(worktree !== null && existsSync(join(worktree.path, ".git"))
      ? [`Worktree: ${worktree.path}（${worktree.branch}）`]
      : []),
    ...runLines(root, workflow, document.frontmatter.id, last),
    // 有执行还没结束时不给下一步。
    ...(last?.endedAt === null ? [] : nextLine(workflow, document, record)),
  ];
}

/**
 * 等任务正在跑的执行结束，返回这时候的 `statusLines`；读不出任务或流程时报错并返回 null。
 * 每秒重新读一次任务文件。不设超时：执行者卡住时一直等，要停就停掉这个命令或者 knit run cancel。
 */
async function waitForRun(dir: string, id: string): Promise<string[] | null> {
  const root = knitRoot(dir);
  if (root === null) return null;
  const waited = await waitRun(root, id);
  if (waited.task === null || waited.workflow === null) {
    fail(waited.problems);
    return null;
  }
  return statusLines(root, waited.workflow, waited.task.document, waited.task.record);
}

export function registerRunCommands(program: Command): void {
  const run = program.command("run").description("派发环节的执行者");

  run
    .command("start <id>")
    .description("派发任务的下一个环节；等 Worktree 准备命令完成后返回，执行者在后台跑")
    .option("--model <模型>", "这一次用的模型（Pi 用 provider/模型，agy 用模型 ID）")
    .option("--thinking <等级>", "这一次用的思考等级：off、minimal、low、medium、high、xhigh、max")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { model?: string; thinking?: string; dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const { config, problems } = loadConfig(root);
      if (config === null) return fail(problems);
      const workflow = loadWorkflow(root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const session = process.env.KNIT_SESSION_AGENT;
      const sessionAgent = checkSchema(AgentNameSchema, session) ? session : "pi";
      const prepared = startRun({
        root, taskId: id, workflow, config, model: options.model ?? null, thinking: options.thinking,
        sessionDefaults: { agent: sessionAgent, ...builtinAgents[sessionAgent].sessionDefaults() },
        checkAgent: (agent, capabilities, worktree) => builtinAgents[agent].checkDispatch?.(root, worktree.path, worktree.branch, capabilities) ?? null,
        workerCommand: (started) => [
          process.execPath, process.argv[1]!, "run", "worker", started.id, "--task", id,
          ...(started.model === null ? [] : ["--model", started.model]),
          ...(started.thinking === null ? [] : ["--thinking", started.thinking]), "--dir", root,
        ],
      });
      if (prepared.run === null) return fail(prepared.problems);
      const started = prepared.run;
      process.stdout.write(
        `已派发 ${id}：${started.stage.name}（${started.id}）\n` +
        `Worktree: ${started.worktree.path}（${started.worktree.branch}）\n` +
        (started.setupCommands === undefined ? "" : `已运行准备命令：${started.setupCommands} 条\n`) +
        `会话记录：${started.dir}/session/\n`,
      );
    });

  run
    .command("status <id>")
    .description("显示任务上一次或正在跑的执行，以及下一步")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { dir: string }) => {
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const workflow = loadWorkflow(loaded.root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const lines = statusLines(loaded.root, workflow, loaded.document, loaded.record);
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });

  run
    .command("wait <id>")
    .description("等任务正在跑的执行结束，然后显示和 status 一样的内容；没有执行在跑时立即返回")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action(async (id: string, options: { dir: string }) => {
      const lines = await waitForRun(options.dir, id);
      if (lines !== null) process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });

  run
    .command("cancel <id>")
    .description("停掉任务正在跑的执行，记为失败；后台进程已经不在的也用它记为失败")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action(async (id: string, options: { dir: string }) => {
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const workflow = loadWorkflow(loaded.root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const { root } = loaded;
      const taskId = loaded.document.frontmatter.id;
      const result = await cancelRun({ root, taskId, workflow });
      if (result.cancelled === null) return fail(result.problems);
      const first = result.cancelled.workerMissing
        ? `执行 ${result.cancelled.runId} 的进程已经不在了，已记为失败`
        : `已取消 ${taskId} 的执行 ${result.cancelled.runId}`;
      process.stdout.write(`${first}\n改动文件: ${result.cancelled.changedPaths.length} 个\n`);
    });

  run
    .command("worker <runId>", { hidden: true })
    .requiredOption("--task <id>", "任务")
    .option("--model <模型>", "模型")
    .option("--thinking <等级>", "思考等级")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action(async (runId: string, options: { task: string; model?: string; thinking?: string; dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const workflow = loadWorkflow(root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const problems = await executeRun({
        root,
        taskId: options.task,
        runId,
        workflow,
        model: options.model ?? null,
        thinking: options.thinking,
        // 主会话在 Rex 里跑时，它启动的进程都带着这两个变量。
        rex:
          process.env.REX_SESSION && process.env.REX_BLOCK
            ? { session: process.env.REX_SESSION, block: process.env.REX_BLOCK }
            : null,
      });
      if (problems.length > 0) fail(problems);
    });
}
