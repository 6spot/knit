/** deliver／archive 命令：确定性收尾，不在 worker 内执行 Git（DESIGN.md 第10节）。 */
import { Command } from "commander";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { DeliveryService, type DeliveryInput, type DeliveryPlan } from "../application/delivery-service.js";
import { LockManager } from "../infrastructure/locks.js";
import type { DeliveryResult } from "../contracts/delivery.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cliMainRoot } from "./root.js";
import { GuardError } from "../application/guard-error.js";

const RUNTIME_DIR = ".knit/.runtime";

function render(result: DeliveryResult): void {
  console.log(`操作: ${result.operationId}（${result.mode}）`);
  console.log(`任务: ${result.taskId}；分支: ${result.branch}`);
  console.log(`状态: ${result.state}${result.reason === null ? "" : `（${result.reason}）`}`);
  if (result.workCommit !== null) console.log(`业务产物提交: ${result.workCommit}`);
  if (result.metadataCommit !== null) console.log(`任务资料提交: ${result.metadataCommit}`);
  if (result.archiveCommit !== null) console.log(`归档提交: ${result.archiveCommit}`);
  for (const [label, message] of [
    ["产物提交文案", result.messages.artifact],
    ["资料提交文案", result.messages.metadata],
    ["归档提交文案", result.messages.archive],
  ] as const) {
    if (message !== null) console.log(`${label}: ${message.source} — ${message.subject}`);
  }
  if (result.workCommit !== null && result.messages.artifact?.source === "template") {
    console.log("提示: 未提供产物提交文案，使用模板正文");
  }
  if (result.archivePath !== null) console.log(`归档目录: ${result.archivePath}`);
  const candidate = result.defaultBranch.ref === null
    ? "unknown"
    : `${result.defaultBranch.ref}（${result.defaultBranch.source}${result.defaultBranch.exists ? "" : "，不存在"}）`;
  console.log(`默认分支候选: ${candidate}（仅观察，不授权）`);
  console.log(`授权来源: ${result.authorization.kind}${result.authorization.ref === null ? "" : ` ${result.authorization.ref}`}`);
  if (result.worktree?.merge !== undefined) {
    console.log(`Worktree 合入: ${result.worktree.merge.status}${result.worktree.merge.reason === null ? "" : `（${result.worktree.merge.reason}）`}`);
  }
  if (result.worktree?.cleanup !== undefined) {
    console.log(`Worktree 清理: ${result.worktree.cleanup.status}${result.worktree.cleanup.reason === null ? "" : `（${result.worktree.cleanup.reason}）`}`);
  }
  if ((result.worktree?.pending.length ?? 0) > 0) console.log(`待办: ${result.worktree?.pending.join("、")}`);
}

function renderPlan(plan: DeliveryPlan): void {
  console.log(`只读收尾计划（分支 ${plan.branch}）`);
  for (const task of plan.tasks) {
    console.log(`\n${task.taskId}: ${task.status}${task.reason === null ? "" : `（${task.reason}）`}`);
    console.log(`  业务产物: ${task.artifacts.length === 0 ? "无" : task.artifacts.join(", ")}`);
    console.log(`  任务资料: ${task.metadata.join(", ")}`);
    console.log(`  提交文案: ${task.message.source} — ${task.message.subject}（正文 ${task.message.bodyLines} 行）`);
    if (task.message.source === "template") console.log("  提示: 未提供产物提交文案，将使用模板正文");
    if (task.stagedArtifacts.length > 0) console.log(`  已暂存业务路径: ${task.stagedArtifacts.join(", ")}`);
    if (task.stagedMetadata.length > 0) console.log(`  已暂存任务资料: ${task.stagedMetadata.join(", ")}`);
    for (const line of outsideScopeLines(task)) console.log(`  ${line}`);
  }
  if (plan.conflicts.length > 0) {
    console.log("\n跨任务同路径冲突：");
    for (const conflict of plan.conflicts) console.log(`  ${conflict.path}: ${conflict.taskIds.join(", ")}`);
  }
}

