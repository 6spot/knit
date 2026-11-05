/**
 * Task 主文档结构与输入变更契约（DESIGN.md 第3.1–3.3、3.5、3.8节）。
 * schema 供 CLI 参数与文件结构校验；摘要函数供应用层核对本与草案。
 * 域转移裁决在 domain/task.ts，本模块不裁决业务允许性。
 */
import { arr, int, lit, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { sha256Text } from "./digest.js";
import { WORKFLOW_ANCHORS, isWorkflowAnchor, type WorkflowAnchor } from "./workflow.js";

export const UpdateKindSchema = union([lit("clarify"), lit("change")]);
export type UpdateKind = Static<typeof UpdateKindSchema>;

export const TaskStatusSchema = union([lit("open"), lit("closed")]);
export type TaskStatus = Static<typeof TaskStatusSchema>;

/**
 * 任务阶段（设计 §3）：内置锚点 `start`／`deliver` 加当前流程配置里的阶段 id。
 * 阶段 id 由 `.knit/workflow.yaml` 定义，本契约只校验取值语法与锚点，
 * “是否在当前配置中”由 domain/task.ts 按 `WorkflowDefinition` 裁决。
 */
export type TaskStage = string;

export const TASK_STAGE_ANCHORS = WORKFLOW_ANCHORS;
export type TaskStageAnchor = WorkflowAnchor;

/** 内置锚点：start（准备／讨论）与 deliver（收尾）。 */
export function isTaskStageAnchor(value: string): value is TaskStageAnchor {
  return isWorkflowAnchor(value);
}

/** 阶段 id 语法；锚点同形，保留字冲突由配置层拒绝。 */
export const TASK_STAGE_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
export const TaskStageSchema = str({ pattern: TASK_STAGE_PATTERN });

/**
 * 旧 frontmatter 字段 `phase` 的只读映射（设计 §15.3 已确认例外）：
 * `discuss` 与新任务初始锚点 `start` 等价；其余值原样作为阶段值展示。
 * 写入端只写 `stage`，首次写入即完成字段改名，不做批量迁移。
 */
export function legacyPhaseToStage(value: string): TaskStage {
  return value === "discuss" ? "start" : value;
}

export const TaskOutcomeSchema = union([
  lit("completed"),
  lit("cancelled"),
  lit("superseded"),
]);
export type TaskOutcome = Static<typeof TaskOutcomeSchema>;

/** 任务完成所需的验证强度；none 只可由用户明确选择。 */
export const VerificationModeSchema = union([
  lit("none"),
  lit("self"),
  lit("independent"),
]);
export type VerificationMode = Static<typeof VerificationModeSchema>;

/** 任务自身优先级：P0 最高；与父子层级无关（DESIGN §3.11）。 */
export const TaskPrioritySchema = union([lit("P0"), lit("P1"), lit("P2"), lit("P3")]);
export type TaskPriority = Static<typeof TaskPrioritySchema>;

/** 未指定优先级时按 P2；"紧急"对应 P0，"可后置"对应 P3，二者都不从措辞推断。 */
export const DEFAULT_PRIORITY: TaskPriority = "P2";

export function priorityOf(frontmatter: { priority?: TaskPriority }): TaskPriority {
  return frontmatter.priority ?? DEFAULT_PRIORITY;
}

/** 新任务默认自检＋范围验证；旧记录缺省按 independent 保持既有检查语义。 */
export const DEFAULT_VERIFICATION: VerificationMode = "self";

export function verificationModeOf(frontmatter: { verification?: VerificationMode }): VerificationMode {
  return frontmatter.verification ?? "independent";
}

/** frontmatter：最小元信息（DESIGN.md 第3.1节）；branch 为完整本地引用或 null。 */
export const TaskFrontmatterSchema = obj(
  {
    id: str({ pattern: "^k-[0-9a-f]{12}$" }),
    status: TaskStatusSchema,
    stage: TaskStageSchema,
    outcome: union([TaskOutcomeSchema, nul()]),
    branch: union([str({ minLength: 1 }), nul()]),
    /** 完成验证要求；旧记录缺省按 independent 兼容。 */
    verification: opt(VerificationModeSchema),
    /**
     * 父任务稳定身份（DESIGN §3.10）。缺省或 null 表示顶层任务；
     * 关系只存子任务一侧，父任务通过扫描派生，目录改名不影响关联。
     */
    parent: opt(union([str({ pattern: "^k-[0-9a-f]{12}$" }), nul()])),
    /** 任务自身优先级；缺省 P2。 */
    priority: opt(TaskPrioritySchema),
    /** 前置依赖的稳定任务身份；缺省为空（无依赖）。 */
    dependsOn: opt(arr(str({ pattern: "^k-[0-9a-f]{12}$" }))),
    /** 同一优先级内人工调整后的业务执行顺序；缺省 null 表示沿用真实创建先后。 */
    order: opt(union([int(), nul()])),
    createdAt: str({ minLength: 1 }),
    title: str({ minLength: 1 }),
  },
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
 * 需求摘要不含 status／stage（旧字段 phase）／outcome／branch／parent／priority／dependsOn／order：
 * 这些是执行状态、结构身份与调度事实，阶段转移、挂接父任务、调整优先级、依赖或
 * 业务顺序都不改变工作内容与验收条件，不能使已确认输入或已通过的检查 stale
 * （DESIGN.md 第3.8、3.11节）。
 */
function withoutStatusFields(region: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(region);
  if (match === null) return region;
  const kept: string[] = [];
  // 调度字段可能是块状列表（dependsOn），其缩进续行随字段一起排除。
  let skipping = false;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (/^(id|status|stage|phase|outcome|branch|parent|priority|dependsOn|order):/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^(\s+\S|\s+-\s|\s+-$|- )/.test(line)) continue;
    skipping = false;
    kept.push(line);
  }
  const body = kept.join("\n");
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
