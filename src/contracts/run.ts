import { arr, bool, int, lit, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { ProtocolVersionSchema } from "./protocol.js";

/** 阶段呈现方式：local 为现有 RPC 后台链路；rex 为 Rex 浮层内的 TUI 链路。 */
export const RunPresentationSchema = union([
  lit("local"),
  lit("rex"),
]);
export type RunPresentation = Static<typeof RunPresentationSchema>;

/** 阶段执行；advisory 只产出建议，不推进 Task。 */
export const RunPhaseSchema = union([
  lit("implement"),
  lit("check"),
  lit("advisory"),
]);
export type RunPhase = Static<typeof RunPhaseSchema>;

/** run 执行状态（STATES.md 第5节转移图）。 */
export const RunStateSchema = union([
  lit("claimed"),
  lit("preparing"),
  lit("running"),
  lit("completed"),
  lit("cancelled"),
  lit("failed"),
]);
export type RunState = Static<typeof RunStateSchema>;

/** launch 定位状态；starting 响应丢失先查匹配 claim，不重启。 */
export const RunLaunchStateSchema = union([
  lit("planned"),
  lit("starting"),
  lit("confirmed"),
  lit("failed"),
]);
export type RunLaunchState = Static<typeof RunLaunchStateSchema>;

/** 派发请求；先持久化 run ID／owner token 再执行，准备未确认时无模型副作用。 */
export const RunRequestSchema = obj(
  {
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
  },
);
export type RunRequest = Static<typeof RunRequestSchema>;

/** prepare 回执：ID 已持久化、可被同 ID 认领，尚未启动模型。 */
export const RunPrepareResultSchema = obj(
  {
    protocolVersion: ProtocolVersionSchema,
    runId: str({ minLength: 1 }),
    state: lit("claimed"),
  },
);
export type RunPrepareResult = Static<typeof RunPrepareResultSchema>;

/** 原生条目范围；取不到的端点如实 null，不填零不冒充。 */
export const NativeEntryRangeSchema = obj(
  {
    startEntryId: union([str({ minLength: 1 }), nul()]),
    leafEntryId: union([str({ minLength: 1 }), nul()]),
  },
);
export type NativeEntryRange = Static<typeof NativeEntryRangeSchema>;

/** 本 run 增量用量；不可取得如实 null。 */
export const RunUsageSchema = obj(
  {
    inputTokens: union([int({ minimum: 0 }), nul()]),
    outputTokens: union([int({ minimum: 0 }), nul()]),
  },
);
export type RunUsage = Static<typeof RunUsageSchema>;

/** 取消意图：按 run 与执行 token 落盘；旧 run 的取消不影响新 run。 */
export const RunCancelSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    operationId: str({ minLength: 1 }),
    token: str({ minLength: 1 }),
    requestedAt: str({ minLength: 1 }),
    reason: union([str(), nul()]),
  },
);
export type RunCancel = Static<typeof RunCancelSchema>;

/** 阶段报告（DESIGN.md 5.1、5.5）；字段按 phase 校验，模型自报不直接改 Task。 */
export const StageReportSchema = obj(
  {
    summary: str(),
    /** implement：实际改动的项目相对路径。 */
    changedPaths: opt(arr(str({ minLength: 1 }))),
    /** check：pass / changes_requested / blocked。 */
    verdict: opt(
      union([lit("pass"), lit("changes_requested"), lit("blocked")]),
    ),
    /** check：实际核对过的路径或完成条件。 */
    coverage: opt(arr(str({ minLength: 1 }))),
    findings: opt(arr(str())),
    unverified: opt(arr(str())),
    /** discuss：建议是否 ready；advisory 不推进业务。 */
    ready: opt(bool()),
  },
);
export type StageReport = Static<typeof StageReportSchema>;

/** 阶段使用的原生会话事实；原生引用不可恢复与执行结果分开报告。 */
export const RunSessionRecordSchema = obj(
  {
    knitSessionId: str({ minLength: 1 }),
    nativeSessionId: str({ minLength: 1 }),
    sessionFile: union([str({ minLength: 1 }), nul()]),
    role: str({ minLength: 1 }),
    status: str({ minLength: 1 }),
    resumeAction: union([lit("resume"), lit("create_new")]),
    resumeReason: union([str(), nul()]),
    nativeReadable: bool(),
  },
);
export type RunSessionRecord = Static<typeof RunSessionRecordSchema>;

