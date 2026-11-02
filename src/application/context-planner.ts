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
import { inputsDigestOf, inputsRegionOf, progressRegionOf, stripStatusFields } from "../contracts/task-inputs.js";
import { parseCandidates } from "../contracts/standards.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { normalizeRoot, safeJoin } from "../infrastructure/paths.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { GuardError } from "./guard-error.js";
import { locateTaskDocument } from "./task-service.js";
import { effectiveIdentityDigest, formalStandardFiles, formalStandardsDigest } from "./standards.js";

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
  role: SessionRole;
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

function toolPolicyFor(role: SessionRole): ToolPolicy {
  if (role === "implement") {
    return { mode: "write", allow: ["read", "write", "edit", "bash", "task"], deny: [] };
  }
  return { mode: "read", allow: ["read", "bash", "task"], deny: ["write", "edit"] };
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
      if (relativeInStandards === "" || relativeInStandards.startsWith("candidates/") || relativeInStandards.includes("..")) {
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
      /** 有效身份不含执行状态字段：阶段转移／交付收尾不使刚通过的检查立即 stale（DESIGN §3.6，任务031）。 */
      identityContent: stripStatusFields(inputsBody),
    });

    const workflow = readText(join(root, ".knit", "workflow.md"));
    if (workflow !== null) {
      sections.push({
        sourceId: "workflow:.knit/workflow.md",
        kind: "workflow",
        path: ".knit/workflow.md",
        content: workflow,
        required: true,
        background: false,
        countsTowardInputs: true,
        priority: 20,
        mode: "system",
      });
    } else {
      excluded.push({ sourceId: "workflow:.knit/workflow.md", path: ".knit/workflow.md", reason: "file_missing" });
    }

    const roleFile = `.knit/agents/${input.role}.md`;
    const roleContent = readText(join(root, roleFile));
    const roleRequired = input.role === "implement" || input.role === "check";
    if (roleContent !== null) {
      sections.push({
        sourceId: `role:${input.role}`,
        kind: "role",
        path: roleFile,
        content: roleContent,
        required: true,
        background: false,
        countsTowardInputs: true,
        priority: 30,
        mode: "system",
      });
    } else {
      excluded.push({
        sourceId: `role:${input.role}`,
        path: roleFile,
        reason: roleRequired ? "role_file_missing" : "optional_role_file_missing",
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
      if (relativePath === "candidates" || relativePath.startsWith("candidates/")) continue;
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

    // 任务候选规范（任务辅助资料 standards.md）：只作背景，不自动成为当前验收条件。
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
    if (roleRequired && !resolved.some((section) => section.kind === "role")) {
      blockers.push(`role_file_missing:${input.role}`);
    }
    if (!resolved.some((section) => section.kind === "standard" && section.required)) {
      blockers.push("standards_missing");
    }

    return {
      planId: newContextPlanId(this.randomHex),
      taskId: input.taskId,
      role: input.role,
      inputsDigest,
      standardsDigest,
      // 整体身份覆盖全部 countsTowardInputs 分节：工作流、角色、运行指令变化同样使旧凭据过期（任务031）。
      // task-inputs 分节用去状态正文参与身份：阶段转移／交付收尾不使刚通过的检查立即 stale（DESIGN §3.6）。
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
      toolPolicy: toolPolicyFor(input.role),
      authorizedStandardOutputs: authorizedOutputs,
    };
  }
}
