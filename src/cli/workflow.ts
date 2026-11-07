/**
 * workflow 命令组：读取、校验与修改 `.knit/workflow.yaml`（设计 §9／§10／§11）。
 *
 * 写入约定：先在当前文件上编辑 YAML AST（保留注释与顺序），再对完整结果执行
 * `parseWorkflow` 全量校验；任何问题都带 YAML 行号拒绝，不落盘。成功写入使用
 * 原子发布（预期指纹为读取时的文件字节），并回显新流程摘要。
 */
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { GuardError } from "../application/guard-error.js";
import { workflowMaxRepairRounds } from "../application/workflow.js";
import {
  DEFAULT_WORKFLOW_YAML,
  parseWorkflow,
  type WorkflowDefinition,
  type WorkflowLoadResult,
} from "../domain/workflow.js";
import {
  WORKFLOW_CONFIG_PATH,
  TOOLS_ALL_REGEX,
  isReportEnum,
  type ReportFieldType,
  type ToolCapability,
  type WorkflowIssue,
  type WorkflowMode,
  type WorkflowValidation,
} from "../contracts/workflow.js";
import { atomicWrite } from "../infrastructure/atomic.js";
import { sha256Bytes } from "../infrastructure/fingerprint.js";
import { cliMainRoot } from "./root.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";

interface WorkflowFileState {
  path: string;
  exists: boolean;
  source: string;
  /** 读取时文件字节的指纹；文件不存在为 null（写入时要求仍不存在）。 */
  sha256: string | null;
}

interface WorkflowView {
  path: string;
  exists: boolean;
  ok: boolean;
  mode: WorkflowMode;
  workflow: WorkflowDefinition;
  validation: WorkflowValidation;
  summary: {
    chain: string;
    stages: Array<{ id: string; name: string; next: string }>;
    fallbackReason: string | null;
  };
}

