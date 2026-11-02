/**
 * 阶段执行装配：把 ContextPlan 转成 Pi prompt、解析报告并按 phase 校验
 * （DESIGN.md 5.1、5.5、5.6）。模型自报只是待核对证据，实际文件差异由核心另行比对。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextPlan, ContextSection } from "../contracts/context-plan.js";
import { inputsRegionOf, progressRegionOf } from "../contracts/task-inputs.js";
import type { RunPhase } from "../contracts/run.js";
import { StageReportSchema, type StageReport } from "../contracts/run.js";
import { Value } from "typebox/value";

export type SectionContents = Record<string, string>;

const REPORT_BLOCK = /```json\s*([\s\S]*?)```/g;

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
    else contents[section.sourceId] = text;
  }
  return contents;
}

/** 取最后一个 fenced JSON 块；没有块时尝试整体 JSON。 */
export function parseStageReport(text: string): { report: StageReport | null; error: string | null } {
  const blocks = [...text.matchAll(REPORT_BLOCK)];
  const candidate = blocks.at(-1)?.[1]?.trim() ?? text.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch (error) {
    return { report: null, error: `report_not_json:${String(error)}` };
  }
  if (!Value.Check(StageReportSchema, raw)) return { report: null, error: "report_schema_invalid" };
  return { report: raw as StageReport, error: null };
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
