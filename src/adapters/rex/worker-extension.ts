/**
 * Rex 阶段 Worker 的 Pi 扩展（本任务 design.md S2）。
 *
 * 激活条件：Pi 进程环境含 PI_KNIT_REX_WORKER（值为 1 时从 PI_KNIT_REX_MANIFEST 读取；
 * 兼容直接把 manifest 路径作为值）。扩展只在该 TUI 会话内工作：
 *   - session_start 校验 TUI 模式与预分配 sessionId，取 owner 单实例锁并起 bridge；
 *   - 注入 launch 时冻结的 prompt；
 *   - before_agent_start/agent_start 映射 running，ui_prompt_* 映射 blocked；
 *   - agent_settled 从会话分支提取最后 assistant 消息，写 rex/results/<rev>.json；
 *   - session_shutdown 收敛未完成轮次、关闭 bridge 并释放 owner。
 *
 * 阶段报告与验收仍由 Knit 核心按 result.json 复核；本扩展不写 Task、不推进阶段。
 */
import { rmSync } from "node:fs";
import { BridgeServer, type BridgeRequest } from "./bridge.js";
import {
  acquireOwnerLock,
  activeRexStatus,
  finishRun,
  newRexInstance,
  readRexPrompt,
  readRexWorkerManifest,
  readRexWorkerState,
  rexDirectory,
  rexManifestPath,
  rexOwnerPath,
  rexPromptPath,
  rexSocketPath,
  rexStatePath,
  writeRexWorkerResult,
  writeRexWorkerState,
  type RexSessionEntry,
  type RexWorkerManifest,
  type RexWorkerState,
} from "./state.js";

interface SessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | null;
  getLeafId(): string | null;
  getBranch(): readonly RexSessionEntry[];
}

interface WorkerContextLike {
  mode: string;
  sessionManager: SessionManagerLike;
  abort(): void;
  shutdown(): void;
  ui?: { notify?(message: string, level?: "info" | "warning" | "error"): void };
}

interface WorkerPiLike {
  on(event: string, handler: (event: Record<string, unknown>, ctx: WorkerContextLike) => unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): unknown;
}

/** 只接受显式激活；普通主会话加载本扩展时完全不注册。 */
export function workerManifestPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const activation = env.PI_KNIT_REX_WORKER;
  if (activation === undefined || activation === "") return null;
  if (activation !== "1") return activation;
  const manifest = env.PI_KNIT_REX_MANIFEST;
  return manifest === undefined || manifest === "" ? null : manifest;
}

function now(): string {
  return new Date().toISOString();
}

