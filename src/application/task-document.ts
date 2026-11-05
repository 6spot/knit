/**
 * task.md 文档模型与读写（DESIGN.md 第3.1–3.3节）。
 * frontmatter 用 YAML Document（yaml 包）维护：更新保留键序、注释与未知键，
 * 正文按记录区标记分区，输入区与记录区所有权分离。
 */
import { Document, parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkSchema } from "../contracts/schema.js";
import {
  TaskFrontmatterSchema,
  PROGRESS_START,
  PROGRESS_END,
  legacyPhaseToStage,
  type TaskFrontmatter,
} from "../contracts/task-inputs.js";
import { InfrastructureError } from "../infrastructure/errors.js";

/** task.md 解析结果：frontmatter、输入区与记录区各自独立，写入方按所有权组合。 */
export interface TaskDocument {
  frontmatter: TaskFrontmatter;
  /** 输入区 Markdown（标记外正文）；保存的是不含尾部标记行的原文。 */
  inputsBody: string;
  /** 记录区正文（标记之间），不含标记行本身。 */
  progressBody: string;
  /** 记录区之后（结束标记下）的正文，如历史附录；原样保留。 */
  trailingBody: string;
}

function yamlError(path: string, message: string): InfrastructureError {
  return new InfrastructureError("io_error", `task.md 结构不符（${path}）: ${message}`);
}

/**
 * 解析 task.md；结构错误抛 io_error，不静默修复。
 *
 * 阶段字段：新文档写 `stage`；旧文档的 `phase` 只读映射到 `stage`
 * （`discuss` → `start`，其余原样）。渲染只写 `stage`，因此任一写操作都会
 * 完成字段改名并清掉旧键，不做批量迁移。值是否在当前流程配置中由应用层核对。
 */
export function parseTaskDocument(markdown: string, pathForErrors = "task.md"): TaskDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (match === null) throw yamlError(pathForErrors, "缺少 frontmatter 分隔符 ---");
  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(match[1] ?? "");
  } catch (error) {
    throw yamlError(pathForErrors, `frontmatter 不是合法 YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof rawFrontmatter !== "object" || rawFrontmatter === null || Array.isArray(rawFrontmatter)) {
    throw yamlError(pathForErrors, "frontmatter 不是映射");
  }
  const frontmatter = rawFrontmatter as Record<string, unknown>;
  for (const key of ["id", "status", "outcome", "branch", "createdAt", "title"]) {
    if (!(key in frontmatter)) throw yamlError(pathForErrors, `缺少字段 ${key}`);
  }
  if ("stage" in frontmatter && "phase" in frontmatter) {
    throw yamlError(pathForErrors, "frontmatter 同时含 stage 与旧字段 phase；只保留 stage");
  }
  const legacyPhase = frontmatter.phase;
  if ("phase" in frontmatter && typeof legacyPhase !== "string") {
    throw yamlError(pathForErrors, "旧字段 phase 必须是字符串");
  }
  const normalized: Record<string, unknown> = { ...frontmatter };
  delete normalized.phase;
  if (!("stage" in normalized)) {
    if (typeof legacyPhase !== "string") throw yamlError(pathForErrors, "缺少字段 stage");
    normalized.stage = legacyPhaseToStage(legacyPhase);
  }
  if (!checkSchema(TaskFrontmatterSchema, normalized)) {
    throw yamlError(pathForErrors, "frontmatter 字段值不符合 schema");
  }
  const typed = normalized as unknown as TaskFrontmatter;
  const rest = markdown.slice(match[0].length);
  const start = rest.indexOf(PROGRESS_START);
  const end = rest.indexOf(PROGRESS_END);
  if (start === -1 || end === -1 || end < start) {
    throw yamlError(pathForErrors, `缺少记录区标记 ${PROGRESS_START} / ${PROGRESS_END}`);
  }
  const normalize = (value: string) => value.replace(/^\r?\n/, "").replace(/\n[ \t]*$/, "\n");
  return {
    frontmatter: typed,
    inputsBody: normalize(rest.slice(0, start)),
    progressBody: normalize(rest.slice(start + PROGRESS_START.length, end)),
    trailingBody: rest.slice(end + PROGRESS_END.length),
  };
}

/** 组装 task.md 全文：frontmatter + 输入区 + 记录区 + 尾部。 */
export function renderTaskDocument(document: TaskDocument): string {
  const doc = new Document(document.frontmatter);
  const frontmatter = stringifyYaml(doc).trimEnd();
  return `---\n${frontmatter}\n---\n\n${document.inputsBody.trimEnd()}\n\n${PROGRESS_START}\n${document.progressBody.trimEnd()}\n\n${PROGRESS_END}${document.trailingBody.replace(/^(?!\n)/, "\n")}`;
}

/** 用更新后的 frontmatter 与分区生成新文档（保留尾部）。 */
export function withRegions(
  document: TaskDocument,
  update: { frontmatter?: TaskFrontmatter; inputsBody?: string; progressBody?: string },
): TaskDocument {
  return {
    frontmatter: update.frontmatter ?? document.frontmatter,
    inputsBody: update.inputsBody ?? document.inputsBody,
    progressBody: update.progressBody ?? document.progressBody,
    trailingBody: document.trailingBody,
  };
}
