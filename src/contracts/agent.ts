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
  /** 恢复启动失败可显式请求以完整交接重开，普通启动错误直接结算。 */
  start(): Promise<string | { readonly resumeFailure: string } | null>;
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

export interface PaneOptions {
  readonly label: string;
  readonly command: readonly string[];
  readonly cwd: string;
}

/** 每次打开得到独立的窗格句柄，由创建它的宿主等待和关闭。 */
export interface PaneHost<Pane> {
  /** 在指定工作目录启动命令，开窗失败时抛出。 */
  open(options: PaneOptions): Pane;
  /** 窗格关闭或其中的命令退出时结束等待。 */
  waitClosed(pane: Pane, signal?: AbortSignal): Promise<void>;
  /** 关闭窗格并结束其中的命令。窗格已经关闭时直接返回。 */
  close(pane: Pane): void;
}
