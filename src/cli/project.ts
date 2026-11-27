import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Option, type Command } from "commander";
import { builtinAgents, piCommand, sessionAgentName } from "../adapters/agents.js";
import { hostProjectRoot, selectHostTask } from "../application/host-hook.js";
import { initGuidance, initProject } from "../application/init.js";
import { buildSessionContext, cliDispatchMode, contextLines } from "../application/session-context.js";
import { CONFIG_PATH, legacyStandardCopies, loadConfig, loadStandards, readWorkflow, savePitfall } from "../application/project-config.js";
import { taskWorktree } from "../application/worktree.js";
import { HOST_SPECS, type HostOptions } from "../contracts/host.js";
import { AGENT_SPECS, DEFAULT_AGENT, TOOL_CAPABILITIES, WORKFLOW_ANCHORS, WORKFLOW_CONFIG_PATH, isReportEnum } from "../contracts/workflow.js";
import { PITFALLS_PATH, pitfallScope, pitfallSections } from "../domain/pitfalls.js";
import { standardsForStage, type Standard } from "../domain/standards.js";
import { WORKFLOW_ANCHOR_NAMES, validateAgentTarget, workflowPrompts, type WorkflowDefinition, type WorkflowExecutor, type WorkflowStage } from "../domain/workflow.js";
import { findExecutable, gitSync } from "../infrastructure/process.js";
import { fail, knitRoot, loadWorkflow, projectRoot, taskLabel } from "./shared.js";

export function registerInitCommand(program: Command): void {
  const init = program.command("init").description("生成项目流程、角色文件和配置；通用规范随安装包加载");
  for (const host of HOST_SPECS.toSorted((a, b) => a.optionOrder - b.optionOrder)) {
    init.option(`--${host.id}`, host.optionDescription);
  }
  init
    .option("--force", "备份并恢复流程、角色文件以及本次指定或已有的宿主桥接")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: HostOptions & { dir: string; force?: boolean }) => {
      const root = projectRoot(options.dir);
      const result = initProject(root, options.force, options);
      const lines = [
        ...section("已生成:", result.created),
        ...section("已恢复成模板:", result.restored),
        ...(result.backupDir === null ? [] : [`备份: ${result.backupDir}/`]),
        ...section("已有，没有动:", result.kept),
        ...section("旧版通用规范副本（保留原文，已停用；请把项目定制迁入另名的项目规范）:", legacyStandardCopies(root)),
        ...initGuidance(root, options, options.force ?? false, result.kept),
        ...(result.task === null
          ? []
          : [`初始化任务: ${result.task.title}（${result.task.id}，${result.task.file}）`]),
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
        const selected = selectHostTask(root, { host, sessionId }, options.use ?? null);
        if (selected.kind === "refused") return fail(selected.problems);
        process.stdout.write(options.unuse ? "已取消选中\n" : `已选中 ${taskLabel(selected.title!, options.use!)}\n`);
        return;
      }
      const root = knitRoot(options.dir);
      if (root === null) return;
      const mode = cliDispatchMode();
      const context = buildSessionContext(root, id, mode === "tools");
      if (context.kind === "refused") return fail(context.problems);
      process.stdout.write(`${contextLines(context, mode).join("\n")}\n`);
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
  return workflow && [...WORKFLOW_ANCHORS, ...workflow.stages.map((stage) => stage.id)];
}

export function registerStandardsCommands(program: Command): void {
  const standards = program.command("standards").description("查看内置规范和项目规范，维护项目避坑清单");
  standards.command("list")
    .description("列出规范来源、适用环节、正文大小和旧版副本")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string }) => {
      const known = knownStages(options.dir);
      if (!known) return;
      const root = projectRoot(options.dir);
      const lines = loadStandards(root).map((standard) => {
        const bytes = Buffer.byteLength(standard.body, "utf8");
        const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
        return `${standard.path}  ${standard.title}  ${stagesColumn(standard, known)}  ${size}`;
      });
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
      if (checklist[0]?.problems.length) return fail(checklist[0].problems.map((problem) => `${PITFALLS_PATH}：${problem}`));
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
      const stages = pitfallScope(options.section);
      if (!stages) return fail(["分区要写通用或逗号分隔的环节 id，每个环节 id 都不能为空"]);
      const unknown = stages.filter((id) => !known.includes(id));
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
  const spec = executor.agent === null ? null : AGENT_SPECS[executor.agent];
  const defaults = spec?.inheritsWorkflowDefaults ? workflow : null;
  const indent = parallel ? "       " : "     ";
  return [
    ...(parallel ? [`     执行器: ${executor.id}`] : []),
    `${indent}角色文件: ${executor.prompt ?? "（没有指定）"}`,
    `${indent}Agent: ${executor.agent ?? `（由派发入口决定，普通终端用 ${DEFAULT_AGENT}）`}`,
    `${indent}模型: ${executor.model ?? defaults?.model ?? spec?.modelDefaultLabel ?? `（由派发入口决定，Pi 用 ${workflow.model ?? "主会话模型"}，agy 用客户端缺省）`}`,
    `${indent}思考等级: ${executor.thinking ?? defaults?.thinking ?? spec?.thinkingDefaultLabel ?? `（由派发入口决定，Pi 用 ${workflow.thinking ?? "主会话等级"}，agy 用客户端缺省）`}`,
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
    `     续聊（resume）: ${stage.resume}`,
    `     首次之后最多再进入: ${stage.maxVisits === null ? "无" : String(stage.maxVisits)}`,
  ];
}