export default function registerRexWorker(pi: WorkerPiLike): void {
  const manifestPath = workerManifestPath();
  if (manifestPath === null) return;

  let manifest: RexWorkerManifest | null = null;
  let state: RexWorkerState | null = null;
  let context: WorkerContextLike | null = null;
  let bridge: BridgeServer | null = null;
  let releaseOwner: (() => void) | null = null;
  let ready = false;

  const publish = (): void => {
    if (manifest === null || state === null) return;
    state.updatedAt = now();
    if (context !== null) {
      state.sessionFile = context.sessionManager.getSessionFile() ?? state.sessionFile;
      state.leafId = context.sessionManager.getLeafId() ?? state.leafId;
    }
    writeRexWorkerState(manifest.statePath, state);
    bridge?.publish();
  };

  const begin = (ctx: WorkerContextLike): void => {
    if (state === null) return;
    if (!activeRexStatus(state.status)) {
      state.run += 1;
      state.runStartLeaf = ctx.sessionManager.getLeafId();
      state.suppressedRevision = 0;
    }
    state.status = "running";
    state.error = null;
    publish();
  };

  const settle = (aborted: boolean): void => {
    if (manifest === null || state === null || context === null) return;
    if (!activeRexStatus(state.status)) return;
    const result = finishRun(state, context.sessionManager.getBranch(), aborted, context.sessionManager.getLeafId());
    writeRexWorkerResult(manifest.directory, result);
    state.resultRevision = result.revision;
    state.status = result.outcome;
    state.error = result.error;
    publish();
    if (manifest.closeOnSettle) {
      // 结果与 state 已落盘；让 settled 处理器全部结束后再关闭 TUI。
      // closeOnSettle=false（StageRunner 的补报窗口）时不自行退出，
      // 由核心在补报窗口结束后 terminate() 关闭浮层并终止本进程。
      setTimeout(() => {
        try {
          context?.shutdown();
        } catch {
          // 关闭失败不影响已发布结果；进程退出仍会被宿主观察到。
        }
      }, 25);
    }
  };

  const failStartup = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (manifest !== null) {
      try {
        if (state === null) {
          state = {
            schemaVersion: 1,
            runId: manifest.runId,
            instance: manifest.instance,
            status: "idle",
            run: 0,
            resultRevision: 0,
            pid: process.pid,
            sessionFile: null,
            runStartLeaf: null,
            leafId: null,
            block: process.env.REX_BLOCK ?? null,
            suppressedRevision: 0,
            error: null,
            updatedAt: now(),
          };
        }
        const revision = Math.max(1, state.run);
        writeRexWorkerResult(manifest.directory, {
          schemaVersion: 1,
          runId: manifest.runId,
          revision,
          outcome: "error",
          text: "",
          error: message,
          sessionFile: state.sessionFile,
          leafId: state.leafId,
          completedAt: now(),
        });
        state.status = "error";
        state.resultRevision = revision;
        state.error = message;
        publish();
      } catch {
        // 启动错误不能覆盖成另一个成功结果；通知与退出仍是本轮事实。
      }
    }
    try {
      context?.ui?.notify?.(`Rex worker 启动失败：${message}`, "error");
    } catch {
      // 通知失败不影响退出。
    }
    try {
      context?.shutdown();
    } catch {
      // 同上。
    }
  };

  const handle = (input: BridgeRequest): unknown => {
    if (state === null || context === null) return { accepted: false, reason: "not_ready" };
    if (input.method === "stop") {
      if (!activeRexStatus(state.status)) {
        // 已完成/已取消的轮次不能被迟到的 stop 覆盖成另一个结果。
        return { accepted: false, reason: "not_running", run: state.run };
      }
      state.suppressedRevision = state.run;
      publish();
      context.abort();
      return { accepted: true, run: state.run };
    }
    if (input.method === "steer") {
      if (typeof input.message !== "string") return { accepted: false, reason: "message_required" };
      if (!activeRexStatus(state.status)) begin(context);
      pi.sendUserMessage(input.message, { deliverAs: "steer" });
      return { accepted: true, run: state.run };
    }
    return state;
  };

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    try {
      const loaded = readRexWorkerManifest(manifestPath);
      if (loaded === null) throw new Error(`Rex manifest 不存在：${manifestPath}`);
      if (ctx.mode !== "tui") throw new Error(`Rex worker 必须在 TUI 模式运行（实际 ${ctx.mode}）`);
      if (ctx.sessionManager.getSessionId() !== loaded.sessionId) {
        throw new Error(
          `Rex worker 会话身份不符：实际 ${ctx.sessionManager.getSessionId()}，预期 ${loaded.sessionId}`,
        );
      }
      manifest = loaded;
      releaseOwner = acquireOwnerLock(loaded.ownerPath);

      const previous = readRexWorkerState(loaded.statePath);
      const sameInstance = previous !== null && previous.instance === loaded.instance;
      state = sameInstance
        ? {
            ...previous,
            pid: process.pid,
            status: "idle",
            error: null,
            leafId: null,
            sessionFile: ctx.sessionManager.getSessionFile() ?? previous.sessionFile,
            block: process.env.REX_BLOCK ?? previous.block,
            updatedAt: now(),
          }
        : {
            schemaVersion: 1,
            runId: loaded.runId,
            instance: loaded.instance,
            status: "idle",
            run: previous?.run ?? 0,
            resultRevision: previous?.resultRevision ?? 0,
            pid: process.pid,
            sessionFile: ctx.sessionManager.getSessionFile(),
            runStartLeaf: ctx.sessionManager.getLeafId(),
            leafId: null,
            block: process.env.REX_BLOCK ?? null,
            suppressedRevision: 0,
            error: null,
            updatedAt: now(),
          };
      // 同一实例的 reload／重入不重复注入初始 prompt；只有首次启动才开第一轮。
      const injectPrompt = !sameInstance || (previous?.run ?? 0) === 0;

      const prompt = readRexPrompt(loaded.promptPath);
      if (prompt === null) throw new Error(`Rex prompt 不存在：${loaded.promptPath}`);

      rmSync(loaded.socketPath, { force: true });
      bridge = new BridgeServer(loaded.socketPath, () => state, handle);
      await bridge.listen();
      ready = true;
      publish();

      // 与 runtime.prompt 等效：扩展注入一次冻结 prompt；之后只接受 steer/stop。
      if (injectPrompt) {
        begin(ctx);
        pi.sendUserMessage(prompt);
      }
    } catch (error) {
      ready = false;
      failStartup(error);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    context = ctx;
    if (!ready) {
      ctx.abort();
      throw new Error("Rex worker bridge 尚未就绪");
    }
    begin(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    if (ready) begin(ctx);
  });

  pi.on("agent_settled", (event) => {
    if (ready) settle(event.aborted === true);
  });

  pi.on("ui_prompt_start", () => {
    if (ready && state !== null && activeRexStatus(state.status)) {
      state.status = "blocked";
      publish();
    }
  });

  pi.on("ui_prompt_end", () => {
    if (ready && state !== null && state.status === "blocked") {
      state.status = "running";
      publish();
    }
  });

  // 身份固定在预分配会话；不允许在运行中切换／fork 到另一个对象。
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));

  pi.on("session_shutdown", async (event) => {
    ready = false;
    try {
      if (state !== null && activeRexStatus(state.status) && event.reason !== "reload") settle(true);
      if (state !== null) {
        state.status = "closed";
        publish();
      }
    } finally {
      await bridge?.close().catch(() => {});
      bridge = null;
      releaseOwner?.();
      releaseOwner = null;
    }
  });
}

export { newRexInstance, rexDirectory, rexManifestPath, rexOwnerPath, rexPromptPath, rexSocketPath, rexStatePath };
