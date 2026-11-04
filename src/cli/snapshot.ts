/** snapshot 命令组：只读对照、逐路径恢复预览与执行（DESIGN.md 第13节）。 */
import { Command } from "commander";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../infrastructure/locks.js";
import { RunStore } from "../infrastructure/run-store.js";
import { RestoreService } from "../application/restore.js";
import { GuardError } from "../application/guard-error.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cliMainRoot } from "./root.js";

const RUNTIME_DIR = ".knit/.runtime";

function openStore(dir: string): SqliteMetadataStore {
  return new SqliteMetadataStore(join(cliMainRoot(dir), RUNTIME_DIR, "metadata.db"));
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseExpect(values: string[], paths: string[]): Record<string, string> {
  if (values.length === 0) throw new GuardError("expect_required", "执行恢复需要 --expect <当前指纹>");
  const result: Record<string, string> = {};
  for (const value of values) {
    const equals = value.indexOf("=");
    if (equals > 0) {
      const path = value.slice(0, equals);
      const fingerprint = value.slice(equals + 1);
      if (path === "" || fingerprint === "") throw new GuardError("invalid_request", `非法 --expect: ${value}`);
      result[path] = fingerprint;
    } else {
      if (paths.length !== 1) throw new GuardError("invalid_request", "多个路径必须使用 --expect <path=指纹>");
      result[paths[0]!] = value;
    }
  }
  return result;
}

function formatPlan(plan: Awaited<ReturnType<RestoreService["preview"]>>): string {
  const lines = [
    `run: ${plan.runId}；任务: ${plan.taskId}`,
    `分支: ${plan.branch ?? "detached"}；HEAD: ${plan.head ?? "无"}；快照: ${plan.snapshotDigest.slice(0, 12)}`,
    `模式: ${plan.index ? "worktree+index" : "仅 worktree"}${plan.removeCreated ? "；允许删除快照中不存在的路径" : ""}`,
  ];
  for (const item of plan.plans) {
    const index = item.indexAction === "ignored" ? "" : `；index ${item.indexAction}`;
    const guard = item.guard === null ? "" : `；保护 ${item.guard}`;
    lines.push(`  ${item.action}  ${item.path}  当前 ${item.current.fingerprint} → 快照 ${item.snapshot.fingerprint}${index}${guard}`);
  }
  return lines.join("\n");
}

export function registerSnapshotCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const snapshot = program.command("snapshot").description("对照快照并逐路径恢复");

  snapshot
    .command("show")
    .description("只读显示快照对照（不输出文件正文）")
    .argument("<runId>", "run ID")
    .option("--path <path>", "只显示指定相对路径")
    .option("--dir <dir>", "项目目录", ".")
    .action((runId, options) => {
      const requestId = `snapshot-show-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const store = new RunStore(options.dir);
        const manifest = store.readSnapshot(runId);
        if (manifest === null) throw new GuardError("snapshot_missing", `run 没有快照: ${runId}`);
        const entries = options.path === undefined ? manifest.entries : manifest.entries.filter((entry: { path: string }) => entry.path === options.path);
        const data = { runId, manifest, entries };
        if (jsonMode()) emit(jsonResponse(requestId, "completed", data));
        else {
          console.log(`run: ${runId}；快照: ${manifest.state}；${manifest.createdAt}`);
          console.log(`base: ${manifest.base.branch ?? "detached"} @ ${manifest.base.head ?? "无"}；覆盖 tracked=${manifest.coverage.tracked} index=${manifest.coverage.index} untracked=${manifest.coverage.untracked}`);
          console.log(`计数: tracked=${manifest.counts.tracked} untracked=${manifest.counts.untracked} absent=${manifest.counts.absent} bytes=${manifest.bytes}`);
          if (manifest.reason !== null) console.log(`原因: ${manifest.reason}`);
          for (const entry of entries) {
            console.log(`  ${entry.absent ? "缺失" : entry.kind}  ${entry.path}  ${entry.digest ?? "-"}  index=${entry.indexOid ?? "-"}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
        else console.error(`knit: ${message}`);
      }
    });

  snapshot
    .command("restore")
    .description("预览或执行逐路径恢复；默认只预览")
    .argument("<runId>", "run ID")
    .option("--path <path>", "恢复路径（可重复）", collect, [])
    .option("--expect <path=指纹|指纹>", "当前 worktree 指纹（可重复；提供后才执行）", collect, [])
    .option("--index", "同时恢复选中路径的 index 内容")
    .option("--remove-created", "允许删除快照中不存在的后来新建路径")
    .option("--dir <dir>", "项目目录", ".")
    .option("--locks <dir>", "锁目录")
    .action(async (runId, options) => {
      const requestId = `snapshot-restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dir = String(options.dir);
      let store: SqliteMetadataStore | null = null;
      try {
        store = openStore(dir);
        const locks = options.locks === undefined ? undefined : new LockManager({ root: String(options.locks) });
        const service = new RestoreService({ store, locks });
        const paths = options.path as string[];
        const expectValues = options.expect as string[];
        if (expectValues.length === 0) {
          const plan = service.preview({ dir, runId, paths, index: options.index === true, removeCreated: options.removeCreated === true });
          if (jsonMode()) emit(jsonResponse(requestId, "completed", { preview: plan }));
          else console.log(formatPlan(plan));
          return;
        }
        const expect = parseExpect(expectValues, paths);
        const result = await service.restore({
          dir,
          runId,
          paths,
          index: options.index === true,
          removeCreated: options.removeCreated === true,
          expect,
        });
        if (jsonMode()) emit(jsonResponse(requestId, result.state === "completed" ? "completed" : "needs_attention", result));
        else {
          console.log(`恢复完成: ${result.operationId}；任务 ${result.taskId}；状态 ${result.state}`);
          console.log(`记录: ${result.recordPath}；检查失效: ${result.checkInvalidated ? "是" : "否"}；任务输入更新: ${result.taskInputUpdated ? "是" : "否"}`);
          for (const item of result.results) console.log(`  ${item.status}  ${item.path}  ${item.after.fingerprint}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
        else console.error(`knit: ${message}`);
      } finally {
        store?.close();
      }
    });
}
