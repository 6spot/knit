/**
 * 主会话实施事实（DESIGN §3.8 完成资格）。
 * 用于没有 worker run 的实施路径：记录执行者、当时的输入摘要与成果路径指纹，
 * 便于完成后与交付前复验。强度低于已接收 run，但可核验、可失效。
 */
import { arr, lit, nul, obj, str, union, type Static } from "@earendil-works/pi-schema";
import { ScopeEntrySchema } from "./run.js";

export const ImplementationFileSchema = obj(
  {
    schemaVersion: lit(1),
    taskId: str({ minLength: 1 }),
    /** 执行者：主会话 Agent 或用户本人；不记录模型名。 */
    executor: union([lit("main-session"), lit("user")]),
    /** 记录时的任务输入摘要（含验证要求）。 */
    inputsDigest: str({ minLength: 1 }),
    /** 记录时的成果路径与指纹；后续改动使记录失效。 */
    entries: arr(ScopeEntrySchema, { minItems: 1 }),
    /** 成果路径集合摘要，便于快速比对。 */
    scopeDigest: str({ minLength: 1 }),
    /** 实施者实际运行过的验证；至少一条，避免记录退化为“声明完成”。 */
    validations: arr(str({ minLength: 1 }), { minItems: 1 }),
    /** 已知未验证项；可为空。 */
    unverified: arr(str({ minLength: 1 })),
    summary: union([str(), nul()]),
    recordedAt: str({ minLength: 1 }),
  },
);
export type ImplementationFile = Static<typeof ImplementationFileSchema>;
