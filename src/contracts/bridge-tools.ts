/**
 * Pi 桥接工具的同源参数 schema（DESIGN.md 第4.1节、TECHNOLOGY.md 第3节）。
 * 构建时由 scripts/build-bridge-schema.mjs 派生为 dist/contracts/bridge-tools.json；
 * 桥接只读取派生 JSON，不依赖用户项目 node_modules 中的 Knit 依赖。
 */
import { arr, bool, int, lit, map, obj, opt, str, union } from "@earendil-works/pi-schema";

export const TaskToolSchema = obj(
  {
    action: union([
      lit("list"),
      lit("search"),
      lit("new"),
      lit("rename"),
      lit("parent"),
      lit("priority"),
      lit("depends"),
      lit("order"),
      lit("next"),
      lit("ready"),
      lit("update"),
      lit("record"),
      lit("implement"),
      lit("close"),
      lit("adopt"),
      lit("verification"),
      lit("use"),
      lit("clear"),
    ]),
    taskId: opt(str({ minLength: 1 })),
    title: opt(str()),
    slug: opt(str()),
    newSlug: opt(str()),
    /** 历史检索：查询词可为单个字符串或词列表；不要求 taskId。 */
    query: opt(union([str({ minLength: 1 }), arr(str({ minLength: 1 }), { minItems: 1 })])),
    /** 历史检索范围；缺省全部。 */
    scope: opt(union([lit("task"), lit("archive"), lit("run"), lit("git")])),
    /** 历史检索最多返回条数；默认 20，核心上限 100。 */
    limit: opt(int({ minimum: 1 })),
    /** task list：默认只列未归档任务；archive 改为按月查看归档。 */
    archive: opt(bool()),
    /** task list --archive 的归档月份过滤（YYYY-MM，隐含 archive）。 */
    month: opt(str()),
    /** 创建或挂接的父任务稳定身份；解除关联用 detach。 */
    parentId: opt(str({ minLength: 1 })),
    detach: opt(bool()),
    /** 任务自身优先级 P0–P3；缺省 P2。 */
    priority: opt(union([lit("P0"), lit("P1"), lit("P2"), lit("P3")])),
    /** 前置依赖的稳定任务身份；add／remove 增量调整，set 整体替换。 */
    dependsOn: opt(arr(str({ minLength: 1 }))),
    removeDependsOn: opt(arr(str({ minLength: 1 }))),
    setDependsOn: opt(arr(str({ minLength: 1 }))),
    clearDependsOn: opt(bool()),
    /** 调整业务顺序的参照任务或位置。 */
    beforeId: opt(str({ minLength: 1 })),
    afterId: opt(str({ minLength: 1 })),
    position: opt(union([lit("top"), lit("bottom")])),
    branch: opt(str()),
    kind: opt(union([lit("clarify"), lit("change")])),
    body: opt(str()),
    reason: opt(str()),
    outcome: opt(union([lit("completed"), lit("cancelled"), lit("superseded")])),
    runsSettled: opt(bool()),
    /** 主会话实施事实：实际改动路径、验证与未验证项。 */
    paths: opt(arr(str({ minLength: 1 }))),
    validations: opt(arr(str({ minLength: 1 }))),
    unverified: opt(arr(str({ minLength: 1 }))),
    summary: opt(str()),
    executor: opt(union([lit("main-session"), lit("user")])),
    /** task close：跳过完成资格证据核对，必须有 reason。 */
    force: opt(bool()),
    applyPending: opt(bool()),
    withdrawPending: opt(bool()),
    expectPending: opt(str()),
    /** task update：目标有活动 run 时声明该 run（缺省时核心报 task_busy）。 */
    runId: opt(str({ minLength: 1 })),
    /** task update：只保存待应用草案，不改输入，不需要 runId。 */
    pending: opt(bool()),
    nonEquivalent: opt(bool()),
  },
);

export const ContextToolSchema = obj(
  {
    taskId: str({ minLength: 1 }),
    /** 阶段目标由生效流程派生；读取失败时退回字符串，由核心返回合法阶段清单。 */
    stage: opt(str({ minLength: 1 })),
  },
);

export const RunToolSchema = obj(
  {
    /** 阶段动作与 status／list／resume／cancel／accept 由桥接按 config 派生；这里只约束非空字符串。 */
    action: str({ minLength: 1 }),
    taskId: opt(str({ minLength: 1 })),
    runId: opt(str({ minLength: 1 })),
    scope: opt(arr(str({ minLength: 1 }))),
    /** accept：确认并入 scope 的来源不明路径（needs_attention: unattributed_paths）。 */
    include: opt(arr(str({ minLength: 1 }))),
    /** accept：确认排除的来源不明路径；不进 scope、不进交付。 */
    exclude: opt(arr(str({ minLength: 1 }))),
    provider: opt(str({ minLength: 1 })),
    model: opt(str({ minLength: 1 })),
    resumeSession: opt(str({ minLength: 1 })),
    newRepairCycle: opt(bool()),
    wait: opt(bool()),
    reason: opt(str()),
  },
);

