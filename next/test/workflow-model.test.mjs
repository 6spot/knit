import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { parseWorkflow } from "../dist/domain/workflow.js";

const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;

/** 在临时目录里建一个只有流程文件的项目，运行 knit workflow <command>。测试结束时删除。 */
function run(t, command, workflow) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-workflow-model-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".knit"));
  writeFileSync(join(dir, ".knit", "workflow.yaml"), workflow);
  return spawnSync(process.execPath, [cli, "workflow", command, "--dir", dir], { encoding: "utf8" });
}

test("顶层的模型是缺省，环节可以写自己的", (t) => {
  const withModels = "version: 1\nmodel: p/a\nstages:\n  - id: implement\n  - id: review\n    model: p/b\n";
  const parsed = parseWorkflow(withModels);
  assert.deepEqual(parsed.validation.issues, []);
  assert.deepEqual(parsed.workflow.stages.map((stage) => stage.model), ["p/a", "p/b"]);

  const shown = run(t, "show", withModels);
  assert.equal(shown.status, 0, shown.stderr);
  const models = shown.stdout.split("\n").filter((line) => line.startsWith("     模型: "));
  assert.deepEqual(models, ["     模型: p/a", "     模型: p/b"]);

  const withoutModels = "version: 1\nstages:\n  - id: implement\n  - id: review\n";
  const bare = parseWorkflow(withoutModels);
  assert.equal(bare.validation.ok, true);
  assert.deepEqual(bare.workflow.stages.map((stage) => stage.model), [null, null]);
  const bareShown = run(t, "show", withoutModels);
  assert.equal(bareShown.status, 0, bareShown.stderr);
  assert.deepEqual(
    bareShown.stdout.split("\n").filter((line) => line.startsWith("     模型: ")),
    ["     模型: （没有指定，派发时加 --model）", "     模型: （没有指定，派发时加 --model）"],
  );
});

test("返工上限写在流程文件里", (t) => {
  const limited = "version: 1\nmaxRepairRounds: 2\nstages:\n  - id: implement\n  - id: review\n    maxVisits: 7\n";
  const parsed = parseWorkflow(limited);
  assert.deepEqual(parsed.validation.issues, []);
  assert.equal(parsed.workflow.defaultMaxVisits, 2);
  assert.deepEqual(parsed.workflow.stages.map((stage) => stage.maxVisits), [2, 7]);

  const shown = run(t, "show", limited);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(
    shown.stdout.split("\n").filter((line) => line.startsWith("     进入次数上限: ")),
    ["     进入次数上限: 2", "     进入次数上限: 7"],
  );

  const unset = parseWorkflow("version: 1\nstages:\n  - id: implement\n  - id: review\n    maxVisits: 7\n");
  assert.equal(unset.workflow.defaultMaxVisits, 5);
  assert.deepEqual(unset.workflow.stages.map((stage) => stage.maxVisits), [5, 7]);
});

test("写错时指出行号", (t) => {
  const cases = [
    ["version: 1\nmodel: nomodel\nstages:\n  - id: implement\n", "invalid_model", 2, "第 2 行：model 要写成 provider/模型"],
    [
      "version: 1\nstages:\n  - id: implement\n  - id: review\n    model: /m\n",
      "invalid_model",
      5,
      "第 5 行：stages[1].model 要写成 provider/模型",
    ],
    [
      "version: 1\nstages:\n  - id: implement\nmaxRepairRounds: -1\n",
      "invalid_max_repair_rounds",
      4,
      "第 4 行：maxRepairRounds 必须是非负整数",
    ],
    [
      "version: 1\nmaxRepairRounds: 1.5\nstages:\n  - id: implement\n",
      "invalid_max_repair_rounds",
      2,
      "第 2 行：maxRepairRounds 必须是非负整数",
    ],
  ];
  for (const [source, code, line, message] of cases) {
    const parsed = parseWorkflow(source);
    assert.equal(parsed.workflow, null, source);
    assert.deepEqual(
      parsed.validation.issues.map((issue) => [issue.code, issue.line, issue.message]),
      [[code, line, message]],
      source,
    );
    const validated = run(t, "validate", source);
    assert.equal(validated.status, 1, source);
    assert.equal(validated.stderr, `${message}\n`, source);
    assert.equal(validated.stdout, "", source);
  }

  // a/b/c 合法：provider 是 a
  assert.equal(parseWorkflow("version: 1\nmodel: a/b/c\nstages:\n  - id: implement\n").workflow.stages[0].model, "a/b/c");
});
