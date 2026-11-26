import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/project-config.js";
import { executeRun } from "../dist/application/run-execute.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { readyTask as confirmTask } from "../dist/application/task-lifecycle.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { commitAll, git } from "./helpers/git.mjs";
import { agents, readyTask, runProject, worktreeOf } from "./helpers/run.mjs";

const workflowOf = (root) => parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")).workflow;
const prepare = (root, task, extra = {}) => prepareRun({ root, taskId: task.id, workflow: workflowOf(root), config: loadConfig(root).config, model: null, ...extra });
const message = (root, run) => readFileSync(join(root, run.dir, "message.md"), "utf8");
const files = (root, task) => ["task.md", "record.json"].map((file) => readFileSync(join(root, task.dir, file), "utf8"));
const finish = (root, task, run) => finishRun({ agents, root, taskId: task.id, runId: run.id, workflow: workflowOf(root), verdict: null, failure: null, sessionFile: null });
function nameMaterials(root, task, paths) {
  const path = join(root, task.dir, "task.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${paths.map((named) => `- \`${named}\` — 资料`).join("\n")}\n`);
  assert.equal(confirmTask(root, task.id).kind, "ready");
}


test("下个环节的仓库资料取 Worktree 的内容，仍给相对路径", async (t) => {
  const root = runProject(t);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/a.md"), "# 资料\n\n## 依据\n\n主检出的内容\n\n## 其它\n\n不该附上\n");
  commitAll(root, "material");
  const task = readyTask(root);
  nameMaterials(root, task, ["docs/a.md#依据", "docs/"]);
  const first = prepare(root, task).run;
  const script = join(process.env.KNIT_HOME, "script.json");
  const previous = process.env.KNIT_FAKE_PI;
  process.env.KNIT_FAKE_PI = script;
  t.after(() => {
    if (previous === undefined) delete process.env.KNIT_FAKE_PI;
    if (previous !== undefined) process.env.KNIT_FAKE_PI = previous;
  });
  writeFileSync(script, JSON.stringify({ writes: [{ path: "docs/a.md", content: "# 资料\n\n## 依据\n\nWorktree 改过的内容\n\n## 其它\n\n不该附上\n" }] }));
  assert.deepEqual(await executeRun({ root, taskId: task.id, runId: first.id, workflow: workflowOf(root), model: first.model, agents }), []);
  const review = prepare(root, task);
  assert.deepEqual(review.problems, []);
  assert.equal(review.run.stage.id, "review");
  assert.ok(message(root, review.run).includes('<material path="docs/a.md#依据">\n## 依据\n\nWorktree 改过的内容\n</material>'));
  assert.ok(message(root, review.run).includes('<material path="docs/">'));
  assert.equal(message(root, review.run).includes("不该附上"), false);
  assert.match(readFileSync(join(root, "docs/a.md"), "utf8"), /主检出的内容/);
});

[false, true].forEach((truncated) => test(`任务资料和报告来自主检出，给可读绝对路径（${truncated ? "超过上限" : "全文附上"}）`, (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  nameMaterials(root, task, [`${task.dir}/evidence.md#依据`, `${task.dir}/notes/`]);
  mkdirSync(join(root, task.dir, "notes"));
  writeFileSync(join(root, task.dir, "evidence.md"), "## 依据\n\n旧证据\n");
  writeFileSync(join(root, task.dir, "plan.md"), "旧计划\n");
  commitAll(root, "old task material");
  const first = prepare(root, task).run;
  assert.deepEqual(finish(root, task, first), []);
  writeFileSync(join(root, task.dir, "evidence.md"), "## 依据\n\n当前证据\n");
  writeFileSync(join(root, task.dir, "plan.md"), "当前计划\n");
  writeFileSync(join(root, first.dir, "report.md"), "实现报告\n");
  const review = prepare(root, task, truncated ? { config: { handoff: { fileBytes: 0, totalBytes: 0 } } } : {});
  assert.deepEqual(review.problems, []);
  const text = message(root, review.run);
  const paths = [...text.matchAll(/<(?:task|material|plan|previous-report)\b[^>]* path="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(paths, [join(root, task.dir, "task.md"), `${join(root, task.dir, "evidence.md")}#依据`, join(root, task.dir, "notes"), join(root, task.dir, "plan.md"), join(root, first.dir, "report.md")]);
  paths.forEach((path) => {
    assert.equal(isAbsolute(path), true);
    assert.equal(existsSync(path.split("#")[0]), true);
  });
  assert.match(text, /在任务的 Worktree 里工作/);
  assert.match(text, /任务目录和以前的报告在主检出.*只读.*不要改/);
  assert.ok(text.includes(join(root, task.dir)));
  assert.equal(text.includes("旧证据"), false);
  assert.equal(text.includes("旧计划"), false);
  ["当前证据", "当前计划", "实现报告"].forEach((content) => assert.equal(text.includes(content), !truncated));
  assert.equal(text.includes("按路径自己读"), truncated);
  assert.match(readFileSync(join(worktreeOf(root, task), task.dir, "plan.md"), "utf8"), /旧计划/);
}));

test("自定义审查环节的首次和续聊交接按本轮预算附上 Worktree 摘要", (t) => {
  const root = runProject(t);
  writeFileSync(join(root, "tracked.ts"), "original\n");
  commitAll(root, "tracked source");
  const task = readyTask(root);
  nameMaterials(root, task, ["tracked.ts"]);
  const workflow = parseWorkflow(readFileSync(join(root, ".knit/workflow.yaml"), "utf8")
    .replace("id: review", "id: inspect\n    resume: true").replace("blocked: review", "blocked: inspect")
    .replaceAll("tools: [read, write, exec]", "tools: []")).workflow;
  const dispatch = (limits) => {
    const result = prepare(root, task, { workflow, ...(limits && { config: { handoff: limits } }) });
    assert.deepEqual(result.problems, []);
    return result.run;
  };
  const implement = dispatch();
  assert.match(message(root, implement), /<material path="tracked.ts">\noriginal\n<\/material>/);
  assert.deepEqual(finish(root, task, implement), []);
  const clean = dispatch();
  assert.equal(clean.stage.id, "inspect");
  assert.doesNotMatch(message(root, clean), /<worktree-changes/);
  const end = (run) => assert.deepEqual(finishRun({ agents, root, taskId: task.id, runId: run.id, workflow,
    verdict: "blocked", failure: null, sessionFile: null, resumeId: "test-native-session" }), []);
  end(clean);
  const tree = clean.worktree.path;
  writeFileSync(join(tree, "new file.txt"), "untracked body\n");
  const checkMessages = (run, check) => {
    for (const file of ["message.md", "resume-message.md"]) {
      const text = readFileSync(join(root, run.dir, file), "utf8");
      const changes = text.match(/<worktree-changes base="HEAD">([\s\S]*?)<\/worktree-changes>/)?.[1];
      assert.ok(changes, file);
      assert.match(changes, /未跟踪文件：\nnew file\.txt/);
      assert.doesNotMatch(changes, /untracked body/);
      check(changes);
    }
  };
  const untracked = dispatch();
  checkMessages(untracked, (changes) => assert.doesNotMatch(changes, /diff --git|git diff HEAD/));
  end(untracked);
  writeFileSync(join(tree, "tracked.ts"), "staged\n");
  git(tree, "add", "tracked.ts");
  const small = dispatch();
  checkMessages(small, (changes) => {
    assert.match(changes, /tracked\.ts\s*\|/);
    assert.match(changes, /-original\n\+staged/);
  });
  end(small);
  for (const limits of [{ totalBytes: 100, fileBytes: 16000 }, { totalBytes: 64000, fileBytes: 80 }, undefined]) {
    if (!limits) writeFileSync(join(tree, "tracked.ts"), "x".repeat(9000));
    const review = dispatch(limits);
    checkMessages(review, (changes) => {
      assert.match(changes, /tracked\.ts\s*\|/);
      assert.match(changes, /git diff HEAD/);
      assert.doesNotMatch(changes, /diff --git|\+staged|xxx/);
    });
    end(review);
  }
});

test("别的任务目录里没提交的资料从主检出读，给绝对路径", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  mkdirSync(join(root, ".knit/tasks/11-20-parent"));
  writeFileSync(join(root, ".knit/tasks/11-20-parent/design.md"), "## 设计\n\n主任务的设计\n");
  nameMaterials(root, task, [".knit/tasks/11-20-parent/design.md#设计"]);
  const started = prepare(root, task);
  assert.deepEqual(started.problems, []);
  assert.ok(
    message(root, started.run).includes(
      `<material path="${join(root, ".knit/tasks/11-20-parent/design.md")}#设计">\n## 设计\n\n主任务的设计\n</material>`,
    ),
  );
});

test("未提交资料拒绝派发，撤回新 Worktree 和分支；提交之后从新 HEAD 派发", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/new.md"), "新资料\n");
  nameMaterials(root, task, ["docs/new.md"]);
  const before = files(root, task);
  const trees = git(root, "worktree", "list", "--porcelain");
  const refused = prepare(root, task);
  assert.equal(refused.run, null);
  assert.match(refused.problems.join("\n"), /docs\/new\.md.*还没有提交.*Worktree/);
  assert.deepEqual(files(root, task), before);
  assert.equal(existsSync(join(root, RUNS_DIR)), false);
  assert.equal(existsSync(worktreeOf(root, task)), false);
  assert.equal(git(root, "branch", "--list", `knit/${basename(task.dir)}`), "");
  assert.equal(git(root, "worktree", "list", "--porcelain"), trees);
  git(root, "add", "docs/new.md");
  git(root, "commit", "-qm", "commit material");
  const retried = prepare(root, task);
  assert.deepEqual(retried.problems, []);
  assert.equal(git(retried.run.worktree.path, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD"));
  assert.ok(message(root, retried.run).includes('<material path="docs/new.md">\n新资料\n</material>'));
});

test("资料在两处都没有时照旧拒绝，撤回新 Worktree 和分支", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  nameMaterials(root, task, ["docs/missing.md"]);
  const before = files(root, task);
  const refused = prepare(root, task);
  assert.deepEqual(refused.problems, ["相关资料里点名的文件不存在：docs/missing.md"]);
  assert.equal(existsSync(worktreeOf(root, task)), false);
  assert.equal(git(root, "branch", "--list", `knit/${basename(task.dir)}`), "");
  assert.equal(existsSync(join(root, RUNS_DIR)), false);
  assert.deepEqual(files(root, task), before);
});

test("交接被拒绝时保留已有 Worktree 的改动、分支和执行记录", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const first = prepare(root, task).run;
  assert.deepEqual(finish(root, task, first), []);
  writeFileSync(join(first.worktree.path, "keep.txt"), "已有工作\n");
  nameMaterials(root, task, ["docs/missing.md"]);
  const before = files(root, task);
  const trees = git(root, "worktree", "list", "--porcelain");
  assert.equal(prepare(root, task).run, null);
  assert.equal(readFileSync(join(first.worktree.path, "keep.txt"), "utf8"), "已有工作\n");
  assert.equal(git(root, "worktree", "list", "--porcelain"), trees);
  assert.deepEqual(files(root, task), before);
});

test("为已有分支重建 Worktree 后交接被拒绝，只撤回本次新建的目录", (t) => {
  const root = runProject(t);
  const task = readyTask(root);
  const branch = `knit/${basename(task.dir)}`;
  git(root, "branch", branch);
  nameMaterials(root, task, ["docs/missing.md"]);
  const head = git(root, "rev-parse", branch);
  assert.equal(prepare(root, task).run, null);
  assert.equal(existsSync(worktreeOf(root, task)), false);
  assert.equal(git(root, "rev-parse", branch), head);
  assert.equal(existsSync(join(root, RUNS_DIR)), false);
});
