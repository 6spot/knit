import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../application/config.js";
import { executeRun } from "../application/run-execute.js";
import { prepareRun, RUNS_DIR } from "../application/run-prepare.js";
import { liveWorker } from "../application/run-process.js";
import type { TaskRecord, TaskRun } from "../contracts/task.js";
import { nextStep } from "../domain/progress.js";
import { currentStatus, type TaskDocument } from "../domain/task-document.js";
import type { WorkflowDefinition } from "../domain/workflow.js";
import { procStartTicks } from "../infrastructure/process.js";
import { fail, knitRoot, loadTask, shownStatus } from "./task.js";
import { loadWorkflow } from "./workflow.js";

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
  return liveWorker(root, run.id) === null
    ? [`执行 ${run.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${taskId} 记为失败`]
    : [`正在跑: ${stage}（${run.id}），开始于 ${run.startedAt}`, `日志: ${dir}/worker.log`];
}

/** “下一步”那一行；任务已经结束时没有。 */
function nextLine(workflow: WorkflowDefinition, document: TaskDocument, record: TaskRecord): string[] {
  const { id, verification } = document.frontmatter;
  const status = currentStatus(document, record);
  if (status === "draft") return [`下一步: 先确认需求（knit task ready ${id}）`];
  if (status !== "ready" && status !== "active") return [];
  const step = nextStep(workflow, verification, record);
  if (step.kind === "close") return [`下一步: 核对之后运行 knit task close ${id}`];
  if (step.kind === "limit") return [`下一步: ${step.stage.name}环节已经进入 ${step.entries} 次，到了上限`];
  return [`下一步: 派发${step.stage.name}环节（knit run start ${id}）`];
}

export function registerRunCommands(program: Command): void {
  const run = program.command("run").description("派发环节的执行者");

  run
    .command("start <id>")
    .description("派发任务的下一个环节；执行者在后台跑，命令立即返回")
    .option("--model <provider/模型>", "这一次用的模型")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: { model?: string; dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const { config, problems } = loadConfig(root);
      if (config === null) return fail(problems);
      const workflow = loadWorkflow(root);
      if (workflow === null) {
        process.exitCode = 1;
        return;
      }
      const prepared = prepareRun({ root, taskId: id, workflow, config, model: options.model ?? null });
      if (prepared.run === null) return fail(prepared.problems);
      const { run: started } = prepared;
      const log = openSync(join(root, started.dir, "worker.log"), "a");
      const worker = spawn(
        process.execPath,
        [process.argv[1]!, "run", "worker", started.id, "--task", id, "--model", started.model, "--dir", root],
        { detached: true, stdio: ["ignore", log, log] },
      );
      worker.unref();
      closeSync(log);
      // 以后靠启动标识确认这个进程号还是原来那个进程。
      const identity = { pid: worker.pid, start: worker.pid === undefined ? null : procStartTicks(worker.pid) };
      writeFileSync(join(root, started.dir, "worker.json"), `${JSON.stringify(identity, null, 2)}\n`);
      process.stdout.write(`已派发 ${id}：${started.stage.name}（${started.id}）\n日志：${started.dir}/worker.log\n`);
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
      const { root, document, record } = loaded;
      const last = record.runs.at(-1);
      const lines = [
        `任务: ${document.frontmatter.title}（${document.frontmatter.id}）`,
        `状态: ${shownStatus(document, record).text}`,
        ...runLines(root, workflow, document.frontmatter.id, last),
        // 有执行还没结束时不给下一步。
        ...(last?.endedAt === null ? [] : nextLine(workflow, document, record)),
      ];
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });

  run
    .command("worker <runId>", { hidden: true })
    .requiredOption("--task <id>", "任务")
    .requiredOption("--model <provider/模型>", "模型")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action(async (runId: string, options: { task: string; model: string; dir: string }) => {
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
        piExecutable: process.env.KNIT_PI_BIN ?? "pi",
      });
      if (problems.length > 0) fail(problems);
    });
}
