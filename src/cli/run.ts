/** run 命令组：阶段派发、观察、接收、恢复与取消（DESIGN.md 第4.1、5.6节）。 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { RunCoordinator } from "../application/run-coordinator.js";
import { RunStore } from "../infrastructure/run-store.js";
import { resolvePhaseModel } from "../application/model-selection.js";
import { GuardError } from "../application/guard-error.js";
import type { RunPhase } from "../contracts/run.js";
import { devEnabled } from "./dev.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";

const RUNTIME_DIR = ".knit/.runtime";

function openStore(dir: string): SqliteMetadataStore {
  return new SqliteMetadataStore(join(dir, RUNTIME_DIR, "metadata.db"));
}

function terminal(state: string): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
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
    const dir = String(options.dir ?? ".");
    const taskId = String(options.task ?? "");
    if (taskId === "") throw new GuardError("task_required", "run 需要 --task <taskId>");
    const model = resolvePhaseModel({
      dir,
      phase,
      provider: options.provider as string | undefined,
      model: options.model as string | undefined,
      runtime: options.runtime as string | undefined,
    });
    const resume = (options.resume as string | undefined) ?? "prefer";
    if (resume !== "prefer" && resume !== "new") throw new GuardError("invalid_request", `未知恢复方式: ${resume}`);
    const store = openStore(dir);
    try {
      const coordinator = new RunCoordinator({ store, lockRoot: options.locks as string | undefined });
      return await coordinator.prepare({
        dir,
        taskId,
        phase,
        initiator: {
          client: options.client === "pi" ? "pi" : "cli",
          knitSessionId: (options.session as string | undefined) ?? null,
          nativeSessionId: (options.native as string | undefined) ?? null,
          cwd: dir,
        },
        model,
        recovery: {
          // --native 是发起方上下文，不等于阶段恢复目标；只有显式 --resume-session 才恢复。
          nativeSessionId: (options.resumeSession as string | undefined) ?? null,
          resume,
        },
        diagnostics: devEnabled(program),
        newRepairCycle: options.newRepairCycle === true,
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
    const dir = String(options.dir ?? ".");
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

  const waitFor = async (dir: string, runId: string, locks?: string): Promise<Record<string, unknown>> => {
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
    .description("发布 run 请求与启动意图（不取得执行占用、不写业务资料）")
    .requiredOption("--task <taskId>", "任务 ID")
    .requiredOption("--phase <phase>", "implement、check 或 advisory")
    .option("--client <client>", "pi 或 cli", "cli")
    .option("--session <knitSessionId>", "发起方 Knit Session")
    .option("--native <nativeSessionId>", "发起方原生 Session")
    .option("--runtime <runtime>", "内部 runtime", "pi")
    .option("--provider <provider>", "模型 provider")
    .option("--model <model>", "模型标识")
    .option("--resume <mode>", "prefer 或 new", "prefer")
    .option("--resume-session <nativeSessionId>", "恢复该原生 Session（默认用 --native）")
    .option("--new-repair-cycle", "显式开启新修复周期（仅 implement）")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      if (options.phase !== "implement" && options.phase !== "check" && options.phase !== "advisory") {
        fail("run-prepare", new GuardError("invalid_request", `未知阶段: ${options.phase}`));
        return;
      }
      try {
        const result = await prepare(options, options.phase as RunPhase, "run-prepare");
        if (jsonMode()) emit(jsonResponse("run-prepare", "completed", result));
        else {
          console.log(`${result.reused ? "复用" : "已准备"} run: ${result.request.runId}`);
          console.log(`阶段: ${result.request.phase}；启动状态: ${result.launch.state}`);
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
          console.log(`run ${prepared.request.runId}: ${phase} 已启动（启动 ${started.launch.state}，准备 ${started.state?.prepared === true}）`);
          if (options.wait === true) {
            const status = result.status as { state?: string; result?: { state?: string; report?: { verdict?: string } } } | undefined;
            console.log(`终态: ${status?.state ?? "未知"}${status?.result?.report?.verdict ? ` / ${status.result.report.verdict}` : ""}`);
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
    .option("--wait", "只观察直到终态（不接收结果）")
    .option("--pi-bin <path>", "非正式检查的 Pi 可执行文件（默认 KNIT_PI_BIN 或 PATH）")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      if (Array.isArray(options.scope) && options.scope.length > 0) {
        if (options.task !== undefined) {
          fail("run-check", new GuardError("invalid_request", "--scope 不能与 --task 同时使用"));
          return;
        }
        const { runInformalCheck } = await import("../application/informal-check.js");
        try {
          const model = resolvePhaseModel({
            dir: options.dir,
            phase: "check",
            provider: options.provider,
            model: options.model,
            runtime: options.runtime,
          });
          const result = await runInformalCheck({
            dir: options.dir,
            scope: options.scope,
            model,
            locksRoot: options.locks,
            piExecutable: options.piBin ?? process.env.KNIT_PI_BIN ?? "pi",
          });
          if (jsonMode()) emit(jsonResponse("run-check", result.state === "completed" ? "completed" : "needs_attention", result));
          else {
            console.log(`非正式检查 ${result.checkId}: ${result.state}`);
            if (result.report?.verdict) console.log(`结论: ${result.report.verdict}`);
            for (const item of result.report?.coverage ?? []) console.log(`  ${item}`);
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
    .command("status")
    .description("只读观察 run 状态；日志不作为完成证据")
    .argument("<runId>", "run ID")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      try {
        const { StatusService } = await import("../application/status-service.js");
        const store = openStore(options.dir);
        try {
          const status = await new StatusService({ store, locksRoot: options.locks }).runStatus(options.dir, runId, options.locks);
          if (jsonMode()) emit(jsonResponse("run-status", "completed", status));
          else {
            console.log(`run ${status.runId}: ${status.state}（启动 ${status.launchState}，尝试 ${status.attempts}）`);
            console.log(`准备: ${status.prepared}；快照: ${status.snapshot?.state ?? "无"}；耗时 ${status.elapsedMs}ms`);
            if (status.inputsDigest !== null && status.effectiveInputsDigest !== null) {
              console.log(`输入摘要: ${status.inputsDigest.slice(0, 12)}；整体身份: ${status.effectiveInputsDigest.slice(0, 12)}`);
            }
            if (status.reason !== null) console.log(`原因: ${status.reason}`);
            if (status.result !== null) {
              console.log(`结果: ${status.result.state}${status.result.report?.verdict ? ` / ${status.result.report.verdict}` : ""}`);
              if (status.acceptance !== null) console.log(`接收: ${status.acceptance.state}${status.acceptance.reason ? `（${status.acceptance.reason}）` : ""}`);
            }
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
    .description("接收已完成 run 的结果（固定 acceptanceOperationId 复核；不重跑模型）")
    .argument("<runId>", "run ID")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      const store = openStore(options.dir);
      try {
        const { RunAcceptanceService } = await import("../application/run-acceptance.js");
        const { LockManager } = await import("../infrastructure/locks.js");
        const result = await new RunAcceptanceService({
          store,
          locks: new LockManager(options.locks === undefined ? {} : { root: options.locks }),
        }).accept({ dir: options.dir, runId });
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

  run
    .command("cancel")
    .description("落盘取消意图；只影响本 run，不直接杀进程")
    .argument("<runId>", "run ID")
    .option("--reason <text>", "取消理由")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      const store = openStore(options.dir);
      try {
        const coordinator = new RunCoordinator({ store });
        const result = await coordinator.cancel({ dir: options.dir, runId, reason: options.reason ?? null });
        if (jsonMode()) emit(jsonResponse("run-cancel", "completed", result));
        else console.log(`run ${runId}: ${result.requested ? "已记录取消意图" : `已是终态 ${result.state}`}`);
      } catch (error) {
        fail("run-cancel", error);
      } finally {
        store.close();
      }
    });

  run
    .command("resume")
    .description("旧执行结束后恢复：结果待同步先接收不重跑；否则用原／新会话续做")
    .argument("<runId>", "旧 run ID")
    .option("--locks <dir>", "锁根目录（隔离测试用）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (runId, options) => {
      const store = openStore(options.dir);
      try {
        const coordinator = new RunCoordinator({ store, lockRoot: options.locks });
        const result = await coordinator.resume({ dir: options.dir, oldRunId: runId });
        if (jsonMode()) emit(jsonResponse("run-resume", "completed", result));
        else console.log(`旧 run ${runId}: ${result.accepted ? "已接收" : "待处理"}；${result.resumed ? `新 run ${result.request?.runId}` : result.reason ?? ""}`);
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
      const dbPath = join(options.dir, RUNTIME_DIR, "metadata.db");
      const store = existsSync(dbPath) ? new SqliteMetadataStore(dbPath, { readOnly: true }) : new SqliteMetadataStore(":memory:");
      try {
        const runs = new RunStore(options.dir);
        const coordinator = new RunCoordinator({ store });
        const result = [];
        for (const runId of runs.listRunIds()) result.push(await coordinator.status({ dir: options.dir, runId }));
        if (jsonMode()) emit(jsonResponse("run-list", "completed", result));
        else for (const status of result) console.log(`${status.runId} ${status.phase} ${status.state} prepared=${status.prepared}`);
      } catch (error) {
        fail("run-list", error);
      } finally {
        store.close();
      }
    });

  program
    .command("assist <mode>")
    .description("可选 advisory worker（discuss/deliver）：只给建议，不推进业务、不执行 Git")
    .requiredOption("--task <taskId>", "任务 ID")
    .option("--client <client>", "pi 或 cli", "cli")
    .option("--session <knitSessionId>", "发起方 Knit Session")
    .option("--native <nativeSessionId>", "发起方原生 Session")
    .option("--runtime <runtime>", "内部 runtime", "pi")
    .option("--provider <provider>", "模型 provider")
    .option("--model <model>", "模型标识")
    .option("--resume <mode>", "prefer 或 new", "prefer")
    .option("--resume-session <nativeSessionId>", "恢复该原生 Session")
    .option("--wait", "只观察直到终态")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (mode, options) => {
      if (mode !== "discuss" && mode !== "deliver") {
        fail("assist", new GuardError("invalid_request", `未知 assist 模式: ${mode}`));
        return;
      }
      try {
        const prepared = await prepare(options, "advisory", "assist");
        const started = await start(options, prepared.request.runId, "assist");
        const result: Record<string, unknown> = { ...prepared, ...started, mode };
        if (options.wait === true) result.status = await waitFor(options.dir, prepared.request.runId, options.locks);
        if (jsonMode()) emit(jsonResponse("assist", "completed", result));
        else console.log(`assist ${mode}: run ${prepared.request.runId}（advisory，不推进业务）`);
      } catch (error) {
        fail("assist", error);
      }
    });
}
