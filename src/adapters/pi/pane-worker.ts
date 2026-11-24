/** Pi 窗格扩展：采集原生事件，通过执行接口交给 Knit 共用会话流程。 */
import { verifiedPiResumeId } from "./native-file.js";
import type { AgentLaunch, AgentResult, AgentSession } from "../../contracts/agent.js";
import type { ReportFieldType } from "../../contracts/workflow.js";
import { modelFailure } from "../../domain/report.js";
import { runPaneSession } from "../../application/run-execute.js";

interface Message {
  readonly role: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[] | string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}
interface Context {
  readonly sessionManager: {
    getBranch(): readonly { readonly type: string; readonly message?: Message }[];
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
  readonly modelRegistry: { find(provider: string, modelId: string): unknown };
  readonly ui: { notify(text: string, kind: "info" | "warning" | "error"): void };
  shutdown(): void;
}
interface Pi {
  on(event: "session_start", handler: (event: { reason: string }, ctx: Context) => void): void;
  on(event: "agent_settled", handler: (event: { aborted: boolean }, ctx: Context) => void): void;
  on(event: "session_before_switch" | "session_before_fork", handler: () => { cancel: true }): void;
  sendUserMessage(text: string): void;
}

export default function paneWorker(pi: Pi): void {
  const dir = process.env.KNIT_PANE_DIR!;
  const declared = JSON.parse(process.env.KNIT_PANE_REPORT!) as Record<string, ReportFieldType>;
  const resume = process.env.KNIT_PANE_RESUME ? JSON.parse(process.env.KNIT_PANE_RESUME) as AgentLaunch["resume"] : undefined;
  const model = process.env.KNIT_PANE_MODEL!;
  const pending: { resolve?: (result: AgentResult) => void } = {};

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    const createSession = (): AgentSession => ({
      get sessionFile() { return ctx.sessionManager.getSessionFile() ?? null; },
      get resumeId() { return verifiedPiResumeId(ctx.sessionManager.getSessionFile() ?? null, ctx.sessionManager.getSessionId()); },
      start: async () => {
        if (resume && resume.resumeId !== verifiedPiResumeId(ctx.sessionManager.getSessionFile() ?? null, ctx.sessionManager.getSessionId())) return "Pi 窗格未打开指定的原生会话";
        return ctx.modelRegistry.find(model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)) ? null : `Pi 里没有模型 ${model}`;
      },
      prompt: (message) => new Promise<AgentResult>((resolve) => {
        pending.resolve = resolve;
        pi.sendUserMessage(message);
      }),
      stop: async () => ctx.shutdown(),
    });
    // 不等待执行结束：Pi 要先退出 session_start / agent_settled 事件派发才能开始下一轮。
    void runPaneSession({ dir, declared, resume, createSession, hostClient: ctx });
  });

  pi.on("agent_settled", (event, ctx) => {
    const last = ctx.sessionManager.getBranch()
      .findLast((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
    if (event.aborted || last?.stopReason === "aborted") {
      ctx.ui.notify("Knit：执行者被中止了。接着输入就继续做；要结束这次执行，关掉窗格或者运行 knit run cancel。", "info");
      return;
    }
    const result: AgentResult = last?.stopReason === "error"
      ? { report: null, failure: modelFailure(last.errorMessage).failure! }
      : {
        report: (last === undefined || typeof last.content === "string" ? [] : last.content)
          .flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : [])
          .join("").trim(),
        failure: null,
      };
    const resolve = pending.resolve;
    delete pending.resolve;
    resolve?.(result);
  });

  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
}