/** 配置校验失败：带结构化问题清单，CLI 据此输出行号并拒绝写入。 */
class WorkflowInvalidError extends GuardError {
  constructor(
    message: string,
    readonly issues: WorkflowIssue[],
  ) {
    super("invalid_workflow", message);
    this.name = "WorkflowInvalidError";
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readFileState(root: string): WorkflowFileState {
  const path = join(root, WORKFLOW_CONFIG_PATH);
  if (!existsSync(path)) {
    return { path, exists: false, source: DEFAULT_WORKFLOW_YAML, sha256: null };
  }
  const bytes = readFileSync(path);
  return { path, exists: true, source: bytes.toString("utf8"), sha256: sha256Bytes(bytes) };
}

function parseSource(root: string, source: string): WorkflowLoadResult {
  return parseWorkflow(source, { maxRepairRounds: workflowMaxRepairRounds(root) });
}

function viewOf(state: WorkflowFileState, loaded: WorkflowLoadResult): WorkflowView {
  const stages = loaded.workflow.stages;
  return {
    path: WORKFLOW_CONFIG_PATH,
    exists: state.exists,
    ok: loaded.validation.ok,
    mode: loaded.mode,
    workflow: loaded.workflow,
    validation: loaded.validation,
    summary: {
      chain: ["准备", ...stages.map((stage) => stage.name), "收尾"].join(" → "),
      stages: stages.map((stage, index) => ({
        id: stage.id,
        name: stage.name,
        next: stages[index + 1]?.name ?? "收尾",
      })),
      fallbackReason: loaded.validation.reason,
    },
  };
}

function reportTypeLabel(type: ReportFieldType): string {
  return isReportEnum(type) ? `[${type.join("|")}]` : type;
}

/** 工具展示：null = 全部放开（不写或 all）；空数组 = 全部禁用；其余为白名单。 */
function toolsLabel(tools: readonly ToolCapability[] | null): string {
  if (tools === null) return "全部放开";
  if (tools.length === 0) return "全部禁用";
  return tools.join(", ");
}

function formatIssues(issues: readonly WorkflowIssue[]): string {
  return issues.map((issue) => `- ${issue.message}`).join("\n");
}

function assertValid(loaded: WorkflowLoadResult, action: string): void {
  if (loaded.validation.ok) return;
  throw new WorkflowInvalidError(
    `${WORKFLOW_CONFIG_PATH} 当前无效，不能${action}：\n${formatIssues(loaded.validation.issues)}`,
    loaded.validation.issues,
  );
}

function renderView(view: WorkflowView): string {
  const lines: string[] = [];
  const source = view.exists ? WORKFLOW_CONFIG_PATH : `${WORKFLOW_CONFIG_PATH}（未创建，使用缺省模板）`;
  const mode = view.mode === "fallback" ? `配置降级：${view.validation.reason}` : "config";
  lines.push(`配置: ${source}（${mode}）`);
  lines.push(`流程: ${view.summary.chain}`);
  if (view.workflow.stages.length === 0) {
    lines.push("阶段: 无业务阶段（start → deliver）");
  } else {
    lines.push(`阶段（${view.workflow.stages.length}）：`);
    view.workflow.stages.forEach((stage, index) => {
      lines.push(`  ${index + 1}. ${stage.id}（${stage.name}）→ ${view.summary.stages[index]?.next ?? "收尾"}`);
      if (stage.description !== null) lines.push(`     说明: ${stage.description}`);
      lines.push(`     提示词: ${stage.prompt ?? "（核心默认指令）"}`);
      lines.push(`     工具: ${toolsLabel(stage.tools)}`);
      const reportEntries = Object.entries(stage.report);
      if (reportEntries.length > 0) {
        lines.push(`     报告: ${reportEntries.map(([field, type]) => `${field}(${reportTypeLabel(type)})`).join("、")}`);
      }
      const verdictEntries = Object.entries(stage.onVerdict);
      if (verdictEntries.length > 0) {
        lines.push(`     裁决跳转: ${verdictEntries.map(([value, target]) => `${value} → ${target}`).join("；")}`);
      }
      lines.push(`     访问上限: ${stage.maxVisits === null ? "无" : String(stage.maxVisits)}`);
    });
  }
  if (!view.validation.ok) {
    lines.push(`问题（${view.validation.issues.length}）：`);
    lines.push(...view.validation.issues.map((issue) => `  - ${issue.message}`));
  }
  return lines.join("\n");
}

function ensureTrailingNewline(source: string): string {
  return source.endsWith("\n") ? source : `${source}\n`;
}

// ---------------------------------------------------------------------------
// YAML AST 编辑：只改目标节点，保留既有注释与字段顺序。

function stagesNode(doc: any): any {
  const stages = doc.get("stages");
  if (!isSeq(stages)) throw new GuardError("invalid_workflow", "stages 缺失或不是数组；先修正配置");
  return stages;
}

function scalarValue(node: any): string | null {
  if (typeof node === "string") return node;
  return isScalar(node) ? String(node.value) : null;
}

function stageIdOf(node: any): string | null {
  if (!isMap(node)) return null;
  return scalarValue(node.get("id"));
}

function stageIds(doc: any): string[] {
  return stagesNode(doc).items.map(stageIdOf).filter((id: string | null): id is string => id !== null);
}

function stageNodeOf(doc: any, id: string): any {
  const node = stagesNode(doc).items.find((item: any) => stageIdOf(item) === id);
  if (node === undefined) {
    const existing = stageIds(doc);
    throw new GuardError("unknown_stage", `阶段不存在: ${id}；现有阶段: ${existing.length === 0 ? "无" : existing.join("、")}`);
  }
  return node;
}

function indexOfStage(doc: any, id: string): number {
  const index = stagesNode(doc).items.findIndex((item: any) => stageIdOf(item) === id);
  if (index < 0) throw new GuardError("unknown_stage", `阶段不存在: ${id}`);
  return index;
}

/**
 * 解析 CLI 能力清单：
 * - 单独一项 `all`（大小写不敏感）→ 标量 `all`（全部放开）；
 * - `[]` 或 `none` → 空数组（全部禁用）；
 * - 其余为白名单。列表里混入 `all`、未知能力都原样写入候选配置，
 *   交给 parseWorkflow 产生带 YAML 行号的 invalid_tools。
 */
function parseTools(values: readonly string[]): string | ToolCapability[] {
  const raw = values.map((value) => value.trim());
  if (raw.length === 1 && (raw[0] === "[]" || raw[0]?.toLowerCase() === "none")) return [];
  const tokens = raw
    .flatMap((value) => value.split(/[\s,]+/))
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) {
    throw new GuardError("invalid_request", "tools 不能为空；全部放开用 all 或 --clear，全部禁用用 [] 或 none");
  }
  if (tokens.length === 1 && TOOLS_ALL_REGEX.test(tokens[0]!)) return "all";
  return tokens as ToolCapability[];
}

function parseReportType(value: string): ReportFieldType {
  const trimmed = value.trim();
  const scalars = new Set(["string", "string[]", "paths", "bool"]);
  if (scalars.has(trimmed)) return trimmed as ReportFieldType;
  let body = trimmed.startsWith("enum:") ? trimmed.slice("enum:".length) : trimmed;
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  const values = body
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  // 空枚举也写入候选配置，交给 parseWorkflow 返回带行号的 invalid_report。
  return values;
}

function reportFieldOf(value: string): { field: string; type: ReportFieldType } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new GuardError("invalid_request", `--report 需要 field:type，例如 verdict:[pass,changes_requested]（收到 ${value}）`);
  }
  return {
    field: value.slice(0, separator).trim(),
    type: parseReportType(value.slice(separator + 1)),
  };
}

