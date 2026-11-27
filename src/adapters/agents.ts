import { checkSchema } from "../contracts/primitives.js";
import { AgentNameSchema, DEFAULT_AGENT } from "../contracts/workflow.js";
import type { AgentRegistry } from "../contracts/agent.js";
import { agyWorkspaceCopies, AntigravityExecutionAdapter, cleanAgyRuntime } from "./antigravity/execution.js";
import { agyPreflight } from "./antigravity/isolation.js";
import { PiExecutionAdapter, piSessionDefaults } from "./pi/execution.js";

export function sessionAgentName() {
  const agent = process.env.KNIT_SESSION_AGENT;
  return checkSchema(AgentNameSchema, agent) ? agent : DEFAULT_AGENT;
}

export function piCommand() {
  return process.env.KNIT_PI_BIN ?? "pi";
}

export const builtinAgents: AgentRegistry = {
  pi: {
    createAdapter: () => new PiExecutionAdapter(piCommand()),
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
