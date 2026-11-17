/**
 * 执行者在 Rex 窗格里跑时 Pi 加载的扩展（`pi --extension <这个文件编译出来的 .js>`）。
 * 它替后台进程做这几件事：把第一条消息发给执行者，等它做完，把最后一条消息存成 report.md，
 * 报告读不出来时要求补报一次，把结果写进 outcome.json，然后让 Pi 退出（窗格随之关掉）。
 *
 * 环境变量：KNIT_PANE_DIR 是执行目录，KNIT_PANE_REPORT 是环节声明的报告字段（JSON），
 * KNIT_PANE_MODEL 是 provider/模型。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportFieldType } from "../../contracts/workflow.js";
import { type ReportOutcome, reportOutcome, reportRetryMessage } from "../../domain/report.js";
import { atomicWrite } from "../../infrastructure/atomic.js";
import { procStartTicks, recordedProcess } from "../../infrastructure/process.js";

/** 窗格里的 Pi 登记自己的文件：有它就说明执行者已经在窗格里开始了。 */
export const PANE_FILE = "pane.json";
/** 窗格里的执行者交出的结果；没有它就是窗格中途没了。 */
export const PANE_OUTCOME_FILE = "outcome.json";

export interface PaneOutcome extends ReportOutcome {
  /** 会话文件的绝对路径。 */
  readonly sessionFile: string | null;
}

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
  const model = process.env.KNIT_PANE_MODEL!;
  let retried = false;

  const finish = (ctx: Context, outcome: ReportOutcome): void => {
    const result: PaneOutcome = { ...outcome, sessionFile: ctx.sessionManager.getSessionFile() ?? null };
    // 窗格随时可能被关掉：整份写好再换上去，后台进程读不到半截的文件。
    atomicWrite({ path: join(dir, PANE_OUTCOME_FILE), data: Buffer.from(`${JSON.stringify(result, null, 2)}\n`) });
    ctx.shutdown();
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    const identity = { pid: process.pid, start: procStartTicks(process.pid) };
    atomicWrite({ path: join(dir, PANE_FILE), data: Buffer.from(`${JSON.stringify(identity, null, 2)}\n`) });
    // 后台进程不在了（还没开始就被取消了）：没有人等结果，不做。先登记再看，取消那边是等后台进程退出之后
    // 再找一次登记，两边总有一边看得到对方。
    if (recordedProcess(join(dir, "worker.json")) === null) return ctx.shutdown();
    // 模型不认识时 Pi 照样启动，到第一次请求才失败：这里先看一眼，和后台执行一样记成启动失败。
    const slash = model.indexOf("/");
    if (!ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))) {
      return finish(ctx, { verdict: null, failure: `执行者启动失败：Pi 里没有模型 ${model}` });
    }
    pi.sendUserMessage(readFileSync(join(dir, "message.md"), "utf8"));
  });

  pi.on("agent_settled", (event, ctx) => {
    const last = ctx.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
    // 用户在窗格里按 Esc 中止：这次执行不结束，窗格留着，接着输入执行者就接着做。
    if (event.aborted || last?.stopReason === "aborted") {
      ctx.ui.notify("Knit：执行者被中止了。接着输入就继续做；要结束这次执行，关掉窗格或者运行 knit run cancel。", "info");
      return;
    }
    if (last?.stopReason === "error") {
      return finish(ctx, { verdict: null, failure: `执行者出错：${last.errorMessage ?? "没有给出原因"}` });
    }
    const blocks = last === undefined || typeof last.content === "string" ? [] : last.content;
    const report = blocks
      .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
      .join("")
      .trim();
    writeFileSync(join(dir, "report.md"), report);
    const read = reportOutcome(declared, report);
    if (read.outcome !== null) return finish(ctx, read.outcome);
    if (retried) return finish(ctx, { verdict: null, failure: `报告读不出来：${read.problems.join("；")}` });
    retried = true;
    pi.sendUserMessage(reportRetryMessage(read.problems));
  });

  // 换了会话之后就不是这次执行了。
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
}
