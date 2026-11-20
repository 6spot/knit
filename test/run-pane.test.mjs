import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RUNS_DIR } from "../dist/application/run-prepare.js";
import { readyTask, runProject, worktreeLine, worktreeOf } from "./helpers/run.mjs";

const CLI = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const FAKE_REX = fileURLToPath(new URL("./helpers/fake-rex.mjs", import.meta.url));
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);
const processesOf = (runId) => spawnSync("pgrep", ["-f", runId], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

/** 主会话在 Rex 里的样子：PATH 上有假的 rex，环境里有 REX_SESSION 和 REX_BLOCK。 */
function inRex(t, dir, environment = {}) {
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-rex-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(FAKE_REX, join(outside, "rex"));
  mkdirSync(join(outside, "rex-home", "layers"), { recursive: true });
  const env = {
    ...process.env,
    PATH: `${outside}${delimiter}${process.env.PATH}`,
    REX_SESSION: "session:test",
    REX_BLOCK: "block:main",
    KNIT_FAKE_REX: join(outside, "rex-home"),
    KNIT_PI_BIN: FAKE_PI,
    KNIT_FAKE_PI: join(outside, "script.json"),
    KNIT_FAKE_PI_LOG: join(outside, "log.jsonl"),
    ...environment,
  };
  const jsonLines = (file) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];
  return {
    outside,
    script: (script) => writeFileSync(env.KNIT_FAKE_PI, JSON.stringify(script)),
    rexFails: (method) => writeFileSync(join(env.KNIT_FAKE_REX, "fail"), method),
    calls: () => jsonLines(join(env.KNIT_FAKE_REX, "calls.jsonl")),
    panes: () => readdirSync(join(env.KNIT_FAKE_REX, "layers")),
    piLog: () => jsonLines(env.KNIT_FAKE_PI_LOG),
    knit: (...args) => {
      const result = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], { encoding: "utf8", env });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}
/** 每 100 毫秒看一次，最多等 20 秒。 */
async function waitUntil(done, what) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await sleep(100);
  }
  assert.fail(`等了 20 秒：${what}`);
}
/** 派发并返回这次执行。 */
function start(rex, dir, task) {
  const started = rex.knit("run", "start", task.id);
  assert.equal(started.code, 0, started.stderr);
  return lastRun(dir, task);
}
/** 等这次执行在记录里结束、它的进程都退出；返回记录里的这一项。 */
async function finished(dir, task, runId) {
  await waitUntil(() => lastRun(dir, task).endedAt !== null, `执行 ${runId} 结束`);
  await waitUntil(() => processesOf(runId).length === 0, `执行 ${runId} 的进程退出`);
  return lastRun(dir, task);
}

test("主会话在 Rex 里时，执行者在窗格里做完", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }], texts: ["做完了。"] });

  const run = start(rex, dir, task);
  const ended = await finished(dir, task, run.id);

  // 命令里的路径是解析过符号链接的项目根（macOS 的临时目录是一个符号链接）。
  const runDir = join(realpathSync(dir), RUNS_DIR, run.id);
  assert.deepEqual(
    { verdict: ended.verdict, failure: ended.failure, changedPaths: ended.changedPaths, sessionFile: ended.sessionFile },
    { verdict: null, failure: null, changedPaths: ["src/a.ts"], sessionFile: `${RUNS_DIR}/${run.id}/session/fake.jsonl` },
  );
  assert.equal(readFileSync(join(runDir, "report.md"), "utf8"), "做完了。");
  assert.deepEqual(
    rex.calls().map((call) => call.method),
    // 最后一次是做完之后关窗格：程序结束时它已经自己关了，这一次什么都不做。
    ["session.describe_block", "session.new_layer", "session.set_layer_state", "session.close_layer"],
  );
  const [, layer, state] = rex.calls();
  assert.equal(layer.params.session_id, "session:test");
  assert.equal(layer.params.window_id, "window:1");
  assert.equal(layer.params.focus, false);
  assert.equal(state.params.state, "minimized");
  const { label, options } = layer.params.layout.block;
  assert.equal(label, `knit ${run.id}`);
  assert.equal(options.cwd, worktreeOf(dir, task));
  assert.equal(readFileSync(join(worktreeOf(dir, task), "src/a.ts"), "utf8"), "export const a = 1;\n");
  assert.equal(existsSync(join(dir, "src/a.ts")), false);
  assert.equal(options.shell, undefined);
  assert.deepEqual(options.exit, { on_completion: true });
  const { command } = options;
  assert.deepEqual(command.slice(0, 3), ["/usr/bin/env", "-u", "PI_SESSION_ID"]);
  assert.ok(command.includes(`KNIT_PANE_DIR=${runDir}`));
  // 交互界面：没有 --mode，也没有 --no-themes；系统提示给的是文件。
  assert.ok(!command.includes("--mode") && !command.includes("--no-themes"));
  assert.equal(command[command.indexOf("--append-system-prompt") + 1], join(runDir, "system.md"));
  assert.equal(command[command.indexOf("--tools") + 1], "read,grep,find,ls,write,edit,bash");
  assert.deepEqual(rex.piLog().filter((line) => line.message !== undefined), [
    { message: readFileSync(join(runDir, "message.md"), "utf8") },
  ]);
  assert.deepEqual(rex.panes(), []);
});

