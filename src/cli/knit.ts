#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { registerContextCommand } from "./context.js";
import { registerDeliverCommand } from "./deliver.js";
import { registerInitCommand } from "./init.js";
import { registerRunCommands } from "./run.js";
import { registerStandardsCommands } from "./standards.js";
import { registerTaskCommands } from "./task.js";
import { registerWorkflowCommands } from "./workflow.js";

// 编译后位于 dist/cli/，往上两级是根目录的 package.json。
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

// 输出接在管道上、对面先关掉时（`knit task list | grep -q …`）写不进去：命令该做的已经做了，
// 不当成出错，退出码照旧。
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

const program = new Command().name("knit").version(pkg.version);
registerInitCommand(program);
registerWorkflowCommands(program);
registerTaskCommands(program);
registerStandardsCommands(program);
registerRunCommands(program);
registerContextCommand(program);
registerDeliverCommand(program);
program.parse();
