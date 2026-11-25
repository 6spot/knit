import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinAgents } from "../../dist/adapters/agents.js";
import { PiExecutionAdapter } from "../../dist/adapters/pi/execution.js";
import { closeTask, readyTask } from "../../dist/application/task-lifecycle.js";
import { createTask } from "../../dist/application/task-store.js";
import { taskWorktree } from "../../dist/application/worktree.js";
import { parseTaskDocument, renderTaskDocument } from "../../dist/domain/task.js";
import { cachedGitProject, commitAll, git } from "./git.mjs";

export const agents = {
  ...builtinAgents,
  pi: { ...builtinAgents.pi, createAdapter: () => new PiExecutionAdapter(fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))) },
};

const WORKFLOW = `version: 1
model: fake/model
stages:
  - id: implement
    name: 实现
    prompt: .knit/agents/implement.md
    tools: [read, write, exec]
  - id: review
    name: 审查
    prompt: .knit/agents/review.md
    tools: [read, write, exec]
    report:
      verdict: [pass, changes_requested, blocked]
    onVerdict:
      changes_requested: implement
      blocked: review
`;

const REQUIREMENT = [
  "## 目标与范围",
  "",
  "加一个问候语。",
  "",
  "## 完成条件",
  "",
  "### Requirement: 问候",
  "#### Scenario: 打招呼",
  "- WHEN 运行程序",
  "- THEN 输出问候语",
  "",
  "## 待澄清",
  "",
  "## 相关资料",
].join("\n");

/** 临时仓库：有实现、审查两个环节的流程和两份角色文件，都已提交；没有 .knit/config.json。 */
export function runProject(t) {
  return cachedGitProject(t, "run", (dir) => {
    const files = {
      ".knit/workflow.yaml": WORKFLOW,
      ".knit/agents/implement.md": "你是实现环节的执行者。\n",
      ".knit/agents/review.md": "你是审查环节的执行者。\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    commitAll(dir, "workflow");
  });
}

export const worktreeOf = (root, task) => taskWorktree(root, task.dir).path;
export const worktreeLine = (root, task) => {
  const worktree = taskWorktree(root, task.dir);
  return `Worktree: ${worktree.path}（${worktree.branch}）\n`;
};

/** 建一个任务，写上带一个场景的需求并确认；返回任务的 id 和目录（相对项目根）。 */
function makeReadyTask(dir, { verification = "independent", dependsOn = [] } = {}) {
  const created = createTask(dir, {
    title: "加问候语",
    slug: "task",
    verification,
    priority: "P2",
    parent: null,
    dependsOn,
  });
  assert.deepEqual(created.problems, []);
  const { id, file } = created.created;
  const { document } = parseTaskDocument(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, file), renderTaskDocument({ ...document, requirement: REQUIREMENT }));
  const ready = readyTask(dir, id);
  assert.equal(ready.kind, "ready", JSON.stringify(ready));
  return { id, dir: dirname(file) };
}

export { makeReadyTask as readyTask };

/** 建一个任务、确认，再记为完成（`paths` 是主会话登记的改动）；返回任务的 id 和目录。 */
export function doneTask(dir, paths = []) {
  const task = makeReadyTask(dir, { verification: "self" });
  const closed = closeTask(dir, task.id, { result: "做完了", paths });
  assert.deepEqual(closed, { kind: "done", title: "加问候语" });
  return task;
}

/** 让临时仓库里的提交不依赖机器上的 Git 配置：身份、签名和 hook 的位置都写在仓库自己的配置里。 */
export function gitIdentity(dir) {
  git(dir, "config", "user.name", "knit");
  git(dir, "config", "user.email", "knit@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", ".git/hooks");
}

// 测试源码只用单引号字面量；外层双引号同时适用于系统的 POSIX shell 和 cmd.exe。
export const nodeCommand = (source) => `"${process.execPath}" -e "${source}"`;
export const setupConfig = (root, commands) => writeFileSync(join(root, ".knit/config.json"), JSON.stringify({ worktree: { setup: commands } }));