[
  { name: "Rex 窗格传递主会话的思考等级", session: "high", paneExit: false, expected: "high" },
  { name: "Rex 窗格四处都没等级时不传 --thinking", session: undefined, paneExit: false, expected: null },
  { name: "Rex 窗格回退后台时保留思考等级", session: "high", paneExit: true, expected: "high" },
].forEach((scenario) => {
  test(scenario.name, async (t) => {
    const dir = runProject(t);
    const task = readyTask(dir);
    const rex = inRex(t, dir, { PI_REASONING_LEVEL: scenario.session });
    rex.script({ paneExit: scenario.paneExit });

    assert.equal((await finished(dir, task, start(rex, dir, task).id)).failure, null);
    const starts = rex.piLog().filter((line) => line.args !== undefined);
    assert.equal(starts.length, scenario.paneExit ? 2 : 1);
    starts.forEach(({ args }) => {
      assert.equal(args.includes("--thinking"), scenario.expected !== null);
      if (scenario.expected !== null) assert.equal(args[args.indexOf("--thinking") + 1], scenario.expected);
    });
  });
});

test("窗格开不了时，照旧在后台执行", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir, { verification: "self" });
  const rex = inRex(t, dir);
  rex.script({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }] });
  rex.rexFails("session.new_layer");

  const first = start(rex, dir, task);
  const ended = await finished(dir, task, first.id);

  assert.deepEqual({ failure: ended.failure, changedPaths: ended.changedPaths }, { failure: null, changedPaths: ["src/a.ts"] });
  assert.match(readFileSync(join(dir, RUNS_DIR, first.id, "worker.log"), "utf8"), /^Rex 窗格用不了（session\.new_layer：.*），改在后台执行\n$/);
  // 后台执行的 Pi 是 rpc 模式。
  assert.ok(rex.piLog()[0].args.includes("--mode"));
  assert.ok(!existsSync(join(dir, RUNS_DIR, first.id, "pane.json")));
});

test("窗格里的 Pi 没有开始就退出时，照旧在后台执行", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  // 窗格里的那一次直接退出；后台的那一次不看 paneExit。
  rex.script({ paneExit: true, texts: ["后台做完了。"] });

  const run = start(rex, dir, task);
  const ended = await finished(dir, task, run.id);

  assert.equal(ended.failure, null);
  assert.equal(readFileSync(join(dir, RUNS_DIR, run.id, "report.md"), "utf8"), "后台做完了。");
  assert.match(readFileSync(join(dir, RUNS_DIR, run.id, "worker.log"), "utf8"), /^Rex 窗格用不了（执行者没有在窗格里开始），改在后台执行\n$/);
  assert.deepEqual(rex.panes(), []);
});

