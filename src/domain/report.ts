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
import type { AcceptanceScenario } from "../contracts/task-inputs.js";
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

/** 报告失败是否只涉及报告本身，可在同一会话补报后重试；执行／边界失败不在此列。 */
export function isRetryableReportFailure(reason: string): boolean {
  return (
    reason === "report_invalid" ||
    reason === "report_changed_paths_missing" ||
    reason === "report_verdict_missing" ||
    reason.startsWith("report_not_json:") ||
    reason.startsWith("report_schema_invalid:") ||
    reason.startsWith("report_field_type:") ||
    reason.startsWith("report_field_missing:") ||
    reason.startsWith("report_field_value:") ||
    reason.startsWith("changed_paths_mismatch:") ||
    reason.startsWith("check_scope_incomplete:") ||
    reason.startsWith("check_scenarios_incomplete:") ||
    reason.startsWith("check_scenarios_inconsistent:")
  );
}

/** 逐场景结论的合法取值；写成场景的验收一律视为必须，`pass` 结论要求全部为 pass。 */
export const SCENARIO_VERDICTS = ["pass", "fail", "not_verified"] as const;
export type ScenarioVerdict = (typeof SCENARIO_VERDICTS)[number];

/** `scenarios` 条目格式；分隔用全角或半角冒号均可。 */
export const SCENARIO_ENTRY_FORMAT = "<编号> <结论>：<证据>";

/** 核对与提示只需要编号和两级名称。 */
export type ScenarioRef = Pick<AcceptanceScenario, "id" | "requirement" | "name">;

/** 场景的可读标识：编号加 Requirement 名与 Scenario 名。 */
export function scenarioLabel(scenario: ScenarioRef): string {
  return `${scenario.id}（${scenario.requirement}／${scenario.name}）`;
}

/** 条目格式说明，阶段提示与补报提示共用；示例取任务的第一个场景编号。 */
export function scenarioEntryGuide(scenarios: readonly ScenarioRef[]): string {
  const sample = scenarios[0]?.id ?? "R1.S1";
  return `scenarios 每个场景恰好一条，格式「${SCENARIO_ENTRY_FORMAT}」，结论只能是 ${SCENARIO_VERDICTS.join("／")}，证据非空，冒号全角半角均可；例：「${sample} pass：test/task.test.mjs「blocking 拒绝」通过」。`;
}

/** 阶段是否评判行为场景：按报告字段声明生效（与 coverage 相同），类型须为 `string[]`。 */
export function stageJudgesScenarios(stage: WorkflowStage | null): boolean {
  return (
    stage !== null &&
    Object.prototype.hasOwnProperty.call(stage.report, "scenarios") &&
    stage.report.scenarios === "string[]"
  );
}

export interface ScenarioReportCheck {
  ok: boolean;
  /** `report_field_value:scenarios`、`check_scenarios_incomplete:<编号列表>` 或 `check_scenarios_inconsistent:<编号列表>`。 */
  reason: string | null;
  /** 人读说明：问题场景的编号与名称，加条目格式；通过时为 null。 */
  detail: string | null;
}

const SCENARIO_ENTRY = /^\s*(R\d+\.S\d+)\s+(pass|fail|not_verified)\s*[:：]\s*(\S[\s\S]*)$/;
const SCENARIO_ENTRY_LOOSE = /^\s*(R\d+\.S\d+)(?![\w.])\s*([A-Za-z_]*)\s*([:：]?)\s*([\s\S]*)$/;

function clipEntry(entry: string): string {
  const chars = Array.from(entry.trim());
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : chars.join("");
}

/**
 * 检查报告的逐场景核对（任务 k-185ace3b9556）；worker 收尾与主会话接收共用，避免两处规则分叉。
 *
 * 只在阶段声明了 `scenarios` 且任务场景数大于 0 时生效，依次核对：
 * 1. 条目不合格式、编号不存在、编号重复或缺证据 → `report_field_value:scenarios`；
 * 2. 有场景没有条目（含整个字段缺失）→ `check_scenarios_incomplete:<编号列表>`；
 * 3. 阶段结论为 `pass` 但有条目不是 pass → `check_scenarios_inconsistent:<编号列表>`。
 *
 * 任何结论（含 blocked）都要求每个场景有条目；`changes_requested` 等结论允许 fail／not_verified。
 * 不判断场景内容或证据是否合理，也不改变 coverage 与 `check_scope_incomplete` 的判定。
 */
