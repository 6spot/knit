import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;

/** design.md 第 6.1 节的示例流程。 */
const SAMPLE_WORKFLOW_YAML = `version: 1
stages:
  - id: implement
    name: 实现
    prompt: .knit/agents/implement.md
    tools: [read, write, exec]
  - id: review
    name: 审查
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

function run(command, dir) {
  return spawnSync(process.execPath, [cli, "workflow", command, "--dir", dir], { encoding: "utf8" });
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
  assert.ok(lines.includes("     进入次数上限: 5"), show.stdout);

  const validate = run("validate", dir);
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(validate.stdout, "配置有效\n流程: 讨论 → 实现 → 审查 → 收尾\n");
});

test("配置有问题：两个命令都在标准错误里给出行号，退出码为 1，不打印流程", (t) => {
  const dir = project(t, "version: 1\nstages:\n  - id: Bad\n");
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
