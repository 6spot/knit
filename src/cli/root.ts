/**
 * CLI 入口的项目根（任务 k-1910551e4f50）。
 * 执行目录为关联 worktree 时，元数据库／run 产物／锁／pi-sessions 都在主检出；
 * 非 Git 目录按 normalizeRoot 原样返回（不改变既有行为）。
 */
import { resolveProjectStart } from "../application/worktree-routing.js";

export function cliMainRoot(dir: string): string {
  return resolveProjectStart(dir).mainRoot;
}
