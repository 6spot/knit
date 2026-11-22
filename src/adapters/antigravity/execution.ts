import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentLaunch, AgentResult, AgentSession } from "../../contracts/agent.js";
import { runPaneSession, SESSION_FILE_LOCATOR } from "../../application/run-session.js";
import { atomicWrite } from "../../infrastructure/atomic.js";
import { AgyBroker } from "./broker.js";
import { agyExecutable, COMMAND_TEMP_PREFIX, commandScope, HOOKS, permits, SANDBOX, sandboxProfile, stopCommandProcesses } from "./isolation.js";
import { type AgyObject, errorText, object, permissionError, resultOf, SUBMIT, transcriptTurn, TURN_INSTRUCTIONS } from "./protocol.js";

const HOOK_TARGET = "agy-hooks.json";
const TEMP_PATH = "agy-temp-path";

export class AntigravityExecutionAdapter implements AgentAdapter {
  createSession(input: AgentLaunch): AgentSession {
    return new AgySession(input, agyExecutable(), false);
  }

  paneCommand(input: AgentLaunch): readonly string[] | null {
    const bin = agyExecutable();
    return bin === null ? null : [process.execPath, fileURLToPath(new URL("./pane.js", import.meta.url)), bin, JSON.stringify(input)];
  }
}

export async function runAgyPane(input: AgentLaunch, executable: string): Promise<void> {
  await runPaneSession({ dir: input.dir, declared: input.report, createSession: () => new AgySession(input, executable, true) });
}

export function cleanAgyRuntime(cwd: string, dir: string): void {
  const hook = join(cwd, HOOKS);
  const generated = join(dir, HOOK_TARGET);
  const entry = lstatSync(hook, { throwIfNoEntry: false });
  const owned = entry?.isSymbolicLink() ? readlinkSync(hook) === generated :
    entry?.isFile() && existsSync(generated) && readFileSync(hook).equals(readFileSync(generated));
  if (owned) unlinkSync(hook);
  const locator = join(dir, TEMP_PATH);
  if (!existsSync(locator)) return;
  const path = readFileSync(locator, "utf8");
  const name = basename(path);
  if (path === `/private/tmp/${name}` && name.startsWith("knit-agy-")) {
    if (name.startsWith(COMMAND_TEMP_PREFIX)) {
      const problem = stopCommandProcesses(commandScope(path));
      if (problem !== null) throw new Error(problem);
    }
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  }
  rmSync(locator, { force: true });
}

class AgySession implements AgentSession {
  private child: ChildProcess | null = null;
  private broker: AgyBroker | null = null;
  private temp: string | null = null;
  private nativeFile: string | null = null;
  private streamFile: string | null = null;
  private requestedSubmit = false;
  private stderr = "";
  private turn = Promise.withResolvers<AgentResult>();
  private stopReply: ReturnType<typeof Promise.withResolvers<AgyObject>> | null = null;
  private readonly backgroundErrors: string[] = [];
  private denied: readonly unknown[] = [];
  private transcriptCursor = 0;
  private closing: Promise<void> | null = null;
  private readonly input: AgentLaunch;
  private readonly original: AgentLaunch;

  constructor(input: AgentLaunch, private readonly executable: string | null, private readonly pane: boolean) {
    this.original = input;
    this.input = { ...input, cwd: realpathSync.native(input.cwd) };
  }

  get sessionFile(): string | null { return this.streamFile ?? this.nativeFile; }

  async start(): Promise<string | null> {
    if (this.executable === null) return "找不到 agy";
    try {
      this.temp = mkdtempSync(`/private/tmp/${permits(this.input.capabilities, "exec") ? COMMAND_TEMP_PREFIX : "knit-agy-"}`);
      writeFileSync(join(this.input.dir, TEMP_PATH), this.temp, { mode: 0o600 });
      this.broker = new AgyBroker(this.input, join(this.temp, "tool.sock"), this.pane, (event, payload) => this.hook(event, payload));
      await this.broker.start();
      const command = (event: string) => ({ type: "command", command: this.broker!.hookCommand(event), timeout: 10 });
      const generated = join(this.input.dir, HOOK_TARGET);
      writeFileSync(generated, JSON.stringify({ knit: {
        SessionStart: [command("SessionStart")], Stop: [command("Stop")],
        PreToolUse: [{ matcher: ".*", hooks: [command("PreToolUse")] }],
      } }), { mode: 0o600 });
      mkdirSync(join(this.input.cwd, ".agents"), { recursive: true });
      // agy 1.5.13 ignores hooks linked out of the Worktree.
      copyFileSync(generated, join(this.input.cwd, HOOKS), constants.COPYFILE_EXCL);
      return null;
    } catch (error) {
      return String(error);
    }
  }

