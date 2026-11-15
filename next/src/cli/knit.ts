#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { registerWorkflowCommands } from "./workflow.js";

// 编译后位于 next/dist/cli/，往上三级才是根目录的 package.json。
const pkg = createRequire(import.meta.url)("../../../package.json") as { version: string };

const program = new Command().name("knit").version(pkg.version);
registerWorkflowCommands(program);
program.parse();
