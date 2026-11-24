import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../dist/application/project-config.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { project } from "./helpers/cli.mjs";

const template = (name) => readFileSync(new URL(`../assets/templates/${name}`, import.meta.url), "utf8");

test("流程模板通过校验", () => {
  const { workflow, validation } = parseWorkflow(template("workflow.yaml"));
  assert.deepEqual(validation.issues, []);
  assert.deepEqual(
    workflow.stages.map((stage) => [stage.id, stage.model, stage.prompt]),
    [
      ["implement", null, ".knit/agents/implement.md"],
      ["review", null, ".knit/agents/review.md"],
    ],
  );
  const review = workflow.stages[1];
  assert.deepEqual(review.report, { verdict: ["pass", "changes_requested", "blocked"] });
  assert.deepEqual(review.onVerdict, { changes_requested: "implement", blocked: "review" });
  assert.notEqual(template("agents/implement.md").trim(), "");
  assert.notEqual(template("agents/review.md").trim(), "");
});

test("配置模板等于缺省值", (t) => {
  const dir = project(t);
  const defaults = loadConfig(dir);
  writeFileSync(join(dir, ".knit", "config.json"), template("config.json"));
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded, defaults);
});
