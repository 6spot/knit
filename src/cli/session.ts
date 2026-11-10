/** session 命令组与 context 命令：会话索引、选择核实与分层输入计划（DESIGN.md 第9节）。 */
import { Command } from "commander";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { SessionService, type SessionAttachInput } from "../application/session-service.js";
import { buildSessionContext } from "../application/session-context.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cliMainRoot } from "./root.js";
import type { SessionKind, SessionRole, SessionSourceKind } from "../contracts/session.js";
import { WORKFLOW_STAGE_ID_REGEX } from "../contracts/workflow.js";
import { StatusService } from "../application/status-service.js";

const RUNTIME_DIR = ".knit/.runtime";

function openStore(dir: string): SqliteMetadataStore {
  // 元数据库固定在主检出；worktree 内不新建。
  return new SqliteMetadataStore(join(cliMainRoot(dir), RUNTIME_DIR, "metadata.db"));
}

const KINDS = new Set(["main", "sub"]);
const SOURCES = new Set(["fork", "switch", "resume_fallback", "attach"]);

export function registerSessionCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";

  const withStore = async <T>(
    requestId: string,
    dir: string,
    fn: (store: SqliteMetadataStore) => Promise<T>,
    render: (result: T) => void,
  ): Promise<void> => {
    const store = openStore(dir);
    try {
      const result = await fn(store);
      if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
      else render(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
      if (jsonMode()) {
        emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
      } else {
        console.error(`knit: ${message}`);
        process.exitCode = 1;
      }
    } finally {
      store.close();
    }
  };

  const session = program.command("session").description("会话索引与原生引用核实");

  session
    .command("attach")
    .description("登记主／子会话：预分配 Knit Session ID、稳定记录位置与原生状态")
    .option("--native <id>", "原生 Session ID（缺省预分配）")
    .option("--kind <kind>", "main 或 sub", "main")
    .option("--role <role>", "阶段 id（历史参数，等同 --stage；内置锚点或 workflow.yaml 中的阶段）", "implement")
    .option("--task <taskId>", "参与任务")
    .option("--file <path>", "已知原生记录位置")
    .option("--parent <knitSessionId>", "父 Knit Session ID（子会话必填）")
    .option("--source <kind>", "fork／switch／resume_fallback／attach")
    .option("--from <knitSessionId>", "来源 Knit Session ID")
    .option("--reason <reason>", "来源／兜底原因")
    .option("--branch <branch>", "绑定分支")
    .option("--run <runId>", "关联 run")
    .option("--checkpoint <entryId>", "会话检查点条目")
    .option("--agent-dir <dir>", "Pi 配置根（默认 ~/.pi/agent）")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const requestId = `session-attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const kind = options.kind as SessionKind;
      const role = options.role as SessionRole;
      if (!KINDS.has(kind)) {
        console.error(`knit: 未知 --kind "${options.kind}"`);
        process.exitCode = 1;
        return;
      }
      if (!WORKFLOW_STAGE_ID_REGEX.test(role)) {
        console.error(`knit: 未知 --role "${options.role}"`);
        process.exitCode = 1;
        return;
      }
      const sourceKind = options.source as SessionSourceKind | undefined;
      if (sourceKind !== undefined && !SOURCES.has(sourceKind)) {
        console.error(`knit: 未知 --source "${options.source}"`);
        process.exitCode = 1;
        return;
      }
      await withStore(
        requestId,
        options.dir,
        async (store) => {
          const service = new SessionService({
            store,
            ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
          });
          const input: SessionAttachInput = {
            dir: options.dir,
            kind,
            role,
            ...(options.native === undefined ? {} : { nativeSessionId: options.native }),
            ...(options.task === undefined ? {} : { taskId: options.task }),
            ...(options.file === undefined ? {} : { sessionFile: options.file }),
            ...(options.parent === undefined ? {} : { parentKnitSessionId: options.parent }),
            ...(sourceKind === undefined
              ? {}
              : { source: { kind: sourceKind, fromSessionId: options.from ?? null, reason: options.reason ?? null } }),
            ...(options.branch === undefined ? {} : { branch: options.branch }),
            ...(options.run === undefined ? {} : { runId: options.run }),
            ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
          };
          return service.attach(input);
        },
        (result) => {
          const record = result.record;
          console.log(`会话已登记: ${record.knitSessionId}${result.created ? "（新）" : "（既有）"}`);
          console.log(`原生: ${record.ref.client}/${record.ref.nativeSessionId} [${record.kind}/${record.ref.role}]`);
          console.log(`状态: ${record.status}${record.reason === null ? "" : ` — ${record.reason}`}`);
          console.log(`记录位置: ${record.sessionFile ?? "尚未落盘"}`);
        },
      );
    });

  session
    .command("list")
    .description("按任务／客户端／类型／父会话查询索引")
    .option("--task <taskId>", "按任务过滤")
    .option("--kind <kind>", "main 或 sub")
    .option("--status <status>", "opening／available／missing／incompatible")
    .option("--parent <knitSessionId>", "按父会话过滤")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const requestId = `session-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withStore(
        requestId,
        options.dir,
        async (store) => {
          const service = new SessionService({ store });
          return service.list({
            ...(options.task === undefined ? {} : { taskId: options.task }),
            ...(options.kind === undefined ? {} : { kind: options.kind as SessionKind }),
            ...(options.status === undefined ? {} : { status: options.status }),
            ...(options.parent === undefined ? {} : { parentSessionId: options.parent }),
          });
        },
        (records) => {
          console.log(`会话（${records.length}）:`);
          for (const record of records) {
            console.log(
              `  ${record.knitSessionId}  [${record.kind}/${record.ref.role}/${record.status}]  ` +
                `${record.ref.client}:${record.ref.nativeSessionId}` +
                `${record.taskId === null ? "" : `  任务 ${record.taskId}`}`,
            );
          }
        },
      );
    });

  session
    .command("verify <knitSessionId>")
    .description("重新核实原生记录可读性与身份（只读）")
    .option("--file <path>", "已知原生记录位置（桥接带入当前 session file）")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (knitSessionId, options) => {
      const requestId = `session-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withStore(
        requestId,
        options.dir,
        async (store) => new SessionService({ store }).verify(knitSessionId, options.file ?? null),
        (record) => {
          console.log(`${record.knitSessionId}: ${record.status}${record.reason === null ? "" : ` — ${record.reason}`}`);
          console.log(`记录位置: ${record.sessionFile ?? "尚未落盘"}`);
        },
      );
    });

  session
    .command("resolve <knitSessionId>")
    .description("从当前原生有效路径恢复并校验任务选择（树切换后不复活旧选择）")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (knitSessionId, options) => {
      const requestId = `session-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withStore(
        requestId,
        options.dir,
        async (store) => new SessionService({ store }).resolveSelection(options.dir, knitSessionId),
        (result) => {
          console.log(
            `${result.knitSessionId}: ${result.taskId ?? "无选择"}` +
              `${result.effective ? "" : "（未生效）"}` +
              `${result.reason === null ? "" : ` — ${result.reason}`}`,
          );
          console.log(`来源: ${result.source}；条目: ${result.entryRef ?? "无"}`);
        },
      );
    });

  session
    .command("context <knitSessionId>")
    .description("一次返回当前选择、任务状态、规划资料与下一步（每轮注入用，只读）")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (knitSessionId, options) => {
      const requestId = `session-context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withStore(
        requestId,
        options.dir,
        async (store) => buildSessionContext({ store, dir: options.dir, knitSessionId }),
        (view) => {
          console.log(
            `${view.knitSessionId}: ${view.taskId ?? "无选择"}${view.effective ? "" : "（未生效）"}` +
              `${view.reason === null ? "" : ` — ${view.reason}`}`,
          );
          console.log(`来源: ${view.source}；条目: ${view.entryRef ?? "无"}`);
          if (view.task === null) return;
          console.log(`当前任务：${view.task.title}（${view.task.taskId}）`);
          console.log(`阶段：${view.task.stageName}（${view.task.stage}）；状态: ${view.task.status}${view.task.outcome ? `；结果: ${view.task.outcome}` : ""}`);
          if (view.task.activeRuns.length > 0) console.log(`活动运行: ${view.task.activeRuns.map((run) => `${run.runId}(${run.state})`).join(", ")}`);
          console.log(`规划资料: ${view.materials.length === 0 ? "无" : view.materials.map((entry) => entry.path).join(", ")}`);
          if (view.nextAction !== null) {
            console.log(`下一步（${view.nextAction.kind}）: ${view.nextAction.summary}`);
            for (const command of view.nextAction.commands) console.log(`  ${command}`);
          }
        },
      );
    });

  session
    .command("history <knitSessionId>")
    .description("只读历史摘要：条目类型与引用，不复制聊天正文")
    .option("--limit <n>", "最多返回末尾 N 条")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (knitSessionId, options) => {
      const requestId = `session-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const limit = options.limit === undefined ? null : Number(options.limit);
      await withStore(
        requestId,
        options.dir,
        async (store) => new SessionService({ store }).history(knitSessionId, limit),
        (result) => {
          if (result.problem !== null) {
            console.log(`历史不可读: ${result.problem}${result.sessionFile === null ? "" : ` (${result.sessionFile})`}`);
            return;
          }
          console.log(`条目（${result.entries.length}）:`);
          for (const entry of result.entries) {
            console.log(`  ${entry.id}  ${entry.type}  ${entry.timestamp ?? ""}`);
          }
          if (result.usage !== null) {
            const input = result.usage.inputTokens === null ? "未知" : String(result.usage.inputTokens);
            const output = result.usage.outputTokens === null ? "未知" : String(result.usage.outputTokens);
            const cost = result.usage.estimatedCostUsd === null ? "未知" : result.usage.estimatedCostUsd.toFixed(8);
            console.log(`用量（去重助手条目 ${result.usage.assistantEntries}）: input ${input}（含缓存 ${result.usage.cacheReadTokens ?? "未知"}／写入 ${result.usage.cacheWriteTokens ?? "未知"}），output ${output}，估算费用 ${cost}`);
          } else {
            console.log("用量: 未知（原生记录没有助手用量）");
          }
        },
      );
    });

  program
    .command("context")
    .description("生成阶段分层输入计划：需求、规范／阶段提示词、指纹与注入清单")
    .option("--task <taskId>", "任务 ID")
    .option("--stage <stage>", "阶段 id（内置锚点或 workflow.yaml 中的阶段）")
    .option("--role <role>", "兼容旧参数；等同 --stage")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const requestId = `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!options.task) {
        console.error("knit: context 需要 --task <taskId>");
        process.exitCode = 1;
        return;
      }
      const stage = String(options.stage ?? options.role ?? "implement");
      if (!WORKFLOW_STAGE_ID_REGEX.test(stage)) {
        console.error(`knit: 非法阶段 id "${stage}"`);
        process.exitCode = 1;
        return;
      }
      await withStore(
        requestId,
        options.dir,
        async (store) => {
          const { ContextPlanner } = await import("../application/context-planner.js");
          const { loadWorkflow } = await import("../application/workflow.js");
          const plan = await new ContextPlanner({ store }).plan({
            dir: options.dir,
            taskId: options.task,
            stage,
            // 展示新 run 将使用的计划：已降级时不套旧阶段提示词。
            keepLegacyStagePrompt: loadWorkflow(options.dir).mode !== "fallback",
          });
          // 任务级确定性下一步：与 status <task> 同一推导；计划本身不含任务状态，卡点在这里给出口。
          let nextAction = null;
          try {
            const view = await new StatusService({ store }).taskStatus(cliMainRoot(options.dir), options.task);
            nextAction = view.nextAction;
          } catch {
            nextAction = null;
          }
          return { ...plan, nextAction };
        },
        (plan) => {
          console.log(`上下文计划 ${plan.planId}  [${plan.taskId}/${plan.role}]`);
          if (plan.stageBrief !== undefined) console.log(plan.stageBrief);
          console.log(`输入摘要: ${plan.inputsDigest.slice(0, 12)}；就绪: ${plan.ready ? "是" : "否"}`);
          for (const section of plan.sections) {
            console.log(
              `  ${section.priority.toString().padStart(3)}  ${section.kind.padEnd(16)}  ${section.path ?? section.sourceId}` +
                `${section.background ? "  (背景)" : ""}`,
            );
          }
          for (const blocker of plan.blockers) console.log(`  阻塞: ${blocker}`);
          if (plan.nextAction !== null) {
            console.log(`下一步（${plan.nextAction.kind}）: ${plan.nextAction.summary}`);
            for (const command of plan.nextAction.commands) console.log(`  ${command}`);
          }
        },
      );
    });
}
