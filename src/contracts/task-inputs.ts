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

/** task.md「待澄清」区段：固定二级标题，位置在完成条件之后、输入引用之前。 */
export const CLARIFY_HEADING = "## 待澄清";
/** 未决项行前缀（区分大小写，必须顶格）；缩进或大小写变体不作为未决项。 */
export const CLARIFY_BLOCKING_PREFIX = "- [blocking] ";
export const CLARIFY_ASSUMED_PREFIX = "- [assumed] ";

/** 「待澄清」区段解析结果：计数与错误消息所需的前 3 条 blocking 正文。 */
export interface ClarifyState {
  blocking: number;
  assumed: number;
  /** 前 3 条 blocking 项正文，单条最多 120 字符；超出以省略号结尾。 */
  blockingItems: string[];
}

/** 单条未决项截断：按码点计 120 字符，超出用省略号占位。 */
function clarifyItemText(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length > 120 ? `${chars.slice(0, 119).join("")}…` : chars.join("");
}

/**
 * 解析输入区的「待澄清」区段（任务 k-9197494d2657）：只认固定标题与顶格前缀，
 * 区段到下一个一级／二级标题为止。无区段、空区段或只有 assumed 不阻挡 ready。
 */
export function clarifyStateOf(taskMarkdown: string): ClarifyState {
  let inSection = false;
  let blocking = 0;
  let assumed = 0;
  const blockingItems: string[] = [];
  for (const line of inputsRegionOf(taskMarkdown).split(/\r?\n/)) {
    if (line.trimEnd() === CLARIFY_HEADING) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^#{1,2}\s/.test(line)) break;
    if (line.startsWith(CLARIFY_BLOCKING_PREFIX)) {
      blocking += 1;
      if (blockingItems.length < 3) blockingItems.push(clarifyItemText(line.slice(CLARIFY_BLOCKING_PREFIX.length)));
    } else if (line.startsWith(CLARIFY_ASSUMED_PREFIX)) {
      assumed += 1;
    }
  }
  return { blocking, assumed, blockingItems };
}

/** task.md「完成条件」区段：固定二级标题；其下的 Requirement／Scenario 是行为场景。 */
export const ACCEPTANCE_HEADING = "## 完成条件";
/** 三级标题固定前缀（半角冒号加一个空格）。 */
export const REQUIREMENT_PREFIX = "Requirement: ";
/** 四级标题固定前缀（半角冒号加一个空格）。 */
export const SCENARIO_PREFIX = "Scenario: ";

export type ScenarioStepKeyword = "GIVEN" | "WHEN" | "THEN" | "AND";

export interface ScenarioStep {
  keyword: ScenarioStepKeyword;
  /** 关键字之后的正文；`- WHEN …` 与 `- **WHEN** …` 得到相同结果。 */
  text: string;
}

/** 一个可单独验证的行为场景；编号按文档位置生成，输入变化后可能改变。 */
export interface AcceptanceScenario {
  /** `Rn.Sm`：第 n 个 Requirement 的第 m 个 Scenario，均从 1 起。 */
  id: string;
  requirement: string;
  name: string;
  steps: ScenarioStep[];
}

export type ScenarioIssueKind =
  | "requirement_without_scenario"
  | "scenario_missing_step"
  | "scenario_orphan"
  | "name_empty"
  | "name_duplicate"
  | "heading_malformed";

/** 结构错误：message 指明所在的 Requirement 或 Scenario。 */
export interface ScenarioIssue {
  kind: ScenarioIssueKind;
  message: string;
}

export interface ScenarioState {
  scenarios: AcceptanceScenario[];
  issues: ScenarioIssue[];
}

/** `task ready` 拒绝消息与写法指引共用的格式示例。 */
export const SCENARIO_FORMAT_EXAMPLE = [
  "### Requirement: 名称",
  "一句话说明必须具备的行为。",
  "",
  "#### Scenario: 名称",
  "- GIVEN 前置条件（可选）",
  "- WHEN 触发动作",
  "- THEN 期望结果",
  "- AND 补充结果（可选）",
].join("\n");

