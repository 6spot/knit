import type { AgentLaunch } from "../../contracts/agent.js";
import { runAgyPane } from "./execution.js";

// Rex delivers terminal interrupts to the native client in the same process group.
process.on("SIGINT", () => {});
await runAgyPane(JSON.parse(process.argv[3]!) as AgentLaunch, process.argv[2]!);
