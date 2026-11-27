import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { git, gitProject } from "./helpers/git.mjs";
import { parseWorkflow } from "../dist/domain/workflow.js";

const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;

/** docs/design/DESIGN.md 第 6.1 节的示例流程。 */
const SAMPLE_WORKFLOW_YAML = `version: 1
model: p/a
thinking: high
maxRepairRounds: 2
stages:
  - id: implement
    name: 实现
    prompt: .knit/agents/implement.md
    tools: [read, write, exec]
  - id: review
    name: 审查
    model: p/b
    thinking: off
    resume: true
    maxVisits: 7
    prompt: .knit/agents/review.md
    tools: [read, write, exec]
    report:
      verdict: [pass, changes_requested, blocked]
    onVerdict:
      changes_requested: implement
      blocked: review
`;

/** 在临时目录里建一个项目；workflow 为 null 时不写流程文件。测试结束时删除。 */
function project(t, workflow) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".knit"));
  if (workflow !== null) writeFileSync(join(dir, ".knit", "workflow.yaml"), workflow);
  return dir;
}

function run(command, dir, args = [], env = {}) {
  return spawnSync(process.execPath, [cli, "workflow", command, "--dir", dir, ...args], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
}

test("配置正确：show 打印流程和两个环节，validate 退出码为 0", (t) => {
  const dir = project(t, SAMPLE_WORKFLOW_YAML);

  const show = run("show", dir);
  assert.equal(show.status, 0, show.stderr);
  const lines = show.stdout.split("\n");
  assert.equal(lines[0], "流程: 讨论 → 实现 → 审查 → 收尾");
  assert.ok(lines.includes("  1. implement（实现）"), show.stdout);
  assert.ok(lines.includes("  2. review（审查）"), show.stdout);
  assert.ok(lines.includes("     角色文件: .knit/agents/review.md"), show.stdout);
  assert.ok(lines.includes("     工具: read、write、exec"), show.stdout);
  assert.ok(lines.includes("     报告字段: verdict(pass|changes_requested|blocked)"), show.stdout);
  assert.ok(lines.includes("     按结论跳转: changes_requested → implement；blocked → review"), show.stdout);
  assert.deepEqual(lines.filter(line => line.startsWith("     模型:")), ["     模型: （由派发入口决定，Pi 用 p/a，agy 用客户端缺省）", "     模型: p/b"]);
  assert.deepEqual(lines.filter(line => line.startsWith("     思考等级:")), ["     思考等级: （由派发入口决定，Pi 用 high，agy 用客户端缺省）", "     思考等级: off"]);
  assert.deepEqual(lines.filter(line => line.includes("首次之后最多再进入:")), ["     首次之后最多再进入: 2", "     首次之后最多再进入: 7"]);
  assert.deepEqual(lines.filter(line => line.includes("续聊（resume）:")), ["     续聊（resume）: false", "     续聊（resume）: true"]);

  const validate = run("validate", dir);
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(validate.stdout, "配置有效\n流程: 讨论 → 实现 → 审查 → 收尾\n");
});

test("validate 从 Git 子目录读取流程，--env 汇总相同工具组合，两种调用都只读", (t) => {
  const dir = gitProject(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, ".knit/git"), '#!/bin/sh\n/usr/bin/touch "$0.called"\n', { mode: 0o755 });
  writeFileSync(join(bin, "pi"), '#!/bin/sh\n/usr/bin/touch "$0.called"\n', { mode: 0o755 });
  writeFileSync(join(dir, ".knit/workflow.yaml"), SAMPLE_WORKFLOW_YAML.replace("tools: [read, write, exec]", "tools: [exec, write, read]"));
  mkdirSync(join(dir, ".knit/agents"));
  writeFileSync(join(dir, ".knit/agents/implement.md"), "实现");
  writeFileSync(join(dir, ".knit/agents/review.md"), "审查");
  writeFileSync(join(dir, ".knit/config.json"), "{}");
  const snapshot = () => readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    return [path, entry.isFile() ? readFileSync(path).toString("base64") : null];
  }).sort();
  const before = snapshot();
  const plain = run("validate", bin, [], { PATH: join(dir, ".knit") });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, "配置有效\n流程: 讨论 → 实现 → 审查 → 收尾\n");
  assert.equal(plain.stderr, "");
  const env = { KNIT_SESSION_AGENT: "pi", KNIT_PI_BIN: "pi", PATH: `${bin}:${process.env.PATH}` };
  const result = run("validate", bin, ["--env"], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /通过  Node v\d+/);
  assert.match(result.stdout, /通过  \.knit\/config\.json/);
  assert.match(result.stdout, /通过  Git 仓库与 HEAD/);
  assert.match(result.stdout, /^通过  角色文件$/m);
  assert.match(result.stdout, /通过  Pi 客户端/);
  assert.equal(result.stdout.match(/通过  pi tools=\[read, write, exec\] 模型/g)?.length, 1);
  assert.match(result.stdout, /派发环境就绪\n$/);
  assert.doesNotMatch(result.stdout, /antigravity/);
  assert.deepEqual(snapshot(), before);
  rmSync(join(dir, ".knit/agents/review.md"));
  const missing = run("validate", bin, ["--env"], env);
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stdout, /^失败  角色文件.*\.knit\/agents\/review\.md.*补齐角色文件.*knit init/m);
  assert.equal(missing.stdout.match(/^失败 /gm)?.length, 1);
  assert.match(missing.stdout, /派发环境未就绪\n$/);
  assert.deepEqual(readdirSync(process.env.KNIT_HOME), []);
});

