/** gc 命令：引用核验的只读预览与显式回收（默认不删除）。 */
import { Command } from "commander";
import { GcService, type GcApplyItem, type GcCandidate, type GcPreviewResult } from "../application/gc.js";
import { LockManager } from "../infrastructure/locks.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";

function itemLine(item: GcCandidate): string {
  return `[${item.kind}] ${item.path}  ${item.sizeBytes} B — ${item.reason}`;
}

function printPreview(result: GcPreviewResult): void {
  console.log(`gc 预览（只读，未删除任何文件）：${result.counts.candidates} 个候选`);
  for (const candidate of result.candidates) {
    console.log(`  ${itemLine(candidate)}`);
    for (const evidence of candidate.evidence) console.log(`    证据: ${evidence}`);
  }
  if (result.counts.candidates === 0) console.log("  无候选。");
  if (result.skipped.length > 0) {
    console.log(`不收集 ${result.skipped.length} 项：`);
    for (const skipped of result.skipped) {
      console.log(`  [${skipped.kind}] ${skipped.path}  ${skipped.sizeBytes} B — ${skipped.reason}`);
    }
  }
  console.log("执行回收需显式 --apply；未执行时不改任何文件。");
}

function printApply(result: Awaited<ReturnType<GcService["apply"]>>): void {
  console.log(`gc 执行: ${result.state}；移除 ${result.counts.removed}，跳过 ${result.counts.skipped}，失败 ${result.counts.failed}`);
  for (const item of result.items as GcApplyItem[]) {
    console.log(`  ${item.status}  ${itemLine(item)}`);
    if (item.outcomeReason !== item.reason) console.log(`    原因: ${item.outcomeReason}`);
  }
  console.log(`记录: ${result.recordPath}`);
}

export function registerGcCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const fail = (requestId: string, error: unknown): void => {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode()) emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
    else console.error(`knit: ${message}`);
  };

  program
    .command("gc")
    .description("引用核验后预览或回收中断快照临时目录、孤儿会话目录与无引用终态 run；默认只读")
    .option("--apply", "执行回收（全程持项目写锁，逐项重新核验；仅删除仍满足条件的候选）")
    .option("--locks <dir>", "锁根目录")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = `gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const locks = options.locks === undefined ? undefined : new LockManager({ root: String(options.locks) });
        const service = new GcService(locks === undefined ? {} : { locks });
        if (options.apply !== true) {
          const result = service.preview({
            dir: String(options.dir),
            ...(options.locks === undefined ? {} : { locksRoot: String(options.locks) }),
          });
          if (jsonMode()) {
            emit(jsonResponse(requestId, "completed", result));
            return;
          }
          printPreview(result);
          return;
        }
        const result = await service.apply({
          dir: String(options.dir),
          ...(options.locks === undefined ? {} : { locksRoot: String(options.locks) }),
        });
        if (jsonMode()) {
          emit(jsonResponse(requestId, result.state === "completed" ? "completed" : "needs_attention", result));
        } else {
          printApply(result);
        }
        if (result.state !== "completed") process.exitCode = 1;
      } catch (error) {
        fail(requestId, error);
      }
    });
}
