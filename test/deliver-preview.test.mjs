import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/application/config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { doneTask } from "./helpers/deliver.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";
import { readyTask, runProject, worktreeLine, worktreeOf } from "./helpers/run.mjs";

const now = new Date();
const archived = (task) =>
  `.knit/tasks/archive/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${basename(task.dir)}`;
const filesOf = (dir, task) => ["task.md", "record.json"].map((name) => readFileSync(join(dir, task.dir, name), "utf8"));
const resultOf = (run) => ({ code: run.code, stdout: run.stdout, stderr: run.stderr });

/** 派一次执行，让 `change` 改工作区，再按 `verdict` 记为结束。 */
function run(dir, task, verdict, change) {
  const workflow = parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
  const prepared = prepareRun({ root: dir, taskId: task.id, workflow, config: loadConfig(dir).config, model: null });
  assert.deepEqual(prepared.problems, []);
  change(worktreeOf(dir, task));
  const problems = finishRun({
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
  const child = knit(dir, "task", "new", "--title", "子任务", "--parent", task.id);
  assert.equal(child.code, 0, child.stderr);
  const childId = child.stdout.split("\n")[0].replace("已创建 ", "");
  commitAll(dir, "tasks");

  run(dir, task, null, (cwd) => writeFileSync(join(cwd, "src/a.ts"), "a2\n"));
  run(dir, task, "pass", (cwd) => writeFileSync(join(cwd, "src/b.ts"), "b\n"));
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了\n\n都验证过", "--paths", "src/gone.ts");
  assert.equal(closed.code, 0, closed.stderr);
  writeFileSync(join(worktreeOf(dir, task), "other.txt"), "other\n");
  // 主检出中的同名文件和无关改动不能影响预览。
  writeFileSync(join(dir, "src/b.ts"), "main only\n");
  writeFileSync(join(dir, "main-only.txt"), "main only\n");
  const message = join(dir, ".knit/.runtime/message.txt");
  writeFileSync(message, "\nfeat: 加问候语\n\n说明一行\n\n");
  const before = [git(dir, "status", "--porcelain"), git(worktreeOf(dir, task), "status", "--porcelain"), ...filesOf(dir, task)];

  const preview = knit(dir, "deliver", task.id, "--preview", "--message-file", message);

  assert.deepEqual(resultOf(preview), {
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
  assert.deepEqual([git(dir, "status", "--porcelain"), git(worktreeOf(dir, task), "status", "--porcelain"), ...filesOf(dir, task)], before);

  const missing = knit(dir, "deliver", task.id, "--preview", "--message-file", join(dir, "nope.txt"));
  assert.deepEqual(resultOf(missing), { code: 1, stdout: "", stderr: `读不到提交文案：${join(dir, "nope.txt")}\n` });
  const bare = knit(dir, "deliver", task.id, "--preview");
  assert.equal(bare.stdout.split("\n").at(-2), "提交文案: 没有给；交付时加 --message-file <文件>");
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
  const fileLines = () => {
    const lines = knit(dir, "deliver", task.id, "--preview").stdout.split("\n");
    return lines.slice(lines.indexOf("提交的文件:") + 1, lines.indexOf("结果:"));
  };

  run(dir, task, null, (cwd) => ["src/a.ts", "src/b.ts"].forEach((path) => write(path, "1\n", cwd)));
  run(dir, task, "pass", (cwd) => write("src/c.ts", "1\n", cwd));
  const reviewId = JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1).id;
  write("src/a.ts", "2\n");
  write("src/c.ts", "2\n");
  write("src/d.ts", "1\n");
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了", "--paths", "src/d.ts");
  assert.equal(closed.code, 0, closed.stderr);

  assert.deepEqual(fileLines(), [
    "  src/a.ts（审查通过之后又改过）",
    "  src/b.ts",
    "  src/c.ts（审查改过，审查通过之后又改过）",
    "  src/d.ts（审查通过之后又改过）",
    `  ${task.dir}/（整个目录，移到归档的位置）`,
    "提示:",
    "  - 有 3 个文件在审查通过之后又改过（上面标出来的），这些改动审查没有看过",
  ]);

  // 改回审查结束时的样子就不标。
  write("src/a.ts", "1\n");
  assert.equal(fileLines()[0], "  src/a.ts");
  assert.equal(fileLines().at(-1), "  - 有 2 个文件在审查通过之后又改过（上面标出来的），这些改动审查没有看过");

  // 审查结束时拍的那一份不在了（运行时资料被清掉）：不标，也不出错。
  rmSync(join(dir, ".knit/.runtime/runs", reviewId, "after.json"));
  assert.deepEqual(fileLines(), ["  src/a.ts", "  src/b.ts", "  src/c.ts（审查改过）", "  src/d.ts", `  ${task.dir}/（整个目录，移到归档的位置）`]);
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
  const closed = knit(dir, "task", "close", task.id, "--result", "做完了", "--reason", "用户要求直接完成");
  assert.equal(closed.code, 0, closed.stderr);

  const preview = knit(dir, "deliver", task.id, "--preview");
  assert.match(preview.stdout, /\n提交的文件:\n  src\/a\.ts\n/);
  assert.doesNotMatch(preview.stdout, /审查通过之后又改过/);
});

test("不在 Git 仓库里只说明归档", (t) => {
  const dir = project(t);
  const task = doneTask(dir, ["src/a.ts"]);

  const preview = knit(dir, "deliver", task.id, "--preview");

  assert.deepEqual(resultOf(preview), {
    code: 0,
    stdout: [
      `任务: 加问候语（${task.id}）`,
      `归档: ${task.dir} → ${archived(task)}`,
      "提交: 这个项目不在 Git 仓库里，只归档，不提交",
      "结果:",
      "  做完了",
      "",
    ].join("\n"),
    stderr: "",
  });
  // 没有提交，也就不读文案。
  assert.equal(knit(dir, "deliver", task.id, "--preview", "--message-file", join(dir, "nope.txt")).stdout, preview.stdout);
  assert.equal(existsSync(join(dir, task.dir, "task.md")), true);
  assert.equal(existsSync(join(dir, archived(task))), false);
});

test("不能交付的任务被拒绝", (t) => {
  const dir = gitProject(t);
  const ready = readyTask(dir);
  const cancelled = readyTask(dir);
  assert.equal(knit(dir, "task", "cancel", cancelled.id, "--reason", "不做了").code, 0);

  assert.deepEqual(resultOf(knit(dir, "deliver", ready.id, "--preview")), {
    code: 1,
    stdout: "",
    stderr: `任务 ${ready.id} 还没有完成（ready）；完成之后再交付：knit task close ${ready.id}\n`,
  });
  assert.deepEqual(resultOf(knit(dir, "deliver", cancelled.id, "--preview")), {
    code: 1,
    stdout: "",
    stderr: `任务 ${cancelled.id} 已经结束（cancelled），不能交付\n`,
  });
});
