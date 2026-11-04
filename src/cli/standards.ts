/** standards 命令组：list/propose/review/apply/pending/migrate（DESIGN.md 第8.2节）。 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { StandardsService } from "../application/standards-service.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";
import { cliMainRoot } from "./root.js";

const RUNTIME_DIR = ".knit/.runtime";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerStandardsCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const standards = program.command("standards").description("项目规范候选、审阅、采纳与旧任务候选迁移");

  const withService = async <T>(
    requestId: string,
    dir: string,
    fn: (service: StandardsService) => Promise<T>,
    render: (result: T) => void,
  ): Promise<void> => {
    const store = new SqliteMetadataStore(join(cliMainRoot(dir), RUNTIME_DIR, "metadata.db"));
    try {
      const service = new StandardsService({ store });
      const result = await fn(service);
      if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
      else render(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
      if (jsonMode()) {
        emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
      } else {
        console.error(`knit: ${message}`);
      }
    } finally {
      store.close();
    }
  };

  standards
    .command("list")
    .description("列出正式规范、索引引用、项目候选与迁移提示")
    .option("--task <taskId>", "同时只读列出该任务的旧 standards.md 候选")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      await withService(
        "standards-list",
        options.dir,
        (service) => service.list({ dir: options.dir, taskId: options.task }),
        (result) => {
          console.log(`正式规范（${result.formal.length}）：`);
          for (const file of result.formal) {
            console.log(`  ${file.path}${file.indexed ? "" : "（索引未引用）"}`);
          }
          console.log(`项目候选（${result.candidates.length}）：`);
          for (const candidate of result.candidates) {
            console.log(`  ${candidate.candidateId} ${candidate.title}`);
          }
          console.log(`项目审阅：${result.pending.reason}`);
          if (result.migration.unmigrated > 0) {
            console.log(`旧任务候选尚未迁移 ${result.migration.unmigrated} 条；可运行 knit standards migrate。`);
          }
          if (result.task !== undefined) {
            console.log(`旧任务候选（${result.task.candidates.length}）：`);
            for (const candidate of result.task.candidates) {
              console.log(`  ${candidate.candidateId} ${candidate.title}`);
            }
            console.log(`旧任务审阅：${result.task.pending.reason}`);
          }
        },
      );
    });

  standards
    .command("propose")
    .description("把可复用规则保存为项目级候选（.knit/standards/candidates.md）")
    .option("--task <taskId>", "来源任务（仅标注，不要求任务存在）")
    .option("--source <text>", "来源说明，如讨论、实施发现")
    .option("--title <title>", "候选标题")
    .option("--problem <text>", "发现的问题／缺口")
    .option("--evidence <text>", "证据")
    .option("--scope <text>", "适用范围")
    .option("--rule <text>", "建议规则")
    .option("--verification <text>", "验证／示例")
    .option("--file <path>", "JSON 文件（多行字段；命令行选项优先）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      await withService(
        "standards-propose",
        options.dir,
        async (service) => {
          const fromFile =
            options.file === undefined
              ? {}
              : (JSON.parse(readFileSync(options.file, "utf8")) as Record<string, string>);
          const field = (name: string) => options[name] ?? fromFile[name] ?? "";
          if (field("title") === "" || field("problem") === "" || field("rule") === "") {
            throw new Error("候选必须提供 --title、--problem 与 --rule");
          }
          return service.propose({
            dir: options.dir,
            ...(options.task === undefined ? {} : { sourceTaskId: options.task }),
            ...(field("source") === "" ? {} : { source: field("source") }),
            title: field("title"),
            problem: field("problem"),
            evidence: field("evidence"),
            scope: field("scope"),
            rule: field("rule"),
            verification: field("verification"),
          });
        },
        (result) => {
          console.log(`已保存候选 ${result.candidate.candidateId}：${result.candidate.title}`);
          console.log(`文件: ${result.file}`);
        },
      );
    });

  standards
    .command("review")
    .description("保存主 Agent 的审阅决定、理由与目标规范")
    .option("--task <taskId>", "来源任务（仅标注，不参与匹配）")
    .requiredOption("--decision <decision>", "applied/deferred/rejected/mixed")
    .requiredOption("--reason <reason>", "决定理由")
    .option("--target <path>", "目标正式规范（可重复）", collect, [])
    .option("--candidate <id>", "覆盖的候选 ID（可重复；省略为全部）", collect, [])
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const decision = options.decision;
      if (!["applied", "deferred", "rejected", "mixed"].includes(decision)) {
        const message = `未知审阅决定: ${decision}`;
        process.exitCode = 1;
        if (jsonMode()) {
          emit(jsonResponse("standards-review", "error", { error: message }, "invalid_request"));
        } else {
          console.error(`knit: ${message}`);
        }
        return;
      }
      await withService(
        "standards-review",
        options.dir,
        (service) =>
          service.review({
            dir: options.dir,
            ...(options.task === undefined ? {} : { sourceTaskId: options.task }),
            decision,
            reason: options.reason,
            targets: options.target,
            candidateIds: options.candidate.length === 0 ? undefined : options.candidate,
          }),
        (result) => {
          console.log(`已记录审阅 ${result.review.reviewId}：${result.review.decision}`);
          console.log(`项目提示状态: ${result.pending.reason}`);
        },
      );
    });

  standards
    .command("apply")
    .description("按匹配回执把项目候选规则写入正式规范并补索引")
    .requiredOption("--candidate <id>", "候选 ID")
    .requiredOption("--target <path>", "目标正式规范")
    .option("--task <taskId>", "来源任务（仅标注）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      await withService(
        "standards-apply",
        options.dir,
        (service) =>
          service.apply({
            dir: options.dir,
            ...(options.task === undefined ? {} : { sourceTaskId: options.task }),
            candidateId: options.candidate,
            target: options.target,
          }),
        (result) => {
          if (result.alreadyApplied) {
            console.log(`候选 ${result.candidateId} 已写入 ${result.target}，未重复追加`);
          } else {
            console.log(`已采纳 ${result.candidateId} → ${result.target}`);
          }
          console.log(`正式规范摘要: ${result.standardsDigest.slice(0, 12)}${result.indexUpdated ? "；索引已更新" : ""}`);
          if (result.affectedTasks.length > 0) {
            console.log(`正式规则变化影响任务（检查需重新核对）：${result.affectedTasks.join(", ")}`);
          }
        },
      );
    });

  standards
    .command("pending")
    .description("机械提示项目级候选是否缺少匹配回执")
    .option("--task <taskId>", "同时只读显示该任务的旧候选状态")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      await withService(
        "standards-pending",
        options.dir,
        (service) => service.pending({ dir: options.dir, taskId: options.task }),
        (result) => {
          console.log(`项目候选: ${result.candidateIds.length}；状态: ${result.reason}`);
          if (result.needsReview) console.log("需要主 Agent 审阅（standards review）；延期／拒绝也可继续。");
          if (result.legacy !== undefined) {
            console.log(`旧任务候选: ${result.legacy.candidateIds.length}；状态: ${result.legacy.reason}`);
          }
        },
      );
    });

  standards
    .command("migrate")
    .description("把旧任务 standards.md 的候选幂等迁入项目候选文件，不改写原文件")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      await withService(
        "standards-migrate",
        options.dir,
        (service) => service.migrate({ dir: options.dir }),
        (result) => {
          console.log(`已迁移 ${result.migrated} 条候选${result.skipped > 0 ? `（跳过已有 ${result.skipped} 条）` : ""}。`);
          for (const source of result.sources) {
            console.log(`  ${source.taskId}: ${source.candidateIds.join(", ")}`);
          }
          if (result.migrated === 0 && result.skipped === 0) console.log("没有找到旧任务候选。");
        },
      );
    });
}
