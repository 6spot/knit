/** `knit init`：把随 Knit 发布的模板生成到项目里。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `template` 相对模板目录，`target` 相对项目根；顺序就是输出的顺序。 */
export const TEMPLATES = [
  { template: "workflow.yaml", target: ".knit/workflow.yaml" },
  { template: "agents/implement.md", target: ".knit/agents/implement.md" },
  { template: "agents/review.md", target: ".knit/agents/review.md" },
  { template: "config.json", target: ".knit/config.json" },
  // 模板的文件名不带点：npm 打包时不收名叫 .gitignore 的文件。
  { template: "gitignore", target: ".knit/.gitignore" },
] as const;

// 编译后位于 next/dist/application/，往上两级是 next/。
const TEMPLATE_DIR = new URL("../../assets/templates/", import.meta.url);

/** 已有的文件不动，缺的按模板补上；返回的两个数组保持 TEMPLATES 的顺序。 */
export function initProject(root: string): { created: string[]; kept: string[] } {
  mkdirSync(join(root, ".knit", "standards"), { recursive: true });
  mkdirSync(join(root, ".knit", "tasks"), { recursive: true });
  const missing = TEMPLATES.filter((item) => !existsSync(join(root, item.target)));
  missing.forEach((item) => {
    mkdirSync(dirname(join(root, item.target)), { recursive: true });
    writeFileSync(join(root, item.target), readFileSync(new URL(item.template, TEMPLATE_DIR)));
  });
  return {
    created: missing.map((item) => item.target),
    kept: TEMPLATES.filter((item) => !missing.includes(item)).map((item) => item.target),
  };
}
