/**
 * 交给环节执行者的内容：系统提示里是角色文件和规范，第一条消息里是需求部分、
 * 任务点名的资料、计划、上一个环节的报告，再次进入一个环节时还有它自己上一次的报告。
 * 「结果」、record.json 和没有点名的资料不给。
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Text } from "../contracts/primitives.js";
import { trimBlankLines } from "../domain/markdown.js";
import { PITFALLS_PATH } from "../domain/pitfalls.js";
import { standardReference, standardsForStage, type Standard } from "../domain/standards.js";
import { referencesOf, sectionOf, type TaskDocument, type TaskReference } from "../domain/task.js";
import type { WorkflowStage } from "../domain/workflow.js";
import { gitSync } from "../infrastructure/process.js";
import { InfrastructureError } from "../infrastructure/fs.js";
import { projectRelative, safeJoin } from "../infrastructure/paths.js";
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
  readonly stage: Pick<WorkflowStage, "id" | "prompt" | "tools">;
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

type HandoffSourcesInput = Pick<HandoffInput, "root" | "worktree" | "task" | "limits"> & { stage: Pick<WorkflowStage, "id" | "tools"> };

/** 同一批的成员共享资料、计划及适用规范，角色文件单独加载。 */
export function loadHandoffSources(input: HandoffSourcesInput) {
  const limits = input.limits ?? DEFAULT_HANDOFF_LIMITS;
  const canRead = input.stage.tools == null || input.stage.tools.includes("read");
  const planPath = `${input.task.dir}/plan.md`;
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
    { worktree: input.worktree, canRead, fileBytes: limits.fileBytes, planPath },
  );
  const problems: string[] = [];
  const namedPlan = named.has(planPath) || named.has(`${planPath}/`);
  const plan = namedPlan ? null : readText(input.root, planPath, "任务计划", problems, true);
  if (namedPlan && materials.materials.some((item) => item.reference.path === resolve(input.root, planPath) && item.kind === "directory")) {
    problems.push(`任务计划不是普通文件：${planPath}`);
  }

  const planFile = resolve(input.root, planPath);
  const materialBlocks = materials.materials.map((material) => {
    const { path, anchor } = material.reference;
    return {
      tag: "material", attributes: { path: `${path}${anchor === null ? "" : `#${anchor}`}` },
      content: trimBlankLines(material.text ?? ""),
      fileBytes: canRead && path !== planFile ? Math.min(8192, limits.fileBytes) : limits.fileBytes,
      notice: material.notice, size: material.size, isPlan: path === planFile,
    };
  });
  return { limits, canRead, includedStandards, materialBlocks,
    plan: plan === null ? [] : [{ tag: "plan", attributes: { path: planFile }, content: trimBlankLines(plan) }],
    problems: [...problems, ...(missingPitfalls ? [`主检出里没有点名的规范：${PITFALLS_PATH}`] : []),
      ...standards.filter((s) => named.has(s.path)).flatMap((s) => s.problems.map((p) => `${s.path}：${p}`)), ...materials.problems] };
}

export function assembleHandoff(input: HandoffInput): Handoff {
  const prepared = prepareHandoff(input, loadHandoffSources(input));
  return { standardsDigest: prepared.standardsDigest, systemPrompt: prepared.systemPrompt,
    problems: prepared.problems, firstMessage: prepared.message(null, "") };
}

interface Attachment extends Block {
  readonly fileBytes?: number;
  readonly size?: number;
  readonly notice?: string;
}

