/**
 * 阶段执行装配：把 ContextPlan 转成 Pi prompt、解析报告并按 phase 校验
 * （DESIGN.md 5.1、5.5、5.6）。模型自报只是待核对证据，实际文件差异由核心另行比对。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextPlan, ContextSection } from "../contracts/context-plan.js";
import { inputsRegionOf, progressRegionOf } from "../contracts/task-inputs.js";
import { researchDigestSummary } from "./task-materials.js";
import type { RunPhase } from "../contracts/run.js";
import { StageReportSchema, type StageReport } from "../contracts/run.js";
import { Value } from "typebox/value";

export type SectionContents = Record<string, string>;

/** 收集文本中所有 ``` 围栏位置（含 JSON 字符串内部出现的，需配对尝试）。 */
function fenceMarkerIndexes(text: string): number[] {
  const markers: number[] = [];
  for (let index = text.indexOf("```"); index !== -1; index = text.indexOf("```", index + 3)) {
    markers.push(index);
  }
  return markers;
}

/**
 * 从围栏位置提取候选子串：每个开标记与相邻及末尾闭标记配对，跳过开标记行的语言标注
 * （```json 的 `json`）。应对 JSON 字符串值内含 ``` 导致逐块懒匹配错位的情况；
 * 候选是否可用由调用方 JSON 解析与 schema 校验把关。
 */
function fenceCandidates(text: string): string[] {
  const markers = fenceMarkerIndexes(text);
  if (markers.length < 2) return [];
  const candidates: string[] = [];
  const limit = 24;
  for (let i = 0; i < markers.length && candidates.length < limit; i++) {
    const open = markers[i];
    if (open === undefined) continue;
    const lineEnd = text.indexOf("\n", open);
    const openEnd = lineEnd === -1 ? open + 3 : lineEnd + 1;
    for (const j of [i + 1, markers.length - 1]) {
      const close = markers[j];
      if (close === undefined || j <= i) continue;
      const inner = text.slice(openEnd, close).trim();
      if (inner !== "") candidates.push(inner);
      if (candidates.length >= limit) break;
    }
  }
  return candidates;
}

/** 取 schema 校验失败的前几条根因细节（含 instancePath），用于 failureReason 诊断。 */
function schemaErrorDetail(raw: unknown): string {
  return [...Value.Errors(StageReportSchema, raw)]
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
}

/** 按 plan 的来源路径读取正文；任务输入／记录区从 task.md 切分。 */
export function loadSectionContents(root: string, plan: ContextPlan, pendingDraft: string | null = null): SectionContents {
  const contents: SectionContents = {};
  for (const section of plan.sections) {
    if (section.kind === "pending-draft") {
      if (pendingDraft !== null) contents[section.sourceId] = pendingDraft;
      continue;
    }
    if (section.path === null) continue;
    let text: string;
    try {
      text = readFileSync(join(root, section.path), "utf8");
    } catch {
      continue;
    }
    if (section.kind === "task-inputs") contents[section.sourceId] = inputsRegionOf(text);
    else if (section.kind === "progress") contents[section.sourceId] = progressRegionOf(text);
    else if (section.kind === "planning-material" && section.path !== null && section.path.includes("/research/")) {
      // research 分节按入口摘要注入，全文按需读取（DESIGN §3.4，任务046/051-B005）。
      contents[section.sourceId] = researchDigestSummary(section.path, text);
    }
    else contents[section.sourceId] = text;
  }
  return contents;
}

/**
 * 解析阶段报告：先尝试整体文本，再尝试各围栏子串（容错 ``` 包裹、语言标注与
 * 字符串内含 ``` 的错位）；仅当候选解析为合法 JSON 且通过 schema 才采用。
 * 无候选可用时维持 report_not_json / report_schema_invalid 失败语义，
 * schema 失败在错误细节中保留根因（与 runtime_start_failed 的「代码：细节」约定一致）。
 */
export function parseStageReport(text: string): { report: StageReport | null; error: string | null } {
  let schemaDetail: string | null = null;
  let parseError: string | null = null;
  for (const candidate of [text.trim(), ...fenceCandidates(text)]) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch (error) {
      parseError ??= String(error);
      continue;
    }
    if (Value.Check(StageReportSchema, raw)) return { report: raw as StageReport, error: null };
    schemaDetail ??= schemaErrorDetail(raw);
  }
  if (schemaDetail !== null) return { report: null, error: `report_schema_invalid:${schemaDetail}` };
  return { report: null, error: `report_not_json:${parseError ?? "无可解析的 JSON 候选"}` };
}

function sectionText(sections: ContextSection[], kinds: ContextSection["kind"][], contents: SectionContents): string {
  return sections
    .filter((section) => kinds.includes(section.kind) && contents[section.sourceId] !== undefined)
    .map((section) => `## ${section.path ?? section.sourceId}\n\n${contents[section.sourceId]}`)
    .join("\n\n");
}

