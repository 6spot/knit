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

const MANAGED_BASELINE = "__BRIDGE_BASELINE__";
const SELECTION_ENTRY = "knit.selection";
const NOTICE_ENTRY = "knit.notice";
const POLL_MS = 5000;
const OBSERVER_GUARD = Symbol.for("knit.bridge.observer");

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
  const state: any = { ctx: null, knitSessionId: null, nativeSessionId: null, branch: null, timer: null, started: false, verified: false, dev: false };
  // reload／重复加载时先停掉上一个模块实例的轮询和旧上下文，避免多个观察器并发通知。
  const previousObserver = (globalThis as any)[OBSERVER_GUARD];
  if (typeof previousObserver === "function") {
    try { previousObserver(); } catch {}
  }
  const releaseObserver = () => {
    stopObserver();
    if ((globalThis as any)[OBSERVER_GUARD] === releaseObserver) delete (globalThis as any)[OBSERVER_GUARD];
  };
  (globalThis as any)[OBSERVER_GUARD] = releaseObserver;
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

  /** 宿主侧资料路径预检；与核心 normalizeMaterialPath 同规则（任务045/048）。 */
  function safeMaterialPath(path: unknown): string | null {
    if (typeof path !== "string" || path === "") return null;
    const normalized = path.replace(/^\.\//, "").split("\\").join("/");
    if (normalized.includes("\0") || normalized.includes("..")) return null;
    const top = normalized.split("/")[0];
    if (top !== "plan.md" && top !== "design.md" && top !== "research") return null;
    if (top === "research") {
      const rest = normalized.slice("research/".length);
      if (rest === "" || rest.endsWith("/") || !rest.endsWith(".md")) return null;
    } else if (normalized !== top || !normalized.endsWith(".md")) {
      return null;
    }
    return normalized;
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
    const cliArgs = ["--json", ...(state.dev || process.env.KNIT_DEV === "1" ? ["--dev"] : []), ...args];
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

  /**
   * 任务与无任务分支共用的主会话行为引导；同一会话每轮只注入一份，历史查询只在此处出现一次。
   * 注入是行为引导，不替代核心授权、阶段与写动作核对。
   */
  const SESSION_BEHAVIOR_GUIDANCE = [
    "任务选择：是否建任务由用户决定；新事项先问是否建任务再展开需求，不按类型或预估大小跳过；暂不创建可继续讨论，实施前再确认，遗漏选择先补问，不能用“你做吧”代替；明确不创建时同一事项持续有效，不重复追问。",
    "授权边界：创建任务不等于需求确认或实施授权；用户明确“按这个做”可同时确认范围与实施授权，仅认可思路且实施意愿不明时补问；授权不覆盖提交／发布。",
    "规范沉淀：明确长期规则可直接采纳并说明依据，冲突先提决定，未明确内容用 standards propose 存项目候选；正常回复末尾告知内容、适用范围与位置。",
    "历史查询: 用户明确表达查历史、上次决定／处理／修改或追溯问题的意愿时，用 knit_task action=search（或 /knit task search）只读检索并引用 path:line、run ID 或 commit；未表达意愿不主动检索；相关记录不等于因果结论。",
    "交付：实施与检查结果由主会话接收、核对完成条件并汇总报告；提交、推送、发布另行授权。",
    "完整规则见 .knit/workflow.md。",
  ];

  /**
   * 每轮模型调用前注入当前任务上下文（DESIGN §9.6，任务047）。
   * 通过 Pi 公开 before_agent_start 事件 + systemPromptOptions.sections 实现：
   * Pi 对分节做 diff，只追加变更，不堆叠历史正文。注入是行为引导，
   * 所有写动作仍经核心按授权／阶段／锁／版本重新核对。
   */
  function buildTurnContext(ctx: any): { text: string; taskId: string | null } | null {
    const session = sessionOf(ctx);
    if (session === null) return null;
    const resolution = core(["session", "resolve", session.knitSessionId, "--dir", root]);
    const resolvedTaskId = resolution.response?.data?.taskId ?? null;
    const lines: string[] = [];
    let taskId: string | null = null;
    if (typeof resolvedTaskId === "string" && resolvedTaskId !== "") {
      taskId = resolvedTaskId;
      const status = core(["status", taskId, "--dir", root]);
      const data = status.response?.data ?? {};
      const materials = core(["task", "material", "list", taskId, "--dir", root]);
      const materialList: string[] = Array.isArray(materials.response?.data) ? materials.response.data : [];
      const activeRuns: any[] = Array.isArray(data.runs) ? data.runs.filter((run: any) => run.state === "running") : [];
      lines.push(`当前任务: ${taskId}${data.title ? `「${data.title}」` : ""}`);
      lines.push(`阶段: ${data.stage ?? "?"}；状态: ${data.status ?? "?"}${data.outcome ? `；结果: ${data.outcome}` : ""}${data.branch ? `；分支: ${data.branch}` : ""}`);
      if (data.pendingDraft) lines.push(`待应用草案: ${data.pendingDraft.kind ?? "?"}（${data.pendingDraft.digest?.slice(0, 12) ?? ""}）——先应用或撤回再进入后续阶段`);
      if (activeRuns.length > 0) lines.push(`活动运行: ${activeRuns.map((run: any) => `${run.runId}(${run.state ?? "?"})`).join(", ")}——活动运行使用冻结输入`);
      lines.push(`任务入口: .knit/${data.relativePath ?? `tasks/…`}`);
      if (materialList.length > 0) lines.push(`规划资料: ${materialList.map((entry: any) => entry.path).join(", ")}`);
      else lines.push("规划资料: 无（简单任务可只用 task.md）");
      lines.push("下一步: 按 workflow.md 当前阶段推进；写动作由核心核对授权与状态。");
    } else {
      lines.push("当前无选定任务。");
      lines.push("是否建任务由用户决定：普通讨论、问答、只读调查、审阅和非正式小修改直接完成，不因调研、委派或报告落盘强制建任务。");
      lines.push("不建任务时使用宿主工具／通用子 Agent；Knit run 只服务正式任务，不派发无任务 worker。");
      lines.push("用户要求正式跟踪时再提议 task new；已有持续授权可直接创建。正式任务创建时选择 completion verification（none／self／independent，默认 self）。");
      lines.push("建任务前先过澄清门：关键缺口先讨论，需求明确直接登记，Agent 建议须标注待确认，复杂需求先给拆分方案。");
      lines.push("继续或补充已有任务用 task list 查看并按稳定 ID 选择。授权不覆盖提交／发布。");
    }
    lines.push(...SESSION_BEHAVIOR_GUIDANCE);
    return { text: lines.join("\n"), taskId };
  }

  pi.on("before_agent_start", (event: any, ctx: any) => {
    if (state.nativeSessionId !== ctx?.sessionManager?.getSessionId?.()) return;
    if (event.messageType !== "user") return; // 只注入用户发起的轮次；自身通知触发的轮次不叠加。
    try {
      const context = buildTurnContext(ctx);
      const options = event.systemPromptOptions;
      if (options === null || typeof options !== "object" || options.sections === null || typeof options.sections !== "object") {
        if (context === null) diag("inject_unavailable", { reason: installationReady().reason ?? "session attach failed" });
        return;
      }
      if (context === null) {
        delete options.sections.knit;
        return;
      }
      options.sections.knit = `<!-- knit:turn-context -->\n${context.text}`;
    } catch (error) {
      diag("inject_failed", { reason: String(error) });
    }
  });

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
    releaseObserver();
  });

  /** 查询命令的成功 data 转可读文本；失败返回 null 由调用方走错误分支（任务042）。 */
  const describeQuery = (tokens: string[], data: any): string | null => {
    if (data === null || typeof data !== "object") return null;
    const joinOutcome = (entry: any): string => {
      const parent = typeof entry.parent === "string" ? ` · 父:${entry.parent}` : "";
      const children = Array.isArray(entry.children) && entry.children.length > 0
        ? ` · 子任务 ${entry.children.length - (Array.isArray(entry.openChildren) ? entry.openChildren.length : 0)}/${entry.children.length}`
        : "";
      return `  - ${entry.taskId}「${entry.title ?? "无标题"}」${entry.stage ? ` · ${entry.stage}` : ""}${entry.outcome ? ` · ${entry.outcome}` : ""}${entry.archived ? " · 已归档" : ""}${parent}${children}`;
    };
    // task search：命中数组，每项带 kind／path／line／ref／snippet。
    if (tokens[0] === "task" && tokens[1] === "search" && Array.isArray(data)) {
      if (data.length === 0) return "未找到匹配记录。";
      const lines = [`匹配记录（${data.length}）：`];
      for (const hit of data.slice(0, 50)) {
        const location = hit.kind === "run" ? `（${hit.path}${hit.line === null ? "" : `:${hit.line}`}）` : "";
        lines.push(`  - [${hit.kind}] ${hit.ref}${location}${hit.taskId ? ` · ${hit.taskId}` : ""} · ${hit.snippet}`);
      }
      if (data.length > 50) lines.push(`  - …共 ${data.length} 条`);
      return lines.join("\n");
    }
    // task list：{ active: [...], archived: [...] }
    if (Array.isArray(data.active) && Array.isArray(data.archived)) {
      const lines: string[] = [];
      lines.push(`活跃任务（${data.active.length}）：`);
      lines.push(...(data.active.length > 0 ? data.active.map(joinOutcome) : ["  - （无）"]));
      lines.push(`已归档（${data.archived.length}）：`);
      lines.push(...(data.archived.length > 0 ? data.archived.slice(0, 20).map(joinOutcome) : ["  - （无）"]));
      if (data.archived.length > 20) lines.push(`  - …共 ${data.archived.length} 条`);
      return lines.join("\n");
    }
    // 项目概览：{ tasks: [...], activeRuns: [...] }
    if (Array.isArray(data.tasks)) {
      const runs = Array.isArray(data.activeRuns) ? data.activeRuns : [];
      const lines = [`任务（${data.tasks.length}）：`];
      lines.push(...(data.tasks.length > 0 ? data.tasks.map((entry: any) => joinOutcome({ ...entry, archived: entry.archived === true })) : ["  - （无）"]));
      lines.push(`活跃运行（${runs.length}）：`);
      lines.push(...(runs.length > 0 ? runs.map((run: any) => `  - ${run.runId} · ${run.phase ?? "?"} · ${run.state ?? "?"}`) : ["  - （无）"]));
      return lines.join("\n");
    }
    // 按任务查询（仅 status <taskId>）：{ taskId, title, stage, status, runs, ... }（任务042）。
    if (tokens[0] === "status" && tokens.length >= 2 && typeof data.taskId === "string") {
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const lines = [
        `${data.taskId}「${data.title ?? "无标题"}」`,
        `  状态: ${data.status ?? "?"} · 阶段: ${data.stage ?? "?"}${data.outcome ? ` · 结果: ${data.outcome}` : ""}${data.archived ? " · 已归档" : ""}${data.branch ? ` · 分支: ${data.branch}` : ""}`,
      ];
      if (data.parent) lines.push(`  父任务: ${data.parent}`);
      if (Array.isArray(data.children) && data.children.length > 0) {
        const open = data.children.filter((child: any) => child.status === "open").length;
        lines.push(`  子任务（${data.children.length - open}/${data.children.length} 已结束）：${data.children.map((child: any) => `${child.taskId}[${child.status}${child.outcome ? `/${child.outcome}` : ""}]`).join(", ")}`);
      }
      if (data.pendingDraft) lines.push(`  待应用草案: ${data.pendingDraft.kind ?? "?"}`);
      lines.push(`  运行（${runs.length}）：`);
      lines.push(...(runs.length > 0 ? runs.map((run: any) => `  - ${run.runId} · ${run.phase ?? "?"} · ${run.state ?? "?"}${run.reason ? ` · ${run.reason}` : ""}`) : ["  - （无）"]));
      return lines.join("\n");
    }
    // 其它对象：键值摘要，不混入诊断。
    if (tokens[0] !== undefined) {
      const entries = Object.entries(data).slice(0, 12);
      if (entries.length > 0) return entries.map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("\n");
    }
    return null;
  };

  pi.registerCommand("knit-status", {
    description: "Knit：查看任务与运行状态",
    handler: async (args: string, ctx: any) => {
      const result = core(["status", ...(args.trim() === "" ? [] : args.trim().split(/\s+/)), "--dir", root]);
      const data = result.response?.data;
      const readable = result.code === 0 && result.response?.outcome === "completed" ? describeQuery(["status"], data) : null;
      if (readable !== null) {
        ctx.ui.notify(readable, "info");
        return;
      }
      const text = result.error ?? result.response?.data?.error ?? result.response?.reasonCode ?? result.stderr;
      ctx.ui.notify(text ? String(text) : "knit status 无输出", result.code === 0 ? "info" : "warning");
    },
  });

  pi.registerCommand("knit-reload", {
    description: "Knit：重新加载项目配置、安装映射与桥接",
    handler: async (_args: string, ctx: any) => {
      releaseObserver();
      const result = core(["doctor", "--dir", root]);
      ctx.ui.notify(result.code === 0 ? "Knit 已重新核对安装与配置" : "Knit 诊断发现需处理项", result.code === 0 ? "info" : "warning");
      try {
        await ctx.reload();
      } catch (error) {
        diag("reload_failed", { reason: String(error) });
      }
    },
  });

  pi.registerCommand("knit-dev", {
    description: "Knit：当前会话开关开发者诊断（不影响已启动 worker）",
    handler: async (args: string, ctx: any) => {
      const action = args.trim().toLowerCase();
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("用法: /knit dev on|off", "warning");
        return;
      }
      state.dev = action === "on";
      ctx.ui.notify(`Knit 开发者诊断: ${state.dev ? "on" : "off"}（当前会话；reload 后关闭）`, "info");
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
      if (tokens[0] === "dev") {
        const action = (tokens[1] ?? "").toLowerCase();
        if (action !== "on" && action !== "off") {
          ctx.ui.notify("用法：/knit dev on|off", "warning");
          return;
        }
        state.dev = action === "on";
        ctx.ui.notify(`Knit 开发者诊断: ${state.dev ? "on" : "off"}（当前会话；reload 后关闭）`, "info");
        return;
      }
      const result = core([...tokens, "--dir", root]);
      const data = result.response?.data;
      const readable = result.code === 0 && result.response?.outcome === "completed" ? describeQuery(tokens, data) : null;
      if (readable !== null) {
        ctx.ui.notify(readable, "info");
        return;
      }
      const text = result.error ?? result.response?.data?.error ?? result.response?.reasonCode ?? result.stderr;
      ctx.ui.notify(text ? String(text) : "Knit 命令已完成", result.code === 0 ? "info" : "warning");
    },
  });

  // 工具参数直接使用安装包内生成的纯 JSON Schema；未知工具名退回空对象 schema。
  const schema = (name: string) => (schemas && schemas[name] ? schemas[name] : { type: "object" });

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

  /** 当前主会话已选择且不同于给定任务时返回其 ID，否则 null（任务048 防重复创建引导）。 */
  async function selectionReminder(ctx: any, createdTaskId: string): Promise<string | null> {
    const session = sessionOf(ctx);
    if (session === null) return null;
    const resolution = core(["session", "resolve", session.knitSessionId, "--dir", root]);
    const current = resolution.response?.data?.taskId;
    return typeof current === "string" && current !== "" && current !== createdTaskId ? current : null;
  }

  pi.registerTool({
    name: "knit_material",
    label: "Knit materials",
    description:
      "任务规划资料（plan.md／design.md／research/）。action=list/read/save/delete。保存是进度与方案更新的入口；" +
      "要求性内容（目标、条件、范围、验收）变化必须改用 knit_task action=update --kind，不能只改计划文件。",
    parameters: schema("material"),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      if (safeId(params.taskId, "k-") === null) return failText("material 需要合法 taskId");
      if (params.action !== "list" && safeMaterialPath(params.path) === null) return failText(`非法资料路径: ${params.path}`);
      const args = ["task", "material", params.action, params.taskId];
      if (params.action !== "list") args.push(params.path);
      if (params.action === "save") {
        if (typeof params.content !== "string") return failText("material save 需要 content");
        if (params.expectDigest !== undefined) args.push("--expect-digest", params.expectDigest);
      }
      args.push("--dir", root);
      return toolResult(core(args, params.action === "save" ? params.content : undefined));
    },
  });

  pi.registerTool({
    name: "knit_task",
    label: "Knit task",
    description: "任务身份、输入草案、验证要求、优先级／依赖／业务顺序、稳定执行顺序、历史检索、记录、关闭与当前会话选择；是否建任务由用户决定，普通问答与只读调查不需要建任务。",
    parameters: schema("task"),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      // 历史检索不需要 taskId，也不写任务状态。
      if (params.action === "search") {
        const rawQuery = Array.isArray(params.query) ? params.query : typeof params.query === "string" ? [params.query] : [];
        const terms = rawQuery.map((value: unknown) => String(value).trim()).filter((value: string) => value !== "");
        if (terms.length === 0) return failText("task search 需要至少一个查询词");
        const args = ["task", "search", ...terms];
        if (params.scope) args.push("--scope", params.scope);
        if (params.limit !== undefined) args.push("--limit", String(params.limit));
        args.push("--dir", root);
        return toolResult(core(args));
      }
      // task next 不读 taskId；只有真正的任务操作才校验它。
      if (params.action !== "next" && params.taskId && safeId(params.taskId, "k-") === null) return failText(`非法 taskId: ${params.taskId}`);
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
      if (params.action === "new") {
        // 创建后若当前会话已有其他任务选择，附加防重复引导；不自动切换（任务048）。
        const args = ["task", "new"];
        if (params.title) args.push("--title", params.title);
        if (params.slug) args.push("--slug", params.slug);
        if (params.branch) args.push("--branch", params.branch);
        if (params.verification) args.push("--verification", params.verification);
        if (params.priority) args.push("--priority", params.priority);
        if (Array.isArray(params.dependsOn) && params.dependsOn.length > 0) {
          const ids = params.dependsOn.map((id: string) => safeId(id, "k-"));
          if (ids.some((id: string | null) => id === null)) return failText(`非法依赖任务 ID: ${params.dependsOn.join(", ")}`);
          args.push("--depends-on", ids.join(","));
        }
        if (params.parentId) {
          const parentId = safeId(params.parentId, "k-");
          if (parentId === null) return failText(`非法父任务 ID: ${params.parentId}`);
          args.push("--parent", parentId);
        }
        args.push("--dir", root);
        const created = core(args);
        if (created.code === 0 && created.response?.data?.taskId) {
          const reminder = await selectionReminder(ctx, created.response.data.taskId);
          if (reminder !== null) {
            const text = `已创建 ${created.response.data.taskId}。注意：当前会话已选择任务 ${reminder}，新任务未自动选择；确认要切换时用 task use。`;
            return { isError: false, content: [{ type: "text", text }], details: created.response.data };
          }
        }
        return toolResult(created);
      }
      const args = ["task", params.action];
      // task next 是项目级只读视图，不接受任务参数；忽略误传的 taskId。
      if (params.taskId && params.action !== "next") args.push(params.taskId);
      if (params.action === "rename") {
        if (!params.newSlug) return failText("task rename 需要 newSlug");
        args.push(params.newSlug);
        if (params.nonEquivalent === true) args.push("--non-equivalent");
      } else if (params.action === "parent") {
        if (params.detach === true) args.push("--detach");
        else if (params.parentId) {
          const parentId = safeId(params.parentId, "k-");
          if (parentId === null) return failText(`非法父任务 ID: ${params.parentId}`);
          args.push(parentId);
        } else return failText("task parent 需要 parentId，或用 detach 解除关联");
      } else if (params.action === "priority") {
        if (!params.priority) return failText("task priority 需要 priority（P0–P3）");
        args.push(params.priority);
      } else if (params.action === "depends") {
        const ids = (values: unknown): string[] | null => {
          if (values === undefined) return [];
          if (!Array.isArray(values)) return null;
          const out: string[] = [];
          for (const value of values) {
            const id = safeId(String(value), "k-");
            if (id === null) return null;
            out.push(id);
          }
          return out;
        };
        const add = ids(params.dependsOn);
        const remove = ids(params.removeDependsOn);
        const set = ids(params.setDependsOn);
        if (add === null || remove === null || set === null) return failText("task depends 含非法依赖任务 ID");
        const clear = params.clearDependsOn === true || (Array.isArray(params.setDependsOn) && params.setDependsOn.length === 0);
        if (add.length === 0 && remove.length === 0 && set.length === 0 && !clear) return failText("task depends 需要 dependsOn／removeDependsOn／setDependsOn／clearDependsOn");
        if (clear) args.push("--clear");
        else if (set.length > 0) args.push("--set", set.join(","));
        if (add.length > 0) args.push("--add", add.join(","));
        if (remove.length > 0) args.push("--remove", remove.join(","));
      } else if (params.action === "order") {
        const before = params.beforeId === undefined ? null : safeId(params.beforeId, "k-");
        const after = params.afterId === undefined ? null : safeId(params.afterId, "k-");
        if ((params.beforeId !== undefined && before === null) || (params.afterId !== undefined && after === null)) return failText("task order 参照任务 ID 非法");
        if (before !== null) args.push("--before", before);
        else if (after !== null) args.push("--after", after);
        else if (params.position === "top") args.push("--top");
        else if (params.position === "bottom") args.push("--bottom");
        else return failText("task order 需要 beforeId／afterId／position=top|bottom");
      } else if (params.action === "adopt") {
        args.push("--branch", params.branch ?? "current");
      } else if (params.action === "verification") {
        if (!params.verification) return failText("task verification 需要 verification");
        args.push("--mode", params.verification);
        if (params.reason) args.push("--reason", params.reason);
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
        if (params.reason) args.push("--reason", params.reason);
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
    description: "派发正式任务的实施／独立检查／讨论建议（assist discuss），查询、恢复或取消 run；无任务直接执行或使用宿主委派，不派发 Knit worker。",
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
        if (params.mode !== "discuss") return failText("advisory 仅支持 mode=discuss；交付由主会话协调 knit_deliver");
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
    description: "按完整分支与授权来源交付、预检或归档；支持多个已完成任务逐项收尾。Agent 交付必须声明 authorizationRef。",
    parameters: schema("deliver"),
    async execute(_toolCallId: string, params: any) {
      const ids: string[] = Array.isArray(params.taskIds) && params.taskIds.length > 0
        ? params.taskIds
        : params.taskId ? [params.taskId] : [];
      if (ids.length === 0) return failText("deliver 需要 taskId 或 taskIds");
      if (params.action === "archive" && ids.length !== 1) return failText("archive 一次只能处理一个任务");
      for (const id of ids) if (safeId(id, "k-") === null) return failText(`非法 taskId: ${id}`);
      const command = params.action === "plan" ? "deliver" : params.action;
      const args = [command, ...ids, "--branch", params.branch, "--caller", "agent", "--dir", root];
      if (params.action === "plan") args.push("--plan");
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
      if (params.taskId && params.action !== "migrate") args.push("--task", params.taskId);
      if (params.action === "propose") {
        for (const key of ["source", "title", "problem", "evidence", "scope", "rule", "verification"]) {
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
