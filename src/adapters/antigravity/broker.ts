import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentLaunch } from "../../contracts/agent.js";
import { COMMAND_CLIENT, commandScope, commandScopeRule, handoffReadPaths, inside, permits, SANDBOX, sandboxProfile, stopCommandProcesses, WORKSPACE_CONTROL } from "./isolation.js";
import { object, type AgyObject } from "./protocol.js";

const entry = fileURLToPath(new URL("./client.js", import.meta.url));
const READ_TOOLS = new Set(["read_file", "view_file", "list_dir", "find_by_name", "grep_search"]);
const WRITE_TOOLS = new Set(["write_file", "write_to_file", "edit_file", "replace_file_content", "multi_replace_file_content", "sed_file"]);
const NETWORK_TOOLS = new Set(["search_web", "read_url_content", "open_browser_url", "read_browser_page", "browser_subagent"]);
const EXTERNAL_TOOLS = new Set(["call_mcp_tool", "list_resources", "read_resource", "list_plugin_accounts"]);
const LOCAL_TOOLS = new Set(["ask_question", "finish", "list_permissions", "wait", "wait_5_seconds"]);

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export class AgyBroker {
  private readonly hooksKey = randomUUID();
  private readonly pending = new Map<string, { command: string; cwd: string }>();
  private readonly commands = new Set<ChildProcess>();
  private readonly connections = new Set<Socket>();
  private readonly server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));

  constructor(
    private readonly launch: AgentLaunch,
    private readonly socketPath: string,
    private readonly interactive: boolean,
    private readonly handle: (event: string, payload: AgyObject) => Promise<AgyObject>,
  ) {}

  get commandPrefix(): string {
    return join(dirname(this.socketPath), COMMAND_CLIENT);
  }

  hookCommand(event: string): string {
    return [process.execPath, entry, this.socketPath, "hook", event, this.hooksKey].map(shellQuote).join(" ");
  }

  async start(): Promise<void> {
    if (permits(this.launch.capabilities, "exec")) {
      const client = [process.execPath, entry, this.socketPath, "command"].map(shellQuote).join(" ");
      writeFileSync(this.commandPrefix, `#!/bin/sh
exec ${client} "$KNIT_AGY_REQUEST"
`, { mode: 0o500, flag: "wx" });
    }
    this.server.listen(this.socketPath);
    await once(this.server, "listening");
  }

  stop(): void {
    this.commands.forEach((child) => child.kill("SIGKILL"));
    this.connections.forEach((socket) => socket.destroy());
    this.server.close();
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", () => socket.destroy());
    const requests = createInterface({ input: socket });
    requests.on("error", () => socket.destroy());
    requests.once("line", (line: string) => {
      const request = object(line);
      if (request?.kind === "command" && typeof request.key === "string") {
        this.runCommand(socket, request.key);
        return;
      }
      if (request?.kind !== "hook" || request.key !== this.hooksKey || typeof request.event !== "string") {
        socket.end(JSON.stringify({ error: "没有有效的 Knit 执行授权" }));
        return;
      }
      const payload = object(request.payload) ?? {};
      const reply = this.handle(request.event, payload).then((result) => request.event === "PreToolUse" ? this.gate(payload) : result);
      void reply.then((result) => socket.end(JSON.stringify(result)), (error: unknown) => {
        socket.end(JSON.stringify({ error: String(error) }));
      });
    });
  }

  private gate(payload: AgyObject): AgyObject {
    const tool = object(payload.toolCall);
    const args = object(tool?.args) ?? {};
    const name = typeof tool?.name === "string" ? tool.name : "";
    const deny = (reason: string) => ({ decision: "deny", reason: `Knit：${name} ${reason}` });
    if (LOCAL_TOOLS.has(name)) return { decision: "allow" };
    if (READ_TOOLS.has(name)) {
      if (!permits(this.launch.capabilities, "read")) return deny("需要 read");
      const path = args.AbsolutePath ?? args.Path ?? args.DirectoryPath ?? args.SearchDirectory ?? args.SearchPath ?? "";
      const real = typeof path === "string" ? this.realPath(resolve(this.launch.cwd, path)) : null;
      const roots = [this.launch.cwd, ...handoffReadPaths(this.launch.root)];
      if (real === null || !roots.some((root) => inside(root, real)) || inside(this.launch.dir, real)) {
        return deny("只允许读取 Worktree 和主检出的交接资料");
      }
      if ((name === "find_by_name" || name === "grep_search") && inside(real, this.launch.dir)) {
        return deny("搜索范围包含本次执行目录");
      }
      return { decision: "allow" };
    }
    if (WRITE_TOOLS.has(name)) {
      if (!permits(this.launch.capabilities, "write")) return deny("需要 write");
      const path = name === "edit_file" ? args.Path : args.TargetFile ?? args.Path ?? args.AbsolutePath ?? args.FilePath;
      return typeof path === "string" && this.writePath(path) ? { decision: "allow" } : deny("只允许写入 Worktree 中的项目文件");
    }
    if (name === "run_command") {
      if (!permits(this.launch.capabilities, "exec")) return deny("需要 exec");
      if (typeof args.CommandLine !== "string" || !args.CommandLine.trim() || args.RunPersistent || args.RequestedTerminalID) {
        return deny("需要普通命令及工作目录，Knit 管理命令的生命周期");
      }
      const cwd = typeof args.Cwd === "string" && args.Cwd ? this.realPath(resolve(this.launch.cwd, args.Cwd)) : this.launch.cwd;
      if (cwd === null || !inside(this.launch.cwd, cwd)) return deny("工作目录必须在 Worktree 内");
      const key = randomUUID();
      this.pending.set(key, { command: args.CommandLine, cwd });
      return {
        decision: this.interactive ? "ask" : "auto_approve",
        reason: `执行命令 ${args.CommandLine}`,
        permissionOverrides: [`command(${args.CommandLine})`],
        // Keep the forwarding executable's permission target independent of the one-time key.
        overwrite: { CommandLine: `KNIT_AGY_REQUEST=${key} ${this.commandPrefix}` },
      };
    }
    if (name === "command_status" || (name === "manage_task" && (args.Action === "status" || args.Action === "list" || args.Action === "kill"))) {
      return permits(this.launch.capabilities, "exec") ? { decision: "allow" } : deny("需要 exec");
    }
    if (NETWORK_TOOLS.has(name)) return permits(this.launch.capabilities, "network") ? { decision: "allow" } : deny("需要 network");
    if (EXTERNAL_TOOLS.has(name)) return permits(this.launch.capabilities, "external") ? { decision: "allow" } : deny("需要 external");
    return deny("没有可以落实能力上限的执行入口");
  }

  private realPath(path: string): string | null {
    try { return realpathSync.native(path); } catch { return null; }
  }

  private writePath(path: string): boolean {
    const absolute = resolve(this.launch.cwd, path);
    const protectedPaths = [...WORKSPACE_CONTROL, ...(this.launch.protectedPaths ?? [])];
    const allowed = (candidate: string) => inside(this.launch.cwd, candidate) &&
      !protectedPaths.some((protectedPath) => inside(resolve(this.launch.cwd, protectedPath), candidate));
    // 尚未创建的文件也要检查最近的现有目录，避免沿符号链接写到运行时状态。
    const realParent = (candidate: string): string | null => {
      try {
        return realpathSync.native(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) return null;
        const parent = dirname(candidate);
        const real = parent === candidate ? null : realParent(parent);
        return real === null ? null : resolve(real, basename(candidate));
      }
    };
    const pathInWorktree = realParent(absolute);
    return pathInWorktree !== null && allowed(pathInWorktree);
  }

  private runCommand(socket: Socket, key: string): void {
    const request = this.pending.get(key);
    if (request === undefined) {
      socket.end(JSON.stringify({ error: "命令未获授权或已执行" }));
      return;
    }
    this.pending.delete(key);
    const profile = sandboxProfile({ cwd: this.launch.cwd, dir: this.launch.dir, paths: this.launch.protectedPaths ?? [],
      socket: this.socketPath, network: permits(this.launch.capabilities, "network"), write: permits(this.launch.capabilities, "write") });
    const scope = commandScope(dirname(this.socketPath));
    const command = `${scope}.${key}`;
    const { PATH, LANG, LC_ALL } = process.env;
    const child = spawn(SANDBOX, ["-p", `${profile}\n${commandScopeRule(scope)}\n${commandScopeRule(command)}`, "/bin/bash", "-c", request.command], {
      cwd: request.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH, LANG, LC_ALL, HOME: process.env.HOME, TMPDIR: this.launch.cwd },
    });
    this.commands.add(child);
    child.stdout.on("data", (data: Buffer) => socket.write(`${JSON.stringify({ stdout: data.toString("base64") })}\n`));
    child.stderr.on("data", (data: Buffer) => socket.write(`${JSON.stringify({ stderr: data.toString("base64") })}\n`));
    // manage_task kill closes the forwarding client. Reap descendants by scope on exit.
    socket.once("end", () => child.kill("SIGKILL"));
    socket.once("close", () => child.kill("SIGKILL"));
    child.on("exit", () => {
      const error = stopCommandProcesses(command);
      if (error !== null) socket.end(`${JSON.stringify({ error })}\n`);
    });
    child.on("error", (error) => socket.end(`${JSON.stringify({ error: error.message })}\n`));
    child.on("close", (code) => {
      this.commands.delete(child);
      if (!socket.writableEnded) socket.end(`${JSON.stringify({ code: code ?? 1 })}\n`);
    });
  }
}