test("窗格里的报告读不出来时补报一次", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({});
  await finished(dir, task, start(rex, dir, task).id);
  const pass = '审查通过。\n\n```json\n{ "verdict": "pass" }\n```';
  rex.script({ texts: ["忘了写结论。", pass] });

  const review = start(rex, dir, task);
  const ended = await finished(dir, task, review.id);

  assert.deepEqual({ stage: ended.stage, verdict: ended.verdict, failure: ended.failure }, { stage: "review", verdict: "pass", failure: null });
  assert.equal(readFileSync(join(dir, RUNS_DIR, review.id, "report.md"), "utf8"), pass);
  const messages = rex.piLog().filter((line) => line.message !== undefined);
  assert.match(messages.at(-1).message, /^上一条消息里的报告读不出来：\n- 报告结尾没有能解析的 json 代码块\n/);
});

test("模型不认识时窗格里的执行记为启动失败，不回退", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({ failStart: true });

  const run = start(rex, dir, task);
  const ended = await finished(dir, task, run.id);

  assert.equal(ended.failure, "执行者启动失败：Pi 里没有模型 fake/model");
  assert.equal(rex.piLog().filter((line) => line.message !== undefined).length, 0);
  assert.equal(readFileSync(join(dir, RUNS_DIR, run.id, "worker.log"), "utf8"), "");
});

test("模型请求出错时，窗格里记的失败原因和后台执行一样", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({ modelError: "Connection error." });

  const run = start(rex, dir, task);
  const ended = await finished(dir, task, run.id);

  assert.equal(ended.failure, "执行者出错：Connection error.");
  assert.equal(rex.piLog().filter((line) => line.message !== undefined).length, 1);
  assert.ok(!existsSync(join(dir, RUNS_DIR, run.id, "report.md")));
});

test("模型请求先出错两次、重试之后成功时，窗格执行照常读报告和结论", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({});
  await finished(dir, task, start(rex, dir, task).id);
  const logCursor = rex.piLog().length;
  const report = '审查通过。\n\n```json\n{ "verdict": "pass" }\n```';
  rex.script({ retryErrors: ["Claude: Service Unavailable (error)", "Claude: Service Unavailable (error)"], texts: [report] });

  const run = start(rex, dir, task);
  const ended = await finished(dir, task, run.id);

  assert.deepEqual(
    { id: ended.id, stage: ended.stage, verdict: ended.verdict, failure: ended.failure },
    { id: run.id, stage: "review", verdict: "pass", failure: null },
  );
  assert.notEqual(ended.endedAt, null);
  assert.equal(readFileSync(join(dir, RUNS_DIR, run.id, "report.md"), "utf8"), report);
  assert.equal(
    rex.piLog().slice(logCursor).filter((line) => line.message !== undefined).length,
    1,
  );
});

test("后台进程不在了、窗格里的执行者还在时，状态里指出窗格", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({ waitFor: join(rex.outside, "never") });

  const run = start(rex, dir, task);
  // 等到执行者收到第一条消息：窗格里的 Pi 登记之后还要看一眼后台进程在不在，那之前杀掉后台进程它会自己退出。
  await waitUntil(() => rex.piLog().some((line) => line.message !== undefined), "执行者在窗格里收到第一条消息");
  const { pid } = JSON.parse(readFileSync(join(dir, RUNS_DIR, run.id, "worker.json"), "utf8"));
  process.kill(pid, "SIGKILL");
  await waitUntil(() => spawnSync("kill", ["-0", String(pid)]).status !== 0, `后台进程 ${pid} 退出`);

  const status = rex.knit("run", "status", task.id);
  assert.equal(
    status.stdout,
    `任务: 加问候语（${task.id}）\n状态: active(implement)\n${worktreeLine(dir, task)}` +
      `执行 ${run.id} 的进程已经不在了，没有正常结束；运行 knit run cancel ${task.id} 记为失败\n` +
      `窗格: Rex 里标着 knit ${run.id} 的浮动窗格还开着，执行者还在里面；knit run cancel 会把它一起停掉\n`,
  );

  const cancelled = rex.knit("run", "cancel", task.id);
  assert.equal(cancelled.stdout, `执行 ${run.id} 的进程已经不在了，已记为失败\n改动文件: 0 个\n`);
  await waitUntil(() => processesOf(run.id).length === 0, `执行 ${run.id} 的进程退出`);
});