function reportEnvironment(root: string, workflow: WorkflowDefinition): void {
  const checks: { label: string; problem: string | null }[] = [];
  const check = (label: string, inspect: () => string | null, remedy: string) => {
    try {
      const problem = inspect();
      checks.push({ label, problem: problem === null ? null : `${problem}。${remedy}` });
    } catch (error) {
      checks.push({ label, problem: `${error instanceof Error ? error.message : String(error)}。${remedy}` });
    }
  };
  check(`Node ${process.version}`, () => Number.parseInt(process.versions.node, 10) >= 24 ? null : "需要 Node ≥ 24", "请升级 Node 后重试");
  check(CONFIG_PATH, () => loadConfig(root).problems.join("\n") || null, `请修正 ${CONFIG_PATH} 后重试`);
  check("角色文件", () => {
    const invalid = workflowPrompts(workflow).filter((path) => !statSync(join(root, path), { throwIfNoEntry: false })?.isFile());
    return invalid.length ? `缺失或非普通文件：${invalid.join("、")}` : null;
  }, "请补齐角色文件，默认角色文件可运行 knit init 补齐");
  check("Git 仓库与 HEAD", () => {
    const repo = gitSync(["rev-parse", "--is-inside-work-tree"], root);
    if (repo.code === -1) return `无法运行 Git（${repo.stderr.trim()}）`;
    if (repo.stdout.trim() !== "true") return "当前目录不在 Git 工作区内，仅支持主会话直接做，无法派发执行者";
    return gitSync(["rev-parse", "--verify", "--quiet", "HEAD"], root).code === 0 ? null : "Git 仓库没有初始提交，先提交一次再派发";
  }, "派发需要可用的 Git 和有初始提交的工作区");

  const session = sessionAgentName();
  const sessionDefaults = builtinAgents[session].sessionDefaults();
  const targets = workflow.stages.flatMap((stage) => stage.executors.map((executor) => {
    const agent = executor.agent ?? session;
    const defaults = AGENT_SPECS[agent].inheritsWorkflowDefaults ? workflow : null;
    const inherited = defaults && agent === session ? sessionDefaults : null;
    const model = executor.model ?? defaults?.model ?? null;
    const thinking = executor.thinking ?? defaults?.thinking ?? inherited?.thinking ?? null;
    const location = stage.executors.length === 1 ? stage.id : `${stage.id}/${executor.id}`;
    const effectiveModel = model ?? inherited?.model ?? null;
    const target = validateAgentTarget({ agent, model: effectiveModel, thinking });
    if (target.modelProblem) check(`${location} ${agent} 模型`, () => `${effectiveModel} ${target.modelProblem}`, "请修正 model");
    if (target.thinkingProblem) check(`${location} ${agent} 思考等级`, () => `${thinking} ${target.thinkingProblem}`, "请修正 thinking");
    return { agent, model, location, tools: TOOL_CAPABILITIES.filter((tool) => stage.tools === null || stage.tools.includes(tool)) };
  }));
  if (targets.some((target) => target.agent === "pi")) {
    check("Pi 客户端", () => findExecutable(piCommand()) === null ? `找不到可执行文件 ${piCommand()}` : null, "请安装 Pi 并检查 PATH");
  }
  const groups = Map.groupBy(targets, (target) => `${target.agent} tools=[${target.tools.join(", ")}]`);
  for (const [label, group] of groups) {
    const target = group[0]!;
    if (target.agent === "antigravity") {
      // 使用新任务的位置，从 HEAD 预检将要检出的内容，不创建目录或分支。
      const tree = taskWorktree(root, `env-${randomUUID()}`);
      check(label, () => builtinAgents.antigravity.checkDispatch!(root, tree.path, tree.branch, target.tools),
        "请在 macOS 配置 agy 1.5.13 并修正所列隔离条件，或在流程中改用 Pi");
      continue;
    }
    const missing = group.filter((item) => item.model === null).map((item) => item.location);
    const hint = "不在 Pi 主会话里派发时，需在 workflow.yaml 写 model 或传 --model";
    const inherits = missing.length > 0 && session === "pi" && sessionDefaults.model !== null;
    check(`${label} 模型${inherits ? `（${missing.join("、")} 使用主会话模型。${hint}）` : ""}`,
      () => missing.length && !inherits ? `${missing.join("、")} 未配置模型` : null, hint);
  }
  const ready = checks.every((item) => item.problem === null);
  process.stdout.write(checks.map(({ label, problem }) => problem === null ? `通过  ${label}\n` : `失败  ${label}：${problem}\n`).join(""));
  process.stdout.write(ready ? "派发环境就绪\n" : "派发环境未就绪\n");
  if (!ready) process.exitCode = 1;
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
      if (loaded === null) return;
      const lines = [chainLine(loaded), `环节（${loaded.stages.length}）：`, ...loaded.stages.flatMap((stage, index) => stageLines(stage, index, loaded))];
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  workflow
    .command("validate")
    .description("校验流程文件，有问题时逐条给出行号")
    .option("--env", "配置有效后，只读检查本机派发环境")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((options: { dir: string; env?: boolean }) => {
      const root = projectRoot(options.dir);
      const loaded = readWorkflow(root);
      if (loaded.workflow === null) return fail(loaded.problems);
      process.stdout.write(`配置有效\n${chainLine(loaded.workflow)}\n`);
      if (options.env) reportEnvironment(root, loaded.workflow);
    });
}
