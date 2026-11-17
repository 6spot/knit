#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { registerDeliverCommand } from "./deliver.js";
import { registerInitCommand } from "./init.js";
import { registerRunCommands } from "./run.js";
import { registerStandardsCommands } from "./standards.js";
import { registerTaskCommands } from "./task.js";
import { registerWorkflowCommands } from "./workflow.js";

// 编译后位于 next/dist/cli/，往上三级才是根目录的 package.json。
const pkg = createRequire(import.meta.url)("../../../package.json") as { version: string };

const program = new Command().name("knit").version(pkg.version);
registerInitCommand(program);
registerWorkflowCommands(program);
registerTaskCommands(program);
registerStandardsCommands(program);
registerRunCommands(program);
registerDeliverCommand(program);
program.parse();
