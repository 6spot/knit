/**
 * 阶段报告校验（设计 §6）：固定字段 + 阶段声明字段。
 *
 * - 固定字段：`summary`（string）、`validation`（string[]）、`blockers`（string[]）。
 * - 阶段声明字段按 `.knit/workflow.yaml` 的类型校验；未声明的额外字段不参与判定。
 * - `paths` 类型默认与实际 Git 可见差异完全一致；有差异而漏报时给出
 *   `report_changed_paths_missing`，路径不符时给出带实际清单的原因。
 *   阶段收尾与新结果接收传 comparePaths=false，路径对照改由来源归属（domain/attribution.ts）完成。
 * - 枚举字段是阶段结论；声明了就必须给出合法值，供 `onVerdict` 或顺序流转使用。
 *
 * 纯函数：不做 IO、不看时钟、不信模型自报；实际差异由调用方传入。
 */
import type { StageReport } from "../contracts/run.js";
import {
  isReportEnum,
  type ReportFieldType,
} from "../contracts/workflow.js";
import type { WorkflowStage } from "./workflow.js";

export interface ReportValidation {
  ok: boolean;
  reason: string | null;
}

/** 阶段是否以报告枚举作结论（检查类阶段）；否则视为产出类阶段（实施类）。 */
export function isDecisionStage(stage: WorkflowStage | null): boolean {
  return stage !== null && Object.values(stage.report).some(isReportEnum);
}

/** 报告字段的值（可能是任意 JSON）；不存在返回 undefined。 */
export function reportField(report: StageReport, field: string): unknown {
  return (report as Record<string, unknown>)[field];
}

/** 报告中某字段的字符串值；不存在或非字符串返回 null。 */
export function reportString(report: StageReport, field: string): string | null {
  const value = reportField(report, field);
  return typeof value === "string" ? value : null;
}

/** 报告中某字段的字符串数组；不存在或含非字符串返回 null。 */
export function reportStringArray(report: StageReport, field: string): string[] | null {
  const value = reportField(report, field);
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

/** 报告中某字段的布尔值；不存在或非布尔返回 null。 */
export function reportBoolean(report: StageReport, field: string): boolean | null {
  const value = reportField(report, field);
  return typeof value === "boolean" ? value : null;
}

/**
 * 阶段结论：优先 `verdict`，否则取第一个声明枚举字段。
 * 枚举值不合法时返回 null（由校验给出具体原因）。
 */
export function reportVerdictOf(stage: WorkflowStage | null, report: StageReport): string | null {
  if (stage === null) return null;
  const entries = Object.entries(stage.report).filter((entry): entry is [string, string[]] =>
    isReportEnum(entry[1]),
  );
  entries.sort(([a], [b]) => (a === "verdict" ? -1 : b === "verdict" ? 1 : 0));
  for (const [field, values] of entries) {
    const value = reportString(report, field);
    if (value !== null && values.includes(value)) return value;
  }
  return null;
}

/** 声明为 `coverage` 的字符串数组；未声明或缺失返回 null（不强制覆盖核对）。 */
export function reportCoverageOf(stage: WorkflowStage | null, report: StageReport): string[] | null {
  if (stage === null) return null;
  const type = stage.report.coverage;
  if (type !== "string[]" && type !== "paths") return null;
  return reportStringArray(report, "coverage");
}

function typeMatches(type: ReportFieldType, value: unknown): boolean {
  if (isReportEnum(type)) {
    // 类型只要求字符串；枚举取值另由 validateReportForStage 报 report_field_value。
    return typeof value === "string";
  }
  switch (type) {
    case "string":
      return typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "paths":
      return (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string" && item.length > 0)
      );
    case "bool":
      return typeof value === "boolean";
  }
}

function typeName(type: ReportFieldType): string {
  return isReportEnum(type) ? "enum" : type;
}

function samePaths(reported: readonly string[], actual: readonly string[]): boolean {
  if (reported.length !== actual.length) return false;
  const sortedReported = [...reported].sort();
  const sortedActual = [...actual].sort();
  return sortedReported.every((path, index) => path === sortedActual[index]);
}

/**
 * 按阶段声明校验报告；`actualChangedPaths` 是核心观察到的实际差异。
 * 未声明字段不受限制（旧报告与额外排障字段可保留），但声明字段必须满足类型与语义。
 */
export function validateReportForStage(
  stage: WorkflowStage | null,
  report: StageReport,
  actualChangedPaths: string[] = [],
  options: { comparePaths?: boolean } = {},
): ReportValidation {
  // comparePaths=false：只校验形状与结论，paths 与实际差异的对照由来源归属（domain/attribution.ts）负责。
  const comparePaths = options.comparePaths ?? true;
  // 固定字段：schema 已保证 summary；这里补校验数组字段，兼容直接写入 result 的旧结果。
  for (const field of ["validation", "blockers"] as const) {
    const value = report[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      return { ok: false, reason: `report_field_type:${field}` };
    }
  }

  if (stage === null) return { ok: true, reason: null };

  const actual = [...new Set(actualChangedPaths.map(normalizePath))].sort();
  for (const [field, type] of Object.entries(stage.report)) {
    const value = reportField(report, field);
    if (value === undefined) {
      // 枚举是阶段结论，声明后必须给出；paths 的缺省规则见下。
      if (isReportEnum(type)) {
        return {
          ok: false,
          reason: field === "verdict" ? "report_verdict_missing" : `report_field_missing:${field}`,
        };
      }
      // 产出类阶段必须列出 paths（即使本次零 diff）；结论阶段无修改时可缺省。
      if (type === "paths" && comparePaths && (!isDecisionStage(stage) || actual.length > 0)) {
        return { ok: false, reason: "report_changed_paths_missing" };
      }
      continue;
    }
    if (!typeMatches(type, value)) {
      return { ok: false, reason: `report_field_type:${field}:${typeName(type)}` };
    }
    if (isReportEnum(type)) {
      const verdict = String(value);
      if (!type.includes(verdict)) {
        return { ok: false, reason: `report_field_value:${field}` };
      }
    }
    if (type === "paths" && comparePaths) {
      // 任务资料不计成果（实际差异已剔除）：如实列出它们的报告不因此整轮失败。
      const reported = (value as string[]).map(normalizePath).filter((path) => !path.startsWith(".knit/tasks/"));
      if (!samePaths(reported, actual)) {
        return {
          ok: false,
          reason:
            actual.length === 0
              ? "changed_paths_mismatch:zero_diff"
              : `changed_paths_mismatch:${actual.join(",")}`,
        };
      }
    }
  }
  return { ok: true, reason: null };
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}
