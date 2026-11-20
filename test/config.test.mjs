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

test("Worktree 准备命令保留内容和顺序，空数组合法", (t) => {
  [[], ["npm ci", "  echo ready  "]].forEach((setup) => {
    assert.deepEqual(loadConfig(projectWithConfig(t, JSON.stringify({ worktree: { setup } }))), {
      config: { handoff: { fileBytes: 16384, totalBytes: 65536 }, worktree: { setup } },
      problems: [],
    });
  });
  assert.deepEqual(loadConfig(projectWithConfig(t, '{"worktree":{}}')), {
    config: { handoff: { fileBytes: 16384, totalBytes: 65536 }, worktree: {} },
    problems: [],
  });
});

[null, "npm ci", {}, [""], ["   "], ["echo ok", 1]].forEach((setup) => {
  test(`准备命令配置写错时指出配置文件和 setup：${JSON.stringify(setup)}`, (t) => {
    const loaded = loadConfig(projectWithConfig(t, JSON.stringify({ worktree: { setup } })));
    assert.equal(loaded.config, null);
    assert.match(loaded.problems.join("\n"), /^\.knit\/config\.json：.*worktree\/setup/);
  });
});

[null, [], "npm ci"].forEach((worktree) => {
  test(`worktree 必须是对象：${JSON.stringify(worktree)}`, (t) => {
    const loaded = loadConfig(projectWithConfig(t, JSON.stringify({ worktree })));
    assert.equal(loaded.config, null);
    assert.match(loaded.problems.join("\n"), /^\.knit\/config\.json：.*worktree/);
  });
});

test("autoMerge 接受布尔值，未写时保持缺省关闭", (t) => {
  [false, true].forEach((autoMerge) => {
    assert.deepEqual(loadConfig(projectWithConfig(t, JSON.stringify({ worktree: { autoMerge } }))), {
      config: { handoff: { fileBytes: 16384, totalBytes: 65536 }, worktree: { autoMerge } },
      problems: [],
    });
  });
  [null, 0, "false", [], {}].forEach((autoMerge) => {
    const loaded = loadConfig(projectWithConfig(t, JSON.stringify({ worktree: { autoMerge } })));
    assert.equal(loaded.config, null);
    assert.match(loaded.problems.join("\n"), /^\.knit\/config\.json：.*worktree\/autoMerge/);
  });
});

test("配置写错时指出问题", (t) => {
  const cases = [
    ["{ not json", "不是合法的 JSON"],
    ['{ "handof": {} }', "handof"],
    ['{ "handoff": { "fileBytes": 0 } }', "fileBytes"],
    ['{ "model": "p/m" }', "model"],
    ['{ "worktree": { "autoMerge": "true" } }', "autoMerge"],
    ['{ "worktree": { "setp": [] } }', "setp"],
  ];
  for (const [content, expected] of cases) {
    const loaded = loadConfig(projectWithConfig(t, content));
    assert.equal(loaded.config, null, content);
    assert.equal(loaded.problems.length, 1, JSON.stringify(loaded.problems));
    assert.ok(loaded.problems[0].startsWith(".knit/config.json："), loaded.problems[0]);
    assert.ok(loaded.problems[0].includes(expected), loaded.problems[0]);
  }
});
