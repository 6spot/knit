/** `knit init`：把随 Knit 发布的模板生成到项目里。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOST_SPECS, type HostOptions, type SharedSettings } from "../contracts/host.js";
import { atomicWrite } from "../infrastructure/fs.js";
import { createTask, hasTasks } from "./task-store.js";

/**
 * `template` 相对模板目录，`target` 相对项目根；顺序就是输出的顺序。
 * `restore` 为假的是项目自己的设置，强制初始化也不覆盖。
 */
export const CORE_TEMPLATES = [
  { template: "workflow.yaml", target: ".knit/workflow.yaml", restore: true },
  { template: "agents/implement.md", target: ".knit/agents/implement.md", restore: true },
  { template: "agents/review.md", target: ".knit/agents/review.md", restore: true },
  { template: "config.json", target: ".knit/config.json", restore: false },
  // 模板的文件名不带点：npm 打包时不收名叫 .gitignore 的文件。
  { template: "gitignore", target: ".knit/.gitignore", restore: false },
] as const;

// 编译后位于 dist/application/，往上两级是根目录。
const TEMPLATE_DIR = new URL("../../assets/templates/", import.meta.url);

export interface InitResult {
  created: string[];
  restored: string[];
  kept: string[];
  /** 相对项目根，结尾不带 `/`；这一次没有备份时是 null。 */
  backupDir: string | null;
  /** 这一次建的初始化任务，`file` 相对项目根；没有建时是 null。 */
  task: { id: string; title: string; file: string } | null;
}

/**
 * 缺的文件按模板补上，已有的不动。`force` 时再把 `restore` 的文件里和模板不一样的恢复成模板，
 * 覆盖之前全部复制到备份目录。先处理核心模板，再按宿主分组处理桥接。
 * 项目里一个任务都没有（归档的也算）时，再建一个写开发规范的任务。
 */
export function initProject(root: string, force = false, hosts: HostOptions = {}): InitResult {
  mkdirSync(join(root, ".knit", "standards"), { recursive: true });
  mkdirSync(join(root, ".knit", "tasks"), { recursive: true });
  const bridges = HOST_SPECS.flatMap((host) => {
    const items = host.templates.map((template) => ({ template, target: `.${template}`, restore: true }));
    const shared = "sharedSettings" in host ? host.sharedSettings : undefined;
    return hosts[host.id] || (force && items.some((item) => installedBridge(root, item.target, shared))) ? items : [];
  });
  const templates = [...CORE_TEMPLATES, ...bridges];
  const missing = templates.filter((item) => !existsSync(join(root, item.target)));
  const changed = force
    ? templates.filter(
        (item) =>
          item.restore &&
          !missing.includes(item) &&
          !readFileSync(join(root, item.target)).equals(readFileSync(new URL(item.template, TEMPLATE_DIR))),
      )
    : [];
  // 在 .knit/.runtime/ 下：这个目录不入库，对比工作区改动时也不算。
  const backupDir = `.knit/.runtime/backups/${timestamp(new Date())}`;
  changed.forEach((item) => {
    mkdirSync(dirname(join(root, backupDir, item.target)), { recursive: true });
    copyFileSync(join(root, item.target), join(root, backupDir, item.target));
  });
  [...missing, ...changed].forEach((item) => {
    mkdirSync(dirname(join(root, item.target)), { recursive: true });
    writeFileSync(join(root, item.target), readFileSync(new URL(item.template, TEMPLATE_DIR)));
  });
  return {
    created: missing.map((item) => item.target),
    restored: changed.map((item) => item.target),
    kept: templates.filter((item) => !missing.includes(item) && !changed.includes(item)).map((item) => item.target),
    backupDir: changed.length === 0 ? null : backupDir,
    task: hasTasks(root) ? null : createStandardsTask(root),
  };
}

function installedBridge(root: string, target: string, shared?: SharedSettings): boolean {
  const path = join(root, target);
  if (!existsSync(path)) return false;
  if (target !== shared?.target) return true;
  const launcherPath = shared.launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const launcher = new RegExp(String.raw`(?:^|[/'"\s])${launcherPath}(?=["'\s]|$)`);
  // 设置文件由项目共用，只有事件钩子引用启动脚本才表示启用了桥接。
  try {
    type Group = { hooks?: { type?: string; command?: string }[] };
    const settings: { hooks?: Record<string, Group[]> } | null = JSON.parse(readFileSync(path, "utf8"));
    return shared.events.some((event) => {
      const groups = settings?.hooks?.[event];
      return Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) =>
        hook?.type === "command" && typeof hook.command === "string" && launcher.test(hook.command)));
    });
  } catch {
    return false;
  }
}

function createStandardsTask(root: string): InitResult["task"] {
  const created = createTask(root, {
    title: "完善项目的开发规范",
    slug: "bootstrap-standards",
    verification: "self",
    priority: "P1",
    parent: null,
    dependsOn: [],
  }).created;
  // 没有上级和依赖，createTask 没有可以拒绝的地方。
  if (created === null) return null;
  const markdown = readFileSync(join(root, created.file), "utf8");
  const end = "\n---\n";
  // createTask 写的是开头字段加一份空的正文：开头字段留下，正文换成模板。
  atomicWrite({
    path: join(root, created.file),
    data: Buffer.from(
      `${markdown.slice(0, markdown.indexOf(end) + end.length)}\n${readFileSync(new URL("tasks/bootstrap-standards.md", TEMPLATE_DIR), "utf8")}`,
    ),
    mode: 0o644,
  });
  return created;
}

/** 本机时间的 `YYYYMMDD-HHMMSS-mmm`。 */
function timestamp(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    pad(now.getMilliseconds(), 3),
  ].join("-");
}
