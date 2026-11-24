import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { deliverTask, previewDelivery } from "../dist/application/delivery.js";
import { cancelTask, closeTask } from "../dist/application/task-lifecycle.js";
import { createTask, findTask, scanTasks } from "../dist/application/task-store.js";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseTaskDocument } from "../dist/domain/task.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";
import { agents, doneTask, readyTask, runProject, worktreeLine, worktreeOf } from "./helpers/run.mjs";

// 在 macOS 上直接使用工具链的 Git 来创建和检查交付夹具。
if (process.platform === "darwin") process.env.PATH = `${git(process.cwd(), "--exec-path")}:${process.env.PATH}`;

const authorization = "user:1a2b3c4d";
const now = new Date();
const archived = (task) =>
  `.knit/tasks/archive/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(task.dir)}`;
const filesOf = (dir, taskDir) => ["task.md", "record.json"].map((name) => readFileSync(join(dir, taskDir, name), "utf8"));

function assertMainDelivery(dir, task, autoMerge, messageFile) {
  const options = { authorization: ` ${authorization} `, messageFile };
  if (autoMerge) {
    const result = deliverTask(dir, task.id, options);
    assert.equal(result.kind, "delivered");
    assert.equal(result.archiveDir, archived(task));
    assert.equal(result.integration, null);
    assert.deepEqual(result.commit, messageFile ? { kind: "committed", summary: git(dir, "log", "-1", "--format=%h %s"), extra: [], missing: [] } : null);
    return;
  }
  const result = knit(dir, "deliver", task.id, "--authorization", options.authorization, ...(messageFile ? ["--message-file", messageFile] : []));
  const summary = messageFile ? `${git(dir, "rev-parse", "--short", "HEAD")} feat: 加问候语` : "这个项目不在 Git 仓库里，没有提交";
  assert.deepEqual(result, { code: 0, stdout: `已交付 ${task.id}\n归档: ${archived(task)}\n提交: ${summary}\n`, stderr: "" });
}

[false, true].forEach((autoMerge) => test(`不在 Git 仓库里交付一个完成的任务（autoMerge=${autoMerge}）`, (t) => {
  const dir = project(t);
  writeFileSync(join(dir, ".knit/config.json"), JSON.stringify({ worktree: { autoMerge } }));
  const task = doneTask(dir, ["src/a.ts"]);
  const [taskBefore, recordBefore] = filesOf(dir, task.dir);

  assertMainDelivery(dir, task, autoMerge);
  assert.equal(existsSync(join(dir, task.dir)), false);
  const [taskAfter, recordAfter] = filesOf(dir, archived(task));
  const before = parseTaskDocument(taskBefore).document;
  assert.deepEqual(parseTaskDocument(taskAfter).document, {
    ...before,
    frontmatter: { ...before.frontmatter, status: "delivered" },
  });
  assert.deepEqual(JSON.parse(recordAfter), { ...JSON.parse(recordBefore), authorization: "user:1a2b3c4d" });
  assert.deepEqual(scanTasks(dir).map((stored) => [stored.id, stored.archived, stored.document.frontmatter.status]), [[task.id, true, "delivered"]]);
}));

test("不能交付时什么都不变", (t) => {
  const dir = project(t);
  const ready = readyTask(dir);
  const done = doneTask(dir);
  const before = [...filesOf(dir, ready.dir), ...filesOf(dir, done.dir)];

  assert.deepEqual(deliverTask(dir, ready.id, { authorization }), { kind: "refused",
    problems: [`任务 ${ready.id} 还没有完成（ready）；完成之后再交付：knit task close ${ready.id}`] });
  for (const options of [{}, { authorization: "  " }]) {
    assert.deepEqual(deliverTask(dir, done.id, options), { kind: "refused", problems: ["交付要有用户的授权：加 --authorization <引用>，写明用户是在哪条消息里同意的"] });
  }
  assert.deepEqual([...filesOf(dir, ready.dir), ...filesOf(dir, done.dir)], before);
});

/** 派一次执行，让 `change` 改工作区，再按 `verdict` 记为结束。 */
function run(dir, task, verdict, change) {
  const workflow = parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
  const prepared = prepareRun({ root: dir, taskId: task.id, workflow, config: loadConfig(dir).config, model: null });
  assert.deepEqual(prepared.problems, []);
  change(worktreeOf(dir, task));
  const problems = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: prepared.run.id,
    workflow,
    verdict,
    failure: null,
    sessionFile: null,
  });
  assert.deepEqual(problems, []);
}

