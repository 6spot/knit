/**
 * 项目配置 `.knit/config.json`（DESIGN.md 第13节）。
 * schemaVersion 未知版本阻塞写入；数值校验正数容量、非负修复轮次、心跳可疑阈值大于间隔。
 */
import { arr, int, lit, map, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { checkSchema, schemaErrors } from "../contracts/schema.js";
import { InfrastructureError } from "../infrastructure/errors.js";

export const PROJECT_SCHEMA_VERSION = 1;

/** 执行宿主选择：auto 在派发前探测 Rex，不可用时回退 local；rex 强制且不回退。 */
export const ExecutionHostSchema = union([lit("auto"), lit("local"), lit("rex")]);
export type ExecutionHost = Static<typeof ExecutionHostSchema>;

/** Worktree 默认开关：off 不自动创建；on 在派发首个配置阶段前确保执行环境。 */
export const WorktreeDefaultSchema = union([lit("off"), lit("on")]);
export type WorktreeDefault = Static<typeof WorktreeDefaultSchema>;

/** 交付后清理策略：manual 保留环境；after-merge 在授权合入成功后清理。 */
export const WorktreeCleanupSchema = union([lit("manual"), lit("after-merge")]);
export type WorktreeCleanup = Static<typeof WorktreeCleanupSchema>;

/** 交付模式：local 在主检出收尾；merge 对已绑定 worktree 的任务先合入再交付。 */
export const DeliveryModeSchema = union([lit("local"), lit("merge")]);
export type DeliveryModeValue = Static<typeof DeliveryModeSchema>;

/** Knit 发起的提交是否执行用户 hooks：skip（缺省）用空 hooks 目录隔离；run 保留仓库 hooks。 */
export const DeliveryHooksSchema = union([lit("skip"), lit("run")]);
export type DeliveryHooks = Static<typeof DeliveryHooksSchema>;

export const ProjectConfigSchema = obj(
  {
    schemaVersion: int({ minimum: 1 }),
    client: obj({ default: str() }, { open: true }),
    agent: obj({ runtime: str(), resume: union([lit("prefer"), lit("new")]) }, { open: true }),
    execution: obj({ host: ExecutionHostSchema }, { open: true }),
    delivery: obj(
      {
        mode: DeliveryModeSchema,
        /** 可选完整本地 refs/heads/...；只作默认分支候选，不授权、不切分支。 */
        defaultBranch: opt(str({ pattern: "^refs/heads/.+" })),
        /** 交付提交是否执行用户 hooks；缺省 skip（core.hooksPath 指向空目录）。 */
        hooks: opt(DeliveryHooksSchema),
      },
      { open: true },
    ),
    workflow: obj({ maxRepairRounds: int({ minimum: 0 }) }, { open: true }),
    limits: obj(
      {
        heartbeatIntervalMs: int({ minimum: 1 }),
        heartbeatStaleMs: int({ minimum: 1 }),
        cancelGraceMs: int({ minimum: 1 }),
        snapshotsMaxBytes: int({ minimum: 1 }),
        storageWarnBytes: int({ minimum: 1 }),
      },
      { open: true },
    ),
    phases: opt(
      map(
        obj(
          {
            runtime: opt(str()),
            model: opt(str()),
          },
          { open: true },
        ),
      ),
    ),
    /** 多任务调度上限（任务 k-9cd9a63bd5c5）；缺省 1／1。门槛为 worktree.default=on。 */
    scheduler: opt(
      obj(
        {
          /** 同时派发上限；计数含手动 run。 */
          maxConcurrent: opt(int({ minimum: 1 })),
          /** 单任务单阶段在一次 schedule 循环内的派发上限；失败不重派。 */
          maxAttempts: opt(int({ minimum: 1 })),
        },
        { open: true },
      ),
    ),
    /** Worktree 公共资料复制白名单与 postCreate 环境步骤（任务 k-e48b7df14115）；无该节=无白名单无步骤。 */
    worktree: opt(
      obj(
        {
          /** 派发首个配置阶段前是否自动确保 worktree；缺省 off。 */
          default: opt(WorktreeDefaultSchema),
          /** 交付合入成功后是否自动清理；缺省 manual。 */
          cleanup: opt(WorktreeCleanupSchema),
          /** 复制白名单：path 相对主项目根；target 相对 worktree 根，缺省同相对路径。 */
          copy: opt(arr(obj({ path: str({ minLength: 1 }), target: opt(str({ minLength: 1 })) }, { open: true }))),
          /** 环境初始化步骤：在目标 worktree 按序执行；name 缺省按序号命名。 */
          postCreate: opt(arr(obj({ name: opt(str({ minLength: 1 })), command: str({ minLength: 1 }) }, { open: true }))),
        },
        { open: true },
      ),
    ),
  },
);

export type ProjectConfig = Static<typeof ProjectConfigSchema>;

export interface WorktreeCopyConfig {
  path: string;
  target?: string;
}

export interface WorktreeStepConfig {
  name?: string;
  command: string;
}

/** worktree 准备配置取值：缺省节与缺省数组都归一为空（不冒充已配置）。 */
export function worktreeConfigOf(config: ProjectConfig): { copy: WorktreeCopyConfig[]; postCreate: WorktreeStepConfig[] } {
  const section = config.worktree;
  return {
    copy: section?.copy ?? [],
    postCreate: section?.postCreate ?? [],
  };
}

/** Worktree 派发／收尾默认值与交付模式；旧配置缺字段时按设计缺省解释。 */
export function worktreeSettingsOf(config: ProjectConfig): {
  default: WorktreeDefault;
  cleanup: WorktreeCleanup;
  deliveryMode: DeliveryModeValue;
} {
  return {
    default: config.worktree?.default ?? "off",
    cleanup: config.worktree?.cleanup ?? "manual",
    deliveryMode: config.delivery.mode,
  };
}

/** 交付提交的 hooks 策略；旧配置缺字段按 skip。 */
export function deliveryHooksOf(config: ProjectConfig): DeliveryHooks {
  return config.delivery.hooks ?? "skip";
}

/** 调度配置缺省值：1／1；旧配置缺字段按此解释。 */
export function schedulerSettingsOf(config: ProjectConfig): { maxConcurrent: number; maxAttempts: number } {
  return {
    maxConcurrent: config.scheduler?.maxConcurrent ?? 1,
    maxAttempts: config.scheduler?.maxAttempts ?? 1,
  };
}

export function defaultConfig(): ProjectConfig {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    client: { default: "pi" },
    agent: { runtime: "pi", resume: "prefer" },
    execution: { host: "auto" },
    delivery: { mode: "local" },
    workflow: { maxRepairRounds: 2 },
    scheduler: { maxConcurrent: 1, maxAttempts: 1 },
    worktree: { default: "off", cleanup: "manual" },
    limits: {
      heartbeatIntervalMs: 5000,
      heartbeatStaleMs: 30000,
      cancelGraceMs: 5000,
      snapshotsMaxBytes: 67108864,
      storageWarnBytes: 536870912,
    },
  };
}

/** 读取并校验项目配置；未知 schemaVersion 阻塞写入（报 incompatible_version）。 */
export function parseConfig(raw: string): ProjectConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new InfrastructureError("io_error", `config.json 不是合法 JSON: ${String(error)}`);
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "schemaVersion" in data &&
    (data as { schemaVersion?: unknown }).schemaVersion !== PROJECT_SCHEMA_VERSION
  ) {
    throw new InfrastructureError("version_conflict", `不支持的 config schemaVersion，期望 ${PROJECT_SCHEMA_VERSION}`, {
      found: (data as { schemaVersion?: unknown }).schemaVersion,
    });
  }
  const errors = [...schemaErrors(ProjectConfigSchema, data)];
  if (errors.length > 0 || !checkSchema(ProjectConfigSchema, data)) {
    throw new InfrastructureError("io_error", "config.json 结构不符合约定", { errors: errors.slice(0, 5).map((e) => e.message) });
  }
  const config = data as ProjectConfig;
  if (config.limits.heartbeatStaleMs <= config.limits.heartbeatIntervalMs) {
    throw new InfrastructureError("io_error", "heartbeatStaleMs 必须大于 heartbeatIntervalMs");
  }
  return config;
}
