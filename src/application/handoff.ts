/**
 * 交给环节执行者的内容：系统提示里是角色文件和规范，第一条消息里是需求部分、
 * 任务点名的资料、计划、上一个环节的报告，再次进入一个环节时还有它自己上一次的报告。
 * 「结果」、record.json 和没有点名的资料不给。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { standardsForStage, type Standard } from "../domain/standards.js";
import type { TaskDocument } from "../domain/task-document.js";
import { referencesOf } from "../domain/task-references.js";
import { projectRelative } from "../infrastructure/paths.js";
import { loadStandards } from "./standards-store.js";
import { readMaterials } from "./task-materials.js";

export interface HandoffInput {
  /** 主检出；任务、报告、角色文件和规范的来源。 */
  readonly root: string;
  /** 执行者所在的任务 Worktree；仓库资料的来源。 */
  readonly worktree: string;
  /** 任务目录（相对项目根）和解析出的 task.md。 */
  readonly task: { readonly dir: string; readonly document: TaskDocument };
  /** 环节 id 和角色文件的路径（相对项目根）。 */
  readonly stage: { readonly id: string; readonly prompt: string | null };
  /** 上一个环节的报告。 */
  readonly previous: HandoffReport | null;
  /** 再次进入这个环节时，它自己上一次的报告；不给和给 null 一样。 */
  readonly own?: HandoffReport | null;
  /** 不给时用 DEFAULT_HANDOFF_LIMITS。 */
  readonly limits?: HandoffLimits;
}

export interface HandoffReport {
  readonly stage: string;
  /** 报告原文在主检出里的绝对路径。 */
  readonly path: string;
  readonly changedPaths: readonly string[];
  readonly text: string;
}

/** 按内容的 UTF-8 字节数算，不算块外面的标记行。 */
export interface HandoffLimits {
  /** 点名的资料、计划、每份报告，单独一块的上限。 */
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
    { worktree: input.worktree },
  );
  const role = input.stage.prompt === null ? null : readText(input.root, input.stage.prompt);
  const planPath = `${input.task.dir}/plan.md`;
  const plan = named(planPath) ? null : readText(input.root, planPath);

  const roleText = role === null ? [] : [trimBlankLines(role)];
  const includedStandards = standards.filter((standard) => applicable.includes(standard) || named(standard.path));
  const taskBlock = {
    tag: "task",
    attributes: { path: resolve(input.root, input.task.dir, "task.md") },
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
    ...(plan === null ? [] : [{ tag: "plan", attributes: { path: resolve(input.root, planPath) }, content: trimBlankLines(plan) }]),
    ...(input.previous === null ? [] : [reportBlock("previous-report", input.previous)]),
    ...(input.own == null ? [] : [reportBlock("own-last-report", input.own)]),
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
      used: [...roleText, ...includedStandards.map((standard) => standard.body), taskBlock.content].reduce(
        (sum, text) => sum + Buffer.byteLength(text),
        0,
      ),
      blocks: [] as Block[],
    },
  ).blocks;

  return {
    systemPrompt: [...roleText, ...includedStandards.map(renderStandard)].join("\n\n"),
    // 工作位置说明不改变原有的资料字节预算。
    firstMessage: [
      `你在任务的 Worktree 里工作：${input.worktree}。仓库资料的相对路径以这里为准。\n任务目录和以前的报告在主检出（${resolve(input.root)}），只读，不要改。任务目录：${resolve(input.root, input.task.dir)}；这些资料和报告按给出的绝对路径读取。`,
      ...[taskBlock, ...fitted].map(render),
    ].join("\n\n"),
    problems: [
      ...(input.stage.prompt !== null && role === null
        ? [`环节 ${input.stage.id} 的角色文件不存在：${input.stage.prompt}`]
        : []),
      ...materials.problems,
    ],
  };
}

/** 一份报告：先是改动的文件，再是原文。 */
function reportBlock(tag: string, report: HandoffReport): Block {
  const changed =
    report.changedPaths.length === 0
      ? "改动的文件：无"
      : `改动的文件：\n${report.changedPaths.map((path) => `- ${path}`).join("\n")}`;
  return {
    tag,
    attributes: { stage: report.stage, path: report.path },
    content: `${changed}\n\n${trimBlankLines(report.text)}`,
  };
}

export function renderStandard(standard: Standard): string {
  return render({ tag: "standard", attributes: { path: standard.path, title: standard.title }, content: standard.body });
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
