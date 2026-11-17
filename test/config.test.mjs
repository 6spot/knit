import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../dist/application/config.js";
import { project } from "./helpers/cli.mjs";

/** 建一个临时项目；给了内容就写成它的 `.knit/config.json`。 */
function projectWithConfig(t, content) {
  const dir = project(t);
  if (content !== undefined) writeFileSync(join(dir, ".knit", "config.json"), content);
  return dir;
}

test("没有配置文件时用缺省值", (t) => {
  const defaults = { config: { handoff: { fileBytes: 16384, totalBytes: 65536 } }, problems: [] };
  assert.deepEqual(loadConfig(projectWithConfig(t)), defaults);
  assert.deepEqual(loadConfig(projectWithConfig(t, "{}")), defaults);
});

test("写了的值生效", (t) => {
  assert.deepEqual(loadConfig(projectWithConfig(t, '{ "handoff": { "fileBytes": 100 } }')), {
    config: { handoff: { fileBytes: 100, totalBytes: 65536 } },
    problems: [],
  });
  assert.deepEqual(loadConfig(projectWithConfig(t, '{ "handoff": { "fileBytes": 100, "totalBytes": 200 } }')), {
    config: { handoff: { fileBytes: 100, totalBytes: 200 } },
    problems: [],
  });
});

test("配置写错时指出问题", (t) => {
  const cases = [
    ["{ not json", "不是合法的 JSON"],
    ['{ "handof": {} }', "handof"],
    ['{ "handoff": { "fileBytes": 0 } }', "fileBytes"],
    ['{ "model": "p/m" }', "model"],
  ];
  for (const [content, expected] of cases) {
    const loaded = loadConfig(projectWithConfig(t, content));
    assert.equal(loaded.config, null, content);
    assert.equal(loaded.problems.length, 1, JSON.stringify(loaded.problems));
    assert.ok(loaded.problems[0].startsWith(".knit/config.json："), loaded.problems[0]);
    assert.ok(loaded.problems[0].includes(expected), loaded.problems[0]);
  }
});
