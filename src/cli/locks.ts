/** 锁只读列表与显式解除（OPERATIONS 第2节）；解除必须提供 owner token。 */
import type { Command } from "commander";
import { LockManager, type LockScope } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { GuardError } from "../application/guard-error.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";

function jsonMode(): boolean {
  return process.argv.includes("--json");
}

function fail(requestId: string, error: unknown): void {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
  else console.error(`knit: ${message}`);
}

function manager(locks: string | undefined): LockManager {
  return new LockManager(locks === undefined ? {} : { root: locks });
}

function scopeOf(value: string): LockScope {
  if (value === "project" || value === "task" || value === "session") return value;
  throw new GuardError("invalid_request", `--scope 需要 project/task/session，收到: ${value}`);
}

export function registerLockCommands(program: Command): void {
  program
    .command("locks")
    .description("只读列出本机项目／任务／Session 锁及进程核实结论")
    .option("--locks <dir>", "锁根目录")
    .action((options) => {
      const requestId = `locks-${Date.now()}`;
      try {
        const entries = manager(options.locks).list();
        if (jsonMode()) {
          emit(jsonResponse(requestId, "completed", { entries }));
          return;
        }
        if (entries.length === 0) {
          console.log("无锁记录（只读；未创建锁根）");
          return;
        }
        for (const entry of entries) {
          const owner = entry.owner;
          console.log(
            `${entry.id}  ${entry.key ?? `#${entry.hash}`}  ${entry.processVerdict}` +
              `${owner ? `  pid=${owner.pid}  token=${owner.token}` : "  owner=缺失/损坏"}` +
              `  action=${owner?.action ?? "未知"}  heartbeat=${owner?.heartbeatAt ?? "未知"}`,
          );
        }
      } catch (error) {
        fail(requestId, error);
      }
    });

  program
    .command("unlock")
    .description("显式解除一个锁；必须提供 owner token，alive／unknown 需 --force（不改业务状态）")
    .argument("[lockId]", "锁 ID（scope/hash，来自 knit locks）")
    .requiredOption("--scope <scope>", "project/task/session")
    .option("--key <key>", "锁键；project 默认使用 --dir 规范化路径")
    .requiredOption("--expect-token <token>", "当前 owner token（来自 knit locks）")
    .option("--force", "已核实 alive／unknown 时仍解除（仍然要求 token 匹配）")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录（project 锁默认键）", ".")
    .action((lockId, options) => {
      const requestId = `unlock-${Date.now()}`;
      try {
        let scope = scopeOf(String(options.scope));
        let key = options.key !== undefined ? String(options.key) : scope === "project" ? normalizeRoot(options.dir) : null;
        if (lockId !== undefined) {
          const [idScope, idHash] = String(lockId).split("/");
          if ((idScope !== "project" && idScope !== "task" && idScope !== "session") || idHash === undefined) {
            throw new GuardError("invalid_request", `非法 lock-id: ${lockId}`);
          }
          const entry = manager(options.locks).list().find((item) => item.id === lockId);
          if (entry === undefined) throw new GuardError("unknown_lock", `锁不存在: ${lockId}`);
          scope = idScope;
          key = entry.key ?? (idScope === "project" ? normalizeRoot(options.dir) : null);
        }
        if (key === null) throw new GuardError("invalid_request", "--scope task/session 需要 --key 或 lock-id");
        const result = manager(options.locks).unlock({
          key: { scope, rawKey: key },
          expectToken: String(options.expectToken),
          force: options.force === true,
        });
        if (jsonMode()) {
          emit(jsonResponse(requestId, "completed", result));
          return;
        }
        console.log(result.removed ? `已解除 ${scope} 锁: ${key}` : `锁不存在或已解除: ${scope} ${key}`);
      } catch (error) {
        fail(requestId, error);
      }
    });
}

