/** deliver／archive 命令：确定性收尾，不在 worker 内执行 Git（DESIGN.md 第10节）。 */
import { Command } from "commander";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { DeliveryService, type DeliveryInput } from "../application/delivery-service.js";
import { LockManager } from "../infrastructure/locks.js";
import type { DeliveryResult } from "../contracts/delivery.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";

const RUNTIME_DIR = ".knit/.runtime";

function render(result: DeliveryResult): void {
  console.log(`操作: ${result.operationId}（${result.mode}）`);
  console.log(`任务: ${result.taskId}；分支: ${result.branch}`);
  console.log(`状态: ${result.state}${result.reason === null ? "" : `（${result.reason}）`}`);
  if (result.workCommit !== null) console.log(`工作提交: ${result.workCommit}`);
  if (result.archiveCommit !== null) console.log(`归档提交: ${result.archiveCommit}`);
  if (result.archivePath !== null) console.log(`归档目录: ${result.archivePath}`);
  const candidate = result.defaultBranch.ref === null
    ? "unknown"
    : `${result.defaultBranch.ref}（${result.defaultBranch.source}${result.defaultBranch.exists ? "" : "，不存在"}）`;
  console.log(`默认分支候选: ${candidate}（仅观察，不授权）`);
  console.log(`授权来源: ${result.authorization.kind}${result.authorization.ref === null ? "" : ` ${result.authorization.ref}`}`);
}

export function registerDeliveryCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";

  const action = (mode: "deliver" | "archive") => async (taskId: string, options: {
    branch: string;
    authorizationRef?: string;
    caller?: string;
    dir: string;
    locks?: string;
    retry?: boolean;
  }) => {
    const requestId = `${mode}-${Date.now()}`;
    if (options.caller !== undefined && options.caller !== "cli" && options.caller !== "agent") {
      process.exitCode = 1;
      if (jsonMode()) emit(jsonResponse(requestId, "error", { error: `未知调用者: ${options.caller}` }, "invalid_request"));
      else console.error(`knit: 未知调用者: ${options.caller}`);
      return;
    }
    const store = new SqliteMetadataStore(join(options.dir, RUNTIME_DIR, "metadata.db"));
    try {
      const service = new DeliveryService({
        store,
        ...(options.locks === undefined ? {} : { locks: new LockManager({ root: options.locks }) }),
      });
      const input: DeliveryInput = {
        dir: options.dir,
        taskId,
        branch: options.branch,
        authorizationRef: options.authorizationRef ?? null,
        caller: options.caller === "agent" ? "agent" : "cli",
        retry: options.retry === true,
      };
      const result = mode === "deliver" ? await service.deliver(input) : await service.archive(input);
      if (result.needsAttention) process.exitCode = 1;
      if (jsonMode()) {
        emit(jsonResponse(requestId, result.needsAttention ? "needs_attention" : "completed", result, result.needsAttention ? "external_effect_unknown" : undefined));
      } else {
        render(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
      if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
      else console.error(`knit: ${message}`);
    } finally {
      store.close();
    }
  };

  program
    .command("deliver")
    .description("正常交付：限定工作提交、封存、归档并提交归档")
    .argument("<taskId>", "任务 ID")
    .requiredOption("--branch <ref>", "完整本地目标 refs/heads/...")
    .option("--authorization-ref <ref>", "授权来源引用（workflow:... 或 user:...）")
    .option("--caller <caller>", "cli 或 agent", "cli")
    .option("--dir <dir>", "项目目录", ".")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--retry", "显式重试 needs_attention：先核验已完成效果")
    .action(action("deliver"));

  program
    .command("archive")
    .description("归档已取消／被替代任务，或继续未完成的交付收尾")
    .argument("<taskId>", "任务 ID")
    .requiredOption("--branch <ref>", "完整本地目标 refs/heads/...")
    .option("--authorization-ref <ref>", "授权来源引用（workflow:... 或 user:...）")
    .option("--caller <caller>", "cli 或 agent", "cli")
    .option("--dir <dir>", "项目目录", ".")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--retry", "显式重试 needs_attention：先核验已完成效果")
    .action(action("archive"));
}
