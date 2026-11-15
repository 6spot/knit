import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changesSince, protectedChanges, takeSnapshot } from "../dist/application/workspace.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { project } from "./helpers/cli.mjs";
import { commitAll, git, gitProject } from "./helpers/git.mjs";

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

test("新增、修改、删除的文件都算改动", (t) => {
  const dir = gitProject(t);
  write(dir, ".gitignore", "ignored/\n");
  for (const path of ["src/edited.ts", "src/removed.ts", "src/untouched.ts", "scripts/run.sh"]) write(dir, path, `${path}\n`);
  commitAll(dir, "files");

  const before = takeSnapshot(dir);
  assert.deepEqual(Object.keys(before.files).sort(), [
    ".gitignore",
    "scripts/run.sh",
    "src/edited.ts",
    "src/removed.ts",
    "src/untouched.ts",
  ]);
  assert.deepEqual(changesSince(dir, before), { changedPaths: [], head: null });

  write(dir, "src/added.ts", "new\n");
  write(dir, "src/edited.ts", "edited\n");
  rmSync(join(dir, "src/removed.ts"));
  chmodSync(join(dir, "scripts/run.sh"), 0o755);
  write(dir, "ignored/cache.txt", "cache\n");
  write(dir, ".knit/.runtime/runs/r-1/worker.log", "log\n");

  const expected = { changedPaths: ["scripts/run.sh", "src/added.ts", "src/edited.ts", "src/removed.ts"], head: null };
  assert.deepEqual(changesSince(dir, before), expected);
  assert.deepEqual(changesSince(dir, JSON.parse(JSON.stringify(before))), expected);

  // 改回去就不算改动
  write(dir, "src/edited.ts", "src/edited.ts\n");
  assert.deepEqual(changesSince(dir, before).changedPaths, ["scripts/run.sh", "src/added.ts", "src/removed.ts"]);
});

test("HEAD 动了能看出来", (t) => {
  const dir = gitProject(t);
  write(dir, "src/a.ts", "one\n");
  commitAll(dir, "files");
  const before = takeSnapshot(dir);
  assert.equal(before.head, git(dir, "rev-parse", "HEAD"));

  write(dir, "src/a.ts", "two\n");
  commitAll(dir, "change");

  const changes = changesSince(dir, before);
  assert.deepEqual(changes.head, { before: before.head, after: git(dir, "rev-parse", "HEAD") });
  assert.match(changes.head.before, /^[0-9a-f]{40}$/);
  assert.match(changes.head.after, /^[0-9a-f]{40}$/);
  assert.notEqual(changes.head.before, changes.head.after);
  assert.deepEqual(changes.changedPaths, ["src/a.ts"]);

  // 还没有提交的仓库
  const empty = project(t);
  git(empty, "init", "-q");
  write(empty, "a.txt", "a\n");
  assert.deepEqual(Object.keys(takeSnapshot(empty).files), ["a.txt"]);
  assert.equal(takeSnapshot(empty).head, null);
});

test("认出受保护的路径", () => {
  const parsed = parseWorkflow(
    [
      "version: 1",
      "stages:",
      "  - id: implement",
      "    prompt: ./.knit/agents/implement.md",
      "  - id: review",
      "    report:",
      "      verdict: [pass, changes_requested]",
      "",
    ].join("\n"),
  );
  assert.deepEqual(parsed.validation.issues, []);

  const changed = [
    ".knit/standards/a.md",
    ".knit/workflow.yaml",
    ".knit/config.json",
    ".knit/agents/implement.md",
    ".knit/agents/other.md",
    "src/a.ts",
  ];
  assert.deepEqual(protectedChanges(changed, parsed.workflow), changed.slice(0, 4));
  assert.deepEqual(protectedChanges(["src/a.ts", ".knit/standards.md", ".knit/tasks/a/task.md"], parsed.workflow), []);
});
