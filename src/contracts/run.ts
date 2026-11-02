import { Type, type Static } from "typebox";
import { ProtocolVersionSchema } from "./protocol.js";

/** 阶段执行；advisory 只产出建议，不推进 Task。 */
export const RunPhaseSchema = Type.Union([
  Type.Literal("implement"),
  Type.Literal("check"),
  Type.Literal("advisory"),
]);
export type RunPhase = Static<typeof RunPhaseSchema>;

/** run 执行状态（STATES.md 第5节转移图）。 */
export const RunStateSchema = Type.Union([
  Type.Literal("claimed"),
  Type.Literal("preparing"),
  Type.Literal("running"),
  Type.Literal("finalizing"),
  Type.Literal("cancelling"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);
export type RunState = Static<typeof RunStateSchema>;

/** launch 定位状态；starting 响应丢失先查匹配 claim，不重启。 */
export const RunLaunchStateSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("starting"),
  Type.Literal("confirmed"),
  Type.Literal("failed"),
]);
export type RunLaunchState = Static<typeof RunLaunchStateSchema>;

/** 派发请求；先持久化 run ID／owner token 再执行，准备未确认时无模型副作用。 */
export const RunRequestSchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
  },
  { additionalProperties: false },
);
export type RunRequest = Static<typeof RunRequestSchema>;

/** prepare 回执：ID 已持久化、可被同 ID 认领，尚未启动模型。 */
export const RunPrepareResultSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    runId: Type.String({ minLength: 1 }),
    state: Type.Literal("claimed"),
  },
  { additionalProperties: false },
);
export type RunPrepareResult = Static<typeof RunPrepareResultSchema>;

