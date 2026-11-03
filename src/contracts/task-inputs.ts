/**
 * Task 主文档结构与输入变更契约（DESIGN.md 第3.1–3.3、3.5、3.8节）。
 * schema 供 CLI 参数与文件结构校验；摘要函数供应用层核对本与草案。
 * 域转移裁决在 domain/task.ts，本模块不裁决业务允许性。
 */
import { Type, type Static } from "typebox";
import { sha256Text } from "./digest.js";

export const UpdateKindSchema = Type.Union([Type.Literal("clarify"), Type.Literal("change")]);
export type UpdateKind = Static<typeof UpdateKindSchema>;

export const TaskStatusSchema = Type.Union([Type.Literal("open"), Type.Literal("closed")]);
export type TaskStatus = Static<typeof TaskStatusSchema>;

export const TaskPhaseSchema = Type.Union([
  Type.Literal("discuss"),
  Type.Literal("implement"),
  Type.Literal("check"),
  Type.Literal("deliver"),
]);
export type TaskPhase = Static<typeof TaskPhaseSchema>;

export const TaskOutcomeSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("superseded"),
]);
export type TaskOutcome = Static<typeof TaskOutcomeSchema>;

/** frontmatter：最小元信息（DESIGN.md 第3.1节）；branch 为完整本地引用或 null。 */
export const TaskFrontmatterSchema = Type.Object(
  {
    id: Type.String({ pattern: "^k-[0-9a-f]{12}$" }),
    status: TaskStatusSchema,
    phase: TaskPhaseSchema,
    outcome: Type.Union([TaskOutcomeSchema, Type.Null()]),
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type TaskFrontmatter = Static<typeof TaskFrontmatterSchema>;

/** 记录区标记；标记间为记录区，标记外为输入区。 */
export const PROGRESS_START = "<!-- knit:progress:start -->";
export const PROGRESS_END = "<!-- knit:progress:end -->";

/**
 * 输入摘要：对输入区全文做 SHA-256。记录区不参与——记录可变化，
 * 纯记录与运行引用不使检查失效（STATES.md 第8节）。
 */
export function inputsDigestOf(taskMarkdown: string): string {
  return sha256Text(withoutStatusFields(inputsRegionOf(taskMarkdown)));
}

/** 输入区去掉执行状态字段后的正文；有效身份与注入分节共用（任务031）。 */
export function stripStatusFields(region: string): string {
  return withoutStatusFields(region);
}

/**
 * 需求摘要不含 status／phase／outcome／branch：这些是执行状态与身份，
 * 阶段转移不能使刚确认的输入或刚通过的检查立即 stale（DESIGN.md 第3.8节）。
 */
function withoutStatusFields(region: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(region);
  if (match === null) return region;
  const body = (match[1] ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^(id|status|phase|outcome|branch):/.test(line))
    .join("\n");
  return `---\n${body}\n---${match[2] ?? ""}${region.slice(match[0].length)}`;
}

/** 提取输入区（记录区标记之外的正文，含 frontmatter）；未找到标记时全文即输入。 */
export function inputsRegionOf(taskMarkdown: string): string {
  const start = taskMarkdown.indexOf(PROGRESS_START);
  const end = taskMarkdown.indexOf(PROGRESS_END);
  if (start === -1 || end === -1 || end < start) return taskMarkdown;
  return taskMarkdown.slice(0, start) + taskMarkdown.slice(end + PROGRESS_END.length);
}

/** 提取记录区正文（标记之间）；无标记时为空。 */
export function progressRegionOf(taskMarkdown: string): string {
  const start = taskMarkdown.indexOf(PROGRESS_START);
  const end = taskMarkdown.indexOf(PROGRESS_END);
  if (start === -1 || end === -1 || end < start) return "";
  return taskMarkdown.slice(start + PROGRESS_START.length, end);
}

/**
 * 草案版本摘要：kind、理由、内容、基线摘要与生成它的更新操作 ID 一起参与。
 * 同内容重建也获得新版本（操作 ID 不同），不能只按正文哈希撤回后来草案。
 */
export interface PendingDraftFacts {
  kind: UpdateKind;
  reason: string;
  content: string;
  baselineDigest: string;
  /** 生成本草案的更新操作 ID；无（如本地未启动 run 时直接保存）为 null。 */
  updateOperationId: string | null;
  createdAt: string;
}

export function pendingDraftDigest(draft: PendingDraftFacts): string {
  return sha256Text(
    JSON.stringify({
      kind: draft.kind,
      reason: draft.reason,
      content: draft.content,
      baselineDigest: draft.baselineDigest,
      updateOperationId: draft.updateOperationId,
      createdAt: draft.createdAt,
    }),
  );
}

/** 稳定任务身份：k- 前缀 + 12 位随机 hex；冲突由创建方核对后重生成。 */
export function newTaskId(randomHex: () => string): string {
  return `k-${randomHex()}`;
}
