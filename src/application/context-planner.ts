/**
 * ContextPlanner：阶段分层输入、正式规范／角色版本、指纹与注入清单
 * （DESIGN.md 第8.1节、ARCHITECTURE.md）。
 * 需求、纯记录、未生效草案和候选规则分开：只有任务输入区计入 inputsDigest。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  newContextPlanId,
  type AuthorizedStandardOutput,
  type ContextExclusion,
  type ContextPlan,
  type ContextSection,
  type ToolPolicy,
} from "../contracts/context-plan.js";
import type { SessionRole } from "../contracts/session.js";
import { inputsDigestOf, inputsRegionOf, legacyPhaseToStage, progressRegionOf, stripStatusFields } from "../contracts/task-inputs.js";
import { isWorkflowAnchor, type ToolCapability } from "../contracts/workflow.js";
import { PROJECT_CANDIDATES_FILE, parseCandidates } from "../contracts/standards.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { GuardError } from "./guard-error.js";
import { loadWorkflow, stageBriefOf, workflowStageOf } from "./workflow.js";
import type { WorkflowStage } from "../domain/workflow.js";
import { locateTaskDocument } from "./task-service.js";
import { effectiveIdentityDigest, formalStandardFiles, formalStandardsDigest } from "./standards.js";
import { readTaskMaterial, researchDigestSummary, snapshotTaskMaterials } from "./task-materials.js";

const TASK_FILE = "task.md";

const PROGRESS_MARKER = ".knit-sealed";

export interface ContextPlannerOptions {
  store: MetadataStore;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

export interface ContextPlanInput {
  dir: string;
  taskId: string;
  /** 阶段 id：内置锚点或 `.knit/workflow.yaml` 声明的阶段。 */
  stage?: string;
  /** 兼容旧调用；等同 `stage`。 */
  role?: SessionRole;
  /** 明确授权为成果的正式规范路径（.knit/standards/ 下，任务037）；空表示无授权。 */
  authorizedStandardPaths?: string[];
  /** 已冻结的授权成果（来自 run 请求）；给定时优先于磁盘当前内容（任务037）。 */
  authorizedStandardContents?: AuthorizedStandardOutput[];
}

interface SectionInput {
  sourceId: string;
  kind: ContextSection["kind"];
  path: string | null;
  content: string | null;
  required: boolean;
  background: boolean;
  countsTowardInputs: boolean;
  priority: number;
  mode: ContextSection["mode"];
  /** 参与有效身份的正文；缺省用 content（任务031）。 */
  identityContent?: string | null;
}

const ALL_PI_TOOLS = ["read", "grep", "find", "ls", "write", "edit", "bash", "knit_*"];

/** 能力 → Pi 工具名／模式（设计 §7）；`external`／`network` 只影响启动开关。 */
const CAPABILITY_TOOLS: Record<ToolCapability, readonly string[]> = {
  read: ["read", "grep", "find", "ls"],
  write: ["write", "edit"],
  exec: ["bash"],
  task: ["knit_*"],
  external: [],
  network: [],
};

function toolPolicyFor(stage: WorkflowStage | null, fallback: boolean): ToolPolicy {
  // 降级流程不套阶段配置：默认 agent 行为，能力全部放开。
  if (stage === null && fallback) {
    return { mode: "write", allow: [...ALL_PI_TOOLS], deny: [], capabilities: null };
  }
  // 锚点没有阶段工具声明：保守只读。
  if (stage === null) {
    return {
      mode: "read",
      allow: ["read", "grep", "find", "ls"],
      deny: ["write", "edit", "bash"],
      capabilities: ["read"],
    };
  }
  if (stage.tools === null) {
    return { mode: "write", allow: [...ALL_PI_TOOLS], deny: [], capabilities: null };
  }
  const capabilities = [...stage.tools];
  const allow = [...new Set(capabilities.flatMap((capability) => CAPABILITY_TOOLS[capability]))];
  const deny: string[] = [];
  if (!capabilities.includes("write")) deny.push("write", "edit");
  if (!capabilities.includes("exec")) deny.push("bash");
  const mode = capabilities.includes("write") || capabilities.includes("exec") ? "write" : "read";
  return { mode, allow, deny, capabilities };
}

function resolveStage(input: ContextPlanInput): string {
  return legacyPhaseToStage(input.stage ?? input.role ?? "implement");
}

