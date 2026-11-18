// 执行目录里的 worker.json、before.json、after.json 坏了时命令怎么表现，照 docs/design/DESIGN.md 第 7.3 节写的办法能不能恢复。
// 在仓库根目录运行：npm run -s build && node --test validation/slim-h5-2026-11/broken-run-files.test.mjs
// 用假的 Pi，不调用模型；项目建在临时目录里。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

const REPO = process.cwd();
const { RUNS_DIR } = await import(join(REPO, "dist/application/run-prepare.js"));
const { readyTask, runProject } = await import(join(REPO, "test/helpers/run.mjs"));
const CLI = join(REPO, "dist/cli/knit.js");
const FAKE_PI = join(REPO, "test/helpers/fake-pi.mjs");
const processesOf = (runId) => spawnSync("pgrep", ["-f", runId], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

/** 派发一次停不下来的执行（假 Pi 写出 src/a.ts 之后一直等），返回操作它要用的东西。 */
async function stuckRun(t) {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  const script = join(outside, "script.json");
  writeFileSync(script, JSON.stringify({ writes: [{ path: "src/a.ts", content: "x\n" }], waitFor: join(outside, "never") }));
  const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script };
  const knit = (...args) => {
    const done = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], { encoding: "utf8", env, timeout: 30000 });
    return { code: done.status, text: done.stdout + done.stderr };
  };
  assert.equal(knit("run", "start", task.id).code, 0);
  for (let tries = 0; tries < 200 && !existsSync(join(dir, "src/a.ts")); tries += 1) await sleep(100);
  const lastRun = () => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
  const runId = lastRun().id;
  t.after(() => {
    spawnSync("pkill", ["-9", "-f", runId]);
    rmSync(outside, { recursive: true, force: true });
  });
  return { task, knit, lastRun, runId, runDir: join(dir, RUNS_DIR, runId) };
}

test("worker.json 坏了：run status、run wait、run cancel、context 都报错；停进程、删文件、再 cancel 之后恢复", async (t) => {
  const { task, knit, lastRun, runId, runDir } = await stuckRun(t);
  writeFileSync(join(runDir, "worker.json"), "{ 坏的");
  for (const args of [["run", "status"], ["run", "wait"], ["run", "cancel"], ["context"]]) {
    const done = knit(...args, task.id);
    assert.equal(done.code, 1, args.join(" "));
    assert.match(done.text, /SyntaxError/, args.join(" "));
  }
  // 命令报错的时候什么都没有停。
  assert.equal(processesOf(runId).length, 2);
  assert.equal(lastRun().endedAt, null);

  spawnSync("pkill", ["-f", runId]);
  for (let tries = 0; tries < 50 && processesOf(runId).length > 0; tries += 1) await sleep(100);
  assert.equal(processesOf(runId).length, 0);
  rmSync(join(runDir, "worker.json"));
  const cancelled = knit("run", "cancel", task.id);
  assert.equal(cancelled.code, 0);
  assert.match(cancelled.text, /已记为失败/);
  assert.equal(lastRun().failure, "执行进程意外退出");
  assert.deepEqual(lastRun().changedPaths, ["src/a.ts"]);
  assert.match(knit("run", "status", task.id).text, /下一步: 派发实现环节/);
});

test("worker.json 坏了：只删文件不停进程，cancel 记了失败，进程还在跑", async (t) => {
  const { task, knit, lastRun, runId, runDir } = await stuckRun(t);
  writeFileSync(join(runDir, "worker.json"), "{ 坏的");
  rmSync(join(runDir, "worker.json"));
  assert.equal(knit("run", "cancel", task.id).code, 0);
  assert.equal(lastRun().failure, "执行进程意外退出");
  assert.equal(processesOf(runId).length, 2);
});

test("before.json 坏了：status 正常，cancel 停了进程之后报错；删文件、再 cancel 之后恢复，改动文件没有记下", async (t) => {
  const { task, knit, lastRun, runId, runDir } = await stuckRun(t);
  writeFileSync(join(runDir, "before.json"), "{ 坏的");
  const status = knit("run", "status", task.id);
  assert.equal(status.code, 0);
  assert.match(status.text, /正在跑/);
  const failed = knit("run", "cancel", task.id);
  assert.equal(failed.code, 1);
  assert.match(failed.text, /SyntaxError/);
  // 报错之前进程已经被停掉，但是这次执行还没有记为结束。
  assert.equal(processesOf(runId).length, 0);
  assert.equal(lastRun().endedAt, null);

  rmSync(join(runDir, "before.json"));
  const cancelled = knit("run", "cancel", task.id);
  assert.equal(cancelled.code, 0);
  assert.match(cancelled.text, /已记为失败/);
  assert.equal(lastRun().failure, "执行进程意外退出");
  // 没有派发时的记录可比，这次执行改了 src/a.ts 也记不下来。
  assert.deepEqual(lastRun().changedPaths, []);
  assert.match(knit("run", "status", task.id).text, /下一步: 派发实现环节/);
});

