import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function locateProject(dir: string) {
  if (!existsSync(dir)) return { root: resolve(dir), initialized: false };
  const start = realpathSync(dir);
  for (let path = start; ; path = dirname(path)) {
    const knitDir = join(path, ".knit");
    if (statSync(knitDir, { throwIfNoEntry: false })?.isDirectory()) {
      const store = resolve(path, process.env.KNIT_HOME || join(homedir(), ".knit"));
      if (existsSync(join(knitDir, "worktrees")) && !existsSync(join(knitDir, "workflow.yaml")) &&
          (path === homedir() || (existsSync(store) && realpathSync(store) === knitDir))) break;
      return { root: path, initialized: true };
    }
    if (existsSync(join(path, ".git"))) return { root: path, initialized: false };
    if (dirname(path) === path) break;
  }
  return { root: start, initialized: false };
}

export function hostProjectRoot(...dirs: string[]): string | null {
  for (const dir of dirs) {
    const project = locateProject(dir);
    if (project.initialized) return project.root;
  }
  return null;
}
