/** 读出任务点名的资料：整个文件、文件里的一节，或一个目录（目录只给路径）。 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sectionOf, type TaskReference } from "../domain/task.js";
import { projectRelative } from "../infrastructure/paths.js";
import { TASKS_DIR } from "./task-store.js";

export interface TaskMaterial {
  readonly reference: TaskReference;
  readonly kind: "file" | "section" | "directory";
  /** 目录没有内容，是 null。 */
  readonly text: string | null;
}

interface HandoffLocation {
  readonly worktree: string;
}

/** 顺序和 references 相同；交接时仓库资料读 Worktree，任务目录（所有任务的）里的资料读主检出并给绝对路径。 */
export function readMaterials(
  root: string,
  references: readonly TaskReference[],
  handoff?: HandoffLocation,
): { materials: TaskMaterial[]; problems: string[] } {
  const results = references.map((reference) => readMaterial(root, reference, handoff));
  return {
    materials: results.flatMap((result) => (typeof result === "string" ? [] : [result])),
    problems: results.flatMap((result) => (typeof result === "string" ? [result] : [])),
  };
}

/** 读出来的资料，或者读不出来的原因。 */
function readMaterial(root: string, reference: TaskReference, handoff?: HandoffLocation): TaskMaterial | string {
  const path = projectRelative(reference.path);
  if (path === null) return `相关资料里的路径要写项目内的相对路径：${reference.path}`;
  // 任务目录交付之前没有入库，别的任务（例如主任务）的目录也一样，Worktree 里没有或者是旧的。
  const taskMaterial = handoff !== undefined && (path === TASKS_DIR || path.startsWith(`${TASKS_DIR}/`));
  const source = handoff !== undefined && !taskMaterial ? handoff.worktree : root;
  const stats = statSync(join(source, path), { throwIfNoEntry: false });
  if (stats === undefined) {
    return `相关资料里点名的文件不存在：${reference.path}${
      handoff !== undefined && !taskMaterial && existsSync(join(root, path))
        ? "；它还没有提交，所以任务的 Worktree 里没有。"
        : ""
    }`;
  }
  const supplied = taskMaterial ? { ...reference, path: resolve(root, path) } : reference;
  if (stats.isDirectory()) return { reference: supplied, kind: "directory", text: null };
  const text = readFileSync(join(source, path), "utf8");
  if (reference.anchor === null) return { reference: supplied, kind: "file", text };
  const section = sectionOf(text, reference.anchor);
  return section === null
    ? `${reference.path} 里没有标题「${reference.anchor}」`
    : { reference: supplied, kind: "section", text: section };
}
