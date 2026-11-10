/** 锁只读列表与显式解除（OPERATIONS 第2节）；解除必须提供 owner token。 */
import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LockManager, heartbeatState, parseLockId, type LockEntry, type LockScope } from "../infrastructure/locks.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { defaultConfig, parseConfig } from "../application/config.js";
import { locksForProject, reclaimsForProject } from "../application/diagnostics.js";
import { GuardError } from "../application/guard-error.js";
import { assertNotInStageContext } from "../application/stage-context.js";
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
  if (value === "project" || value === "task" || value === "session" || value === "state") return value;
  throw new GuardError("invalid_request", `--scope 需要 project/task/session/state，收到: ${value}`);
}

/** 心跳超时阈值：--dir 指向的项目配置优先，缺省 30 秒。 */
function staleMsOf(dir: string | undefined): number {
  const fallback = defaultConfig().limits.heartbeatStaleMs;
  if (dir === undefined) return fallback;
  try {
    const path = join(normalizeRoot(dir), ".knit", "config.json");
    return existsSync(path) ? parseConfig(readFileSync(path, "utf8")).limits.heartbeatStaleMs : fallback;
  } catch {
    return fallback;
  }
}

export function registerLockCommands(program: Command): void {
  program
    .command("locks")
    .description("只读列出本机工作树租约（project）／任务／Session／状态（state）锁、进程核实与心跳；--dir 只列该项目")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "只列该项目（主检出根、任务键、worktree 与本项目阶段 Session）")
    .action((options) => {
      const requestId = `locks-${Date.now()}`;
      try {
        const locks = manager(options.locks);
        const root = options.dir === undefined ? null : normalizeRoot(String(options.dir));
        const all = locks.list();
        const listed = root === null ? all : locksForProject(root, all);
        const staleMs = staleMsOf(options.dir as string | undefined);
        const nowMs = Date.now();
        const entries = listed.map((entry) => ({
          ...entry,
          heartbeat: heartbeatState(entry.owner, nowMs, staleMs),
          reclaimable: locks.reclaimable(entry),
        }));
        const reclaimedAll = locks.listReclaimed();
        const reclaimed = (root === null ? reclaimedAll : reclaimsForProject(root, reclaimedAll)).slice(0, 10);
        if (jsonMode()) {
          emit(jsonResponse(requestId, "completed", { entries, heartbeatStaleMs: staleMs, reclaimed, projectRoot: root }));
          return;
        }
        if (entries.length === 0) {
          console.log(root === null ? "无锁记录（只读；未创建锁根）" : `无本项目锁记录: ${root}`);
        }
        for (const entry of entries) {
          const owner = entry.owner;
          const heartbeat = entry.heartbeat === "stale" ? `超时>${staleMs}ms` : entry.heartbeat === "fresh" ? "正常" : "未知";
          console.log(
            `${entry.id}  ${entry.key ?? `#${entry.hash}`}  ${entry.processVerdict}${entry.reclaimable ? "（可自动回收）" : ""}` +
              `${owner ? `  pid=${owner.pid}  token=${owner.token}` : "  owner=缺失/损坏"}` +
              `  action=${owner?.action ?? "未知"}  heartbeat=${owner?.heartbeatAt ?? "未知"}（${heartbeat}）`,
          );
        }
        for (const record of reclaimed) {
          console.log(`已自动回收 ${record.reclaimedAt}  ${record.id}  原 ${record.previousOwner.action} pid=${record.previousOwner.pid}  由 ${record.reclaimedBy.action}`);
        }
      } catch (error) {
        fail(requestId, error);
      }
    });

  program
    .command("unlock")
    .description("显式解除一个锁；必须提供 owner token，alive／unknown 需 --force（不改业务状态）")
    .argument("[lockId]", "锁 ID（scope/hash，来自 knit locks）；给出时无需 --scope／--key")
    .option("--scope <scope>", "project/task/session/state（未给 lockId 时必填）")
    .option("--key <key>", "锁键；project 默认使用 --dir 规范化路径")
    .option("--expect-token <token>", "当前 owner token（来自 knit locks）")
    .option("--from-list", "使用 knit locks 当前列出的 owner token（只在 owner 已确认 not_alive 时可用）")
    .option("--force", "已核实 alive／unknown 时仍解除（仍然要求 token 匹配）")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录（project 锁默认键）", ".")
    .action((lockId, options) => {
      const requestId = `unlock-${Date.now()}`;
      try {
        assertNotInStageContext("unlock");
        const locks = manager(options.locks);
        const fromList = options.fromList === true;
        if (options.expectToken === undefined && !fromList) {
          throw new GuardError("invalid_request", "需要 --expect-token <token>（来自 knit locks），或 --from-list 确认使用列表中的 token");
        }
        let entry: LockEntry | undefined;
        let label: string;
        if (lockId !== undefined) {
          const parsed = parseLockId(String(lockId));
          if (parsed === null) throw new GuardError("invalid_request", `非法 lock-id: ${lockId}（应为 scope/hash，来自 knit locks）`);
          if (options.scope !== undefined && scopeOf(String(options.scope)) !== parsed.scope) {
            throw new GuardError("invalid_request", `--scope 与 lock-id 不一致: ${options.scope} vs ${parsed.scope}`);
          }
          entry = locks.list().find((item) => item.id === lockId);
          if (entry === undefined) throw new GuardError("unknown_lock", `锁不存在: ${lockId}`);
          label = `${entry.id}${entry.key === null ? "" : `（${entry.key}）`}`;
        } else {
          if (options.scope === undefined) throw new GuardError("invalid_request", "需要 lock-id（scope/hash），或 --scope 加 --key");
          const scope = scopeOf(String(options.scope));
          const key = options.key !== undefined ? String(options.key) : scope === "project" ? normalizeRoot(options.dir) : null;
          if (key === null) throw new GuardError("invalid_request", "--scope task/session/state 需要 --key 或 lock-id");
          entry = { ...locks.inspect({ scope, rawKey: key }), scope, id: "", hash: "", path: "", key };
          label = `${scope} ${key}`;
          const ownerToken = resolveToken(entry, options.expectToken as string | undefined, fromList, options.force === true);
          const unlocked = locks.unlock({ key: { scope, rawKey: key }, expectToken: ownerToken, force: options.force === true });
          report(requestId, unlocked, label);
          return;
        }
        const ownerToken = resolveToken(entry, options.expectToken as string | undefined, fromList, options.force === true);
        const unlocked = locks.unlockById({ id: entry.id, expectToken: ownerToken, force: options.force === true });
        report(requestId, unlocked, label);
      } catch (error) {
        fail(requestId, error);
      }
    });
}

