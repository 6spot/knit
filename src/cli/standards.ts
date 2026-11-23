import type { Command } from "commander";
import { legacyStandardCopies, loadStandards, savePitfall } from "../application/standards-store.js";
import { WORKFLOW_ANCHORS } from "../contracts/workflow.js";
import { PITFALLS_PATH, pitfallScope, pitfallSections } from "../domain/pitfalls.js";
import { standardsForStage, type Standard } from "../domain/standards.js";
import { projectRoot } from "./root.js";
import { fail } from "./task.js";
import { loadWorkflow } from "./workflow.js";

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
