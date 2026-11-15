import { resolve } from "node:path";
import { gitSync } from "../infrastructure/process.js";

/** 项目根：目录在 Git 仓库里时是仓库的顶层目录，否则是这个目录本身。 */
export function projectRoot(dir: string): string {
  const top = gitSync(["rev-parse", "--show-toplevel"], dir);
  return top.code === 0 ? top.stdout.trim() : resolve(dir);
}