interface ScenarioNode {
  line: number;
  name: string;
  /** 固定前缀且名称非空；否则只作容器，吸收后续步骤，不再重复报错。 */
  wellFormed: boolean;
  steps: ScenarioStep[];
}

interface RequirementNode {
  line: number;
  name: string;
  wellFormed: boolean;
  scenarios: ScenarioNode[];
}

const STEP_PATTERN = /^[-*+][ \t]+(?:\*\*(GIVEN|WHEN|THEN|AND)\*\*|(GIVEN|WHEN|THEN|AND))[ \t]+(\S.*)$/;

/**
 * 解析输入区「完成条件」里的行为场景（任务 k-185ace3b9556）：纯函数，输入是 task.md 文本。
 *
 * - 区段：固定标题 `## 完成条件`，到下一个一级或二级标题为止；围栏代码块内的内容不解析。
 * - `### Requirement: 名称` 下放 `#### Scenario: 名称`；步骤是顶格列表项，关键字 GIVEN／WHEN／THEN／AND 大写，
 *   加粗与否等价；每个 Scenario 至少一条 WHEN 和一条 THEN。
 * - 区段内的普通文字和列表不解析、不报错；没有任何场景标题时场景数为 0。
 * - 写错的标题（全角冒号、小写关键字、层级不对、名称为空）各报一条结构错误，并仍作为容器吸收其下内容，
 *   避免一处笔误连带报出多条。
 *
 * 核心只核对结构，不区分 MUST／SHOULD／MAY，也不判断场景内容是否合理。
 */