export function prepareHandoff(input: HandoffInput, sources: ReturnType<typeof loadHandoffSources>) {
  const { limits, canRead, includedStandards } = sources;
  const problems: string[] = [];
  const role = input.stage.prompt === null ? null : readText(input.root, input.stage.prompt, `环节 ${input.stage.id} 的角色文件`, problems);
  const roleText = role === null ? [] : [trimBlankLines(role)];
  const taskBlock = {
    tag: "task",
    attributes: { path: resolve(input.root, input.task.dir, "task.md") },
    content: trimBlankLines(`# ${input.task.document.frontmatter.title}\n\n${input.task.document.requirement}`),
  };
  const instructions: Block[] = input.instruction === undefined ? [] : [
    { tag: "main-instruction", attributes: {}, content: input.instruction },
  ];
  const previous = [input.previous ?? []].flat().map((report) => reportBlock("previous-report", report));
  const own = input.own ? [reportBlock("own-last-report", input.own)] : [];
  const lowerPriority = [...own, ...sources.plan, ...sources.materialBlocks.filter((part) => part.isPlan),
    ...sources.materialBlocks.filter((part) => !part.isPlan)];
  const display = [...sources.materialBlocks, ...sources.plan, ...previous, ...own];
  const fixedBytes = [...roleText, ...includedStandards.map((standard) => standard.body), taskBlock.content, input.instruction ?? ""]
    .reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  const standardBlocks = includedStandards.map(renderStandard);
  const systemPrompt = [...roleText, ...standardBlocks].join("\n\n");
  const location = `你在任务的 Worktree 里工作：${input.worktree}。仓库资料的相对路径以这里为准。\n任务目录和以前的报告在主检出（${resolve(input.root)}），只读，不要改。任务目录：${resolve(input.root, input.task.dir)}；${canRead ? "这些资料和报告按给出的绝对路径读取。" : "本环节无 read 权限，使用下方附上的资料和报告。"}`;
  return {
    standardsDigest: sha256Text(standardBlocks.join("\n\n")), systemPrompt, problems: [...problems, ...sources.problems],
    message(changes: ReturnType<typeof reviewChanges>, rules: string) {
      const budget = { used: fixedBytes, roomWithPatch: Infinity };
      const selected = new Map<Block, string>();
      const firstMessage = () => [location, ...[taskBlock, ...instructions, ...display].map((part) => render({ ...part, content: selected.get(part) ?? part.content }))].join("\n\n");
      const noticeFor = (part: Attachment, used: number) => part.notice ?? attachmentNotice(part.size ?? Buffer.byteLength(part.content), used,
        { ...limits, fileBytes: part.fileBytes ?? limits.fileBytes }, canRead);
      const fit = (part: Attachment) => {
        const notice = noticeFor(part, budget.used);
        if (notice !== null) {
          selected.set(part, notice);
          return;
        }
        const size = Buffer.byteLength(part.content);
        const growth = size - Buffer.byteLength(selected.get(part) ?? "");
        if (growth > budget.roomWithPatch) return;
        budget.used += size;
        budget.roomWithPatch -= growth;
        selected.set(part, part.content);
      };
      previous.forEach(fit);
      const review = reviewAttachment(changes, limits, input.stage.tools == null || input.stage.tools.includes("exec"));
      // 为每个低优先级块保留最短的有效表示，按含系统提示、标签和路径的实际大小为补丁留位。
      const chooseReview = () => {
        if (!review.full) return review.summary;
        lowerPriority.forEach((part) => {
          const required = noticeFor(part, 0);
          const fallback = noticeFor(part, Infinity)!;
          selected.set(part, required ?? (Buffer.byteLength(part.content) < Buffer.byteLength(fallback) ? part.content : fallback));
        });
        const systemBytes = Buffer.byteLength(systemPrompt) + (rules ? 2 + Buffer.byteLength(rules) : 0);
        const remaining = limits.totalBytes - systemBytes - Buffer.byteLength(firstMessage() + review.full);
        if (remaining < 0) return review.summary;
        budget.roomWithPatch = remaining;
        return review.full;
      };
      const reviewBlock = chooseReview();
      lowerPriority.forEach(fit);
      return firstMessage() + reviewBlock;
    },
  };
}

function attachmentNotice(bytes: number, used: number, limits: HandoffLimits, canRead: boolean): string | null {
  const action = canRead ? "需要时按路径自己读。" : "本环节无 read 权限，无法自行读取；请调整 handoff 预算或精简资料。";
  if (bytes > limits.fileBytes) return `这份资料有 ${bytes} 字节，超过单个文件的上限 ${limits.fileBytes} 字节，没有附上；${action}`;
  if (used + bytes > limits.totalBytes) return `加上这份资料会超过一次交接的上限 ${limits.totalBytes} 字节，没有附上；${action}`;
  return null;
}

const MAX_DIFF_BYTES = 8192;