/** 不在 scope、不进产物提交的路径提醒：外部改动（含确认排除）与未处理失败残留。 */
function outsideScopeLines(task: { externalChanges: string[]; residue: string[] }): string[] {
  const lines: string[] = [];
  if (task.externalChanges.length > 0) lines.push(`提醒: 外部改动不在本任务 scope、不进产物提交: ${task.externalChanges.join(", ")}`);
  if (task.residue.length > 0) lines.push(`提醒: 未处理的失败残留不在 scope、不进产物提交: ${task.residue.join(", ")}`);
  return lines;
}

interface DeliveryOptions {
  branch: string;
  authorizationRef?: string;
  caller?: string;
  dir: string;
  locks?: string;
  retry?: boolean;
  plan?: boolean;
  messageFile?: string[];
  merge?: boolean;
  cleanup?: boolean;
}

const TASK_ID_PATTERN = /^k-[0-9a-f]{12}$/;

/** 解析单值路径与批量 <taskId>=<path>；用法错误在服务调用前拒绝。 */
function messageFileMap(taskIds: string[], values: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    const key = separator > 0 ? value.slice(0, separator) : null;
    if (key !== null && TASK_ID_PATTERN.test(key)) {
      const path = value.slice(separator + 1).trim();
      if (path === "") throw new GuardError("invalid_request", `--message-file 缺少路径: ${value}`);
      if (!taskIds.includes(key)) throw new GuardError("invalid_request", `--message-file 指定了本次未交付的任务: ${key}`);
      if (map.has(key)) throw new GuardError("invalid_request", `任务 ${key} 重复指定 --message-file`);
      map.set(key, path);
      continue;
    }
    if (value.trim() === "") throw new GuardError("invalid_request", "--message-file 路径不能为空");
    if (taskIds.length !== 1) throw new GuardError("invalid_request", "批量交付的 --message-file 必须使用 <taskId>=<path>");
    if (values.length !== 1) throw new GuardError("invalid_request", "单任务只能指定一个 --message-file");
    map.set(taskIds[0]!, value);
  }
  return map;
}

