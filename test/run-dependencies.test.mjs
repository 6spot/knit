import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { archiveDirOf } from "../dist/application/task-store.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { commitAll, git } from "./helpers/git.mjs";
import { agents, readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

const workflowOf = (root) => parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
const prepare = (root, task) => prepareRun({ root, taskId: task.id, workflow: workflowOf(root), config: loadConfig(root).config, model: null });
const taskFiles = (root, task) => ["task.md", "record.json"].map((file) => readFileSync(join(root, task.dir, file), "utf8"));
const runDirs = (root) => existsSync(join(root, RUNS_DIR)) ? readdirSync(join(root, RUNS_DIR)) : [];

function refusedWithoutChanges(root, task, expected) {
  const before = [taskFiles(root, task), runDirs(root), git(root, "worktree", "list", "--porcelain")];
  const refused = prepare(root, task);
  assert.equal(refused.run, null);
  assert.equal(refused.problems.length, 1);
  assert.match(refused.problems[0], expected);
  assert.deepEqual([taskFiles(root, task), runDirs(root), git(root, "worktree", "list", "--porcelain")], before);
  assert.equal(existsSync(worktreeOf(root, task)), false);
  assert.equal(git(root, "branch", "--list", `knit/${basename(task.dir)}`), "");
  assert.deepEqual(JSON.parse(taskFiles(root, task)[1]).runs, []);
  return refused.problems[0];
}

["draft", "ready", "active", "done"].forEach((status) => test(`依赖 ${status} 还没有交付，建 Worktree 之前拒绝`, (t) => {
  const root = runProject(t);
  const dependency = readyTask(root, { verification: "self" });
  const task = readyTask(root, { dependsOn: [dependency.id] });
  if (status === "draft") {
    const file = join(root, dependency.dir, "task.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("status: ready", "status: draft"));
  }
  if (status === "active") assert.deepEqual(prepare(root, dependency).problems, []);
  if (status === "done") {
    const closed = knit(root, "task", "close", dependency.id, "--result", "还没有交付");
    assert.equal(closed.code, 0, closed.stderr);
  }
  const problem = refusedWithoutChanges(root, task, /依赖的任务还没有交付/);
  assert.ok(problem.includes(`${dependency.id}（${status}）`), problem);
  assert.match(problem, /交付并合并之后再派发/);
}));

test("取消的归档依赖仍拒绝，提示沿用原文", (t) => {
  const root = runProject(t);
  const dependency = readyTask(root);
  const task = readyTask(root, { dependsOn: [dependency.id] });
  const cancelled = knit(root, "task", "cancel", dependency.id, "--reason", "不再需要");
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(refusedWithoutChanges(root, task, /依赖的任务还没有完成/), `依赖的任务还没有完成：${dependency.id}（cancelled）`);
});

test("依赖在主检出和任务分支都找不到，提示不存在或已交付但未合并", (t) => {
  const root = runProject(t);
  const dependency = readyTask(root);
  const task = readyTask(root, { dependsOn: [dependency.id] });
  rmSync(join(root, dependency.dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const problem = refusedWithoutChanges(root, task, /主检出里找不到/);
  assert.ok(problem.includes(dependency.id), problem);
  assert.match(problem, /可能.*已经.*交付.*还没有合并/);
  assert.match(problem, /不存在/);
});

test("缺失依赖按任务文档的身份定位分支，不依赖 YAML 排版或 Git grep 配置", (t) => {
  const root = runProject(t);
  const dependency = readyTask(root);
  const task = readyTask(root, { dependsOn: [dependency.id] });
  const unrelated = readyTask(root);
  const dependencyFile = join(root, dependency.dir, "task.md");
  writeFileSync(dependencyFile, readFileSync(dependencyFile, "utf8").replace(`id: ${dependency.id}`, `id: "${dependency.id}" # 合法的 YAML`));
  const unrelatedFile = join(root, unrelated.dir, "task.md");
  writeFileSync(unrelatedFile, `${readFileSync(unrelatedFile, "utf8")}\n示例：\n\n\`\`\`yaml\nid: ${dependency.id}\n\`\`\`\n`);
  commitAll(root, "task documents with quoted identity and an example");
  const branch = `knit/${basename(dependency.dir)}`;
  const unrelatedBranch = `knit/${basename(unrelated.dir)}`;
  git(root, "branch", branch);
  git(root, "branch", unrelatedBranch);
  rmSync(join(root, dependency.dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const problem = refusedWithoutChanges(root, task, /主检出里找不到/);
  assert.ok(problem.includes(`任务分支：${branch}；在主检出里运行 git merge ${branch}`), problem);
  assert.equal(problem.includes(`任务分支：${unrelatedBranch}；`), false, problem);
  git(root, "config", "grep.patternType", "fixed");
  assert.equal(refusedWithoutChanges(root, task, /主检出里找不到/), problem);
});

[false, true].forEach((ignored) => test(`依赖真实交付但未合并时拒绝，合并后 Worktree 拿到代码（任务目录${ignored ? "被忽略" : "未入库"}）`, (t) => {
  const root = runProject(t);
  writeFileSync(join(root, ".gitignore"), `.knit/.runtime/\n${ignored ? ".knit/tasks/\n" : ""}`);
  commitAll(root, "ignore runtime and optional task files");
  const dependency = readyTask(root, { verification: "self" });
  const task = readyTask(root, { dependsOn: [dependency.id] });
  const dispatched = prepare(root, dependency);
  assert.deepEqual(dispatched.problems, []);
  const worktree = dispatched.run.worktree;
  writeFileSync(join(worktree.path, "dependency.txt"), "delivered dependency code\n");
  assert.deepEqual(finishRun({ agents, root, taskId: dependency.id, runId: dispatched.run.id, workflow: workflowOf(root), verdict: null, failure: null, sessionFile: null }), []);
  const closed = knit(root, "task", "close", dependency.id, "--result", "实现已验证");
  assert.equal(closed.code, 0, closed.stderr);
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: dependency\n");
  const delivered = knit(root, "deliver", dependency.id, "--authorization", "user:delivery", "--message-file", message);
  assert.equal(delivered.code, 0, delivered.stderr);
  const archive = archiveDirOf(dependency);
  assert.equal(existsSync(join(root, dependency.dir)), false);
  assert.equal(existsSync(join(root, archive)), ignored);
  assert.match(readFileSync(join(ignored ? root : worktree.path, archive, "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(existsSync(join(root, "dependency.txt")), false);
  // 其它任务分支可以带着这份归档；任务身份要对应它自己的目录名和分支。
  git(root, "branch", "knit/unrelated", worktree.branch);
  const problem = refusedWithoutChanges(root, task, /还没有合并/);
  assert.ok(problem.includes(dependency.id), problem);
  assert.ok(problem.includes(`git merge ${worktree.branch}`), problem);
  assert.equal(problem.includes("knit/unrelated"), false);
  if (!ignored) {
    assert.match(problem, /可能.*已经.*交付.*还没有合并/);
    assert.match(problem, /不存在/);
  }

  // 检查的是当前分支的 HEAD，并且普通的非快进合并也算已合并。
  git(root, "checkout", "-qb", "dependency-target");
  writeFileSync(join(root, "target.txt"), "current branch advanced\n");
  git(root, "add", "target.txt");
  git(root, "commit", "-qm", "advance target", "--only", "--", "target.txt");
  git(root, "merge", "--no-edit", worktree.branch);
  assert.equal(git(root, "log", "-1", "--format=%P").split(" ").length, 2);
  const accepted = prepare(root, task);
  assert.deepEqual(accepted.problems, []);
  assert.equal(readFileSync(join(accepted.run.worktree.path, "dependency.txt"), "utf8"), "delivered dependency code\n");
  assert.equal(readFileSync(join(accepted.run.worktree.path, "target.txt"), "utf8"), "current branch advanced\n");
  assert.equal(JSON.parse(taskFiles(root, task)[1]).runs.length, 1);

  git(root, "worktree", "remove", worktree.path);
  git(root, "branch", "-d", worktree.branch);
  const later = readyTask(root, { dependsOn: [dependency.id] });
  const withoutBranch = prepare(root, later);
  assert.deepEqual(withoutBranch.problems, []);
  assert.equal(readFileSync(join(withoutBranch.run.worktree.path, "dependency.txt"), "utf8"), "delivered dependency code\n");
}));

test("主会话直接完成不检查依赖，直接交付且归档的依赖可以派发", (t) => {
  const root = runProject(t);
  writeFileSync(join(root, ".gitignore"), ".knit/.runtime/\n");
  commitAll(root, "ignore runtime");
  const unfinished = readyTask(root);
  const dependency = readyTask(root, { verification: "self", dependsOn: [unfinished.id] });
  const task = readyTask(root, { dependsOn: [dependency.id] });
  writeFileSync(join(root, "dependency.txt"), "main session code\n");
  const closed = knit(root, "task", "close", dependency.id, "--result", "主会话完成", "--paths", "dependency.txt");
  assert.equal(closed.code, 0, closed.stderr);
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: main session dependency\n");
  const delivered = knit(root, "deliver", dependency.id, "--authorization", "user:delivery", "--message-file", message);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.match(readFileSync(join(root, archiveDirOf(dependency), "task.md"), "utf8"), /^status: delivered$/m);
  assert.equal(git(root, "branch", "--list", `knit/${basename(dependency.dir)}`), "");
  const accepted = prepare(root, task);
  assert.deepEqual(accepted.problems, []);
  assert.equal(readFileSync(join(accepted.run.worktree.path, "dependency.txt"), "utf8"), "main session code\n");
});