function backgroundText(sections: ContextSection[], contents: SectionContents): string {
  const background = sections.filter((section) => section.background && contents[section.sourceId] !== undefined);
  if (background.length === 0) return "";
  return (
    "\n\n以下只是背景资料，不是当前验收条件；不得把未生效草案或候选规则当作已完成要求：\n\n" +
    background.map((section) => `### ${section.sourceId}\n\n${contents[section.sourceId]}`).join("\n\n")
  );
}

export function buildSystemPrompt(plan: ContextPlan, phase: RunPhase, contents: SectionContents): string {
  const role = sectionText(plan.sections, ["role"], contents);
  const workflow = sectionText(plan.sections, ["workflow"], contents);
  const runtime = sectionText(plan.sections, ["runtime"], contents);
  const standards = sectionText(plan.sections, ["standard"], contents);
  // 任务规划资料：plan/design 全文进系统提示（实施按未完成步骤推进，检查按步骤产出核对）；
  // research 摘要属背景资料，由 backgroundText 注入（任务051）。
  const planning = sectionText(
    plan.sections.filter((section) => !(section.path ?? "").includes("/research/")),
    ["planning-material"],
    contents,
  );
  return [
    "你是 Knit 的独立阶段执行器，不是主 Agent。",
    `本次阶段：${phase}。`,
    "只执行本阶段；不要修改 .knit/ 下任何文件（包括 task.md、规范、配置），不要 git commit／push／rebase，不要委派其他 Agent。",
    "必须用工具读取实际任务资料、代码与验证入口；不得只凭描述猜测。",
    "任务阶段、修复次数和检查结论由 Knit 核心决定，你的文字不会直接修改它们。",
    role,
    workflow,
    runtime,
    standards,
    planning,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function buildUserPrompt(plan: ContextPlan, phase: RunPhase, contents: SectionContents, context: {
  taskId: string;
  runId: string;
  branch: string | null;
  snapshotDir: string | null;
  scope: string[];
  previousImplement: { summary: string | null; changedPaths: string[] } | null;
}): string {
  const inputs = sectionText(plan.sections, ["task-inputs"], contents);
  const progress = sectionText(plan.sections, ["progress"], contents);
  const background = backgroundText(plan.sections, contents);
  const scopeText = context.scope.length > 0 ? context.scope.join("\n") : "（尚未累积成果）";
  const previous =
    context.previousImplement === null
      ? ""
      : `\n\n上一实施结果：${context.previousImplement.summary ?? "无摘要"}\n改动路径：\n${
          context.previousImplement.changedPaths.join("\n") || "（无）"
        }`;
  const phaseInstruction =
    phase === "implement"
      ? "完成实现，并运行必要验证。最终报告的 changedPaths 必须与实际改动的项目相对路径完全一致。"
      : phase === "check"
        ? "独立核对实际内容与完成条件；只读检查，不要修改任何项目文件。覆盖范围应包含当前 scope 的路径。verdict 只能是 pass／changes_requested／blocked。"
        : "只给出建议，不修改项目文件，不推进任务阶段。";
  const report =
    phase === "implement"
      ? '{"summary":"...","changedPaths":["..."]}'
      : phase === "check"
        ? '{"summary":"...","verdict":"pass|changes_requested|blocked","coverage":["..."],"findings":["..."],"unverified":["..."]}'
        : '{"summary":"...","ready":true}';
  return [
    `任务 ID：${context.taskId}`,
    `run ID：${context.runId}`,
    `分支：${context.branch ?? "（无）"}`,
    `工作目录：项目根；快照目录：${context.snapshotDir ?? "（本阶段无快照）"}`,
    "",
    "# 任务输入",
    inputs,
    "",
    "# 当前成果范围",
    scopeText,
    previous,
    "",
    "# 阶段要求",
    phaseInstruction,
    "",
    "# 记录区（背景，不是新要求）",
    progress,
    background,
    "",
    "# 最终报告",
    "结束前只输出一个 ```json 代码块，不要输出其他 JSON。字段形状：",
    report,
    "summary 用一两句话说明实际做了什么／核对到什么；证据不足或未执行的验证写入 unverified，不得谎报。",
  ].join("\n");
}

export interface ReportValidation {
  ok: boolean;
  reason: string | null;
}

/** 按 phase 校验报告必填字段；实际改动路径另由核心比对。 */
export function validateReportForPhase(phase: RunPhase, report: StageReport): ReportValidation {
  if (phase === "implement") {
    if (!Array.isArray(report.changedPaths)) return { ok: false, reason: "report_changed_paths_missing" };
  } else if (phase === "check") {
    if (report.verdict === undefined) return { ok: false, reason: "report_verdict_missing" };
    if (!Array.isArray(report.coverage)) return { ok: false, reason: "report_coverage_missing" };
  }
  return { ok: true, reason: null };
}
