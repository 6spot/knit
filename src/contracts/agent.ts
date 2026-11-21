/** 客户端只提供会话操作与观察结果；报告规则、执行记录和 Rex 由 Knit 管理。 */
import type { ReportFieldType, ToolCapability } from "./workflow.js";

export interface AgentLaunch {
  readonly model: string;
  readonly thinking: string | null;
  readonly capabilities: readonly ToolCapability[] | null;
  readonly report: Readonly<Record<string, ReportFieldType>>;
  readonly cwd: string;
  readonly dir: string;
}

export type AgentResult =
  | { readonly report: string; readonly failure: null }
  | { readonly report: null; readonly failure: string };

export interface AgentSession {
  readonly sessionFile: string | null;
  /** null 表示启动成功，否则给出客户端的失败原因。 */
  start(): Promise<string | null>;
  /** 在原会话发送消息，等客户端真正结束这一轮后返回。 */
  prompt(message: string): Promise<AgentResult>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  createSession(input: AgentLaunch): AgentSession;
  /** 交互客户端的完整启动命令；不支持交互时返回 null。 */
  paneCommand(input: AgentLaunch): readonly string[] | null;
}
