import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../application/config.js";
import { executeRun } from "../application/run-execute.js";
import { prepareRun } from "../application/run-prepare.js";
import { procStartTicks } from "../infrastructure/process.js";
import { fail, knitRoot } from "./task.js";
import { loadWorkflow } from "./workflow.js";

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