export function scenarioStateOf(taskMarkdown: string): ScenarioState {
  const found: Array<ScenarioIssue & { line: number }> = [];
  const requirements: RequirementNode[] = [];
  let inSection = false;
  let fence: { char: string; length: number } | null = null;
  // 游标放在对象里：标题处理函数改写它，循环体按声明类型读取。
  const cursor: { requirement: RequirementNode | null; scenario: ScenarioNode | null } = { requirement: null, scenario: null };
  const lines = inputsRegionOf(taskMarkdown).split(/\r?\n/);
  const malformed = (line: number, heading: string, expected: string): void => {
    found.push({ line, kind: "heading_malformed", message: `标题「${heading}」不符合固定写法，应为「${expected}」（半角冒号加一个空格，关键字首字母大写）` });
  };
  const openRequirement = (line: number, name: string, wellFormed: boolean): void => {
    cursor.requirement = { line, name, wellFormed, scenarios: [] };
    requirements.push(cursor.requirement);
    cursor.scenario = null;
  };
  const openScenario = (line: number, name: string, wellFormed: boolean): void => {
    cursor.scenario = { line, name, wellFormed, steps: [] };
    if (cursor.requirement !== null) cursor.requirement.scenarios.push(cursor.scenario);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // 围栏从文档开头跟踪：围栏里的「## 完成条件」与场景标题都不算。
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      const marker = fenceMatch?.[1] ?? "";
      if (marker[0] === fence.char && marker.length >= fence.length && (fenceMatch?.[2] ?? "").trim() === "") fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      fence = { char: marker[0] ?? "`", length: marker.length };
      continue;
    }
    if (!inSection) {
      if (line.trimEnd() === ACCEPTANCE_HEADING) inSection = true;
      continue;
    }
    if (/^#{1,2}\s/.test(line)) break;
    const heading = /^(#{3,4})(?!#)(\s*)(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "").length;
      const spaced = (heading[2] ?? "") !== "";
      const text = (heading[3] ?? "").trim();
      const shown = line.trim();
      const looksRequirement = /^requirement/i.test(text);
      const looksScenario = /^scenario/i.test(text);
      // 「###Requirement: x」不是 Markdown 标题，但明显是写错的场景标题，同样报错而不是静默忽略。
      if (!spaced && !looksRequirement && !looksScenario) continue;
      if (looksRequirement) {
        const expected = `### ${REQUIREMENT_PREFIX}名称`;
        if (level !== 3 || !spaced) {
          malformed(index, shown, expected);
          openRequirement(index, text, false);
        } else if (text === REQUIREMENT_PREFIX.trimEnd()) {
          found.push({ line: index, kind: "name_empty", message: `Requirement 名称为空：「${shown}」` });
          openRequirement(index, "", false);
        } else if (text.startsWith(REQUIREMENT_PREFIX)) {
          openRequirement(index, text.slice(REQUIREMENT_PREFIX.length).trim(), true);
        } else {
          malformed(index, shown, expected);
          openRequirement(index, text, false);
        }
        continue;
      }
      if (looksScenario) {
        const expected = `#### ${SCENARIO_PREFIX}名称`;
        const owner = cursor.requirement;
        if (level !== 4 || !spaced) {
          malformed(index, shown, expected);
          openScenario(index, text, false);
        } else if (text === SCENARIO_PREFIX.trimEnd()) {
          const where = owner === null ? "" : `（Requirement「${owner.name}」）`;
          found.push({ line: index, kind: "name_empty", message: `Scenario 名称为空：「${shown}」${where}` });
          openScenario(index, "", false);
        } else if (text.startsWith(SCENARIO_PREFIX)) {
          const name = text.slice(SCENARIO_PREFIX.length).trim();
          if (owner === null) {
            found.push({ line: index, kind: "scenario_orphan", message: `Scenario「${name}」不在任何 Requirement 之下；先写「### ${REQUIREMENT_PREFIX}名称」` });
            openScenario(index, name, false);
          } else {
            openScenario(index, name, true);
          }
        } else {
          malformed(index, shown, expected);
          openScenario(index, text, false);
        }
        continue;
      }
      // 其他三级标题结束当前 Requirement；其他四级标题只结束当前 Scenario。
      if (level === 3) cursor.requirement = null;
      cursor.scenario = null;
      continue;
    }
    if (cursor.scenario === null) continue;
    const step = STEP_PATTERN.exec(line);
    if (step === null) continue;
    cursor.scenario.steps.push({
      keyword: (step[1] ?? step[2]) as ScenarioStepKeyword,
      text: (step[3] ?? "").trim(),
    });
  }

  const scenarios: AcceptanceScenario[] = [];
  const requirementNames = new Set<string>();
  let requirementNo = 0;
  for (const node of requirements) {
    if (!node.wellFormed) continue;
    requirementNo += 1;
    if (requirementNames.has(node.name)) {
      found.push({ line: node.line, kind: "name_duplicate", message: `Requirement 名称重复：「${node.name}」` });
    }
    requirementNames.add(node.name);
    if (node.scenarios.length === 0) {
      found.push({ line: node.line, kind: "requirement_without_scenario", message: `Requirement「${node.name}」没有 Scenario` });
    }
    const scenarioNames = new Set<string>();
    let scenarioNo = 0;
    for (const child of node.scenarios) {
      if (!child.wellFormed) continue;
      scenarioNo += 1;
      if (scenarioNames.has(child.name)) {
        found.push({ line: child.line, kind: "name_duplicate", message: `Scenario 名称重复：「${child.name}」（Requirement「${node.name}」）` });
      }
      scenarioNames.add(child.name);
      const missing = (["WHEN", "THEN"] as const).filter((keyword) => !child.steps.some((item) => item.keyword === keyword));
      if (missing.length > 0) {
        found.push({
          line: child.line,
          kind: "scenario_missing_step",
          message: `Scenario「${child.name}」（Requirement「${node.name}」）缺少 ${missing.join(" 与 ")}`,
        });
      }
      scenarios.push({ id: `R${requirementNo}.S${scenarioNo}`, requirement: node.name, name: child.name, steps: child.steps });
    }
  }
  // 结构错误按文档顺序给出；同一行的多条保持发现顺序。
  const issues = found
    .map((issue, order) => ({ issue, order }))
    .sort((a, b) => a.issue.line - b.issue.line || a.order - b.order)
    .map(({ issue }) => ({ kind: issue.kind, message: issue.message }));
  return { scenarios, issues };
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
