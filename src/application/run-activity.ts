/**
 * 任务 run 收敛事实：活动／未知运行与待接收结果。
 * 仅以 run 仓储的终态、结果和验收操作回执判断，不用取消意图或进程句柄冒充完成。
 */
import { RunStore } from "../infrastructure/run-store.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import type { TaskRunActivityPort } from "./task-service.js";

/**
 * 单个 run 是否已收敛为业务事实。
 * completed 终态必须有结果和 completed 接收回执；failed／cancelled 是已裁决终态，
 * 即使接收操作停在 needs_attention 或没有 result，也不再作为任务级未收敛运行。
 * 后续 close／deliver 仍按业务检查、草案和 Git 事实各自守卫，旧失败不会被当成成功回执。
 */
export async function runSettled(store: MetadataStore, runs: RunStore, runId: string, request: { acceptanceOperationId: string }): Promise<boolean> {
  const state = runs.readState(runId);
  if (state === null || !["completed", "cancelled", "failed"].includes(state.state)) return false;
  if (state.state !== "completed") return true;
  let result = null;
  try {
    result = runs.readResult(runId);
  } catch {
    result = null;
  }
  if (result === null) return false;
  const operation = await store.operations.get(request.acceptanceOperationId);
  return operation?.state === "completed";
}

export class RunActivityService implements TaskRunActivityPort {
  private readonly store: MetadataStore;

  constructor(options: { store: MetadataStore }) {
    this.store = options.store;
  }

  async settled(root: string, taskId: string): Promise<boolean> {
    const runs = new RunStore(root);
    for (const runId of runs.listRunIds()) {
      const request = runs.readRequest(runId);
      if (request === null || request.taskId !== taskId) continue;
      if (!(await runSettled(this.store, runs, runId, request))) return false;
    }
    return true;
  }

  async active(root: string, taskId: string): Promise<boolean> {
    return !(await this.settled(root, taskId));
  }
}
