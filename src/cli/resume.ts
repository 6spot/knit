/** resume/cancel：按 run 或 operation 恢复、核实与取消（DESIGN.md 第4.1、10节）。 */
import { Command } from "commander";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { RunStore } from "../infrastructure/run-store.js";
import { RunAcceptanceService } from "../application/run-acceptance.js";
import { DeliveryService } from "../application/delivery-service.js";
import { LockManager } from "../infrastructure/locks.js";
import { DeliveryRecordSchema, type DeliveryRecord } from "../contracts/delivery.js";
import { checkSchema } from "../contracts/schema.js";
import { GuardError } from "../application/guard-error.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cliMainRoot } from "./root.js";
import { resolveProjectStart } from "../application/worktree-routing.js";
import { cancelOptions, cancelRun, emitCancel, emitResume, resumeRun } from "./run-control.js";

const RUNTIME_DIR = ".knit/.runtime";

export function registerResumeCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const fail = (requestId: string, error: unknown): void => {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
    else console.error(`knit: ${message}`);
  };

  program
    .command("resume [id]")
    .description("按 run 恢复；按 operation 先核实已有效果后继续同一操作")
    .option("--run <runId>", "旧 run ID")
    .option("--operation <operationId>", "操作 ID")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, options) => {
      const requestId = `resume-${Date.now()}`;
      const runId = options.run ?? (typeof id === "string" && id.startsWith("run-") ? id : undefined);
      const operationId = options.operation ?? (typeof id === "string" && id.startsWith("op-") ? id : undefined);
      const taskId = options.run === undefined && options.operation === undefined && typeof id === "string" && !id.startsWith("run-") && !id.startsWith("op-") ? id : undefined;
      const start = resolveProjectStart(options.dir);
      const store = new SqliteMetadataStore(join(start.mainRoot, RUNTIME_DIR, "metadata.db"));
      try {
        if (runId !== undefined) {
          // 与 `run resume` 共用同一实现（cli/run-control.ts）。
          const result = await resumeRun({ store, mainRoot: start.mainRoot, executionDir: start.executionDir, runId, locks: options.locks });
          emitResume(requestId, jsonMode(), `run ${runId}`, result);
          return;
        }
        if (operationId !== undefined) {
          const operation = await store.operations.get(operationId);
          if (operation === null) throw new GuardError("unknown_operation", `操作不存在: ${operationId}`);
          if (operation.kind === "delivery.deliver" || operation.kind === "delivery.archive") {
            const record = operation as DeliveryRecord;
            if (!checkSchema(DeliveryRecordSchema, record)) throw new GuardError("operation_unsupported", "交付操作记录不完整，不能自动恢复");
            const service = new DeliveryService({ store, locks: new LockManager(options.locks === undefined ? {} : { root: options.locks }) });
            const result = record.mode === "deliver"
              ? await service.deliver({ dir: options.dir, taskId: record.taskId, branch: record.branch, authorizationRef: record.authorizationRef, caller: record.caller, retry: true })
              : await service.archive({ dir: options.dir, taskId: record.taskId, branch: record.branch, authorizationRef: record.authorizationRef, caller: record.caller, retry: true });
            if (jsonMode()) emit(jsonResponse(requestId, result.state === "completed" ? "completed" : "needs_attention", result));
            else console.log(`操作 ${operationId}: ${result.state}${result.reason ? `（${result.reason}）` : ""}`);
            if (result.state !== "completed") process.exitCode = 1;
            return;
          }
          if (operation.kind === "run_acceptance") {
            const runs = new RunStore(start.mainRoot);
            const run = runs.listRunIds().find((candidate) => runs.readRequest(candidate)?.acceptanceOperationId === operationId);
            if (run === undefined) throw new GuardError("unknown_run", `找不到操作 ${operationId} 对应的 run`);
            const result = await new RunAcceptanceService({ store, locks: new LockManager(options.locks === undefined ? {} : { root: options.locks }) }).accept({ dir: start.mainRoot, runId: run });
            if (jsonMode()) emit(jsonResponse(requestId, result.accepted ? "completed" : "needs_attention", result));
            else console.log(`操作 ${operationId}: ${result.accepted ? "已接收" : "待处理"}（${result.reason ?? "无原因"}）`);
            return;
          }
          throw new GuardError("operation_unsupported", `暂不支持恢复操作类型: ${operation.kind}`);
        }
        if (taskId !== undefined) {
          const runs = new RunStore(start.mainRoot);
          const candidates = runs.listRunIds()
            .map((run) => runs.readRequest(run))
            .filter((request): request is NonNullable<typeof request> => request !== null && request.taskId === taskId);
          const latest = candidates.at(-1);
          if (latest === undefined) throw new GuardError("unknown_run", `任务没有可恢复 run: ${taskId}`);
          const result = await resumeRun({ store, mainRoot: start.mainRoot, executionDir: start.executionDir, runId: latest.runId, locks: options.locks });
          emitResume(requestId, jsonMode(), `任务 ${taskId}`, result);
          return;
        }
        throw new GuardError("invalid_request", "resume 需要 run ID、operation ID 或 task ID");
      } catch (error) {
        fail(requestId, error);
      } finally {
        store.close();
      }
    });

  cancelOptions(
    program
      .command("cancel")
      .description("按 run 或 operation 落盘取消意图；--terminate 只终止本 run 已核实的自有进程组")
      .option("--run <runId>", "run ID")
      .option("--operation <operationId>", "操作 ID"),
  )
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = `cancel-${Date.now()}`;
      const root = cliMainRoot(options.dir);
      const store = new SqliteMetadataStore(join(root, RUNTIME_DIR, "metadata.db"));
      try {
        if (options.run !== undefined) {
          // 与 `run cancel` 共用同一实现（cli/run-control.ts）。
          const result = await cancelRun({
            store,
            root,
            runId: options.run,
            reason: options.reason ?? null,
            terminate: options.terminate === true,
          });
          emitCancel(requestId, jsonMode(), options.run, result);
          return;
        }
        if (options.operation !== undefined) {
          const operation = await store.operations.get(options.operation);
          if (operation === null) throw new GuardError("unknown_operation", `操作不存在: ${options.operation}`);
          if (operation.state === "completed" || operation.state === "abandoned") {
            if (jsonMode()) emit(jsonResponse(requestId, "completed", { operationId: operation.operationId, state: operation.state, changed: false }));
            else console.log(`操作 ${operation.operationId} 已是 ${operation.state}，未改变`);
            return;
          }
          if (operation.state !== "planned") {
            throw new GuardError("external_effect_unknown", `操作 ${operation.operationId} 已进入 ${operation.state}，先核实实际效果再处理`);
          }
          await store.operations.save({ ...operation, state: "abandoned", reason: options.reason ?? "cancelled before effects" });
          if (jsonMode()) emit(jsonResponse(requestId, "completed", { operationId: operation.operationId, state: "abandoned", changed: true }));
          else console.log(`操作 ${operation.operationId}: 已放弃（未执行效果）`);
          return;
        }
        throw new GuardError("invalid_request", "cancel 需要 --run 或 --operation");
      } catch (error) {
        fail(requestId, error);
      } finally {
        store.close();
      }
    });
}
