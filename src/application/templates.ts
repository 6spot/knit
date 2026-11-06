/**
 * 初始化模板（DESIGN.md 第14节）：项目资料只补缺，受管内容按旧基线更新。
 * 模板随安装包 assets/ 发布；不复制开发仓库 AGENTS.md。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { defaultConfig } from "./config.js";
import type { FileOwnership } from "./init-manifest.js";

/** 模板文件清单：项目内相对路径 → 所有权。桥接最后发布（顺序由 init 流程控制）。 */
export interface TemplateSpec {
  path: string;
  ownership: FileOwnership;
  /** 是否为 Pi 桥接（最后发布项）。 */
  bridge?: boolean;
}

export const TEMPLATE_SPECS: TemplateSpec[] = [
  { path: ".knit/config.json", ownership: "project" },
  { path: ".knit/workflow.yaml", ownership: "project" },
  { path: ".knit/agents/implement.md", ownership: "project" },
  { path: ".knit/agents/check.md", ownership: "project" },
  { path: ".knit/agents/runtimes/pi.md", ownership: "project" },
  { path: ".knit/standards/index.md", ownership: "project" },
  { path: ".pi/extensions/knit.ts", ownership: "managed", bridge: true },
];

/** 模板资产在安装包内的目录名（assets/templates）。 */
export const TEMPLATE_ASSET_DIR = "assets/templates";

export const AGENTS_MANAGED_MARKER_BEGIN = "<!-- knit:managed-begin -->";
export const AGENTS_MANAGED_MARKER_END = "<!-- knit:managed-end -->";

/** 模板资产目录：包根 assets/templates。dist/application/templates.js → dist → 包根。 */
export function templateRoot(): string {
  return join(fileURLToPath(new URL("../../assets/templates", import.meta.url)));
}

/** 模板内容读取；config.json 由 defaultConfig() 生成，不走文件模板。 */
export function readTemplate(relative: string): string {
  if (relative === ".knit/config.json") {
    throw new InfrastructureError("io_error", "config.json 由 defaultConfig() 生成，不走文件模板");
  }
  // 目标路径 → 模板资产路径：.pi/… 存放为 assets/templates/pi/…（点前缀目录不入包清单）
  const assetPath = relative.startsWith(".pi/") ? `pi/${relative.slice(3)}` : relative;
  return readFileSync(join(templateRoot(), assetPath), "utf8");
}

/** 模板目标内容：config.json 由 defaultConfig() 生成，其余读取安装包资产。 */
export function templateContent(relative: string): string {
  if (relative === ".knit/config.json") return JSON.stringify(defaultConfig(), null, 2) + "\n";
  return readTemplate(relative);
}

/** 模板指纹：模板目标文本的 SHA-256（config.json 与初始化写入内容一致）。 */
export function templateDigest(relative: string): string {
  return sha256Text(templateContent(relative));
}

/** AGENTS.md 受管标记块内容（从模板生成）。 */
export function agentsManagedBlock(knitCommand: string): string {
  const lines = [
    AGENTS_MANAGED_MARKER_BEGIN,
    "## Knit 受管入口",
    "",
    "本块由 Knit 生成并按基线维护；人工改动会因与基线不一致而报告差异，不静默覆盖。",
    "",
    "- 任务列表：活跃用 `" + knitCommand + " task list`，归档用 `" + knitCommand + " task list --archive`（`.knit/tasks/`）",
    `- 流程配置：\`.knit/workflow.yaml\`（默认 准备 → 实现 → 检查 → 收尾；启动用 \`${knitCommand} start\`；阶段顺序、提示词、工具与报告字段以此文件为准）`,
    "- 主会话入口：是否建任务由用户决定；新事项先问是否建任务再展开需求，暂不创建时继续讨论，转到实施前再确认；明确不创建时同一事项持续有效，不重复追问；实施前仍无有效选择先补问，不能用“你做吧”代替。创建任务不等于需求确认或实施授权；创建同意不等于实施授权；任务创建同意不等于需求确认或实施授权；用户明确“按这个做”等可同时确认范围与授权实施。普通问答／只读调查直接完成。",
    "- 需求澄清门：先取证再提问——查代码、测试、配置、文档、既有规范与任务历史（含归档任务、run 记录与提交说明），查得到的不问用户；仓库证据只证明现状与约束，产品意图、范围、验收与风险取舍仍由用户决定。逐项扫描缺口：目标与成功判据、范围与非目标、验收与证据、约束与依赖、冲突与合规、数据与副作用、失败与回滚、优先级与时序；证据已解决的不问，不硬造问题。需用户决定时，每问给出要定的决定、为什么重要、推荐项与选另一项的代价，一轮最多 3 个且一问只承载一个决定；推荐项不等于默认值，用户不答按推荐推进须写成 `[assumed]` 并标注“（Agent 建议，待确认）”。与既有规范、决定或架构冲突时先指出冲突、影响与替代方案，再等用户选择；用户已明确决定的不重复建议。未决项写入 task.md「待澄清」区段（`- [blocking] …`／`- [assumed] …`），解决后折入目标与完成条件并删除；`blocking` 未清零时 `task ready` 拒绝。想法登记时标注“需求未确认，仅登记想法”；复杂需求先拆分任务并确认范围。收敛时给最终摘要（目标、范围内外、验收、关键决定、风险与延期、资料状态）并等明确批准，不得以“完整方案＋是否正确”作为唯一确认。",
    "- 规范沉淀：明确长期规则可直接采纳并说明依据，冲突先提出并取得用户决定；不依附任务；未明确内容存项目候选（`.knit/standards/candidates.md`）；一次性要求只留本次范围；正常回复末尾简短说明内容、适用范围与位置。",
    "- 历史查询：需求澄清取证时可直接用 `" + knitCommand + " task search`（桥接 `knit_task` action=search）检索任务历史、归档与提交并引用来源；普通对话仅在用户明确表达查历史、上次决定／处理／修改或追溯问题的意愿时检索，未表达不主动检索；相关记录不等于证明因果。",
    "- 交付：主会话接收实施／检查结果、核对实际成果与完成条件并汇总报告；交付前起草一次产物提交文案并向用户展示，不虚构验证；不另启动交付辅助 worker；已有明确授权不重复确认；提交、推送、发布另行授权；按操作记录核实工具与 Git 实际效果；规范候选未审阅不构成交付前置。",
    "- 任务规划资料：task.md 为任务入口与业务状态唯一权威；复杂任务按需在任务目录内创建 plan.md／design.md／research/，简单任务只用 task.md",
    "- 规范索引：`.knit/standards/index.md`",
    "- 阶段提示词：`.knit/agents/`（由 workflow.yaml 的 `prompt` 引用；runtime 补充在 runtimes/）",
    "",
    "初始化不要求启动 Pi；桥接 `.pi/extensions/knit.ts` 按宿主项目信任规则加载，每轮提供当前任务与下一步上下文。",
    AGENTS_MANAGED_MARKER_END,
  ];
  return lines.join("\n") + "\n";
}

/** 受管模板版本：安装包版本，清单记录它以核对旧基线。 */
export function templateVersion(): string {
  return (JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string }).version;
}
