import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentLaunch, AgentResult, AgentSession } from "../../contracts/agent.js";
import { runPaneSession, SESSION_FILE_LOCATOR } from "../../application/run-session.js";
import { withRunLock } from "../../application/run-lock.js";
import { atomicWrite } from "../../infrastructure/atomic.js";
import { AgyBroker } from "./broker.js";
import { agyExecutable, COMMAND_TEMP_PREFIX, commandScope, handoffReadPaths, HOOKS, permits, SANDBOX, sandboxProfile, stopCommandProcesses } from "./isolation.js";
import { type AgyObject, errorText, object, permissionError, resultOf, SUBMIT, transcriptTurn, TURN_INSTRUCTIONS } from "./protocol.js";

const HOOK_TARGET = "agy-hooks.json";
export const agyWorkspaceCopies = { [HOOKS]: HOOK_TARGET };
const TEMP_PATH = "agy-temp-path";
const CLEANUP_ERROR = "agy-cleanup-error";

export class AntigravityExecutionAdapter implements AgentAdapter {
  checkResume(resumeId: string): string | null {
    return basename(resumeId) === resumeId && existsSync(join(homedir(), ".gemini/antigravity-cli/conversations", `${resumeId}.db`))
      ? null : "Antigravity 原生对话不存在";
  }

  createSession(input: AgentLaunch): AgentSession {
    return new AgySession(input, agyExecutable(), false);
  }

  paneCommand(input: AgentLaunch): readonly string[] | null {
    const bin = agyExecutable();
    return bin === null ? null : [process.execPath, fileURLToPath(new URL("./pane.js", import.meta.url)), bin, JSON.stringify(input)];
  }
}

export async function runAgyPane(input: AgentLaunch, executable: string): Promise<void> {
  await runPaneSession({ dir: input.dir, declared: input.report, resume: input.resume, createSession: () => new AgySession(input, executable, true) });
}

export function cleanAgyRuntime(cwd: string, dir: string): void {
  removeAgyRuntime(cwd, dir);
  const priorError = ifPresent(() => readFileSync(join(dir, CLEANUP_ERROR), "utf8"));
  if (priorError !== undefined) throw new Error(priorError);
}