/** `knit workflow` 命令组：读取、校验与修改 .knit/workflow.yaml。 */
export const WorkflowToolSchema = obj(
  {
    action: union([
      lit("init"),
      lit("show"),
      lit("validate"),
      lit("add"),
      lit("remove"),
      lit("move"),
      lit("set-prompt"),
      lit("set-tools"),
      lit("set-report"),
      lit("set-next"),
    ]),
    stageId: opt(str({ minLength: 1 })),
    name: opt(str()),
    description: opt(str()),
    prompt: opt(str({ minLength: 1 })),
    /** 阶段能力：字符串 `all` = 全部放开；`[]` = 全部禁用；非空数组 = 白名单；`clear` 删除字段（等同全部放开）。 */
    tools: opt(union([str({ minLength: 1 }), arr(str({ minLength: 1 }))])),
    report: opt(map(str({ minLength: 1 }))),
    maxVisits: opt(int({ minimum: 0 })),
    field: opt(str({ minLength: 1 })),
    type: opt(str({ minLength: 1 })),
    value: opt(str({ minLength: 1 })),
    target: opt(str({ minLength: 1 })),
    position: opt(int({ minimum: 1 })),
    before: opt(str({ minLength: 1 })),
    after: opt(str({ minLength: 1 })),
    clear: opt(bool()),
    force: opt(bool()),
  },
);

export const DeliverToolSchema = obj(
  {
    action: union([lit("deliver"), lit("archive"), lit("plan")]),
    taskId: opt(str({ minLength: 1 })),
    taskIds: opt(arr(str({ minLength: 1 }), { minItems: 1 })),
    branch: str({ pattern: "^refs/heads/.+" }),
    authorizationRef: opt(str()),
    retry: opt(bool()),
    /** 产物提交文案文件：单任务给路径；批量用 <taskId>=<path>，可重复。 */
    messageFile: opt(union([str({ minLength: 1 }), arr(str({ minLength: 1 }), { minItems: 1 })])),
  },
);

export const StandardsToolSchema = obj(
  {
    action: union([
      lit("list"),
      lit("propose"),
      lit("review"),
      lit("apply"),
      lit("pending"),
      lit("migrate"),
    ]),
    taskId: opt(str({ minLength: 1 })),
    /** 来源说明（讨论、实施发现）；propose 使用。 */
    source: opt(str()),
    title: opt(str()),
    problem: opt(str()),
    evidence: opt(str()),
    scope: opt(str()),
    rule: opt(str()),
    verification: opt(str()),
    decision: opt(union([lit("applied"), lit("deferred"), lit("rejected"), lit("mixed")])),
    reason: opt(str()),
    target: opt(str()),
    targets: opt(arr(str({ minLength: 1 }))),
    candidateId: opt(str()),
  },
);

export const SnapshotToolSchema = obj(
  {
    action: union([lit("show"), lit("restore")]),
    runId: str({ minLength: 1 }),
    path: opt(str({ minLength: 1 })),
    paths: opt(arr(str({ minLength: 1 }))),
    expect: opt(map(str({ minLength: 1 }))),
    index: opt(bool()),
    removeCreated: opt(bool()),
  },
);

export const StatusToolSchema = obj(
  {
    taskId: opt(str({ minLength: 1 })),
    runId: opt(str({ minLength: 1 })),
  },
);

/** 任务规划资料工具（DESIGN §3.4，任务045/048）：要求性内容变化仍须走 task update。 */
export const MaterialToolSchema = obj(
  {
    action: union([lit("list"), lit("read"), lit("save"), lit("delete")]),
    taskId: str({ minLength: 1 }),
    path: opt(str({ minLength: 1 })),
    content: opt(str()),
    expectDigest: opt(str()),
  },
);

export const BRIDGE_TOOL_SCHEMAS = {
  task: TaskToolSchema,
  material: MaterialToolSchema,
  context: ContextToolSchema,
  run: RunToolSchema,
  workflow: WorkflowToolSchema,
  deliver: DeliverToolSchema,
  standards: StandardsToolSchema,
  snapshot: SnapshotToolSchema,
  status: StatusToolSchema,
} as const;
