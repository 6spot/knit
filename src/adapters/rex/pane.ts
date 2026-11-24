/** Rex 浮动窗格的命令和行为见 docs/research/REX-PANE.md。 */
import { spawn, spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import type { PaneHost, PaneOptions } from "../../contracts/agent.js";

interface RexPane {
  readonly layerId: string;
  readonly blockId: string;
}

export class RexPaneHost implements PaneHost<RexPane> {
  constructor(private readonly session: string, private readonly block: string) {}

  open(options: PaneOptions): RexPane {
    const { block } = this.call("session.describe_block", { block_id: this.block }) as { block: { window_id: string } };
    const made = this.call("session.new_layer", {
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
            // 窗格里的程序拿到的是 Rex 给的环境，PATH 要这样传。
            path_prepend: (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== ""),
            size: { columns: 120, rows: 36 },
            exit: { on_completion: true },
          },
        },
      },
    }) as { layer_id: string; block_ids: string[] };
    const pane = { layerId: made.layer_id, blockId: made.block_ids[0]! };
    try {
      this.call("session.set_layer_state", { layer_id: pane.layerId, state: "minimized" });
    } catch {
      // 程序已经在跑，最小化不了就让它留在前面。
    }
    return pane;
  }

  waitClosed(pane: RexPane): Promise<void> {
    return new Promise((resolve) => {
      const wait = spawn("rex", ["--autostart=false", "wait", pane.blockId, "-s", this.session], { stdio: "ignore" });
      wait.on("error", () => resolve());
      wait.on("close", () => resolve());
    });
  }

  close(pane: RexPane): void {
    try {
      this.call("session.close_layer", { layer_id: pane.layerId });
    } catch {
      // 已经关掉了。
    }
  }

  private call(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const result = spawnSync(
      "rex",
      ["--autostart=false", "api", "call", method, JSON.stringify({ ...params, session_id: this.session })],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`${method}：${result.error?.message ?? result.stderr.trim()}`);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }
}
