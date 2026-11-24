import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/application/project-config.js";
import { finishRun } from "../dist/application/run-finish.js";
import { prepareRun, RUNS_DIR } from "../dist/application/run-prepare.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit } from "./helpers/cli.mjs";
import { agents, readyTask, runProject, worktreeLine, worktreeOf } from "./helpers/run.mjs";

const CLI = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const workflowOf = (dir) => parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).workflow;
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);

function status(dir, id) {
  const shown = knit(dir, "run", "status", id);
  assert.equal(shown.code, 0, shown.stderr);
  return shown.stdout;
}
function prepare(dir, task) {
  const { run, problems } = prepareRun({
    root: dir,
    taskId: task.id,
    workflow: workflowOf(dir),
    config: loadConfig(dir).config,
    model: null,
  });
  assert.deepEqual(problems, []);
  return run;
}
function finish(dir, task, run, { verdict = null, failure = null } = {}) {
  const problems = finishRun({
    agents,
    root: dir,
    taskId: task.id,
    runId: run.id,
    workflow: workflowOf(dir),
    verdict,
    failure,
    sessionFile: null,
  });
  assert.deepEqual(problems, []);
}
function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
/** 每 100 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await sleep(100);
  }
  assert.fail(`等了 20 秒：${what}`);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("没派发过时给出下一步", (t) => {
  const dir = runProject(t);
  const draft = knit(dir, "task", "new", "--title", "还没确认").stdout.split("\n")[0].replace("已创建 ", "");
  const ready = readyTask(dir);

  assert.equal(
    status(dir, draft),
    `任务: 还没确认（${draft}）\n状态: draft\n还没有派发过\n下一步: 先确认需求（knit task ready ${draft}）\n`,
  );
  assert.equal(
    status(dir, ready.id),
    `任务: 加问候语（${ready.id}）\n状态: ready\n还没有派发过\n下一步: 派发实现环节（knit run start ${ready.id}）\n`,
  );
});

test("正在跑和进程不在了分得出来", async (t) => {
  const running = runProject(t);
  const first = readyTask(running);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const gate = join(outside, "go");
  writeFileSync(join(outside, "script.json"), JSON.stringify({ waitFor: gate }));
  const started = spawnSync(process.execPath, [CLI, "run", "start", first.id, "--dir", running], {
    encoding: "utf8",
    env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: join(outside, "script.json") },
  });
  assert.equal(started.status, 0, started.stderr);
  const run = lastRun(running, first);

  assert.equal(
    status(running, first.id),
    `任务: 加问候语（${first.id}）\n状态: active(implement)\n${worktreeLine(running, first)}` +
      `正在跑: 实现（${run.id}），开始于 ${run.startedAt}\n会话记录: ${RUNS_DIR}/${run.id}/session/\nAgent: pi\n`,
  );

  const gone = runProject(t);
  const second = readyTask(gone);
  const lost = prepare(gone, second);
  assert.equal(
    status(gone, second.id),
    `任务: 加问候语（${second.id}）\n状态: active(implement)\n${worktreeLine(gone, second)}` +
      `执行 ${lost.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${second.id} 记为失败\nAgent: pi\n`,
  );

  writeFileSync(gate, "");
  await waitUntil(() => lastRun(running, first).endedAt !== null, `执行 ${run.id} 结束`);
  const { pid } = JSON.parse(readFileSync(join(running, RUNS_DIR, run.id, "worker.json"), "utf8"));
  await waitUntil(() => !alive(pid), `后台进程 ${pid} 退出`);
  assert.match(status(running, first.id), /\n上一次: 实现（r-[0-9a-f]{12}）\n结果: 正常结束\n/);
});

test("结束之后显示结果和下一步", (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const head = `任务: 加问候语（${task.id}）\n`;
  const worktree = worktreeLine(dir, task);

  const implement = prepare(dir, task);
  write(worktreeOf(dir, task), "src/a.ts", "export const a = 1;\n");
  write(worktreeOf(dir, task), "src/b.ts", "export const b = 2;\n");
  write(dir, `${implement.dir}/report.md`, "做完了。\n");
  finish(dir, task, implement);
  assert.equal(
    status(dir, task.id),
    `${head}状态: active(implement)\n${worktree}上一次: 实现（${implement.id}）\n结果: 正常结束\n` +
      `报告: ${RUNS_DIR}/${implement.id}/report.md\n改动文件: 2 个\nAgent: pi\n下一步: 派发审查环节（knit run start ${task.id}）\n`,
  );

  const review = prepare(dir, task);
  finish(dir, task, review, { verdict: "changes_requested" });
  const recordPath = join(dir, task.dir, "record.json");
  const legacy = JSON.parse(readFileSync(recordPath, "utf8"));
  delete legacy.runs.at(-1).agent;
  writeFileSync(recordPath, JSON.stringify(legacy));
  assert.equal(
    status(dir, task.id),
    `${head}状态: active(review)\n${worktree}上一次: 审查（${review.id}）\n结论: changes_requested\n` +
      `改动文件: 0 个\nAgent: pi\n下一步: 派发实现环节（knit run start ${task.id}）\n`,
  );

  const other = readyTask(dir);
  const failed = prepare(dir, other);
  finish(dir, other, failed, { failure: "执行者中途退出" });
  assert.equal(
    status(dir, other.id),
    `任务: 加问候语（${other.id}）\n状态: active(implement)\n${worktreeLine(dir, other)}上一次: 实现（${failed.id}）\n失败: 执行者中途退出\n` +
      `改动文件: 0 个\nAgent: pi\n下一步: 派发实现环节（knit run start ${other.id}）\n`,
  );
});
