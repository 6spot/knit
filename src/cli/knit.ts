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
  if (Number.parseInt(process.versions.node, 10) < 24) {
    // 桌面脚本可在登录 shell 中重试，此时 stdin 尚未读取。
    if (process.env.KNIT_HOOK_TRY_PATH === "1") {
      process.exitCode = 78;
      return;
    }
    process.stderr.write(`Knit 需要 Node ≥ 24，当前版本为 ${process.version}\n`);
    process.exitCode = 1;
    return;
  }
  const [command, hostId, event] = process.argv.slice(2);
  const host = HOST_SPECS.find((spec) => spec.id === hostId);
  if (command === "hook" && process.argv.length === 5 && event && !event.startsWith("-") && host &&
      ("hook" in host || (host.id === "pi" && event === "tool-call"))) return runHook(host, event);

  // 编译后位于 dist/cli/，往上两级是根目录的 package.json。
  const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  const { Command } = await import("commander");
  const program = new Command().name("knit").version(pkg.version);
  const commands = new Map<string, () => Promise<void>>([
    ["init", async () => (await import("./project.js")).registerInitCommand(program)],
    ["workflow", async () => (await import("./project.js")).registerWorkflowCommands(program)],
    ["task", async () => (await import("./task.js")).registerTaskCommands(program)],
    ["standards", async () => (await import("./project.js")).registerStandardsCommands(program)],
    ["run", async () => (await import("./run.js")).registerRunCommands(program)],
    ["context", async () => (await import("./project.js")).registerContextCommand(program)],
    ["deliver", async () => (await import("./deliver.js")).registerDeliverCommand(program)],
  ]);
  const register = commands.get(command ?? "");
  if (register) await register();
  // 顶层帮助与拼写建议需要完整的命令表，并保留原来的展示顺序。
  if (!register && command !== "hook") for (const load of commands.values()) await load();
  const hook = program.command("hook", { hidden: true });
  for (const spec of HOST_SPECS) {
    if (spec.id !== "pi" && !("hook" in spec)) continue;
    hook.command(`${spec.id} <event>`, { hidden: spec.id === "pi" || spec.hook.hidden })
      .action((event: string) => runHook(spec, event));
  }
  await program.parseAsync();
}

async function runHook(host: (typeof HOST_SPECS)[number], event: string) {
  if (host.id === "pi" && event !== "tool-call") return (await import("./shared.js")).fail(["未知的 Pi 工具事件"]);
  const call = readHookInput();
  if (call === undefined) return;
  if ("hook" in host) {
    const route = host.hook;
    const adapter = await import(`../adapters/${route.module}`);
    const handle: (event: string, input: unknown) => Promise<unknown> = adapter[route.exportName];
    const result = await handle(event, call);
    if (result !== null || !route.omitNull) process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
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

function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("knit hook 需要从标准输入读取有效的 JSON\n");
    process.exitCode = 1;
    return undefined;
  }
}
