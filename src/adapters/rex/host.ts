/**
 * Rex CLI 宿主封装（本任务 design.md S3）。
 *
 * 只调用 rex 公开 CLI：`rex api list --json`、`rex api call ...`、`rex api events ...`。
 * 能力探测在创建浮层前完成；缺失必需方法直接报错，不降级模拟 UI。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RexExecResult {
  stdout: string;
  stderr?: string;
}

export type RexExec = (args: string[], options: { timeoutMs: number }) => Promise<RexExecResult>;

export interface RexEventWatch {
  stop(): void;
}

export type RexWatchFactory = (args: string[], onChange: () => void) => RexEventWatch;

export interface RexApiOptions {
  executable?: string;
  /** Rex server 定位；缺省使用本机默认连接。 */
  server?: string | null;
  /** Rex session；方法参数与 events 订阅共用。 */
  session?: string | null;
  /** 单次 API 调用超时。 */
  timeoutMs?: number;
  /** 测试注入：替换 rex 进程调用。 */
  exec?: RexExec;
  /** 测试注入：替换 events 子进程。 */
  watch?: RexWatchFactory;
}

export interface RexLayer {
  layerId: string | null;
  blockIds: Array<string | null>;
  revision: number;
}

export interface RexBlock {
  blockId: string;
  label: string;
  windowId: string | null;
}

export interface RexLayerView {
  layerId: string;
  kind: string;
  state: string | null;
  blockIds: string[];
}

export interface RexView {
  layers: RexLayerView[];
}

export interface RexLayerSpec {
  windowId?: string | null;
  bounds: [number, number, number, number];
  focus?: boolean;
  label: string;
  command: string[];
  cwd: string;
  pathPrepend?: string[];
  size?: { columns: number; rows: number };
  onCompletion?: boolean;
}

export const REX_REQUIRED_METHODS = [
  "session.new_layer",
  "session.set_layer_state",
  "session.float_block",
  "session.view",
  "session.list_blocks",
  "session.describe_block",
  "session.close_layer",
] as const;

export class RexCapabilityError extends Error {
  constructor(readonly method: string) {
    super(`当前 Rex server 缺少必需方法：${method}`);
    this.name = "RexCapabilityError";
  }
}

export class RexApi {
  readonly executable: string;
  readonly server: string | null;
  readonly session: string | null;
  private readonly timeoutMs: number;
  private readonly exec: RexExec;
  private readonly watchFactory: RexWatchFactory;
  private checked: Promise<void> | null = null;

  constructor(options: RexApiOptions = {}) {
    this.executable = options.executable ?? "rex";
    this.server = options.server ?? null;
    this.session = options.session ?? null;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.exec = options.exec ?? defaultExec(this.executable);
    this.watchFactory = options.watch ?? defaultWatch(this.executable);
  }

  /** 基础参数在所有子命令前保持稳定，避免调用点各自拼 timeout／server。 */
  private base(): string[] {
    return [
      "--autostart=false",
      "--timeout",
      "10s",
      ...(this.server === null ? [] : ["--server", this.server]),
    ];
  }

