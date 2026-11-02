/** init 命令：确认项目根、计划、执行初始化；--check 只读。 */
import { Command } from "commander";
import { InitializationService } from "../application/initialization.js";
import { emit, formatPlanItem, jsonResponse, outcomeForError, reasonForError } from "./output.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("在项目中生成最小工作流、角色与受管桥接（不启动 Pi、不调用模型、不安装依赖、不提交 Git）")
    .option("--client <client>", "客户端适配 ID", "pi")
    .option("--dir <dir>", "目标项目目录（默认当前目录）", ".")
    .option("--check", "只展示计划，不写任何文件")
    .option("--force", "受管内容与基线不一致时按新模板覆盖（人工改动先报告）")
    .action(async (options) => {
      const requestId = `init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const service = new InitializationService();
        if (options.check) {
          const plan = service.check(options.dir);
          if (program.opts().json || process.env.KNIT_JSON === "1") {
            emit(jsonResponse(requestId, "completed", plan));
          } else {
            console.log(`项目根: ${plan.root}${plan.resolvedFrom ? `（由 ${plan.resolvedFrom} 归一）` : ""}`);
            console.log(`Git 仓库: ${plan.isGitRepo ? "是" : "否（资料可初始化；正式执行需 Git）"}`);
            if (plan.gitWarning) console.log(`注意: ${plan.gitWarning}`);
            console.log(`计划（${plan.items.length} 项）:`);
            for (const item of plan.items) console.log(formatPlanItem(item));
          }
          return;
        }
        if (options.client !== "pi") {
          const reason = `不支持的客户端适配 ID "${options.client}"；首版仅内置 pi`;
          if (program.opts().json || process.env.KNIT_JSON === "1") {
            emit(jsonResponse(requestId, "error", { reason }, "invalid_request"));
          } else {
            console.error(`knit: ${reason}`);
            process.exitCode = 1;
          }
          return;
        }
        const result = await service.execute({ dir: options.dir, client: options.client, force: options.force });
        if (program.opts().json || process.env.KNIT_JSON === "1") {
          emit(jsonResponse(requestId, result.ready ? "completed" : "needs_attention", result, result.ready ? undefined : "needs_review"));
        } else {
          console.log(`项目根: ${result.root}`);
          console.log(`清单状态: ${result.manifestState}`);
          if (result.created.length) console.log(`创建: ${result.created.join(", ")}`);
          if (result.kept.length) console.log(`沿用: ${result.kept.length} 个项目文件`);
          if (result.updated.length) console.log(`更新: ${result.updated.join(", ")}`);
          for (const conflict of result.conflicts) console.log(`冲突（未覆盖）: ${conflict}`);
          for (const failure of result.failed) console.log(`失败: ${failure.path} — ${failure.error}`);
          if (result.gitWarning) console.log(`注意: ${result.gitWarning}`);
          if (result.ready) {
            console.log("初始化完成：桥接按宿主项目信任规则加载（新会话自动加载；已有会话 /reload 或重启）。");
          } else {
            console.log("初始化未完成：逐项结果见 .knit/.runtime/init-manifest.json；处理后重试 knit init。");
            process.exitCode = 1;
          }
        }
      } catch (error) {
        const reason = reasonForError(error);
        const outcome = outcomeForError(error);
        const message = error instanceof Error ? error.message : String(error);
        if (program.opts().json || process.env.KNIT_JSON === "1") {
          emit(jsonResponse(requestId, outcome, { error: message }, reason));
        } else {
          console.error(`knit: ${message}`);
          process.exitCode = 1;
        }
      }
    });
}
