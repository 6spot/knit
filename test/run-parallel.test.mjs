import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RUNS_DIR } from "../dist/application/run-prepare.js";
import { knit } from "./helpers/cli.mjs";
import { git } from "./helpers/git.mjs";
import { readyTask, runProject, worktreeLine, worktreeOf } from "./helpers/run.mjs";

const CLI = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const recordOf = (root, task) => JSON.parse(readFileSync(join(root, task.dir, "record.json"), "utf8"));
const lastRun = (root, task) => recordOf(root, task).runs.at(-1);
const processesOf = (runId) => spawnSync("pgrep", ["-f", runId], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

async function waitUntil(done, what) {
  const deadline = Date.now() + 20000;
  while (!done() && Date.now() < deadline) await sleep(100);
  assert.ok(done(), `等了 20 秒：${what}`);
}

function parallelProject(t) {
  const started = [];
  // 在删除夹具之前停完进程，失败的断言也不会留下等待文件的假 Pi。
  t.after(async () => {
    started.filter((task) => lastRun(root, task).endedAt === null).forEach((task) => {
      const cancelled = knit(root, "run", "cancel", task.id);
      assert.equal(cancelled.code, 0, cancelled.stderr);
    });
    await Promise.all(started.map((task) => waitUntil(() => processesOf(lastRun(root, task).id).length === 0, "执行进程退出")));
  });
  const root = runProject(t);
  return {
    root,
    start: (task) => {
      const script = join(process.env.KNIT_HOME, `${task.id}.json`);
      writeFileSync(script, JSON.stringify({
        writes: [
          { path: `src/${task.id}.txt`, content: task.id },
          { path: "shared.txt", content: task.id },
        ],
        waitFor: join(process.env.KNIT_HOME, `${task.id}.go`),
        texts: [`${task.id} 做完了。`],
      }));
      const result = spawnSync(process.execPath, [CLI, "run", "start", task.id, "--dir", root], {
        encoding: "utf8",
        env: { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script },
      });
      assert.equal(result.status, 0, result.stderr);
      started.push(task);
      const run = lastRun(root, task);
      assert.equal(result.stdout, `已派发 ${task.id}：实现（${run.id}）\n${worktreeLine(root, task)}会话记录：${RUNS_DIR}/${run.id}/session/\n`);
      return run;
    },
    release: (task) => writeFileSync(join(process.env.KNIT_HOME, `${task.id}.go`), ""),
  };
}

async function running(root, task) {
  await waitUntil(() => existsSync(join(worktreeOf(root, task), `src/${task.id}.txt`)), "假 Pi 写出文件");
  assert.equal(lastRun(root, task).endedAt, null);
  assert.equal(processesOf(lastRun(root, task).id).length, 2);
  const status = knit(root, "run", "status", task.id);
  assert.equal(status.code, 0, status.stderr);
  assert.ok(status.stdout.includes(`正在跑: 实现（${lastRun(root, task).id}）`), status.stdout);
  assert.ok(status.stdout.includes(worktreeLine(root, task)), status.stdout);
}

async function ended(root, task) {
  await waitUntil(() => lastRun(root, task).endedAt !== null, "执行结束");
  await waitUntil(() => processesOf(lastRun(root, task).id).length === 0, "后台进程和假 Pi 退出");
  const waited = knit(root, "run", "wait", task.id);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.stdout, knit(root, "run", "status", task.id).stdout);
  return lastRun(root, task);
}

function ownChanges(root, task) {
  assert.deepEqual(lastRun(root, task).changedPaths, ["shared.txt", `src/${task.id}.txt`]);
  assert.equal(readFileSync(join(worktreeOf(root, task), "shared.txt"), "utf8"), task.id);
  assert.equal(existsSync(join(root, "shared.txt")), false);
  assert.equal(existsSync(join(root, `src/${task.id}.txt`)), false);
}

test("不同任务同时派发，各在自己的 Worktree 结束、记改动并推进状态", async (t) => {
  const project = parallelProject(t);
  const tasks = [readyTask(project.root), readyTask(project.root)];
  const main = [git(project.root, "branch", "--show-current"), git(project.root, "rev-parse", "HEAD")];
  project.start(tasks[0]);
  await running(project.root, tasks[0]);
  project.start(tasks[1]);
  await Promise.all(tasks.map((task) => running(project.root, task)));
  assert.notEqual(worktreeOf(project.root, tasks[0]), worktreeOf(project.root, tasks[1]));
  assert.notEqual(lastRun(project.root, tasks[0]).id, lastRun(project.root, tasks[1]).id);
  assert.equal(git(project.root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 3);

  project.release(tasks[0]);
  assert.equal((await ended(project.root, tasks[0])).failure, null);
  await running(project.root, tasks[1]);
  project.release(tasks[1]);
  assert.equal((await ended(project.root, tasks[1])).failure, null);
  tasks.forEach((task) => {
    ownChanges(project.root, task);
    assert.equal(recordOf(project.root, task).runs.length, 1);
    const runDir = join(project.root, RUNS_DIR, lastRun(project.root, task).id);
    assert.equal(readFileSync(join(runDir, "report.md"), "utf8"), `${task.id} 做完了。`);
    assert.ok(readdirSync(runDir).includes("before.json"));
    assert.equal(existsSync(join(worktreeOf(project.root, task), RUNS_DIR)), false);
    assert.equal(existsSync(join(worktreeOf(project.root, task), task.dir)), false);
    assert.equal(git(worktreeOf(project.root, task), "rev-parse", "HEAD"), main[1]);
    assert.ok(knit(project.root, "run", "status", task.id).stdout.includes(`下一步: 派发审查环节（knit run start ${task.id}）`));
  });
  assert.deepEqual([git(project.root, "branch", "--show-current"), git(project.root, "rev-parse", "HEAD")], main);
});

test("取消并行任务甲只停甲，任务乙继续运行并正常结束", async (t) => {
  const project = parallelProject(t);
  const first = readyTask(project.root);
  const second = readyTask(project.root);
  const firstRun = project.start(first);
  await running(project.root, first);
  project.start(second);
  await running(project.root, second);
  const secondBefore = recordOf(project.root, second);

  const cancelled = knit(project.root, "run", "cancel", first.id);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `已取消 ${first.id} 的执行 ${firstRun.id}\n改动文件: 2 个\n`);
  assert.equal(processesOf(firstRun.id).length, 0);
  assert.equal(lastRun(project.root, first).failure, "已取消");
  assert.notEqual(lastRun(project.root, first).endedAt, null);
  ownChanges(project.root, first);
  assert.deepEqual(recordOf(project.root, second), secondBefore);
  await running(project.root, second);
  project.release(second);
  assert.equal((await ended(project.root, second)).failure, null);
  ownChanges(project.root, second);
  assert.ok(knit(project.root, "run", "status", second.id).stdout.includes(`下一步: 派发审查环节（knit run start ${second.id}）`));
});
