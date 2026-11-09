/**
 * Rex 阶段启动器（本任务 design.md S3）。
 *
 * StageRunner 在输入冻结与快照 ready 后进入本模块：
 *   1. 能力探测 Rex server；
 *   2. 已有 rex.json 时先做恢复发现（label 匹配、进程存活、身份一致），不重复建浮层；
 *   3. 新建浮层，命令为 Pi TUI + worker 扩展，环境经 /usr/bin/env 注入；
 *   4. 写 rex.json 与 rex/ 私有事实，订阅 bridge 状态、rex events 与 state.json 兜底；
 *   5. 返回最后 assistant 文本、sessionFile、pid 与 outcome，后续报告校验/接收仍走 StageRunner。
 *
 * 终态由 StageRunner 调用 closeLayer() 关闭本次浮层；terminate() 只保留取消／失败的终止语义，
 * 两者共用同一套 rex.json 关联解析且幂等。本模块不写核心 state/result，不改变验收资格；失败只以返回值表达。
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeClient,
  RexApi,
  parseRexWorkerState,
  readLatestRexWorkerResult,
  readRexAssociation,
  readRexWorkerManifest,
  readRexWorkerState,
  rexAssociationPath,
  rexDirectory,
  rexManifestPath,
  rexSocketPathFor,
  rexStatePath,
  writeRexAssociation,
  writeRexWorkerManifest,
  writeRexPrompt,
  type RexAssociation,
  type RexWorkerManifest,
  type RexWorkerResult,
  type RexWorkerState,
} from "../adapters/rex/index.js";
import { type PiProcessExit } from "../adapters/pi/index.js";
import type { RunPhase, RunUsage } from "../contracts/run.js";
import type { ToolCapability } from "../contracts/workflow.js";
import { capabilitySwitches } from "../adapters/pi/runtime.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { procStartTicks, processTreePids, signalProcessTree } from "../infrastructure/process.js";

export const REX_DEFAULT_BOUNDS: [number, number, number, number] = [0.52, 0.48, 0.46, 0.48];
export const REX_LABEL_PREFIX = "knit ";
const UNKNOWN_USAGE: RunUsage = { inputTokens: null, outputTokens: null };

export interface RexPiCommandInput {
  executablePath: string;
  sessionId: string;
  sessionFile: string | null;
  sessionDir: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  /** 工具 allowlist；null 表示不限制。 */
  tools: string[] | null;
  toolAdditions?: string[];
  excludeTools?: string[];
  /** 阶段能力；null 表示全部放开。 */
  capabilities?: readonly ToolCapability[] | null;
  /** task 能力需要的项目扩展路径。 */
  toolExtensionPaths?: string[];
  systemPrompt: string;
  extensionPath: string;
  manifestPath: string;
  runId: string;
  agentDir?: string;
}

/** label 带 run ID，list_blocks 可无状态恢复发现；截断不超过 Rex 的 60 字符。 */
export function rexLabel(runId: string): string {
  return `${REX_LABEL_PREFIX}${runId}`.slice(0, 60);
}