function parseMaxVisits(value: string): number | string | null {
  if (value === "none" || value === "null") return null;
  const parsed = Number(value);
  // 非法值也写进候选配置，交给全量校验返回带行号的 invalid_max_visits。
  return Number.isFinite(parsed) ? parsed : value;
}

function addStage(doc: any, id: string, options: Record<string, any>): void {
  // 重复 id 也走全量校验：拒绝信息带新阶段所在行号。
  const data: Record<string, unknown> = { id };
  if (options.name !== undefined) data.name = String(options.name);
  if (options.description !== undefined) data.description = String(options.description);
  if (options.prompt !== undefined) data.prompt = String(options.prompt);
  if (Array.isArray(options.tools) && options.tools.length > 0) data.tools = parseTools(options.tools);
  if (Array.isArray(options.report) && options.report.length > 0) {
    const report: Record<string, ReportFieldType> = {};
    for (const entry of options.report) {
      const parsed = reportFieldOf(String(entry));
      report[parsed.field] = parsed.type;
    }
    data.report = report;
  }
  if (options.maxVisits !== undefined) data.maxVisits = parseMaxVisits(String(options.maxVisits));
  const node = doc.createNode(data);
  const seq = stagesNode(doc);
  let index = seq.items.length;
  if (options.before !== undefined) index = indexOfStage(doc, String(options.before));
  else if (options.after !== undefined) index = indexOfStage(doc, String(options.after)) + 1;
  seq.items.splice(index, 0, node);
}

function removeStage(doc: any, id: string): void {
  const seq = stagesNode(doc);
  const index = indexOfStage(doc, id);
  seq.items.splice(index, 1);
}

function moveStage(doc: any, id: string, position: string | undefined, options: Record<string, any>): void {
  const seq = stagesNode(doc);
  const from = indexOfStage(doc, id);
  const [item] = seq.items.splice(from, 1);
  let target: number;
  if (position !== undefined) {
    target = Number(position) - 1;
  } else if (options.before !== undefined) {
    target = indexOfStage(doc, String(options.before));
  } else if (options.after !== undefined) {
    target = indexOfStage(doc, String(options.after)) + 1;
  } else if (options.top === true) {
    target = 0;
  } else if (options.bottom === true) {
    target = seq.items.length;
  } else {
    throw new GuardError("invalid_request", "move 需要位置（1 起始）、--before、--after、--top 或 --bottom");
  }
  if (!Number.isInteger(target) || target < 0 || target > seq.items.length) {
    throw new GuardError("invalid_request", `移动位置越界: ${position ?? target + 1}（当前 ${seq.items.length + 1} 个阶段）`);
  }
  seq.items.splice(target, 0, item);
}

function setPrompt(doc: any, id: string, prompt: string | undefined, options: Record<string, any>): void {
  const node = stageNodeOf(doc, id);
  if (options.clear === true) {
    node.delete("prompt");
    return;
  }
  if (prompt === undefined || prompt === "") throw new GuardError("invalid_request", "set-prompt 需要路径，或用 --clear");
  node.set("prompt", prompt);
}

function setTools(doc: any, id: string, tools: string | undefined, options: Record<string, any>): void {
  const node = stageNodeOf(doc, id);
  if (options.clear === true) {
    node.delete("tools");
    return;
  }
  if (tools === undefined || tools === "") {
    throw new GuardError("invalid_request", "set-tools 需要能力清单、all（全部放开）、[]／none（全部禁用），或用 --clear");
  }
  const parsed = parseTools([tools]);
  // 空数组写成流式 []，便于阅读；非空列表沿用默认块式。
  node.set("tools", Array.isArray(parsed) && parsed.length === 0 ? flowSeq(doc) : parsed);
}

function flowSeq(doc: any): any {
  const seq = doc.createNode([]);
  seq.flow = true;
  return seq;
}