/** 不可变 run 结果；先写 result 再收敛 state，接收由固定 operation 复核。 */
export const RunResultFileSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: union([lit("completed"), lit("cancelled"), lit("failed")]),
    report: union([StageReportSchema, nul()]),
    reportSummary: union([str(), nul()]),
    nativeEntries: NativeEntryRangeSchema,
    usage: RunUsageSchema,
    session: union([RunSessionRecordSchema, nul()]),
    /** 实际观察到的改动路径；check 时为空。 */
    actualChangedPaths: arr(str({ minLength: 1 })),
    /** 发布结果时的路径指纹；接收时据此发现后来改动。旧结果可缺省。 */
    actualEntries: opt(
      arr(
        obj(
          {
            path: str({ minLength: 1 }),
            digest: union([str({ minLength: 1 }), nul()]),
            absent: bool(),
            /** 指纹种类；旧结果缺省视为 file，只核内容（任务027）。 */
            factsKind: opt(union([lit("file"), lit("directory"), lit("link"), lit("absent")])),
            /** 八进制模式；目录／缺失为 null。 */
            mode: opt(union([str({ minLength: 1 }), nul()])),
          },
        ),
      ),
    ),
    acceptanceOperationId: str({ minLength: 1 }),
    recordedAt: str({ minLength: 1 }),
    failureReason: union([str(), nul()]),
    /** 执行分支（worktree 路由为 worktree 分支）；旧结果可缺省。 */
    branch: opt(union([str({ minLength: 1 }), nul()])),
  },
);
export type RunResultFile = Static<typeof RunResultFileSchema>;

/** 终态回执；result 先持久化、state 再收敛，终态不覆写。 */
export const RunResultSchema = obj(
  {
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: union([
      lit("completed"),
      lit("cancelled"),
      lit("failed"),
    ]),
    reportSummary: union([str(), nul()]),
    nativeEntries: opt(NativeEntryRangeSchema),
    usage: opt(RunUsageSchema),
    report: opt(union([StageReportSchema, nul()])),
    acceptance: opt(
      union([
        obj(
          {
            operationId: str({ minLength: 1 }),
            state: str({ minLength: 1 }),
            reason: union([str(), nul()]),
          },
        ),
        nul(),
      ]),
    ),
  },
);
export type RunResult = Static<typeof RunResultSchema>;

/** 只读 status 投影；时间取不到为 null，心跳与诊断事件不算业务活动。 */
export const RunStatusSchema = obj(
  {
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: RunStateSchema,
    launchState: opt(RunLaunchStateSchema),
    startedAt: opt(union([str(), nul()])),
    lastActivityAt: opt(union([str(), nul()])),
    result: opt(union([RunResultFileSchema, nul()])),
    acceptance: opt(
      union([
        obj(
          {
            operationId: str({ minLength: 1 }),
            state: str({ minLength: 1 }),
            reason: union([str(), nul()]),
          },
        ),
        nul(),
      ]),
    ),
  },
);
export type RunStatus = Static<typeof RunStatusSchema>;

/**
 * run 资料文件（DESIGN.md 第5.6节）。
 * request/launch 由核心写；inputs/instructions/state/result 由 worker 写。
 * 文件保存跨进程事实；SQLite 只做可查询投影，不能替代 request 与操作记录。
 */

export const RunPurposeSchema = union([lit("stage"), lit("assist")]);
export type RunPurpose = Static<typeof RunPurposeSchema>;

export const RunInitiatorSchema = obj(
  {
    client: union([lit("pi"), lit("cli")]),
    knitSessionId: union([str({ minLength: 1 }), nul()]),
    nativeSessionId: union([str({ minLength: 1 }), nul()]),
    cwd: str({ minLength: 1 }),
  },
);
export type RunInitiator = Static<typeof RunInitiatorSchema>;

