/** 读出任务点名的资料：整个文件、文件里的一节，或一个目录（目录只给路径）。 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sectionOf } from "../domain/markdown.js";
import type { TaskReference } from "../domain/task-references.js";
import { projectRelative } from "../infrastructure/paths.js";

export interface TaskMaterial {
  readonly reference: TaskReference;
  readonly kind: "file" | "section" | "directory";
  /** 目录没有内容，是 null。 */
  readonly text: string | null;
}

/** 顺序和 references 相同；读不出来的不在 materials 里，原因在 problems 里，不影响其它资料。 */
export function readMaterials(
  root: string,
  references: readonly TaskReference[],
): { materials: TaskMaterial[]; problems: string[] } {
  const results = references.map((reference) => readMaterial(root, reference));
  return {
    materials: results.flatMap((result) => (typeof result === "string" ? [] : [result])),
    problems: results.flatMap((result) => (typeof result === "string" ? [result] : [])),
  };
}

/** 读出来的资料，或者读不出来的原因。 */
function readMaterial(root: string, reference: TaskReference): TaskMaterial | string {
  const path = projectRelative(reference.path);
  if (path === null) return `相关资料里的路径要写项目内的相对路径：${reference.path}`;
  const stats = statSync(join(root, path), { throwIfNoEntry: false });
  if (stats === undefined) return `相关资料里点名的文件不存在：${reference.path}`;
  if (stats.isDirectory()) return { reference, kind: "directory", text: null };
  const text = readFileSync(join(root, path), "utf8");
  if (reference.anchor === null) return { reference, kind: "file", text };
  const section = sectionOf(text, reference.anchor);
  return section === null
    ? `${reference.path} 里没有标题「${reference.anchor}」`
    : { reference, kind: "section", text: section };
}
