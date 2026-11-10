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

/**
 * 按顶层命令懒加载命令组：桥接每轮上下文只有 300ms 预算，
 * 启动时加载全部命令组会白花约 80ms（k-0524fc52e81b）。
 * 无参数、help、版本等需要完整清单的入口仍加载全部组。
 */
const COMMAND_GROUPS: Array<{ commands: string[]; register: () => Promise<void> }> = [
  { commands: ["init"], register: async () => (await import("./init.js")).registerInitCommand(program) },
  { commands: ["start"], register: async () => (await import("./start.js")).registerStartCommand(program) },
  { commands: ["task"], register: async () => (await import("./task.js")).registerTaskCommands(program) },
  { commands: ["session", "context"], register: async () => (await import("./session.js")).registerSessionCommands(program) },
  { commands: ["standards"], register: async () => (await import("./standards.js")).registerStandardsCommands(program) },
  { commands: ["run"], register: async () => (await import("./run.js")).registerRunCommands(program) },
  { commands: ["workflow"], register: async () => (await import("./workflow.js")).registerWorkflowCommands(program) },
  { commands: ["worktree"], register: async () => (await import("./worktree.js")).registerWorktreeCommands(program) },
  { commands: ["deliver", "archive"], register: async () => (await import("./deliver.js")).registerDeliveryCommands(program) },
  { commands: ["status", "doctor", "storage"], register: async () => (await import("./status.js")).registerStatusCommands(program) },
  { commands: ["resume", "cancel"], register: async () => (await import("./resume.js")).registerResumeCommands(program) },
  { commands: ["snapshot"], register: async () => (await import("./snapshot.js")).registerSnapshotCommands(program) },
  { commands: ["locks", "unlock"], register: async () => (await import("./locks.js")).registerLockCommands(program) },
  { commands: ["gc"], register: async () => (await import("./gc.js")).registerGcCommands(program) },
];

/** 顶层命令（跳过全局选项与其值）；无位置参数返回 null。 */
function topLevelCommand(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

const command = topLevelCommand(process.argv.slice(2));
const KNOWN_COMMANDS = new Set(COMMAND_GROUPS.flatMap((group) => group.commands));
// 无位置参数（帮助／版本）与 `help` 需要完整命令清单；其余只加载命中的组。
const groups = command === null || command === "help" ? COMMAND_GROUPS : COMMAND_GROUPS.filter((group) => group.commands.includes(command));
for (const group of groups) await group.register();

// 未命中的顶层命令不加载任何组，直接报错；不交给 commander 按多余参数处理。
if (command !== null && command !== "help" && !KNOWN_COMMANDS.has(command)) {
  console.error(`knit: 未知命令 "${command}"；未执行任何操作。`);
  console.error(`error: unknown command '${command}'`);
  process.exitCode = 1;
} else if (process.argv.length <= 2) {
  // 无参数：直接输出帮助，不经 parseAsync（commander 15 对已注册子命令的裸调用以 missing command 退出）
  program.outputHelp();
} else {
  await program.parseAsync(process.argv);
  const known = program.commands.map((item) => item.name());
  const [firstArg] = program.args;
  if (firstArg !== undefined && !known.includes(firstArg)) {
    console.error(`knit: 未知命令 "${firstArg}"；未执行任何操作。`);
    process.exitCode = 1;
  }
}
