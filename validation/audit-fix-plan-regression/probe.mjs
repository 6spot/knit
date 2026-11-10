#!/usr/bin/env node
/**
 * 审计修复总计划（k-2c0d10318898）§5 回归场景的 CLI 级探针。
 *
 * 每条场景在系统临时目录新建 Git 项目，只通过编译产物 dist/cli/knit.js 的公开命令驱动，
 * 阶段 Agent 用 test/fixtures/fake-pi.mjs 代替真实模型。HOME 与 KNIT_KEYS_ROOT 指向临时目录，
 * 不读写本机 ~/.knit 下的锁与凭据密钥。
 *
 * 用法：node validation/audit-fix-plan-regression/probe.mjs [输出 JSON 路径]
 */
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO, "dist", "cli", "knit.js");
const FAKE_PI = join(REPO, "test", "fixtures", "fake-pi.mjs");
const FAKE_REX = join(REPO, "test", "fixtures", "fake-rex.mjs");
const BRANCH = "refs/heads/main";
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "knit-audit-regress-")));
const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "probe-output.json");

for (const name of ["home", "keys", "aux"]) mkdirSync(join(ROOT, name), { recursive: true });

const BASE_ENV = { ...process.env, HOME: join(ROOT, "home"), KNIT_KEYS_ROOT: join(ROOT, "keys"), KNIT_PI_BIN: FAKE_PI };
for (const key of Object.keys(BASE_ENV)) {
  if (/^(KNIT_STAGE_RUN_ID|KNIT_RUN|KNIT_LOCKS_ROOT|REX_.*|KNIT_FAKE_.*)$/.test(key)) delete BASE_ENV[key];
}

const results = [];
let auxCounter = 0;

