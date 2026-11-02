/**
 * Knit 项目薄桥接（Knit init 生成，模板随安装包发布）。
 * 仅使用 Pi 公开 Extension API：转交原生会话、命令与工具；业务处理调用本机 Knit CLI。
 * 本文件可入库；本机安装映射在 .knit/.runtime/installation.json，不写进本文件。
 * 只有本机清单 ready 且映射匹配时桥接才处理调用；缺失或不匹配则提示重新 init。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const MANAGED_BASELINE = "__BRIDGE_BASELINE__";
const SELECTION_ENTRY = "knit.selection";
const NOTICE_ENTRY = "knit.notice";
const POLL_MS = 5000;

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function projectRootFromExtension(): string {
  try {
    return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  } catch {
    return process.cwd();
  }
}

export default function (pi: any) {
  const root = projectRootFromExtension();
  const state: any = { ctx: null, knitSessionId: null, nativeSessionId: null, branch: null, timer: null, started: false, verified: false };
  function loadSchemas(): any {
    const installation = readJson(join(root, ".knit", ".runtime", "installation.json"));
    if (typeof installation?.cliEntry !== "string") return null;
    return readJson(join(dirname(installation.cliEntry), "..", "contracts", "bridge-tools.json"));
  }
  const schemas = loadSchemas();

  function diag(event: string, fields: any = {}): void {
    if (process.env.KNIT_DEV !== "1") return;
    const allowed: any = { type: "knit.bridge.diag", event };
    for (const key of ["runId", "taskId", "phase", "state", "reason", "session", "code"]) {
      if (fields[key] !== undefined && fields[key] !== null) allowed[key] = String(fields[key]).slice(0, 200);
    }
    process.stderr.write(JSON.stringify(allowed) + "\n");
  }

  function installationReady(): { ready: boolean; reason?: string; runtime?: any } {
    const runtime = readJson(join(root, ".knit", ".runtime", "installation.json"));
    const manifest = readJson(join(root, ".knit", ".runtime", "init-manifest.json"));
    if (!runtime || !manifest) return { ready: false, reason: "缺少本机安装映射或初始化清单；在项目根重新运行 knit init" };
    if (manifest.state !== "ready") return { ready: false, reason: `初始化清单为 ${manifest.state}；重新运行 knit init 补齐` };
    if (typeof runtime.cliEntry !== "string" || !existsSync(runtime.cliEntry)) return { ready: false, reason: "安装映射缺少可用 CLI 入口；重新运行 knit init" };
    return { ready: true, runtime };
  }

  function execKnit(args: string[], stdin?: string): { code: number; stdout: string; stderr: string; error?: string } {
    const check = installationReady();
    if (!check.ready) return { code: 1, stdout: "", stderr: "", error: check.reason };
    const cliArgs = ["--json", ...(process.env.KNIT_DEV === "1" ? ["--dev"] : []), ...args];
    const result = spawnSync(process.execPath, [check.runtime!.cliEntry, ...cliArgs], {
      cwd: root,
      encoding: "utf8",
      input: stdin,
      timeout: 180_000,
      env: { ...process.env, KNIT_BRIDGE_BASELINE: MANAGED_BASELINE },
    });
    if (result.error) return { code: 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: String(result.error) };
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function core(args: string[], stdin?: string): { code: number; response: any; stderr: string; error?: string } {
    const result = execKnit(args, stdin);
    if (result.error) return { code: 1, response: null, stderr: result.stderr, error: result.error };
    let response: any = null;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      return { code: result.code, response: null, stderr: result.stderr, error: result.stdout.trim().slice(0, 500) || "Knit 返回非 JSON" };
    }
    return { code: result.code, response, stderr: result.stderr };
  }

  function toolResult(result: { code: number; response: any; stderr: string; error?: string }) {
    const ok = result.error === undefined && result.code === 0 && result.response?.outcome === "completed";
    const text = result.error ?? (result.response === null ? result.stderr : JSON.stringify(result.response));
    return {
      isError: !ok,
      content: [{ type: "text", text: text || (ok ? "{}" : "Knit 调用失败") }],
      details: result.response?.data ?? null,
    };
  }

  function failText(message: string) {
    return { isError: true, content: [{ type: "text", text: message }], details: null };
  }

  function safeId(value: unknown, prefix: string): string | null {
    if (typeof value !== "string") return null;
    return new RegExp(`^${prefix}[0-9a-z-]+$`).test(value) ? value : null;
  }

  function branchNow(): string | null {
    const result = spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: root, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  }

  function sessionOf(ctx: any): { knitSessionId: string; nativeSessionId: string } | null {
    const nativeId = ctx?.sessionManager?.getSessionId?.();
    if (typeof nativeId !== "string") return null;
    if (state.nativeSessionId !== nativeId) {
      state.nativeSessionId = nativeId;
      state.knitSessionId = null;
      state.verified = false;
      state.ctx = ctx;
      state.branch = branchNow();
      const attachArgs = ["session", "attach", "--native", nativeId, "--kind", "main", "--role", "implement"];
      if (state.branch !== null) attachArgs.push("--branch", state.branch);
      const sessionFile = typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
      if (typeof sessionFile === "string") attachArgs.push("--file", sessionFile);
      attachArgs.push("--dir", root);
      const attached = core(attachArgs);
      if (attached.code === 0 && attached.response?.data?.record?.knitSessionId) {
        state.knitSessionId = attached.response.data.record.knitSessionId;
        diag("session_attached", { session: state.knitSessionId });
      } else {
        diag("session_attach_failed", { reason: attached.error ?? attached.response?.reasonCode ?? "unknown" });
      }
    }
    if (state.knitSessionId === null) return null;
    if (state.verified !== true) {
      const currentFile = typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
      const verifyArgs = ["session", "verify", state.knitSessionId];
      if (typeof currentFile === "string") verifyArgs.push("--file", currentFile);
      verifyArgs.push("--dir", root);
      const verified = core(verifyArgs);
      if (verified.code === 0 && verified.response?.data?.status === "available") state.verified = true;
    }
    return { knitSessionId: state.knitSessionId, nativeSessionId: nativeId };
  }

  function activeSelection(ctx: any): any | null {
    try {
      const branch = ctx.sessionManager.getBranch();
      const selections = branch.filter((entry: any) => entry.type === "custom" && entry.customType === SELECTION_ENTRY);
      return selections.length === 0 ? null : selections[selections.length - 1];
    } catch {
      return null;
    }
  }

  function restoreSelection(ctx: any): void {
    const session = sessionOf(ctx);
    if (session === null) return;
    const entry = activeSelection(ctx);
    if (entry === null) return;
    const data = entry.data ?? {};
    const operationId = typeof data.operationId === "string" ? data.operationId : undefined;
    if (data.taskId === null || data.taskId === undefined) {
      core(["task", "clear", "--session", session.knitSessionId, "--entry", entry.id, "--persisted", "--operation-id", operationId ?? "restore-clear", "--dir", root]);
    } else {
      core([
        "task", "use", data.taskId, "--session", session.knitSessionId, "--entry", entry.id, "--persisted",
        "--operation-id", operationId ?? "restore-use", "--branch", data.branch ?? state.branch ?? "", "--dir", root,
      ]);
    }
  }

  function appendSelection(ctx: any, data: any): string | null {
    pi.appendEntry(SELECTION_ENTRY, data);
    try {
      const entries = ctx.sessionManager.getEntries();
      const entry = entries[entries.length - 1];
      return typeof entry?.id === "string" ? entry.id : null;
    } catch {
      return null;
    }
  }

  function notified(ctx: any): Set<string> {
    try {
      return new Set(
        ctx.sessionManager.getEntries()
          .filter((entry: any) => entry.type === "custom" && entry.customType === NOTICE_ENTRY)
          .map((entry: any) => String(entry.data?.signature ?? "")),
      );
    } catch {
      return new Set();
    }
  }

  function scanRuns(ctx: any): void {
    if (ctx.sessionManager.getSessionId() !== state.nativeSessionId) {
      stopObserver();
      return;
    }
    state.ctx = ctx;
    if (state.verified !== true) sessionOf(ctx);
    const list = core(["run", "list", "--dir", root]);
    if (list.code !== 0 || !Array.isArray(list.response?.data)) return;
    for (const run of list.response.data) {
      if (run?.initiator?.nativeSessionId !== state.nativeSessionId) continue;
      if (["completed", "cancelled", "failed"].includes(run.state) && run.result === null) continue;
      const status = core(["status", "--run", run.runId, "--json", "--dir", root]);
      if (status.code !== 0 || status.response?.data === null) continue;
      const view = status.response.data;
      const currentBranch = branchNow();
      if (typeof view.branch === "string" && currentBranch !== null && view.branch !== currentBranch) {
        diag("notice_skipped_branch", { runId: view.runId, branch: view.branch });
        continue;
      }
      const resultState = view.result?.state ?? null;
      const acceptanceState = view.acceptance?.state ?? null;
      const terminal = ["completed", "cancelled", "failed"].includes(resultState ?? view.state);
      if (!terminal) continue;
      const signature = `${view.runId}:${resultState ?? view.state}`;
      if (notified(ctx).has(signature)) continue;
      const pending = resultState === "completed" && acceptanceState !== "completed";
      const text = pending
        ? `Knit run ${view.runId} 已完成，结果待同步；下一步：knit status --run ${view.runId}（不要重复实施）`
        : `Knit run ${view.runId} ${resultState ?? view.state}${view.result?.report?.verdict ? ` / ${view.result.report.verdict}` : ""}；下一步：查看 status 或 resume。`;
      try {
        const busy = typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
        pi.sendMessage(
          { customType: NOTICE_ENTRY, content: text, display: true, details: { runId: view.runId, state: resultState ?? view.state, acceptance: acceptanceState, signature } },
          busy ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: false },
        );
        pi.appendEntry(NOTICE_ENTRY, { signature, runId: view.runId, state: resultState ?? view.state });
        diag("notice_sent", { runId: view.runId, state: resultState ?? view.state });
      } catch (error) {
        diag("notice_failed", { runId: view.runId, reason: String(error) });
      }
    }
  }

  function startObserver(ctx: any): void {
    stopObserver();
    state.ctx = ctx;
    state.started = true;
    state.timer = setInterval(() => scanRuns(ctx), POLL_MS);
    scanRuns(ctx);
  }

  function stopObserver(): void {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.started = false;
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    state.ctx = ctx;
    const session = sessionOf(ctx);
    if (session !== null) {
      restoreSelection(ctx);
      startObserver(ctx);
    } else {
      diag("not_ready", { reason: installationReady().reason ?? "session attach failed" });
    }
  });

  pi.on("agent_settled", (_event: any, ctx: any) => {
    if (state.nativeSessionId !== ctx?.sessionManager?.getSessionId?.()) return;
    sessionOf(ctx);
    scanRuns(ctx);
  });

  pi.on("session_shutdown", () => {
    stopObserver();
  });

  pi.registerCommand("knit-status", {
    description: "Knit：查看任务与运行状态",
    handler: async (args: string, ctx: any) => {
      const result = core(["status", ...(args.trim() === "" ? [] : args.trim().split(/\s+/)), "--dir", root]);
      const text = result.error ?? result.response?.data?.error ?? result.response?.reasonCode ?? result.stderr;
      ctx.ui.notify(text ? String(text) : "knit status 无输出", result.code === 0 ? "info" : "warning");
    },
  });

  pi.registerCommand("knit-reload", {
    description: "Knit：重新加载项目配置、安装映射与桥接",
    handler: async (_args: string, ctx: any) => {
      const result = core(["doctor", "--dir", root]);
      ctx.ui.notify(result.code === 0 ? "Knit 已重新核对安装与配置" : "Knit 诊断发现需处理项", result.code === 0 ? "info" : "warning");
      try {
        await ctx.reload();
      } catch (error) {
        diag("reload_failed", { reason: String(error) });
      }
    },
  });

  pi.registerCommand("knit", {
    description: "Knit：把参数转交本机 CLI（如 /knit task list）",
    handler: async (args: string, ctx: any) => {
      const tokens = args.trim() === "" ? [] : args.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((item) => item.replace(/^["']|["']$/g, "")) ?? [];
      if (tokens.length === 0) {
        ctx.ui.notify("用法：/knit <子命令> [参数]", "warning");
        return;
      }
      const result = core([...tokens, "--dir", root]);
      const text = result.error ?? result.response?.data?.error ?? result.response?.reasonCode ?? result.stderr;
      ctx.ui.notify(text ? String(text) : "Knit 命令已完成", result.code === 0 ? "info" : "warning");
    },
  });

  const schema = (name: string) => (schemas && schemas[name] ? Type.Unsafe(schemas[name]) : Type.Object({}));

  pi.registerTool({
    name: "knit_status",
    label: "Knit status",
    description: "只读查询 Knit 任务或 run 状态；不接收结果、不重派。",
    parameters: schema("status"),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const args = ["status", "--dir", root];
      if (params.runId) {
        const id = safeId(params.runId, "run-");
        if (id === null) return failText(`非法 runId: ${params.runId}`);
        args.splice(1, 0, "--run", id);
      } else if (params.taskId) {
        const id = safeId(params.taskId, "k-");
        if (id === null) return failText(`非法 taskId: ${params.taskId}`);
        args.splice(1, 0, id);
      }
      return toolResult(core(args));
    },
  });

  pi.registerTool({
    name: "knit_task",
    label: "Knit task",
    description: "任务身份、输入草案、记录、关闭与当前会话选择。",
    parameters: schema("task"),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      if (params.taskId && safeId(params.taskId, "k-") === null) return failText(`非法 taskId: ${params.taskId}`);
      if (params.action === "use" || params.action === "clear") {
        const session = sessionOf(ctx);
        if (session === null) return failText("无法登记当前主会话；先确认项目已 init 且桥接加载");
        const operationId = `sel-${Date.now().toString(36)}`;
        const branch = branchNow();
        const taskId = params.action === "use" ? params.taskId : null;
        if (params.action === "use" && (typeof taskId !== "string" || safeId(taskId, "k-") === null)) return failText("task use 需要合法 taskId");
        const entryId = appendSelection(ctx, { taskId, branch, operationId });
        if (entryId === null) return failText("无法写入原生选择条目");
        const persisted = typeof ctx.sessionManager?.isPersisted === "function" ? ctx.sessionManager.isPersisted() === true : true;
        const persistedArgs = persisted ? ["--persisted"] : [];
        const args = params.action === "use"
          ? ["task", "use", taskId, "--session", session.knitSessionId, "--entry", entryId, ...persistedArgs, "--operation-id", operationId, "--branch", branch ?? "", "--dir", root]
          : ["task", "clear", "--session", session.knitSessionId, "--entry", entryId, ...persistedArgs, "--operation-id", operationId, "--branch", branch ?? "", "--dir", root];
        return toolResult(core(args));
      }
      const args = ["task", params.action];
      if (params.taskId) args.push(params.taskId);
      if (params.action === "new") {
        if (params.title) args.push("--title", params.title);
        if (params.slug) args.push("--slug", params.slug);
        if (params.branch) args.push("--branch", params.branch);
      } else if (params.action === "rename") {
        if (!params.newSlug) return failText("task rename 需要 newSlug");
        args.push(params.newSlug);
        if (params.nonEquivalent === true) args.push("--non-equivalent");
      } else if (params.action === "adopt") {
        args.push("--branch", params.branch ?? "current");
      } else if (params.action === "update") {
        if (params.kind) args.push("--kind", params.kind);
        if (params.applyPending === true) args.push("--apply-pending");
        if (params.withdrawPending === true) args.push("--withdraw-pending");
        if (params.expectPending) args.push("--expect-pending", params.expectPending);
        if (params.reason) args.push("--reason", params.reason);
        args.push("--dir", root);
        return toolResult(core(args, params.body ?? ""));
      } else if (params.action === "record") {
        args.push("--dir", root);
        return toolResult(core(args, params.body ?? ""));
      } else if (params.action === "close") {
        if (!params.outcome) return failText("task close 需要 outcome");
        args.push("--outcome", params.outcome);
        if (params.runsSettled === true) args.push("--runs-settled");
      }
      args.push("--dir", root);
      return toolResult(core(args));
    },
  });

  pi.registerTool({
    name: "knit_context",
    label: "Knit context",
    description: "生成任务阶段的分层输入计划与阻塞项。",
    parameters: schema("context"),
    async execute(_toolCallId: string, params: any) {
      if (safeId(params.taskId, "k-") === null) return failText(`非法 taskId: ${params.taskId}`);
      return toolResult(core(["context", "--task", params.taskId, "--role", params.role ?? "implement", "--dir", root]));
    },
  });

  pi.registerTool({
    name: "knit_run",
    label: "Knit run",
    description: "派发实施／独立检查／advisory，查询、恢复或取消 run；结果通知由桥接观察。",
    parameters: schema("run"),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const model = ctx?.model;
      const provider = params.provider ?? (typeof model?.provider === "string" ? model.provider : undefined);
      const modelId = params.model ?? (typeof model?.id === "string" ? model.id : undefined);
      if (params.action === "list") return toolResult(core(["run", "list", "--dir", root]));
      if (params.action === "status") {
        if (!params.runId || safeId(params.runId, "run-") === null) return failText("run status 需要合法 runId");
        return toolResult(core(["status", "--run", params.runId, "--dir", root]));
      }
      if (params.action === "resume") {
        if (!params.runId || safeId(params.runId, "run-") === null) return failText("run resume 需要合法 runId");
        return toolResult(core(["run", "resume", params.runId, "--dir", root]));
      }
      if (params.action === "cancel") {
        if (!params.runId || safeId(params.runId, "run-") === null) return failText("run cancel 需要合法 runId");
        return toolResult(core(["run", "cancel", params.runId, "--reason", params.reason ?? "bridge cancel", "--dir", root]));
      }
      if (params.action === "advisory") {
        if (!params.taskId || safeId(params.taskId, "k-") === null) return failText("advisory 需要合法 taskId");
        if (params.mode !== "discuss" && params.mode !== "deliver") return failText("advisory 需要 mode=discuss|deliver");
        const args = ["assist", params.mode, "--task", params.taskId, "--client", "pi", "--native", state.nativeSessionId ?? "", "--dir", root];
        if (provider) args.push("--provider", provider);
        if (modelId) args.push("--model", modelId);
        if (params.wait === true) args.push("--wait");
        return toolResult(core(args));
      }
      if (params.action === "check" && Array.isArray(params.scope) && params.scope.length > 0) {
        const args = ["run", "check", "--scope", ...params.scope, "--dir", root];
        if (provider) args.push("--provider", provider);
        if (modelId) args.push("--model", modelId);
        return toolResult(core(args));
      }
      if (!params.taskId || safeId(params.taskId, "k-") === null) return failText(`${params.action} 需要合法 taskId`);
      const args = ["run", params.action, "--task", params.taskId, "--client", "pi", "--native", state.nativeSessionId ?? "", "--dir", root];
      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (params.resumeSession) args.push("--resume-session", params.resumeSession);
      if (params.newRepairCycle === true) args.push("--new-repair-cycle");
      if (params.wait === true) args.push("--wait");
      return toolResult(core(args));
    },
  });

  pi.registerTool({
    name: "knit_deliver",
    label: "Knit deliver",
    description: "按完整分支与授权来源交付或归档；Agent 必须声明 authorizationRef。",
    parameters: schema("deliver"),
    async execute(_toolCallId: string, params: any) {
      if (safeId(params.taskId, "k-") === null) return failText(`非法 taskId: ${params.taskId}`);
      const args = [params.action, params.taskId, "--branch", params.branch, "--caller", "agent", "--dir", root];
      if (params.authorizationRef) args.push("--authorization-ref", params.authorizationRef);
      if (params.retry === true) args.push("--retry");
      return toolResult(core(args));
    },
  });

  pi.registerTool({
    name: "knit_snapshot",
    label: "Knit snapshot",
    description: "只读对照实施快照；提供 expect 后才按路径恢复，可显式恢复 index 或删除后来新建路径。",
    parameters: schema("snapshot"),
    async execute(_toolCallId: string, params: any) {
      if (safeId(params.runId, "run-") === null) return failText(`非法 runId: ${params.runId}`);
      const args = ["snapshot", params.action, params.runId, "--dir", root];
      if (params.action === "show") {
        if (params.path) args.push("--path", params.path);
        return toolResult(core(args));
      }
      const paths: string[] = Array.isArray(params.paths) ? params.paths : params.path ? [params.path] : [];
      if (paths.length === 0) return failText("snapshot restore 需要 paths");
      for (const path of paths) args.push("--path", path);
      if (params.index === true) args.push("--index");
      if (params.removeCreated === true) args.push("--remove-created");
      if (params.expect && typeof params.expect === "object") {
        for (const [path, fingerprint] of Object.entries(params.expect)) args.push("--expect", `${path}=${String(fingerprint)}`);
      }
      return toolResult(core(args));
    },
  });

  pi.registerTool({
    name: "knit_standards",
    label: "Knit standards",
    description: "规范候选、审阅、采纳与待处理提示。",
    parameters: schema("standards"),
    async execute(_toolCallId: string, params: any) {
      if (params.taskId && safeId(params.taskId, "k-") === null) return failText(`非法 taskId: ${params.taskId}`);
      const args = ["standards", params.action, "--dir", root];
      if (params.taskId) args.push("--task", params.taskId);
      if (params.action === "propose") {
        for (const key of ["title", "problem", "evidence", "scope", "rule", "verification"]) {
          if (params[key]) args.push(`--${key}`, params[key]);
        }
      } else if (params.action === "review") {
        if (!params.decision || !params.reason) return failText("standards review 需要 decision 与 reason");
        args.push("--decision", params.decision, "--reason", params.reason);
        for (const target of [...(params.targets ?? []), ...(params.target ? [params.target] : [])]) args.push("--target", target);
        if (params.candidateId) args.push("--candidate", params.candidateId);
      } else if (params.action === "apply") {
        if (!params.candidateId || !params.target) return failText("standards apply 需要 candidateId 与 target");
        args.push("--candidate", params.candidateId, "--target", params.target);
      }
      return toolResult(core(args));
    },
  });

  return { execKnit, installationReady, state };
}