function setReport(doc: any, id: string, field: string, type: string | undefined, options: Record<string, any>): void {
  const node = stageNodeOf(doc, id);
  let report = node.get("report");
  if (!isMap(report)) {
    report = doc.createNode({});
    node.set("report", report);
  }
  if (options.clear === true) {
    report.delete(field);
    return;
  }
  if (type === undefined || type === "") throw new GuardError("invalid_request", "set-report 需要类型，或用 --clear");
  report.set(field, parseReportType(type));
}

function setNext(doc: any, id: string, value: string | undefined, target: string | undefined, options: Record<string, any>): void {
  const node = stageNodeOf(doc, id);
  if (options.clear === true) {
    node.delete("onVerdict");
    return;
  }
  if (value === undefined || value === "" || target === undefined || target === "") {
    throw new GuardError("invalid_request", "set-next 需要报告值、跳转目标，或用 --clear");
  }
  let onVerdict = node.get("onVerdict");
  if (!isMap(onVerdict)) {
    onVerdict = doc.createNode({});
    node.set("onVerdict", onVerdict);
  }
  onVerdict.set(value, target);
}

export function registerWorkflowCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";

  const fail = (requestId: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    const issues = error instanceof WorkflowInvalidError ? error.issues : undefined;
    if (jsonMode()) {
      emit(
        jsonResponse(
          requestId,
          outcomeForError(error),
          issues === undefined ? { error: message } : { error: message, issues },
          reasonForError(error),
        ),
      );
    } else {
      console.error(`knit: ${message}`);
    }
  };

  const renderResult = (view: WorkflowView, written: boolean): void => {
    if (written) console.log(`已写入 ${WORKFLOW_CONFIG_PATH}`);
    console.log(renderView(view));
  };

  const mutate = async (
    requestId: string,
    dir: string,
    change: (doc: any) => void,
  ): Promise<void> => {
    const root = cliMainRoot(dir);
    try {
      const state = readFileState(root);
      const current = parseSource(root, state.source);
      assertValid(current, "修改");
      const doc = parseDocument(state.source);
      change(doc);
      const nextSource = ensureTrailingNewline(doc.toString());
      const next = parseSource(root, nextSource);
      if (!next.validation.ok) {
        throw new WorkflowInvalidError(
          `写入被拒绝：\n${formatIssues(next.validation.issues)}`,
          next.validation.issues,
        );
      }
      atomicWrite({
        path: state.path,
        data: Buffer.from(nextSource, "utf8"),
        expectedSha256: state.sha256,
        mode: 0o644,
      });
      const view = viewOf({ ...state, exists: true, source: nextSource, sha256: sha256Bytes(Buffer.from(nextSource)) }, next);
      if (jsonMode()) emit(jsonResponse(requestId, "completed", { changed: true, ...view }));
      else renderResult(view, true);
    } catch (error) {
      fail(requestId, error);
    }
  };

  const workflow = program
    .command("workflow")
    .description("读取、校验与修改 .knit/workflow.yaml（写入先全量校验，失败带行号拒绝）");

  workflow
    .command("init")
    .description("生成带完整注释的默认流程配置")
    .option("--force", "覆盖已有配置")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = "workflow-init";
      const root = cliMainRoot(options.dir);
      try {
        const state = readFileState(root);
        if (state.exists && options.force !== true) {
          throw new GuardError("workflow_exists", `${WORKFLOW_CONFIG_PATH} 已存在；确认覆盖请加 --force`);
        }
        const loaded = parseSource(root, DEFAULT_WORKFLOW_YAML);
        assertValid(loaded, "写入默认配置");
        atomicWrite({
          path: state.path,
          data: Buffer.from(ensureTrailingNewline(DEFAULT_WORKFLOW_YAML), "utf8"),
          expectedSha256: state.sha256,
          mode: 0o644,
        });
        const view = viewOf(
          { path: state.path, exists: true, source: DEFAULT_WORKFLOW_YAML, sha256: sha256Bytes(Buffer.from(DEFAULT_WORKFLOW_YAML)) },
          loaded,
        );
        if (jsonMode()) emit(jsonResponse(requestId, "completed", { changed: true, ...view }));
        else renderResult(view, true);
      } catch (error) {
        fail(requestId, error);
      }
    });

  workflow
    .command("show")
    .description("展示生效流程、阶段字段与降级问题")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = "workflow-show";
      const root = cliMainRoot(options.dir);
      try {
        const state = readFileState(root);
        const loaded = parseSource(root, state.source);
        const view = viewOf(state, loaded);
        if (jsonMode()) emit(jsonResponse(requestId, "completed", view));
        else console.log(renderView(view));
      } catch (error) {
        fail(requestId, error);
      }
    });

  workflow
    .command("validate")
    .description("只读校验配置；问题带 YAML 行号")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (options) => {
      const requestId = "workflow-validate";
      const root = cliMainRoot(options.dir);
      try {
        const state = readFileState(root);
        const loaded = parseSource(root, state.source);
        const view = viewOf(state, loaded);
        if (jsonMode()) {
          emit(
            jsonResponse(requestId, view.validation.ok ? "completed" : "needs_attention", {
              ...view,
              issues: view.validation.issues,
              reason: view.validation.reason,
            }),
          );
        } else {
          console.log(`配置: ${state.exists ? WORKFLOW_CONFIG_PATH : `${WORKFLOW_CONFIG_PATH}（未创建，按缺省模板）`}`);
          if (view.validation.ok) {
            console.log(`配置有效；流程: ${view.summary.chain}`);
          } else {
            console.error(`配置无效（${view.validation.reason}）：`);
            for (const issue of view.validation.issues) console.error(`  - ${issue.message}`);
          }
        }
        if (!view.validation.ok) process.exitCode = 1;
      } catch (error) {
        fail(requestId, error);
      }
    });

  workflow
    .command("add")
    .description("新增阶段（默认追加到末尾）")
    .argument("<id>", "阶段 id")
    .option("--name <name>", "显示名")
    .option("--description <text>", "本步说明")
    .option("--prompt <path>", "项目相对提示词路径")
    .option("--tools <tools>", "能力白名单，逗号分隔（可重复）；all = 全部放开，[]／none = 全部禁用", collect, [])
    .option("--report <field:type>", "额外报告字段，如 verdict:[pass,blocked]（可重复）", collect, [])
    .option("--max-visits <n>", "访问上限（非负整数或 none）")
    .option("--before <id>", "插到该阶段之前")
    .option("--after <id>", "插到该阶段之后")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, options) => {
      await mutate("workflow-add", options.dir, (doc) => addStage(doc, id, options));
    });

  workflow
    .command("remove")
    .description("删除阶段；仍被 onVerdict 引用的配置会被拒绝")
    .argument("<id>", "阶段 id")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, options) => {
      await mutate("workflow-remove", options.dir, (doc) => removeStage(doc, id));
    });

  workflow
    .command("move")
    .description("调整阶段顺序")
    .argument("<id>", "阶段 id")
    .argument("[position]", "目标位置（1 起始）")
    .option("--before <id>", "移到该阶段之前")
    .option("--after <id>", "移到该阶段之后")
    .option("--top", "移到最前")
    .option("--bottom", "移到最后")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, position, options) => {
      await mutate("workflow-move", options.dir, (doc) => moveStage(doc, id, position, options));
    });

  workflow
    .command("set-prompt")
    .description("设置阶段提示词路径；--clear 恢复核心默认指令")
    .argument("<id>", "阶段 id")
    .argument("[path]", "项目相对路径")
    .option("--clear", "删除 prompt")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, prompt, options) => {
      await mutate("workflow-set-prompt", options.dir, (doc) => setPrompt(doc, id, prompt, options));
    });

  workflow
    .command("set-tools")
    .description("设置阶段能力：all 全部放开，[]／none 全部禁用，逗号清单为白名单；--clear 删除字段（等同全部放开）")
    .argument("<id>", "阶段 id")
    .argument("[tools]", "能力清单（逗号分隔）、all，或 []／none")
    .option("--clear", "删除 tools（等同全部放开）")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, tools, options) => {
      await mutate("workflow-set-tools", options.dir, (doc) => setTools(doc, id, tools, options));
    });

  workflow
    .command("set-report")
    .description("设置一个额外报告字段；--clear 删除该字段")
    .argument("<id>", "阶段 id")
    .argument("<field>", "报告字段名")
    .argument("[type]", "string／string[]／paths／bool 或逗号分隔枚举")
    .option("--clear", "删除该报告字段")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, field, type, options) => {
      await mutate("workflow-set-report", options.dir, (doc) => setReport(doc, id, field, type, options));
    });

  workflow
    .command("set-next")
    .description("设置报告值对应的跳转目标；--clear 删除该阶段全部 onVerdict")
    .argument("<id>", "阶段 id")
    .argument("[value]", "报告值")
    .argument("[target]", "阶段 id 或 deliver")
    .option("--clear", "删除该阶段全部 onVerdict")
    .option("--dir <dir>", "项目目录", ".")
    .action(async (id, value, target, options) => {
      await mutate("workflow-set-next", options.dir, (doc) => setNext(doc, id, value, target, options));
    });
}
