#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";

const requireJson = createRequire(import.meta.url);
const pkg = requireJson("../../package.json") as { version: string };

const program = new Command();

program
  .name("knit")
  .description("轻量项目辅助 CLI：项目资料、任务、规范演进、实施／检查、提交归档与恢复。")
  .version(pkg.version)
  .option("--json", "以协议 JSON 输出结果（stdout 只写协议响应）")
  .option("--dev", "仅本次进程输出结构化诊断到 stderr（白名单，不落盘）");

const { installDiagnostics } = await import("./dev.js");
installDiagnostics(program);

const { registerInitCommand } = await import("./init.js");
registerInitCommand(program);
const { registerStartCommand } = await import("./start.js");
registerStartCommand(program);

const { registerTaskCommands } = await import("./task.js");
registerTaskCommands(program);
const { registerSessionCommands } = await import("./session.js");
registerSessionCommands(program);
const { registerStandardsCommands } = await import("./standards.js");
registerStandardsCommands(program);
const { registerRunCommands } = await import("./run.js");
registerRunCommands(program);
const { registerDeliveryCommands } = await import("./deliver.js");
registerDeliveryCommands(program);
const { registerStatusCommands } = await import("./status.js");
registerStatusCommands(program);
const { registerResumeCommands } = await import("./resume.js");
registerResumeCommands(program);
const { registerSnapshotCommands } = await import("./snapshot.js");
registerSnapshotCommands(program);
const { registerLockCommands } = await import("./locks.js");
registerLockCommands(program);

// 无参数：直接输出帮助，不经 parseAsync（commander 15 对已注册子命令的裸调用以 missing command 退出）
if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  await program.parseAsync(process.argv);
  const known = program.commands.map((command) => command.name());
  const [firstArg] = program.args;
  if (firstArg !== undefined && !known.includes(firstArg)) {
    console.error(`knit: 未知命令 "${firstArg}"；未执行任何操作。`);
    process.exitCode = 1;
  }
}
