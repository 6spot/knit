/** 执行者的后台进程。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { procStartTicks, sameProcessStart } from "../infrastructure/process.js";
import { RUNS_DIR } from "./run-prepare.js";

/** 这次执行的后台进程还在时返回它的进程号，不在时是 null。 */
export function liveWorker(root: string, runId: string): number | null {
  const file = join(root, RUNS_DIR, runId, "worker.json");
  if (!existsSync(file)) return null;
  const worker = JSON.parse(readFileSync(file, "utf8")) as { pid: number; start: string | null };
  const current = procStartTicks(worker.pid);
  // 进程号会被别的进程重新用上，启动标识一样才是原来那个。
  return worker.start !== null && current !== null && sameProcessStart(worker.start, current) ? worker.pid : null;
}
