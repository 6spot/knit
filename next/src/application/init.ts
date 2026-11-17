/** `knit init`：把随 Knit 发布的模板生成到项目里。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `template` 相对模板目录，`target` 相对项目根；顺序就是输出的顺序。
 * `restore` 为假的是项目自己的设置，强制初始化也不覆盖。
 */
export const TEMPLATES = [
  { template: "workflow.yaml", target: ".knit/workflow.yaml", restore: true },
  { template: "agents/implement.md", target: ".knit/agents/implement.md", restore: true },
  { template: "agents/review.md", target: ".knit/agents/review.md", restore: true },
  { template: "config.json", target: ".knit/config.json", restore: false },
  // 模板的文件名不带点：npm 打包时不收名叫 .gitignore 的文件。
  { template: "gitignore", target: ".knit/.gitignore", restore: false },
  { template: "pi/extensions/knit.ts", target: ".pi/extensions/knit.ts", restore: true },
] as const;

// 编译后位于 next/dist/application/，往上两级是 next/。
const TEMPLATE_DIR = new URL("../../assets/templates/", import.meta.url);

export interface InitResult {
  created: string[];
  restored: string[];
  kept: string[];
  /** 相对项目根，结尾不带 `/`；这一次没有备份时是 null。 */
  backupDir: string | null;
}

/**
 * 缺的文件按模板补上，已有的不动。`force` 时再把 `restore` 的文件里和模板不一样的恢复成模板，
 * 覆盖之前全部复制到备份目录。返回的数组保持 TEMPLATES 的顺序。
 */
export function initProject(root: string, force = false): InitResult {
  mkdirSync(join(root, ".knit", "standards"), { recursive: true });
  mkdirSync(join(root, ".knit", "tasks"), { recursive: true });
  const missing = TEMPLATES.filter((item) => !existsSync(join(root, item.target)));
  const changed = force
    ? TEMPLATES.filter(
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
    kept: TEMPLATES.filter((item) => !missing.includes(item) && !changed.includes(item)).map((item) => item.target),
    backupDir: changed.length === 0 ? null : backupDir,
  };
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
