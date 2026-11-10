/** run 命令组：阶段派发、观察、接收、恢复与取消（DESIGN.md 第4.1、5.6节）。 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { RunCoordinator } from "../application/run-coordinator.js";
import { RunScheduler, SCHEDULE_DISABLED_MESSAGE } from "../application/run-scheduler.js";
import { RunStore } from "../infrastructure/run-store.js";
import { LockManager } from "../infrastructure/locks.js";
import { resolvePhaseModel } from "../application/model-selection.js";
import { GuardError } from "../application/guard-error.js";
import { resolveProjectStart } from "../application/worktree-routing.js";
import type { RunPhase, RunPresentation } from "../contracts/run.js";
import { reportStringArrayField, reportVerdictLabel } from "../contracts/run.js";
import { WORKFLOW_STAGE_ID_REGEX } from "../contracts/workflow.js";
import { devEnabled } from "./dev.js";
import { cliMainRoot } from "./root.js";
import { boundaryLines, stageLabel, taskLabel } from "./display.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cancelOptions, cancelRun, emitCancel, emitResume, resumeOptions, resumeRun } from "./run-control.js";

const RUNTIME_DIR = ".knit/.runtime";

function openStore(dir: string): SqliteMetadataStore {
  return new SqliteMetadataStore(join(cliMainRoot(dir), RUNTIME_DIR, "metadata.db"));
}

function terminal(state: string): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/** 调用级显式覆盖；--rex 与 --local 同时出现拒绝，未指定时由项目配置／自动探测决定。 */
function explicitPresentation(options: Record<string, unknown>): RunPresentation | undefined {
  if (options.rex === true && options.local === true) {
    throw new GuardError("invalid_request", "--rex 与 --local 不能同时使用");
  }
  if (options.rex === true) return "rex";
  if (options.local === true) return "local";
  return undefined;
}

/** 调用级 worktree 覆盖；只接受 on／off，未指定时按项目 worktree.default。 */
function explicitWorktree(options: Record<string, unknown>): "on" | "off" | undefined {
  const value = options.worktree;
  if (value === undefined) return undefined;
  if (value === "on" || value === "off") return value;
  throw new GuardError("invalid_request", `--worktree 只接受 on 或 off: ${String(value)}`);
}

