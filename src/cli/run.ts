import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { loadConfig } from "../application/config.js";
import { executeRun } from "../application/run-execute.js";
import { finishRun } from "../application/run-finish.js";
import { limitNotice, prepareRun, RUNS_DIR } from "../application/run-prepare.js";
import { aliveAmong, livePane, liveWorker, type WorkerProcess, workerProcesses } from "../application/run-process.js";
import { findTask } from "../application/task-store.js";
import { taskWorktree } from "../application/worktree.js";
import type { TaskRecord, TaskRun } from "../contracts/task.js";
import { nextStep } from "../domain/progress.js";
import { currentStatus, type TaskDocument } from "../domain/task-document.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { procStartTicks, signalProcessTree } from "../infrastructure/process.js";
import { fail, knitRoot, loadTask, shownStatus } from "./task.js";
import { loadWorkflow } from "./workflow.js";

/** 每 100 毫秒看一次，最多看到 `deadline`（毫秒时间戳），等到这些进程一个都不在；返回最后还在的。 */
async function stillAlive(processes: readonly WorkerProcess[], deadline: number): Promise<WorkerProcess[]> {
  const alive = aliveAmong(processes);
  if (alive.length === 0 || Date.now() >= deadline) return alive;
  await sleep(100);
  return stillAlive(alive, deadline);
}