  async listMethods(): Promise<Set<string>> {
    const { stdout } = await this.exec([...this.base(), "api", "list", "--json"], {
      timeoutMs: this.timeoutMs,
    });
    const parsed = JSON.parse(stdout) as unknown;
    const methods =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { methods?: unknown }).methods)
        ? ((parsed as { methods: Array<{ name?: unknown }> }).methods)
        : [];
    return new Set(
      methods
        .map((method) => method.name)
        .filter((name): name is string => typeof name === "string" && name !== ""),
    );
  }

  /** 能力探测缺方法立即失败；成功结果缓存，避免每次调用都 list。 */
  async check(required: readonly string[] = REX_REQUIRED_METHODS): Promise<void> {
    this.checked ??= (async () => {
      const methods = await this.listMethods();
      for (const method of required) {
        if (!methods.has(method)) throw new RexCapabilityError(method);
      }
    })();
    return this.checked;
  }

  private usesSession(method: string): boolean {
    return method.startsWith("session.") || method.startsWith("block.") || method.startsWith("com.");
  }

  async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const payload = {
      ...args,
      ...(this.usesSession(method) && this.session !== null ? { session_id: this.session } : {}),
    };
    const { stdout } = await this.exec([...this.base(), "api", "call", method, JSON.stringify(payload)], {
      timeoutMs: this.timeoutMs,
    });
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new Error(`Rex 方法 ${method} 的响应不是合法 JSON`);
    }
  }

  async newLayer(spec: RexLayerSpec): Promise<RexLayer> {
    const payload: Record<string, unknown> = {
      bounds: spec.bounds,
      focus: spec.focus ?? false,
      ...(spec.windowId === undefined || spec.windowId === null ? {} : { window_id: spec.windowId }),
      layout: {
        block: {
          flavor: "com.superlogical.terminal.shell",
          label: spec.label,
          options: {
            command: spec.command,
            cwd: spec.cwd,
            ...(spec.pathPrepend === undefined ? {} : { path_prepend: spec.pathPrepend }),
            ...(spec.size === undefined ? {} : { size: spec.size }),
            exit: { on_completion: spec.onCompletion ?? false },
          },
        },
      },
    };
    const result = await this.call<{
      layer_id?: unknown;
      block_ids?: unknown;
      revision?: unknown;
    }>("session.new_layer", payload);
    return {
      layerId: typeof result.layer_id === "string" ? result.layer_id : null,
      blockIds: Array.isArray(result.block_ids)
        ? result.block_ids.map((value) => (typeof value === "string" ? value : null))
        : [],
      revision: typeof result.revision === "number" ? result.revision : 0,
    };
  }

  async setLayerState(layerId: string, state: "normal" | "minimized", focus = false): Promise<void> {
    await this.call("session.set_layer_state", {
      layer_id: layerId,
      state,
      ...(focus ? { focus: true } : {}),
    });
  }

  async floatBlock(blockId: string, bounds: [number, number, number, number]): Promise<string | null> {
    const result = await this.call<{ layer_id?: unknown }>("session.float_block", {
      block_id: blockId,
      bounds,
    });
    return typeof result.layer_id === "string" ? result.layer_id : null;
  }

  async view(): Promise<RexView> {
    const result = await this.call<{
      windows?: Array<{ layers?: Array<{ layer_id?: unknown; kind?: unknown; state?: unknown; blocks?: Array<{ block_id?: unknown }> }> }>;
    }>("session.view");
    const layers: RexLayerView[] = [];
    for (const window of result.windows ?? []) {
      for (const layer of window.layers ?? []) {
        if (typeof layer.layer_id !== "string") continue;
        layers.push({
          layerId: layer.layer_id,
          kind: typeof layer.kind === "string" ? layer.kind : "unknown",
          state: typeof layer.state === "string" ? layer.state : null,
          blockIds: (layer.blocks ?? [])
            .map((block) => block.block_id)
            .filter((value): value is string => typeof value === "string"),
        });
      }
    }
    return { layers };
  }

  async listBlocks(): Promise<RexBlock[]> {
    const result = await this.call<{ blocks?: Array<{ block_id?: unknown; label?: unknown; window_id?: unknown }> | null }>(
      "session.list_blocks",
    );
    return (result.blocks ?? [])
      .filter((block) => typeof block.block_id === "string")
      .map((block) => ({
        blockId: block.block_id as string,
        label: typeof block.label === "string" ? block.label : "",
        windowId: typeof block.window_id === "string" ? block.window_id : null,
      }));
  }

  async describeBlock(blockId: string): Promise<{ windowId: string | null; label: string | null; hostId: string | null }> {
    const result = await this.call<{ block?: { window_id?: unknown; label?: unknown; host_id?: unknown } }>(
      "session.describe_block",
      { block_id: blockId },
    );
    return {
      windowId: typeof result.block?.window_id === "string" ? result.block.window_id : null,
      label: typeof result.block?.label === "string" ? result.block.label : null,
      hostId: typeof result.block?.host_id === "string" ? result.block.host_id : null,
    };
  }

  /**
   * 读取块内进程终态。该方法在本机以 block.method 暴露，不一定出现在 api list；
   * 调用失败由调用方按未知／已退出处理，不能当作成功。
   */
  async process(blockId: string): Promise<{ lastExit: unknown; running: boolean }> {
    const result = await this.call<{ last_exit?: unknown }>("com.superlogical.terminal.process", {
      block_id: blockId,
      args: {},
    });
    const lastExit = result.last_exit ?? null;
    return { lastExit, running: lastExit === null };
  }

  async closeLayer(layerId: string): Promise<void> {
    await this.call("session.close_layer", { layer_id: layerId });
  }

  /**
   * 读取块内终端屏幕与回滚（`rex capture`）；只用于启动失败诊断，内容不进入业务证据。
   * Rex 浮层内 Pi 的 stderr 直接写在终端里，这是它唯一可读的来源。
   */
  async capture(blockId: string): Promise<string> {
    const { stdout } = await this.exec(
      [...this.base(), "capture", "-b", blockId, ...(this.session === null ? [] : ["-s", this.session]), "--trim"],
      { timeoutMs: this.timeoutMs },
    );
    return stdout;
  }

  /** 订阅 Rex 事件；任何事件都只是触发重新核对，不被当作业务终态。 */
  watch(onChange: () => void): RexEventWatch {
    return this.watchFactory(
      [...this.base(), "events", ...(this.session === null ? [] : ["-s", this.session]), "--json"],
      onChange,
    );
  }
}

function defaultExec(executable: string): RexExec {
  return async (args, { timeoutMs }) => {
    const result = await execFileAsync(executable, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
}

function defaultWatch(executable: string): RexWatchFactory {
  return (args, onChange) => {
    const child: ChildProcess = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.on("data", onChange);
    child.on("error", () => {});
    return {
      stop: () => {
        child.kill();
      },
    };
  };
}
