/**
 * 项目配置 `.knit/config.json`（DESIGN.md 第13节）。
 * schemaVersion 未知版本阻塞写入；数值校验正数容量、非负修复轮次、心跳可疑阈值大于间隔。
 */
import { int, lit, map, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { checkSchema, schemaErrors } from "../contracts/schema.js";
import { InfrastructureError } from "../infrastructure/errors.js";

export const PROJECT_SCHEMA_VERSION = 1;

export const ProjectConfigSchema = obj(
  {
    schemaVersion: int({ minimum: 1 }),
    client: obj({ default: str() }, { open: true }),
    agent: obj({ runtime: str(), resume: union([lit("prefer"), lit("new")]) }, { open: true }),
    execution: obj({ host: str() }, { open: true }),
    delivery: obj(
      {
        mode: str(),
        /** 可选完整本地 refs/heads/...；只作默认分支候选，不授权、不切分支。 */
        defaultBranch: opt(str({ pattern: "^refs/heads/.+" })),
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
  },
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
