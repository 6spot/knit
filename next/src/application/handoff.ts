/**
 * 交给环节执行者的内容：系统提示里是角色文件和规范，第一条消息里是需求部分、
 * 任务点名的资料、计划和上一个环节的报告。「结果」、record.json 和没有点名的资料不给。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { standardsForStage } from "../domain/standards.js";
import type { TaskDocument } from "../domain/task-document.js";
import { referencesOf } from "../domain/task-references.js";
import { projectRelative } from "../infrastructure/paths.js";
import { loadStandards } from "./standards-store.js";
import { readMaterials } from "./task-materials.js";

export interface HandoffInput {
  readonly root: string;
  /** 任务目录（相对项目根）和解析出的 task.md。 */
  readonly task: { readonly dir: string; readonly document: TaskDocument };
  /** 环节 id 和角色文件的路径（相对项目根）。 */
  readonly stage: { readonly id: string; readonly prompt: string | null };
  readonly previous: {
    readonly stage: string;
    /** 报告原文的路径。 */
    readonly path: string;
    readonly changedPaths: readonly string[];
    readonly text: string;
  } | null;
}

export interface Handoff {
  readonly systemPrompt: string;
  readonly firstMessage: string;
  /** 读不出来的资料和角色文件；有问题时两段文本照样拼出来，要不要派发由调用方决定。 */
  readonly problems: readonly string[];
}

/** 同样的输入得到逐字相同的输出。 */
export function assembleHandoff(input: HandoffInput): Handoff {
  const standards = loadStandards(input.root);
  const references = referencesOf(input.task.document.requirement);
  const named = (path: string) => references.some((reference) => projectRelative(reference.path) === path);
  const applicable = standardsForStage(standards, input.stage.id);
  const materials = readMaterials(
    input.root,
    references.filter((reference) => !standards.some((standard) => standard.path === projectRelative(reference.path))),
  );
  const role = input.stage.prompt === null ? null : readText(input.root, input.stage.prompt);
  const planPath = `${input.task.dir}/plan.md`;
  const plan = named(planPath) ? null : readText(input.root, planPath);
  return {
    systemPrompt: [
      ...(role === null ? [] : [trimBlankLines(role)]),
      ...standards
        .filter((standard) => applicable.includes(standard) || named(standard.path))
        .map((standard) => block("standard", { path: standard.path, title: standard.title }, standard.body)),
    ].join("\n\n"),
    firstMessage: [
      block(
        "task",
        { path: `${input.task.dir}/task.md` },
        `# ${input.task.document.frontmatter.title}\n\n${input.task.document.requirement}`,
      ),
      ...materials.materials.map((material) =>
        block(
          "material",
          { path: `${material.reference.path}${material.reference.anchor === null ? "" : `#${material.reference.anchor}`}` },
          material.text ?? "这是一个目录，没有附上内容。",
        ),
      ),
      ...(plan === null ? [] : [block("plan", { path: planPath }, plan)]),
      ...(input.previous === null
        ? []
        : [
            block(
              "previous-report",
              { stage: input.previous.stage, path: input.previous.path },
              `${
                input.previous.changedPaths.length === 0
                  ? "改动的文件：无"
                  : `改动的文件：\n${input.previous.changedPaths.map((path) => `- ${path}`).join("\n")}`
              }\n\n${trimBlankLines(input.previous.text)}`,
            ),
          ]),
    ].join("\n\n"),
    problems: [
      ...(input.stage.prompt !== null && role === null
        ? [`环节 ${input.stage.id} 的角色文件不存在：${input.stage.prompt}`]
        : []),
      ...materials.problems,
    ],
  };
}

function block(tag: string, attributes: Readonly<Record<string, string>>, content: string): string {
  const opening = Object.entries(attributes)
    .map((attribute) => ` ${attribute[0]}="${attribute[1]}"`)
    .join("");
  return `<${tag}${opening}>\n${trimBlankLines(content)}\n</${tag}>`;
}

/** 文件不存在时是 null。 */
function readText(root: string, path: string): string | null {
  return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}
