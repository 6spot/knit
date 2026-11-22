import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinAgents } from "../../dist/adapters/agents.js";
import { PiExecutionAdapter } from "../../dist/adapters/pi/execution.js";
import { taskWorktree } from "../../dist/application/worktree.js";
import { parseTaskDocument, renderTaskDocument } from "../../dist/domain/task-document.js";
import { knit } from "./cli.mjs";
import { commitAll, gitProject } from "./git.mjs";

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
  const dir = gitProject(t);
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
  return dir;
}

export const worktreeOf = (root, task) => taskWorktree(root, task.dir).path;
export const worktreeLine = (root, task) => {
  const worktree = taskWorktree(root, task.dir);
  return `Worktree: ${worktree.path}（${worktree.branch}）\n`;
};

/** 建一个任务，写上带一个场景的需求并确认；返回任务的 id 和目录（相对项目根）。 */
export function readyTask(dir, { verification = "independent", dependsOn = [] } = {}) {
  const created = knit(
    dir,
    "task",
    "new",
    "--title",
    "加问候语",
    "--verification",
    verification,
    ...(dependsOn.length > 0 ? ["--depends-on", ...dependsOn] : []),
  );
  assert.equal(created.code, 0, created.stderr);
  const [first, file] = created.stdout.split("\n");
  const id = first.replace("已创建 ", "");
  const { document } = parseTaskDocument(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, file), renderTaskDocument({ ...document, requirement: REQUIREMENT }));
  const ready = knit(dir, "task", "ready", id);
  assert.equal(ready.code, 0, ready.stderr);
  return { id, dir: dirname(file) };
}
