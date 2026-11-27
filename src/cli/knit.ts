#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { HOST_SPECS } from "../contracts/host.js";

// 输出接在管道上、对面先关掉时（`knit task list | grep -q …`）写不进去：命令该做的已经做了，
// 不当成出错，退出码照旧。
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

await main();

async function main() {
  const [command, hostId, event] = process.argv.slice(2);
  const host = HOST_SPECS.find((spec) => spec.id === hostId);
  if (command === "hook" && process.argv.length === 5 && event && !event.startsWith("-") && host &&
      ("hook" in host || (host.id === "pi" && event === "tool-call"))) return runHook(host, event);

  const [{ Command }, project, task, run, deliver] = await Promise.all([
    import("commander"), import("./project.js"), import("./task.js"), import("./run.js"), import("./deliver.js"),
  ]);
  // 编译后位于 dist/cli/，往上两级是根目录的 package.json。
  const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
  const program = new Command().name("knit").version(pkg.version);
  project.registerInitCommand(program);
  project.registerWorkflowCommands(program);
  task.registerTaskCommands(program);
  project.registerStandardsCommands(program);
  run.registerRunCommands(program);
  project.registerContextCommand(program);
  deliver.registerDeliverCommand(program);
  const hook = program.command("hook", { hidden: true });
  for (const spec of HOST_SPECS) {
    if (spec.id !== "pi" && !("hook" in spec)) continue;
    hook.command(`${spec.id} <event>`, { hidden: spec.id === "pi" || spec.hook.hidden })
      .action((event: string) => runHook(spec, event));
  }
  await program.parseAsync();
}

async function runHook(host: (typeof HOST_SPECS)[number], event: string) {
  if ("hook" in host) {
    const route = host.hook;
    const adapter = await import(`../adapters/${route.module}`);
    const handle: (event: string, input: unknown) => Promise<unknown> = adapter[route.exportName];
    const result = await handle(event, JSON.parse(readFileSync(0, "utf8")));
    if (result !== null || !route.omitNull) process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (event !== "tool-call") return (await import("./shared.js")).fail(["未知的 Pi 工具事件"]);
  const call = JSON.parse(readFileSync(0, "utf8"));
  if (call.name !== "bash" || typeof call.input?.command !== "string") {
    process.stdout.write("{}");
    return;
  }
  const { checkHostCommand, inspectHostCommand } = await import("../application/host-command.js");
  if (call.quotesOnly === true) {
    const { quotes, command } = await inspectHostCommand(call.input.command);
    process.stdout.write(JSON.stringify(command === call.input.command ? { quotes } : { quotes, command }));
    return;
  }
  const checked = await checkHostCommand(call.input.command, () => call.messages
    .filter((message: { role: string }) => message.role === "user").map((message: { text: string }) => message.text));
  if (checked.reason) return (await import("./shared.js")).fail([checked.reason]);
  process.stdout.write(JSON.stringify({ command: checked.command }));
}