/**
 * 解除使用的 token：--expect-token 优先，--from-list 仅在 owner 已确认 not_alive 且未 --force 时
 * 取列表中的 token（便捷确认）；alive／unknown 必须显式给出 token，不用列表结果代替人工核对。
 */
function resolveToken(entry: LockEntry, expectToken: string | undefined, fromList: boolean, force: boolean): string {
  if (expectToken !== undefined) {
    if (fromList && entry.owner !== null && entry.owner.token !== expectToken) {
      throw new GuardError("invalid_request", `--expect-token 与列表中的 owner token 不一致（${entry.owner.token}）；重新运行 knit locks 核对`);
    }
    return expectToken;
  }
  if (entry.owner === null) {
    throw new GuardError("invalid_request", "owner 缺失/损坏，--from-list 无 token 可用；核实后用 --expect-token <任意> --force");
  }
  if (force || entry.processVerdict !== "not_alive") {
    throw new GuardError("invalid_request", `owner ${entry.processVerdict}：--from-list 只用于已确认 not_alive 的锁；核实后显式给 --expect-token ${entry.owner.token}${entry.processVerdict === "not_alive" ? "" : " --force"}`);
  }
  return entry.owner.token;
}

function report(requestId: string, result: LockEntry & { removed: boolean }, label: string): void {
  if (jsonMode()) {
    emit(jsonResponse(requestId, "completed", result));
    return;
  }
  console.log(result.removed ? `已解除锁: ${label}` : `锁不存在或已解除: ${label}`);
}