test("在 Git 仓库里列出要提交的文件和提示", (t) => {
  const dir = runProject(t);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "src/gone.ts"), "gone\n");
  const task = readyTask(dir);
  const child = createTask(dir, { title: "子任务", slug: "child", verification: "self", priority: "P2", parent: task.id, dependsOn: [] });
  assert.deepEqual(child.problems, []);
  const childId = child.created.id;
  commitAll(dir, "tasks");

  run(dir, task, null, (cwd) => writeFileSync(join(cwd, "src/a.ts"), "a2\n"));
  run(dir, task, "pass", (cwd) => writeFileSync(join(cwd, "src/b.ts"), "b\n"));
  assert.equal(closeTask(dir, task.id, { result: "做完了\n\n都验证过", paths: ["src/gone.ts"] }).kind, "done");
  writeFileSync(join(worktreeOf(dir, task), "other.txt"), "other\n");
  // 主检出中的同名文件和无关改动不能影响预览。
  writeFileSync(join(dir, "src/b.ts"), "main only\n");
  writeFileSync(join(dir, "main-only.txt"), "main only\n");
  const message = join(dir, ".knit/.runtime/message.txt");
  writeFileSync(message, "\nfeat: 加问候语\n\n说明一行\n\n");
  const before = [git(dir, "status", "--porcelain"), git(worktreeOf(dir, task), "status", "--porcelain"), ...filesOf(dir, task.dir)];

  const preview = knit(dir, "deliver", task.id, "--preview", "--message-file", message);

  assert.deepEqual(preview, {
    code: 0,
    stdout: [
      `任务: 加问候语（${task.id}）`,
      `归档: ${task.dir} → ${join(worktreeOf(dir, task), archived(task))}`,
      worktreeLine(dir, task).trimEnd(),
      "提交在任务分支上，不会合并进主检出的分支",
      "提交的文件:",
      "  src/a.ts",
      "  src/b.ts（审查改过）",
      `  ${task.dir}/（整个目录，移到归档的位置）`,
      "提示:",
      "  - 记录里有 1 个路径现在没有改动，不会被提交：src/gone.ts",
      "  - 工作区里还有 1 处不属于这个任务的改动，不会被提交",
      `  - 子任务还没有结束：${childId}（draft）`,
      "结果:",
      "  做完了",
      "",
      "  都验证过",
      "提交文案:",
      "  feat: 加问候语",
      "",
      "  说明一行",
      "",
    ].join("\n"),
    stderr: "",
  });
  assert.deepEqual([git(dir, "status", "--porcelain"), git(worktreeOf(dir, task), "status", "--porcelain"), ...filesOf(dir, task.dir)], before);

  assert.deepEqual(deliverTask(dir, task.id, { preview: true, messageFile: join(dir, "nope.txt") }), {
    kind: "refused", problems: [`读不到提交文案：${join(dir, "nope.txt")}`],
  });
  const bare = deliverTask(dir, task.id, { preview: true });
  assert.equal(bare.kind, "preview");
  assert.equal(bare.message, undefined);
});

test("审查通过之后又改过的文件标出来", (t) => {
  const dir = runProject(t);
  mkdirSync(join(dir, "src"));
  const task = readyTask(dir);
  commitAll(dir, "task");
  const write = (path, text, cwd = worktreeOf(dir, task)) => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const files = () => previewDelivery(dir, findTask(dir, task.id)).commit.files;
  run(dir, task, null, (cwd) => ["src/a.ts", "src/b.ts"].forEach((path) => write(path, "1\n", cwd)));
  run(dir, task, "pass", (cwd) => write("src/c.ts", "1\n", cwd));
  const reviewId = JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1).id;
  write("src/a.ts", "2\n");
  write("src/c.ts", "2\n");
  write("src/d.ts", "1\n");
  assert.equal(closeTask(dir, task.id, { result: "做完了", paths: ["src/d.ts"] }).kind, "done");

  assert.deepEqual(files(), [
    { path: "src/a.ts", reviewed: false, changedAfterReview: true },
    { path: "src/b.ts", reviewed: false, changedAfterReview: false },
    { path: "src/c.ts", reviewed: true, changedAfterReview: true },
    { path: "src/d.ts", reviewed: false, changedAfterReview: true },
  ]);
  write("src/a.ts", "1\n");
  assert.deepEqual(files().filter((file) => file.changedAfterReview).map((file) => file.path), ["src/c.ts", "src/d.ts"]);
  rmSync(join(dir, ".knit/.runtime/runs", reviewId, "after.json"));
  assert.equal(files().some((file) => file.changedAfterReview), false);
  assert.deepEqual(files().filter((file) => file.reviewed).map((file) => file.path), ["src/c.ts"]);
});

