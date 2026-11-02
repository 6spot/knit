/** standards 命令组：list/propose/review/apply/pending（DESIGN.md 第8.2节）。 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { StandardsService } from "../application/standards-service.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";

const RUNTIME_DIR = ".knit/.runtime";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerStandardsCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const standards = program.command("standards").description("规范候选、审阅与采纳");

  const withService = async <T>(
    requestId: string,
    dir: string,
    fn: (service: StandardsService) => Promise<T>,
    render: (result: T) => void,
  ): Promise<void> => {
    const store = new SqliteMetadataStore(join(dir, RUNTIME_DIR, "metadata.db"));
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
    .description("列出正式规范、索引引用与任务候选")
    .option("--task <taskId>", "同时列出该任务的候选与回执状态")
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
          if (result.task !== undefined) {
            console.log(`候选（${result.task.candidates.length}）：`);
            for (const candidate of result.task.candidates) {
              console.log(`  ${candidate.candidateId} ${candidate.title}`);
            }
            console.log(`审阅：${result.task.pending.reason}`);
          }
        },
      );
    });

  standards
    .command("propose")
    .description("把规范候选写入任务辅助资料 standards.md")
    .requiredOption("--task <taskId>", "任务 ID")
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
            taskId: options.task,
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
    .requiredOption("--task <taskId>", "任务 ID")
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
            taskId: options.task,
            decision,
            reason: options.reason,
            targets: options.target,
            candidateIds: options.candidate.length === 0 ? undefined : options.candidate,
          }),
        (result) => {
          console.log(`已记录审阅 ${result.review.reviewId}：${result.review.decision}`);
          console.log(`提示状态: ${result.pending.reason}`);
        },
      );
    });

  standards
    .command("apply")
    .description("按匹配回执把候选规则写入正式规范并补索引")
    .requiredOption("--task <taskId>", "任务 ID")
    .requiredOption("--candidate <id>", "候选 ID")
    .requiredOption("--target <path>", "目标正式规范")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      await withService(
        "standards-apply",
        options.dir,
        (service) =>
          service.apply({
            dir: options.dir,
            taskId: options.task,
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
    .description("机械提示：有候选且缺少匹配回执时要求主 Agent 处理")
    .requiredOption("--task <taskId>", "任务 ID")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      await withService(
        "standards-pending",
        options.dir,
        (service) => service.pending({ dir: options.dir, taskId: options.task }),
        (result) => {
          console.log(`候选: ${result.candidateIds.length}；状态: ${result.reason}`);
          if (result.needsReview) console.log("需要主 Agent 审阅（standards review）；延期／拒绝也可继续。");
        },
      );
    });
}
