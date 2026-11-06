/** start：在当前项目启动本机原生客户端，不另建聊天 UI（DESIGN.md 第4.1节）。 */
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registerClientFlags } from "./client-flags.js";
import { emit, jsonResponse } from "./output.js";

export function registerStartCommand(program: Command): void {
  const command = program
    .command("start")
    .description("启动本机 Pi 客户端（不建立 Knit 聊天 UI；信任由用户决定）")
    .option("--dir <dir>", "项目目录", ".")
    .option("--bin <path>", "Pi 可执行文件（默认 KNIT_PI_BIN 或 PATH）")
    .allowExcessArguments(true);
  // 当前启动器接入 Pi；注册表新增客户端时在此扩展对应启动入口。
  // 不注册的客户端开关（如未来的 --codex）由 commander 直接报未知选项。
  registerClientFlags(command);
  command.action(async (options) => {
    const json = program.opts().json || process.env.KNIT_JSON === "1";
    const requestId = `start-${Date.now()}`;
    if (!existsSync(join(options.dir, ".knit"))) {
      const message = "项目尚未初始化：先运行 knit init --pi";
      if (json) emit(jsonResponse(requestId, "error", { error: message }, "needs_context"));
      else console.error(`knit: ${message}`);
      process.exitCode = 1;
      return;
    }
    const bin = options.bin ?? process.env.KNIT_PI_BIN ?? "pi";
    const separator = process.argv.indexOf("--");
    const passthrough = separator >= 0 ? process.argv.slice(separator + 1) : [];
    const child = spawn(bin, passthrough, { cwd: options.dir, stdio: "inherit", env: process.env });
    let finished = false;
    const finish = (outcome: "completed" | "blocked", data: Record<string, unknown>, code: number): void => {
      if (finished) return;
      finished = true;
      if (json) emit(jsonResponse(requestId, outcome, data));
      process.exitCode = code;
    };
    child.on("error", (error) => {
      const message = `无法启动 ${bin}: ${error.message}`;
      if (!json) console.error(`knit: ${message}`);
      finish("blocked", { error: message }, 1);
    });
    child.on("exit", (code, signal) => {
      finish(code === 0 ? "completed" : "blocked", { exitCode: code, signal }, code ?? (signal === null ? 0 : 1));
    });
  });
}
