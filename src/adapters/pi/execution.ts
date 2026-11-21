/** Knit 执行接口的 Pi CLI 实现；原生协议、启动参数和权限映射不出适配器。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentLaunch, AgentResult, AgentSession } from "../../contracts/agent.js";
import type { ToolCapability } from "../../contracts/workflow.js";
import { modelFailure } from "../../domain/report.js";
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

  createSession(input: AgentLaunch): AgentSession {
    return new PiExecutionSession(new PiAgentRuntime({
      ...this.options(input),
      appendSystemPrompt: readFileSync(join(input.dir, "system.md"), "utf8"),
    }));
  }

  paneCommand(input: AgentLaunch): readonly string[] {
    return interactivePiCommand({
      ...this.options(input),
      appendSystemPrompt: join(input.dir, "system.md"),
      extensionPaths: [fileURLToPath(new URL("./pane-worker.js", import.meta.url))],
    }, { KNIT_PANE_DIR: input.dir, KNIT_PANE_MODEL: input.model, KNIT_PANE_REPORT: JSON.stringify(input.report) });
  }

  private options(input: AgentLaunch): PiRuntimeOptions {
    return {
      executablePath: this.executablePath,
      provider: input.model.slice(0, input.model.indexOf("/")),
      modelId: input.model.slice(input.model.indexOf("/") + 1),
      thinkingLevel: input.thinking ?? undefined,
      cwd: input.cwd,
      sessionDir: join(input.dir, "session"),
      ...runtimeTools(input.capabilities),
    };
  }
}

class PiExecutionSession implements AgentSession {
  constructor(private readonly runtime: PiAgentRuntime) {}

  get sessionFile() { return this.runtime.sessionFile; }

  async start(): Promise<string | null> {
    const started = await this.runtime.start();
    return started.ok ? null : started.detail;
  }

  async prompt(message: string): Promise<AgentResult> {
    const settled = await this.runtime.prompt(message);
    if (!settled.settled) return { report: null, failure: "执行者中途退出" };
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
