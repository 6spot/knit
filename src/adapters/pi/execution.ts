/** Knit 执行接口的 Pi CLI 实现；原生协议、启动参数和权限映射不出适配器。 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentLaunch, AgentResult, AgentSession } from "../../contracts/agent.js";
import type { ToolCapability } from "../../contracts/workflow.js";
import { modelFailure } from "../../domain/report.js";
import { inspectNativeSessionFile, piResumeSystemPrompt, verifiedPiResumeId } from "./native-file.js";
import { interactivePiCommand, PiAgentRuntime, type PiRuntimeOptions } from "./runtime.js";

const BUILTIN_TOOLS = {
  read: ["read", "grep", "find", "ls"],
  write: ["write", "edit"],
  exec: ["bash"],
} as const;

export function piSessionDefaults() {
  return {
    model: process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : null,
    thinking: process.env.PI_REASONING_LEVEL ?? null,
  };
}

export class PiExecutionAdapter implements AgentAdapter {
  constructor(private readonly executablePath: string) {}

  checkResume(resumeId: string, cwd: string): string | null {
    const check = inspectNativeSessionFile(resumeId);
    if (!check.exists) return "Pi 原生会话文件不存在";
    if (check.problem) return `Pi 原生会话文件损坏（${check.problem}）`;
    if (!check.hasConversation) return "Pi 原生会话缺少历史交接或助手回复";
    return check.identity?.cwd === cwd || check.identity?.cwd === realpathSync.native(cwd) ? null : "Pi 原生会话的 Worktree 不匹配";
  }

  createSession(input: AgentLaunch): AgentSession {
    const systemFile = join(input.dir, "system.md");
    return new PiExecutionSession(new PiAgentRuntime({
      ...this.options(input),
      appendSystemPrompt: input.resume ? piResumeSystemPrompt(input.resume.resumeId, systemFile) : systemFile,
    }), input.resume?.resumeId);
  }

  paneCommand(input: AgentLaunch): readonly string[] {
    const systemFile = join(input.dir, "system.md");
    return interactivePiCommand({
      ...this.options(input),
      appendSystemPrompt: input.resume ? piResumeSystemPrompt(input.resume.resumeId, systemFile) : systemFile,
      extensionPaths: [fileURLToPath(new URL("./pane-worker.js", import.meta.url))],
    }, {
      KNIT_PANE_DIR: input.dir,
      KNIT_PANE_MODEL: input.model!,
      KNIT_PANE_REPORT: JSON.stringify(input.report),
      KNIT_PANE_RESUME: input.resume ? JSON.stringify(input.resume) : "",
    });
  }

  private options(input: AgentLaunch): PiRuntimeOptions {
    const model = input.model!;
    return {
      executablePath: this.executablePath,
      provider: model.slice(0, model.indexOf("/")),
      modelId: model.slice(model.indexOf("/") + 1),
      thinkingLevel: input.thinking ?? undefined,
      cwd: input.cwd,
      sessionFile: input.resume?.resumeId,
      sessionDir: join(input.dir, "session"),
      ...runtimeTools(input.capabilities),
    };
  }
}

class PiExecutionSession implements AgentSession {
  constructor(private readonly runtime: PiAgentRuntime, private readonly requestedFile?: string) {}

  get resumeId() { return verifiedPiResumeId(this.runtime.sessionFile, this.runtime.nativeSessionId); }

  get sessionFile() { return this.runtime.sessionFile; }

  async start() {
    const started = await this.runtime.start();
    if (!started.ok) {
      const recoverable = started.failure === "connection_closed" || started.failure === "session_identity_mismatch" || started.failure === "no_session_state";
      return this.requestedFile && recoverable ? { resumeFailure: started.detail } : started.detail;
    }
    return this.requestedFile && this.resumeId !== this.requestedFile ? { resumeFailure: "Pi 启动时未打开指定的原生会话" } : null;
  }

  async prompt(message: string): Promise<AgentResult> {
    const settled = await this.runtime.prompt(message);
    if (!settled.settled) return { report: null, failure: settled.diagnostics ? `执行者中途退出：${settled.diagnostics}` : "执行者中途退出" };
    if (settled.aborted) return { report: null, failure: "执行者被中止" };
    const error = this.runtime.lastModelError();
    if (error !== null) return { report: null, failure: modelFailure(error).failure! };
    return { report: await this.runtime.getLastAssistantText(), failure: null };
  }

  async stop(): Promise<void> { await this.runtime.dispose(); }
}

function runtimeTools(capabilities: readonly ToolCapability[] | null): Pick<PiRuntimeOptions, "capabilities" | "tools" | "toolAdditions" | "excludeTools"> {
  if (capabilities === null) return { capabilities: null, tools: null };
  const wanted = Object.entries(BUILTIN_TOOLS).flatMap(([capability, names]) =>
    capabilities.includes(capability as ToolCapability) ? [...names] : [],
  );
  if (!capabilities.includes("external")) return { capabilities, tools: wanted };
  // external 保留扩展工具，只排除没有授权的内置工具。
  return {
    capabilities,
    tools: null,
    toolAdditions: wanted,
    excludeTools: Object.values(BUILTIN_TOOLS).flat().filter((name) => !wanted.includes(name)),
  };
}
