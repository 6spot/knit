import { Option, type Command } from "commander";
import { hostProjectRoot, selectHostTask } from "../application/host-hook.js";
import { initProject } from "../application/init.js";
import { buildSessionContext, contextLines } from "../application/session-context.js";
import { legacyStandardCopies, loadStandards, savePitfall } from "../application/project-config.js";
import { AGENT_SPECS, DEFAULT_AGENT, WORKFLOW_ANCHORS, WORKFLOW_CONFIG_PATH, isReportEnum } from "../contracts/workflow.js";
import { PITFALLS_PATH, pitfallScope, pitfallSections } from "../domain/pitfalls.js";
import { standardsForStage, type Standard } from "../domain/standards.js";
import { WORKFLOW_ANCHOR_NAMES, type WorkflowDefinition, type WorkflowExecutor, type WorkflowStage } from "../domain/workflow.js";
import { fail, knitRoot, loadWorkflow, projectRoot } from "./shared.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("生成项目流程、角色文件和配置；通用规范随安装包加载")
    .option("--pi", "安装 Pi 项目桥接")
    .option("--agy", "安装 Antigravity 项目插件")
    .option("--workbuddy", "安装 WorkBuddy 桌面端主会话钩子")
    .option("--force", "备份并恢复流程、角色文件以及本次指定或已有的宿主桥接")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string; force?: boolean; pi?: boolean; agy?: boolean; workbuddy?: boolean }) => {
      const root = projectRoot(options.dir);
      const result = initProject(root, options.force, options);
      const lines = [
        ...section("已生成:", result.created),
        ...section("已恢复成模板:", result.restored),
        ...(result.backupDir === null ? [] : [`备份: ${result.backupDir}/`]),
        ...section("已有，没有动:", result.kept),
        ...section("旧版通用规范副本（保留原文，已停用；请把项目定制迁入另名的项目规范）:", legacyStandardCopies(root)),
        ...(result.task === null
          ? []
          : [`初始化任务: ${result.task.id}（${result.task.file}）`]),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}

/** 没有内容的一段整段不出现。 */
function section(title: string, targets: readonly string[]): string[] {
  return targets.length === 0 ? [] : [title, ...targets.map((target) => `  ${target}`)];
}

export function registerContextCommand(program: Command): void {
  program
    .command("context [id]")
    .description("主会话每轮收到的讨论规范；指定任务时追加状态、下一步和当前环节的补充规范")
    .addOption(new Option("--use <id>", "为当前宿主会话选中任务").conflicts("unuse"))
    .option("--unuse", "清除当前宿主会话的任务选择")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string | undefined, options: { dir: string; use?: string; unuse?: boolean }) => {
      if (options.use !== undefined || options.unuse) {
        if (id !== undefined) return fail(["选择任务时请使用 knit context --use <id> 或 knit context --unuse"]);
        const host = process.env.KNIT_HOST;
        const sessionId = process.env.KNIT_HOST_SESSION;
        if (!host || !sessionId) return fail(["选择任务需要 KNIT_HOST 和 KNIT_HOST_SESSION"]);
        const root = hostProjectRoot(options.dir);
        if (root === null) return fail(["这个项目里没有 .knit/ 目录"]);
        const problems = selectHostTask(root, { host, sessionId }, options.use ?? null);
        if (problems.length) return fail(problems);
        process.stdout.write(options.unuse ? "已取消选中\n" : `已选中 ${options.use}\n`);
        return;
      }
      const root = knitRoot(options.dir);
      if (root === null) return;
      const context = buildSessionContext(root, id);
      if (context.kind === "refused") return fail(context.problems);
      process.stdout.write(`${contextLines(context).join("\n")}\n`);
    });
}

function stagesColumn(standard: Standard, known: readonly string[]): string {
  if (standard.problems.length) return `开头声明有问题，不会注入：${standard.problems[0]}`;
  const sections = standard.path === PITFALLS_PATH ? pitfallSections(standard.body) : null;
  const stages = sections?.flatMap((section) => section.stages) ?? standard.stages;
  const unknown = [...new Set(stages.filter((stage) => !known.includes(stage)))];
  const label = sections === null ? (stages.join(", ") || "没有声明适用的环节，不会注入")
    : `分区：${sections.map((section) => section.heading).join(" / ") || "暂无"}`;
  return label + (unknown.length ? `（流程里没有的环节：${unknown.join("、")}）` : "");
}

function knownStages(dir: string): string[] | null {
  const workflow = loadWorkflow(dir);
  if (workflow) return [...WORKFLOW_ANCHORS, ...workflow.stages.map((stage) => stage.id)];
  process.exitCode = 1;
  return null;
}

