import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, type Command } from "commander";
import { builtinAgents } from "../adapters/agents.js";
import { RexPaneHost } from "../adapters/rex/pane.js";
import { cancelRun, startRun, waitRun } from "../application/run-control.js";
import { loadConfig } from "../application/config.js";
import { executeRun } from "../application/run-execute.js";
import { RUNS_DIR } from "../application/run-prepare.js";
import { readResume } from "../application/run-session.js";
import { buildTaskStatus } from "../application/session-context.js";
import { statusLines } from "../application/session-output.js";
import { checkSchema } from "../contracts/primitives.js";
import { AgentNameSchema, DEFAULT_AGENT } from "../contracts/workflow.js";
import { fail, knitRoot, loadTask, loadWorkflow } from "./shared.js";

export { statusLines };

async function waitForRun(dir: string, id: string, timeout?: number): Promise<string[] | null> {
  const root = knitRoot(dir);
  if (root === null) return null;
  const waited = await waitRun(root, id, undefined, timeout === undefined ? undefined : Date.now() + timeout * 1000);
  if (waited.task === null || waited.workflow === null) {
    fail(waited.problems);
    return null;
  }
  const lines = statusLines(buildTaskStatus(root, waited.task.dir, waited.workflow, waited.task.document, waited.task.record, waited.batchId));
  return waited.timedOut ? [...lines, `等待 ${timeout} 秒后批次仍在运行，可再次运行 knit run wait ${id}`] : lines;
}

export function registerRunCommands(program: Command): void {
  const run = program.command("run").description("派发环节的执行者");

  run
    .command("start <id>")
    .description("派发任务的下一个环节；等 Worktree 准备命令完成后返回，执行者在后台跑")
    .addOption(new Option("--instruction <文本>", "主会话的裁决或修改清单").conflicts("instructionFile"))
    .option("--instruction-file <文件>", "读取主会话修改指令")
    .option("--fresh", "强制使用全新会话和完整交接")
    .option("--stage <环节>", "主会话裁决时指定派发环节")
    .option("--model <模型>", "这一次用的模型（Pi 用 provider/模型，agy 用模型 ID）")
    .option("--thinking <等级>", "这一次用的思考等级：off、minimal、low、medium、high、xhigh、max")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { model?: string; thinking?: string; instruction?: string; instructionFile?: string; fresh?: boolean; stage?: string; dir: string }) => {
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
        stage: options.stage, fresh: options.fresh,
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
        (readResume(join(root, started.dir)) ? `会话记录位置见 knit run status ${id}\n` : `会话记录：${started.dir}/session/\n`),
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
    .option("--timeout <秒>", "最多等待的秒数（正整数）")
    .action(async (id: string, options: { dir: string; timeout?: string }) => {
      if (options.timeout !== undefined && (!/^[1-9]\d*$/.test(options.timeout) || !Number.isSafeInteger(Number(options.timeout)))) {
        return fail(["--timeout 需要正整数秒数"]);
      }
      const lines = await waitForRun(options.dir, id, options.timeout === undefined ? undefined : Number(options.timeout));
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
