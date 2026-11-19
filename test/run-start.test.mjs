import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RUNS_DIR } from "../dist/application/run-prepare.js";
import { knit } from "./helpers/cli.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";

const CLI = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
const lastRun = (dir, task) => JSON.parse(readFileSync(join(dir, task.dir, "record.json"), "utf8")).runs.at(-1);

/** 假 Pi 的脚本放在项目目录之外；返回写脚本的函数、运行 knit 的函数和这个目录。 */
function fakePi(t, dir, environment = {}) {
  const outside = mkdtempSync(join(tmpdir(), "knit-fake-pi-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const env = {
    ...process.env,
    KNIT_PI_BIN: FAKE_PI,
    KNIT_FAKE_PI: join(outside, "script.json"),
    KNIT_FAKE_PI_LOG: join(outside, "pi.jsonl"),
    ...environment,
  };
  return {
    outside,
    script: (script) => writeFileSync(env.KNIT_FAKE_PI, JSON.stringify(script)),
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
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** 等这次执行在记录里结束、后台进程退出；返回记录里的这一项。 */
async function finished(dir, task, runId) {
  await waitUntil(() => lastRun(dir, task).endedAt !== null, `执行 ${runId} 结束`);
  const { pid } = JSON.parse(readFileSync(join(dir, RUNS_DIR, runId, "worker.json"), "utf8"));
  await waitUntil(() => !alive(pid), `后台进程 ${pid} 退出`);
  const run = lastRun(dir, task);
  assert.equal(run.id, runId);
  return run;
}
const startedRunId = (stdout) => stdout.match(/（(r-[0-9a-f]{12})）/)[1];

test("派发后立即返回，执行者在后台做完", async (t) => {
  const dir = runProject(t);
  const task = readyTask(dir);
  const pi = fakePi(t, dir);
  pi.script({ writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }] });

  const started = pi.knit("run", "start", task.id);
  assert.equal(started.code, 0, started.stderr);
  const runId = lastRun(dir, task).id;
  const runDir = `${RUNS_DIR}/${runId}`;
  assert.equal(started.stdout, `已派发 ${task.id}：实现（${runId}）\n会话记录：${runDir}/session/\n`);
  const worker = JSON.parse(readFileSync(join(dir, runDir, "worker.json"), "utf8"));
  assert.ok(Number.isInteger(worker.pid) && worker.pid > 0);
  assert.equal(typeof worker.start, "string");

  const run = await finished(dir, task, runId);
  assert.equal(run.failure, null);
  assert.deepEqual(run.changedPaths, ["src/a.ts"]);
  assert.equal(readFileSync(join(dir, runDir, "report.md"), "utf8"), "做完了。");
  assert.equal(readFileSync(join(dir, runDir, "worker.log"), "utf8"), "");
});

[
  { name: "没有配置时用主会话的模型", top: null, stage: null, override: null, expected: "p/m" },
  { name: "顶层模型优先于主会话", top: "top/m", stage: null, override: null, expected: "top/m" },
  { name: "环节模型优先于顶层和主会话", top: "top/m", stage: "stage/m", override: null, expected: "stage/m" },
  { name: "--model 优先于环节、顶层和主会话", top: "top/m", stage: "stage/m", override: "cli/m", expected: "cli/m" },
].forEach((scenario) => {
  test(scenario.name, async (t) => {
    const dir = runProject(t);
    const workflow = join(dir, ".knit/workflow.yaml");
    writeFileSync(
      workflow,
      readFileSync(workflow, "utf8")
        .replace("model: fake/model\n", scenario.top === null ? "" : `model: ${scenario.top}\n`)
        .replace("    name: 实现\n", `    name: 实现\n${scenario.stage === null ? "" : `    model: ${scenario.stage}\n`}`),
    );
    const task = readyTask(dir);
    const pi = fakePi(t, dir, { PI_PROVIDER: "p", PI_MODEL: "m" });
    pi.script({});

    const started = pi.knit("run", "start", task.id, ...(scenario.override === null ? [] : ["--model", scenario.override]));
    assert.equal(started.code, 0, started.stderr);
    assert.equal((await finished(dir, task, startedRunId(started.stdout))).failure, null);
    const { args } = JSON.parse(readFileSync(join(pi.outside, "pi.jsonl"), "utf8").split("\n")[0]);
    assert.equal(`${args[args.indexOf("--provider") + 1]}/${args[args.indexOf("--model") + 1]}`, scenario.expected);
  });
});

[
  { name: "没有配置时用主会话的思考等级", top: null, stage: null, override: null, session: "high", expected: "high" },
  { name: "顶层思考等级优先于主会话", top: "low", stage: null, override: null, session: "high", expected: "low" },
  { name: "环节思考等级优先于顶层和主会话", top: "low", stage: "max", override: null, session: "high", expected: "max" },
  { name: "--thinking 优先于环节、顶层和主会话", top: "low", stage: "max", override: "off", session: "high", expected: "off" },
  { name: "四处都没有思考等级时派发成功且不传 --thinking", top: null, stage: null, override: null, session: undefined, expected: null },
].forEach((scenario) => {
  test(scenario.name, async (t) => {
    const dir = runProject(t);
    const workflow = join(dir, ".knit/workflow.yaml");
    writeFileSync(
      workflow,
      readFileSync(workflow, "utf8")
        .replace("version: 1\n", `version: 1\n${scenario.top === null ? "" : `thinking: ${scenario.top}\n`}`)
        .replace("    name: 实现\n", `    name: 实现\n${scenario.stage === null ? "" : `    thinking: ${scenario.stage}\n`}`),
    );
    const task = readyTask(dir);
    const pi = fakePi(t, dir, { PI_REASONING_LEVEL: scenario.session });
    pi.script({});

    const started = pi.knit("run", "start", task.id, ...(scenario.override === null ? [] : ["--thinking", scenario.override]));
    assert.equal(started.code, 0, started.stderr);
    assert.equal((await finished(dir, task, startedRunId(started.stdout))).failure, null);
    const { args } = JSON.parse(readFileSync(join(pi.outside, "pi.jsonl"), "utf8").split("\n")[0]);
    assert.equal(args.includes("--thinking"), scenario.expected !== null);
    if (scenario.expected !== null) assert.equal(args[args.indexOf("--thinking") + 1], scenario.expected);
    assert.equal(Object.hasOwn(lastRun(dir, task), "thinking"), false);
    assert.doesNotMatch(pi.knit("run", "status", task.id).stdout, /thinking|思考等级/);
  });
});

[
  { PI_PROVIDER: undefined, PI_MODEL: undefined },
  { PI_PROVIDER: "p", PI_MODEL: undefined },
  { PI_PROVIDER: undefined, PI_MODEL: "m" },
].forEach((environment) => {
  test(`没有完整的主会话模型时拒绝：${JSON.stringify(environment)}`, (t) => {
    const dir = runProject(t);
    const workflow = join(dir, ".knit/workflow.yaml");
    writeFileSync(workflow, readFileSync(workflow, "utf8").replace("model: fake/model\n", ""));
    const task = readyTask(dir);
    const before = ["task.md", "record.json"].map((file) => readFileSync(join(dir, task.dir, file), "utf8"));
    const pi = fakePi(t, dir, environment);

    const refused = pi.knit("run", "start", task.id);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr,
      "没有指定执行者的模型：不在 Pi 会话里时，在 .knit/workflow.yaml 里写 model，或加 --model provider/模型\n",
    );
    assert.equal(existsSync(join(dir, RUNS_DIR)), false);
    assert.deepEqual(["task.md", "record.json"].map((file) => readFileSync(join(dir, task.dir, file), "utf8")), before);
  });
});