export function defaultRexWorkerExtensionPath(): string {
  const compiled = fileURLToPath(new URL("../adapters/rex/worker-extension.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  // 双注册：编译产物缺失时回退到 assets 模板 loader（仍只执行同一份实现）。
  return fileURLToPath(new URL("../../assets/templates/pi/extensions/knit-rex-worker.ts", import.meta.url));
}

/**
 * Pi TUI 命令。环境经 /usr/bin/env 注入，因为 session.new_layer 的 terminal options
 * 只接收 command/cwd/path_prepend，不接收 env；同时用 -u 清除主会话 PI_* 变量。
 */
export function buildRexPiArgs(input: RexPiCommandInput): string[] {
  const switches = capabilitySwitches(input.capabilities);
  const envArgs = [
    "/usr/bin/env",
    "-u",
    "PI_SESSION_ID",
    "-u",
    "PI_SESSION_FILE",
    "-u",
    "PI_PROVIDER",
    "-u",
    "PI_MODEL",
    "-u",
    "PI_REASONING_LEVEL",
    "-u",
    "PI_OFFLINE",
    "PI_KNIT_REX_WORKER=1",
    `PI_KNIT_REX_MANIFEST=${input.manifestPath}`,
    `KNIT_RUN=${input.runId}`,
    ...(switches.offline ? ["PI_OFFLINE=1"] : []),
    "PI_SKIP_VERSION_CHECK=1",
    "PI_TELEMETRY=0",
    ...(input.agentDir === undefined ? [] : [`PI_CODING_AGENT_DIR=${input.agentDir}`]),
  ];
  const args: string[] = [
    "--mode",
    "text",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-approve",
  ];
  if (switches.offline) args.push("--offline");
  if (!switches.mcp) args.push("--no-mcp");
  if (!switches.skills) args.push("--no-skills");
  if (!switches.extensions) args.push("--no-extensions");
  args.push("--extension", input.extensionPath);
  for (const extensionPath of input.toolExtensionPaths ?? []) args.push("--extension", extensionPath);
  args.push("--session-dir", input.sessionDir);
  if (input.sessionFile !== null) {
    args.push("--session", input.sessionFile);
  } else {
    args.push("--session-id", input.sessionId, "--name", "Knit Rex worker");
  }
  args.push("--provider", input.provider, "--model", input.modelId);
  if (input.toolAdditions !== undefined && input.toolAdditions.length > 0) {
    args.push("--tools", input.toolAdditions.map((name) => `+${name}`).join(","));
  } else if (input.tools === null) {
    // 全部放开：不传 --tools，也不传 --no-tools。
  } else if (input.tools.length > 0) args.push("--tools", input.tools.join(","));
  else args.push("--no-tools");
  if (input.excludeTools !== undefined && input.excludeTools.length > 0) {
    args.push("--exclude-tools", input.excludeTools.join(","));
  }
  if (input.thinkingLevel !== undefined) args.push("--thinking", input.thinkingLevel);
  args.push("--append-system-prompt", input.systemPrompt);
  return [...envArgs, input.executablePath, ...args];
}

export interface RexLauncherOptions {
  root: string;
  runId: string;
  taskId: string;
  phase: RunPhase;
  sessionId: string;
  sessionFile?: string | null;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  tools: string[] | null;
  toolAdditions?: string[];
  excludeTools?: string[];
  capabilities?: readonly ToolCapability[] | null;
  toolExtensionPaths?: string[];
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  sessionDir: string;
  executablePath: string;
  extensionPath?: string;
  agentDir?: string;
  /** Rex 定位；缺省读 REX_SESSION／REX_SERVER／REX_BLOCK（主会话在 Rex 内时由宿主注入）。 */
  rexSession?: string | null;
  rexServer?: string | null;
  parentBlockId?: string | null;
  windowId?: string | null;
  bounds?: [number, number, number, number];
  /** 测试注入或复用宿主连接。 */
  rex?: RexApi;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  /** settle 后是否请求 Pi 关闭；阶段默认关闭 Pi、保留浮层输出。 */
  closeOnSettle?: boolean;
  /** 取消后等待 worker 自行退出的宽限；超时关闭浮层并终止进程。 */
  cancelGraceMs?: number;
  /** 启动期等待 worker 状态／bridge 的上限；不是阶段总时限。 */
  startupTimeoutMs?: number;
  bridgeConnectTimeoutMs?: number;
  pollIntervalMs?: number;
  onPid?: (pid: number | null) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface RexExecution {
  /** agent_settled 结果已落盘才为 true；进程退出但无结果时 false。 */
  settled: boolean;
  aborted: boolean;
  exit: PiProcessExit | null;
  text: string;
  sessionFile: string | null;
  pid: number | null;
  usage: RunUsage;
  result: RexWorkerResult | null;
  /** 非 null 表示 Worker 自身错误（宿主仍按 failed 处理）。 */
  failure: string | null;
}

type RexDiscovery =
  | { state: "missing"; association: RexAssociation | null }
  | { state: "completed"; association: RexAssociation | null; result: RexWorkerResult }
  | { state: "attached"; association: RexAssociation; client: BridgeClient | null; workerState: RexWorkerState | null }
  | { state: "exited"; association: RexAssociation; workerState: RexWorkerState | null }
  | { state: "ambiguous"; association: RexAssociation; matches: number }
  | { state: "identity_mismatch"; association: RexAssociation; detail: string };

export class RexLauncher {
  private readonly root: string;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly phase: RunPhase;
  private readonly sessionId: string;
  private readonly resumeSessionFile: string | null;
  private readonly provider: string;
  private readonly modelId: string;
  private readonly thinkingLevel: string | undefined;
  private readonly tools: string[] | null;
  private readonly toolAdditions: string[];
  private readonly excludeTools: string[];
  private readonly capabilities: readonly ToolCapability[] | null | undefined;
  private readonly toolExtensionPaths: string[];
  private readonly systemPrompt: string;
  private readonly userPrompt: string;
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly executablePath: string;
  private readonly extensionPath: string;
  private readonly agentDir: string | undefined;
  private readonly parentBlockId: string | null;
  private readonly windowId: string | null;
  private readonly bounds: [number, number, number, number];
  private readonly rex: RexApi;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;
  private readonly closeOnSettle: boolean;
  private readonly cancelGraceMs: number;
  private readonly startupTimeoutMs: number;
  private readonly bridgeConnectTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly onPid: ((pid: number | null) => void) | null;
  private readonly sleep: (ms: number) => Promise<void>;

  private manifest: RexWorkerManifest | null = null;
  private association: RexAssociation | null = null;
  private client: BridgeClient | null = null;
  private latestState: RexWorkerState | null = null;
  private watch: { stop(): void } | null = null;
  private wake: (() => void) | null = null;
  private stopRequestedAt: number | null = null;
  private terminated = false;
  private layerClosed = false;
  private bridgeClosed = false;

  constructor(options: RexLauncherOptions) {
    this.root = options.root;
    this.runId = options.runId;
    this.taskId = options.taskId;
    this.phase = options.phase;
    this.sessionId = options.sessionId;
    this.resumeSessionFile = options.sessionFile ?? null;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.thinkingLevel = options.thinkingLevel;
    this.tools = options.tools;
    this.toolAdditions = options.toolAdditions ?? [];
    this.excludeTools = options.excludeTools ?? [];
    this.capabilities = options.capabilities;
    this.toolExtensionPaths = options.toolExtensionPaths ?? [];
    this.systemPrompt = options.systemPrompt;
    this.userPrompt = options.userPrompt;
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.executablePath = options.executablePath;
    this.extensionPath = options.extensionPath ?? defaultRexWorkerExtensionPath();
    this.agentDir = options.agentDir;
    this.parentBlockId = options.parentBlockId ?? process.env.REX_BLOCK ?? null;
    this.windowId = options.windowId ?? null;
    this.bounds = options.bounds ?? REX_DEFAULT_BOUNDS;
    this.rex =
      options.rex ??
      new RexApi({
        session: options.rexSession ?? process.env.REX_SESSION ?? null,
        server: options.rexServer ?? process.env.REX_SERVER ?? null,
      });
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes) => nodeRandomBytes(bytes).toString("hex"));
    this.closeOnSettle = options.closeOnSettle ?? true;
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.bridgeConnectTimeoutMs = options.bridgeConnectTimeoutMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
    this.onPid = options.onPid ?? null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get runDirectory(): string {
    return join(this.root, ".knit", ".runtime", "runs", this.runId);
  }

  private get rexDirectory(): string {
    return rexDirectory(this.runDirectory);
  }

  private get label(): string {
    return rexLabel(this.runId);
  }

  /** 执行阶段；恢复发现优先于新建，避免同一 label 出现两个浮层。 */
  async execute(): Promise<RexExecution> {
    const discovery = await this.discover();
    if (discovery.state === "completed") {
      this.association = discovery.association;
      return this.executionFromResult(discovery.result, this.latestState);
    }
    if (discovery.state === "attached") {
      this.association = discovery.association;
      this.client = discovery.client;
      if (discovery.workerState !== null) this.noteState(discovery.workerState);
      if (this.client === null) {
        try {
          this.client = await this.connectBridge(this.association.socketPath);
        } catch {
          this.client = null;
        }
      }
      this.startWatch();
      return this.waitForTerminal(this.association);
    }
    if (discovery.state === "ambiguous") {
      throw new InfrastructureError("io_error", `Rex 浮层 label ${this.label} 匹配到 ${discovery.matches} 个块，拒绝冒认`, {
        label: this.label,
      });
    }
    if (discovery.state === "identity_mismatch") {
      throw new InfrastructureError("io_error", `Rex 浮层身份不符：${discovery.detail}`);
    }
    if (discovery.state === "exited") {
      if (discovery.association !== null) this.association = discovery.association;
      return this.executionFromExit(discovery.workerState);
    }
    try {
      return await this.createAndWait();
    } catch (error) {
      // 新建浮层后任何装配失败都清理本次自有对象；不把半成品留给下一次发现。
      await this.terminate().catch(() => {});
      await this.dispose().catch(() => {});
      throw error;
    }
  }

  /** 只读恢复发现；测试与主会话重入可单独调用。 */
  async discover(): Promise<RexDiscovery> {
    const association = readRexAssociation(rexAssociationPath(this.runDirectory));
    const latestResult = readLatestRexWorkerResult(this.rexDirectory);
    if (association === null) {
      if (latestResult !== null) return { state: "completed", association: null, result: latestResult };
      return { state: "missing", association: null };
    }

    const manifest = readRexWorkerManifest(rexManifestPath(this.runDirectory));
    if (
      manifest !== null &&
      (manifest.runId !== association.runId ||
        manifest.sessionId !== association.sessionId ||
        manifest.instance !== association.instance ||
        manifest.label !== association.label)
    ) {
      return { state: "identity_mismatch", association, detail: "manifest 与 rex.json 的 run/session/instance/label 不一致" };
    }

    let blocks: { blockId: string; label: string }[];
    try {
      blocks = await this.rex.listBlocks();
    } catch (error) {
      if (latestResult !== null) return { state: "completed", association, result: latestResult };
      // 查询失败不等于浮层不存在；不据此新建第二个同 label 的块。
      throw new InfrastructureError(
        "io_error",
        `无法列出 Rex 浮层以恢复 ${association.label}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const matches = blocks.filter((block) => block.label === association.label);
    if (matches.length > 1) return { state: "ambiguous", association, matches: matches.length };
    if (matches.length === 0) {
      if (latestResult !== null) return { state: "completed", association, result: latestResult };
      return { state: "missing", association };
    }

    const blockId = matches[0]?.blockId;
    if (blockId === undefined) return { state: "missing", association };
    if (blockId !== association.blockId) {
      this.association = this.updateAssociation(association, { blockId });
      writeRexAssociation(rexAssociationPath(this.runDirectory), this.association);
    } else {
      this.association = association;
    }

    let running: boolean | null = null;
    try {
      running = (await this.rex.process(blockId)).running;
    } catch {
      // 老 server 可能不暴露 block method；由 bridge 连通性继续判断。
    }
    if (running === false) {
      if (latestResult !== null) return { state: "completed", association: this.association ?? association, result: latestResult };
      return {
        state: "exited",
        association: this.association ?? association,
        workerState: readRexWorkerState(rexStatePath(this.runDirectory)),
      };
    }

    const workerState = readRexWorkerState(rexStatePath(this.runDirectory));
    if (workerState !== null && workerState.runId !== association.runId) {
      return { state: "identity_mismatch", association, detail: "state.json runId 与 rex.json 不一致" };
    }
    let client: BridgeClient | null = null;
    try {
      client = await this.connectBridge(association.socketPath, 1_000);
    } catch {
      client = null;
    }
    if (running === null && client === null && latestResult !== null) {
      return { state: "completed", association: this.association ?? association, result: latestResult };
    }
    // 块存在但存活／bridge 暂时不可核实：保持 attached，避免再建一个同 label 的浮层。
    return { state: "attached", association: this.association ?? association, client, workerState };
  }

  private updateAssociation(association: RexAssociation, patch: Partial<RexAssociation>): RexAssociation {
    return { ...association, ...patch, updatedAt: this.now().toISOString() };
  }

  private async createAndWait(): Promise<RexExecution> {
    await this.rex.check();
    // 决定新建时清掉上一次尝试的 result；旧块若仍存活会在 discover 阶段被 attached。
    rmSync(join(this.rexDirectory, "results"), { recursive: true, force: true });
    const manifest = this.prepareManifest();
    this.manifest = manifest;
    const command = buildRexPiArgs({
      executablePath: this.executablePath,
      sessionId: this.sessionId,
      sessionFile: this.resumeSessionFile,
      sessionDir: this.sessionDir,
      provider: this.provider,
      modelId: this.modelId,
      thinkingLevel: this.thinkingLevel,
      tools: this.tools,
      toolAdditions: this.toolAdditions,
      excludeTools: this.excludeTools,
      capabilities: this.capabilities,
      toolExtensionPaths: this.toolExtensionPaths,
      systemPrompt: this.systemPrompt,
      extensionPath: this.extensionPath,
      manifestPath: rexManifestPath(this.runDirectory),
      runId: this.runId,
      agentDir: this.agentDir,
    });

    const windowId =
      this.windowId ??
      (this.parentBlockId === null ? null : (await this.rex.describeBlock(this.parentBlockId)).windowId);
    const created = await this.rex.newLayer({
      windowId,
      bounds: this.bounds,
      focus: false,
      label: this.label,
      command,
      cwd: this.cwd,
      pathPrepend: (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== ""),
      size: { columns: 120, rows: 36 },
      onCompletion: false,
    });
    const blockId = created.blockIds.find((value): value is string => typeof value === "string");
    if (blockId === undefined) {
      throw new InfrastructureError("io_error", "Rex session.new_layer 未返回 block_id");
    }
    let layerId = created.layerId;
    if (layerId === null) layerId = await this.findLayerForBlock(blockId);
    const createdAt = this.now().toISOString();
    const association: RexAssociation = {
      schemaVersion: 1,
      runId: this.runId,
      sessionId: this.sessionId,
      instance: manifest.instance,
      blockId,
      layerId,
      label: this.label,
      socketPath: manifest.socketPath,
      createdAt,
      updatedAt: createdAt,
    };
    this.association = association;
    writeRexAssociation(rexAssociationPath(this.runDirectory), association);
    await this.presentMinimized(layerId, blockId);
    this.startWatch();
    try {
      this.client = await this.connectBridge(association.socketPath);
    } catch {
      // bridge 起不来时仍以 state.json/result 文件兜底；不因此伪造成功。
      this.client = null;
    }
    return this.waitForTerminal(association);
  }

  private prepareManifest(): RexWorkerManifest {
    if (!/^run-[0-9a-f]{12}$/.test(this.runId)) {
      throw new InfrastructureError("io_error", `非法 run ID：${this.runId}`);
    }
    const createdAt = this.now().toISOString();
    const directory = this.rexDirectory;
    const manifest: RexWorkerManifest = {
      schemaVersion: 1,
      runId: this.runId,
      taskId: this.taskId,
      phase: this.phase,
      sessionId: this.sessionId,
      instance: `rex-${this.randomHex(6)}`,
      label: this.label,
      cwd: this.cwd,
      runDirectory: this.runDirectory,
      directory,
      // 路径超过平台 sun_path 上限（macOS 104 字节）时改用 $TMPDIR 短路径；实际值随 manifest／rex.json 记录。
      socketPath: rexSocketPathFor(this.runDirectory),
      promptPath: join(directory, "prompt.txt"),
      statePath: join(directory, "state.json"),
      ownerPath: join(directory, "owner.json"),
      closeOnSettle: this.closeOnSettle,
      createdAt,
    };
    writeRexWorkerManifest(rexManifestPath(this.runDirectory), manifest);
    writeRexPrompt(manifest.promptPath, this.userPrompt);
    return manifest;
  }

  private async findLayerForBlock(blockId: string): Promise<string | null> {
    try {
      const view = await this.rex.view();
      const layer = view.layers.find((candidate) => candidate.blockIds.includes(blockId));
      if (layer === undefined) return null;
      if (layer.kind === "tiled") {
        return await this.rex.floatBlock(blockId, this.bounds);
      }
      return layer.layerId;
    } catch {
      return null;
    }
  }

  private async presentMinimized(layerId: string | null, blockId: string): Promise<void> {
    let target = layerId;
    if (target === null) target = await this.findLayerForBlock(blockId);
    if (target === null) return;
    try {
      await this.rex.setLayerState(target, "minimized");
      if (this.association !== null && this.association.layerId !== target) {
        this.association = this.updateAssociation(this.association, { layerId: target });
        writeRexAssociation(rexAssociationPath(this.runDirectory), this.association);
      }
    } catch {
      // 呈现失败不改变业务结果；浮层仍可由用户手动定位。
    }
  }

  private async connectBridge(socketPath: string, timeoutMs = this.bridgeConnectTimeoutMs): Promise<BridgeClient> {
    const client = await BridgeClient.connect(
      socketPath,
      (raw) => {
        const state = this.parseState(raw);
        if (state !== null) this.noteState(state);
        this.wake?.();
      },
      () => {
        this.bridgeClosed = true;
        this.wake?.();
      },
      timeoutMs,
    );
    this.client = client;
    this.bridgeClosed = false;
    try {
      const status = await client.call("status");
      const state = this.parseState(status);
      if (state !== null) this.noteState(state);
    } catch {
      // 连接成功但 status 未回：继续靠 state.json 与结果文件。
    }
    return client;
  }

  private parseState(raw: unknown): RexWorkerState | null {
    return parseRexWorkerState(raw);
  }

  private noteState(state: RexWorkerState): void {
    this.latestState = state;
    this.onPid?.(state.pid);
  }

  private startWatch(): void {
    if (this.watch !== null) return;
    try {
      this.watch = this.rex.watch(() => {
        this.wake?.();
      });
    } catch {
      this.watch = null;
    }
  }

  private stopWatch(): void {
    this.watch?.stop();
    this.watch = null;
  }

  private async waitForTerminal(association: RexAssociation): Promise<RexExecution> {
    let iteration = 0;
    const startedAt = Date.now();
    for (;;) {
      const result = readLatestRexWorkerResult(this.rexDirectory);
      if (result !== null) return this.executionFromResult(result, this.latestState);

      const fileState = readRexWorkerState(rexStatePath(this.runDirectory));
      if (fileState !== null) this.noteState(fileState);

      // bridge 正常时以状态事件为主；只有断开或没有 bridge 才用 Rex 进程状态兜底。
      // 兜底查询按 pollIntervalMs 节流：这是 spawn 子进程的调用，不能每个 tick 都发。
      if (this.client === null || this.bridgeClosed) {
        try {
          if (this.processFallbackDue(iteration)) {
            const process = await this.rex.process(association.blockId);
            if (!process.running) {
              await this.sleep(50);
              const afterExit = readLatestRexWorkerResult(this.rexDirectory);
              if (afterExit !== null) return this.executionFromResult(afterExit, this.latestState);
              return this.executionFromExit(this.latestState);
            }
          }
        } catch {
          // process 方法不可用时，用块列表兜底；仍然不能仅凭异常宣称退出。
          if (iteration % 10 === 0) {
            try {
              const blocks = await this.rex.listBlocks();
              if (!blocks.some((block) => block.blockId === association.blockId)) {
                const afterDisappear = readLatestRexWorkerResult(this.rexDirectory);
                if (afterDisappear !== null) return this.executionFromResult(afterDisappear, this.latestState);
                return this.executionFromExit(this.latestState);
              }
            } catch {
              // 查询失败按未知处理，继续等待。
            }
          }
        }
      }

      if (this.stopRequestedAt !== null && Date.now() - this.stopRequestedAt >= this.cancelGraceMs) {
        await this.terminate();
        const afterStop = readLatestRexWorkerResult(this.rexDirectory);
        if (afterStop !== null) return this.executionFromResult(afterStop, this.latestState);
        return this.executionFromExit(this.latestState, true);
      }

      // 启动超时只覆盖“worker 从未报到”；阶段本身无总时限，正常跑模型不触发。
      if (this.latestState === null && Date.now() - startedAt >= this.startupTimeoutMs) {
        await this.terminate();
        const late = readLatestRexWorkerResult(this.rexDirectory);
        if (late !== null) return this.executionFromResult(late, this.latestState);
        return { ...this.executionFromExit(null), failure: "rex_worker_not_started" };
      }

      iteration += 1;
      await this.waitTick();
    }
  }

  /**
   * 无 bridge 时的进程状态查询节流：这是 spawn 子进程的 CLI 调用，
   * 约 2 秒一次已足够观察退出；真正的事件仍以 state.json 与结果文件为准。
   */
  private processFallbackDue(iteration: number): boolean {
    const interval = Math.max(1, Math.ceil(2_000 / this.pollIntervalMs));
    return iteration % interval === 0;
  }

  private waitTick(): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, this.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        finish();
      };
    });
  }

  /** 向 worker 注入 steer；不启动模型轮询，只在现有轮次内追加指令。 */
  async steer(message: string): Promise<void> {
    if (this.client === null) throw new InfrastructureError("io_error", "Rex worker bridge 未连接，无法 steer");
    await this.client.call("steer", message);
  }

  /** 最近一次从 bridge／state.json 观察到的 worker 状态。 */
  status(): RexWorkerState | null {
    return this.latestState;
  }

  /** 发送 stop；bridge 不可用时直接关闭浮层并终止自有进程，仍以 cancelled 返回。 */
  async stop(): Promise<void> {
    if (this.stopRequestedAt !== null) return;
    this.stopRequestedAt = Date.now();
    if (this.client !== null) {
      try {
        await this.client.call("stop");
        return;
      } catch {
        // 连接断开：走进程终止兜底。
      }
    }
    await this.terminate();
  }

  /**
   * 终态关闭本 run 的浮层：优先 rex.json 的 layerId，缺失时按 blockId 反查；幂等。
   * closeOnSettle=false 时保留浮层（测试／调试）；关闭失败只忽略，不改变已落盘 run 结果。
   */
  async closeLayer(): Promise<void> {
    if (!this.closeOnSettle) return;
    await this.closeAssociatedLayer();
  }

  /** 关闭与 rex.json 关联的浮层；不按 label 冒认，也不关闭其他窗口或 layer。 */
  private async closeAssociatedLayer(): Promise<void> {
    if (this.layerClosed) return;
    const association = this.association;
    if (association === null) return;
    let layerId = association.layerId;
    if (layerId === null) layerId = await this.findLayerForBlock(association.blockId);
    if (layerId === null) return;
    this.layerClosed = true;
    try {
      await this.rex.closeLayer(layerId);
    } catch {
      // 浮层可能已被用户或 worker 关闭；关闭失败不影响 run 结果。
    }
  }

  /** 终止本 run 的浮层与已记录 Pi 进程；只处理 rex.json/state 记录的自有对象。 */
  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    await this.closeAssociatedLayer();
    const pid = this.latestState?.pid ?? null;
    if (pid !== null && procStartTicks(pid) !== null) {
      const tree = processTreePids(pid);
      if (tree.length > 0) {
        signalProcessTree(pid, "SIGTERM", tree);
        await this.sleep(300);
        signalProcessTree(pid, "SIGKILL", tree);
      }
    }
    this.stopWatch();
    this.client?.close();
    this.client = null;
    const socketPath = this.association?.socketPath ?? this.manifest?.socketPath ?? null;
    if (socketPath !== null) rmSync(socketPath, { force: true });
    rmSync(join(this.rexDirectory, "bridge.sock"), { force: true });
  }

  /** 释放本模块持有的 socket／events 子进程；不改变浮层，也不删除结果。 */
  async dispose(): Promise<void> {
    this.stopWatch();
    this.client?.close();
    this.client = null;
  }

  private executionFromResult(result: RexWorkerResult, state: RexWorkerState | null): RexExecution {
    this.stopWatch();
    return {
      settled: true,
      aborted: result.outcome === "aborted",
      exit: null,
      text: result.text,
      sessionFile: result.sessionFile ?? state?.sessionFile ?? this.resumeSessionFile,
      pid: state?.pid ?? this.latestState?.pid ?? null,
      usage: UNKNOWN_USAGE,
      result,
      failure:
        result.outcome === "error"
          ? result.error ?? "rex_worker_error"
          : result.outcome === "aborted"
            ? "agent_aborted"
            : null,
    };
  }

  private executionFromExit(state: RexWorkerState | null, stopped = false): RexExecution {
    this.stopWatch();
    return {
      settled: false,
      aborted: stopped,
      exit: { code: null, signal: null },
      text: "",
      sessionFile: state?.sessionFile ?? this.latestState?.sessionFile ?? this.resumeSessionFile,
      pid: state?.pid ?? this.latestState?.pid ?? null,
      usage: UNKNOWN_USAGE,
      result: null,
      failure: stopped ? "agent_aborted" : "agent_exited",
    };
  }
}
