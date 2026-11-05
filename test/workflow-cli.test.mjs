/**
 * P5：workflow 命令组、--stage 与桥接去静态枚举。
 * 用真实 CLI 在临时项目内读写 workflow.yaml；不启动模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

function project(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), `knit-workflow-${prefix}-`)));
}

function run(dir, args) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], { cwd: dir, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function json(dir, args) {
  const result = run(dir, ["--json", ...args]);
  const parsed = result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  return { ...result, parsed };
}

function workflowPath(dir) {
  return join(dir, ".knit", "workflow.yaml");
}

test("workflow init／show／validate：生成带注释模板，重复 init 拒绝，--force 覆盖", () => {
  const dir = project("init");
  try {
    // 未创建时 show／validate 按缺省模板读取，不报错。
    const before = json(dir, ["workflow", "show"]);
    assert.equal(before.parsed.outcome, "completed");
    assert.equal(before.parsed.data.exists, false);
    assert.equal(before.parsed.data.mode, "config");
    assert.deepEqual(before.parsed.data.workflow.stages.map((stage) => stage.id), ["implement", "check"]);
    assert.equal(existsSync(workflowPath(dir)), false, "show 不写文件");

    const initialized = json(dir, ["workflow", "init"]);
    assert.equal(initialized.parsed.outcome, "completed", initialized.stderr);
    assert.equal(initialized.parsed.data.changed, true);
    const source = readFileSync(workflowPath(dir), "utf8");
    assert.match(source, /^# Knit 流程配置/m);
    assert.match(source, /^version: 1$/m);

    const duplicate = json(dir, ["workflow", "init"]);
    assert.equal(duplicate.code, 1);
    assert.equal(duplicate.parsed.outcome, "error");
    assert.match(duplicate.parsed.data.error, /已存在/);

    const forced = json(dir, ["workflow", "init", "--force"]);
    assert.equal(forced.parsed.outcome, "completed");

    const validated = json(dir, ["workflow", "validate"]);
    assert.equal(validated.code, 0);
    assert.equal(validated.parsed.outcome, "completed");
    assert.equal(validated.parsed.data.ok, true);
    assert.equal(validated.parsed.data.validation.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow add／move／set-*：写入后全量校验并回显新流程摘要", () => {
  const dir = project("edit");
  try {
    assert.equal(json(dir, ["workflow", "init"]).parsed.outcome, "completed");
    const added = json(dir, [
      "workflow", "add", "build",
      "--name", "构建",
      "--description", "先构建",
      "--prompt", ".knit/agents/build.md",
      "--tools", "read,exec",
      "--report", "result:string",
      "--after", "implement",
    ]);
    assert.equal(added.parsed.outcome, "completed", added.stderr);
    assert.equal(added.parsed.data.changed, true);
    assert.deepEqual(added.parsed.data.workflow.stages.map((stage) => stage.id), ["implement", "build", "check"]);
    assert.equal(added.parsed.data.summary.chain, "准备 → 实现 → 构建 → 检查 → 收尾");

    assert.equal(json(dir, ["workflow", "set-report", "build", "verdict", "pass,changes_requested"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "set-next", "build", "changes_requested", "implement"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "set-tools", "build", "read"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "set-prompt", "build", ".knit/agents/build.md"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "move", "build", "1"]).parsed.outcome, "completed");

    const shown = json(dir, ["workflow", "show"]);
    assert.equal(shown.parsed.outcome, "completed");
    assert.deepEqual(shown.parsed.data.workflow.stages.map((stage) => stage.id), ["build", "implement", "check"]);
    const build = shown.parsed.data.workflow.stages.find((stage) => stage.id === "build");
    assert.equal(build.name, "构建");
    assert.equal(build.description, "先构建");
    assert.equal(build.prompt, ".knit/agents/build.md");
    assert.deepEqual(build.tools, ["read"]);
    assert.equal(build.report.result, "string");
    assert.deepEqual(build.report.verdict, ["pass", "changes_requested"]);
    assert.equal(build.onVerdict.changes_requested, "implement");

    // 注释在编辑后仍然保留。
    assert.match(readFileSync(workflowPath(dir), "utf8"), /^# 阶段字段：/m);

    // --clear 移除可选字段后仍可校验通过。
    assert.equal(json(dir, ["workflow", "set-next", "build", "--clear"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "set-report", "build", "verdict", "--clear"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "set-prompt", "build", "--clear"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "set-tools", "build", "--clear"]).parsed.outcome, "completed");
    assert.equal(json(dir, ["workflow", "remove", "build"]).parsed.outcome, "completed");
    assert.deepEqual(json(dir, ["workflow", "show"]).parsed.data.workflow.stages.map((stage) => stage.id), ["implement", "check"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow 写入失败带行号并保持原文件；未创建时 add 先写入默认模板", () => {
  const dir = project("reject");
  try {
    const created = json(dir, ["workflow", "add", "build", "--after", "implement"]);
    assert.equal(created.parsed.outcome, "completed", created.stderr);
    assert.equal(existsSync(workflowPath(dir)), true, "未创建时 add 先写默认模板");
    const before = readFileSync(workflowPath(dir), "utf8");

    const invalidId = json(dir, ["workflow", "add", "Bad"]);
    assert.equal(invalidId.code, 1);
    assert.equal(invalidId.parsed.outcome, "error");
    assert.ok(invalidId.parsed.data.issues.length > 0, "错误含结构化问题");
    assert.match(invalidId.parsed.data.issues[0].message, /第 \d+ 行/);
    assert.equal(readFileSync(workflowPath(dir), "utf8"), before, "非法写入不改文件");

    const duplicate = json(dir, ["workflow", "add", "build"]);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.parsed.data.issues[0].message, /第 \d+ 行：阶段 id "build" 重复/);
    assert.equal(readFileSync(workflowPath(dir), "utf8"), before, "重复 id 不改文件");

    const unknownTools = json(dir, ["workflow", "set-tools", "check", "read,bogus"]);
    assert.equal(unknownTools.code, 1);
    assert.match(unknownTools.parsed.data.issues[0].message, /第 \d+ 行/);
    assert.equal(readFileSync(workflowPath(dir), "utf8"), before, "未知能力不改文件");

    const unknownNext = json(dir, ["workflow", "set-next", "check", "changes_requested", "missing"]);
    assert.equal(unknownNext.code, 1);
    assert.equal(unknownNext.parsed.data.issues.some((issue) => /不存在/.test(issue.message)), true);
    assert.equal(readFileSync(workflowPath(dir), "utf8"), before, "无效跳转不改文件");

    const referenced = json(dir, ["workflow", "remove", "implement"]);
    assert.equal(referenced.code, 1, "被 onVerdict 引用的阶段不能删除");
    assert.match(referenced.parsed.data.issues[0].message, /第 \d+ 行/);
    assert.equal(readFileSync(workflowPath(dir), "utf8"), before, "拒绝写入不改文件");

    const outOfRange = json(dir, ["workflow", "move", "check", "99"]);
    assert.equal(outOfRange.code, 1);
    assert.match(outOfRange.parsed.data.error, /越界/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow validate 对坏 YAML 输出降级原因与行号，非零退出", () => {
  const dir = project("invalid");
  try {
    assert.equal(json(dir, ["workflow", "init"]).parsed.outcome, "completed");
    const broken = readFileSync(workflowPath(dir), "utf8") + "\n  - id: Bad\n";
    writeFileSync(workflowPath(dir), broken, "utf8");
    const validated = json(dir, ["workflow", "validate"]);
    assert.equal(validated.code, 1);
    assert.equal(validated.parsed.outcome, "needs_attention");
    assert.equal(validated.parsed.data.ok, false);
    assert.equal(validated.parsed.data.mode, "fallback");
    assert.ok(validated.parsed.data.validation.issues.length > 0);
    assert.match(validated.parsed.data.validation.issues[0].message, /第 \d+ 行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
