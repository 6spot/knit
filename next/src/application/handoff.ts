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
  /** 不给时用 DEFAULT_HANDOFF_LIMITS。 */
  readonly limits?: HandoffLimits;
}

/** 按内容的 UTF-8 字节数算，不算块外面的标记行。 */
export interface HandoffLimits {
  /** 点名的资料、计划、上一环节的报告，单独一块的上限。 */
  readonly fileBytes: number;
  /** 一次交接合计的上限；角色文件、规范和需求部分计入合计，但任何时候都全文给。 */
  readonly totalBytes: number;
}

export const DEFAULT_HANDOFF_LIMITS: HandoffLimits = { fileBytes: 16384, totalBytes: 65536 };

interface Block {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly content: string;
}

export interface Handoff {
  readonly systemPrompt: string;
  readonly firstMessage: string;
  /** 读不出来的资料和角色文件；有问题时两段文本照样拼出来，要不要派发由调用方决定。 */
  readonly problems: readonly string[];
}

/** 同样的输入得到逐字相同的输出。 */
export function assembleHandoff(input: HandoffInput): Handoff {
  const limits = input.limits ?? DEFAULT_HANDOFF_LIMITS;
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

  const roleText = role === null ? [] : [trimBlankLines(role)];
  const standardBlocks = standards
    .filter((standard) => applicable.includes(standard) || named(standard.path))
    .map((standard) => ({
      tag: "standard",
      attributes: { path: standard.path, title: standard.title },
      content: standard.body,
    }));
  const taskBlock = {
    tag: "task",
    attributes: { path: `${input.task.dir}/task.md` },
    content: trimBlankLines(`# ${input.task.document.frontmatter.title}\n\n${input.task.document.requirement}`),
  };
  // 受上限约束的块，按第一条消息里的先后；content 是 null 的是目录，没有内容可附。
  const attached = [
    ...materials.materials.map((material) => ({
      tag: "material",
      attributes: {
        path: `${material.reference.path}${material.reference.anchor === null ? "" : `#${material.reference.anchor}`}`,
      },
      content: material.text === null ? null : trimBlankLines(material.text),
    })),
    ...(plan === null ? [] : [{ tag: "plan", attributes: { path: planPath }, content: trimBlankLines(plan) }]),
    ...(input.previous === null
      ? []
      : [
          {
            tag: "previous-report",
            attributes: { stage: input.previous.stage, path: input.previous.path },
            content: `${
              input.previous.changedPaths.length === 0
                ? "改动的文件：无"
                : `改动的文件：\n${input.previous.changedPaths.map((path) => `- ${path}`).join("\n")}`
            }\n\n${trimBlankLines(input.previous.text)}`,
          },
        ]),
  ];
  const fitted = attached.reduce(
    (state, part) => {
      if (part.content === null) {
        return { used: state.used, blocks: [...state.blocks, { ...part, content: "这是一个目录，没有附上内容。" }] };
      }
      const bytes = Buffer.byteLength(part.content);
      const notice =
        bytes > limits.fileBytes
          ? `这份资料有 ${bytes} 字节，超过单个文件的上限 ${limits.fileBytes} 字节，没有附上；需要时按路径自己读。`
          : state.used + bytes > limits.totalBytes
            ? `加上这份资料会超过一次交接的上限 ${limits.totalBytes} 字节，没有附上；需要时按路径自己读。`
            : null;
      return notice === null
        ? { used: state.used + bytes, blocks: [...state.blocks, { ...part, content: part.content }] }
        : { used: state.used, blocks: [...state.blocks, { ...part, content: notice }] };
    },
    {
      used: [...roleText, ...standardBlocks.map((block) => block.content), taskBlock.content].reduce(
        (sum, text) => sum + Buffer.byteLength(text),
        0,
      ),
      blocks: [] as Block[],
    },
  ).blocks;

  return {
    systemPrompt: [...roleText, ...standardBlocks.map(render)].join("\n\n"),
    firstMessage: [taskBlock, ...fitted].map(render).join("\n\n"),
    problems: [
      ...(input.stage.prompt !== null && role === null
        ? [`环节 ${input.stage.id} 的角色文件不存在：${input.stage.prompt}`]
        : []),
      ...materials.problems,
    ],
  };
}

function render(block: Block): string {
  const opening = Object.entries(block.attributes)
    .map((attribute) => ` ${attribute[0]}="${attribute[1]}"`)
    .join("");
  return `<${block.tag}${opening}>\n${block.content}\n</${block.tag}>`;
}

/** 文件不存在时是 null。 */
function readText(root: string, path: string): string | null {
  return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}