test("不能派发时不启动进程", (t) => {
  const dir = runProject(t);
  const pi = fakePi(t, dir);
  const id = knit(dir, "task", "new", "--title", "还没确认").stdout.split("\n")[0].replace("已创建 ", "");

  const refused = pi.knit("run", "start", id);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, `需求还没有确认，或确认之后改过；先运行 knit task ready ${id}\n`);
  assert.equal(existsSync(join(dir, RUNS_DIR)), false);
});

test("执行者还在跑时不能再派发", async (t) => {
  const dir = runProject(t);
  const first = readyTask(dir);
  const second = readyTask(dir);
  const pi = fakePi(t, dir);
  const gate = join(pi.outside, "go");
  pi.script({ waitFor: gate });

  const started = pi.knit("run", "start", first.id);
  assert.equal(started.code, 0, started.stderr);
  const runId = startedRunId(started.stdout);
  const refused = pi.knit("run", "start", second.id);
  assert.equal(refused.code, 1);
  assert.equal(
    refused.stderr,
    `任务 ${first.id} 的执行 ${runId} 还没有结束；等它结束，或运行 knit run cancel ${first.id}\n`,
  );
  assert.equal(lastRun(dir, first).endedAt, null);

  writeFileSync(gate, "");
  assert.equal((await finished(dir, first, runId)).failure, null);
  const next = pi.knit("run", "start", second.id);
  assert.equal(next.code, 0, next.stderr);
  assert.equal((await finished(dir, second, startedRunId(next.stdout))).failure, null);
});
