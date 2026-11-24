/**
 * 交给环节执行者的内容：系统提示里是角色文件和规范，第一条消息里是需求部分、
 * 任务点名的资料、计划、上一个环节的报告，再次进入一个环节时还有它自己上一次的报告。
 * 「结果」、record.json 和没有点名的资料不给。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Text } from "../contracts/primitives.js";
import { PITFALLS_PATH } from "../domain/pitfalls.js";
import { standardReference, standardsForStage, type Standard } from "../domain/standards.js";
import { referencesOf, sectionOf, type TaskDocument, type TaskReference } from "../domain/task.js";
import { projectRelative } from "../infrastructure/paths.js";
import { DEFAULT_HANDOFF_LIMITS, loadStandards, type HandoffLimits } from "./project-config.js";
import { TASKS_DIR } from "./task-store.js";

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
  readonly previous: HandoffReport | readonly HandoffReport[] | null;
  readonly instruction?: string;
  /** 再次进入这个环节时，它自己上一次的报告；不给和给 null 一样。 */
  readonly own?: HandoffReport | null;
  /** 不给时用 DEFAULT_HANDOFF_LIMITS。 */
  readonly limits?: HandoffLimits;
}

export interface HandoffReport {
  readonly executor?: string;
  readonly verdict?: string | null;
  readonly failure?: string | null;
  readonly stage: string;
  /** 报告原文在主检出里的绝对路径。 */
  readonly path: string;
  readonly changedPaths: readonly string[];
  readonly text: string;
}

export { DEFAULT_HANDOFF_LIMITS, type HandoffLimits } from "./project-config.js";

interface Block {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly content: string;
}

export interface Handoff {
  readonly standardsDigest: string;
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
  const referencePath = (path: string) => standardReference(projectRelative(path) ?? "");
  const named = new Set(references.map(({ path }) => referencePath(path)));
  const includedStandards = standardsForStage(standards, input.stage.id, named);
  const standardPaths = new Set(standards.map((standard) => standard.path));
  // 点名清单时只用主检出的适用分区，不能把 Worktree 中的旧清单作为普通资料附上。
  const missingPitfalls = named.has(PITFALLS_PATH) && !standardPaths.has(PITFALLS_PATH);
  const materials = readMaterials(
    input.root,
    references.filter(({ path }) => {
      const normalized = referencePath(path);
      return normalized !== PITFALLS_PATH && !standardPaths.has(normalized);
    }),
    { worktree: input.worktree },
  );
  const role = input.stage.prompt === null ? null : readText(input.root, input.stage.prompt);
  const planPath = `${input.task.dir}/plan.md`;
  const plan = named.has(planPath) ? null : readText(input.root, planPath);

  const roleText = role === null ? [] : [trimBlankLines(role)];
  const taskBlock = {
    tag: "task",
    attributes: { path: resolve(input.root, input.task.dir, "task.md") },
    content: trimBlankLines(`# ${input.task.document.frontmatter.title}\n\n${input.task.document.requirement}`),
  };
  // 受上限约束的块，按第一条消息里的先后；content 是 null 的是目录，没有内容可附。
  const instructions: Block[] = input.instruction === undefined ? [] : [
    { tag: "main-instruction", attributes: {}, content: input.instruction },
  ];
  const attached = [
    ...materials.materials.map((material) => ({
      tag: "material",
      attributes: {
        path: `${material.reference.path}${material.reference.anchor === null ? "" : `#${material.reference.anchor}`}`,
      },
      content: material.text === null ? null : trimBlankLines(material.text),
    })),
    ...(plan === null ? [] : [{ tag: "plan", attributes: { path: resolve(input.root, planPath) }, content: trimBlankLines(plan) }]),
    ...[input.previous ?? []].flat().map((report) => reportBlock("previous-report", report)),
    ...(input.own == null ? [] : [reportBlock("own-last-report", input.own)]),
  ];
  const fitted = attached.reduce(
    (state, part) => {
      if (part.content === null) {
        return { used: state.used, blocks: [...state.blocks, { ...part, content: "这是一个目录，没有附上内容。" }] };
      }
      const bytes = Buffer.byteLength(part.content);
      const notice = attachmentNotice(bytes, state.used, limits);
      return notice === null
        ? { used: state.used + bytes, blocks: [...state.blocks, { ...part, content: part.content }] }
        : { used: state.used, blocks: [...state.blocks, { ...part, content: notice }] };
    },
    {
      used: [...roleText, ...includedStandards.map((standard) => standard.body), taskBlock.content, input.instruction ?? ""].reduce(
        (sum, text) => sum + Buffer.byteLength(text),
        0,
      ),
      blocks: [] as Block[],
    },
  ).blocks;

