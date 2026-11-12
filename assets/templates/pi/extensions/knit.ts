/**
 * Knit 项目薄桥接（Knit init 生成，模板随安装包发布）。
 * 仅使用 Pi 公开 Extension API：转交原生会话、命令与工具；业务处理调用本机 Knit CLI。
 * 本文件可入库；本机安装映射在 .knit/.runtime/installation.json，不写进本文件。
 * 只有本机清单 ready 且映射匹配时桥接才处理调用；缺失或不匹配则提示重新 init。
 *
 * 所有 Knit CLI 调用都异步执行（spawn + Promise），不阻塞 Pi 主线程：
 * 工具 execute 透传 signal，可随用户中止结束等待；每轮上下文只调一次 CLI，超过预算用上一轮缓存并标注。
 */
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANAGED_BASELINE = "__BRIDGE_BASELINE__";
const SELECTION_ENTRY = "knit.selection";
const NO_CURRENT_TASK = "未选择任务：请提供 taskId，或先用 knit_task action=use 选择当前任务";
const NOTICE_ENTRY = "knit.notice";
const POLL_MS = 5000;
const IDLE_POLL_MS = 30_000;
const OBSERVER_GUARD = Symbol.for("knit.bridge.observer");
/** 每轮上下文预算：有上一轮缓存时超过即用缓存（k-0524fc52e81b 用户决定：不阻塞等待）。 */
const CONTEXT_TIMEOUT_MS = 300;
/** 续接会话首轮没有可回退缓存时的等待上限：CLI 冷启动实测约 0.6s，留足余量。 */
const CONTEXT_FIRST_TIMEOUT_MS = 2_000;
/** 预热与工具动作后的刷新预算：不在模型轮次关键路径上，允许等待 CLI 完成。 */
const CONTEXT_REFRESH_TIMEOUT_MS = 10_000;
/** 注入分节标记与降级说明：Pi 按分节 diff 持久化，失败时不重设等于删除。 */
const TURN_CONTEXT_MARKER = "<!-- knit:turn-context -->";
const CONTEXT_STALE_PREFIX = "上下文可能过期：";
/** 共享请求超过本次预算的哨兵：底层请求继续跑完并写缓存，只让当前轮不阻塞。 */
const CONTEXT_DEADLINE = Symbol("knit.context.deadline");
const WAIT_LIMIT_MS = 180_000;
const WAIT_POLL_MS = 1000;
const CLI_TIMEOUT_MS = 180_000;
const ATTACH_TIMEOUT_MS = 20_000;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
  /** 调用方 signal 中止（不含 Knit run 自身的取消）。 */
  aborted?: boolean;
  /** 超过本次调用预算被终止。 */
  timedOut?: boolean;
}

interface CoreResult extends ExecResult {
  response: any;
}

interface SessionRef {
  knitSessionId: string;
  nativeSessionId: string;
}

interface ContextCacheEntry {
  knitSessionId: string;
  nativeSessionId: string;
  text: string;
  taskId: string | null;
  at: number;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function digestFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
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

/**
 * 异步子进程：收集 stdout／stderr，支持 stdin、超时与 AbortSignal。
 * 超时或中止只结束本次调用（CLI 自身可能继续落盘，但工具结果如实标注中止）。
 */
function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const signal = options.signal ?? undefined;
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: "", error: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    let aborted = false;
    let timedOut = false;
    let timeoutTimer: any = null;
    let killTimer: any = null;
    const finish = (result: ExecResult): void => {
      if (done) return;
      done = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    const terminate = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    child.stdout?.on("data", (chunk: any) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: any) => {
      stderr += String(chunk);
    });
    child.on("error", (error: any) => finish({ code: 1, stdout, stderr, error: String(error) }));
    child.on("close", (code: number | null, signalName: string | null) => {
      if (aborted) finish({ code: code ?? 1, stdout, stderr, error: "aborted", aborted: true });
      else if (timedOut) finish({ code: code ?? 1, stdout, stderr, error: `timeout after ${options.timeout}ms`, timedOut: true });
      else if (signalName !== null) finish({ code: code ?? 1, stdout, stderr, error: `terminated by ${signalName}` });
      else finish({ code: code ?? 1, stdout, stderr });
    });
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeout);
    }
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let settled = false;
    let timer: any = null;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function terminalState(state: unknown): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/**
 * 在共享请求上等本次预算：超时返回哨兵，不终止底层请求（预热继续完成并写缓存）。
 * 调用方只据此决定本轮是否回退，不能把超时当成请求失败。
 */
function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof CONTEXT_DEADLINE> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: any = null;
    const finish = (value: T | typeof CONTEXT_DEADLINE): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(CONTEXT_DEADLINE), ms);
    promise.then(
      (value) => finish(value),
      () => finish(CONTEXT_DEADLINE),
    );
  });
}