/** 发布后不改的预期身份与需求；worker 认领后重新核实。 */
export const RunExpectationSchema = obj(
  {
    branch: union([str({ minLength: 1 }), nul()]),
    /** 准备时的任务执行目录（worktree 生效时为 worktree 路径）；旧请求可缺省。 */
    executionDir: opt(union([str({ minLength: 1 }), nul()])),
    inputsDigest: str({ minLength: 1 }),
    standardsDigest: str({ minLength: 1 }),
    effectiveInputsDigest: str({ minLength: 1 }),
    planId: str({ minLength: 1 }),
    /** 检查启动时绑定的成果范围摘要；旧任务可为 null。 */
    scopeDigest: opt(union([str({ minLength: 1 }), nul()])),
    /** 本任务明确授权为成果的正式规范及冻结旧版本；空表示无授权（任务037）。 */
    authorizedStandardOutputs: opt(
      arr(
        obj(
          {
            path: str({ minLength: 1 }),
            frozenDigest: str({ minLength: 1 }),
            frozenContent: str(),
          },
        ),
      ),
    ),
  },
);
export type RunExpectation = Static<typeof RunExpectationSchema>;

/** 按 Task 累积的成果范围；路径带当前指纹，检查据此判断目标版本。 */
export const ScopeFileSchema = obj(
  {
    schemaVersion: lit(1),
    taskId: str({ minLength: 1 }),
    runIds: arr(str({ minLength: 1 })),
    entries: arr(
      obj(
        {
          path: str({ minLength: 1 }),
          digest: union([str({ minLength: 1 }), nul()]),
          absent: bool(),
          /** 指纹种类；旧记录缺省视为 file（DESIGN §5.3 类型核 smoked，任务027）。 */
          factsKind: opt(union([lit("file"), lit("directory"), lit("link"), lit("absent")])),
          /** 八进制模式；目录／缺失为 null。 */
          mode: opt(union([str({ minLength: 1 }), nul()])),
        },
      ),
    ),
    digest: str({ minLength: 1 }),
    updatedAt: str({ minLength: 1 }),
  },
);
export type ScopeFile = Static<typeof ScopeFileSchema>;

/** 检查凭据；发布后不改，当前资格由输入／scope 版本另行推导。 */
export const CheckFileSchema = obj(
  {
    schemaVersion: lit(1),
    taskId: str({ minLength: 1 }),
    runId: str({ minLength: 1 }),
    branch: union([str({ minLength: 1 }), nul()]),
    verdict: union([lit("pass"), lit("changes_requested"), lit("blocked")]),
    report: StageReportSchema,
    inputsDigest: str({ minLength: 1 }),
    standardsDigest: str({ minLength: 1 }),
    effectiveInputsDigest: str({ minLength: 1 }),
    scopeDigest: str({ minLength: 1 }),
    recordedAt: str({ minLength: 1 }),
  },
);
export type CheckFile = Static<typeof CheckFileSchema>;

export const RunRequestFileSchema = obj(
  {
    schemaVersion: lit(1),
    protocolVersion: ProtocolVersionSchema,
    runId: str({ minLength: 1, pattern: "^run-[0-9a-f]{12}$" }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    presentation: opt(RunPresentationSchema),
    purpose: RunPurposeSchema,
    initiator: RunInitiatorSchema,
    createdAt: str({ minLength: 1 }),
    expected: RunExpectationSchema,
    model: obj(
      {
        runtime: str({ minLength: 1 }),
        provider: str({ minLength: 1 }),
        model: str({ minLength: 1 }),
      },
    ),
    toolPolicy: obj(
      {
        mode: union([lit("write"), lit("read")]),
        allow: arr(str()),
        deny: arr(str()),
      },
    ),
    recovery: obj(
      {
        nativeSessionId: union([str({ minLength: 1 }), nul()]),
        resume: union([lit("prefer"), lit("new")]),
      },
    ),
    acceptanceOperationId: str({ minLength: 1 }),
    diagnostics: obj({ enabled: bool() }),
  },
);
export type RunRequestFile = Static<typeof RunRequestFileSchema>;

/** 启动句柄：PID 与启动标识必须同时匹配才算同一实例。 */
export const RunHandleSchema = obj(
  {
    pid: int({ minimum: 1 }),
    bootId: str({ minLength: 1 }),
    procStartTicks: union([str({ minLength: 1 }), nul()]),
    hostname: str({ minLength: 1 }),
    recordedAt: str({ minLength: 1 }),
  },
);
export type RunHandle = Static<typeof RunHandleSchema>;

export const LaunchRecordSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    state: RunLaunchStateSchema,
    attempts: int({ minimum: 0 }),
    requestedAt: str({ minLength: 1 }),
    updatedAt: str({ minLength: 1 }),
    handle: union([RunHandleSchema, nul()]),
    /** worker 认领后的实例证据；未认领为 null。 */
    instance: union([
      obj(
        {
          workerId: str({ minLength: 1 }),
          pid: int({ minimum: 1 }),
          bootId: str({ minLength: 1 }),
          procStartTicks: union([str({ minLength: 1 }), nul()]),
          claimedAt: str({ minLength: 1 }),
        },
      ),
      nul(),
    ]),
    lastError: union([str(), nul()]),
  },
);
export type LaunchRecord = Static<typeof LaunchRecordSchema>;

