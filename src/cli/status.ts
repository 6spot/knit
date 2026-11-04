/** status/doctor/storage：只读观察与诊断（DESIGN.md 第4.1节、STATES.md 第9节）。 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { RunStore } from "../infrastructure/run-store.js";
import { StatusService } from "../application/status-service.js";
import { doctor, storage } from "../application/diagnostics.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cliMainRoot } from "./root.js";

const RUNTIME_DIR = ".knit/.runtime";

function openReadStore(dir: string): SqliteMetadataStore {
  const path = join(cliMainRoot(dir), RUNTIME_DIR, "metadata.db");
  return existsSync(path)
    ? new SqliteMetadataStore(path, { readOnly: true })
    : new SqliteMetadataStore(":memory:");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function terminal(state: string): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

export function registerStatusCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const fail = (requestId: string, error: unknown): void => {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
    else console.error(`knit: ${message}`);
  };

  program
    .command("status [id]")
    .description("只读查看任务／run 状态；不接收结果、不推进业务")
    .option("--run <runId>", "查看指定 run")
    .option("--locks <dir>", "锁根目录（与 run start 一致）")
    .option("--events", "观察事件流直到 run 终态（stdout 仅事件 JSON 行）")
    .option("--interval <ms>", "事件轮询间隔（默认 1000ms）", "1000")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, options) => {
      const requestId = `status-${Date.now()}`;
      const runId = options.run ?? (typeof id === "string" && id.startsWith("run-") ? id : undefined);
      const taskId = options.run !== undefined ? undefined : typeof id === "string" && !id.startsWith("run-") ? id : undefined;
      const store = openReadStore(options.dir);
      try {
        if (options.events === true) {
          if (runId === undefined) throw new Error("status --events 需要 --run <runId>");
          if (jsonMode()) throw new Error("status --events 不能与 --json 同时使用");
          const runs = new RunStore(options.dir);
          let index = 0;
          for (;;) {
            const events = runs.readEvents(runId);
            while (index < events.length) {
              process.stdout.write(JSON.stringify({ type: "knit.event", runId, ...events[index] }) + "\n");
              index += 1;
            }
            const service = new StatusService({ store, locksRoot: options.locks });
            const view = await service.runStatus(options.dir, runId, options.locks);
            if (terminal(view.state)) {
              process.stdout.write(JSON.stringify({ type: "knit.terminal", runId, state: view.state, acceptance: view.acceptance?.state ?? null }) + "\n");
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number(options.interval) || 1000)));
          }
        }
        const service = new StatusService({ store, locksRoot: options.locks });
        const result = await service.status({ dir: options.dir, runId, taskId, locksRoot: options.locks });
        if (jsonMode()) {
          emit(jsonResponse(requestId, "completed", result));
          return;
        }
        if ("taskId" in result && "latestRun" in result) {
          console.log(`任务 ${result.taskId}: ${result.status}/${result.phase}${result.outcome ? `/${result.outcome}` : ""}`);
          console.log(`标题: ${result.title}`);
          console.log(`分支: ${result.branch ?? "未绑定"}；位置: ${result.relativePath}${result.archived ? "（已归档）" : ""}`);
          console.log(`运行: ${result.runs.length} 个（活动 ${result.activeRuns}）；完成验证: ${result.verification}；最近检查: ${result.lastCheckRunId ?? "无"}`);
          console.log(`优先级: ${result.priority}；前置依赖: ${result.dependsOn.length === 0 ? "无" : result.dependsOn.join(", ")}`);
          if (result.blocked.length > 0) {
            console.log(`启动阻塞: ${result.blocked.map((blocker) => `${blocker.taskId}(${blocker.problem})`).join(", ")}`);
          }
          if (result.parent !== null) console.log(`父任务: ${result.parent}`);
          if (result.children.length > 0) {
            const open = result.children.filter((child) => child.status === "open").length;
            console.log(`子任务（${result.children.length - open}/${result.children.length} 已结束）: ${result.children.map((child) => `${child.taskId}[${child.status}${child.outcome ? `/${child.outcome}` : ""}]`).join(", ")}`);
          }
          if (result.completion !== null) console.log(`完成凭据: ${result.completion.verification} @ ${result.completion.completedAt}`);
          console.log(`范围: ${result.scopeCount} 条；草案: ${result.pendingDraft ? result.pendingDraft.kind : "无"}`);
          if (result.latestRun !== null) {
            const run = result.latestRun;
            console.log(`最近 run: ${run.runId} ${run.phase}/${run.state}；耗时 ${formatMs(run.elapsedMs)}；活动 ${run.lastEvent ?? "无"} @ ${run.lastActivityAt ?? "未知"}`);
            if (run.heartbeat !== null) console.log(`心跳: ${run.heartbeat.at}（${run.heartbeat.verdict}）`);
          }
        } else if ("runId" in result && "elapsedMs" in result) {
          console.log(`run ${result.runId}: ${result.state}（启动 ${result.launchState}，尝试 ${result.attempts}）`);
          console.log(`任务: ${result.taskId} / ${result.phase}；耗时 ${formatMs(result.elapsedMs)}`);
          // 执行目录锁是 project 锁的实际键；主检出路由与现在输出等价（任务17）。
          if (result.executionDir !== cliMainRoot(options.dir)) console.log(`执行目录: ${result.executionDir}`);
          console.log(`准备: ${result.prepared}；快照: ${result.snapshot?.state ?? "无"}`);
          console.log(`最近活动: ${result.lastEvent ?? "无"} @ ${result.lastActivityAt ?? "未知"}`);
          console.log(`心跳: ${result.heartbeat ? `${result.heartbeat.at}（${result.heartbeat.verdict}）` : "无"}`);
          if (result.cancelRequestedAt !== null) console.log(`取消意图: ${result.cancelRequestedAt}${result.cancelReason ? `（${result.cancelReason}）` : ""}`);
          console.log(`阶段进程: ${result.stageProcess ? `${result.stageProcess.state}/${result.stageProcessVerdict}` : "无记录"}`);
          if (result.reason !== null) console.log(`原因: ${result.reason}`);
          if (result.result !== null) {
            console.log(`结果: ${result.result.state}${result.result.report?.verdict ? ` / ${result.result.report.verdict}` : ""}`);
            const usage = result.result.usage;
            console.log(`用量: input ${usage.inputTokens ?? "未知"}（含缓存），output ${usage.outputTokens ?? "未知"}；未知值不填零`);
            console.log(`接收: ${result.acceptance?.state ?? "未开始"}${result.acceptance?.reason ? `（${result.acceptance.reason}）` : ""}`);
          }
        } else {
          console.log(`项目状态 ${result.generatedAt}：活动任务 ${result.tasks.filter((task) => !task.archived).length}，活动 run ${result.activeRuns.length}`);
          for (const task of result.tasks.filter((item) => !item.archived)) {
            console.log(`  ${task.taskId}  ${task.status}/${task.phase}  ${task.title}${task.activeRuns > 0 ? `  (run ${task.activeRuns})` : ""}`);
          }
          for (const run of result.activeRuns) {
            console.log(`  ${run.runId}  ${run.phase}/${run.state}  ${formatMs(run.elapsedMs)}  ${run.lastEvent ?? ""}`);
          }
        }
      } catch (error) {
        fail(requestId, error);
      } finally {
        store.close();
      }
    });

  program
    .command("doctor")
    .description("只读核对安装、配置、桥接、worker、Git 与 Pi 可用性")
    .option("--pi-bin <path>", "Pi 可执行文件（默认 KNIT_PI_BIN 或 PATH）")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action((options) => {
      const requestId = `doctor-${Date.now()}`;
      try {
        const result = doctor({ dir: options.dir, ...(options.piBin === undefined ? {} : { piBin: options.piBin }), ...(options.locks === undefined ? {} : { locksRoot: options.locks }) });
        if (jsonMode()) emit(jsonResponse(requestId, result.ok ? "completed" : "needs_attention", result));
        else {
          for (const check of result.checks) console.log(`[${check.status}] ${check.name}: ${check.detail}`);
          console.log(result.ok ? "诊断通过（只读）" : "诊断发现需处理项（只读，未修改）");
        }
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        fail(requestId, error);
      }
    });

  program
    .command("storage")
    .description("只读统计元数据库、任务、run、快照与锁容量")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action((options) => {
      const requestId = `storage-${Date.now()}`;
      try {
        const result = storage({ dir: options.dir, ...(options.locks === undefined ? {} : { locksRoot: options.locks }) });
        if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
        else {
          console.log(`项目: ${result.projectRoot}`);
          console.log(`元数据库: ${result.database.exists ? `${result.database.bytes} B (+WAL ${result.database.walBytes} B)` : "未创建"}`);
          console.log(`记录: ${Object.entries(result.database.counts).map(([key, value]) => `${key}=${value}`).join(" ") || "无"}`);
          console.log(`任务: 活动 ${result.tasks.active}，归档 ${result.tasks.archived}`);
          console.log(`run: ${result.runs.count} 个 / ${result.runs.bytes} B；快照 ${result.snapshots.count} 个 / ${result.snapshots.bytes} B`);
          console.log(`gc 候选: ${result.gcCandidates} 个（只读摘要；用 knit gc 预览）`);
          console.log(`锁: ${result.locks.entries} 个文件 / ${result.locks.bytes} B`);
          for (const warning of result.warnings) console.log(`提示: ${warning}`);
        }
      } catch (error) {
        fail(requestId, error);
      }
    });
}