const parallelWorkflow = `version: 1
stages:
  - id: implement
    tools: all
  - id: review
    tools: [read, exec]
    prompt: .knit/agents/review.md
    executors:
      - id: pi-review
        agent: pi
        model: provider/reviewer
        thinking: minimal
      - agent: antigravity
        model: gemini-reviewer
        thinking: high
`;

test("--env 一次报告配置、空仓库、两个并行客户端和缺模型的执行器", (t) => {
  const dir = project(t, parallelWorkflow.replace("        model: provider/reviewer\n", "") + "        prompt: roles/agy.md\n");
  mkdirSync(join(dir, "roles/agy.md"), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".knit/config.json"), "{");
  const result = run("validate", dir, ["--env"], {
    KNIT_SESSION_AGENT: "pi", PI_MODEL: "", KNIT_PI_BIN: join(dir, "pi"), KNIT_AGY_BIN: join(dir, "agy"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /失败  \.knit\/config\.json.*不是合法的 JSON.*修正/);
  assert.match(result.stdout, /失败  角色文件.*\.knit\/agents\/review\.md、roles\/agy\.md/);
  assert.match(result.stdout, /失败  Git .*先提交一次再派发/);
  assert.match(result.stdout, /失败  Pi 客户端.*请安装 Pi/);
  assert.match(result.stdout, /失败  pi .*review\/pi-review 未配置模型.*workflow.yaml 写 model 或传 --model/);
  assert.match(result.stdout, /失败  antigravity .*（agy）|失败  antigravity .*sandbox-exec/);
  assert.match(result.stdout, /派发环境未就绪\n$/);
});

test("--env 在非 Git 项目说明主会话可直接做，Pi 主会话模型可供派发", (t) => {
  const dir = project(t, "version: 1\nstages:\n  - id: implement\n");
  const result = run("validate", dir, ["--env"], {
    KNIT_SESSION_AGENT: "pi", PI_PROVIDER: "p", PI_MODEL: "a", KNIT_PI_BIN: process.execPath,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /仅支持主会话直接做，无法派发执行者/);
  assert.match(result.stdout, /通过  pi .*使用主会话模型.*传 --model/);
});

test("--env 按当前宿主检查隐式 Antigravity，按工具组合复用版本与隔离预检", { skip: process.platform !== "darwin" }, (t) => {
  const dir = gitProject(t);
  const agy = join(dir, "agy");
  writeFileSync(agy, '#!/bin/sh\n[ "$1" = --version ] && echo 1.5.13\n', { mode: 0o755 });
  writeFileSync(join(dir, ".knit/workflow.yaml"), "version: 1\nstages:\n  - id: implement\n    tools: []\n  - id: review\n    tools: [exec]\n");
  const result = run("validate", dir, ["--env"], { KNIT_SESSION_AGENT: "antigravity", KNIT_AGY_BIN: agy });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /通过  antigravity tools=\[\]/);
  assert.match(result.stdout, /失败  antigravity tools=\[exec\].*通用命令需要 read/);
  assert.doesNotMatch(result.stdout, /Pi 客户端/);
  assert.deepEqual(readdirSync(process.env.KNIT_HOME), []);
});

test("--env 按实际入口复核隐式执行器的模型和 thinking", (t) => {
  const dir = gitProject(t);
  const file = join(dir, ".knit/workflow.yaml");
  writeFileSync(file, "version: 1\nstages:\n  - id: implement\n    model: agy-model\n");
  const pi = run("validate", dir, ["--env"], { KNIT_SESSION_AGENT: "pi", KNIT_PI_BIN: process.execPath });
  assert.equal(pi.status, 1);
  assert.match(pi.stdout, /失败  implement pi 模型：agy-model 要写成 provider\/模型/);
  writeFileSync(file, "version: 1\nstages:\n  - id: implement\n    tools: []\n    model: provider/model\n    thinking: minimal\n");
  const agy = run("validate", dir, ["--env"], { KNIT_SESSION_AGENT: "antigravity", KNIT_AGY_BIN: join(dir, "absent") });
  assert.equal(agy.status, 1);
  assert.match(agy.stdout, /失败  implement antigravity 模型：provider\/model 要写成 Antigravity 模型 ID/);
  assert.match(agy.stdout, /失败  implement antigravity 思考等级：minimal 只允许 low／medium／high／xhigh／max/);
});

test("只读审查可并列两个执行器，按各自的 Agent 展示模型、思考等级和角色文件", (t) => {
  const parsed = parseWorkflow(parallelWorkflow);
  assert.deepEqual(parsed.validation.issues, []);
  const prompt = ".knit/agents/review.md";
  assert.deepEqual(parsed.workflow.stages[1].executors, [
    { id: "pi-review", agent: "pi", model: "provider/reviewer", thinking: "minimal", prompt },
    { id: "executor-2", agent: "antigravity", model: "gemini-reviewer", thinking: "high", prompt },
  ]);
  const dir = project(t, parallelWorkflow + "        prompt: roles/agy.md\n");
  const validate = run("validate", dir);
  assert.equal(validate.status, 0, validate.stderr);
  const show = run("show", dir);
  assert.equal(show.status, 0, show.stderr);
  assert.ok(show.stdout.includes([
    "     执行器: pi-review", `       角色文件: ${prompt}`, "       Agent: pi",
    "       模型: provider/reviewer", "       思考等级: minimal",
    "     执行器: executor-2", "       角色文件: roles/agy.md", "       Agent: antigravity",
    "       模型: gemini-reviewer", "       思考等级: high",
  ].join("\n")), show.stdout);
  assert.doesNotMatch(show.stdout, /执行器: executor-1/);
  assert.match(show.stdout, /模型: （由派发入口决定，Pi 用 主会话模型，agy 用客户端缺省）/);
  assert.match(show.stdout, /思考等级: （由派发入口决定，Pi 用 主会话等级，agy 用客户端缺省）/);
  const agy = run("show", project(t, "version: 1\nmodel: p/a\nthinking: off\nstages:\n  - id: review\n    agent: antigravity\n"));
  assert.equal(agy.status, 0, agy.stderr);
  assert.match(agy.stdout, /模型: （用 agy 的缺省）/);
  assert.match(agy.stdout, /思考等级: （用 agy 的缺省）/);
});

test("并行环节的工具、顶层冲突与执行器字段错误按源文件行序一并报告", (t) => {
  const source = parallelWorkflow
    .replace("tools: [read, exec]", "tools: [read, write]\n    model: p/m")
    .replace("id: pi-review", "id: Pi")
    .replace("model: provider/reviewer", "model: invalid")
    .replace("thinking: minimal", "thinking: invalid");
  const parsed = parseWorkflow(source);
  assert.equal(parsed.workflow, null);
  assert.deepEqual(parsed.validation.issues.map((issue) => [issue.code, issue.line]), [
    ["parallel_stage_requires_readonly_tools", 6],
    ["conflicting_executor_fields", 7],
    ["invalid_executor_id", 10],
    ["invalid_model", 12],
    ["invalid_thinking", 13],
  ]);
  const validate = run("validate", project(t, source));
  assert.equal(validate.status, 1);
  assert.equal(validate.stderr, parsed.validation.issues.map((issue) => `${issue.message}\n`).join(""));
});

test("配置有问题：两个命令都在标准错误里给出行号，退出码为 1，不打印流程", (t) => {
  const dir = project(t, "version: 1\nstages:\n  - id: Bad\n");
  const preflight = run("validate", dir, ["--env"]);
  assert.equal(preflight.status, 1);
  assert.equal(preflight.stderr, run("validate", dir).stderr);
  assert.equal(preflight.stdout, "");
  for (const command of ["validate", "show"]) {
    const result = run(command, dir);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /^第 3 行：/, command);
    assert.equal(result.stdout, "", command);
  }
});

test("流程文件不存在：两个命令都说明文件不存在并提示 knit init，退出码为 1", (t) => {
  const dir = project(t, null);
  for (const command of ["validate", "show"]) {
    const result = run(command, dir);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /\.knit\/workflow\.yaml 不存在/, command);
    assert.match(result.stderr, /knit init/, command);
    assert.equal(result.stdout, "", command);
  }
});
