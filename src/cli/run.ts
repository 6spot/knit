import { readFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { builtinAgents } from "../adapters/agents.js";
import { RexPaneHost } from "../adapters/rex/pane.js";
import { cancelRun, startRun, waitRun } from "../application/run-control.js";
import { loadConfig } from "../application/config.js";
import { executeRun } from "../application/run-execute.js";
import { arbitrationNotice, limitNotice, RUNS_DIR } from "../application/run-prepare.js";
import { buildTaskStatus, type SessionTaskStatus } from "../application/session-context.js";
import { checkSchema } from "../contracts/schema.js";
import { AgentNameSchema, DEFAULT_AGENT } from "../contracts/workflow.js";
import { fail, knitRoot, loadTask } from "./task.js";
import { loadWorkflow } from "./workflow.js";

/** 一次执行的情况。 */
function runLines(task: SessionTaskStatus, member: SessionTaskStatus["members"][number]): string[] {
  const run = member.run;
  const dir = `${RUNS_DIR}/${run.id}`;
  const agent = `Agent: ${run.agent ?? "pi"}`;
  if (run.endedAt !== null) {
    return [
      `上一次: ${task.stageName}（${run.id}）`,
      run.failure !== null ? `失败: ${run.failure}` : run.verdict !== null ? `结论: ${run.verdict}` : "结果: 正常结束",
      ...(member.report === null || run.batchId ? [] : [`报告: ${member.report}`]),
      `改动文件: ${run.changedPaths.length} 个`,
      agent,
    ];
  }
  if (member.starting) return [`正在启动: ${task.stageName}（${run.id}）`, agent];
  return !member.worker
    ? [
        `执行 ${run.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${task.frontmatter.id} 记为失败`,
        agent,
        // 窗格里的执行者由 Rex 启动，后台进程退出后仍可能在运行。
        ...(member.pane
          ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格还开着，执行者还在里面；knit run cancel 会把它一起停掉`]
          : []),
      ]
    : [
        `正在跑: ${task.stageName}（${run.id}），开始于 ${run.startedAt}`,
        `会话记录: ${dir}/session/`,
        agent,
        ...(member.pane ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格（最小化着）`] : []),
      ];
}

/** “下一步”那一行，到返工上限时后面还跟着各轮的报告和可以走的路；任务已经结束时没有。 */
function nextLine(task: SessionTaskStatus): string[] {
  const id = task.frontmatter.id;
  const status = task.status;
  if (status === "draft") return [`下一步: 先确认需求（knit task ready ${id}）`];
  if (status === "done") return [`下一步: 用户授权后交付（knit deliver ${id}）`];
  const step = task.next;
  if (step === null || step.kind === "running") return [];
  if (step.kind === "arbitrate") return [`下一步: ${arbitrationNotice(id, step).join("\n")}`];
  if (step.kind === "close") return [`下一步: 核对之后运行 knit task close ${id}`];
  if (step.kind === "limit") {
    const [first, ...rest] = limitNotice(id, task.workflow, task.record, step);
    return [`下一步: ${first}`, ...rest];
  }
  return [`下一步: 派发${step.stage.name}环节（knit run start ${id}）`];
}

/** `knit run status` 的输出：任务、状态、上一次或正在跑的执行、下一步。 */
export function statusLines(task: SessionTaskStatus): string[] {
  return [
    `任务: ${task.frontmatter.title}（${task.frontmatter.id}）`,
    `状态: ${task.status === "active" ? `active(${task.frontmatter.stage})` : task.status}`,
    ...(task.worktree === null ? [] : [`Worktree: ${task.worktree.path}（${task.worktree.branch}）`]),
    ...(task.members.length ? task.members.flatMap((member) => [
      ...(member.run.batchId ? [`执行器: ${member.run.executor ?? member.run.id}`, `报告: ${member.path}`] : []),
      ...runLines(task, member),
    ]) : ["还没有派发过"]),
    ...(task.members.some(({ run }) => run.endedAt === null) ? [] : nextLine(task)),
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
  return statusLines(buildTaskStatus(root, waited.task.dir, waited.workflow, waited.task.document, waited.task.record, waited.batchId));
}

export function registerRunCommands(program: Command): void {
  const run = program.command("run").description("派发环节的执行者");

  run
    .command("start <id>")
    .description("派发任务的下一个环节；等 Worktree 准备命令完成后返回，执行者在后台跑")
    .addOption(new Option("--instruction <文本>", "主会话的裁决或修改清单").conflicts("instructionFile"))
    .option("--instruction-file <文件>", "读取主会话修改指令")
    .option("--stage <环节>", "主会话裁决时指定派发环节")
    .option("--model <模型>", "这一次用的模型（Pi 用 provider/模型，agy 用模型 ID）")
    .option("--thinking <等级>", "这一次用的思考等级：off、minimal、low、medium、high、xhigh、max")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { model?: string; thinking?: string; instruction?: string; instructionFile?: string; stage?: string; dir: string }) => {
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
      const sessionAgent = checkSchema(AgentNameSchema, session) ? session : DEFAULT_AGENT;
      const prepared = startRun({
        root, taskId: id, workflow, config, model: options.model ?? null, thinking: options.thinking,
        instruction: options.instructionFile === undefined ? options.instruction : readFileSync(options.instructionFile, "utf8"),
        stage: options.stage,
        sessionDefaults: { agent: sessionAgent, ...builtinAgents[sessionAgent].sessionDefaults() },
        checkAgent: (agent, capabilities, worktree) => builtinAgents[agent].checkDispatch?.(root, worktree.path, worktree.branch, capabilities) ?? null,
        workerCommand: (started) => [
          process.execPath, process.argv[1]!, "run", "worker", started.id, "--task", id,
          ...(started.model === null ? [] : ["--model", started.model]),
          ...(started.thinking === null ? [] : ["--thinking", started.thinking]), "--dir", root,
        ],
      });
      if (prepared.run === null) return fail(prepared.problems);
      prepared.runs.forEach((started) => process.stdout.write(
        `已派发 ${id}：${started.stage.name}（${started.id}）${started.executor ? ` ${started.executor}` : ""}\n` +
        `Worktree: ${started.worktree.path}（${started.worktree.branch}）\n` +
        (started.setupCommands === undefined ? "" : `已运行准备命令：${started.setupCommands} 条\n`) +
        `会话记录：${started.dir}/session/\n`,
      ));
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
      const lines = statusLines(buildTaskStatus(loaded.root, loaded.stored.dir, workflow, loaded.document, loaded.record));
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
    .option("--run <run-id>", "只取消指定执行")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action(async (id: string, options: { dir: string; run?: string }) => {
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const workflow = loadWorkflow(loaded.root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const { root } = loaded;
      const taskId = loaded.document.frontmatter.id;
      const result = await cancelRun({ root, taskId, workflow, agents: builtinAgents, runId: options.run });
      if (result.cancelled === null) return fail(result.problems);
      result.runs.forEach((run) => {
        const first = run.workerMissing ? `执行 ${run.runId} 的进程已经不在了，已记为失败` : `已取消 ${taskId} 的执行 ${run.runId}`;
        process.stdout.write(`${first}\n改动文件: ${run.changedPaths.length} 个\n`);
      });
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
        agents: builtinAgents,
        paneHost: process.env.REX_SESSION && process.env.REX_BLOCK
          ? new RexPaneHost(process.env.REX_SESSION, process.env.REX_BLOCK)
          : null,
      });
      if (problems.length > 0) fail(problems);
    });
}
