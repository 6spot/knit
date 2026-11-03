/**
 * 初始化清单 `.knit/.runtime/init-manifest.json`（OPERATIONS.md 第1节）。
 * preparing → ready/failed；逐项结果留证据；中断按清单继续；未知版本不降级。
 */
import { arr, int, lit, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";

export const MANIFEST_SCHEMA_VERSION = 1;

/** 文件所有权（DESIGN.md 第14节）：project 只补缺；managed 按模板基线核对更新。 */
export type FileOwnership = "project" | "managed";

export type ManifestItemState = "created" | "kept" | "updated" | "conflict" | "failed" | "pending";

export interface ManifestItem {
  path: string;
  ownership: FileOwnership;
  state: ManifestItemState;
  /** 现文件指纹；沿用或冲突时记录。 */
  currentSha256?: string | null;
  /** 本次写入内容的指纹（managed 基线）。 */
  baselineSha256?: string | null;
  error?: string | null;
}

export const InitManifestSchema = obj(
  {
    schemaVersion: int({ minimum: 1 }),
    state: union([lit("preparing"), lit("ready"), lit("failed")]),
    client: str(),
    /** 模板基线版本（包版本）。 */
    templateVersion: str(),
    startedAt: str(),
    updatedAt: str(),
    items: arr(
      obj(
        {
          path: str(),
          ownership: union([lit("project"), lit("managed")]),
          state: union([
            lit("created"),
            lit("kept"),
            lit("updated"),
            lit("conflict"),
            lit("failed"),
            lit("pending"),
          ]),
          currentSha256: opt(union([str(), nul()])),
          baselineSha256: opt(union([str(), nul()])),
          error: opt(union([str(), nul()])),
        },
        { open: true },
      ),
    ),
  },
);

export type InitManifest = Static<typeof InitManifestSchema>;

export function newManifest(input: { client: string; templateVersion: string; now: string }): InitManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    state: "preparing",
    client: input.client,
    templateVersion: input.templateVersion,
    startedAt: input.now,
    updatedAt: input.now,
    items: [],
  };
}

/** 检查清单 schema 版本；未知版本阻塞（报 version_conflict），不降级猜测。 */
export function checkManifestVersion(manifest: InitManifest): void {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    const error = new Error(`不支持的 init-manifest schemaVersion ${manifest.schemaVersion}，期望 ${MANIFEST_SCHEMA_VERSION}`);
    error.name = "VersionConflict";
    throw error;
  }
}

/** ready 条件：无 failed／conflict／pending 项，桥接项已发布。 */
export function isReady(manifest: InitManifest, bridgePath: string): boolean {
  if (manifest.state !== "preparing") return false;
  return !manifest.items.some(
    (item) => item.state === "failed" || item.state === "conflict" || item.state === "pending" || (item.path === bridgePath && item.state !== "created" && item.state !== "updated" && item.state !== "kept"),
  );
}