export function registerRunCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const run = program.command("run").description("准备、启动并观察本地 worker");

  const fail = (requestId: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
    else console.error(`knit: ${message}`);
  };

  const prepare = async (
    options: Record<string, unknown>,
    phase: RunPhase,
    requestId: string,
  ): Promise<Awaited<ReturnType<RunCoordinator["prepare"]>>> => {
    const presentation = explicitPresentation(options);
    const start = resolveProjectStart(String(options.dir ?? "."));
    const root = start.mainRoot;
    const taskId = String(options.task ?? "");
    if (taskId === "") throw new GuardError("task_required", "run 需要 --task <taskId>");
    const model = resolvePhaseModel({
      dir: root,
      phase,
      provider: options.provider as string | undefined,
      model: options.model as string | undefined,
      runtime: options.runtime as string | undefined,
    });
    const resume = (options.resume as string | undefined) ?? "prefer";
    if (resume !== "prefer" && resume !== "new") throw new GuardError("invalid_request", `未知恢复方式: ${resume}`);
    const worktree = explicitWorktree(options);
    const store = openStore(root);
    try {
      const coordinator = new RunCoordinator({ store, lockRoot: options.locks as string | undefined });
      return await coordinator.prepare({
        dir: root,
        executionDir: start.executionDir,
        taskId,
        phase,
        presentation,
        initiator: {
          client: options.client === "pi" ? "pi" : "cli",
          knitSessionId: (options.session as string | undefined) ?? null,
          nativeSessionId: (options.native as string | undefined) ?? null,
          cwd: start.executionDir,
        },
        model,
        recovery: {
          // --native 是发起方上下文，不等于阶段恢复目标；只有显式 --resume-session 才恢复。
          nativeSessionId: (options.resumeSession as string | undefined) ?? null,
          resume,
        },
        diagnostics: devEnabled(program),
        newRepairCycle: options.newRepairCycle === true,
        authorizedStandardPaths: (options.authorizeStandard as string[] | undefined) ?? [],
        ...(worktree === undefined ? {} : { worktree: { policy: worktree, source: "explicit" as const } }),
      });
    } finally {
      store.close();
    }
  };

  const start = async (
    options: Record<string, unknown>,
    runId: string,
    requestId: string,
  ): Promise<Awaited<ReturnType<RunCoordinator["start"]>>> => {
    const dir = cliMainRoot(String(options.dir ?? "."));
    const store = openStore(dir);
    try {
      const coordinator = new RunCoordinator({ store, lockRoot: options.locks as string | undefined });
      return await coordinator.start({
        dir,
        runId,
        retry: options.retry === true,
        prepareOnly: options.prepareOnly === true,
      });
    } finally {
      store.close();
    }
  };

  const waitFor = async (startDir: string, runId: string, locks?: string): Promise<Record<string, unknown>> => {
    const dir = cliMainRoot(startDir);
    const store = openStore(dir);
    try {
      const coordinator = new RunCoordinator({ store, lockRoot: locks });
      for (;;) {
        const status = await coordinator.status({ dir, runId });
        if (terminal(status.state)) return status as unknown as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      store.close();
    }
  };

  run
    .command("prepare")
    .description("发布 run 请求与启动意图（可能先确保 worktree；不取得执行占用）")
    .requiredOption("--task <taskId>", "任务 ID")
    .requiredOption("--stage <stage>", "阶段 id（内置锚点或 workflow.yaml 中的阶段）")
    .option("--rex", "强制在 Rex 浮层中运行阶段 Pi（不可用时报错，不回退）")
    .option("--local", "强制本地后台运行（覆盖项目 execution.host）")
    .option("--client <client>", "pi 或 cli", "cli")
    .option("--session <knitSessionId>", "发起方 Knit Session")
    .option("--native <nativeSessionId>", "发起方原生 Session")
    .option("--runtime <runtime>", "内部 runtime", "pi")
    .option("--provider <provider>", "模型 provider")
    .option("--model <model>", "模型标识")
    .option("--resume <mode>", "prefer 或 new", "prefer")
    .option("--resume-session <nativeSessionId>", "恢复该原生 Session（默认用 --native）")
    .option("--new-repair-cycle", "显式开启新修复周期（仅 implement）")
    .option("--authorize-standard <path>", "明确授权为成果的正式规范路径（可重复）", (value: string, previous: string[]) => [...previous, value], [])
    .option("--worktree <mode>", "本次派发 on 自动确保 worktree／off 抑制自动创建（覆盖项目 worktree.default）")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      if (!WORKFLOW_STAGE_ID_REGEX.test(String(options.stage))) {
        fail("run-prepare", new GuardError("invalid_request", `未知阶段: ${options.stage}`));
        return;
      }
      try {
        const result = await prepare(options, options.stage as RunPhase, "run-prepare");
        if (jsonMode()) emit(jsonResponse("run-prepare", "completed", result));
        else {
          console.log(`${result.reused ? "复用" : "已准备"} run: ${result.request.runId}`);
          console.log(`阶段: ${result.request.phase}；启动状态: ${result.launch.state}`);
          console.log(`呈现: ${result.request.presentation}（来源 ${result.request.presentationSource ?? "config"}）${result.request.presentationFallbackReason ? `；回退原因: ${result.request.presentationFallbackReason}` : ""}`);
        }
      } catch (error) {
        fail("run-prepare", error);
      }
    });

  run
    .command("start")
    .description("启动本地 worker 并等待认领／准备确认")
    .argument("<runId>", "run ID")
    .option("--retry", "仅当原句柄已确认死亡时重试同一 run")
    .option("--prepare-only", "仅准备到 prepared（测试／诊断）")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      try {
        const result = await start(options, runId, "run-start");
        if (jsonMode()) emit(jsonResponse("run-start", "completed", result));
        else {
          console.log(`run ${runId}: 启动=${result.launch.state} 准备=${result.state?.prepared === true}`);
          if (result.launch.lastError !== null) console.log(`原因: ${result.launch.lastError}`);
        }
      } catch (error) {
        fail("run-start", error);
      }
    });

  const dispatch = (phase: RunPhase) =>
    async (options: Record<string, unknown>) => {
      const requestId = `run-${phase}`;
      try {
        const prepared = await prepare(options, phase, requestId);
        const started = await start(options, prepared.request.runId, requestId);
        const result: Record<string, unknown> = { ...prepared, ...started };
        if (options.wait === true) result.status = await waitFor(String(options.dir ?? "."), prepared.request.runId, options.locks as string | undefined);
        if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
        else {
          console.log(`run ${prepared.request.runId}: ${phase} 已启动（启动 ${started.launch.state}，准备 ${started.state?.prepared === true}，呈现 ${prepared.request.presentation}/${prepared.request.presentationSource ?? "config"}）`);
          if (options.wait === true) {
            const status = result.status as { state?: string; result?: { state?: string; report?: import("../contracts/run.js").StageReport } } | undefined;
            const verdict = status?.result?.report === undefined ? null : reportVerdictLabel(status.result.report);
            console.log(`终态: ${status?.state ?? "未知"}${verdict === null ? "" : ` / ${verdict}`}`);
          }
        }
      } catch (error) {
        fail(requestId, error);
      }
    };

  run
    .command("implement")
    .description("派发实施 worker（prepare + start；run ID 在启动前落盘）")
    .requiredOption("--task <taskId>", "任务 ID")
    .option("--client <client>", "pi 或 cli", "cli")
    .option("--session <knitSessionId>", "发起方 Knit Session")
    .option("--native <nativeSessionId>", "发起方原生 Session")
    .option("--runtime <runtime>", "内部 runtime", "pi")
    .option("--provider <provider>", "模型 provider")
    .option("--model <model>", "模型标识")
    .option("--resume <mode>", "prefer 或 new", "prefer")
    .option("--resume-session <nativeSessionId>", "恢复该原生 Session")
    .option("--new-repair-cycle", "显式开启新修复周期")
    .option("--rex", "强制在 Rex 浮层中运行阶段 Pi（不可用时报错，不回退）")
    .option("--local", "强制本地后台运行（覆盖项目 execution.host）")
    .option("--worktree <mode>", "本次派发 on 自动确保 worktree／off 抑制自动创建")
    .option("--wait", "只观察直到终态（不接收结果）")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(dispatch("implement"));

  run
    .command("check")
    .description("派发独立检查 worker；--scope 为非正式只读检查（不建 Task 绑定）")
    .option("--task <taskId>", "正式检查的任务 ID")
    .option("--scope <path...>", "非正式检查的显式范围")
    .option("--client <client>", "pi 或 cli", "cli")
    .option("--session <knitSessionId>", "发起方 Knit Session")
    .option("--native <nativeSessionId>", "发起方原生 Session")
    .option("--runtime <runtime>", "内部 runtime", "pi")
    .option("--provider <provider>", "模型 provider")
    .option("--model <model>", "模型标识")
    .option("--resume <mode>", "prefer 或 new", "prefer")
    .option("--resume-session <nativeSessionId>", "恢复该原生 Session")
    .option("--rex", "强制在 Rex 浮层中运行阶段 Pi（不可用时报错，不回退）")
    .option("--local", "强制本地后台运行（覆盖项目 execution.host）")
    .option("--worktree <mode>", "正式检查派发时 on 自动确保 worktree／off 抑制自动创建")
    .option("--wait", "只观察直到终态（不接收结果）")
    .option("--pi-bin <path>", "非正式检查的 Pi 可执行文件（默认 KNIT_PI_BIN 或 PATH）")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      if (Array.isArray(options.scope) && options.scope.length > 0) {
        if (options.rex === true && options.local === true) {
          fail("run-check", new GuardError("invalid_request", "--rex 与 --local 不能同时使用"));
          return;
        }
        if (options.rex === true) {
          fail("run-check", new GuardError("invalid_request", "非正式检查不支持 --rex；Rex 浮层只用于正式阶段"));
          return;
        }
        if (options.task !== undefined) {
          fail("run-check", new GuardError("invalid_request", "--scope 不能与 --task 同时使用"));
          return;
        }
        const { runInformalCheck } = await import("../application/informal-check.js");
        try {
          const model = resolvePhaseModel({
            dir: cliMainRoot(options.dir),
            phase: "check",
            provider: options.provider,
            model: options.model,
            runtime: options.runtime,
          });
          const result = await runInformalCheck({
            dir: cliMainRoot(options.dir),
            scope: options.scope,
            model,
            locksRoot: options.locks,
            piExecutable: options.piBin ?? process.env.KNIT_PI_BIN ?? "pi",
          });
          if (jsonMode()) emit(jsonResponse("run-check", result.state === "completed" ? "completed" : "needs_attention", result));
          else {
            console.log(`非正式检查 ${result.checkId}: ${result.state}`);
            const verdict = result.report === null ? null : reportVerdictLabel(result.report);
            if (verdict !== null) console.log(`结论: ${verdict}`);
            for (const item of result.report === null ? [] : reportStringArrayField(result.report, "coverage") ?? []) console.log(`  ${item}`);
          }
          if (result.state !== "completed") process.exitCode = 1;
        } catch (error) {
          fail("run-check", error);
        }
        return;
      }
      if (options.task === undefined) {
        fail("run-check", new GuardError("task_required", "正式检查需要 --task；非正式检查用 --scope"));
        return;
      }
      await dispatch("check")(options);
    });

  run
    .command("schedule")
    .description("Worktree 模式下的多任务调度：按就绪集与并发上限派发、接收并推进阶段")
    .option("--once", "只做一轮计算与派发，不等待、不接收")
    .option("--until-idle", "循环派发、接收与推进，直到没有活动 run 与可派发任务（默认）")
    .option("--max <n>", "覆盖本轮并发上限（正整数）")
    .option("--authorization-ref <ref>", "显式授权提交／合入／清理的来源引用")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = "run-schedule";
      if (options.once === true && options.untilIdle === true) {
        fail(requestId, new GuardError("invalid_request", "--once 与 --until-idle 不能同时使用"));
        return;
      }
      let maxConcurrent: number | undefined;
      if (options.max !== undefined) {
        const parsed = Number(options.max);
        if (!Number.isInteger(parsed) || parsed < 1) {
          fail(requestId, new GuardError("invalid_request", `--max 必须是正整数: ${String(options.max)}`));
          return;
        }
        maxConcurrent = parsed;
      }
      const root = cliMainRoot(options.dir);
      const lockRoot = options.locks as string | undefined;
      const store = openStore(root);
      const locks = new LockManager(lockRoot === undefined ? {} : { root: lockRoot });
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.on("SIGINT", onSigint);
      try {
        const scheduler = new RunScheduler({
          store,
          locks,
          ...(lockRoot === undefined ? {} : { locksRoot: lockRoot }),
        });
        const result = await scheduler.run({
          dir: root,
          mode: options.once === true ? "once" : "until-idle",
          ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
          authorizationRef: (options.authorizationRef as string | undefined) ?? null,
          signal: controller.signal,
        });
        if (jsonMode()) {
          emit(jsonResponse(requestId, result.needsAttention.length > 0 ? "needs_attention" : "completed", result, result.needsAttention.length > 0 ? "needs_review" : undefined));
        } else if (result.gate === "disabled") {
          console.log(result.message ?? SCHEDULE_DISABLED_MESSAGE);
        } else {
          console.log(`调度（${result.mode}）：并发上限 ${result.limits.maxConcurrent}，单阶段尝试上限 ${result.limits.maxAttempts}`);
          for (const event of result.events) {
            if (event.action === "scheduler_start" || event.action === "scheduler_stop") continue;
            const subject = [event.taskId, event.stage === undefined ? null : `@${event.stage}`, event.runId].filter((item) => item !== null && item !== undefined).join(" ");
            const suffix = event.reason === undefined ? "" : ` — ${event.reason}`;
            const authorization = event.authorization === undefined ? "" : `（授权 ${event.authorization}）`;
            console.log(`${event.action}${subject === "" ? "" : ` ${subject}`}${suffix}${authorization}`);
          }
          if (result.interrupted) console.log("已中断：停止派发与接收，活动 run 保留；未自动取消。");
          const advanced = result.accepted.filter((item) => item.stage !== null);
          if (advanced.length > 0) {
            console.log(`已推进: ${advanced.map((item) => `${item.taskId}@${item.stage}${item.verdict === null ? "" : `(${item.verdict})`}`).join(", ")}`);
          }
          if (result.active.length > 0) {
            console.log(`仍在运行 ${result.active.length}: ${result.active.map((run) => `${run.runId}(${run.taskId}@${run.stage})`).join(", ")}`);
          }
          if (result.pendingDelivery.length > 0) console.log(`待交付／待授权: ${result.pendingDelivery.join(", ")}`);
          if (result.needsAttention.length > 0) {
            console.log(`需人工处理 ${result.needsAttention.length}: ${result.needsAttention.map((item) => `${item.taskId}(${item.reason})`).join(", ")}`);
          }
          console.log(`汇总：派发 ${result.dispatched.length}，接收 ${result.accepted.length}，关闭 ${result.closed.length}，交付 ${result.delivered.length}`);
        }
      } catch (error) {
        fail(requestId, error);
      } finally {
        process.removeListener("SIGINT", onSigint);
        store.close();
      }
    });

  run
    .command("status")
    .description("只读观察 run 状态；日志不作为完成证据")
    .argument("<runId>", "run ID")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      try {
        const { StatusService } = await import("../application/status-service.js");
        const root = cliMainRoot(options.dir);
        const store = openStore(root);
        try {
          const status = await new StatusService({ store, locksRoot: options.locks }).runStatus(root, runId, options.locks);
          if (jsonMode()) emit(jsonResponse("run-status", "completed", status, undefined, status.nextActions.length > 0 ? status.nextActions : undefined));
          else {
            console.log(`任务：${taskLabel(status)}（阶段：${stageLabel(status.stageName, status.phase, "space")}）`);
            console.log(`run ${status.runId}: ${status.state}（启动 ${status.launchState}，尝试 ${status.attempts}）`);
            console.log(`呈现: ${status.presentation}（来源 ${status.presentationSource}）${status.presentationFallbackReason ? `；回退原因: ${status.presentationFallbackReason}` : ""}`);
            console.log(`准备: ${status.prepared}；快照: ${status.snapshot?.state ?? "无"}；耗时 ${status.elapsedMs}ms`);
            if (status.inputsDigest !== null && status.effectiveInputsDigest !== null) {
              console.log(`输入摘要: ${status.inputsDigest.slice(0, 12)}；整体身份: ${status.effectiveInputsDigest.slice(0, 12)}`);
            }
            if (status.reason !== null) console.log(`原因: ${status.reason}`);
            if (status.startupDiagnostics !== null) {
              const diag = status.startupDiagnostics;
              console.log(`启动诊断: ${diag.failure}；${diag.detail}${diag.truncated ? "（尾部已截断）" : ""}`);
              if (diag.stderrTail !== "") console.log(diag.stderrTail);
            }
            if (status.result !== null) {
              console.log(`结果: ${status.result.state}${status.result.report && reportVerdictLabel(status.result.report) ? ` / ${reportVerdictLabel(status.result.report)}` : ""}`);
              if (status.result.reportRetries !== undefined && status.result.reportRetries > 0) {
                const retryUsage = status.result.reportRetryUsage;
                console.log(`报告补报: ${status.result.reportRetries} 次${retryUsage ? `；额外用量 input ${retryUsage.inputTokens ?? "未知"}，output ${retryUsage.outputTokens ?? "未知"}` : ""}`);
              }
              if (status.result.reportIssue) {
                console.log(`报告问题: ${status.result.reportIssue.reason}`);
                for (const line of status.result.reportIssue.detail.split("\n")) console.log(`  ${line}`);
              }
              if (status.acceptance !== null) console.log(`接收: ${status.acceptance.state}${status.acceptance.reason ? `（${status.acceptance.reason}）` : ""}`);
              for (const line of boundaryLines(status.result)) console.log(line);
              if (status.verificationLabel !== null && status.checkerChangedPaths.length > 0) console.log(`验证: ${status.verificationLabel}`);
              if (status.noOutputNotice !== null) console.log(`提示: ${status.noOutputNotice}`);
            }
            for (const action of status.nextActions) console.log(`下一步: ${action}`);
          }
        } finally {
          store.close();
        }
      } catch (error) {
        fail("run-status", error);
      }
    });

  run
    .command("accept")
    .description("接收已完成 run 的结果（固定 acceptanceOperationId 复核；不重跑模型）；--include／--exclude 确认来源不明的路径")
    .argument("<runId>", "run ID")
    .option("--include <path...>", "确认并入 scope 的来源不明路径（按当前指纹并入）")
    .option("--exclude <path...>", "确认排除的来源不明路径（不进 scope、不进交付）")
    .option("--reason <text>", "确认原因（随确认记录保存）")
    .option("--by <who>", "确认人（缺省 cli）")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      try {
        // 阶段进程内不能接收任何 run（含自己）：接收会推进任务阶段与写检查凭据。
        const { assertNotInStageContext } = await import("../application/stage-context.js");
        assertNotInStageContext("run accept");
      } catch (error) {
        fail("run-accept", error);
        return;
      }
      const root = cliMainRoot(options.dir);
      const store = openStore(root);
      try {
        const { RunAcceptanceService } = await import("../application/run-acceptance.js");
        const { LockManager } = await import("../infrastructure/locks.js");
        const include: string[] = options.include ?? [];
        const exclude: string[] = options.exclude ?? [];
        const result = await new RunAcceptanceService({
          store,
          locks: new LockManager(options.locks === undefined ? {} : { root: options.locks }),
        }).accept({
          dir: root,
          runId,
          ...(include.length > 0 || exclude.length > 0
            ? { decision: { include, exclude, confirmedBy: options.by ?? "cli", reason: options.reason ?? null } }
            : {}),
        });
        if (jsonMode()) emit(jsonResponse("run-accept", result.accepted ? "completed" : "needs_attention", result));
        else {
          console.log(`run ${runId}: ${result.accepted ? "已接收" : "待处理"}（${result.reason ?? "无原因"}）`);
          if (result.verdict !== null) console.log(`检查结论: ${result.verdict}`);
        }
      } catch (error) {
        fail("run-accept", error);
      } finally {
        store.close();
      }
    });

  cancelOptions(
    run
      .command("cancel")
      .description("落盘取消意图；只影响本 run，不直接杀进程（与顶层 cancel --run 同一实现）")
      .argument("<runId>", "run ID"),
  )
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      const root = cliMainRoot(options.dir);
      const store = openStore(root);
      try {
        const result = await cancelRun({
          store,
          root,
          runId,
          reason: options.reason ?? null,
          terminate: options.terminate === true,
        });
        emitCancel("run-cancel", jsonMode(), runId, result);
      } catch (error) {
        fail("run-cancel", error);
      } finally {
        store.close();
      }
    });

  resumeOptions(
    run
      .command("resume")
      .description("旧执行结束后恢复：结果待同步先接收不重跑；否则用原／新会话续做并启动新 run（与顶层 resume --run 同一实现）")
      .argument("<runId>", "旧 run ID"),
  )
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      const start = resolveProjectStart(options.dir);
      const store = openStore(start.mainRoot);
      try {
        const result = await resumeRun({
          store,
          mainRoot: start.mainRoot,
          executionDir: start.executionDir,
          runId,
          locks: options.locks,
          start: options.start !== false,
          wait: options.wait === true,
        });
        emitResume("run-resume", jsonMode(), `run ${runId}`, result);
      } catch (error) {
        fail("run-resume", error);
      } finally {
        store.close();
      }
    });

  run
    .command("list")
    .description("列出本项目的 run 目录（只读）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const root = cliMainRoot(options.dir);
      const dbPath = join(root, RUNTIME_DIR, "metadata.db");
      const store = existsSync(dbPath) ? new SqliteMetadataStore(dbPath, { readOnly: true }) : new SqliteMetadataStore(":memory:");
      try {
        const runs = new RunStore(root);
        const coordinator = new RunCoordinator({ store });
        const result = [];
        for (const runId of runs.listRunIds()) result.push(await coordinator.status({ dir: root, runId }));
        if (jsonMode()) emit(jsonResponse("run-list", "completed", result));
        else for (const status of result) {
          const fallback = status.presentationFallbackReason ? ` fallback=${status.presentationFallbackReason}` : "";
          console.log(`${status.runId} ${status.phase} ${status.state} host=${status.presentation} source=${status.presentationSource}${fallback} prepared=${status.prepared}`);
        }
      } catch (error) {
        fail("run-list", error);
      } finally {
        store.close();
      }
    });
}