function record(scenario, name, pass, actual) {
  results.push({ scenario, check: name, pass: Boolean(pass), actual });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  [${scenario}] ${name}${pass ? "" : `\n      actual: ${JSON.stringify(actual)?.slice(0, 600)}`}\n`);
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: BASE_ENV }).trim();
}

/** 调用 knit CLI（--json），返回退出码与解析后的回执。 */
function knit(dir, args, env = {}) {
  const run = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...BASE_ENV, ...env },
    timeout: 120_000,
  });
  let body = null;
  try {
    body = JSON.parse(run.stdout);
  } catch {
    body = null;
  }
  return { code: run.status, body, data: body?.data ?? null, text: `${run.stdout}\n${run.stderr}` };
}

function project(name, { gitignore = null, workflow = null, checkWrite = false } = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "probe@example.com"]);
  git(dir, ["config", "user.name", "probe"]);
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  const init = knit(dir, ["init", "--pi"]);
  if (init.code !== 0) throw new Error(`knit init 失败: ${init.text}`);
  if (gitignore) writeFileSync(join(dir, ".gitignore"), gitignore);
  const workflowFile = join(dir, ".knit", "workflow.yaml");
  if (workflow) writeFileSync(workflowFile, workflow);
  if (checkWrite) {
    const text = readFileSync(workflowFile, "utf8");
    const next = text.replace(/(id: check[\s\S]*?tools: )\[read, exec\]/, "$1[read, write, exec]");
    if (next === text) throw new Error("未找到 check 阶段的 tools: [read, exec]");
    writeFileSync(workflowFile, next);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "knit init"]);
  return dir;
}

function newTask(dir, title, verification = "self") {
  const created = knit(dir, ["task", "new", "--title", title, "--slug", title, "--verification", verification]);
  if (created.code !== 0) throw new Error(`task new 失败: ${created.text}`);
  const ready = knit(dir, ["task", "ready", created.data.taskId]);
  if (ready.code !== 0) throw new Error(`task ready 失败: ${ready.text}`);
  return created.data;
}

function actionFile(action) {
  const path = join(ROOT, "aux", `action-${++auxCounter}.json`);
  writeFileSync(path, JSON.stringify(action));
  return path;
}

function auxPath(name) {
  return join(ROOT, "aux", `${++auxCounter}-${name}`);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(probe, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await sleep(100);
  }
}

function runStatus(dir, runId) {
  return knit(dir, ["status", "--run", runId]).data;
}

async function settled(dir, runId) {
  return waitFor(() => {
    const status = runStatus(dir, runId);
    if (!status || !["completed", "failed", "cancelled"].includes(status.state)) return null;
    return alive(status.handle?.pid) ? null : status;
  }, `run ${runId} 终态`);
}

/** 启动一个阶段 run 并等到终态；返回状态视图。 */
async function stage(dir, phase, taskId, action, { env = {}, local = true } = {}) {
  const args = ["run", phase, "--task", taskId, "--provider", "fake", "--model", "fake-model", "--wait"];
  if (local) args.push("--local");
  const started = knit(dir, args, { KNIT_FAKE_ACTION: actionFile(action), ...env });
  const runId = started.data?.request?.runId;
  if (!runId) throw new Error(`run ${phase} 未返回 runId: ${started.text}`);
  return { started: started.data, status: await settled(dir, runId), runId };
}

/** 启动后停在 waitFile 的 run：返回 runId 与放行信号文件。 */
async function held(dir, taskId, action) {
  const signal = auxPath("go");
  const promptFile = auxPath("prompt.txt");
  const started = knit(dir, ["run", "implement", "--task", taskId, "--provider", "fake", "--model", "fake-model", "--local"], {
    KNIT_FAKE_ACTION: actionFile({ waitFile: relative(dir, signal), waitTimeoutMs: 120_000, ...action }),
    KNIT_FAKE_PROMPT_FILE: promptFile,
  });
  const runId = started.data?.request?.runId;
  if (!runId) throw new Error(`run implement 未返回 runId: ${started.text}`);
  await waitFor(() => existsSync(promptFile) && runStatus(dir, runId)?.stageProcess?.piPid, "阶段 Pi 收到提示词");
  return { runId, signal };
}

function taskFile(dir, task) {
  return join(dir, ".knit", task.relativePath);
}

function stageOf(dir, task) {
  return /^stage: (.+)$/m.exec(readFileSync(taskFile(dir, task), "utf8"))?.[1] ?? null;
}

function scopePaths(dir, taskId) {
  const file = join(dir, ".knit", ".runtime", "tasks", taskId, "scope.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")).entries.map((entry) => entry.path).sort();
}

function messageFile(subject) {
  const path = auxPath("message.txt");
  writeFileSync(path, `${subject}\n\n探针交付。\n`);
  return path;
}

function deliver(dir, taskId, extra = []) {
  return knit(dir, ["deliver", taskId, "--branch", BRANCH, "--message-file", messageFile(`probe ${taskId}`), ...extra]);
}

const PASS_REPORT = { summary: "核对通过", verdict: "pass", coverage: ["README.md"], findings: [], unverified: [] };

const scenarios = {
  async "1 阶段内 git commit"() {
    const dir = project("s01");
    const task = newTask(dir, "commit");
    const base = git(dir, ["rev-parse", "HEAD"]);
    const { status } = await stage(dir, "implement", task.taskId, {
      writes: [{ path: "h.txt", content: "h\n" }],
      exec: [["git", "add", "h.txt"], ["git", "-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "in-stage"]],
      report: { summary: "提交了 h.txt", changedPaths: [] },
    });
    record(1, "夹具确实在阶段内产生了提交", git(dir, ["rev-parse", "HEAD"]) !== base, null);
    record(1, "run 失败，原因 head_moved_during_stage", status.state === "failed" && status.result?.failureReason === "head_moved_during_stage", { state: status.state, reason: status.result?.failureReason });
    record(1, "边界记录 headMoved 与阶段内提交", status.result?.boundary?.headMoved === true && status.result.boundary.commits.length === 1, status.result?.boundary);
    record(1, "任务不前进、不并入 scope", stageOf(dir, task) === "implement" && scopePaths(dir, task.taskId).length === 0, { stage: stageOf(dir, task), scope: scopePaths(dir, task.taskId) });
  },

  async "2 写受保护运行时路径与 ignored 目录"() {
    for (const [name, path] of [["s02a", ".git/hooks/pre-commit"], ["s02b", ".knit/.runtime/checks/x.json"]]) {
      const dir = project(name);
      const task = newTask(dir, "protected");
      const { status } = await stage(dir, "implement", task.taskId, {
        writes: [{ path: "README.md", content: "# changed\n" }, { path, content: "#!/bin/sh\necho pwned\n" }],
        report: { summary: "改了 README", changedPaths: ["README.md"] },
      });
      record(2, `写 ${path} → protected_runtime_modified`, status.state === "failed" && status.result?.failureReason === `protected_runtime_modified:${path}`, { state: status.state, reason: status.result?.failureReason });
      record(2, `写 ${path} 后任务不前进`, stageOf(dir, task) === "implement" && scopePaths(dir, task.taskId).length === 0, { stage: stageOf(dir, task) });
    }
    const dir = project("s02c", { gitignore: "node_modules/\n" });
    const task = newTask(dir, "ignored");
    const { status } = await stage(dir, "implement", task.taskId, {
      writes: [{ path: "README.md", content: "# changed\n" }, { path: "node_modules/pkg/index.js", content: "module.exports = 1;\n" }],
      report: { summary: "改了 README", changedPaths: ["README.md"] },
    });
    record(2, "写 node_modules/ → 正常接收", status.state === "completed" && status.acceptance?.state === "completed", { state: status.state, reason: status.result?.failureReason, acceptance: status.acceptance });
    record(2, "ignoredChanges 有记录", (status.result?.ignoredChanges ?? []).length > 0, status.result?.ignoredChanges);
  },

  async "3 改动归属：用户并发写入与来源不明"() {
    const dir = project("s03a");
    const task = newTask(dir, "external");
    const { status } = await stage(dir, "implement", task.taskId, {
      writes: [{ path: "README.md", content: "# agent\n" }],
      external: [{ path: "user.txt", content: "user\n" }],
      report: { summary: "只改了 README", changedPaths: ["README.md"] },
    });
    record(3, "用户写入且 Agent 未列 → 接收成功", status.state === "completed" && status.acceptance?.state === "completed", { state: status.state, reason: status.result?.failureReason, acceptance: status.acceptance });
    record(3, "user.txt 进 externalChanges，不进 scope", JSON.stringify(status.result?.externalChanges ?? []).includes("user.txt") && JSON.stringify(scopePaths(dir, task.taskId)) === '["README.md"]', { external: status.result?.externalChanges, scope: scopePaths(dir, task.taskId) });
    const closed = knit(dir, ["task", "close", task.taskId, "--outcome", "completed", "--reason", "探针"]);
    const delivered = deliver(dir, task.taskId);
    const work = delivered.data?.workCommit;
    const files = work ? git(dir, ["show", "--name-only", "--format=", work]).split("\n") : [];
    record(3, "产物提交只含 README.md，user.txt 仍未跟踪", closed.code === 0 && delivered.data?.state === "completed" && JSON.stringify(files) === '["README.md"]' && git(dir, ["status", "--porcelain", "user.txt"]).startsWith("??"), { closed: closed.body, delivered: delivered.body, files });

    const dir2 = project("s03b");
    const task2 = newTask(dir2, "unattributed");
    const second = await stage(dir2, "implement", task2.taskId, {
      writes: [{ path: "README.md", content: "# agent\n" }, { path: "gen.txt", content: "gen\n", via: "bash" }],
      report: { summary: "生成 gen.txt", changedPaths: ["README.md", "gen.txt"] },
    });
    record(3, "Agent 列出但非工具写入 → needs_attention unattributed_paths", second.status.acceptance?.state === "needs_attention" && second.status.acceptance.reason === "unattributed_paths:gen.txt", { state: second.status.state, acceptance: second.status.acceptance, reason: second.status.result?.failureReason });
    record(3, "来源不明时任务不前进、scope 为空", stageOf(dir2, task2) === "implement" && scopePaths(dir2, task2.taskId).length === 0, { stage: stageOf(dir2, task2), scope: scopePaths(dir2, task2.taskId) });
    const wrong = knit(dir2, ["run", "accept", second.runId, "--include", "README.md"]);
    record(3, "include 非来源不明路径 → 拒绝（path_not_unattributed），scope 不变", wrong.code !== 0 && wrong.text.includes("不是该 run 来源不明的路径: README.md") && JSON.stringify(scopePaths(dir2, task2.taskId)) === "[]", wrong.body);
    const accepted = knit(dir2, ["run", "accept", second.runId, "--include", "gen.txt", "--reason", "探针确认"]);
    record(3, "--include 确认后并入 scope，任务前进", accepted.code === 0 && JSON.stringify(scopePaths(dir2, task2.taskId)) === '["README.md","gen.txt"]' && stageOf(dir2, task2) === "deliver", { accepted: accepted.body, scope: scopePaths(dir2, task2.taskId), stage: stageOf(dir2, task2) });
  },

  async "4 失败 run 残留，下一轮声明继承"() {
    const dir = project("s04");
    const task = newTask(dir, "residue");
    const first = await stage(dir, "implement", task.taskId, {
      writes: [{ path: "src.txt", content: "partial\n" }, { path: "README.md", content: "# partial\n" }],
      report: { summary: "列错路径", changedPaths: ["src.txt", "README.md", "missing.txt"] },
    });
    record(4, "第一轮失败（changed_paths_mismatch），文件留在工作区", first.status.state === "failed" && /^changed_paths_mismatch:/.test(first.status.result?.failureReason ?? "") && existsSync(join(dir, "src.txt")), { state: first.status.state, reason: first.status.result?.failureReason });
    const second = await stage(dir, "implement", task.taskId, {
      writes: [{ path: "src.txt", content: "done\n" }, { path: "more.txt", content: "more\n" }],
      report: { summary: "续做并继承残留", changedPaths: ["src.txt", "README.md", "more.txt"] },
    });
    record(4, "第二轮声明继承 → 接收成功", second.status.state === "completed" && second.status.acceptance?.state === "completed", { state: second.status.state, reason: second.status.result?.failureReason, acceptance: second.status.acceptance });
    record(4, "README.md 记为继承路径，scope 含三个路径", JSON.stringify(second.status.result?.attribution?.inheritedPaths) === '["README.md"]' && JSON.stringify(scopePaths(dir, task.taskId)) === '["README.md","more.txt","src.txt"]', { inherited: second.status.result?.attribution?.inheritedPaths, scope: scopePaths(dir, task.taskId) });
  },

  async "5 检查阶段写入约束"() {
    const dir = project("s05a");
    const task = newTask(dir, "readonly-check", "independent");
    await stage(dir, "implement", task.taskId, { writes: [{ path: "README.md", content: "# impl\n" }], report: { summary: "实现", changedPaths: ["README.md"] } });
    const denied = await stage(dir, "check", task.taskId, {
      writes: [{ path: "README.md", content: "# renamed by checker\n", via: "bash" }],
      report: { ...PASS_REPORT, changedPaths: ["README.md"], selfVerified: true },
    });
    record(5, "[read, exec] 检查阶段写文件 → write_without_capability", denied.status.state === "failed" && denied.status.result?.failureReason === "write_without_capability:README.md", { state: denied.status.state, reason: denied.status.result?.failureReason });
    record(5, "被拒的检查不产生 pass 凭据，任务停在 check", denied.status.acceptance?.reason !== "check_pass" && stageOf(dir, task) === "check", { acceptance: denied.status.acceptance, stage: stageOf(dir, task) });

    const dir2 = project("s05b", { checkWrite: true });
    const task2 = newTask(dir2, "writable-check", "independent");
    await stage(dir2, "implement", task2.taskId, { writes: [{ path: "README.md", content: "# impl\n" }], report: { summary: "实现", changedPaths: ["README.md"] } });
    const fix = await stage(dir2, "check", task2.taskId, {
      writes: [{ path: "README.md", content: "# fixed by checker\n" }],
      report: { ...PASS_REPORT, changedPaths: ["README.md"], selfVerified: true, findings: ["README 有误，已修"] },
    });
    record(5, "允许写的检查阶段修复后 pass → 接收为 check_pass", fix.status.state === "completed" && fix.status.acceptance?.reason === "check_pass", { state: fix.status.state, reason: fix.status.result?.failureReason, acceptance: fix.status.acceptance });
    record(5, "状态视图标注检查者修复", JSON.stringify(fix.status.checkerChangedPaths) === '["README.md"]' && /修复部分为自检/.test(fix.status.verificationLabel ?? ""), { checkerChangedPaths: fix.status.checkerChangedPaths, label: fix.status.verificationLabel });
    const closeDenied = knit(dir2, ["task", "close", task2.taskId, "--outcome", "completed"]);
    record(5, "independent 完成被 check_self_modified 拒绝", closeDenied.code !== 0 && closeDenied.text.includes("check_self_modified"), closeDenied.body);
    const deliverDenied = deliver(dir2, task2.taskId);
    record(5, "交付同样被 check_self_modified 拒绝", deliverDenied.code !== 0 && deliverDenied.text.includes("check_self_modified"), deliverDenied.body);
    const recheck = await stage(dir2, "check", task2.taskId, { report: { ...PASS_REPORT, summary: "复查通过" } });
    const closed = knit(dir2, ["task", "close", task2.taskId, "--outcome", "completed"]);
    const delivered = deliver(dir2, task2.taskId);
    // 产物提交正文取自 --message-file，验证事实在尾注；「验证」行由 Knit 写在资料提交。
    const body = delivered.data?.metadataCommit ? git(dir2, ["log", "-1", "--format=%B", delivered.data.metadataCommit]) : "";
    const trailer = delivered.data?.workCommit ? git(dir2, ["log", "-1", "--format=%(trailers:key=Knit-Verification,valueonly)", delivered.data.workCommit]) : "";
    record(5, "无改动复查 pass 后可完成并交付", recheck.status.acceptance?.reason === "check_pass" && closed.code === 0 && delivered.data?.state === "completed", { recheck: recheck.status.acceptance, closed: closed.body, delivered: delivered.body });
    record(5, "提交如实标注 independent 与检查 run（资料提交「验证」行、产物提交尾注）", body.includes(`验证：independent — 检查 ${recheck.runId} 通过`) && !body.includes("自检") && trailer === "independent", { body, trailer });
  },

  async "6 空 scope 的 self 任务"() {
    const dir = project("s06");
    const task = newTask(dir, "empty");
    const { status } = await stage(dir, "implement", task.taskId, { report: { summary: "无改动", changedPaths: [] } });
    record(6, "空报告的实施 run 被接收，scope 为空，并提示未产生成果", status.acceptance?.state === "completed" && scopePaths(dir, task.taskId).length === 0 && /本轮未产生成果/.test(status.noOutputNotice ?? ""), { acceptance: status.acceptance, notice: status.noOutputNotice });
    const denied = knit(dir, ["task", "close", task.taskId, "--outcome", "completed"]);
    record(6, "close → empty_scope", denied.code !== 0 && denied.text.includes("empty_scope"), denied.body);
    const deliverDenied = deliver(dir, task.taskId);
    record(6, "deliver 同一守卫 → empty_scope", deliverDenied.code !== 0 && deliverDenied.text.includes("empty_scope"), deliverDenied.body);
    const closed = knit(dir, ["task", "close", task.taskId, "--outcome", "completed", "--no-artifacts", "--reason", "只核对现状，无需改动"]);
    const delivered = deliver(dir, task.taskId);
    record(6, "--no-artifacts --reason 后可完成，交付如实标注无产物提交", closed.code === 0 && delivered.data?.state === "completed" && delivered.data.workCommit === null && delivered.data.noArtifactCommit === true, { closed: closed.body, delivered: delivered.body });
  },

  async "7 杀 worker 后自动回收锁并 resume"() {
    const dir = project("s07");
    const task = newTask(dir, "killed");
    const old = await held(dir, task.taskId, { writes: [{ path: "README.md", content: "# orphan\n" }], report: { summary: "不应完成", changedPaths: ["README.md"] } });
    const before = runStatus(dir, old.runId);
    const workerPid = before.handle?.pid;
    const piPid = before.stageProcess?.piPid;
    process.kill(workerPid, "SIGKILL");
    await waitFor(() => !alive(workerPid) && !alive(piPid), "worker 与阶段 Pi 退出");
    const stale = knit(dir, ["locks"]).data;
    record(7, "worker 被杀后留下已死进程的残留锁", stale.entries.length > 0 && stale.entries.every((entry) => entry.processVerdict === "not_alive"), stale.entries.map((entry) => ({ scope: entry.scope, verdict: entry.processVerdict })));
    const created = knit(dir, ["task", "new", "--title", "after-kill", "--slug", "after-kill"]);
    record(7, "下一条命令（task new）不需手工 unlock 即成功", created.code === 0 && Boolean(created.data?.taskId), created.body);
    const resumed = knit(dir, ["resume", "--run", old.runId, "--wait"], {
      KNIT_FAKE_ACTION: actionFile({ writes: [{ path: "README.md", content: "# recovered\n" }], report: { summary: "恢复完成", changedPaths: ["README.md"] } }),
    });
    const newRunId = resumed.data?.request?.runId ?? resumed.data?.runId ?? resumed.data?.newRunId ?? null;
    record(7, "resume 启动了新 run", resumed.code === 0 && Boolean(newRunId) && newRunId !== old.runId, resumed.body);
    if (!newRunId) return;
    const final = await settled(dir, newRunId);
    record(7, "新 run 真实执行并被接收", final.state === "completed" && final.acceptance?.state === "completed" && readFileSync(join(dir, "README.md"), "utf8") === "# recovered\n" && stageOf(dir, task) === "deliver", { state: final.state, reason: final.result?.failureReason, acceptance: final.acceptance, stage: stageOf(dir, task) });
    const after = knit(dir, ["locks"]).data;
    record(7, "残留锁已自动回收且有回收记录", after.entries.length === 0 && after.reclaimed.length > 0, { entries: after.entries.length, reclaimed: after.reclaimed.map((item) => item.scope) });
  },

  async "8 auto 模式 Rex 未报到回退 local"() {
    const dir = project("s08");
    const task = newTask(dir, "rex");
    const bin = join(ROOT, "aux", "rex-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_REX}" "$@"\n`);
    chmodSync(join(bin, "rex"), 0o755);
    const rexLog = auxPath("fake-rex.log");
    const env = { REX_SESSION: "fake-session", REX_BLOCK: "fake-block", REX_BIN_DIR: bin, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_REX_LOG: rexLog };
    const { started, status } = await stage(dir, "implement", task.taskId, { writes: [{ path: "README.md", content: "# local fallback\n" }], report: { summary: "回退 local 完成", changedPaths: ["README.md"] } }, { env, local: false });
    record(8, "auto 先选中 Rex", started.request.presentation === "rex" && started.request.presentationSource === "auto", { presentation: started.request.presentation, source: started.request.presentationSource });
    record(8, "worker 未报到 → 同一 run 回退 local 并完成接收", status.state === "completed" && status.acceptance?.state === "completed" && status.presentation === "local" && status.presentationFallbackReason === "rex_worker_not_started", { state: status.state, presentation: status.presentation, fallback: status.presentationFallbackReason, reason: status.result?.failureReason });
    record(8, "保留 Rex 启动失败诊断", status.rexDiagnostics != null && existsSync(rexLog), status.rexDiagnostics);
  },

  async "9 clone 后 rebind 可完成"() {
    const origin = project("s09-origin");
    const task = newTask(origin, "rebind");
    git(origin, ["add", "-A"]);
    git(origin, ["commit", "-q", "-m", "add task"]);
    const dir = join(ROOT, "s09-clone");
    git(ROOT, ["clone", "-q", origin, dir]);
    git(dir, ["config", "user.email", "probe@example.com"]);
    git(dir, ["config", "user.name", "probe"]);
    record(9, "clone 后只有 Git 内资料，没有本机运行态", existsSync(taskFile(dir, task)) && !existsSync(join(dir, ".knit", ".runtime", "metadata.db")), null);
    const listed = knit(dir, ["task", "list"]);
    record(9, "task list 指出绑定缺失", JSON.stringify(listed.data?.bindingMissing ?? []).includes(task.taskId), listed.data?.bindingMissing);
    const blocked = knit(dir, ["run", "implement", "--task", task.taskId, "--provider", "fake", "--model", "fake-model", "--local", "--wait"], { KNIT_FAKE_ACTION: actionFile({ report: { summary: "不应执行" } }) });
    record(9, "rebind 前不能派发阶段", blocked.code !== 0, blocked.body);
    const rebind = knit(dir, ["task", "rebind", task.taskId]);
    record(9, "task rebind 成功", rebind.code === 0 && rebind.data?.rebound === true, rebind.body);
    const { status } = await stage(dir, "implement", task.taskId, { writes: [{ path: "README.md", content: "# on clone\n" }], report: { summary: "clone 上实施", changedPaths: ["README.md"] } });
    const closed = knit(dir, ["task", "close", task.taskId, "--outcome", "completed", "--reason", "探针"]);
    const delivered = deliver(dir, task.taskId);
    record(9, "rebind 后可实施、完成并交付", status.acceptance?.state === "completed" && closed.code === 0 && delivered.data?.state === "completed" && Boolean(delivered.data.workCommit), { acceptance: status.acceptance, reason: status.result?.failureReason, closed: closed.body, delivered: delivered.body });
  },

  async "10 凭据完整性、调用边界与 hooks"() {
    // a) 篡改检查凭据。
    const dir = project("s10a");
    const task = newTask(dir, "tamper", "independent");
    await stage(dir, "implement", task.taskId, { writes: [{ path: "README.md", content: "# impl\n" }], report: { summary: "实现", changedPaths: ["README.md"] } });
    const check = await stage(dir, "check", task.taskId, { report: PASS_REPORT });
    const credential = join(dir, ".knit", ".runtime", "checks", `${check.runId}.json`);
    record(10, "检查凭据带本机签名，密钥在项目外", check.status.acceptance?.reason === "check_pass" && existsSync(credential) && JSON.parse(readFileSync(credential, "utf8")).integrity?.alg === "hmac-sha256" && !existsSync(join(dir, ".knit", ".runtime", "keys")), { acceptance: check.status.acceptance, exists: existsSync(credential) });
    const raw = JSON.parse(readFileSync(credential, "utf8"));
    raw.report.coverage = ["README.md", "forged.txt"];
    writeFileSync(credential, `${JSON.stringify(raw, null, 2)}\n`);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const tampered = deliver(dir, task.taskId);
    record(10, "篡改检查凭据 → 交付以 credential_tampered 拒绝，无提交", tampered.code !== 0 && tampered.text.includes("credential_tampered") && git(dir, ["rev-parse", "HEAD"]) === head, tampered.body);
    const closeTampered = knit(dir, ["task", "close", task.taskId, "--outcome", "completed"]);
    record(10, "篡改后 task close 同样拒绝", closeTampered.code !== 0 && closeTampered.text.includes("credential_tampered"), closeTampered.body);

    // a2) 篡改完成凭据。
    const dirC = project("s10a2");
    const taskC = newTask(dirC, "tamper-completion");
    await stage(dirC, "implement", taskC.taskId, { writes: [{ path: "README.md", content: "# impl\n" }], report: { summary: "实现", changedPaths: ["README.md"] } });
    knit(dirC, ["task", "close", taskC.taskId, "--outcome", "completed", "--reason", "探针"]);
    const completion = join(dirC, ".knit", ".runtime", "completions", `${taskC.taskId}.json`);
    const rawC = JSON.parse(readFileSync(completion, "utf8"));
    rawC.verification = "independent";
    writeFileSync(completion, `${JSON.stringify(rawC, null, 2)}\n`);
    const headC = git(dirC, ["rev-parse", "HEAD"]);
    const tamperedC = deliver(dirC, taskC.taskId);
    record(10, "篡改完成凭据 → 交付以 credential_tampered 拒绝，无提交", tamperedC.code !== 0 && tamperedC.text.includes("credential_tampered") && git(dirC, ["rev-parse", "HEAD"]) === headC, tamperedC.body);

    // b) worker 环境中调用 deliver。
    const dir2 = project("s10b");
    const task2 = newTask(dir2, "stage-context");
    const envOut = auxPath("stage-env.txt");
    const deliverOut = auxPath("stage-deliver.json");
    const count = git(dir2, ["rev-list", "--count", "HEAD"]);
    const inside = await stage(dir2, "implement", task2.taskId, {
      writes: [{ path: "README.md", content: "# changed\n" }],
      exec: [
        ["sh", "-c", `printf %s "$KNIT_STAGE_RUN_ID" > '${envOut}'`],
        ["sh", "-c", `'${process.execPath}' '${CLI}' --json deliver ${task2.taskId} --branch ${BRANCH} --dir . > '${deliverOut}' 2>&1; true`],
      ],
      report: { summary: "实现", changedPaths: ["README.md"] },
    });
    const insideBody = existsSync(deliverOut) ? readFileSync(deliverOut, "utf8") : "";
    record(10, "阶段进程带 KNIT_STAGE_RUN_ID", existsSync(envOut) && readFileSync(envOut, "utf8") === inside.runId, existsSync(envOut) ? readFileSync(envOut, "utf8") : null);
    record(10, "worker 环境中调用 deliver → stage_context_forbidden，未产生提交", insideBody.includes("stage_context_forbidden") && git(dir2, ["rev-list", "--count", "HEAD"]) === count, insideBody.slice(0, 400));

    // c) 植入的 hook 在交付时不执行。
    const dir3 = project("s10c");
    const task3 = newTask(dir3, "hook");
    await stage(dir3, "implement", task3.taskId, { writes: [{ path: "README.md", content: "# impl\n" }], report: { summary: "实现", changedPaths: ["README.md"] } });
    knit(dir3, ["task", "close", task3.taskId, "--outcome", "completed", "--reason", "探针"]);
    const marker = auxPath("hook-ran");
    for (const name of ["pre-commit", "post-index-change", "reference-transaction"]) {
      const hook = join(dir3, ".git", "hooks", name);
      writeFileSync(hook, `#!/bin/sh\necho ${name} >> '${marker}'\n${name === "pre-commit" ? "exit 1" : "exit 0"}\n`);
      chmodSync(hook, 0o755);
    }
    const plan = deliver(dir3, task3.taskId, ["--plan"]);
    record(10, "交付预检列出新增 hooks（skip 模式）", plan.data?.hooks?.mode === "skip" && ["pre-commit", "post-index-change", "reference-transaction"].every((name) => JSON.stringify(plan.data.hooks.changes).includes(name)), plan.data?.hooks);
    rmSync(marker, { force: true });
    const delivered = deliver(dir3, task3.taskId);
    record(10, "交付成功且植入的 hook 一次也没执行", delivered.data?.state === "completed" && Boolean(delivered.data.workCommit) && !existsSync(marker), { delivered: delivered.body, marker: existsSync(marker) ? readFileSync(marker, "utf8") : null });
  },

  async "11 运行中编辑输入区与并发 task new"() {
    const dir = project("s11");
    const task = newTask(dir, "stale");
    const run = await held(dir, task.taskId, { writes: [{ path: "README.md", content: "# changed\n" }], report: { summary: "实现", changedPaths: ["README.md"] } });
    const created = knit(dir, ["task", "new", "--title", "during-run", "--slug", "during-run"]);
    record(11, "run 期间可以 task new", created.code === 0 && Boolean(created.data?.taskId), created.body);
    const input = auxPath("input.md");
    writeFileSync(input, "## 目标与边界\n\nCLI 改写\n");
    const busy = knit(dir, ["task", "update", task.taskId, "--kind", "clarify", "--file", input, "--reason", "探针"]);
    record(11, "活动 run 中未声明 --run 的 task update → task_busy", busy.code !== 0 && busy.text.includes("task_busy"), busy.body);
    const file = taskFile(dir, task);
    const text = readFileSync(file, "utf8");
    const edited = text.replace("<!-- 待讨论确认：目的、范围、约束与必要设计 -->", "运行中由用户直接改写的目标");
    if (edited === text) throw new Error("未找到 task.md 输入区占位");
    writeFileSync(file, edited);
    writeFileSync(run.signal, "");
    const status = await settled(dir, run.runId);
    record(11, "用户编辑输入区 → 结果完成、接收判 stale_input（不是 protected_path_modified）", status.result?.state === "completed" && status.acceptance?.reason === "stale_input" && !JSON.stringify(status).includes("protected_path_modified"), { state: status.state, result: status.result?.state, reason: status.result?.failureReason, acceptance: status.acceptance });
    record(11, "结果与工作区保留", readFileSync(join(dir, "README.md"), "utf8") === "# changed\n" && readFileSync(file, "utf8").includes("运行中由用户直接改写的目标"), null);
  },

  async "12 tools 语义"() {
    const workflow = ["version: 1", "stages:", "  - id: build", "    tools: []", "  - id: verify", "    tools: all", "  - id: polish", ""].join("\n");
    const dir = project("s12", { workflow });
    const valid = knit(dir, ["workflow", "validate"]);
    record(12, "workflow 校验通过", valid.code === 0, valid.body);
    const task = newTask(dir, "tools", "independent");
    const argvOf = {};
    for (const id of ["build", "verify", "polish"]) {
      const prepared = knit(dir, ["run", "prepare", "--task", task.taskId, "--stage", id, "--provider", "fake", "--model", "fake-model", "--local"]);
      const runId = prepared.data?.request?.runId;
      if (!runId) throw new Error(`run prepare ${id} 失败: ${prepared.text}`);
      const argsFile = auxPath(`argv-${id}.json`);
      const started = knit(dir, ["run", "start", runId], { KNIT_FAKE_ARGS_FILE: argsFile, KNIT_FAKE_ACTION: actionFile({ report: { summary: id } }) });
      const status = await settled(dir, runId);
      argvOf[id] = { tools: prepared.data.request.stageDefinition.tools, capabilities: prepared.data.request.toolPolicy?.capabilities, argv: existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : null, state: status.state, started: started.code };
    }
    const build = argvOf.build;
    record(12, "tools: [] → 空能力，Pi 启动参数含 --no-tools（并离线、禁用扩展／MCP／技能）", build.state === "completed" && JSON.stringify(build.tools) === "[]" && JSON.stringify(build.capabilities) === "[]" && ["--no-tools", "--offline", "--no-mcp", "--no-skills", "--no-extensions"].every((flag) => build.argv?.includes(flag)) && !build.argv.includes("--tools"), build);
    for (const [id, label] of [["verify", "tools: all"], ["polish", "不写 tools"]]) {
      const item = argvOf[id];
      record(12, `${label} → 全部放开（不传 --tools／--no-tools）`, item.state === "completed" && item.tools === null && item.capabilities === null && item.argv != null && !item.argv.includes("--tools") && !item.argv.includes("--no-tools"), item);
    }
  },
};

const only = process.env.PROBE_ONLY ? process.env.PROBE_ONLY.split(",") : null;
for (const [name, body] of Object.entries(scenarios)) {
  const number = name.split(" ")[0];
  if (only && !only.includes(number)) continue;
  process.stdout.write(`\n== 场景 ${name}\n`);
  try {
    await body();
  } catch (error) {
    record(Number(number), "场景执行未抛错", false, String(error?.stack ?? error));
  }
}

const failed = results.filter((item) => !item.pass);
const summary = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cli: relative(REPO, CLI),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
if (!only) writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`\n合计 ${summary.total}，通过 ${summary.passed}，失败 ${summary.failed}\n`);
if (process.env.PROBE_KEEP !== "1" && failed.length === 0) rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
else process.stdout.write(`夹具保留在 ${ROOT}\n`);
process.exit(failed.length === 0 ? 0 : 1);
