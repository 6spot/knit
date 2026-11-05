/**
 * 归档任务的 Git 历史分类（DESIGN §12 跨机历史）。
 * 只读判定：身份／结束字段有效且 task.md 已被 Git 索引跟踪才算 git-history；
 * 本模块不创建绑定、不产生检查资格，也不写任务或 Git 状态。
 */
import type { TaskFrontmatter } from "../contracts/task-inputs.js";
import { gitSync } from "../infrastructure/process.js";

export type TaskHistoryKind = "git-history" | "local-only" | "invalid";

/** 归档条目的历史分类；problems 只描述该条目自身的判定问题。 */
export interface TaskHistoryInfo {
  kind: TaskHistoryKind;
  problems: string[];
}

/** list 级诊断：解析失败、重复来源、Git 跟踪状态不可判定。 */
export interface TaskListProblem {
  path: string;
  message: string;
}

const TASK_ID_PATTERN = /^k-[0-9a-f]{12}$/;

/**
 * 身份有效：id 符合 k- 模式，title／createdAt／branch 非空。
 * 结束有效：status=closed、stage=deliver、outcome 为 completed 或 cancelled。
 * 返回空数组表示字段有效；问题明细按字段列出，供列表与 JSON 展示。
 */
export function archivedHistoryProblems(frontmatter: TaskFrontmatter): string[] {
  const problems: string[] = [];
  if (typeof frontmatter.id !== "string" || !TASK_ID_PATTERN.test(frontmatter.id)) {
    problems.push(`身份无效: id 不符合 k- 模式（${String(frontmatter.id)}）`);
  }
  if (typeof frontmatter.title !== "string" || frontmatter.title.trim() === "") {
    problems.push("身份无效: title 为空");
  }
  if (typeof frontmatter.createdAt !== "string" || frontmatter.createdAt.trim() === "") {
    problems.push("身份无效: createdAt 为空");
  }
  if (frontmatter.branch === null || typeof frontmatter.branch !== "string" || frontmatter.branch.trim() === "") {
    problems.push("身份无效: branch 为空");
  }
  if (frontmatter.status !== "closed") {
    problems.push(`结束字段无效: status=${String(frontmatter.status)}（应为 closed）`);
  }
  if (frontmatter.stage !== "deliver") {
    problems.push(`结束字段无效: stage=${String(frontmatter.stage)}（应为 deliver）`);
  }
  if (frontmatter.outcome !== "completed" && frontmatter.outcome !== "cancelled") {
    problems.push(`结束字段无效: outcome=${String(frontmatter.outcome)}（应为 completed 或 cancelled）`);
  }
  return problems;
}

export interface GitTrackedFiles {
  /** false 表示 Git 查询失败或不可用，调用方不得据此宣称档案已入库。 */
  ok: boolean;
  tracked: Set<string>;
  problem: string | null;
}

/**
 * 批量一次查询 Git 索引中的路径（相对项目根）。
 * `git ls-files` 只读；失败时返回问题文本，由调用方按未验证处理。
 */
export function gitTrackedFiles(root: string, relativePaths: readonly string[]): GitTrackedFiles {
  if (relativePaths.length === 0) return { ok: true, tracked: new Set(), problem: null };
  const result = gitSync(["ls-files", "-z", "--", ...relativePaths], root);
  if (result.code !== 0) {
    const detail = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
    return {
      ok: false,
      tracked: new Set(),
      problem: detail === "" ? "Git 跟踪状态不可判定" : `Git 跟踪状态不可判定：${detail}`,
    };
  }
  return {
    ok: true,
    tracked: new Set(result.stdout.split("\0").filter((path) => path !== "")),
    problem: null,
  };
}