function ifPresent<T>(operation: () => T): T | undefined {
  try { return operation(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

// 使用者和锁留在主检出的 .knit/.runtime，按 Worktree 名区分。
function updateHook(cwd: string, dir: string, install: boolean): void {
  const generated = join(dir, HOOK_TARGET);
  if (!existsSync(generated)) return;
  const owners = join(dirname(dirname(dir)), "agy-hooks", basename(cwd));
  withRunLock(`${owners}.lock`, 5000, () => {
    const hook = join(cwd, HOOKS);
    const owner = join(owners, basename(dir));
    const entry = lstatSync(hook, { throwIfNoEntry: false });
    const matches = entry?.isFile() && readFileSync(hook).equals(readFileSync(generated));
    if (install) {
      mkdirSync(owners, { recursive: true });
      if (entry && (!matches || !readdirSync(owners).length)) throw new Error(`Worktree 中已有 ${HOOKS}`);
      writeFileSync(owner, "");
      if (!entry) copyFileSync(generated, hook, constants.COPYFILE_EXCL);
      return;
    }
    if (existsSync(owners)) {
      if (!existsSync(owner)) return;
      rmSync(owner);
      if (readdirSync(owners).length) return;
      rmSync(owners, { recursive: true });
    }
    // 兼容升级前留在 Worktree 的单执行器钩子。
    if (matches || (entry?.isSymbolicLink() && readlinkSync(hook) === generated)) unlinkSync(hook);
  }, () => { throw new Error(`无法取得 ${HOOKS} 的文件锁`); });
}

function removeAgyRuntime(cwd: string, dir: string): void {
  updateHook(cwd, dir, false);
  const locator = join(dir, TEMP_PATH);
  const path = ifPresent(() => readFileSync(locator, "utf8"));
  if (path === undefined) return;
  const name = basename(path);
  const owned = path === `/private/tmp/${name}` && name.startsWith("knit-agy-");
  if (owned && name.startsWith(COMMAND_TEMP_PREFIX)) {
    const problem = stopCommandProcesses(commandScope(path));
    if (problem !== null) {
      // 另一进程看到定位文件已删除时，必须能读到这次回收的失败原因。
      atomicWrite({ path: join(dir, CLEANUP_ERROR), data: Buffer.from(problem) });
    }
  }
  if (owned) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  rmSync(locator, { force: true });
}

class AgySession implements AgentSession {
  private child: ChildProcess | null = null;
  private broker: AgyBroker | null = null;
  private temp: string | null = null;
  private nativeFile: string | null = null;
  private conversationId: string | null = null;
  private resumeTimer?: NodeJS.Timeout;
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
    this.input = { ...input, cwd: realpathSync.native(input.cwd), root: realpathSync.native(input.root), dir: realpathSync.native(input.dir) };
  }

  get resumeId() { return this.conversationId; }

  get sessionFile(): string | null { return this.streamFile ?? this.nativeFile; }

  async start(): Promise<string | null> {
    if (this.executable === null) return "找不到 agy";
    try {
      this.temp = mkdtempSync(`/private/tmp/${permits(this.input.capabilities, "exec") ? COMMAND_TEMP_PREFIX : "knit-agy-"}`);
      writeFileSync(join(this.input.dir, TEMP_PATH), this.temp, { mode: 0o600 });
      this.broker = new AgyBroker(this.input, join(this.temp, "tool.sock"), (event, payload) => this.hook(event, payload));
      await this.broker.start();
      this.writeSettings();
      const command = (event: string) => ({ type: "command", command: this.broker!.hookCommand(event), timeout: 10 });
      const generated = join(this.input.dir, HOOK_TARGET);
      writeFileSync(generated, JSON.stringify({ knit: {
        SessionStart: [command("SessionStart")], Stop: [command("Stop")],
        PreToolUse: [{ matcher: ".*", hooks: [command("PreToolUse")] }],
      } }), { mode: 0o600 });
      mkdirSync(join(this.input.cwd, ".agents"), { recursive: true });
      // agy 1.5.13 ignores hooks linked out of the Worktree.
      updateHook(this.input.cwd, this.input.dir, true);
      return null;
    } catch (error) {
      return String(error);
    }
  }

  prompt(message: string): Promise<AgentResult> {
    this.turn = Promise.withResolvers<AgentResult>();
    if (this.child === null) {
      const first = [
        ...(this.input.resume ? [] : [readFileSync(join(this.input.dir, "system.md"), "utf8")]),
        TURN_INSTRUCTIONS, message,
      ].join("\n\n");
      if (this.input.resume) this.resumeTimer = setTimeout(() => this.startupError("等待 Antigravity 确认恢复的原生对话超时"), 30_000);
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
    clearTimeout(this.resumeTimer);
    this.stopReply?.resolve({});
    this.broker?.stop();
    const child = this.child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "close").catch(() => {});
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill("SIGTERM");
      await exited.finally(() => clearTimeout(force));
    }
    try {
      removeAgyRuntime(this.original.cwd, this.original.dir);
    } catch (error) {
      // 窗格可能已发布了报告，后台结算仍需读到清理失败的原因。
      atomicWrite({ path: join(this.original.dir, CLEANUP_ERROR), data: Buffer.from(error instanceof Error ? error.message : String(error)) });
    }
  }

  private writeSettings(): void {
    const nativeSettings = join(homedir(), ".gemini/antigravity-cli/settings.json");
    const nativePermissions = existsSync(nativeSettings) ? object(object(readFileSync(nativeSettings, "utf8"))?.permissions) : null;
    const handoff = permits(this.input.capabilities, "read") ? handoffReadPaths(this.input.root) : [];
    const exec = permits(this.input.capabilities, "exec");
    writeFileSync(join(this.input.dir, "agy-settings.json"), JSON.stringify({
      trustedWorkspaces: [this.input.cwd], enableTerminalSandbox: false, allowNonWorkspaceAccess: false,
      toolPermission: "request-review", disableSlashCommands: true, agentMode: "", statusLine: { enabled: false }, title: { enabled: false },
      permissions: {
        ...nativePermissions,
        ask: [],
        allow: [
          ...(Array.isArray(nativePermissions?.allow) ? nativePermissions.allow : []),
          ...(exec ? [`command(${this.broker!.commandPrefix})`] : []),
          ...handoff.map((path) => `read_file(${path})`),
          ...(permits(this.input.capabilities, "read") ? [`read_file(${this.input.cwd})`] : []),
          ...(permits(this.input.capabilities, "write") ? [`write_file(${this.input.cwd})`] : []),
        ],
        deny: [
          ...(Array.isArray(nativePermissions?.deny) ? nativePermissions.deny : []),
          ...handoff.map((path) => `write_file(${path})`),
          `read_file(${this.input.dir})`,
          ...(permits(this.input.capabilities, "read") ? [] : ["read_file(*)"]),
          ...(permits(this.input.capabilities, "write") ? [] : ["write_file(*)"]),
          ...(permits(this.input.capabilities, "exec") ? [] : ["command(*)"]),
          ...(permits(this.input.capabilities, "external") ? [] : ["mcp(*)"]),
          ...(permits(this.input.capabilities, "network") ? [] : ["read_url(*)", "execute_url(*)"]),
        ],
      },
    }));
  }

  private launch(first: string): void {
    const dir = join(this.input.dir, "session");
    mkdirSync(dir, { recursive: true });
    const profile = sandboxProfile({ cwd: this.input.cwd, dir: this.input.dir, paths: this.input.protectedPaths ?? [],
      cli: { home: homedir(), temporary: this.temp!, external: permits(this.input.capabilities, "external") },
      network: true, write: permits(this.input.capabilities, "write") });
    const child = spawn(SANDBOX, ["-p", profile, this.executable!, "--settings", join(this.input.dir, "agy-settings.json"),
      ...(this.input.resume ? ["--conversation", this.input.resume.resumeId] : []),
      ...(this.input.model === null ? [] : [`--model=${this.input.model}`]),
      ...(this.input.thinking === null ? [] : [`--effort=${this.input.thinking}`]),
      ...(this.pane ? ["--prompt-interactive", first] : ["--disable-slash-commands", "--input-format", "stream-json", "--output-format", "stream-json"]),
    ], { cwd: this.input.cwd, env: { ...process.env, ...this.broker!.hookEnv, TMPDIR: this.temp!, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, stdio: this.pane ? "inherit" : "pipe" });
    this.child = child;
    child.on("error", (error) => this.startupError(`Antigravity 启动失败：${error.message}`));
    child.on("close", (code, signal) => this.startupError(
      this.pane && (code === 0 || signal === "SIGHUP" || signal === "SIGTERM") ? "执行者的窗格关掉了，没有交报告" :
        `Antigravity 会话退出（${signal ?? code}）${this.stderr.trim() ? `：${this.stderr.trim()}` : ""}`));
    if (!this.pane) {
      this.streamFile = join(dir, "agy.jsonl");
      child.stdin!.on("error", (error) => this.startupError(`Antigravity 输入已关闭：${error.message}`));
      child.stderr!.setEncoding("utf8").on("data", (data: string) => { this.stderr = (this.stderr + data).slice(-8192); });
      createInterface({ input: child.stdout! }).on("line", (line) => this.background(line));
    }
  }

  private startupError(failure: string): void {
    this.turn.resolve({ report: null, failure, ...(this.input.resume && !this.conversationId ? { startupFailure: true } : {}) });
  }

  private observeConversation(id: unknown): boolean {
    if (typeof id !== "string" || !id.trim()) return true;
    if (this.input.resume && id !== this.input.resume.resumeId) {
      this.startupError(`Antigravity 打开的原生对话 ${id} 与请求不一致`);
      return false;
    }
    clearTimeout(this.resumeTimer);
    this.conversationId = id;
    return true;
  }

  private send(message: string): void {
    this.child!.stdin!.write(`${JSON.stringify({ event: "user", message: { content: message } })}\n`);
  }

  private background(line: string): void {
    appendFileSync(this.streamFile!, `${line}\n`);
    const event = object(line);
    if (!this.observeConversation(event?.conversation_id ?? object(event?.result)?.conversation_id)) return;
    const step = object(event?.step_update);
    if (event?.event === "step_update" && step?.state === "ERROR") {
      const error = errorText(object(step.tool_info)?.error);
      if (error) this.backgroundErrors.push(error);
    }
    if (event?.event !== "result") return;
    const result = object(event.result) ?? {};
    if (this.input.resume && !this.conversationId) return this.startupError(errorText(result.error) || "Antigravity 未确认原生对话 ID");
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
    if (!this.observeConversation(payload.conversationId)) return { decision: "deny", reason: "恢复的对话 ID 不匹配" };
    if (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) {
      const file = resolve(this.input.cwd, payload.transcriptPath.replace(/^~\//, `${homedir()}/`));
      if (file !== this.nativeFile) {
        atomicWrite({ path: join(this.input.dir, SESSION_FILE_LOCATOR), data: Buffer.from(file) });
        this.nativeFile = file;
        this.transcriptCursor = this.input.resume && event === "SessionStart" && existsSync(file)
          ? readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean).length : 0;
      }
    }
    if (!this.pane || event !== "Stop" || payload.fullyIdle !== true) return {};
    if (this.input.resume && !this.conversationId) {
      this.startupError("Antigravity 窗格未确认原生对话 ID");
      return {};
    }
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