function readText(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 项目相对路径（正斜杠），用于稳定来源 ID。 */
function projectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** 递归收集目录下 .md 文件（相对路径排序）；目录缺失返回空。 */
function markdownFiles(dir: string): string[] {
  const result: string[] = [];
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return result.sort();
}

export class ContextPlanner {
  private readonly store: MetadataStore;
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(options: ContextPlannerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  }

  /** 生成冻结输入计划；ready=true 表示参数与必需指令就绪，可发起首轮调用。 */
  async plan(input: ContextPlanInput): Promise<ContextPlan> {
    const root = normalizeRoot(input.dir);
    let located;
    try {
      located = locateTaskDocument(root, input.taskId);
    } catch {
      throw new GuardError("unknown_task", `任务不存在: ${input.taskId}`);
    }
    if (located.archived) throw new GuardError("task_archived", `任务已归档: ${input.taskId}`);
    const document = located.document;
    const taskRelative = projectPath(root, join(located.dir, TASK_FILE));
    const rawText = located.raw.toString("utf8");
    // 明确授权的规范成果：只接受 .knit/standards/ 下的正式规范文件；
    // 旧内容冻结为输入分节，新内容作为成果核查（任务037）。
    // 接收／恢复传入已冻结 outputs 时按请求快照重建，不读磁盘当前内容。
    const authorizedStandardPaths = [...new Set(input.authorizedStandardPaths ?? [])].sort();
    const preFrozen = new Map((input.authorizedStandardContents ?? []).map((output) => [output.path, output]));
    const authorizedOutputs: AuthorizedStandardOutput[] = [];
    for (const relativePath of authorizedStandardPaths) {
      if (!relativePath.startsWith(".knit/standards/") || relativePath.endsWith("/")) {
        throw new GuardError("invalid_request", `授权规范成果必须位于 .knit/standards/: ${relativePath}`);
      }
      const relativeInStandards = relativePath.slice(".knit/standards/".length);
      if (
        relativeInStandards === "" ||
        relativeInStandards === PROJECT_CANDIDATES_FILE ||
        relativeInStandards.startsWith("candidates/") ||
        relativeInStandards.includes("..")
      ) {
        throw new GuardError("invalid_request", `授权规范成果不能指向候选或越界路径: ${relativePath}`);
      }
      const preFrozenOutput = preFrozen.get(relativePath);
      if (preFrozenOutput !== undefined) {
        authorizedOutputs.push(preFrozenOutput);
        continue;
      }
      const oldContent = readText(join(root, relativePath));
      if (oldContent === null) {
        throw new GuardError("unknown_target", `授权规范成果不存在: ${relativePath}`);
      }
      authorizedOutputs.push({ path: relativePath, frozenDigest: sha256Text(oldContent), frozenContent: oldContent });
    }
    const inputsDigest = inputsDigestOf(rawText);
    // 授权成果的正式规范按冻结旧版本参与摘要：新内容是成果，不使需求身份变化（任务037）。
    const frozenOverrides = new Map(authorizedOutputs.map((output) => [output.path, output.frozenDigest]));
    const standardsDigest = sha256Text(
      formalStandardFiles(root)
        .map((file) => `${file.path}\u0000${frozenOverrides.get(file.path) ?? file.digest}`)
        .join("\n"),
    );
    const sections: SectionInput[] = [];
    const excluded: ContextExclusion[] = [];

    const inputsBody = inputsRegionOf(rawText);
    sections.push({
      sourceId: `task-inputs:${input.taskId}`,
      kind: "task-inputs",
      path: taskRelative,
      content: inputsBody,
      required: true,
      background: false,
      countsTowardInputs: true,
      priority: 10,
      mode: "system",
      /** 有效身份不含执行状态字段：阶段转移／交付收尾不使刚通过的检查立即 stale（DESIGN §3.8，任务031）。 */
      identityContent: stripStatusFields(inputsBody),
    });

    // 生效流程：阶段名／说明／提示词／能力都来自配置；流程配置本身不进 inputsDigest。
    const loaded = loadWorkflow(root);
    const stage = resolveStage(input);
    const stageDefinition = workflowStageOf(loaded.workflow, stage);
    // 降级流程允许旧阶段值在途跑完；正常配置只接受锚点或已声明阶段。
    if (
      stageDefinition === null &&
      !isWorkflowAnchor(stage) &&
      !(loaded.mode === "fallback" && loaded.workflow.stages.length === 0)
    ) {
      throw new GuardError("stage_not_in_workflow", `阶段不在生效流程中: ${stage}`);
    }
    const stageBrief = stageBriefOf(loaded.workflow, stage, loaded.mode, loaded.validation.reason);

    // 阶段提示词：配置显式声明 prompt 才注入；缺失时用核心默认 agent 指令，不阻断。
    // 降级流程为在途旧 run 保留旧角色提示词路径，避免流程降级本身使冻结输入失效。
    const promptPath =
      stageDefinition?.prompt ??
      (loaded.mode === "fallback" && !isWorkflowAnchor(stage) && loaded.workflow.stages.length === 0
        ? `.knit/agents/${stage}.md`
        : null);
    const roleContent = promptPath === null ? null : readText(join(root, promptPath));
    if (promptPath !== null && roleContent !== null) {
      sections.push({
        sourceId: `role:${stage}`,
        kind: "role",
        path: promptPath,
        content: roleContent,
        required: true,
        background: false,
        countsTowardInputs: true,
        priority: 30,
        mode: "system",
      });
    } else if (promptPath !== null) {
      excluded.push({
        sourceId: `role:${stage}`,
        path: promptPath,
        reason: "stage_prompt_file_missing",
      });
    }

    const runtimeFile = ".knit/agents/runtimes/pi.md";
    const runtimeContent = readText(join(root, runtimeFile));
    if (runtimeContent !== null) {
      sections.push({
        sourceId: "runtime:pi",
        kind: "runtime",
        path: runtimeFile,
        content: runtimeContent,
        required: false,
        background: false,
        countsTowardInputs: true,
        priority: 40,
        mode: "resource",
      });
    }

    // 正式规范：.knit/standards 下（排除 candidates/）全部 .md，按路径排序。
    // 授权成果的规范以冻结旧内容作输入分节，并从当前规范读取中排除（任务037）。
    const standardsRoot = safeJoin(join(root, ".knit"), "standards");
    for (const [index, relativePath] of markdownFiles(standardsRoot).entries()) {
      if (
        relativePath === "candidates" ||
        relativePath.startsWith("candidates/") ||
        relativePath === PROJECT_CANDIDATES_FILE
      ) {
        continue;
      }
      const sectionPath = `.knit/standards/${relativePath}`;
      const authorized = authorizedOutputs.find((output) => output.path === sectionPath);
      if (authorized !== undefined) {
        sections.push({
          sourceId: `standard-frozen:${relativePath}`,
          kind: "standard",
          path: sectionPath,
          content: authorized.frozenContent,
          required: true,
          background: false,
          countsTowardInputs: true,
          priority: 50 + index,
          mode: "resource",
          identityContent: authorized.frozenContent,
        });
        continue;
      }
      const content = readText(join(root, ".knit", "standards", relativePath));
      if (content === null) continue;
      sections.push({
        sourceId: `standard:${relativePath}`,
        kind: "standard",
        path: sectionPath,
        content,
        required: true,
        background: false,
        countsTowardInputs: true,
        priority: 50 + index,
        mode: "resource",
      });
    }

    // 任务目录的项目相对路径（.knit/tasks/<dir>）；taskRelative 以 task.md 结尾，去掉文件名。
    const taskIdDirName = taskRelative.split("/").slice(0, -1).join("/");
    // 任务规划资料（DESIGN §3.4，任务046）：实施读 plan 全文；检查读 plan 与 design；
    // research 只注入入口摘要，按需读取。资料按当前事实读取，digest 记入分节供版本核对。
    const planningFiles = snapshotTaskMaterials(root, input.taskId).files;
    for (const [index, file] of planningFiles.entries()) {
      const material = readTaskMaterial(root, input.taskId, file.path);
      if (!material.exists || material.content === null) {
        excluded.push({ sourceId: `planning:${file.path}`, path: `${taskIdDirName}/${file.path}`, reason: "planning_material_unreadable" });
        continue;
      }
      const isResearch = file.path.startsWith("research/");
      const body = isResearch ? researchDigestSummary(file.path, material.content) : material.content;
      sections.push({
        sourceId: `planning:${file.path}`,
        kind: "planning-material",
        path: `${taskIdDirName}/${file.path}`,
        content: body,
        required: !isResearch,
        background: isResearch,
        countsTowardInputs: false,
        priority: 60 + index,
        mode: isResearch ? "resource" : "resource",
      });
    }

    // 记录区：背景资料，不计入需求摘要（STATES.md 第8节：纯记录不使检查失效）。
    const progressBody = progressRegionOf(rawText);
    sections.push({
      sourceId: `progress:${input.taskId}`,
      kind: "progress",
      path: taskRelative,
      content: progressBody,
      required: false,
      background: true,
      countsTowardInputs: false,
      priority: 90,
      mode: "resource",
    });

    const binding = await this.store.bindings.get(input.taskId);
    if (binding !== null && binding.pendingDraft !== null) {
      const draft = binding.pendingDraft;
      sections.push({
        sourceId: `pending-draft:${draft.digest}`,
        kind: "pending-draft",
        path: null,
        content: draft.content,
        required: false,
        background: true,
        countsTowardInputs: false,
        priority: 95,
        mode: "user",
      });
      excluded.push({
        sourceId: `pending-draft:${draft.digest}`,
        path: null,
        reason: "pending_draft_not_applied",
      });
    }

    // 项目候选规范：只作背景，不自动成为当前验收条件。
    const projectCandidatesFile = join(root, ".knit", "standards", PROJECT_CANDIDATES_FILE);
    const projectCandidatesText = readText(projectCandidatesFile);
    if (projectCandidatesText !== null) {
      const projectCandidates = parseCandidates(projectCandidatesText).candidates;
      if (projectCandidates.length > 0) {
        const candidatesRelative = projectPath(root, projectCandidatesFile);
        const sourceId = "standard-candidate:project";
        sections.push({
          sourceId,
          kind: "standard-candidate",
          path: candidatesRelative,
          content: projectCandidatesText,
          required: false,
          background: true,
          countsTowardInputs: false,
          priority: 95,
          mode: "resource",
        });
        excluded.push({ sourceId, path: candidatesRelative, reason: "candidate_not_applied" });
      }
    }

    // 旧任务候选规范（任务辅助资料 standards.md）：只读兼容，只作背景。
    const candidatesFile = join(located.dir, "standards.md");
    const candidatesText = readText(candidatesFile);
    if (candidatesText !== null) {
      const candidates = parseCandidates(candidatesText).candidates;
      if (candidates.length > 0) {
        const candidatesRelative = projectPath(root, candidatesFile);
        const sourceId = `standard-candidate:${input.taskId}`;
        sections.push({
          sourceId,
          kind: "standard-candidate",
          path: candidatesRelative,
          content: candidatesText,
          required: false,
          background: true,
          countsTowardInputs: false,
          priority: 96,
          mode: "resource",
        });
        excluded.push({ sourceId, path: candidatesRelative, reason: "candidate_not_applied" });
      }
    }

    if (existsSync(join(located.dir, PROGRESS_MARKER))) {
      excluded.push({ sourceId: `sealed:${input.taskId}`, path: null, reason: "sealed_record" });
    }

    const resolved: ContextSection[] = sections.map((section) => ({
      sourceId: section.sourceId,
      kind: section.kind,
      path: section.path,
      digest: section.content === null ? null : sha256Text(section.content),
      bytes: section.content === null ? null : Buffer.byteLength(section.content, "utf8"),
      required: section.required,
      background: section.background,
      countsTowardInputs: section.countsTowardInputs,
      priority: section.priority,
      mode: section.mode,
    }));
    resolved.sort((a, b) => a.priority - b.priority || a.sourceId.localeCompare(b.sourceId));

    const blockers: string[] = [];
    if (!resolved.some((section) => section.kind === "task-inputs")) blockers.push("task_inputs_missing");
    if (!resolved.some((section) => section.kind === "standard" && section.required)) {
      blockers.push("standards_missing");
    }

    return {
      planId: newContextPlanId(this.randomHex),
      taskId: input.taskId,
      role: stage,
      stageBrief,
      inputsDigest,
      standardsDigest,
      // 整体身份覆盖全部 countsTowardInputs 分节：阶段提示词、运行指令变化同样使旧凭据过期（任务031）。
      // 流程配置（阶段顺序／名称／能力）不进摘要：流程重排不使已有凭据过期（设计 §8）。
      // task-inputs 分节用去状态正文参与身份：阶段转移／交付收尾不使刚通过的检查立即 stale（DESIGN §3.8）。
      effectiveInputsDigest: effectiveIdentityDigest(
        inputsDigest,
        standardsDigest,
        resolved.filter((section) => section.countsTowardInputs).map((section) => ({
          sourceId: section.sourceId,
          digest: section.kind === "task-inputs" ? sha256Text(stripStatusFields(inputsBody)) : section.digest,
        })),
      ),
      taskDocumentDigest: sha256Bytes(located.raw),
      sections: resolved,
      excluded,
      createdAt: this.now().toISOString(),
      ready: blockers.length === 0,
      blockers,
      toolPolicy: toolPolicyFor(stageDefinition, loaded.mode === "fallback"),
      authorizedStandardOutputs: authorizedOutputs,
    };
  }
}
