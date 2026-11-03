import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSectionContents } from "../dist/application/stage.js";

const section = (path, required) => ({
  sourceId: `planning-material:${path}`, kind: "planning-material", path,
  digest: null, bytes: null, required, background: false,
  countsTowardInputs: required, priority: 1, mode: "system",
});

test("060：规划后必需文件消失，提示装配明确报sourceId与path，不静默启动", () => {
  const root = mkdtempSync(join(tmpdir(), "knit-required-"));
  try {
    const required = section("plan.md", true);
    assert.throws(() => loadSectionContents(root, { sections: [required] }), (error) => {
      assert.equal(error.code, "io_error");
      assert.equal(error.details.path, "plan.md");
      assert.equal(error.details.sourceId, required.sourceId);
      return true;
    });
    writeFileSync(join(root, "plan.md"), "# 当前计划\n");
    assert.equal(loadSectionContents(root, { sections: [required] })[required.sourceId], "# 当前计划\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("060：可选背景文件缺失仍可省略，必需文件已加载内容保留", () => {
  const root = mkdtempSync(join(tmpdir(), "knit-optional-"));
  try {
    writeFileSync(join(root, "plan.md"), "# 计划\n");
    const required = section("plan.md", true);
    const optional = section("missing.md", false);
    assert.deepEqual(loadSectionContents(root, { sections: [optional, required] }), { [required.sourceId]: "# 计划\n" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