test("before.json 坏了：执行者自己做完时记不了结果，这次执行一直算正在跑；删文件、再 cancel 之后恢复", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  const script = join(outside, "script.json");
  const go = join(outside, "go");
  writeFileSync(script, JSON.stringify({ writes: [{ path: "src/a.ts", content: "x\n" }], waitFor: go, texts: ["做完了。"] }));
  const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script };
  const knit = (...args) => {
    const done = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], { encoding: "utf8", env, timeout: 30000 });
    return { code: done.status, text: done.stdout + done.stderr };
  };
  assert.equal(knit("run", "start", task.id).code, 0);
  for (let tries = 0; tries < 200 && !existsSync(join(dir, "src/a.ts")); tries += 1) await sleep(100);
  const lastRun = () => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
  const runId = lastRun().id;
  const runDir = join(dir, RUNS_DIR, runId);
  t.after(() => {
    spawnSync("pkill", ["-9", "-f", runId]);
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(runDir, "before.json"), "{ 坏的");
  writeFileSync(go, "");
  for (let tries = 0; tries < 100 && processesOf(runId).length > 0; tries += 1) await sleep(100);
  assert.equal(processesOf(runId).length, 0);
  assert.equal(lastRun().endedAt, null);
  assert.match(readFileSync(join(runDir, "worker.log"), "utf8"), /SyntaxError/);
  assert.match(knit("run", "status", task.id).text, /进程已经不在了/);
  assert.equal(knit("run", "cancel", task.id).code, 1);

  rmSync(join(runDir, "before.json"));
  assert.equal(knit("run", "cancel", task.id).code, 0);
  assert.equal(lastRun().failure, "执行进程意外退出");
  assert.deepEqual(lastRun().changedPaths, []);
});

test("after.json 坏了：交付预览报错；交付本身不读它，照样能交付", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const script = join(outside, "script.json");
  const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script };
  const knit = (...args) => {
    const done = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], { encoding: "utf8", env, timeout: 30000 });
    return { code: done.status, text: done.stdout + done.stderr };
  };
  writeFileSync(script, JSON.stringify({ writes: [{ path: "src/a.ts", content: "x\n" }], texts: ["做完了。"] }));
  assert.equal(knit("run", "start", task.id).code, 0);
  assert.equal(knit("run", "wait", task.id).code, 0);
  writeFileSync(script, JSON.stringify({ texts: ['没有问题。\n\n```json\n{"verdict":"pass"}\n```'] }));
  assert.equal(knit("run", "start", task.id).code, 0);
  assert.match(knit("run", "wait", task.id).text, /结论: pass/);
  const review = JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
  const after = join(dir, RUNS_DIR, review.id, "after.json");
  assert.equal(existsSync(after), true);
  assert.equal(knit("task", "close", task.id, "--result", "做完了").code, 0);

  writeFileSync(after, "{ 坏的");
  const preview = knit("deliver", task.id, "--preview");
  assert.equal(preview.code, 1);
  assert.match(preview.text, /SyntaxError/);
  // 交付本身不读 after.json：坏着也能交付。
  const message = join(outside, "message.txt");
  writeFileSync(message, "feat: add a\n\n演练。\n");
  const delivered = knit("deliver", task.id, "--authorization", "脚本演练：没有真的用户消息", "--message-file", message);
  assert.equal(delivered.code, 0, delivered.text);
  assert.match(delivered.text, /已交付/);
});

test("after.json 坏了：删掉之后预览正常", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const script = join(outside, "script.json");
  const env = { ...process.env, KNIT_PI_BIN: FAKE_PI, KNIT_FAKE_PI: script };
  const knit = (...args) => {
    const done = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], { encoding: "utf8", env, timeout: 30000 });
    return { code: done.status, text: done.stdout + done.stderr };
  };
  writeFileSync(script, JSON.stringify({ writes: [{ path: "src/a.ts", content: "x\n" }], texts: ["做完了。"] }));
  knit("run", "start", task.id);
  knit("run", "wait", task.id);
  writeFileSync(script, JSON.stringify({ texts: ['没有问题。\n\n```json\n{"verdict":"pass"}\n```'] }));
  knit("run", "start", task.id);
  knit("run", "wait", task.id);
  const review = JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
  const after = join(dir, RUNS_DIR, review.id, "after.json");
  knit("task", "close", task.id, "--result", "做完了");
  writeFileSync(after, "{ 坏的");
  assert.equal(knit("deliver", task.id, "--preview").code, 1);
  rmSync(after);
  const preview = knit("deliver", task.id, "--preview");
  assert.equal(preview.code, 0, preview.text);
  assert.match(preview.text, /src\/a\.ts/);
});
