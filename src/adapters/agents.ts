import type { AgentAdapter } from "../contracts/agent.js";
import type { AgentName, ToolCapability } from "../contracts/workflow.js";
import { AntigravityExecutionAdapter, cleanAgyRuntime } from "./antigravity/execution.js";
import { agyPreflight } from "./antigravity/isolation.js";
import { PiExecutionAdapter, piSessionDefaults } from "./pi/execution.js";

interface BuiltinAgent {
  createAdapter(): AgentAdapter;
  sessionDefaults(): { readonly model: string | null; readonly thinking: string | null };
  checkDispatch?(root: string, cwd: string, branch: string, capabilities: readonly ToolCapability[] | null): string | null;
  cleanRun?(cwd: string, dir: string): void;
}

export const builtinAgents: Readonly<Record<AgentName, BuiltinAgent>> = {
  pi: {
    createAdapter: () => new PiExecutionAdapter(process.env.KNIT_PI_BIN ?? "pi"),
    sessionDefaults: piSessionDefaults,
  },
  antigravity: {
    createAdapter: () => new AntigravityExecutionAdapter(),
    sessionDefaults: () => ({ model: null, thinking: null }),
    checkDispatch: agyPreflight,
    cleanRun: cleanAgyRuntime,
  },
};