/** 原生条目范围；取不到的端点如实 null，不填零不冒充。 */
export const NativeEntryRangeSchema = Type.Object(
  {
    startEntryId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    leafEntryId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type NativeEntryRange = Static<typeof NativeEntryRangeSchema>;

/** 本 run 增量用量；不可取得如实 null。 */
export const RunUsageSchema = Type.Object(
  {
    inputTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    outputTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RunUsage = Static<typeof RunUsageSchema>;

/** 取消意图：按 run 与执行 token 落盘；旧 run 的取消不影响新 run。 */
export const RunCancelSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    operationId: Type.String({ minLength: 1 }),
    token: Type.String({ minLength: 1 }),
    requestedAt: Type.String({ minLength: 1 }),
    reason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RunCancel = Static<typeof RunCancelSchema>;

/** 阶段报告（DESIGN.md 5.1、5.5）；字段按 phase 校验，模型自报不直接改 Task。 */
export const StageReportSchema = Type.Object(
  {
    summary: Type.String(),
    /** implement：实际改动的项目相对路径。 */
    changedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** check：pass / changes_requested / blocked。 */
    verdict: Type.Optional(
      Type.Union([Type.Literal("pass"), Type.Literal("changes_requested"), Type.Literal("blocked")]),
    ),
    /** check：实际核对过的路径或完成条件。 */
    coverage: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    findings: Type.Optional(Type.Array(Type.String())),
    unverified: Type.Optional(Type.Array(Type.String())),
    /** discuss：建议是否 ready；advisory 不推进业务。 */
    ready: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type StageReport = Static<typeof StageReportSchema>;

/** 阶段使用的原生会话事实；原生引用不可恢复与执行结果分开报告。 */
export const RunSessionRecordSchema = Type.Object(
  {
    knitSessionId: Type.String({ minLength: 1 }),
    nativeSessionId: Type.String({ minLength: 1 }),
    sessionFile: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    role: Type.String({ minLength: 1 }),
    status: Type.String({ minLength: 1 }),
    resumeAction: Type.Union([Type.Literal("resume"), Type.Literal("create_new")]),
    resumeReason: Type.Union([Type.String(), Type.Null()]),
    nativeReadable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RunSessionRecord = Static<typeof RunSessionRecordSchema>;

/** 不可变 run 结果；先写 result 再收敛 state，接收由固定 operation 复核。 */
export const RunResultFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("failed")]),
    report: Type.Union([StageReportSchema, Type.Null()]),
    reportSummary: Type.Union([Type.String(), Type.Null()]),
    nativeEntries: NativeEntryRangeSchema,
    usage: RunUsageSchema,
    session: Type.Union([RunSessionRecordSchema, Type.Null()]),
    /** 实际观察到的改动路径；check 时为空。 */
    actualChangedPaths: Type.Array(Type.String({ minLength: 1 })),
    /** 发布结果时的路径指纹；接收时据此发现后来改动。旧结果可缺省。 */
    actualEntries: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({ minLength: 1 }),
            digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            absent: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    acceptanceOperationId: Type.String({ minLength: 1 }),
    recordedAt: Type.String({ minLength: 1 }),
    failureReason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RunResultFile = Static<typeof RunResultFileSchema>;

/** 终态回执；result 先持久化、state 再收敛，终态不覆写。 */
export const RunResultSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: Type.Union([
      Type.Literal("completed"),
      Type.Literal("cancelled"),
      Type.Literal("failed"),
    ]),
    reportSummary: Type.Union([Type.String(), Type.Null()]),
    nativeEntries: Type.Optional(NativeEntryRangeSchema),
    usage: Type.Optional(RunUsageSchema),
    report: Type.Optional(Type.Union([StageReportSchema, Type.Null()])),
    acceptance: Type.Optional(
      Type.Union([
        Type.Object(
          {
            operationId: Type.String({ minLength: 1 }),
            state: Type.String({ minLength: 1 }),
            reason: Type.Union([Type.String(), Type.Null()]),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type RunResult = Static<typeof RunResultSchema>;

/** 只读 status 投影；时间取不到为 null，心跳与诊断事件不算业务活动。 */
export const RunStatusSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: RunStateSchema,
    launchState: Type.Optional(RunLaunchStateSchema),
    startedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    lastActivityAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    result: Type.Optional(Type.Union([RunResultFileSchema, Type.Null()])),
    acceptance: Type.Optional(
      Type.Union([
        Type.Object(
          {
            operationId: Type.String({ minLength: 1 }),
            state: Type.String({ minLength: 1 }),
            reason: Type.Union([Type.String(), Type.Null()]),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type RunStatus = Static<typeof RunStatusSchema>;

/**
 * run 资料文件（DESIGN.md 第5.6节）。
 * request/launch 由核心写；inputs/instructions/state/result 由 worker 写。
 * 文件保存跨进程事实；SQLite 只做可查询投影，不能替代 request 与操作记录。
 */

export const RunPurposeSchema = Type.Union([Type.Literal("stage"), Type.Literal("assist")]);
export type RunPurpose = Static<typeof RunPurposeSchema>;

export const RunInitiatorSchema = Type.Object(
  {
    client: Type.Union([Type.Literal("pi"), Type.Literal("cli")]),
    knitSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    nativeSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    cwd: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type RunInitiator = Static<typeof RunInitiatorSchema>;

/** 发布后不改的预期身份与需求；worker 认领后重新核实。 */
export const RunExpectationSchema = Type.Object(
  {
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    inputsDigest: Type.String({ minLength: 1 }),
    standardsDigest: Type.String({ minLength: 1 }),
    effectiveInputsDigest: Type.String({ minLength: 1 }),
    planId: Type.String({ minLength: 1 }),
    /** 检查启动时绑定的成果范围摘要；旧任务可为 null。 */
    scopeDigest: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type RunExpectation = Static<typeof RunExpectationSchema>;

/** 按 Task 累积的成果范围；路径带当前指纹，检查据此判断目标版本。 */
export const ScopeFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: Type.String({ minLength: 1 }),
    runIds: Type.Array(Type.String({ minLength: 1 })),
    entries: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          absent: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    digest: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ScopeFile = Static<typeof ScopeFileSchema>;

/** 检查凭据；发布后不改，当前资格由输入／scope 版本另行推导。 */
export const CheckFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("changes_requested"), Type.Literal("blocked")]),
    report: StageReportSchema,
    inputsDigest: Type.String({ minLength: 1 }),
    standardsDigest: Type.String({ minLength: 1 }),
    effectiveInputsDigest: Type.String({ minLength: 1 }),
    scopeDigest: Type.String({ minLength: 1 }),
    recordedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CheckFile = Static<typeof CheckFileSchema>;

export const RunRequestFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    protocolVersion: ProtocolVersionSchema,
    runId: Type.String({ minLength: 1, pattern: "^run-[0-9a-f]{12}$" }),
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
    purpose: RunPurposeSchema,
    initiator: RunInitiatorSchema,
    createdAt: Type.String({ minLength: 1 }),
    expected: RunExpectationSchema,
    model: Type.Object(
      {
        runtime: Type.String({ minLength: 1 }),
        provider: Type.String({ minLength: 1 }),
        model: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    toolPolicy: Type.Object(
      {
        mode: Type.Union([Type.Literal("write"), Type.Literal("read")]),
        allow: Type.Array(Type.String()),
        deny: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    recovery: Type.Object(
      {
        nativeSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        resume: Type.Union([Type.Literal("prefer"), Type.Literal("new")]),
      },
      { additionalProperties: false },
    ),
    acceptanceOperationId: Type.String({ minLength: 1 }),
    diagnostics: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export type RunRequestFile = Static<typeof RunRequestFileSchema>;

/** 启动句柄：PID 与启动标识必须同时匹配才算同一实例。 */
export const RunHandleSchema = Type.Object(
  {
    pid: Type.Integer({ minimum: 1 }),
    bootId: Type.String({ minLength: 1 }),
    procStartTicks: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    hostname: Type.String({ minLength: 1 }),
    recordedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type RunHandle = Static<typeof RunHandleSchema>;

export const LaunchRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    state: RunLaunchStateSchema,
    attempts: Type.Integer({ minimum: 0 }),
    requestedAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    handle: Type.Union([RunHandleSchema, Type.Null()]),
    /** worker 认领后的实例证据；未认领为 null。 */
    instance: Type.Union([
      Type.Object(
        {
          workerId: Type.String({ minLength: 1 }),
          pid: Type.Integer({ minimum: 1 }),
          bootId: Type.String({ minLength: 1 }),
          procStartTicks: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          claimedAt: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    lastError: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type LaunchRecord = Static<typeof LaunchRecordSchema>;

export const FrozenInputsSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
    frozenAt: Type.String({ minLength: 1 }),
    planId: Type.String({ minLength: 1 }),
    inputsDigest: Type.String({ minLength: 1 }),
    standardsDigest: Type.String({ minLength: 1 }),
    effectiveInputsDigest: Type.String({ minLength: 1 }),
    taskDocumentDigest: Type.String({ minLength: 1 }),
    sections: Type.Array(
      Type.Object(
        {
          sourceId: Type.String({ minLength: 1 }),
          kind: Type.String({ minLength: 1 }),
          path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          mode: Type.String({ minLength: 1 }),
          countsTowardInputs: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    excluded: Type.Array(
      Type.Object(
        {
          sourceId: Type.String({ minLength: 1 }),
          reason: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    toolPolicy: Type.Object(
      {
        mode: Type.Union([Type.Literal("write"), Type.Literal("read")]),
        allow: Type.Array(Type.String()),
        deny: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type FrozenInputs = Static<typeof FrozenInputsSchema>;

export const InstructionsFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    preparedAt: Type.String({ minLength: 1 }),
    entries: Type.Array(
      Type.Object(
        {
          sourceId: Type.String({ minLength: 1 }),
          scope: Type.String({ minLength: 1 }),
          digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          injection: Type.String({ minLength: 1 }),
          path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          version: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type InstructionsFile = Static<typeof InstructionsFileSchema>;

export const SnapshotEntrySchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    layer: Type.Union([Type.Literal("tracked"), Type.Literal("untracked")]),
    kind: Type.Union([Type.Literal("file"), Type.Literal("symlink"), Type.Literal("submodule")]),
    /** Git 索引模式；未跟踪文件按实际执行位取 100644／100755。 */
    mode: Type.Integer({ minimum: 0 }),
    size: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 符号链接目标；非链接为 null。 */
    linkTarget: Type.Union([Type.String(), Type.Null()]),
    /** 基线存在但工作区缺失：恢复时删除。 */
    absent: Type.Boolean(),
    /** 索引层中该路径的 blob OID；未跟踪为 null。 */
    indexOid: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 索引层内容的 SHA-256；旧快照可缺省（此时 --index 恢复拒绝）。 */
    indexDigest: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type SnapshotEntry = Static<typeof SnapshotEntrySchema>;

export const SnapshotManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    state: Type.Union([Type.Literal("preparing"), Type.Literal("ready"), Type.Literal("failed")]),
    createdAt: Type.String({ minLength: 1 }),
    base: Type.Object(
      {
        head: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        /** 无 HEAD 的空仓库：不存在起点，恢复不假定旧树。 */
        absent: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    coverage: Type.Object(
      {
        tracked: Type.Boolean(),
        index: Type.Boolean(),
        untracked: Type.Boolean(),
        worktree: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    entries: Type.Array(SnapshotEntrySchema),
    counts: Type.Object(
      {
        tracked: Type.Integer({ minimum: 0 }),
        untracked: Type.Integer({ minimum: 0 }),
        absent: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    bytes: Type.Integer({ minimum: 0 }),
    maxBytes: Type.Integer({ minimum: 1 }),
    digest: Type.String({ minLength: 1 }),
    reason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SnapshotManifest = Static<typeof SnapshotManifestSchema>;

export const RunStateFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: RunStateSchema,
    worker: Type.Object(
      {
        workerId: Type.String({ minLength: 1 }),
        pid: Type.Integer({ minimum: 1 }),
        bootId: Type.String({ minLength: 1 }),
        procStartTicks: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        hostname: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    claimedAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    /** 输入与正式实施快照已就绪；正式代码与模型调用仍由 013 从该点继续。 */
    prepared: Type.Boolean(),
    preparedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    snapshot: Type.Union([
      Type.Object(
        {
          state: Type.String({ minLength: 1 }),
          digest: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          entries: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
          reason: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    reason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RunStateFile = Static<typeof RunStateFileSchema>;

/** 阶段 Pi 进程句柄：worker 被杀后仍可核实旧工具是否存活，避免新会话绕过。 */
export const RunStageProcessSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: Type.Union([Type.Literal("starting"), Type.Literal("running"), Type.Literal("exited")]),
    workerPid: Type.Integer({ minimum: 1 }),
    piPid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    bootId: Type.String({ minLength: 1 }),
    procStartTicks: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    hostname: Type.String({ minLength: 1 }),
    nativeSessionId: Type.String({ minLength: 1 }),
    knitSessionId: Type.String({ minLength: 1 }),
    startedAt: Type.String({ minLength: 1 }),
    recordedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type RunStageProcess = Static<typeof RunStageProcessSchema>;
