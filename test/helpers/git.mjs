import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { project } from "./cli.mjs";

const SYSTEM_TMPDIR = tmpdir();
const templates = new Map();
const createdTemplates = [];
process.once("exit", () => {
  createdTemplates.forEach((template) => rmSync(template, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

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

/** 每进程懒初始化一次只读模板仓库并复制到独立临时目录，避免用例间重复 `git init`。 */
export function cachedGitProject(t, key, prepare) {
  if (!templates.has(key)) {
    const template = mkdtempSync(join(SYSTEM_TMPDIR, "knit-git-template-"));
    createdTemplates.push(template);
    mkdirSync(join(template, ".knit"));
    git(template, "init", "-q");
    // 提交之后 Git 会在后台整理仓库，测试结束删目录时它可能还在写，删除就会失败。
    git(template, "config", "maintenance.auto", "false");
    git(template, "config", "user.name", "knit");
    git(template, "config", "user.email", "knit@example.invalid");
    git(template, "config", "commit.gpgsign", "false");
    git(template, "config", "core.hooksPath", ".git/hooks");
    commitAll(template, "init");
    if (prepare !== undefined) prepare(template);
    templates.set(key, template);
  }
  const dir = project(t);
  cpSync(templates.get(key), dir, { recursive: true });
  return dir;
}

/** 在临时目录里建一个带 `.knit/` 的项目，`git init` 并做第一次提交；测试结束时删除。 */
export function gitProject(t) {
  return cachedGitProject(t, "base");
}