  prompt(message: string): Promise<AgentResult> {
    this.turn = Promise.withResolvers<AgentResult>();
    if (this.child === null) {
      const system = readFileSync(join(this.input.dir, "system.md"), "utf8");
      const first = `${system}\n\n${TURN_INSTRUCTIONS}\n\n${message}`;
      this.launch(first);
      if (!this.pane) this.send(first);
    } else if (this.pane) {
      this.stopReply?.resolve({ decision: "continue", reason: `${message}\n\n${TURN_INSTRUCTIONS}` });
    } else {
      this.send(`${message}\n\n回复第一行写 ${SUBMIT}。`);
    }
    return this.turn.promise;
  }

  stop(): Promise<void> {
    this.closing ??= this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    this.stopReply?.resolve({});
    this.broker?.stop();
    const child = this.child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "close").catch(() => {});
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill("SIGTERM");
      await exited.finally(() => clearTimeout(force));
    }
    cleanAgyRuntime(this.original.cwd, this.original.dir);
  }

  private launch(first: string): void {
    const settings = join(this.input.dir, "agy-settings.json");
    const nativeSettings = join(homedir(), ".gemini/antigravity-cli/settings.json");
    const nativePermissions = existsSync(nativeSettings) ? object(object(readFileSync(nativeSettings, "utf8"))?.permissions) : null;
    const dir = join(this.input.dir, "session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(settings, JSON.stringify({
      trustedWorkspaces: [this.input.cwd], enableTerminalSandbox: false, allowNonWorkspaceAccess: false,
      toolPermission: "request-review", disableSlashCommands: true, agentMode: "", statusLine: { enabled: false }, title: { enabled: false },
      permissions: {
        ...nativePermissions,
        allow: [
          ...(Array.isArray(nativePermissions?.allow) ? nativePermissions.allow : []),
          ...(permits(this.input.capabilities, "exec") ? [`command(${this.broker!.commandPrefix})`] : []),
          ...(this.pane || !permits(this.input.capabilities, "read") ? [] : [`read_file(${this.input.cwd})`]),
          ...(this.pane || !permits(this.input.capabilities, "write") ? [] : [`write_file(${this.input.cwd})`]),
        ],
        deny: [
          ...(Array.isArray(nativePermissions?.deny) ? nativePermissions.deny : []),
          ...(permits(this.input.capabilities, "read") ? [] : ["read_file(*)"]),
          ...(permits(this.input.capabilities, "write") ? [] : ["write_file(*)"]),
          ...(permits(this.input.capabilities, "exec") ? [] : ["command(*)"]),
          ...(permits(this.input.capabilities, "external") ? [] : ["mcp(*)"]),
          ...(permits(this.input.capabilities, "network") ? [] : ["read_url(*)", "execute_url(*)"]),
        ],
      },
    }));
    const profile = sandboxProfile({ cwd: this.input.cwd, dir: this.input.dir, paths: this.input.protectedPaths ?? [],
      cli: { home: homedir(), temporary: this.temp! }, network: true, write: permits(this.input.capabilities, "write") });
    const child = spawn(SANDBOX, ["-p", profile, this.executable!, "--settings", settings,
      ...(this.input.model === null ? [] : [`--model=${this.input.model}`]),
      ...(this.input.thinking === null ? [] : [`--effort=${this.input.thinking}`]),
      ...(this.pane ? ["--prompt-interactive", first] : ["--disable-slash-commands", "--input-format", "stream-json", "--output-format", "stream-json"]),
    ], { cwd: this.input.cwd, env: { ...process.env, TMPDIR: this.temp!, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, stdio: this.pane ? "inherit" : "pipe" });
    this.child = child;
    child.on("error", (error) => this.turn.resolve({ report: null, failure: `Antigravity 启动失败：${error.message}` }));
    child.on("close", (code, signal) => this.turn.resolve({ report: null,
      failure: this.pane && (code === 0 || signal === "SIGHUP" || signal === "SIGTERM") ? "执行者的窗格关掉了，没有交报告" :
        `Antigravity 会话退出（${signal ?? code}）${this.stderr.trim() ? `：${this.stderr.trim()}` : ""}` }));
    if (!this.pane) {
      this.streamFile = join(dir, "agy.jsonl");
      child.stdin!.on("error", (error) => this.turn.resolve({ report: null, failure: `Antigravity 输入已关闭：${error.message}` }));
      child.stderr!.setEncoding("utf8").on("data", (data: string) => { this.stderr = (this.stderr + data).slice(-8192); });
      createInterface({ input: child.stdout! }).on("line", (line) => this.background(line));
    }
  }

  private send(message: string): void {
    this.child!.stdin!.write(`${JSON.stringify({ event: "user", message: { content: message } })}\n`);
  }

  private background(line: string): void {
    appendFileSync(this.streamFile!, `${line}\n`);
    const event = object(line);
    const step = object(event?.step_update);
    if (event?.event === "step_update" && step?.state === "ERROR") {
      const error = errorText(object(step.tool_info)?.error);
      if (error) this.backgroundErrors.push(error);
    }
    if (event?.event !== "result") return;
    const result = object(event.result) ?? {};
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
    const currentDenied = denied.slice(this.denied.every((entry, index) => JSON.stringify(entry) === JSON.stringify(denied[index])) ? this.denied.length : 0);
    this.denied = denied;
    const errors = this.backgroundErrors.splice(0);
    const error = errorText(result.error);
    if (result.status === "SUCCESS" && error) errors.push(error);
    const failure = result.status === "SUCCESS" ? "" : error || String(result.status ?? "缺少后台状态");
    const outcome = resultOf(result.response, errors, currentDenied, failure);
    if (outcome !== null) return this.turn.resolve(outcome);
    if (this.requestedSubmit) return this.turn.resolve({ report: null, failure: `Antigravity 后台追问后仍未以 ${SUBMIT} 提交报告` });
    this.requestedSubmit = true;
    this.send(`后台无法接收交互输入。请完成工作，在回复第一行写 ${SUBMIT}，其余行输出完整报告。`);
  }

  private async hook(event: string, payload: AgyObject): Promise<AgyObject> {
    if (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) {
      const file = resolve(this.input.cwd, payload.transcriptPath.replace(/^~\//, `${homedir()}/`));
      if (file !== this.nativeFile) {
        atomicWrite({ path: join(this.input.dir, SESSION_FILE_LOCATOR), data: Buffer.from(file) });
        this.nativeFile = file;
        this.transcriptCursor = 0;
      }
    }
    if (!this.pane || event !== "Stop" || payload.fullyIdle !== true) return {};
    const reason = errorText(payload.error);
    const termination = typeof payload.terminationReason === "string" ? payload.terminationReason : "";
    if (/abort|cancel|interrupt/i.test(termination)) return {};
    const file = this.nativeFile;
    const turn = file && existsSync(file) ? transcriptTurn(file, this.transcriptCursor) :
      { response: undefined, errors: [], denied: [], cursor: 0 };
    this.transcriptCursor = turn.cursor;
    const errors = permissionError(reason) ? [...turn.errors, reason] : turn.errors;
    const failure = permissionError(reason) ? "" : reason || (/error|max_steps_exceeded|terminal_custom_hook/i.test(termination) ? termination : "");
    const outcome = resultOf(turn.response, errors, turn.denied, failure);
    if (outcome === null) return {};
    this.stopReply = Promise.withResolvers<AgyObject>();
    this.turn.resolve(outcome);
    return this.stopReply.promise;
  }
}