/** 每轮预算：显式环境覆盖优先；无可回退缓存等冷启动（续接会话首轮），否则 300ms 不阻塞。 */
function contextTimeoutMs(hasCache: boolean): number {
  const raw = Number(process.env.KNIT_BRIDGE_CONTEXT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return hasCache ? CONTEXT_TIMEOUT_MS : CONTEXT_FIRST_TIMEOUT_MS;
}

export default async function (pi: any) {
  const root = projectRootFromExtension();
  const toolSignal = new AsyncLocalStorage<AbortSignal | undefined>();
  const state: any = {
    ctx: null,
    knitSessionId: null,
    nativeSessionId: null,
    branch: null,
    timer: null,
    started: false,
    verified: false,
    dev: false,
    sessionWork: null,
    scanChain: Promise.resolve(),
    lastScanActive: true,
    lastScanAt: null,
    contextCache: null,
    contextWork: null,
    contextGeneration: 0,
    versionNoticed: false,
  };
  // reload／重复加载时先停掉上一个模块实例的轮询和旧上下文，避免多个观察器并发通知。
  const previousObserver = (globalThis as any)[OBSERVER_GUARD];
  if (typeof previousObserver === "function") {
    try { previousObserver(); } catch {}
  }
  const releaseObserver = () => {
    invalidateTurnContext();
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

  /**
   * 读取当前生效流程的阶段 id 与显示名，供桥接 schema 与文本派生。
   * 配置不可读或已降级时返回 null：schema 保留字符串参数，由核心返回合法阶段清单。
   * 工厂函数由宿主 await，这里的 CLI 调用异步执行，不阻塞 Pi 主线程。
   */
  async function readConfiguredWorkflow(): Promise<{ ids: string[]; names: Record<string, string> } | null> {
    const installation = readJson(join(root, ".knit", ".runtime", "installation.json"));
    if (typeof installation?.cliEntry !== "string" || !existsSync(installation.cliEntry)) return null;
    const result = await runProcess(process.execPath, [installation.cliEntry, "--json", "workflow", "show", "--dir", root], {
      cwd: root,
      timeout: ATTACH_TIMEOUT_MS,
      env: { ...process.env, KNIT_BRIDGE_BASELINE: MANAGED_BASELINE },
    });
    if (result.code !== 0 || result.stdout.trim() === "") return null;
    let response: any;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    const data = response?.data;
    if (response?.outcome !== "completed" || data?.mode !== "config" || data?.validation?.ok !== true) return null;
    const stages = Array.isArray(data?.workflow?.stages) ? data.workflow.stages : [];
    const ids = stages.map((stage: any) => stage?.id).filter((id: any) => typeof id === "string" && id !== "");
    const names: Record<string, string> = {};
    for (const stage of stages) {
      if (typeof stage?.id !== "string" || stage.id === "") continue;
      names[stage.id] = typeof stage.name === "string" && stage.name !== "" ? stage.name : stage.id;
    }
    return ids.length > 0 ? { ids, names } : null;
  }
  const configuredWorkflow = await readConfiguredWorkflow();
  const configuredStages = configuredWorkflow?.ids ?? null;

  /** 阶段显示名：优先当前生效流程，缺锚点用内置名，再退回 id。 */
  function stageNameOf(stage: string): string {
    return configuredWorkflow?.names[stage] ?? ({ start: "准备", deliver: "收尾" } as Record<string, string>)[stage] ?? stage;
  }

  /** 短 ID：类型前缀 + 前 6 位（k-8ed2d4、run-f991c4）。 */
  function shortId(value: string): string {
    const dash = value.indexOf("-");
    if (dash === -1) return value;
    return `${value.slice(0, dash + 1)}${value.slice(dash + 1, dash + 7)}`;
  }

  /** 人读标题上限 20 字，超出加省略号；JSON 保留全文。 */
  function truncateTitle(value: string): string {
    const chars = Array.from(value);
    return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : value;
  }

  function titleOf(data: any): string | null {
    for (const key of ["taskTitle", "title"]) {
      if (typeof data?.[key] === "string" && data[key].trim() !== "") return data[key].trim();
    }
    return null;
  }

  /** 任务称呼：标题优先，缺失退 slug，再缺退短 ID。 */
  function taskName(data: any, fallbackTaskId?: string): string {
    const title = titleOf(data);
    if (title !== null) return `「${truncateTitle(title)}」`;
    if (typeof data?.taskSlug === "string" && data.taskSlug !== "") return data.taskSlug;
    return shortId(typeof data?.taskId === "string" ? data.taskId : fallbackTaskId ?? "");
  }

  /** 标题／slug 后附短任务 ID；已经退回短 ID 时不重复。 */
  function taskLabel(data: any, fallbackTaskId?: string): string {
    const name = taskName(data, fallbackTaskId);
    const taskId = shortId(typeof data?.taskId === "string" ? data.taskId : fallbackTaskId ?? "");
    if (name === taskId) return taskId;
    return titleOf(data) !== null ? `${name}${taskId}` : `${name}（${taskId}）`;
  }

  /** 阶段展示：显示名与 id 不同时并列。 */
  function stageText(name: unknown, id: string, style: "space" | "paren"): string {
    const label = typeof name === "string" && name !== "" ? name : id;
    if (label === id) return id;
    return style === "space" ? `${label} ${id}` : `${label}（${id}）`;
  }

  function currentTaskText(data: any, taskId: string): string {
    const name = taskName(data, taskId);
    const short = shortId(taskId);
    return name === short ? short : `${name}（${short}）`;
  }

  function stageEnum(values: string[]): any {
    return { anyOf: values.map((value) => ({ const: value })) };
  }

  /** 派生桥接参数 schema：阶段动作与 context 目标来自配置；读取失败时保留字符串。 */
  function schemaOf(name: string): any {
    const base = schemas && schemas[name] ? JSON.parse(JSON.stringify(schemas[name])) : { type: "object" };
    if (configuredStages === null) return base;
    if (name === "run" && base.properties?.action) {
      base.properties.action = stageEnum([...configuredStages, "status", "list", "resume", "cancel", "accept"]);
    }
    if (name === "context" && base.properties?.stage) {
      base.properties.stage = stageEnum(["start", ...configuredStages, "deliver"]);
    }
    return base;
  }

  function diag(event: string, fields: any = {}): void {
    if (process.env.KNIT_DEV !== "1") return;
    const allowed: any = { type: "knit.bridge.diag", event };
    for (const key of ["runId", "taskId", "phase", "state", "reason", "session", "code", "installedVersion", "repoVersion", "digest"]) {
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

  /**
   * 安装 CLI 与实际仓库的一致性（与 doctor installation-version 同口径）：
   * 版本来自入口包 package.json／installation.json，摘要对照本地 dist；
   * Knit 自身仓库里桥接指向仓库外安装是最常见的“用错版本”，提示改用本地 dist。
   */
  function cliVersionFacts(): { installedVersion: string | null; repoVersion: string | null; localDigest: string | null; notice: string | null } {
    const runtime = readJson(join(root, ".knit", ".runtime", "installation.json"));
    const cliEntry = typeof runtime?.cliEntry === "string" ? runtime.cliEntry : null;
    const entryPackage = cliEntry === null ? null : readJson(join(dirname(cliEntry), "..", "package.json"));
    const installedVersion =
      typeof entryPackage?.version === "string"
        ? entryPackage.version
        : typeof runtime?.packageVersion === "string"
          ? runtime.packageVersion
          : null;
    const repoPackage = readJson(join(root, "package.json"));
    const repoVersion = typeof repoPackage?.version === "string" ? repoPackage.version : null;
    const localDist = join(root, "dist", "cli", "knit.js");
    const localDigest = existsSync(localDist) ? digestFile(localDist) : null;
    const entryDigest = cliEntry !== null && existsSync(cliEntry) ? digestFile(cliEntry) : null;
    const insideRoot = cliEntry !== null && (cliEntry === root || cliEntry.startsWith(`${root}/`));
    const knitRepo =
      repoVersion !== null && (repoPackage?.name === "knit" || existsSync(join(root, "src", "cli", "knit.ts")));
    const problems: string[] = [];
    // 只有当前仓库是 Knit 自身时才有“期望版本”：普通项目自己的 package.json 与 Knit 版本无关。
    if (knitRepo) {
      if (installedVersion !== null && installedVersion !== repoVersion) {
        problems.push(`安装 CLI ${installedVersion} 与仓库 ${repoVersion} 版本不一致`);
      }
      if (localDigest !== null && entryDigest !== null && localDigest !== entryDigest) {
        problems.push(`安装 CLI 摘要 ${entryDigest.slice(0, 12)} 与本地 dist ${localDigest.slice(0, 12)} 不一致`);
      }
      if (localDigest === null) problems.push("当前是 Knit 自身仓库但没有本地 dist 构建");
      if (insideRoot !== true) problems.push(`当前是 Knit 自身仓库，桥接指向仓库外的安装 ${cliEntry ?? "?"}`);
    }
    const notice =
      problems.length === 0
        ? null
        : `${problems.join("；")}；改用本地 dist：npm run build 后 node dist/cli/knit.js init --force`;
    return { installedVersion, repoVersion, localDigest, notice };
  }
  const versionFacts = cliVersionFacts();
  diag("cli_version", {
    installedVersion: versionFacts.installedVersion,
    repoVersion: versionFacts.repoVersion,
    digest: versionFacts.localDigest?.slice(0, 12) ?? null,
    reason: versionFacts.notice ?? "consistent",
  });

  async function execKnit(args: string[], stdin?: string, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const check = installationReady();
    if (!check.ready) return { code: 1, stdout: "", stderr: "", error: check.reason };
    const cliArgs = ["--json", ...(state.dev || process.env.KNIT_DEV === "1" ? ["--dev"] : []), ...args];
    const signal = options.signal ?? toolSignal.getStore() ?? undefined;
    return runProcess(process.execPath, [check.runtime!.cliEntry, ...cliArgs], {
      cwd: root,
      input: stdin,
      timeout: options.timeout ?? CLI_TIMEOUT_MS,
      signal,
      env: { ...process.env, KNIT_BRIDGE_BASELINE: MANAGED_BASELINE },
    });
  }

  async function core(args: string[], stdin?: string, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<CoreResult> {
    const result = await execKnit(args, stdin, options);
    if (result.error !== undefined) {
      return { ...result, response: null };
    }
    let response: any = null;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      return {
        ...result,
        response: null,
        error: result.stdout.trim().slice(0, 500) || "Knit 返回非 JSON",
      };
    }
    // 只在成功的相关写动作后失效；只读查询仍可与预热共享请求。
    if (result.code === 0 && response?.outcome === "completed" && changesTurnContext(args)) invalidateTurnContext();
    return { ...result, response };
  }

  function changesTurnContext(args: string[]): boolean {
    const [command, action, subaction] = args;
    if (command === "task") {
      if (action === "material") return subaction === "save" || subaction === "delete";
      return ["new", "use", "clear", "rename", "parent", "priority", "depends", "verification", "update", "ready", "record", "rebind", "implement", "close", "order", "adopt"].includes(action);
    }
    if (command === "run") return ["prepare", "start", "resume", "cancel", "accept"].includes(action);
    if (command === "workflow") return action !== "show" && action !== "validate";
    if (command === "standards") return action === "apply" || action === "migrate";
    if (command === "deliver") return !args.includes("--plan");
    return ["archive", "cancel", "supersede"].includes(command);
  }

  /** 只丢弃可共享请求，保留成功缓存供明确标注过期的降级使用。 */
  function invalidateTurnContext(): void {
    state.contextGeneration += 1;
    state.contextWork = null;
  }

  function toolResult(
    result: { code: number; response: any; stderr: string; error?: string },
    formatter?: (data: any) => string | null,
  ) {
    const ok = result.error === undefined && result.code === 0 && result.response?.outcome === "completed";
    const data = result.response?.data ?? null;
    const readable = ok && formatter !== undefined ? formatter(data) : null;
    const text = result.error ?? (result.response === null ? result.stderr : readable ?? JSON.stringify(result.response));
    return {
      isError: !ok,
      content: [{ type: "text", text: text || (ok ? "{}" : "Knit 调用失败") }],
      details: data,
    };
  }

  /** 用户类授权引用：与核心 resolveAuthorization 同口径，项目策略来源（workflow:／含 #／.knit/ 开头／.md 结尾）以外均是。 */
  function userTypeAuthorizationRef(ref: string): boolean {
    const value = ref.trim();
    if (value === "") return false;
    if (value.startsWith("user:") || value.startsWith("native:") || value.startsWith("message:")) return true;
    return !(value.startsWith("workflow:") || value.includes("#") || value.startsWith(".knit/") || value.endsWith(".md"));
  }

  function failText(message: string) {
    return { isError: true, content: [{ type: "text", text: message }], details: null };
  }

  /** 核心推导的任务级确定性下一步（status／context 的 nextAction）转可读行；缺失返回空。 */
  function nextActionLines(next: any): string[] {
    if (next === null || typeof next !== "object" || typeof next.summary !== "string") return [];
    const commands: string[] = Array.isArray(next.commands) ? next.commands.filter((command: unknown) => typeof command === "string") : [];
    return [`下一步（${next.kind ?? "?"}）: ${next.summary}`, ...commands.map((command) => `  ${command}`)];
  }

  function safeId(value: unknown, prefix: string): string | null {
    if (typeof value !== "string") return null;
    return new RegExp(`^${prefix}[0-9a-z-]+$`).test(value) ? value : null;
  }

  function safeStageId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : null;
  }

  async function branchNow(): Promise<string | null> {
    const result = await runProcess("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: root });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /**
   * 登记并核实当前主会话；同一原生会话并发调用复用同一个 Promise，避免重复 attach。
   * session_start 与 before_agent_start 可能同时在途。
   */
  async function attachSession(ctx: any, nativeId: string): Promise<SessionRef | null> {
    if (state.nativeSessionId !== nativeId) {
      invalidateTurnContext();
      state.contextCache = null;
      state.nativeSessionId = nativeId;
      state.knitSessionId = null;
      state.verified = false;
      state.ctx = ctx;
      state.branch = await branchNow();
      const attachArgs = ["session", "attach", "--native", nativeId, "--kind", "main", "--role", "implement"];
      if (state.branch !== null) attachArgs.push("--branch", state.branch);
      const sessionFile = typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
      if (typeof sessionFile === "string") attachArgs.push("--file", sessionFile);
      attachArgs.push("--dir", root);
      const attached = await core(attachArgs, undefined, { timeout: ATTACH_TIMEOUT_MS });
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
      const verified = await core(verifyArgs, undefined, { timeout: ATTACH_TIMEOUT_MS });
      if (verified.code === 0 && verified.response?.data?.status === "available") state.verified = true;
    }
    return { knitSessionId: state.knitSessionId, nativeSessionId: nativeId };
  }

  function sessionOf(ctx: any): Promise<SessionRef | null> {
    const nativeId = ctx?.sessionManager?.getSessionId?.();
    if (typeof nativeId !== "string") return Promise.resolve(null);
    const pending = state.sessionWork;
    if (pending !== null && pending.nativeSessionId === nativeId) return pending.promise;
    const promise = attachSession(ctx, nativeId).finally(() => {
      if (state.sessionWork !== null && state.sessionWork.promise === promise) state.sessionWork = null;
    });
    state.sessionWork = { nativeSessionId: nativeId, promise };
    return promise;
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

  async function restoreSelection(ctx: any): Promise<void> {
    const session = await sessionOf(ctx);
    if (session === null) return;
    const entry = activeSelection(ctx);
    if (entry === null) return;
    const data = entry.data ?? {};
    const operationId = typeof data.operationId === "string" ? data.operationId : undefined;
    if (data.taskId === null || data.taskId === undefined) {
      await core(["task", "clear", "--session", session.knitSessionId, "--entry", entry.id, "--persisted", "--operation-id", operationId ?? "restore-clear", "--dir", root], undefined, { timeout: ATTACH_TIMEOUT_MS });
    } else {
      await core([
        "task", "use", data.taskId, "--session", session.knitSessionId, "--entry", entry.id, "--persisted",
        "--operation-id", operationId ?? "restore-use", "--branch", data.branch ?? state.branch ?? "", "--dir", root,
      ], undefined, { timeout: ATTACH_TIMEOUT_MS });
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

  /**
   * 一次 run list --active --with-status 观察本会话的 run；串行执行、不重入。
   * 返回是否有本会话尚未到终态的 run（用于 5s／30s 退避）。
   */
  async function scanRuns(ctx: any): Promise<boolean> {
    if (ctx?.sessionManager?.getSessionId?.() !== state.nativeSessionId) {
      stopObserver();
      return false;
    }
    state.ctx = ctx;
    if (state.verified !== true) await sessionOf(ctx);
    // --since：已接收的完成 run 只保留上次扫描之后出结果的，避免反复重算历史 run，
    // 同时保留“首次观察时已收敛”的被动通知（DESIGN §9.3）。
    const scanStartedAt = Date.now();
    const sinceAt = typeof state.lastScanAt === "number" ? state.lastScanAt : scanStartedAt - 60_000;
    const since = new Date(sinceAt).toISOString();
    const list = await core(["run", "list", "--active", "--with-status", "--since", since, "--dir", root]);
    const runs = list.code === 0 && Array.isArray(list.response?.data) ? list.response.data : null;
    // 查询失败不推进扫描时间：下一次仍从原时间点查，不漏掉这段时间内出结果的 run。
    if (runs === null) return state.lastScanActive === true;
    state.lastScanAt = scanStartedAt;
    let active = false;
    let currentBranch: string | null | undefined;
    for (const view of runs) {
      if (view?.initiator?.nativeSessionId !== state.nativeSessionId) continue;
      const resultState = view.result?.state ?? null;
      const noticeState = resultState ?? view.state;
      if (!terminalState(noticeState)) {
        active = true;
        continue;
      }
      // 失败、取消或结果待接收才需要处理；完成且已接收的通知只进入下一轮上下文（DESIGN §9.3）。
      const acceptanceState = view.acceptance?.state ?? null;
      const needsAction = noticeState === "failed" || noticeState === "cancelled" || (noticeState === "completed" && acceptanceState !== "completed");
      if (currentBranch === undefined) currentBranch = await branchNow();
      if (typeof view.branch === "string" && currentBranch !== null && view.branch !== currentBranch) {
        diag("notice_skipped_branch", { runId: view.runId, branch: view.branch });
        continue;
      }
      const signature = `${view.runId}:${noticeState}`;
      if (notified(ctx).has(signature)) continue;
      const pending = resultState === "completed" && acceptanceState !== "completed";
      const stage = typeof view.stageName === "string" && view.stageName !== "" ? view.stageName : view.phase;
      const shortRunId = shortId(view.runId);
      const outcome = view.result?.report?.verdict ?? resultState ?? view.state;
      const base = pending
        ? `${taskName(view)}${stage}：${shortRunId} 已完成，结果待同步；下一步：knit status --run ${view.runId}（不要重复实施）`
        : `${taskName(view)}${stage}：${shortRunId} ${outcome}；下一步：knit status --run ${view.runId} 查看，或 resume。`;
      const text = [base, ...boundaryNotes(view.result), ...(typeof view.noOutputNotice === "string" ? [view.noOutputNotice] : [])].join("\n");
      try {
        pi.sendMessage(
          { customType: NOTICE_ENTRY, content: text, display: true, details: { runId: view.runId, state: noticeState, acceptance: acceptanceState, signature } },
          needsAction ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn", triggerTurn: false },
        );
        pi.appendEntry(NOTICE_ENTRY, { signature, runId: view.runId, state: noticeState });
        diag("notice_sent", { runId: view.runId, state: noticeState });
      } catch (error) {
        diag("notice_failed", { runId: view.runId, reason: String(error) });
      }
    }
    state.lastScanActive = active;
    return active;
  }

  /** 串行扫描队列：观察器与 agent_settled 共用，避免同一 run 并发通知。 */
  function serialScan(ctx: any): Promise<boolean> {
    const next = state.scanChain.then(
      () => scanRuns(ctx),
      () => scanRuns(ctx),
    );
    state.scanChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 阶段边界事实：失败原因（阶段内提交、敏感区改动等）与忽略区变化；忽略区只报告不判失败。 */
  function boundaryNotes(result: any): string[] {
    const notes: string[] = [];
    if (result?.state === "failed" && typeof result.failureReason === "string" && result.failureReason !== "") {
      notes.push(`失败原因：${result.failureReason}`);
    }
    if (result?.boundary?.headMoved === true && Array.isArray(result.boundary.commits)) {
      notes.push(`阶段内提交 ${result.boundary.commits.length} 个，未接收；请自行处理提交后重派。`);
    }
    const external = Array.isArray(result?.externalChanges) ? result.externalChanges : [];
    if (external.length > 0) {
      notes.push(`外部改动（未并入 scope）：${external.slice(0, 5).join(", ")}${external.length > 5 ? ` 等 ${external.length} 项` : ""}`);
    }
    const unattributed = Array.isArray(result?.attribution?.unattributedPaths) ? result.attribution.unattributedPaths : [];
    if (unattributed.length > 0) {
      notes.push(`来源不明，待确认：${unattributed.slice(0, 5).join(", ")}${unattributed.length > 5 ? ` 等 ${unattributed.length} 项` : ""}；用 knit_run action=accept 带 include／exclude 确认。`);
    }
    const ignored = Array.isArray(result?.ignoredChanges) ? result.ignoredChanges : [];
    if (ignored.length > 0) {
      const shown = ignored.slice(0, 5).map((item: any) => `${item.path}(${item.change})`).join(", ");
      notes.push(`忽略区变化（仅报告）：${shown}${ignored.length > 5 ? ` 等 ${ignored.length} 项` : ""}`);
    }
    return notes;
  }

  function startObserver(ctx: any): void {
    stopObserver();
    state.ctx = ctx;
    state.started = true;
    state.lastScanActive = true;
    // 从本次会话开始观察：历史已收敛的 run 不再进入通知，只保留会话开始后新出结果的。
    state.lastScanAt = Date.now();
    scheduleObserver(0);
  }

  function stopObserver(): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.started = false;
  }

  function observerDelay(active: boolean): number {
    return active ? POLL_MS : IDLE_POLL_MS;
  }

  /** 观察器节拍：setTimeout 串行排队；无活动 run 退避到 30 秒。 */
  function scheduleObserver(delay: number): void {
    if (state.started !== true) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void observerTick();
    }, delay);
    // 观察器不单独维持进程存活：宿主退出或测试用例提前失败时不因定时器挂住。
    state.timer.unref?.();
  }

  async function observerTick(): Promise<void> {
    if (state.started !== true) return;
    let active = state.lastScanActive === true;
    try {
      active = await serialScan(state.ctx);
    } catch (error) {
      diag("scan_failed", { reason: String(error) });
    }
    if (state.started !== true) return;
    scheduleObserver(observerDelay(active));
  }

  /** 派发／恢复／结束后立即扫一次，重置观察器节拍。 */
  function pokeObserver(ctx: any): void {
    if (state.started !== true) return;
    state.ctx = ctx;
    scheduleObserver(0);
  }

  /**
   * 任务与无任务分支共用的主会话行为引导；同一会话每轮只注入一份，历史查询只在此处出现一次。
   * 注入是行为引导，不替代核心授权、阶段与写动作核对。
   */
  const SESSION_BEHAVIOR_GUIDANCE = [
    "任务选择：是否建任务由用户决定；新事项先问是否建任务再展开需求，不按类型或预估大小跳过；暂不创建可继续讨论，实施前再确认，遗漏选择先补问，不能用“你做吧”代替；明确不创建时同一事项持续有效，不重复追问。",
    "派发分层：动手前先判断可委派（需求稳定、目标与验收可写清、无需频繁反问、不依赖主会话未落盘判断），再按复杂度分流：W1 独立检查（任务要求 independent，或协议、数据迁移、权限、并发、安全、保护路径等正确性无法自证）、W2 改动面（点名后可见 ≥ 3 个文件，或跨 ≥ 2 个模块／包，含必须同步的配置、测试、文档）、W3 摸底成本（动手前需读 ≥ 8 个文件或 ≥ 1500 行，或依赖大量搜索／长日志）、W4 用户指定；满足任一派 Knit worker，其余主会话直接做（单文件或纯文案／注释／小函数／单个配置项、已知改哪里、自证足够、一次做完）。阈值是判断辅助，不以时长、步骤数、阶段数或是否需要恢复作判据。没有任务就没有 Knit worker：该派但无任务时先向用户提议建任务，不代建；复杂但不建任务时用宿主通用子 Agent；independent 不得用主会话自检或 run check --scope 代替，也不得用 task implement 绕开 W1。",
    "授权边界：创建任务不等于需求确认或实施授权；用户明确“按这个做”可同时确认范围与实施授权，仅认可思路且实施意愿不明时补问；授权不覆盖提交／发布。",
    "规范沉淀：明确长期规则可直接采纳并说明依据，冲突先提决定，未明确内容用 standards propose 存项目候选；正常回复末尾告知内容、适用范围与位置。",
    "需求澄清：先查代码、测试、配置、文档、规范与任务历史（含归档、run、提交说明）再提问，仓库证据只证明现状，产品意图、范围与验收仍由用户决定；按目标、范围、验收、约束、冲突、副作用、回滚、时序逐项扫缺口，证据已解决的不问、不硬造问题。需决定时每问给决定、为什么重要、推荐与代价，一轮最多 3 个且一问一事；推荐不替用户选择，不答按推荐推进须标 [assumed] 与“（Agent 建议，待确认）”；与既有决定冲突先给影响与替代方案，已明确决定不重复建议。未决项写 task.md「待澄清」的 - [blocking]／- [assumed]，解决后折入正文并删除；blocking 未清零不 task ready；验收写成场景：完成条件用 ### Requirement: 名称 与 #### Scenario: 名称，顶格 - GIVEN／- WHEN／- THEN／- AND（可加粗关键字），每场景至少 WHEN 与 THEN、可单独验证；independent 任务必须写场景，self／none 可用自由列表；验证不了的延期项留在目标与边界，不写成必须通过的场景；收敛摘要等用户明确批准，不能以“完整方案＋是否正确”作为唯一确认。",
    "历史查询: 需求澄清取证时可用 knit_task action=search（或 /knit task search）检索任务历史、归档与提交并引用 path:line、run ID 或 commit；普通对话仅在用户明确表达查历史、上次决定／处理／修改或追溯问题的意愿时检索；未表达意愿不主动检索；相关记录不等于因果结论。",
    "交付：实施与检查结果由主会话接收、核对完成条件并汇总报告；交付前起草一次产物提交文案并向用户展示，不虚构验证；提交、推送、发布另行授权。",
    "完整规则见 AGENTS.md；流程配置见 .knit/workflow.yaml。",
  ];

  /**
   * 每轮模型调用前注入当前任务上下文（DESIGN §9.6，任务047）。
   * 通过 Pi 公开 before_agent_start 事件 + systemPromptOptions.sections 实现：
   * Pi 对分节做 diff，只追加变更，不堆叠历史正文。注入是行为引导，
   * 所有写动作仍经核心按授权／阶段／锁／版本重新核对。
   *
   * 每轮只调一次 `session context`（选择、状态、资料与 nextAction），并与 session_start 预热共享在途请求：
   * 有缓存时超过预算（默认 300ms）不阻塞、改用缓存并标注“可能过期”；
   * 续接会话首轮没有缓存时等待当轮结果（上限 2s），失败保留上一轮分节并记录诊断，不静默删除。
   */
  function renderTurnContext(data: any): { text: string; taskId: string | null } {
    const lines: string[] = [];
    const taskId = typeof data?.taskId === "string" && data.taskId !== "" ? data.taskId : null;
    const task = data?.task ?? null;
    if (taskId !== null && task !== null) {
      const activeRuns: any[] = Array.isArray(task.activeRuns) ? task.activeRuns : [];
      lines.push(`当前任务：${currentTaskText(task, taskId)}`);
      lines.push(`阶段：${stageText(task.stageName, task.stage ?? "?", "paren")}；状态: ${task.status ?? "?"}${task.outcome ? `；结果: ${task.outcome}` : ""}${task.branch ? `；分支: ${task.branch}` : ""}`);
      if (task.pendingDraft) lines.push(`待应用草案: ${task.pendingDraft.kind ?? "?"}（${task.pendingDraft.digest?.slice(0, 12) ?? ""}）——先应用或撤回再进入后续阶段`);
      const clarify = task.clarify;
      if (clarify !== null && typeof clarify === "object") {
        if (typeof clarify.blocking === "number" && clarify.blocking > 0) lines.push(`待澄清: ${clarify.blocking} 项`);
        if (typeof clarify.assumed === "number" && clarify.assumed > 0) lines.push(`假设待确认: ${clarify.assumed} 项`);
      }
      if (activeRuns.length > 0) lines.push(`活动运行: ${activeRuns.map((run: any) => `${run.runId}(${run.state ?? "?"})`).join(", ")}——活动运行使用冻结输入`);
      lines.push(`任务入口: ${typeof task.relativePath === "string" && task.relativePath !== "" ? task.relativePath : ".knit/tasks/…/task.md"}`);
      const materials: any[] = Array.isArray(data.materials) ? data.materials : [];
      if (materials.length > 0) lines.push(`规划资料: ${materials.map((entry: any) => entry.path).join(", ")}`);
      else lines.push("规划资料: 无（简单任务可只用 task.md）");
      lines.push("下一步: 按当前阶段推进；写动作由核心核对授权与状态。");
      // 核心推导的确定性出口（输入已变、待接收、锁残留、无绑定等）紧跟在通用规则后。
      lines.push(...nextActionLines(data.nextAction));
    } else {
      lines.push("当前无选定任务。");
      lines.push("是否建任务由用户决定：普通讨论、问答、只读调查、审阅和非正式小修改直接完成，不因调研、委派或报告落盘强制建任务。");
      lines.push("不建任务时使用宿主工具／通用子 Agent；复杂但不建任务时不派 Knit run，Knit run 只服务正式任务，不派发无任务 worker。");
      lines.push("用户要求正式跟踪时再提议 task new；已有持续授权可直接创建。正式任务创建时选择 completion verification（none／self／independent，默认 self）。");
      lines.push("建任务前先过澄清门：先取证再提问（代码、测试、配置、文档、规范与任务历史，含归档），仓库证据只证明现状、产品意图仍由用户决定；按目标、范围、验收、约束、冲突、副作用等维度扫缺口，缺口清单为空或用户已裁决才登记；需决定时每问给决定、原因、推荐与代价，一轮最多 3 个；假设写 [assumed] 并标“（Agent 建议，待确认）”；blocking 未清零不 task ready，不得以“完整方案＋是否正确”作为唯一确认；复杂需求先拆分并确认范围。");
      lines.push("继续或补充已有任务用 task list 查看活跃任务（归档用 task list --archive）并按稳定 ID 选择。授权不覆盖提交／发布。");
      lines.push("主会话直接实施的任务，收尾前用 task implement 记录改动路径与实际验证；只有用户明确要求时才用 task close --force --reason。");
    }
    lines.push(...SESSION_BEHAVIOR_GUIDANCE);
    return { text: lines.join("\n"), taskId };
  }

  type TurnContextResult =
    | { status: "fresh"; text: string; taskId: string | null }
    | { status: "stale"; text: string; taskId: string | null; reason: string }
    | { status: "unavailable"; reason: string };

  /**
   * 同一主会话同一代际共享在途 `session context`：写动作或会话重核后不再复用旧请求。
   * 结果交给 buildTurnContext 再核对代际，旧回包不能标 fresh 或覆盖新缓存。
   */
  async function requestTurnContext(session: SessionRef, timeout: number): Promise<{ data: any | null; timedOut: boolean; failure: string | null }> {
    const pending: { knitSessionId: string; promise: Promise<{ data: any | null; timedOut: boolean; failure: string | null }> } | null = state.contextWork;
    if (pending !== null && pending.knitSessionId === session.knitSessionId) {
      const shared = await raceDeadline(pending.promise, timeout);
      if (shared === CONTEXT_DEADLINE) return { data: null, timedOut: true, failure: null };
      return shared;
    }
    const promise = (async () => {
      const result = await core(["session", "context", session.knitSessionId, "--dir", root], undefined, { timeout });
      const data = result.response?.outcome === "completed" ? result.response.data : null;
      if (data !== null && typeof data === "object") return { data, timedOut: false, failure: null };
      const failure = result.timedOut === true ? null : result.error ?? result.response?.reasonCode ?? "unknown";
      return { data: null, timedOut: result.timedOut === true, failure };
    })();
    state.contextWork = { knitSessionId: session.knitSessionId, promise };
    const clear = (): void => {
      if (state.contextWork !== null && state.contextWork.promise === promise) state.contextWork = null;
    };
    void promise.then(clear, clear);
    return await promise;
  }

  /**
   * 回放原生会话的 system 分节，取上一轮注入的 knit 分节（Pi 按 section diff 持久化）。
   * 持久化的是渲染后的 `<knit>…</knit>`；回填前还原成 raw 正文，避免宿主再次包装成嵌套分节。
   */
  function previousKnitSection(ctx: any): string | null {
    let entries: any[] = [];
    try {
      entries = typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    } catch {
      entries = [];
    }
    let section: string | null = null;
    for (const entry of entries) {
      if (entry?.type !== "message" || entry?.message?.role !== "system") continue;
      const sections = entry.message.sections;
      if (sections === null || typeof sections !== "object" || !("knit" in sections)) continue;
      section = typeof sections.knit === "string" ? sections.knit : null;
    }
    if (section === null) return null;
    const body = unwrapKnitSection(section);
    return body === "" ? TURN_CONTEXT_MARKER : `${TURN_CONTEXT_MARKER}\n${body}`;
  }

  /**
   * 还原 raw 正文：剥离宿主的 `<knit>` 包装（含旧版本造成的多层嵌套）与分节标记，
   * 保留正文（含旧过期说明，供不需要刷新的轮次原样保留）。
   */
  function unwrapKnitSection(section: string): string {
    let body = section.trim();
    for (;;) {
      let changed = false;
      if (body.startsWith("<knit>\n") && body.endsWith("\n</knit>")) {
        body = body.slice("<knit>\n".length, body.length - "\n</knit>".length).trim();
        changed = true;
      }
      if (body === TURN_CONTEXT_MARKER) {
        body = "";
        changed = true;
      } else if (body.startsWith(`${TURN_CONTEXT_MARKER}\n`)) {
        body = body.slice(TURN_CONTEXT_MARKER.length + 1);
        changed = true;
      }
      if (!changed) break;
    }
    return body.trimEnd();
  }

  /** 去掉旧降级说明，避免多次降级叠加。 */
  function knitSectionBody(section: string): string {
    return unwrapKnitSection(section)
      .split("\n")
      .filter((line) => !line.startsWith(CONTEXT_STALE_PREFIX))
      .join("\n")
      .trimEnd();
  }

  function withStaleNotice(text: string, cause: string): string {
    return `${knitSectionBody(text)}\n${CONTEXT_STALE_PREFIX}${cause}。`;
  }

  async function buildTurnContext(ctx: any, options: { timeout?: number } = {}): Promise<TurnContextResult> {
    const session = await sessionOf(ctx);
    if (session === null) return { status: "unavailable", reason: installationReady().reason ?? "原生会话未登记" };
    const cached: ContextCacheEntry | null =
      state.contextCache !== null && state.contextCache.knitSessionId === session.knitSessionId ? state.contextCache : null;
    const generation = state.contextGeneration;
    const timeout = options.timeout ?? contextTimeoutMs(cached !== null);
    let result = await requestTurnContext(session, timeout);
    if (generation !== state.contextGeneration || session.nativeSessionId !== state.nativeSessionId) {
      result = { data: null, timedOut: false, failure: "context_invalidated" };
      diag("context_refresh_failed", { reason: "context_invalidated" });
    }
    if (result.data !== null && typeof result.data === "object") {
      const rendered = renderTurnContext(result.data);
      state.contextCache = {
        knitSessionId: session.knitSessionId,
        nativeSessionId: session.nativeSessionId,
        text: rendered.text,
        taskId: rendered.taskId,
        at: Date.now(),
      } as ContextCacheEntry;
      return { status: "fresh", text: rendered.text, taskId: rendered.taskId };
    }
    const cause =
      result.timedOut === true
        ? `本次查询超过 ${timeout}ms`
        : `本次刷新失败（${result.failure ?? "未知原因"}）`;
    const fallback: ContextCacheEntry | null =
      state.contextCache?.knitSessionId === session.knitSessionId && state.contextCache?.nativeSessionId === state.nativeSessionId
        ? state.contextCache : null;
    if (fallback !== null) {
      diag("context_cache_used", { reason: result.timedOut === true ? "timeout" : result.failure ?? "failed" });
      const ageSeconds = Math.max(0, Math.round((Date.now() - fallback.at) / 1000));
      return {
        status: "stale",
        text: withStaleNotice(fallback.text, `${cause}，使用上一轮缓存（${ageSeconds} 秒前）`),
        taskId: fallback.taskId,
        reason: cause,
      };
    }
    diag("context_refresh_failed", { reason: cause });
    return { status: "unavailable", reason: cause };
  }

  /** 预热／动作后刷新：不占模型轮次预算；失败只记诊断，不影响工具结果。 */
  async function refreshTurnContext(ctx: any): Promise<void> {
    try {
      await buildTurnContext(ctx, { timeout: CONTEXT_REFRESH_TIMEOUT_MS });
    } catch (error) {
      diag("context_refresh_failed", { reason: String(error) });
    }
  }

  /** 保留已有 knit 分节：Pi 每轮用新 options 与历史分节做 diff，不重设等于删除。 */
  function keepKnitSection(event: any, ctx: any, cause?: string): void {
    const options = event?.systemPromptOptions;
    if (options === null || typeof options !== "object" || options.sections === null || typeof options.sections !== "object") return;
    const previous = previousKnitSection(ctx);
    if (previous === null) return;
    options.sections.knit = cause === undefined ? previous : `${TURN_CONTEXT_MARKER}\n${withStaleNotice(previous, cause)}`;
  }

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (state.nativeSessionId !== ctx?.sessionManager?.getSessionId?.()) {
      // 会话未登记或已切换：本轮不查询，但保留当前分支已有的分节，不靠“不设置”删除历史。
      keepKnitSection(event, ctx);
      return;
    }
    if (event.messageType !== "user") {
      // 只刷新用户发起的轮次；自身通知触发的轮次不叠加正文，但保留已有分节。
      keepKnitSection(event, ctx);
      return;
    }
    try {
      const context = await buildTurnContext(ctx);
      const options = event.systemPromptOptions;
      if (options === null || typeof options !== "object" || options.sections === null || typeof options.sections !== "object") {
        diag("inject_unavailable", { reason: installationReady().reason ?? "systemPromptOptions.sections missing" });
        return;
      }
      if (context.status === "unavailable") {
        const previous = previousKnitSection(ctx);
        if (previous !== null) {
          options.sections.knit = `${TURN_CONTEXT_MARKER}\n${withStaleNotice(previous, `${context.reason}，沿用上一轮注入`)}`;
          diag("context_previous_section_used", { reason: context.reason });
        } else {
          options.sections.knit = `${TURN_CONTEXT_MARKER}\nknit 上下文暂不可用：${context.reason}。写动作仍由核心核对授权、阶段与状态。`;
          diag("inject_unavailable", { reason: context.reason });
        }
        return;
      }
      options.sections.knit = `${TURN_CONTEXT_MARKER}\n${context.text}`;
    } catch (error) {
      diag("inject_failed", { reason: String(error) });
      keepKnitSection(event, ctx, `本次注入失败（${String(error)}）`);
    }
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    invalidateTurnContext();
    state.ctx = ctx;
    const session = await sessionOf(ctx);
    if (session !== null) {
      if (versionFacts.notice !== null && state.versionNoticed !== true) {
        state.versionNoticed = true;
        try {
          ctx.ui.notify(versionFacts.notice, "warning");
        } catch {}
      }
      await restoreSelection(ctx);
      startObserver(ctx);
      // 预热每轮上下文缓存：首轮与预热共享在途请求，随后各轮有可回退的上一轮内容。
      void refreshTurnContext(ctx);
    } else {
      diag("not_ready", { reason: installationReady().reason ?? "session attach failed" });
    }
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (state.nativeSessionId !== ctx?.sessionManager?.getSessionId?.()) return;
    await sessionOf(ctx);
    try {
      const active = await serialScan(ctx);
      if (state.started === true) scheduleObserver(observerDelay(active));
    } catch (error) {
      diag("scan_failed", { reason: String(error) });
    }
    void refreshTurnContext(ctx);
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
      const stage = entry.stage ? ` · 阶段：${stageText(entry.stageName, entry.stage, "paren")}` : "";
      return `  - ${taskLabel(entry)}${stage}${entry.outcome ? ` · ${entry.outcome}` : ""}${entry.archived ? " · 已归档" : ""}${parent}${children}`;
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
    // task list 默认视图：{ scope: "active", active: [...], archivedCount }。
    if (data.scope === "active" && Array.isArray(data.active)) {
      const groups = [
        { title: "进行中", rows: data.active.filter((entry: any) => entry.status === "open") },
        { title: "待归档", rows: data.active.filter((entry: any) => entry.status !== "open" && entry.outcome !== "cancelled" && entry.outcome !== "superseded") },
        { title: "已取消", rows: data.active.filter((entry: any) => entry.status !== "open" && (entry.outcome === "cancelled" || entry.outcome === "superseded")) },
      ];
      const row = (entry: any): string =>
        `  - ${entry.priority ?? "?"} · ${taskLabel(entry)}${entry.stage ? ` · ${stageNameOf(entry.stage)}` : ""}`;
      const lines: string[] = [];
      for (const group of groups) {
        lines.push(`${group.title}（${group.rows.length}）：`);
        lines.push(...(group.rows.length > 0 ? group.rows.map(row) : ["  - （无）"]));
      }
      const blocked = groups[0].rows.filter((entry: any) => Array.isArray(entry.blocked) && entry.blocked.length > 0).length;
      lines.push(`进行中 ${groups[0].rows.length} · 待归档 ${groups[1].rows.length} · 已取消 ${groups[2].rows.length} · 阻塞 ${blocked} · 归档 ${data.archivedCount ?? 0}（task list --archive）`);
      if (Array.isArray(data.bindingMissing) && data.bindingMissing.length > 0) {
        lines.push(`本机缺少绑定 ${data.bindingMissing.length}（binding_missing；clone／换机后按 task.md 重建）：`);
        for (const entry of data.bindingMissing) {
          lines.push(`  - ${taskLabel(entry)} · ${stageNameOf(entry.stage)}（先 task rebind ${entry.taskId}）`);
        }
      }
      return lines.join("\n");
    }
    // task list --archive：{ scope: "archive", archived: [...], archivedCount }。
    if (data.scope === "archive" && Array.isArray(data.archived)) {
      const groups = new Map<string, any[]>();
      for (const entry of data.archived) {
        const match = /^tasks\/archive\/(\d{4}-\d{2})\//.exec(String(entry.relativePath ?? ""));
        const month = match?.[1] ?? "未知";
        groups.set(month, [...(groups.get(month) ?? []), entry]);
      }
      const lines: string[] = [];
      for (const month of [...groups.keys()].sort().reverse()) {
        const rows = groups.get(month) ?? [];
        lines.push(`归档 ${month}（${rows.length}）：`);
        lines.push(...rows.slice(0, 30).map((entry: any) => `  - ${shortId(entry.taskId)}${entry.outcome ? ` · ${entry.outcome}` : ""} · ${entry.title ?? ""}`));
        if (rows.length > 30) lines.push(`  - …本月共 ${rows.length} 条`);
      }
      if (groups.size === 0) lines.push("归档（0）：");
      if (typeof data.archivedCount === "number") lines.push(`全部归档 ${data.archivedCount} 条`);
      return lines.join("\n");
    }
    // 项目概览：{ tasks: [...], activeRuns: [...] }
    if (Array.isArray(data.tasks)) {
      const runs = Array.isArray(data.activeRuns) ? data.activeRuns : [];
      const lines = [`任务（${data.tasks.length}）：`];
      lines.push(...(data.tasks.length > 0 ? data.tasks.map((entry: any) => joinOutcome({ ...entry, archived: entry.archived === true })) : ["  - （无）"]));
      lines.push(`活跃运行（${runs.length}）：`);
      lines.push(...(runs.length > 0 ? runs.map((run: any) => `  - ${taskLabel(run)}${typeof run.stageName === "string" ? run.stageName : run.phase ?? "?"} · ${shortId(run.runId)} · ${run.state ?? "?"}`) : ["  - （无）"]));
      return lines.join("\n");
    }
    // run 状态（status --run）：{ runId, taskId, phase, stageName, state, result, acceptance, ... }。
    if (tokens[0] === "status" && typeof data.runId === "string" && typeof data.taskId === "string" && !Array.isArray(data.runs)) {
      const lines = [
        `任务：${taskLabel(data)}（阶段：${stageText(data.stageName, data.phase ?? "?", "space")}）`,
        `  run ${data.runId}: ${data.state ?? "?"}（启动 ${data.launchState ?? "?"}，尝试 ${data.attempts ?? "?"}）；任务 ID: ${data.taskId}`,
      ];
      if (data.result) lines.push(`  结果: ${data.result.state ?? "?"}${data.result.report?.verdict ? ` / ${data.result.report.verdict}` : ""}`);
      if (data.result) lines.push(...boundaryNotes(data.result).map((note) => `  ${note}`));
      if (data.acceptance) lines.push(`  接收: ${data.acceptance.state ?? "?"}${data.acceptance.reason ? `（${data.acceptance.reason}）` : ""}`);
      if (Array.isArray(data.nextActions)) lines.push(...data.nextActions.map((action: string) => `  下一步: ${action}`));
      return lines.join("\n");
    }
    // 按任务查询（仅 status <taskId>）：{ taskId, title, stage, status, runs, ... }（任务042）。
    if (tokens[0] === "status" && tokens.length >= 2 && typeof data.taskId === "string") {
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const lines = [
        taskLabel(data),
        `  任务 ID: ${data.taskId}`,
        `  状态: ${data.status ?? "?"} · 阶段：${stageText(data.stageName, data.stage ?? "?", "paren")}${data.outcome ? ` · 结果: ${data.outcome}` : ""}${data.archived ? " · 已归档" : ""}${data.branch ? ` · 分支: ${data.branch}` : ""}`,
      ];
      if (data.parent) lines.push(`  父任务: ${data.parent}`);
      if (Array.isArray(data.children) && data.children.length > 0) {
        const open = data.children.filter((child: any) => child.status === "open").length;
        lines.push(`  子任务（${data.children.length - open}/${data.children.length} 已结束）：${data.children.map((child: any) => `${child.taskId}[${child.status}${child.outcome ? `/${child.outcome}` : ""}]`).join(", ")}`);
      }
      if (data.pendingDraft) lines.push(`  待应用草案: ${data.pendingDraft.kind ?? "?"}`);
      lines.push(`  运行（${runs.length}）：`);
      lines.push(...(runs.length > 0 ? runs.map((run: any) => `  - ${shortId(run.runId)} · ${stageText(run.stageName, run.phase ?? "?", "paren")} · ${run.state ?? "?"}${run.reason ? ` · ${run.reason}` : ""}`) : ["  - （无）"]));
      lines.push(...nextActionLines(data.nextAction).map((line) => `  ${line}`));
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
      const result = await core(["status", ...(args.trim() === "" ? [] : args.trim().split(/\s+/)), "--dir", root]);
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
      const result = await core(["doctor", "--dir", root]);
      // 诊断同时显示安装 CLI 的版本／dist 摘要一致性（k-0524fc52e81b）。
      const checks: any[] = Array.isArray(result.response?.data?.checks) ? result.response.data.checks : [];
      const versionCheck = checks.find((check) => check?.name === "installation-version");
      const detail = typeof versionCheck?.detail === "string" ? `\n${versionCheck.detail}` : "";
      const ok = result.code === 0 && result.response?.outcome === "completed";
      ctx.ui.notify(`${ok ? "Knit 已重新核对安装与配置" : "Knit 诊断发现需处理项"}${detail}`, ok ? "info" : "warning");
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
      const result = await core([...tokens, "--dir", root]);
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

  // 工具参数直接使用安装包内生成的纯 JSON Schema；阶段目标按当前 workflow.yaml 派生。
  const schema = (name: string) => schemaOf(name);

  /** 注册工具：把 execute 的 signal 放进 AsyncLocalStorage，所有 CLI 调用默认继承，可随中止结束。 */
  function registerTool(definition: any): void {
    pi.registerTool({
      ...definition,
      execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) =>
        toolSignal.run(signal, () => definition.execute(toolCallId, params, signal, onUpdate, ctx)),
    });
  }

  registerTool({
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
      return toolResult(await core(args), (data) => describeQuery(["status"], data));
    },
  });

  /** 当前主会话已选择且不同于给定任务时返回其 ID，否则 null（任务048 防重复创建引导）。 */
  async function selectionReminder(ctx: any, createdTaskId: string): Promise<string | null> {
    const session = await sessionOf(ctx);
    if (session === null) return null;
    const resolution = await core(["session", "resolve", session.knitSessionId, "--dir", root]);
    const current = resolution.response?.data?.taskId;
    return typeof current === "string" && current !== "" && current !== createdTaskId ? current : null;
  }

  /** 本轮主会话经 session resolve 核实的当前任务；无有效选择返回 null。 */
  async function currentTaskId(ctx: any): Promise<string | null> {
    const session = await sessionOf(ctx);
    if (session === null) return null;
    const resolution = await core(["session", "resolve", session.knitSessionId, "--dir", root]);
    const current = resolution.response?.data?.taskId;
    return resolution.code === 0 && typeof current === "string" && current !== "" ? current : null;
  }

  registerTool({
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
      return toolResult(await core(args, params.action === "save" ? params.content : undefined));
    },
  });

  registerTool({
    name: "knit_task",
    label: "Knit task",
    description: "任务身份、输入更新（目标有活动 run 时 update 需 runId 否则 task_busy，运行中改输入收尾判 stale_input；pending=true 只存草案）、验证要求、优先级／依赖／业务顺序、稳定执行顺序、历史检索、记录、关闭、clone／换机后的 rebind 与当前会话选择；list 默认只列未归档任务，archive=true 查归档；是否建任务由用户决定，普通问答与只读调查不需要建任务。",
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
        return toolResult(await core(args));
      }
      // task next 不读 taskId；只有真正的任务操作才校验它。
      if (params.action !== "next" && params.taskId && safeId(params.taskId, "k-") === null) return failText(`非法 taskId: ${params.taskId}`);
      // rebind 是跨机恢复入口，必须明确目标任务；不借用会话当前选择。
      if (params.action === "rebind" && !params.taskId) return failText("task rebind 需要 taskId");
      if (params.action === "use" || params.action === "clear") {
        const session = await sessionOf(ctx);
        if (session === null) return failText("无法登记当前主会话；先确认项目已 init 且桥接加载");
        const operationId = `sel-${Date.now().toString(36)}`;
        const branch = await branchNow();
        const taskId = params.action === "use" ? params.taskId : null;
        if (params.action === "use" && (typeof taskId !== "string" || safeId(taskId, "k-") === null)) return failText("task use 需要合法 taskId");
        const entryId = appendSelection(ctx, { taskId, branch, operationId });
        if (entryId === null) return failText("无法写入原生选择条目");
        const persisted = typeof ctx.sessionManager?.isPersisted === "function" ? ctx.sessionManager.isPersisted() === true : true;
        const persistedArgs = persisted ? ["--persisted"] : [];
        const args = params.action === "use"
          ? ["task", "use", taskId, "--session", session.knitSessionId, "--entry", entryId, ...persistedArgs, "--operation-id", operationId, "--branch", branch ?? "", "--dir", root]
          : ["task", "clear", "--session", session.knitSessionId, "--entry", entryId, ...persistedArgs, "--operation-id", operationId, "--branch", branch ?? "", "--dir", root];
        const result = await core(args);
        // 选择变化后刷新每轮上下文缓存；失败只记诊断，不回滚选择。
        void refreshTurnContext(ctx);
        return toolResult(result);
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
        const created = await core(args);
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
      if (params.action === "list") {
        if (params.archive === true) args.push("--archive");
        if (typeof params.month === "string" && params.month !== "") args.push("--month", params.month);
      }
      // ready／record／close 允许省略 taskId：使用本轮 session resolve 的当前任务；
      // 其他动作保持原语义（next 不接受任务参数，其余需要显式 taskId 的动作由核心报错）。
      let taskId = params.taskId;
      if ((params.action === "ready" || params.action === "record" || params.action === "close") && !taskId) {
        const current = await currentTaskId(ctx);
        if (current === null) return failText(NO_CURRENT_TASK);
        taskId = current;
      }
      // task next 是项目级只读视图，不接受任务参数；忽略误传的 taskId。
      if (taskId && params.action !== "next") args.push(taskId);
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
        // 目标有活动 run 时必须声明 runId（否则核心报 task_busy）；pending 只存草案，不需要 runId。
        if (params.runId) {
          if (safeId(params.runId, "run-") === null) return failText(`非法 runId: ${params.runId}`);
          args.push("--run", params.runId);
        }
        if (params.pending === true) args.push("--pending");
        if (params.applyPending === true) args.push("--apply-pending");
        if (params.withdrawPending === true) args.push("--withdraw-pending");
        if (params.expectPending) args.push("--expect-pending", params.expectPending);
        if (params.reason) args.push("--reason", params.reason);
        args.push("--dir", root);
        return toolResult(await core(args, params.body ?? ""));
      } else if (params.action === "record") {
        args.push("--dir", root);
        return toolResult(await core(args, params.body ?? ""));
      } else if (params.action === "implement") {
        for (const path of params.paths ?? []) args.push("--path", path);
        for (const line of params.validations ?? []) args.push("--validation", line);
        for (const line of params.unverified ?? []) args.push("--unverified", line);
        if (typeof params.summary === "string" && params.summary !== "") args.push("--summary", params.summary);
        if (params.executor === "user" || params.executor === "main-session") args.push("--by", params.executor);
      } else if (params.action === "close") {
        if (!params.outcome) return failText("task close 需要 outcome");
        args.push("--outcome", params.outcome);
        if (params.reason) args.push("--reason", params.reason);
        if (params.runsSettled === true) args.push("--runs-settled");
        if (params.force === true) args.push("--force");
        if (params.noArtifacts === true) args.push("--no-artifacts");
      }
      args.push("--dir", root);
      return toolResult(await core(args), (data) => (params.action === "list" ? describeQuery(["task", "list"], data) : null));
    },
  });

  registerTool({
    name: "knit_context",
    label: "Knit context",
    description: "生成任务阶段的分层输入计划与阻塞项；stage 由当前 workflow.yaml 派生。",
    parameters: schema("context"),
    async execute(_toolCallId: string, params: any) {
      if (safeId(params.taskId, "k-") === null) return failText(`非法 taskId: ${params.taskId}`);
      const stage = params.stage ?? configuredStages?.[0] ?? "implement";
      return toolResult(await core(["context", "--task", params.taskId, "--stage", stage, "--dir", root]), (data) => {
        // 计划原样返回（JSON），另把确定性下一步放在最前，不让空 blockers 被误读为可继续。
        if (data === null || typeof data !== "object") return null;
        const next = nextActionLines(data.nextAction);
        return next.length === 0 ? null : `${next.join("\n")}\n${JSON.stringify(data)}`;
      });
    },
  });

  /**
   * 轮询 run 终态；桥接只读观察，不重复接收结果。
   * wait 期间可被 signal 中止：结束等待并返回当前状态，不取消 run。
   */
  async function waitForRun(runId: string, signal?: AbortSignal): Promise<CoreResult & { waitAborted?: boolean }> {
    const startedAt = Date.now();
    let last = await core(["run", "status", runId, "--dir", root], undefined, { signal });
    for (;;) {
      const state = last.response?.data?.state;
      if (terminalState(state)) return last;
      if (last.aborted === true) return { ...last, waitAborted: true };
      if (last.code !== 0 || last.timedOut === true) return last;
      if (Date.now() - startedAt > WAIT_LIMIT_MS) return { ...last, timedOut: true };
      if (signal?.aborted === true) return { ...last, waitAborted: true };
      await sleep(WAIT_POLL_MS, signal);
      if (signal?.aborted) return { ...last, waitAborted: true };
      const next = await core(["run", "status", runId, "--dir", root], undefined, { signal });
      if (next.aborted === true) return { ...last, waitAborted: true };
      last = next;
    }
  }

  /** wait 结果合并进工具 data；中止与超时如实标注，不伪装终态。 */
  function mergeWaitStatus(data: any, status: CoreResult & { waitAborted?: boolean }): any {
    if (status.response?.data?.state === undefined) return data;
    return {
      ...data,
      status: status.response.data,
      ...(status.waitAborted === true ? { waitAborted: true } : {}),
      ...(status.timedOut === true ? { waitTimedOut: true } : {}),
    };
  }

  function waitNote(data: any): string | null {
    if (data?.waitAborted === true) return `等待已中止（run 未取消）：当前状态 ${data.status?.state ?? "?"}`;
    if (data?.waitTimedOut === true) return `等待超时（未达终态）：当前状态 ${data.status?.state ?? "?"}`;
    return null;
  }

  registerTool({
    name: "knit_run",
    label: "Knit run",
    description: "派发正式任务的配置阶段（action 为 workflow.yaml 阶段 id）、查询、恢复、取消或接收 run（accept 可带 include／exclude 确认来源不明路径）；无任务直接执行或使用宿主委派，不派发 Knit worker。",
    parameters: schema("run"),
    async execute(_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) {
      const model = ctx?.model;
      const provider = params.provider ?? (typeof model?.provider === "string" ? model.provider : undefined);
      const modelId = params.model ?? (typeof model?.id === "string" ? model.id : undefined);
      if (params.action === "list") {
        return toolResult(await core(["run", "list", "--with-status", "--dir", root]), (data) => {
          if (!Array.isArray(data)) return null;
          if (data.length === 0) return "暂无 run。";
          const lines = [`run（${data.length}）：`];
          for (const run of data) {
            const label = taskLabel({ ...(run ?? {}), taskId: run?.taskId });
            const stage = typeof run?.stageName === "string" && run.stageName !== "" ? run.stageName : stageNameOf(run?.phase ?? "?");
            lines.push(`  - ${label}${stage}：${shortId(String(run?.runId))} ${run?.state ?? "?"}${run?.presentation ? `（${run.presentation}）` : ""}`);
          }
          return lines.join("\n");
        });
      }
      if (params.action === "status") {
        if (!params.runId || safeId(params.runId, "run-") === null) return failText("run status 需要合法 runId");
        return toolResult(await core(["status", "--run", params.runId, "--dir", root]), (data) => describeQuery(["status"], data));
      }
      if (params.action === "resume") {
        if (!params.runId || safeId(params.runId, "run-") === null) return failText("run resume 需要合法 runId");
        // resume 与 CLI 同一实现：生成新 run 后立即启动（与 run implement 同一 start 流程），返回 launch 已确认的状态。
        const resumed = await core(["run", "resume", params.runId, "--dir", root]);
        const newRunId = resumed.response?.data?.request?.runId;
        if (params.wait === true && resumed.response?.data?.started === true && typeof newRunId === "string") {
          const status = await waitForRun(newRunId, signal);
          if (resumed.response !== null) resumed.response = { ...resumed.response, data: mergeWaitStatus(resumed.response.data, status) };
        }
        pokeObserver(ctx);
        return toolResult(resumed, (data) => {
          if (data === null || typeof data !== "object") return null;
          const note = waitNote(data);
          if (data.resumed !== true) return `run ${params.runId}: ${data.accepted ? "已接收" : "待处理"}；${data.reason ?? "未新建 run"}${note ? `\n${note}` : ""}`;
          const launch = data.launch?.state ?? "?";
          const lines = [`run ${params.runId} 已恢复为新 run ${data.request?.runId ?? "?"}：启动 ${launch}，准备 ${data.state?.prepared === true}`];
          if (data.launch?.lastError) lines.push(`  原因: ${data.launch.lastError}`);
          if (data.status?.state) lines.push(`  终态: ${data.status.state}${data.status.result?.state ? `（结果 ${data.status.result.state}）` : ""}`);
          if (note !== null) lines.push(`  ${note}`);
          return lines.join("\n");
        });
      }
      if (params.action === "cancel") {
        if (!params.runId || safeId(params.runId, "run-") === null) return failText("run cancel 需要合法 runId");
        const result = await core(["run", "cancel", params.runId, "--reason", params.reason ?? "bridge cancel", "--dir", root]);
        pokeObserver(ctx);
        return toolResult(result);
      }
      if (params.action === "accept") {
        // 来源不明路径的确认出口（needs_attention: unattributed_paths）：--include 并入、--exclude 排除，确认人记主会话。
        if (!params.runId || safeId(params.runId, "run-") === null) return failText("run accept 需要合法 runId");
        const args = ["run", "accept", params.runId, "--dir", root];
        const include = Array.isArray(params.include) ? params.include.filter((path: unknown) => typeof path === "string" && path !== "") : [];
        const exclude = Array.isArray(params.exclude) ? params.exclude.filter((path: unknown) => typeof path === "string" && path !== "") : [];
        if (include.length > 0) args.push("--include", ...include);
        if (exclude.length > 0) args.push("--exclude", ...exclude);
        if (include.length > 0 || exclude.length > 0) {
          args.push("--by", state.nativeSessionId ? `pi:${state.nativeSessionId}` : "pi");
          if (typeof params.reason === "string" && params.reason !== "") args.push("--reason", params.reason);
        }
        return toolResult(await core(args));
      }
      if (params.action === "check" && Array.isArray(params.scope) && params.scope.length > 0) {
        const args = ["run", "check", "--scope", ...params.scope, "--dir", root];
        if (provider) args.push("--provider", provider);
        if (modelId) args.push("--model", modelId);
        return toolResult(await core(args));
      }
      if (!params.taskId || safeId(params.taskId, "k-") === null) return failText(`${params.action} 需要合法 taskId`);
      // 阶段动作统一走 prepare + start：action 不在配置中时由核心返回合法阶段清单。
      const common = ["--task", params.taskId, "--client", "pi", "--native", state.nativeSessionId ?? "", "--dir", root];
      if (provider) common.push("--provider", provider);
      if (modelId) common.push("--model", modelId);
      if (params.resumeSession) common.push("--resume-session", params.resumeSession);
      if (params.newRepairCycle === true) common.push("--new-repair-cycle");
      const prepared = await core(["run", "prepare", "--stage", String(params.action), ...common]);
      if (prepared.code !== 0 || prepared.response?.outcome !== "completed") return toolResult(prepared);
      const runId = prepared.response?.data?.request?.runId;
      if (typeof runId !== "string") return failText(`Knit 未返回 runId（action=${params.action}）`);
      pokeObserver(ctx);
      const started = await core(["run", "start", runId, "--dir", root]);
      if (started.code !== 0 || started.response?.outcome !== "completed") return toolResult(started);
      pokeObserver(ctx);
      let data: any = { ...(prepared.response?.data ?? {}), ...(started.response?.data ?? {}) };
      if (params.wait === true) {
        const status = await waitForRun(runId, signal);
        data = mergeWaitStatus(data, status);
      }
      const taskStatus = await core(["status", params.taskId, "--dir", root]);
      const taskData = taskStatus.code === 0 && taskStatus.response?.outcome === "completed" ? taskStatus.response.data : null;
      void refreshTurnContext(ctx);
      return toolResult({ code: 0, response: { ...prepared.response, data }, stderr: started.stderr }, (resultData) => {
        const stage = typeof taskData?.stageName === "string" && taskData.stageName !== "" ? taskData.stageName : stageNameOf(String(params.action));
        const header = `任务：${taskLabel({ ...(taskData ?? {}), taskId: params.taskId })}（阶段：${stageText(stage, String(params.action), "space")}）`;
        const runInfo = typeof resultData?.request?.runId === "string"
          ? `run ${resultData.request.runId}: ${resultData?.launch?.state ?? resultData?.state ?? "已准备"}`
          : "";
        const note = waitNote(resultData);
        return [header, runInfo, note ?? "", JSON.stringify(resultData)].filter((line) => line !== "").join("\n");
      });
    },
  });

  /** knit_workflow 的 tools 参数 → CLI 能力参数：字符串原样（如 all），空数组为 []（全部禁用）。 */
  const toolsArg = (tools: unknown): string => {
    if (typeof tools === "string") return tools;
    if (Array.isArray(tools)) return tools.length === 0 ? "[]" : tools.map(String).join(",");
    return String(tools);
  };

  registerTool({
    name: "knit_workflow",
    label: "Knit workflow",
    description: "读取、校验或修改 .knit/workflow.yaml；写入先全量校验，失败带 YAML 行号。",
    parameters: schema("workflow"),
    async execute(_toolCallId: string, params: any) {
      const action = String(params.action);
      const args = ["workflow", action, "--dir", root];
      if (action === "init") {
        if (params.force === true) args.push("--force");
        return toolResult(await core(args));
      }
      if (action === "show" || action === "validate") return toolResult(await core(args));
      const id = safeStageId(params.stageId);
      if (id === null) return failText(`knit_workflow ${action} 需要合法 stageId`);
      args.push(id);
      if (action === "add") {
        if (params.name) args.push("--name", params.name);
        if (params.description) args.push("--description", params.description);
        if (params.prompt) args.push("--prompt", params.prompt);
        if (params.before) args.push("--before", params.before);
        if (params.after) args.push("--after", params.after);
        if (params.maxVisits !== undefined) args.push("--max-visits", String(params.maxVisits));
        if (params.tools !== undefined) args.push("--tools", toolsArg(params.tools));
        if (params.report && typeof params.report === "object") {
          for (const [field, type] of Object.entries(params.report)) args.push("--report", `${field}:${String(type)}`);
        }
      } else if (action === "move") {
        if (params.position !== undefined) args.push(String(params.position));
        if (params.before) args.push("--before", params.before);
        if (params.after) args.push("--after", params.after);
      } else if (action === "set-prompt") {
        if (params.clear === true) args.push("--clear");
        else if (params.prompt) args.push(params.prompt);
      } else if (action === "set-tools") {
        if (params.clear === true) args.push("--clear");
        // all = 全部放开；[] = 全部禁用；非空数组 = 白名单；clear = 删除字段（等同全部放开）。
        else if (params.tools !== undefined) args.push(toolsArg(params.tools));
      } else if (action === "set-report") {
        if (!params.field) return failText("knit_workflow set-report 需要 field");
        args.push(params.field);
        if (params.clear === true) args.push("--clear");
        else if (params.type) args.push(params.type);
      } else if (action === "set-next") {
        if (params.clear === true) args.push("--clear");
        else {
          if (!params.value || !params.target) return failText("knit_workflow set-next 需要 value 与 target");
          args.push(params.value, params.target);
        }
      }
      return toolResult(await core(args));
    },
  });

  registerTool({
    name: "knit_deliver",
    label: "Knit deliver",
    description: "按完整分支与授权来源交付、预检或归档；支持多个已完成任务逐项收尾。Agent 交付必须声明 authorizationRef；用户授权写 user:<本会话用户消息条目 ID> 或 user:sha256:<消息正文摘要前 12+ 位>，核心按本会话原生记录核对。",
    parameters: schema("deliver"),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
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
      // 桥接路径的非 plan 动作一律把本会话原生记录交给核心：凡非项目策略来源的引用（user:／native:／message:／自由文本）
      // 都按真实用户消息核对（条目 ID 或正文摘要），回执记 caller: bridge。
      // 取不到会话文件时只接受项目策略来源（workflow:／文件#章节／.md），用户类引用直接拒绝，不降级为 cli-unverified。
      if (params.action !== "plan") {
        const sessionFile = typeof ctx?.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
        if (typeof sessionFile === "string" && sessionFile !== "") {
          args.push("--session-file", sessionFile);
        } else if (typeof params.authorizationRef === "string" && userTypeAuthorizationRef(params.authorizationRef)) {
          return failText("authorization_unverified: 当前会话没有原生记录文件，无法核对用户类授权引用（user:／native:／message:／自由文本）");
        }
      }
      if (params.retry === true) args.push("--retry");
      if (params.messageFile !== undefined) {
        if (params.action === "archive") return failText("archive 不接受提交文案；文案只用于产物提交");
        const messageFiles = Array.isArray(params.messageFile) ? params.messageFile : [params.messageFile];
        for (const value of messageFiles) args.push("--message-file", String(value));
      }
      return toolResult(await core(args), deliveryNotice);
    },
  });

  /** 交付结果无产物提交时把提示放在最前（审计 F4），其余仍是完整 JSON。 */
  function deliveryNotice(data: any): string | null {
    const results: any[] = Array.isArray(data?.results) ? data.results.map((item: any) => item?.result) : [data];
    const notes = results
      .filter((result) => result?.noArtifactCommit === true)
      .map((result) => `${result.taskId}：${result.noArtifactNotice ?? "本次交付没有产物提交"}`);
    if (notes.length === 0) return null;
    return [...notes, JSON.stringify({ outcome: "completed", data })].join("\n");
  }

  registerTool({
    name: "knit_snapshot",
    label: "Knit snapshot",
    description: "只读对照实施快照；提供 expect 后才按路径恢复，可显式恢复 index 或删除后来新建路径。",
    parameters: schema("snapshot"),
    async execute(_toolCallId: string, params: any) {
      if (safeId(params.runId, "run-") === null) return failText(`非法 runId: ${params.runId}`);
      const args = ["snapshot", params.action, params.runId, "--dir", root];
      if (params.action === "show") {
        if (params.path) args.push("--path", params.path);
        return toolResult(await core(args));
      }
      const paths: string[] = Array.isArray(params.paths) ? params.paths : params.path ? [params.path] : [];
      if (paths.length === 0) return failText("snapshot restore 需要 paths");
      for (const path of paths) args.push("--path", path);
      if (params.index === true) args.push("--index");
      if (params.removeCreated === true) args.push("--remove-created");
      if (params.expect && typeof params.expect === "object") {
        for (const [path, fingerprint] of Object.entries(params.expect)) args.push("--expect", `${path}=${String(fingerprint)}`);
      }
      return toolResult(await core(args));
    },
  });

  registerTool({
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
      return toolResult(await core(args));
    },
  });

  return { execKnit, installationReady, state };
}