/** 准备命令完成后，在同批审查者共用的 Worktree 读取一次。 */
export function reviewChanges(worktree: string) {
  const gitArgs = ["-c", "core.quotePath=false"];
  const diffArgs = [...gitArgs, "diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  const stat = gitSync([...diffArgs, "--stat", "HEAD", "--"], worktree);
  const untracked = gitSync([...gitArgs, "ls-files", "--others", "--exclude-standard"], worktree);
  if (stat.code !== 0 || untracked.code !== 0) throw new Error(`无法读取 Worktree 改动摘要：${stat.stderr}${untracked.stderr}`);
  if (!stat.stdout && !untracked.stdout) return null;
  const names = untracked.stdout.split("\n").filter(Boolean);
  const listing = [...names.slice(0, 200), ...(names.length > 200 ? [`等共 ${names.length} 个文件`] : [])];
  const summary = [stat.stdout.trimEnd(), listing.length && `未跟踪文件：\n${listing.join("\n")}`].filter(Boolean).join("\n\n");
  const diff = stat.stdout ? gitSync([...diffArgs, "--unified=1", "HEAD", "--"], worktree, MAX_DIFF_BYTES) : null;
  return { summary, patch: diff === null ? "" : diff.code === 0 ? diff.stdout : null };
}

function reviewAttachment(changes: ReturnType<typeof reviewChanges>, limits: HandoffLimits, canExec: boolean) {
  if (!changes) return { summary: "", full: null };
  const block = (detail: string) => "\n\n" + render({ tag: "worktree-changes", attributes: { base: "HEAD" },
    content: detail ? `${changes.summary}\n\n${detail}` : changes.summary });
  const hint = canExec ? "需要时在 Worktree 运行 git diff HEAD 查看补丁。" : "本环节无法自行运行 git diff HEAD；请调整 handoff 预算或精简改动。";
  return {
    summary: block(changes.patch === "" ? "" : hint),
    full: changes.patch && Buffer.byteLength(changes.patch) <= Math.min(MAX_DIFF_BYTES, limits.fileBytes) ? block(changes.patch.replace(/\n$/, "")) : null,
  };
}

export function appendReviewChanges(message: string, changes: ReturnType<typeof reviewChanges>, limits: HandoffLimits, systemBytes = 0, canExec = true): string {
  const review = reviewAttachment(changes, limits, canExec);
  return message + (review.full && systemBytes + Buffer.byteLength(message + review.full) <= limits.totalBytes ? review.full : review.summary);
}

/** 无读取工具的执行者无法打开报告路径，按交接预算随消息附上报告。 */
export function resumeMessage(instruction: string | undefined, reports: readonly HandoffReport[], rules: string, inlineLimits?: HandoffLimits, failure?: string | null): string {
  const recovery = failure ? [`上一次同环节执行因「${failure}」中断，Worktree 保留了当时的改动。请检查当前 Worktree 状态，接着完成剩余工作和验证，并按要求的格式提交完整报告。`] : [];
  const instructions = instruction ? [render({ tag: "main-instruction", attributes: {}, content: instruction })] : [];
  const previous = reports.reduce((state, report) => {
    const reference = `${report.executor ?? report.stage}（${report.failure ?? report.verdict ?? "正常结束"}）的报告：${report.path}`;
    const bytes = Buffer.byteLength(report.text);
    const notice = inlineLimits && attachmentNotice(bytes, state.used, inlineLimits, false);
    return { used: state.used + (notice === null ? bytes : 0), messages: [...state.messages,
      inlineLimits ? `${reference}\n${notice ?? report.text}` : reference] };
  }, { used: Buffer.byteLength(instruction ?? "") + Buffer.byteLength(rules) + Buffer.byteLength(recovery.join("")), messages: [] as string[] });
  return [...recovery, ...instructions, ...previous.messages, rules].join("\n\n");
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
    .map(([key, value]) => ` ${key}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;")}"`)
    .join("");
  return `<${block.tag}${opening}>\n${block.content}\n</${block.tag}>`;
}

function inspectPath(root: string, path: string) {
  try {
    const file = safeJoin(root, path);
    return { file, stats: statSync(file, { throwIfNoEntry: false }) };
  } catch (error) {
    if (error instanceof InfrastructureError && error.code === "path_escape") return `无法安全解析为项目内路径：${path}`;
    throw error;
  }
}

function readText(root: string, path: string, label: string, problems: string[], optional = false): string | null {
  const entry = inspectPath(root, path);
  if (typeof entry !== "string" && entry.stats?.isFile()) return readFileSync(entry.file, "utf8");
  if (typeof entry !== "string" && entry.stats === undefined && optional) return null;
  const reason = typeof entry === "string" ? entry : entry.stats ? `不是普通文件：${path}` : `不存在：${path}`;
  problems.push(`${label}${reason}`);
  return null;
}

export interface TaskMaterial {
  readonly reference: TaskReference;
  readonly kind: "file" | "section" | "directory";
  readonly notice?: string;
  readonly size?: number;
  /** 目录、仅给路径或超限的文件没有正文。 */
  readonly text: string | null;
}

interface HandoffLocation {
  readonly worktree: string;
  readonly canRead: boolean;
  readonly fileBytes: number;
  readonly planPath: string;
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
  const entry = inspectPath(source, path);
  if (typeof entry === "string") return `相关资料${entry}`;
  if (entry.stats === undefined) {
    const main = handoff !== undefined && !taskMaterial ? inspectPath(root, path) : null;
    return `相关资料里点名的文件不存在：${reference.path}${
      main && typeof main !== "string" && main.stats
        ? "；它还没有提交，所以任务的 Worktree 里没有。"
        : ""
    }`;
  }
  const supplied = taskMaterial ? { ...reference, path: resolve(root, path) } : reference;
  if (entry.stats.isDirectory()) return { reference: supplied, kind: "directory", text: null,
    ...(handoff && { notice: "这是一个目录，没有附上内容。" }) };
  if (!entry.stats.isFile()) return `相关资料不是普通文件：${reference.path}`;
  if (handoff && reference.anchor === null) {
    const slim = handoff.canRead && path !== handoff.planPath;
    if (slim && !path.toLowerCase().endsWith(".md")) return { reference: supplied, kind: "file", text: null, notice: "需要时按路径自己读。" };
    if (entry.stats.size > (slim ? Math.min(8192, handoff.fileBytes) : handoff.fileBytes)) {
      return { reference: supplied, kind: "file", text: null, size: entry.stats.size };
    }
  }
  const text = readFileSync(entry.file, "utf8");
  if (reference.anchor === null) return { reference: supplied, kind: "file", text };
  const section = sectionOf(text, reference.anchor);
  return section === null
    ? `${reference.path} 里没有标题「${reference.anchor}」`
    : { reference: supplied, kind: "section", text: section };
}