export function registerStandardsCommands(program: Command): void {
  const standards = program.command("standards").description("查看内置规范和项目规范，维护项目避坑清单");
  standards.command("list")
    .description("列出规范来源、适用环节和旧版副本")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string }) => {
      const known = knownStages(options.dir);
      if (!known) return;
      const root = projectRoot(options.dir);
      const lines = loadStandards(root).map((standard) => `${standard.path}  ${standard.title}  ${stagesColumn(standard, known)}`);
      lines.push(...legacyStandardCopies(root).map((path) => `${path}  旧版副本，已停用；请把项目定制迁入另名的项目规范`));
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  standards.command("pitfalls <stage>")
    .description("查看通用区和适用于指定环节的避坑条目")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((stage: string, options: { dir: string }) => {
      const known = knownStages(options.dir);
      if (!known) return;
      if (!known.includes(stage)) return fail([`流程里没有的环节：${stage}`]);
      const checklist = loadStandards(projectRoot(options.dir)).filter(({ path }) => path === PITFALLS_PATH);
      const [selected] = standardsForStage(checklist, stage);
      process.stdout.write(`${selected?.body ?? "没有适用的避坑条目"}\n`);
    });

  standards.command("record")
    .description("在指定分区记录避坑条目，同名条目补充原文")
    .requiredOption("--section <分区>", "通用或逗号分隔的环节 id")
    .requiredOption("--title <标题>", "条目的三级标题")
    .requiredOption("--body <正文>", "经验或要补充的内容")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string; section: string; title: string; body: string }) => {
      const known = knownStages(options.dir);
      if (!known) return;
      const unknown = pitfallScope(options.section).filter((id) => !known.includes(id));
      if (unknown.length) return fail([`流程里没有的环节：${unknown.join("、")}`]);
      try {
        savePitfall(projectRoot(options.dir), options.section, options.title, options.body);
        process.stdout.write(`${PITFALLS_PATH}（${options.section}）\n`);
      } catch (error) {
        fail([error instanceof Error ? error.message : String(error)]);
      }
    });
}

function chainLine(workflow: WorkflowDefinition): string {
  const names = [WORKFLOW_ANCHOR_NAMES.discuss, ...workflow.stages.map((stage) => stage.name), WORKFLOW_ANCHOR_NAMES.deliver];
  return `流程: ${names.join(" → ")}`;
}

function executorLines(executor: WorkflowExecutor, workflow: WorkflowDefinition, parallel: boolean): string[] {
  const spec = AGENT_SPECS[executor.agent ?? DEFAULT_AGENT];
  const defaults = spec.inheritsWorkflowDefaults ? workflow : null;
  const indent = parallel ? "       " : "     ";
  return [
    ...(parallel ? [`     执行器: ${executor.id}`] : []),
    `${indent}角色文件: ${executor.prompt ?? "（没有指定）"}`,
    `${indent}Agent: ${executor.agent ?? `（由派发入口决定，普通终端用 ${DEFAULT_AGENT}）`}`,
    `${indent}模型: ${executor.model ?? defaults?.model ?? spec.modelDefaultLabel}`,
    `${indent}思考等级: ${executor.thinking ?? defaults?.thinking ?? spec.thinkingDefaultLabel}`,
  ];
}

function stageLines(stage: WorkflowStage, index: number, workflow: WorkflowDefinition): string[] {
  const report = Object.entries(stage.report).map(
    (entry) => `${entry[0]}(${isReportEnum(entry[1]) ? entry[1].join("|") : entry[1]})`,
  );
  const jumps = Object.entries(stage.onVerdict).map((entry) => `${entry[0]} → ${entry[1]}`);
  const tools = stage.tools === null ? "全部放开" : stage.tools.length === 0 ? "全部禁用" : stage.tools.join("、");
  return [
    `  ${index + 1}. ${stage.id}（${stage.name}）`,
    ...(stage.description === null ? [] : [`     说明: ${stage.description}`]),
    ...stage.executors.flatMap((executor) => executorLines(executor, workflow, stage.executors.length > 1)),
    `     工具: ${tools}`,
    ...(report.length === 0 ? [] : [`     报告字段: ${report.join("、")}`]),
    ...(jumps.length === 0 ? [] : [`     按结论跳转: ${jumps.join("；")}`]),
    `     进入次数上限: ${stage.maxVisits === null ? "无" : String(stage.maxVisits)}`,
  ];
}

/** 流程文件由人手工修改，这里只提供查看和校验两个只读命令。 */
export function registerWorkflowCommands(program: Command): void {
  const workflow = program.command("workflow").description(`查看和校验 ${WORKFLOW_CONFIG_PATH}`);

  workflow
    .command("show")
    .description("显示流程和每个环节的配置")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string }) => {
      const loaded = loadWorkflow(options.dir);
      if (loaded === null) {
        process.exitCode = 1;
        return;
      }
      const lines = [chainLine(loaded), `环节（${loaded.stages.length}）：`, ...loaded.stages.flatMap((stage, index) => stageLines(stage, index, loaded))];
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  workflow
    .command("validate")
    .description("校验流程文件，有问题时逐条给出行号")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string }) => {
      const loaded = loadWorkflow(options.dir);
      if (loaded === null) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`配置有效\n${chainLine(loaded)}\n`);
    });
}