export function checkScenarioReport(
  stage: WorkflowStage | null,
  report: StageReport,
  scenarios: readonly ScenarioRef[],
): ScenarioReportCheck {
  if (!stageJudgesScenarios(stage) || scenarios.length === 0) return { ok: true, reason: null, detail: null };
  const guide = scenarioEntryGuide(scenarios);
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const labels = (ids: readonly string[]): string =>
    ids.map((id) => {
      const scenario = byId.get(id);
      return scenario === undefined ? id : scenarioLabel(scenario);
    }).join("；");
  const value = reportField(report, "scenarios");
  if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
    return { ok: false, reason: "report_field_value:scenarios", detail: `scenarios 必须是字符串数组。\n${guide}` };
  }
  const entries = (value ?? []) as string[];
  const verdicts = new Map<string, ScenarioVerdict>();
  const problems: string[] = [];
  for (const entry of entries) {
    const match = SCENARIO_ENTRY.exec(entry);
    if (match === null) {
      const loose = SCENARIO_ENTRY_LOOSE.exec(entry);
      const verdict = loose?.[2] ?? "";
      if (loose === null) problems.push(`「${clipEntry(entry)}」不合格式：应以场景编号开头`);
      else if (!(SCENARIO_VERDICTS as readonly string[]).includes(verdict)) {
        problems.push(`「${clipEntry(entry)}」的结论${verdict === "" ? "缺失" : `「${verdict}」`}不是 ${SCENARIO_VERDICTS.join("／")}`);
      } else if ((loose[4] ?? "").trim() === "") problems.push(`「${clipEntry(entry)}」缺证据`);
      else problems.push(`「${clipEntry(entry)}」不合格式：结论与证据之间用冒号分隔`);
      continue;
    }
    const id = match[1] ?? "";
    if (!byId.has(id)) {
      problems.push(`「${clipEntry(entry)}」的编号 ${id} 不是本任务的场景`);
      continue;
    }
    if (verdicts.has(id)) {
      problems.push(`${id} 有多条条目，每个场景只写一条`);
      continue;
    }
    verdicts.set(id, match[2] as ScenarioVerdict);
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason: "report_field_value:scenarios",
      detail: [`scenarios 条目问题：${problems.join("；")}`, `本任务的场景：${labels(scenarios.map((scenario) => scenario.id))}`, guide].join("\n"),
    };
  }
  const missing = scenarios.filter((scenario) => !verdicts.has(scenario.id)).map((scenario) => scenario.id);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `check_scenarios_incomplete:${missing.join(",")}`,
      detail: [
        `scenarios 缺少条目的场景：${labels(missing)}`,
        "每个场景都要有条目；当前环境验证不了的写 not_verified 并说明原因。",
        guide,
      ].join("\n"),
    };
  }
  if (reportVerdictOf(stage, report) === "pass") {
    const notPassed = scenarios.filter((scenario) => verdicts.get(scenario.id) !== "pass").map((scenario) => scenario.id);
    if (notPassed.length > 0) {
      return {
        ok: false,
        reason: `check_scenarios_inconsistent:${notPassed.join(",")}`,
        detail: [
          `结论为 pass，但这些场景不是 pass：${notPassed.map((id) => `${labels([id])} = ${verdicts.get(id) ?? "?"}`).join("；")}`,
          "结论 pass 要求全部场景为 pass；仍有 fail 或 not_verified 时改用其他结论，不要为了通过改写场景结论。",
          guide,
        ].join("\n"),
      };
    }
  }
  return { ok: true, reason: null, detail: null };
}

/** 声明为 `coverage` 的字符串数组；未声明或缺失返回 null（不强制覆盖核对）。 */
export function reportCoverageOf(stage: WorkflowStage | null, report: StageReport): string[] | null {
  if (stage === null) return null;
  const type = stage.report.coverage;
  if (type !== "string[]" && type !== "paths") return null;
  return reportStringArray(report, "coverage");
}

/**
 * 检查报告 coverage 未覆盖的 scope 路径；阶段未声明 coverage 时返回空。
 * 路径前缀命中即算覆盖（`src/app.ts：说明`），但路径后必须是分隔／说明文字，
 * 避免 `app.txt` 命中 `app.txt.bak`。与接收侧共用，避免两处规则分叉。
 */
export function uncoveredScopePaths(
  stage: WorkflowStage | null,
  report: StageReport,
  scopePaths: readonly string[],
): string[] {
  if (stage === null || !Object.prototype.hasOwnProperty.call(stage.report, "coverage")) return [];
  const coverage = (reportCoverageOf(stage, report) ?? []).map(normalizePath);
  return scopePaths
    .map(normalizePath)
    .filter((path) => {
      return !coverage.some((item) => {
        if (item === path) return true;
        if (!item.startsWith(path)) return false;
        return !/[A-Za-z0-9._/-]/.test(item[path.length] ?? "");
      });
    });
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
  options: { comparePaths?: boolean; scenarios?: readonly ScenarioRef[] } = {},
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
    // 有行为场景时，scenarios 的形状与条目语义统一交给共用核对函数，保持指定原因码。
    if (field === "scenarios" && stageJudgesScenarios(stage) && (options.scenarios?.length ?? 0) > 0) continue;
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
