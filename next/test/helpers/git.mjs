import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { project } from "./cli.mjs";

/** 在 `dir` 里运行 git，失败就报错；返回去掉首尾空白的输出。 */
export function git(dir, ...args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}：${result.stderr}`);
  return result.stdout.trim();
}

/** 把工作区里的改动全部提交；不依赖机器上的 Git 配置。 */
export function commitAll(dir, message) {
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.name=knit",
    "-c",
    "user.email=knit@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );
}

/** 在临时目录里建一个带 `.knit/` 的项目，`git init` 并做第一次提交；测试结束时删除。 */
export function gitProject(t) {
  const dir = project(t);
  git(dir, "init", "-q");
  commitAll(dir, "init");
  return dir;
}