test("最后一次审查没有通过时不标", (t) => {
  const dir = runProject(t);
  mkdirSync(join(dir, "src"));
  const task = readyTask(dir);
  commitAll(dir, "task");

  run(dir, task, null, (cwd) => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "1\n");
  });
  run(dir, task, "blocked", () => {});
  writeFileSync(join(worktreeOf(dir, task), "src/a.ts"), "2\n");
  assert.equal(closeTask(dir, task.id, { result: "做完了", reason: "用户要求直接完成", paths: [] }).kind, "done");

  assert.deepEqual(previewDelivery(dir, findTask(dir, task.id)).commit.files, [
    { path: "src/a.ts", reviewed: false, changedAfterReview: false },
  ]);
});

test("不在 Git 仓库里只说明归档", (t) => {
  const dir = project(t);
  const task = doneTask(dir, ["src/a.ts"]);

  const preview = deliverTask(dir, task.id, { preview: true });
  assert.equal(preview.kind, "preview");
  assert.equal(preview.preview.commit, null);
  assert.equal(preview.preview.archiveDir, archived(task));
  assert.deepEqual(deliverTask(dir, task.id, { preview: true, messageFile: join(dir, "nope.txt") }), preview);
  assert.equal(existsSync(join(dir, task.dir, "task.md")), true);
  assert.equal(existsSync(join(dir, archived(task))), false);
});

test("不能交付的任务被拒绝", (t) => {
  const dir = gitProject(t);
  const ready = readyTask(dir);
  const cancelled = readyTask(dir);
  assert.equal(cancelTask(dir, cancelled.id, { reason: "不做了" }).kind, "cancelled");
  assert.deepEqual(deliverTask(dir, ready.id, { preview: true }), { kind: "refused", problems: [`任务 ${ready.id} 还没有完成（ready）；完成之后再交付：knit task close ${ready.id}`] });
  assert.deepEqual(deliverTask(dir, cancelled.id, { preview: true }), { kind: "refused", problems: [`任务 ${cancelled.id} 已经结束（cancelled），不能交付`] });
});

/** 文案写在项目外面，不算工作区里的改动。 */
function messageFile(t, text) {
  const dir = project(t);
  writeFileSync(join(dir, "message.txt"), text);
  return join(dir, "message.txt");
}

[false, true].forEach((autoMerge) => test(`没有 Worktree 时只在当前分支提交这个任务的文件（autoMerge=${autoMerge}）`, (t) => {
  const dir = gitProject(t);
  writeFileSync(join(dir, ".knit/config.json"), JSON.stringify({ worktree: { autoMerge } }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "src/c.ts"), "c\n");
  const task = doneTask(dir, ["src/a.ts", "src/b.ts"]);
  commitAll(dir, "task");
  writeFileSync(join(dir, "src/a.ts"), "a2\n");
  writeFileSync(join(dir, "src/b.ts"), "b\n");
  writeFileSync(join(dir, "src/c.ts"), "c2\n");
  git(dir, "add", "src/c.ts");
  writeFileSync(join(dir, "other.txt"), "other\n");
  const head = git(dir, "rev-parse", "HEAD");

  const message = messageFile(t, "\nfeat: 加问候语\n\n# 说明一行\n\n");
  assertMainDelivery(dir, task, autoMerge, message);
  assert.equal(git(dir, "rev-parse", "HEAD~1"), head);
  assert.deepEqual(git(dir, "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort(), [
    `A\t${archived(task)}/record.json`,
    `A\t${archived(task)}/task.md`,
    "A\tsrc/b.ts",
    `D\t${task.dir}/record.json`,
    `D\t${task.dir}/task.md`,
    "M\tsrc/a.ts",
  ]);
  assert.match(git(dir, "show", `HEAD:${archived(task)}/task.md`), /^status: delivered$/m);
  assert.equal(git(dir, "log", "-1", "--format=%B"), `feat: 加问候语\n\n# 说明一行\n\nKnit-Task: ${task.id}`);
  assert.equal(git(dir, "status", "--porcelain"), "M  src/c.ts\n?? other.txt");
}));

