/**
 * 阶段执行装配：把 ContextPlan 转成 Pi prompt、解析报告并交由阶段声明校验
 * （DESIGN.md 5.1、5.5、5.6）。模型自报只是待核对证据，实际文件差异由核心另行比对。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextPlan, ContextSection } from "../contracts/context-plan.js";
import { inputsRegionOf, progressRegionOf } from "../contracts/task-inputs.js";
import { researchDigestSummary } from "./task-materials.js";
import { StageReportSchema, type StageReport } from "../contracts/run.js";
import { isReportEnum, type ReportFieldType } from "../contracts/workflow.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { checkSchema, schemaErrors } from "../contracts/schema.js";
import { isDecisionStage } from "../domain/report.js";
import type { WorkflowStage } from "../domain/workflow.js";

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

/** 取 schema 校验失败的前几条根因细节（含 JSON Pointer 路径），用于 failureReason 诊断。 */
function schemaErrorDetail(raw: unknown): string {
  return [...schemaErrors(StageReportSchema, raw)]
    .slice(0, 3)
    .map((error) => `${error.path || "/"}: ${error.message}`)
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
    } catch (error) {
      if (section.required) {
        throw new InfrastructureError("io_error", `必需上下文资料不可读取: ${section.sourceId} (${section.path})`, {
          sourceId: section.sourceId,
          path: section.path,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
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
    if (checkSchema(StageReportSchema, raw)) return { report: raw as StageReport, error: null };
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

function reportSample(type: ReportFieldType): unknown {
  if (isReportEnum(type)) return type[0] ?? "...";
  switch (type) {
    case "string":
      return "...";
    case "string[]":
      return ["..."];
    case "paths":
      return ["..."];
    case "bool":
      return true;
  }
}

/** 按阶段声明生成报告形状示例；固定字段始终存在。 */
export function reportTemplateOf(stage: WorkflowStage | null): string {
  const shape: Record<string, unknown> = {
    summary: "...",
    validation: ["方法：...；结果：pass／fail／not_run；证据：..."],
    blockers: [],
  };
  if (stage !== null) {
    for (const [field, type] of Object.entries(stage.report)) {
      // 固定字段始终按固定语义展示；声明不能覆盖成别的形状。
      if (Object.prototype.hasOwnProperty.call(shape, field)) continue;
      // coverage 每项只对应一个 scope 路径；示例展示“路径：核对内容”，避免被误解为可合并多项。
      if (field === "coverage" && (type === "string[]" || type === "paths")) {
        shape[field] = ["src/app.ts：核对内容"];
        continue;
      }
      shape[field] = isReportEnum(type) ? (type[0] ?? "...") : reportSample(type);
    }
  }
  return JSON.stringify(shape);
}

function stageRequirementOf(stage: WorkflowStage | null): string {
  if (stage === null) {
    return "按当前任务资料完成本阶段产出，并运行必要验证；行为以阶段提示词与规范为准。";
  }
  if (!isDecisionStage(stage)) {
    const pathsFields = Object.entries(stage.report)
      .filter(([, type]) => type === "paths")
      .map(([field]) => field);
    const pathRequirement =
      pathsFields.length === 0
        ? ""
        : `最终报告的 ${pathsFields.join("／")} 必须与实际改动的项目相对路径完全一致。`;
    return `完成本阶段产出，并运行必要验证。${pathRequirement}未执行或证据不足的验证写入 validation（结果标 not_run），不得谎报。`;
  }
  const verdictField = Object.entries(stage.report).find(([, type]) => isReportEnum(type));
  const values = verdictField !== undefined && isReportEnum(verdictField[1]) ? verdictField[1] : [];
  const blockedValue = values.includes("blocked") ? "blocked" : values.includes("fail") ? "fail" : values.at(-1);
  const handoff =
    blockedValue === undefined
      ? "涉及需求解释、取舍、扩大范围或验收变化时不要修改，交回主会话"
      : `涉及需求解释、取舍、扩大范围或验收变化时不要修改，以 ${blockedValue} 交回主会话`;
  const coverageRequirement = Object.prototype.hasOwnProperty.call(stage.report, "coverage")
    ? "coverage 每项一个路径（可写成「路径：核对内容」），不要合并多项；scope 中每个路径都要单独出现，否则接收会以 check_scope_incomplete 拒绝。"
    : "";
  return [
    "核对实际内容与完成条件。发现既定需求内、问题与修复方向明确的缺陷时，可直接修复并运行相关验证；",
    `${handoff}。只改任务范围内必要文件，不修改 .knit/，不提交 Git。`,
    "有修改时 paths 文件字段必须与实际 diff 完全一致，并报告发现的问题、实际修改、执行的验证、未解决和未验证项；",
    "对自身修改的验证属于自检，不表述为另一独立执行者已复核。覆盖范围应包含当前 scope 的路径。",
    coverageRequirement,
    values.length > 0 ? `结论字段只能是 ${values.join("／")}。` : "",
  ].join("");
}

export function buildSystemPrompt(plan: ContextPlan, stage: WorkflowStage | null, contents: SectionContents): string {
  const role = sectionText(plan.sections, ["role"], contents);
  const runtime = sectionText(plan.sections, ["runtime"], contents);
  const standards = sectionText(plan.sections, ["standard"], contents);
  // 任务规划资料：plan/design 全文进系统提示（实施按未完成步骤推进，检查按步骤产出核对）；
  // research 摘要属背景资料，由 backgroundText 注入（任务051）。
  const planning = sectionText(
    plan.sections.filter((section) => !(section.path ?? "").includes("/research/")),
    ["planning-material"],
    contents,
  );
  const stageName = stage?.name ?? plan.role;
  return [
    plan.stageBrief ?? "",
    "你是 Knit 的独立阶段执行器，不是主 Agent。",
    `本次阶段：${stageName}（${plan.role}）。`,
    "只执行本阶段；不要修改 .knit/ 下任何文件（包括 task.md、规范、配置），不要 git commit／push／rebase，不要委派其他 Agent。",
    "必须用工具读取实际任务资料、代码与验证入口；不得只凭描述猜测。",
    "任务阶段、修复次数和检查结论由 Knit 核心决定，你的文字不会直接修改它们。",
    role,
    runtime,
    standards,
    planning,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function buildUserPrompt(plan: ContextPlan, stage: WorkflowStage | null, contents: SectionContents, context: {
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
  return [
    plan.stageBrief ?? "",
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
    stageRequirementOf(stage),
    "",
    "# 记录区（背景，不是新要求）",
    progress,
    background,
    "",
    "# 最终报告",
    "结束前只输出一个 ```json 代码块，不要输出其他 JSON。字段形状：",
    reportTemplateOf(stage),
    "summary 用一两句话说明实际做了什么／核对到什么；validation 记录实际执行的验证（方法、结果、证据），未执行项标 not_run；blockers 列出阻塞（无则空数组）；证据不足或未执行的验证不得谎报为通过。",
  ].join("\n");
}