/** 一次执行的情况。 */
function runLines(root: string, workflow: WorkflowDefinition, taskId: string, run: TaskRun | undefined): string[] {
  if (run === undefined) return ["还没有派发过"];
  const dir = `${RUNS_DIR}/${run.id}`;
  // 执行记录里的环节已经不在流程里时用它的 id。
  const stage = workflow.stages.find((item) => item.id === run.stage)?.name ?? run.stage;
  if (run.endedAt !== null) {
    return [
      `上一次: ${stage}（${run.id}）`,
      run.failure !== null ? `失败: ${run.failure}` : run.verdict !== null ? `结论: ${run.verdict}` : "结果: 正常结束",
      ...(existsSync(join(root, dir, "report.md")) ? [`报告: ${dir}/report.md`] : []),
      `改动文件: ${run.changedPaths.length} 个`,
    ];
  }
  const pane = livePane(root, run.id) !== null;
  return liveWorker(root, run.id) === null
    ? [
        `执行 ${run.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${taskId} 记为失败`,
        // 窗格里的 Pi 是 Rex 启动的，后台进程没了它还在，还会接着改工作区。
        ...(pane
          ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格还开着，执行者还在里面；knit run cancel 会把它一起停掉`]
          : []),
      ]
    : [
        `正在跑: ${stage}（${run.id}），开始于 ${run.startedAt}`,
        `会话记录: ${dir}/session/`,
        ...(pane ? [`窗格: Rex 里标着 knit ${run.id} 的浮动窗格（最小化着）`] : []),
      ];
}

/** “下一步”那一行，到返工上限时后面还跟着各轮的报告和可以走的路；任务已经结束时没有。 */
function nextLine(workflow: WorkflowDefinition, document: TaskDocument, record: TaskRecord): string[] {
  const { id, verification } = document.frontmatter;
  const status = currentStatus(document, record);
  if (status === "draft") return [`下一步: 先确认需求（knit task ready ${id}）`];
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
  const loaded = loadTask(dir, id);
  if (loaded === null) return null;
  const workflow = loadWorkflow(loaded.root);
  if (workflow === null) {
    process.exitCode = 1;
    return null;
  }
  const running = loaded.record.runs.find((item) => item.endedAt === null);
  if (running === undefined) return statusLines(loaded.root, workflow, loaded.document, loaded.record);
  if (liveWorker(loaded.root, running.id) === null) {
    // 后台进程先把结果写进记录再退出，它可能正好在上面读完记录之后结束：重新读一次才是最后的样子。
    // 意外退出的记录里仍然没有结束时间，不等它：输出里有让人运行 knit run cancel 的那一行。
    const settled = loadTask(dir, id);
    return settled === null ? null : statusLines(settled.root, workflow, settled.document, settled.record);
  }
  await sleep(1000);
  return waitForRun(dir, id);
}

export function registerRunCommands(program: Command): void {
  const run = program.command("run").description("派发环节的执行者");

  run
    .command("start <id>")
    .description("派发任务的下一个环节；执行者在后台跑，命令立即返回")
    .option("--model <provider/模型>", "这一次用的模型")
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
      const prepared = prepareRun({ root, taskId: id, workflow, config, model: options.model ?? null, thinking: options.thinking });
      if (prepared.run === null) return fail(prepared.problems);
      const { run: started } = prepared;
      const log = openSync(join(root, started.dir, "worker.log"), "a");
      const worker = spawn(
        process.execPath,
        [
          process.argv[1]!, "run", "worker", started.id, "--task", id, "--model", started.model,
          ...(started.thinking === null ? [] : ["--thinking", started.thinking]),
          "--dir", root,
        ],
        { detached: true, stdio: ["ignore", log, log] },
      );
      worker.unref();
      closeSync(log);
      // 以后靠启动标识确认这个进程号还是原来那个进程。
      const identity = { pid: worker.pid, start: worker.pid === undefined ? null : procStartTicks(worker.pid) };
      writeFileSync(join(root, started.dir, "worker.json"), `${JSON.stringify(identity, null, 2)}\n`);
      process.stdout.write(
        `已派发 ${id}：${started.stage.name}（${started.id}）\n` +
        `Worktree: ${started.worktree.path}（${started.worktree.branch}）\n` +
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
      const running = loaded.record.runs.find((item) => item.endedAt === null);
      if (running === undefined) return fail([`任务 ${taskId} 没有正在跑的执行`]);
      const worker = liveWorker(root, running.id);
      // Pi 还在的话会接着改工作区，所以等这一串都退出，再对比改动文件。
      const stop = async (chain: readonly WorkerProcess[]): Promise<void> => {
        if (chain[0] === undefined) return;
        signalProcessTree(
          chain[0].pid,
          "SIGTERM",
          chain.map((item) => item.pid),
        );
        const stubborn = await stillAlive(chain, Date.now() + 5000);
        if (stubborn[0] === undefined) return;
        signalProcessTree(
          stubborn[0].pid,
          "SIGKILL",
          stubborn.map((item) => item.pid),
        );
        // 再等完还有进程在也照样往下记：不记的话这次执行结束不了，别的任务也派发不了。
        await stillAlive(stubborn, Date.now() + 5000);
      };
      // 发信号之前取：后台进程先退出的话就找不到它启动的 Pi 了。
      await stop(workerProcesses(root, running.id));
      // 窗格里的 Pi 可能在这期间才登记：再找一次。更晚才起来的，会看到后台进程不在了，自己退出。
      await stop(workerProcesses(root, running.id));
      const problems = finishRun({
        root,
        taskId,
        runId: running.id,
        workflow,
        verdict: null,
        failure: worker === null ? "执行进程意外退出" : "已取消",
        sessionFile: null,
      });
      if (problems.length > 0) return fail(problems);
      const changed = findTask(root, taskId)?.record?.runs.find((item) => item.id === running.id)?.changedPaths ?? [];
      const first =
        worker === null
          ? `执行 ${running.id} 的进程已经不在了，已记为失败`
          : `已取消 ${taskId} 的执行 ${running.id}`;
      process.stdout.write(`${first}\n改动文件: ${changed.length} 个\n`);
    });

  run
    .command("worker <runId>", { hidden: true })
    .requiredOption("--task <id>", "任务")
    .requiredOption("--model <provider/模型>", "模型")
    .option("--thinking <等级>", "思考等级")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action(async (runId: string, options: { task: string; model: string; thinking?: string; dir: string }) => {
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
        model: options.model,
        thinking: options.thinking,
        piExecutable: process.env.KNIT_PI_BIN ?? "pi",
        // 主会话在 Rex 里跑时，它启动的进程都带着这两个变量。
        rex:
          process.env.REX_SESSION && process.env.REX_BLOCK
            ? { session: process.env.REX_SESSION, block: process.env.REX_BLOCK }
            : null,
      });
      if (problems.length > 0) fail(problems);
    });
}