test("用 git mv 移动过的文件", (t) => {
  const dir = gitProject(t);
  mkdirSync(join(dir, "d"));
  writeFileSync(join(dir, "d/a.md"), "a\n");
  const task = readyTask(dir, { verification: "self" });
  commitAll(dir, "task");
  mkdirSync(join(dir, "e"));
  git(dir, "mv", "d/a.md", "e/a.md");
  assert.equal(closeTask(dir, task.id, { result: "做完了", paths: ["d/a.md", "e/a.md"] }).kind, "done");

  const delivered = deliverTask(dir, task.id, { authorization, messageFile: messageFile(t, "feat: 移动文件\n") });

  assert.equal(delivered.kind, "delivered");
  assert.deepEqual(git(dir, "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort(), [
    `A\t${archived(task)}/record.json`,
    `A\t${archived(task)}/task.md`,
    "A\te/a.md",
    `D\t${task.dir}/record.json`,
    `D\t${task.dir}/task.md`,
    "D\td/a.md",
  ]);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("用 git rm 删除的文件", (t) => {
  const dir = gitProject(t);
  mkdirSync(join(dir, "d"));
  writeFileSync(join(dir, "d/a.md"), "a\n");
  const task = readyTask(dir, { verification: "self" });
  commitAll(dir, "task");
  git(dir, "rm", "d/a.md");
  assert.equal(closeTask(dir, task.id, { result: "做完了", paths: ["d/a.md"] }).kind, "done");

  const delivered = deliverTask(dir, task.id, { authorization, messageFile: messageFile(t, "feat: 删除文件\n") });

  assert.equal(delivered.kind, "delivered");
  assert.equal(
    git(dir, "show", "--name-only", "--no-renames", "--format=", "HEAD")
      .split("\n")
      .includes("d/a.md"),
    true,
  );
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("别的已经暂存的文件不受影响", (t) => {
  const dir = gitProject(t);
  mkdirSync(join(dir, "d"));
  writeFileSync(join(dir, "d/a.md"), "a\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  const task = readyTask(dir, { verification: "self" });
  commitAll(dir, "task");
  mkdirSync(join(dir, "e"));
  git(dir, "mv", "d/a.md", "e/a.md");
  writeFileSync(join(dir, "other.txt"), "other2\n");
  git(dir, "add", "other.txt");
  assert.equal(closeTask(dir, task.id, { result: "做完了", paths: ["d/a.md", "e/a.md"] }).kind, "done");

  const delivered = deliverTask(dir, task.id, { authorization, messageFile: messageFile(t, "feat: 移动文件\n") });

  assert.equal(delivered.kind, "delivered");
  assert.equal(
    git(dir, "show", "--name-only", "--no-renames", "--format=", "HEAD")
      .split("\n")
      .includes("other.txt"),
    false,
  );
  assert.equal(git(dir, "status", "--porcelain"), "M  other.txt");
});

test("没有提交文案时拒绝", (t) => {
  const dir = gitProject(t);
  const task = doneTask(dir);
  const stateOf = () => [
    git(dir, "rev-parse", "HEAD"),
    git(dir, "status", "--porcelain"),
    ...["task.md", "record.json"].map((name) => readFileSync(join(dir, task.dir, name), "utf8")),
  ];
  const before = stateOf();
  const blank = messageFile(t, " \n\n");

  for (const [messageFile, problem] of [
    [undefined, "在 Git 仓库里交付要给提交文案：加 --message-file <文件>"],
    [blank, `提交文案是空的：${blank}`],
    [`${blank}.nope`, `读不到提交文案：${blank}.nope`],
  ]) assert.deepEqual(deliverTask(dir, task.id, { authorization, messageFile }), { kind: "refused", problems: [problem] });
  assert.deepEqual(stateOf(), before);
});

test("没有要提交的文件时不提交", (t) => {
  const dir = gitProject(t);
  writeFileSync(join(dir, ".gitignore"), "/.knit/\n");
  commitAll(dir, "ignore");
  const task = doneTask(dir);
  const head = git(dir, "rev-parse", "HEAD");

  const delivered = deliverTask(dir, task.id, { authorization, messageFile: messageFile(t, "feat: 加问候语\n") });

  assert.equal(delivered.kind, "delivered");
  assert.deepEqual(delivered.commit, { kind: "nothing" });
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(existsSync(join(dir, task.dir)), false);
  assert.match(readFileSync(join(dir, archived(task), "task.md"), "utf8"), /^status: delivered$/m);
});

/**
 * 临时仓库里一个完成的任务：任务目录已经提交，记录的路径是改过的 src/a.ts 和新文件 src/b.ts，
 * 另外 src/c.ts 改了并且已经暂存；pre-commit hook 的内容是 `hook`。
 */
function prepared(t, hook) {
  const dir = gitProject(t);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "src/c.ts"), "c\n");
  const task = doneTask(dir, ["src/a.ts", "src/b.ts"]);
  commitAll(dir, "task");
  writeFileSync(join(dir, "src/a.ts"), "a2\n");
  writeFileSync(join(dir, "src/b.ts"), "b\n");
  writeFileSync(join(dir, "src/c.ts"), "c2\n");
  git(dir, "add", "src/c.ts");
  mkdirSync(join(dir, ".git/hooks"), { recursive: true });
  writeFileSync(join(dir, ".git/hooks/pre-commit"), `#!/bin/sh\n${hook}\n`);
  chmodSync(join(dir, ".git/hooks/pre-commit"), 0o755);
  // 文案写在项目外面，不算工作区里的改动。
  const message = join(project(t), "message.txt");
  writeFileSync(message, "feat: 加问候语\n");
  const deliver = () => knit(dir, "deliver", task.id, "--authorization", "user:1a2b3c4d", "--message-file", message);
  return { dir, task, deliver, message };
}

test("Git 拒绝提交时撤回", (t) => {
  const { dir, task, deliver, message } = prepared(t, "echo 'lint failed' >&2\nexit 1");
  const stateOf = () => [
    git(dir, "rev-parse", "HEAD"),
    git(dir, "status", "--porcelain"),
    ...["task.md", "record.json"].map((name) => readFileSync(join(dir, task.dir, name), "utf8")),
  ];
  const before = stateOf();

  const refused = deliver();

  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /^lint failed$/m);
  assert.equal(
    refused.stderr.trimEnd().split("\n").at(-1),
    `Git 没有接受这次提交，交付已经撤回：任务目录在 ${task.dir}，状态是 done`,
  );
  assert.deepEqual(stateOf(), before);
  assert.equal(existsSync(join(dir, archived(task))), false);

  rmSync(join(dir, ".git/hooks/pre-commit"));
  const delivered = deliverTask(dir, task.id, { authorization, messageFile: message });
  assert.equal(delivered.kind, "delivered");
  assert.equal(delivered.worktree, null);
  assert.deepEqual(delivered.commit, { kind: "committed", summary: git(dir, "log", "-1", "--format=%h %s"), extra: [], missing: [] });
  const stored = findTask(dir, task.id);
  assert.equal(delivered.archiveDir, stored.dir);
  assert.equal(stored.document.frontmatter.status, "delivered");
  assert.equal(stored.record.authorization, authorization);
  assert.equal(git(dir, "log", "-1", "--format=%b"), `Knit-Task: ${task.id}`);
  assert.equal(git(dir, "status", "--porcelain"), "M  src/c.ts");
});

test("hook 改了提交的内容时报告差别", (t) => {
  const { dir, task, message } = prepared(t, "git rm -q --cached src/b.ts\necho hooked > hooked.txt\ngit add hooked.txt");

  const delivered = deliverTask(dir, task.id, { authorization, messageFile: message });
  assert.equal(delivered.kind, "delivered");
  assert.deepEqual(delivered.commit, { kind: "committed", summary: git(dir, "log", "-1", "--format=%h %s"), extra: ["hooked.txt"], missing: ["src/b.ts"] });
  assert.equal(git(dir, "log", "-1", "--format=%b"), `Knit-Task: ${task.id}`);
  assert.equal(existsSync(join(dir, task.dir)), false);
  assert.match(readFileSync(join(dir, archived(task), "task.md"), "utf8"), /^status: delivered$/m);
});