export function registerDeliveryCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";

  const withService = async <T>(options: DeliveryOptions, action: (service: DeliveryService) => Promise<T>): Promise<T | null> => {
    if (options.caller !== undefined && options.caller !== "cli" && options.caller !== "agent") {
      const message = `未知调用者: ${options.caller}`;
      if (jsonMode()) emit(jsonResponse(`deliver-${Date.now()}`, "error", { error: message }, "invalid_request"));
      else console.error(`knit: ${message}`);
      process.exitCode = 1;
      return null;
    }
    const store = new SqliteMetadataStore(join(cliMainRoot(options.dir), RUNTIME_DIR, "metadata.db"));
    try {
      const service = new DeliveryService({
        store,
        ...(options.locks === undefined ? {} : { locks: new LockManager({ root: options.locks }) }),
      });
      return await action(service);
    } finally {
      store.close();
    }
  };

  const inputOf = (
    taskId: string,
    options: DeliveryOptions,
    messageFiles: Map<string, string> = new Map(),
  ): DeliveryInput => ({
    dir: options.dir,
    taskId,
    branch: options.branch,
    authorizationRef: options.authorizationRef ?? null,
    caller: options.caller === "agent" ? "agent" : "cli",
    retry: options.retry === true,
    messageFile: messageFiles.get(taskId) ?? null,
    merge: options.merge === true,
    cleanup: options.cleanup === true,
  });

  const fail = (requestId: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
    else console.error(`knit: ${message}`);
  };

  program
    .command("deliver")
    .description("正常交付：业务产物与任务资料分开提交、封存、归档；worktree 任务可按配置先合入并在交付后清理")
    .argument("<taskIds...>", "任务 ID（可多个，按顺序逐项处理）")
    .requiredOption("--branch <ref>", "完整本地目标 refs/heads/...")
    .option("--authorization-ref <ref>", "授权来源引用（workflow:... 或 user:...）")
    .option("--caller <caller>", "cli 或 agent", "cli")
    .option("--dir <dir>", "项目目录", ".")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--retry", "显式重试 needs_attention：先核验已完成效果")
    .option("--merge", "显式授权交付前合入已绑定 worktree（需已有 authorization-ref）", false)
    .option("--cleanup", "显式授权交付后清理 worktree（需已有 authorization-ref）", false)
    .option("--plan", "只读预检：输出任务产物／资料分类与冲突，不写 Git", false)
    .option(
      "--message-file <value>",
      "产物提交文案文件（单任务给路径；批量用 <taskId>=<path>，可重复）",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (taskIds: string[], options: DeliveryOptions) => {
      const requestId = `deliver-${Date.now()}`;
      try {
        const messageFiles = messageFileMap(taskIds, options.messageFile ?? []);
        const inputs = taskIds.map((taskId) => inputOf(taskId, options, messageFiles));
        const plan = await withService(options, (service) => service.plan(inputs));
        if (plan === null) return;
        if (options.plan === true) {
          if (jsonMode()) emit(jsonResponse(requestId, "completed", plan));
          else renderPlan(plan);
          return;
        }
        const blocked = plan.tasks.some((task) => task.status === "conflict");
        if (blocked) {
          process.exitCode = 1;
          if (jsonMode()) emit(jsonResponse(requestId, "needs_attention", plan, "needs_review"));
          else renderPlan(plan);
          return;
        }
        if (!jsonMode()) {
          for (const task of plan.tasks) for (const line of outsideScopeLines(task)) console.log(`${task.taskId} ${line}`);
        }
        if (taskIds.length === 1) {
          const result = await withService(options, (service) => service.deliver(inputOf(taskIds[0] ?? "", options, messageFiles)));
          if (result === null) return;
          if (result.needsAttention) process.exitCode = 1;
          if (jsonMode()) emit(jsonResponse(requestId, result.needsAttention ? "needs_attention" : "completed", result, result.needsAttention ? "external_effect_unknown" : undefined));
          else render(result);
          return;
        }
        const results: Array<{ taskId: string; result?: DeliveryResult; error?: string; reason?: string }> = [];
        let failed = false;
        for (const taskId of taskIds) {
          if (failed) {
            results.push({ taskId, error: "前一项未完成，本项未执行" });
            continue;
          }
          try {
            const result = await withService(options, (service) => service.deliver(inputOf(taskId, options, messageFiles)));
            if (result === null) { failed = true; break; }
            results.push({ taskId, result });
            if (result.needsAttention) failed = true;
          } catch (error) {
            failed = true;
            results.push({ taskId, error: error instanceof Error ? error.message : String(error), reason: reasonForError(error) });
          }
        }
        if (failed) process.exitCode = 1;
        if (jsonMode()) {
          emit(jsonResponse(requestId, failed ? "needs_attention" : "completed", { results }, failed ? "external_effect_unknown" : undefined));
        } else {
          for (const item of results) {
            if (item.result) render(item.result);
            else console.log(`${item.taskId}: ${item.error}`);
          }
        }
      } catch (error) {
        fail(requestId, error);
      }
    });

  const archive = async (taskId: string, options: DeliveryOptions) => {
    const requestId = `archive-${Date.now()}`;
    try {
      const result = await withService(options, (service) => service.archive(inputOf(taskId, options)));
      if (result === null) return;
      if (result.needsAttention) process.exitCode = 1;
      if (jsonMode()) emit(jsonResponse(requestId, result.needsAttention ? "needs_attention" : "completed", result, result.needsAttention ? "external_effect_unknown" : undefined));
      else render(result);
    } catch (error) {
      fail(requestId, error);
    }
  };

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
    .action(archive);
}