export const FrozenInputsSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    frozenAt: str({ minLength: 1 }),
    planId: str({ minLength: 1 }),
    inputsDigest: str({ minLength: 1 }),
    standardsDigest: str({ minLength: 1 }),
    effectiveInputsDigest: str({ minLength: 1 }),
    taskDocumentDigest: str({ minLength: 1 }),
    sections: arr(
      obj(
        {
          sourceId: str({ minLength: 1 }),
          kind: str({ minLength: 1 }),
          path: union([str({ minLength: 1 }), nul()]),
          digest: union([str({ minLength: 1 }), nul()]),
          mode: str({ minLength: 1 }),
          countsTowardInputs: bool(),
        },
      ),
    ),
    excluded: arr(
      obj(
        {
          sourceId: str({ minLength: 1 }),
          reason: str({ minLength: 1 }),
        },
      ),
    ),
    toolPolicy: obj(
      {
        mode: union([lit("write"), lit("read")]),
        allow: arr(str()),
        deny: arr(str()),
      },
    ),
  },
);
export type FrozenInputs = Static<typeof FrozenInputsSchema>;

export const InstructionsFileSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    preparedAt: str({ minLength: 1 }),
    entries: arr(
      obj(
        {
          sourceId: str({ minLength: 1 }),
          scope: str({ minLength: 1 }),
          digest: union([str({ minLength: 1 }), nul()]),
          injection: str({ minLength: 1 }),
          path: union([str({ minLength: 1 }), nul()]),
          version: str({ minLength: 1 }),
        },
      ),
    ),
  },
);
export type InstructionsFile = Static<typeof InstructionsFileSchema>;

export const SnapshotEntrySchema = obj(
  {
    path: str({ minLength: 1 }),
    layer: union([lit("tracked"), lit("untracked")]),
    kind: union([lit("file"), lit("symlink"), lit("submodule")]),
    /** Git 索引模式；未跟踪文件按实际执行位取 100644／100755。 */
    mode: int({ minimum: 0 }),
    size: union([int({ minimum: 0 }), nul()]),
    digest: union([str({ minLength: 1 }), nul()]),
    /** 符号链接目标；非链接为 null。 */
    linkTarget: union([str(), nul()]),
    /** 基线存在但工作区缺失：恢复时删除。 */
    absent: bool(),
    /** 索引层中该路径的 blob OID；未跟踪为 null。 */
    indexOid: union([str({ minLength: 1 }), nul()]),
    /** 索引层内容的 SHA-256；旧快照可缺省（此时 --index 恢复拒绝）。 */
    indexDigest: opt(union([str({ minLength: 1 }), nul()])),
    /** 内容与 HEAD 树中同一路径的 blob 相同：不存 files/ 副本，恢复时按 OID 取字节。 */
    source: opt(lit("head")),
    /** 引用的 HEAD blob OID；source 为 head 时使用。 */
    headOid: opt(str({ minLength: 1 })),
    /** index blob 与 HEAD 树同一路径的 blob 相同：不存 index/ 副本。 */
    indexSource: opt(lit("head")),
    /** 引用的 HEAD index blob OID；indexSource 为 head 时使用。 */
    indexHeadOid: opt(str({ minLength: 1 })),
  },
);
export type SnapshotEntry = Static<typeof SnapshotEntrySchema>;

/**
 * 快照 manifest 当前写入版本。读取器兼容 v1：缺少 source／indexSource／savedBytes
 * 即全量副本语义。声明版本为数值且大于该值时视为未知较新格式，阻塞读写、不降级。
 */
export const SNAPSHOT_MANIFEST_VERSION = 2 as const;
/** 当前读取器可完整解释的快照 manifest 版本。 */
export const SNAPSHOT_READABLE_VERSIONS = [1, SNAPSHOT_MANIFEST_VERSION] as const;