test("在窗格里中止之后执行不结束，接着输入就接着做完", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  const resume = join(rex.outside, "resume");
  rex.script({ aborted: true, resumeOn: resume, texts: ["接着做完了。"] });

  const run = start(rex, dir, task);
  await waitUntil(() => rex.piLog().some((line) => line.notify !== undefined), "扩展提示执行者被中止");
  await sleep(300);

  assert.equal(lastRun(dir, task).endedAt, null);
  const status = rex.knit("run", "status", task.id);
  assert.match(status.stdout, new RegExp(`\\n正在跑: 实现（${run.id}），开始于 .*\\n会话记录: .*\\n窗格: Rex 里标着 knit ${run.id} 的浮动窗格（最小化着）\\n$`));
  assert.ok(!existsSync(join(dir, RUNS_DIR, run.id, "report.md")));

  writeFileSync(resume, "");
  const ended = await finished(dir, task, run.id);
  assert.equal(ended.failure, null);
  assert.equal(readFileSync(join(dir, RUNS_DIR, run.id, "report.md"), "utf8"), "接着做完了。");
});

test("取消时窗格里的执行者也被停掉；窗格被关掉时记为失败", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }], waitFor: join(rex.outside, "never") });

  const first = start(rex, dir, task);
  await waitUntil(() => existsSync(join(worktreeOf(dir, task), "src/a.ts")), "假 Pi 写出 src/a.ts");
  // 后台进程和窗格里的假 Pi。
  assert.equal(processesOf(first.id).length, 2);
  const cancelled = rex.knit("run", "cancel", task.id);

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `已取消 ${task.id} 的执行 ${first.id}\n改动文件: 1 个\n`);
  assert.equal(lastRun(dir, task).failure, "已取消");
  assert.equal(processesOf(first.id).length, 0);

  const second = start(rex, dir, task);
  await waitUntil(() => existsSync(join(dir, RUNS_DIR, second.id, "pane.json")), "执行者在窗格里开始");
  const layer = rex.calls().findLast((call) => call.method === "session.new_layer");
  assert.equal(layer.params.layout.block.label, `knit ${second.id}`);
  // 用户把窗格关掉。假的 rex 没有常驻的服务，第一次被取消的窗格的文件还留着，新的排在最后。
  const layerId = `layer:${rex.panes().at(-1).replace(".json", "")}`;
  const closed = spawnSync(FAKE_REX, ["api", "call", "session.close_layer", JSON.stringify({ session_id: "s", layer_id: layerId })], {
    encoding: "utf8",
    env: { ...process.env, KNIT_FAKE_REX: join(rex.outside, "rex-home") },
  });
  assert.equal(closed.status, 0, closed.stderr);
  const ended = await finished(dir, task, second.id);
  assert.equal(ended.failure, "执行者的窗格关掉了，没有交报告");
});

test("执行者还没有在窗格里开始就取消时，它不会再开始", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const rex = inRex(t, dir);
  rex.script({ startDelay: 1500, writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }] });

  const run = start(rex, dir, task);
  await waitUntil(() => rex.panes().length === 1, "窗格开出来");
  const cancelled = rex.knit("run", "cancel", task.id);

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `已取消 ${task.id} 的执行 ${run.id}\n改动文件: 0 个\n`);
  assert.ok(!existsSync(join(dir, RUNS_DIR, run.id, "pane.json")));
  // 窗格里的 Pi 这时才起来：后台进程已经不在了，它不发消息就退出。
  await waitUntil(() => processesOf(run.id).length === 0, "窗格里的 Pi 退出");
  assert.deepEqual(rex.piLog().filter((line) => line.message !== undefined), []);
  assert.ok(!existsSync(join(dir, "src/a.ts")));
  assert.ok(!existsSync(join(worktreeOf(dir, task), "src/a.ts")));
});
