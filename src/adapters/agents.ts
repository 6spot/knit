import type { AgentRegistry } from "../contracts/agent.js";
import { agyWorkspaceCopies, AntigravityExecutionAdapter, cleanAgyRuntime } from "./antigravity/execution.js";
import { agyPreflight } from "./antigravity/isolation.js";
import { PiExecutionAdapter, piSessionDefaults } from "./pi/execution.js";

export const builtinAgents: AgentRegistry = {
  pi: {
    createAdapter: () => new PiExecutionAdapter(process.env.KNIT_PI_BIN ?? "pi"),
    sessionDefaults: piSessionDefaults,
  },
  antigravity: {
    createAdapter: () => new AntigravityExecutionAdapter(),
    sessionDefaults: () => ({ model: null, thinking: null }),
    checkDispatch: agyPreflight,
    cleanRun: cleanAgyRuntime,
    workspaceCopies: agyWorkspaceCopies,
  },
};
