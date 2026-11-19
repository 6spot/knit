/**
 * Rex 的浮动窗格：开一个跑一条命令的窗格、等里面的程序结束、关掉它。
 * 都是运行 PATH 上的 `rex` 命令；用到的方法和它们的表现见docs/research/REX-PANE.md。
 */
import { spawn, spawnSync } from "node:child_process";
import { delimiter } from "node:path";

/** 主会话所在的 Rex 会话和块：环境变量 REX_SESSION、REX_BLOCK。 */
export interface RexHost {
  readonly session: string;
  readonly block: string;
}

export interface RexPane {
  readonly layerId: string;
  readonly blockId: string;
}

/** 调用一个 Rex 方法；失败时抛出，消息是 rex 的标准错误。 */
function call(host: RexHost, method: string, params: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(
    "rex",
    ["--autostart=false", "api", "call", method, JSON.stringify({ ...params, session_id: host.session })],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`${method}：${result.error?.message ?? result.stderr.trim()}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/**
 * 在主会话所在的窗口里开一个浮动窗格跑 `command`，开完就最小化，不抢焦点。开不了时抛出。
 * 程序结束时窗格自己关掉（很快就失败的除外，Rex 会留着它让人看错误）。
 */
export function openPane(
  host: RexHost,
  options: { readonly label: string; readonly command: readonly string[]; readonly cwd: string },
): RexPane {
  const { block } = call(host, "session.describe_block", { block_id: host.block }) as { block: { window_id: string } };
  const made = call(host, "session.new_layer", {
    window_id: block.window_id,
    bounds: [0.52, 0.48, 0.46, 0.48],
    focus: false,
    layout: {
      block: {
        flavor: "com.superlogical.terminal.shell",
        label: options.label,
        options: {
          command: options.command,
          cwd: options.cwd,
          // 窗格里的程序拿到的环境变量是 Rex 给的，PATH 要这样传。
          path_prepend: (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== ""),
          size: { columns: 120, rows: 36 },
          exit: { on_completion: true },
        },
      },
    },
  }) as { layer_id: string; block_ids: string[] };
  const pane = { layerId: made.layer_id, blockId: made.block_ids[0]! };
  try {
    call(host, "session.set_layer_state", { layer_id: pane.layerId, state: "minimized" });
  } catch {
    // 窗格已经开了，程序已经在跑：最小化不了就让它留在前面。
  }
  return pane;
}

/** 等到窗格里的程序结束或者窗格没了。`rex wait` 的退出码分不清这两种情况，不看。 */
export function paneGone(host: RexHost, pane: RexPane): Promise<void> {
  return new Promise((resolve) => {
    const wait = spawn("rex", ["--autostart=false", "wait", pane.blockId, "-s", host.session], { stdio: "ignore" });
    wait.on("error", () => resolve());
    wait.on("close", () => resolve());
  });
}

/** 关掉窗格，里面的程序还在跑的话会被结束；窗格已经不在时什么都不做。 */
export function closePane(host: RexHost, pane: RexPane): void {
  try {
    call(host, "session.close_layer", { layer_id: pane.layerId });
  } catch {
    // 已经关掉了。
  }
}
