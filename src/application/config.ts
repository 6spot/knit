/**
 * 项目配置 `.knit/config.json`（DESIGN.md 第13节）。
 * schemaVersion 未知版本阻塞写入；数值校验正数容量、非负修复轮次、心跳可疑阈值大于间隔。
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { InfrastructureError } from "../infrastructure/errors.js";

export const PROJECT_SCHEMA_VERSION = 1;

export const ProjectConfigSchema = Type.Object(
  {
    schemaVersion: Type.Integer({ minimum: 1 }),
    client: Type.Object({ default: Type.String() }),
    agent: Type.Object({ runtime: Type.String(), resume: Type.Union([Type.Literal("prefer"), Type.Literal("new")]) }),
    execution: Type.Object({ host: Type.String() }),
    delivery: Type.Object({
      mode: Type.String(),
      /** 可选完整本地 refs/heads/...；只作默认分支候选，不授权、不切分支。 */
      defaultBranch: Type.Optional(Type.String({ pattern: "^refs/heads/.+" })),
    }),
    workflow: Type.Object({ maxRepairRounds: Type.Integer({ minimum: 0 }) }),
    limits: Type.Object({
      heartbeatIntervalMs: Type.Integer({ minimum: 1 }),
      heartbeatStaleMs: Type.Integer({ minimum: 1 }),
      cancelGraceMs: Type.Integer({ minimum: 1 }),
      snapshotsMaxBytes: Type.Integer({ minimum: 1 }),
      storageWarnBytes: Type.Integer({ minimum: 1 }),
    }),
    phases: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          runtime: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
        }),
      ),
    ),
  },
  { additionalProperties: false },
);

export type ProjectConfig = Static<typeof ProjectConfigSchema>;

export function defaultConfig(): ProjectConfig {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    client: { default: "pi" },
    agent: { runtime: "pi", resume: "prefer" },
    execution: { host: "local" },
    delivery: { mode: "local" },
    workflow: { maxRepairRounds: 2 },
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
  const errors = [...Value.Errors(ProjectConfigSchema, data)];
  if (errors.length > 0 || !Value.Check(ProjectConfigSchema, data)) {
    throw new InfrastructureError("io_error", "config.json 结构不符合约定", { errors: errors.slice(0, 5).map((e) => e.message) });
  }
  const config = data as ProjectConfig;
  if (config.limits.heartbeatStaleMs <= config.limits.heartbeatIntervalMs) {
    throw new InfrastructureError("io_error", "heartbeatStaleMs 必须大于 heartbeatIntervalMs");
  }
  return config;
}