export const SnapshotManifestSchema = obj(
  {
    /** v2 增加 HEAD 基线引用与 savedBytes；v1 无这些字段，按全量副本语义读取。 */
    schemaVersion: union([lit(1), lit(SNAPSHOT_MANIFEST_VERSION)]),
    runId: str({ minLength: 1 }),
    state: union([lit("preparing"), lit("ready"), lit("failed")]),
    createdAt: str({ minLength: 1 }),
    base: obj(
      {
        head: union([str({ minLength: 1 }), nul()]),
        branch: union([str({ minLength: 1 }), nul()]),
        /** 无 HEAD 的空仓库：不存在起点，恢复不假定旧树。 */
        absent: bool(),
      },
    ),
    coverage: obj(
      {
        tracked: bool(),
        index: bool(),
        untracked: bool(),
        worktree: bool(),
      },
    ),
    entries: arr(SnapshotEntrySchema),
    counts: obj(
      {
        tracked: int({ minimum: 0 }),
        untracked: int({ minimum: 0 }),
        absent: int({ minimum: 0 }),
      },
    ),
    bytes: int({ minimum: 0 }),
    /** 因引用 HEAD 基线而未写入快照目录的内容字节；不计入 bytes／maxBytes。 */
    savedBytes: opt(int({ minimum: 0 })),
    maxBytes: int({ minimum: 1 }),
    digest: str({ minLength: 1 }),
    reason: union([str(), nul()]),
  },
);
export type SnapshotManifest = Static<typeof SnapshotManifestSchema>;

export const RunStateFileSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: RunStateSchema,
    worker: obj(
      {
        workerId: str({ minLength: 1 }),
        pid: int({ minimum: 1 }),
        bootId: str({ minLength: 1 }),
        procStartTicks: union([str({ minLength: 1 }), nul()]),
        hostname: str({ minLength: 1 }),
      },
    ),
    claimedAt: str({ minLength: 1 }),
    updatedAt: str({ minLength: 1 }),
    /** 输入与正式实施快照已就绪；正式代码与模型调用仍由 013 从该点继续。 */
    prepared: bool(),
    preparedAt: union([str({ minLength: 1 }), nul()]),
    snapshot: union([
      obj(
        {
          state: str({ minLength: 1 }),
          digest: union([str({ minLength: 1 }), nul()]),
          entries: union([int({ minimum: 0 }), nul()]),
          reason: union([str(), nul()]),
        },
      ),
      nul(),
    ]),
    reason: union([str(), nul()]),
  },
);
export type RunStateFile = Static<typeof RunStateFileSchema>;

/** 阶段 Pi 进程句柄：worker 被杀后仍可核实旧工具是否存活，避免新会话绕过。 */
export const RunStageProcessSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    state: union([lit("starting"), lit("running"), lit("exited")]),
    workerPid: int({ minimum: 1 }),
    piPid: union([int({ minimum: 1 }), nul()]),
    bootId: str({ minLength: 1 }),
    procStartTicks: union([str({ minLength: 1 }), nul()]),
    hostname: str({ minLength: 1 }),
    nativeSessionId: str({ minLength: 1 }),
    knitSessionId: str({ minLength: 1 }),
    startedAt: str({ minLength: 1 }),
    recordedAt: str({ minLength: 1 }),
  },
);
export type RunStageProcess = Static<typeof RunStageProcessSchema>;

/**
 * 启动失败诊断（DESIGN.md 5.6）；只作失败原因的辅助证据，不作权威回执、不参与状态机。
 * stderrTail 是阶段 Pi 自身 stderr 的尾部（启动发生在任何 prompt 之前，不含消息正文）；超长只留尾部并如实标记。
 */
export const RunDiagnosticsFileSchema = obj(
  {
    schemaVersion: lit(1),
    runId: str({ minLength: 1 }),
    taskId: str({ minLength: 1 }),
    phase: RunPhaseSchema,
    kind: lit("runtime_start_failed"),
    /** RuntimeStartCheck.failure 代码；语义不变，诊断不参与状态机。 */
    failure: str({ minLength: 1 }),
    detail: str(),
    stderrTail: str(),
    truncated: bool(),
    recordedAt: str({ minLength: 1 }),
  },
);
export type RunDiagnosticsFile = Static<typeof RunDiagnosticsFileSchema>;
