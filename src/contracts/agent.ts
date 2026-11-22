/** 客户端只提供会话操作与观察结果；报告规则、执行记录和 Rex 由 Knit 管理。 */
import type { AgentName, ReportFieldType, ToolCapability } from "./workflow.js";

export interface AgentLaunch {
  readonly model: string | null;
  readonly thinking: string | null;
  readonly capabilities: readonly ToolCapability[] | null;
  readonly report: Readonly<Record<string, ReportFieldType>>;
  /** 任务资料所在的主检出。 */
  readonly root: string;
  readonly cwd: string;
  readonly dir: string;
  readonly protectedPaths?: readonly string[];
  readonly resume?: { readonly resumeId: string; readonly messageFile: string };
}

export type AgentResult =
  | { readonly report: string; readonly failure: null }
  | { readonly report: null; readonly failure: string; readonly startupFailure?: true };

export interface AgentSession {
  readonly sessionFile: string | null;
  readonly resumeId: string | null;
  /** null 表示启动成功，否则给出客户端的失败原因。 */
  start(): Promise<string | null>;
  /** 在原会话发送消息，等客户端真正结束这一轮后返回。 */
  prompt(message: string): Promise<AgentResult>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  /** 返回原生恢复不可用的原因。缺省表示客户端不支持。 */
  checkResume?(resumeId: string, cwd: string): string | null;
  createSession(input: AgentLaunch): AgentSession;
  /** 交互客户端的完整启动命令；不支持交互时返回 null。 */
  paneCommand(input: AgentLaunch): readonly string[] | null;
}

export interface AgentRegistration {
  createAdapter(): AgentAdapter;
  sessionDefaults(): { readonly model: string | null; readonly thinking: string | null };
  checkDispatch?(root: string, cwd: string, branch: string, capabilities: readonly ToolCapability[] | null): string | null;
  cleanRun?(cwd: string, dir: string): void;
  /** Worktree 临时文件及其在本次执行目录中的原件，供同批成员核对快照。 */
  readonly workspaceCopies?: Readonly<Record<string, string>>;
}

export type AgentRegistry = Readonly<Record<AgentName, AgentRegistration>>;