  const standardBlocks = includedStandards.map(renderStandard);
  return {
    standardsDigest: sha256Text(standardBlocks.join("\n\n")),
    systemPrompt: [...roleText, ...standardBlocks].join("\n\n"),
    // 工作位置说明不改变原有的资料字节预算。
    firstMessage: [
      `你在任务的 Worktree 里工作：${input.worktree}。仓库资料的相对路径以这里为准。\n任务目录和以前的报告在主检出（${resolve(input.root)}），只读，不要改。任务目录：${resolve(input.root, input.task.dir)}；这些资料和报告按给出的绝对路径读取。`,
      ...[taskBlock, ...instructions, ...fitted].map(render),
    ].join("\n\n"),
    problems: [
      ...(input.stage.prompt !== null && role === null
        ? [`环节 ${input.stage.id} 的角色文件不存在：${input.stage.prompt}`]
        : []),
      ...(missingPitfalls ? [`主检出里没有点名的规范：${PITFALLS_PATH}`] : []),
      ...materials.problems,
    ],
  };
}

function attachmentNotice(bytes: number, used: number, limits: HandoffLimits): string | null {
  if (bytes > limits.fileBytes) return `这份资料有 ${bytes} 字节，超过单个文件的上限 ${limits.fileBytes} 字节，没有附上；需要时按路径自己读。`;
  if (used + bytes > limits.totalBytes) return `加上这份资料会超过一次交接的上限 ${limits.totalBytes} 字节，没有附上；需要时按路径自己读。`;
  return null;
}

/** 无读取工具的执行者无法打开报告路径，按交接预算随消息附上报告。 */
export function resumeMessage(instruction: string | undefined, reports: readonly HandoffReport[], rules: string, inlineLimits?: HandoffLimits): string {
  const instructions = instruction ? [render({ tag: "main-instruction", attributes: {}, content: instruction })] : [];
  const previous = reports.reduce((state, report) => {
    const reference = `${report.executor ?? report.stage}（${report.failure ?? report.verdict ?? "正常结束"}）的报告：${report.path}`;
    const bytes = Buffer.byteLength(report.text);
    const include = inlineLimits && attachmentNotice(bytes, state.used, inlineLimits) === null;
    return { used: state.used + (include ? bytes : 0), messages: [...state.messages, include ? `${reference}\n${report.text}` : reference] };
  }, { used: Buffer.byteLength(instruction ?? "") + Buffer.byteLength(rules), messages: [] as string[] });
  return [...instructions, ...previous.messages, rules].join("\n\n");
}

/** 一份报告：先是改动的文件，再是原文。 */
function reportBlock(tag: string, report: HandoffReport): Block {
  const changed =
    report.changedPaths.length === 0
      ? "改动的文件：无"
      : `改动的文件：\n${report.changedPaths.map((path) => `- ${path}`).join("\n")}`;
  return {
    tag,
    attributes: { stage: report.stage, path: report.path, ...(report.executor === undefined ? {} : {
      executor: report.executor, verdict: report.verdict ?? "null",
    }) },
    content: [changed, ...(report.failure ? [`执行失败：${report.failure}`] : []), trimBlankLines(report.text)].join("\n\n"),
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

export interface TaskMaterial {
  readonly reference: TaskReference;
  readonly kind: "file" | "section" | "directory";
  /** 目录没有内容，是 null。 */
  readonly text: string | null;
}

interface HandoffLocation {
  readonly worktree: string;
}

/** 顺序和 references 相同；交接时仓库资料读 Worktree，任务目录（所有任务的）里的资料读主检出并给绝对路径。 */
export function readMaterials(
  root: string,
  references: readonly TaskReference[],
  handoff?: HandoffLocation,
): { materials: TaskMaterial[]; problems: string[] } {
  const results = references.map((reference) => readMaterial(root, reference, handoff));
  return {
    materials: results.flatMap((result) => (typeof result === "string" ? [] : [result])),
    problems: results.flatMap((result) => (typeof result === "string" ? [result] : [])),
  };
}

/** 读出来的资料，或者读不出来的原因。 */
function readMaterial(root: string, reference: TaskReference, handoff?: HandoffLocation): TaskMaterial | string {
  const path = projectRelative(reference.path);
  if (path === null) return `相关资料里的路径要写项目内的相对路径：${reference.path}`;
  // 任务目录交付之前没有入库，别的任务（例如主任务）的目录也一样，Worktree 里没有或者是旧的。
  const taskMaterial = handoff !== undefined && (path === TASKS_DIR || path.startsWith(`${TASKS_DIR}/`));
  const source = handoff !== undefined && !taskMaterial ? handoff.worktree : root;
  const stats = statSync(join(source, path), { throwIfNoEntry: false });
  if (stats === undefined) {
    return `相关资料里点名的文件不存在：${reference.path}${
      handoff !== undefined && !taskMaterial && existsSync(join(root, path))
        ? "；它还没有提交，所以任务的 Worktree 里没有。"
        : ""
    }`;
  }
  const supplied = taskMaterial ? { ...reference, path: resolve(root, path) } : reference;
  if (stats.isDirectory()) return { reference: supplied, kind: "directory", text: null };
  const text = readFileSync(join(source, path), "utf8");
  if (reference.anchor === null) return { reference: supplied, kind: "file", text };
  const section = sectionOf(text, reference.anchor);
  return section === null
    ? `${reference.path} 里没有标题「${reference.anchor}」`
    : { reference: supplied, kind: "section", text: section };
}
