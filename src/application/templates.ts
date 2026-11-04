/**
 * 初始化模板（DESIGN.md 第14节）：项目资料只补缺，受管内容按旧基线更新。
 * 模板随安装包 assets/ 发布；不复制开发仓库 AGENTS.md。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "../infrastructure/fingerprint.js";
import { InfrastructureError } from "../infrastructure/errors.js";
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
  { path: ".knit/workflow.md", ownership: "project" },
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

/** config.json 的模板指纹：代码生成的默认配置文本。 */
export function templateDigest(relative: string): string {
  if (relative === ".knit/config.json") {
    // 与 initialization.ts 生成内容一致：defaultConfig 序列化 + 换行
    // 延迟导入避免循环依赖
    const { defaultConfig } = require("./config.js") as typeof import("./config.js");
    return sha256Text(JSON.stringify(defaultConfig(), null, 2) + "\n");
  }
  return sha256Text(readTemplate(relative));
}

/** AGENTS.md 受管标记块内容（从模板生成）。 */
export function agentsManagedBlock(knitCommand: string): string {
  const lines = [
    AGENTS_MANAGED_MARKER_BEGIN,
    "## Knit 受管入口",
    "",
    "本块由 Knit 生成并按基线维护；人工改动会因与基线不一致而报告差异，不静默覆盖。",
    "",
    "- 任务列表：`.knit/tasks/`（`" + knitCommand + " task list`）",
    `- 四环节工作流：\`.knit/workflow.md\`（讨论 → 实施 → 检查 → 交付；启动用 \`${knitCommand} start\`）`,
    "- 主会话工作流：是否建任务由用户决定；关键缺口先讨论再创建待执行任务；不建任务直接执行，正式任务按验证要求推进；普通问答／只读调查不强制记录；详见 workflow.md",
    "- 任务规划资料：task.md 为任务入口与业务状态唯一权威；复杂任务按需在任务目录内创建 plan.md／design.md／research/，简单任务只用 task.md",
    "- 规范索引：`.knit/standards/index.md`",
    "- 阶段角色指令：`.knit/agents/`（implement / check；交付由主会话协调，runtime 补充在 runtimes/）",
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
