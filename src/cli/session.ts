/** session 命令组与 context 命令：会话索引、选择核实与分层输入计划（DESIGN.md 第9节）。 */
import { Command } from "commander";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { SessionService, type SessionAttachInput } from "../application/session-service.js";
import { ContextPlanner } from "../application/context-planner.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import type { SessionKind, SessionRole, SessionSourceKind } from "../contracts/session.js";

const RUNTIME_DIR = ".knit/.runtime";

function openStore(dir: string): SqliteMetadataStore {
  return new SqliteMetadataStore(join(dir, RUNTIME_DIR, "metadata.db"));
}

const ROLES = new Set(["implement", "check", "advisory"]);
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
    .option("--role <role>", "implement／check／advisory", "implement")
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
      if (!ROLES.has(role)) {
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
        },
      );
    });

  program
    .command("context")
    .description("生成阶段分层输入计划：需求、规范／角色、指纹与注入清单")
    .option("--task <taskId>", "任务 ID")
    .option("--role <role>", "implement／check／advisory", "implement")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const requestId = `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const role = options.role as SessionRole;
      if (!options.task) {
        console.error("knit: context 需要 --task <taskId>");
        process.exitCode = 1;
        return;
      }
      if (!ROLES.has(role)) {
        console.error(`knit: 未知 --role "${options.role}"`);
        process.exitCode = 1;
        return;
      }
      await withStore(
        requestId,
        options.dir,
        async (store) => new ContextPlanner({ store }).plan({ dir: options.dir, taskId: options.task, role }),
        (plan) => {
          console.log(`上下文计划 ${plan.planId}  [${plan.taskId}/${plan.role}]`);
          console.log(`输入摘要: ${plan.inputsDigest.slice(0, 12)}；就绪: ${plan.ready ? "是" : "否"}`);
          for (const section of plan.sections) {
            console.log(
              `  ${section.priority.toString().padStart(3)}  ${section.kind.padEnd(16)}  ${section.path ?? section.sourceId}` +
                `${section.background ? "  (背景)" : ""}`,
            );
          }
          for (const blocker of plan.blockers) console.log(`  阻塞: ${blocker}`);
        },
      );
    });
}
