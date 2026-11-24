#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { registerDeliverCommand } from "./deliver.js";
import { registerContextCommand, registerInitCommand, registerStandardsCommands, registerWorkflowCommands } from "./project.js";
import { registerRunCommands } from "./run.js";
import { fail } from "./shared.js";
import { registerTaskCommands } from "./task.js";

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
const hook = program.command("hook", { hidden: true });
hook.command("pi <event>", { hidden: true }).action(async (event: string) => {
  if (event !== "tool-call") return fail(["未知的 Pi 工具事件"]);
  const call = JSON.parse(readFileSync(0, "utf8"));
  if (call.name !== "bash" || typeof call.input?.command !== "string") {
    process.stdout.write("{}");
    return;
  }
  const { checkHostCommand, inspectHostCommand } = await import("../application/host-command.js");
  if (call.quotesOnly === true) {
    const { quotes } = await inspectHostCommand(call.input.command);
    process.stdout.write(JSON.stringify({ quotes }));
    return;
  }
  const checked = await checkHostCommand(call.input.command, () => call.messages
    .filter((message: { role: string }) => message.role === "user").map((message: { text: string }) => message.text));
  if (checked.reason) return fail([checked.reason]);
  process.stdout.write(JSON.stringify({ command: checked.command }));
});
hook.command("agy <event>").action(async (event: string) => {
  const { agyHostHook } = await import("../adapters/antigravity/host-hook.js");
  const result = await agyHostHook(event, JSON.parse(readFileSync(0, "utf8")));
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
hook.command("workbuddy <event>", { hidden: true }).action(async (event: string) => {
  const { workbuddyHostHook } = await import("../adapters/workbuddy/host-hook.js");
  const result = await workbuddyHostHook(event, JSON.parse(readFileSync(0, "utf8")));
  if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`);
});
await program.parseAsync();
