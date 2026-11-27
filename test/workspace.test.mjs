import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changesBetween, fingerprint, matchesFingerprint, matchingFingerprints, protectedChanges, takeSnapshot } from "../dist/application/workspace.js";
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
  assert.deepEqual(changesBetween(before, takeSnapshot(dir)), { changedPaths: [], head: null });

  write(dir, "src/added.ts", "new\n");
  write(dir, "src/edited.ts", "edited\n");
  rmSync(join(dir, "src/removed.ts"));
  chmodSync(join(dir, "scripts/run.sh"), 0o755);
  write(dir, "ignored/cache.txt", "cache\n");
  write(dir, ".knit/.runtime/runs/r-1/worker.log", "log\n");

  const expected = { changedPaths: ["scripts/run.sh", "src/added.ts", "src/edited.ts", "src/removed.ts"], head: null };
  assert.deepEqual(changesBetween(before, takeSnapshot(dir)), expected);
  assert.deepEqual(changesBetween(JSON.parse(JSON.stringify(before)), takeSnapshot(dir)), expected);

  // 改回去就不算改动
  write(dir, "src/edited.ts", "src/edited.ts\n");
  assert.deepEqual(changesBetween(before, takeSnapshot(dir)).changedPaths, ["scripts/run.sh", "src/added.ts", "src/removed.ts"]);
});

test("干净普通文件免读内容，受保护路径始终保留字节指纹", (t) => {
  const dir = gitProject(t);
  const ordinary = ["src/a.txt", "src/with\tspace\n.txt", ".knit/tasks/archive/2026-10/old/task.md"];
  const active = ".knit/tasks/11-27-active/task.md";
  const archiveRole = ".knit/tasks/archive/2026-10/old/role.md";
  const guarded = [".knit/config.json", ".knit/workflow.yaml", ".knit/standards/a.md", "roles/shared.md", "roles/chosen.md", active, archiveRole];
  for (const path of [...ordinary, ...guarded]) write(dir, path, "one\n");
  write(dir, ".gitattributes", "*.md text\n");
  write(dir, ".knit/.runtime/tracked", "runtime\n");
  commitAll(dir, "files");
  const original = fs.readFileSync;
  const reads = [];
  const handle = t.mock.method(fs, "readFileSync", (path, ...args) => {
    reads.push(path);
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  const roles = ["./roles/shared.md", "roles/chosen.md", archiveRole];
  const before = takeSnapshot(dir, roles);
  handle.mock.restore();
  syncBuiltinESMExports();
  for (const path of ordinary) {
    assert.match(before.files[path], /^git 100644 [a-f0-9]{40,64}$/);
    assert.ok(!reads.includes(join(dir, path)), path);
  }
  for (const path of guarded) {
    assert.equal(before.files[path], fingerprint(dir, path));
    assert.ok(reads.includes(join(dir, path)), path);
  }
  assert.ok(!Object.hasOwn(before.files, ".knit/.runtime/tracked"));
  const changed = [".knit/standards/a.md", "roles/shared.md", "roles/chosen.md", active, archiveRole];
  for (const path of changed) {
    write(dir, path, "one\r\n");
    git(dir, "add", "--", path);
  }
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.deepEqual(changesBetween(before, takeSnapshot(dir, roles)).changedPaths, changed.sort());
});

test("保护大小写变体并保留原路径与原始字节指纹", (t) => {
  const dir = gitProject(t);
  const roles = ["./Roles/Implement.md"];
  const { workflow } = parseWorkflow(`version: 1\nstages:\n  - id: implement\n    prompt: ${roles[0]}\n`);
  const paths = [".knit/Config.json", ".knit/Workflow.yaml", ".knit/Standards/extra.md", "roles/IMPLEMENT.md"].sort();
  const empty = takeSnapshot(dir, roles);
  paths.forEach((path) => write(dir, path, "first\n"));
  const added = changesBetween(empty, takeSnapshot(dir, roles)).changedPaths;
  assert.deepEqual(protectedChanges(added, workflow), paths);
  commitAll(dir, "variants");
  const before = takeSnapshot(dir, roles);
  paths.forEach((path) => {
    assert.equal(before.files[path], fingerprint(dir, path));
    write(dir, path, "second\n");
  });
  const after = takeSnapshot(dir, roles, before);
  assert.deepEqual(protectedChanges(changesBetween(before, after).changedPaths, workflow), paths);
  paths.forEach((path) => assert.equal(after.files[path], fingerprint(dir, path)));
});

test("子模块快照使用实际 HEAD，并检出工作区内容及未跟踪文件变化", (t) => {
  const source = gitProject(t);
  const root = gitProject(t);
  write(source, "sample.txt", "sample\n");
  commitAll(source, "sample");
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
  commitAll(root, "gitlink");
  const module = join(root, "module");
  const clean = takeSnapshot(root);
  assert.equal(clean.files.module, `submodule ${git(module, "rev-parse", "HEAD")} clean`);
  git(module, "checkout", "-q", "--detach", "HEAD~1");
  assert.deepEqual(changesBetween(clean, takeSnapshot(root)).changedPaths, ["module"]);
  git(module, "checkout", "-q", git(source, "rev-parse", "HEAD"));
  assert.deepEqual(changesBetween(clean, takeSnapshot(root)).changedPaths, []);
  write(module, "sample.txt", "edited\n");
  const dirty = takeSnapshot(root);
  assert.deepEqual(changesBetween(clean, dirty).changedPaths, ["module"]);
  assert.ok(matchesFingerprint(root, "module", dirty.files.module));
  write(module, "sample.txt", "edited again\n");
  assert.deepEqual(changesBetween(dirty, takeSnapshot(root)).changedPaths, ["module"]);
  git(module, "restore", "sample.txt");
  write(module, "new.txt", "local\n");
  assert.deepEqual(changesBetween(clean, takeSnapshot(root)).changedPaths, ["module"]);
  git(root, "submodule", "deinit", "-q", "--force", "--", "module");
  const uninitialized = takeSnapshot(root);
  assert.equal(uninitialized.files.module, "submodule uninitialized");
  assert.deepEqual(changesBetween(clean, uninitialized).changedPaths, ["module"]);
});

test("未初始化、无提交及 Git 元数据异常时按子模块工作文件核对快照和交付指纹", (t) => {
  const root = gitProject(t);
  const module = join(root, "module");
  mkdirSync(module);
  git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD")},module`);
  git(root, "commit", "-qm", "gitlink");
  const empty = takeSnapshot(root);
  assert.equal(empty.files.module, "submodule uninitialized");
  const outside = project(t);
  write(outside, "sample", "initial");
  symlinkSync(outside, join(module, "link"));
  const checkWorkFiles = (state) => {
    write(module, "docs/sample", "first");
    const before = takeSnapshot(root);
    assert.match(before.files.module, state);
    assert.deepEqual(takeSnapshot(root, [], before), before);
    assert.ok(matchesFingerprint(root, "module", before.files.module));
    write(module, "docs/sample", "second");
    const after = takeSnapshot(root, [], before);
    assert.deepEqual(changesBetween(before, after).changedPaths, ["module"]);
    assert.ok(!matchesFingerprint(root, "module", before.files.module));
    write(module, "docs/sample", "first");
    assert.ok(matchesFingerprint(root, "module", before.files.module));
    return before;
  };
  const uninitialized = checkWorkFiles(/^submodule uninitialized /);
  assert.deepEqual(changesBetween(empty, uninitialized).changedPaths, ["module"]);
  write(outside, "sample", "changed");
  assert.deepEqual(takeSnapshot(root), uninitialized);
  git(module, "init", "-q");
  checkWorkFiles(/^submodule unborn /);
  commitAll(module, "sample");
  const head = git(module, "rev-parse", "HEAD");
  write(module, ".git/index", "invalid fixture index");
  checkWorkFiles(new RegExp(`^submodule unreadable ${head} `));
  rmSync(join(module, ".git"), { recursive: true });
  write(module, ".git", "invalid fixture gitfile");
  checkWorkFiles(/^submodule unreadable - /);
});

test("符号链接目标、类型变化及仅暂存状态变化", (t) => {
  const dir = gitProject(t);
  write(dir, "a.txt", "one\n");
  symlinkSync("a.txt", join(dir, "link"));
  commitAll(dir, "files");
  const clean = takeSnapshot(dir);
  rmSync(join(dir, "link"));
  symlinkSync("other", join(dir, "link"));
  const changedLink = takeSnapshot(dir);
  assert.deepEqual(changesBetween(clean, changedLink).changedPaths, ["link"]);
  git(dir, "add", "link");
  assert.deepEqual(changesBetween(changedLink, takeSnapshot(dir)).changedPaths, []);
  rmSync(join(dir, "link"));
  write(dir, "link", "other");
  assert.deepEqual(changesBetween(changedLink, takeSnapshot(dir)).changedPaths, ["link"]);
  rmSync(join(dir, "link"));
  symlinkSync("a.txt", join(dir, "link"));
  assert.deepEqual(changesBetween(clean, takeSnapshot(dir)).changedPaths, []);
  git(dir, "reset", "-q", "HEAD", "--", "link");
  git(dir, "rm", "--cached", "a.txt");
  const cachedRemoval = takeSnapshot(dir);
  assert.deepEqual(changesBetween(clean, cachedRemoval).changedPaths, []);
  git(dir, "reset", "-q", "HEAD", "--", "a.txt");
  assert.deepEqual(changesBetween(cachedRemoval, takeSnapshot(dir)).changedPaths, []);
  write(dir, "a.txt", "two\n");
  write(dir, "new.txt", "new\n");
  const dirty = takeSnapshot(dir);
  assert.deepEqual(changesBetween(clean, dirty).changedPaths, ["a.txt", "new.txt"]);
  git(dir, "add", "a.txt", "new.txt");
  assert.deepEqual(changesBetween(dirty, takeSnapshot(dir)).changedPaths, []);
  write(dir, "a.txt", "one\n");
  const stagedOnly = takeSnapshot(dir);
  assert.deepEqual(changesBetween(clean, stagedOnly).changedPaths, ["new.txt"]);
  git(dir, "reset", "-q", "HEAD", "--", "a.txt", "new.txt");
  assert.deepEqual(changesBetween(stagedOnly, takeSnapshot(dir)).changedPaths, []);
  rmSync(join(dir, "a.txt"));
  const removed = takeSnapshot(dir);
  git(dir, "add", "-u");
  assert.deepEqual(changesBetween(removed, takeSnapshot(dir)).changedPaths, []);
});

test("普通文本按 Git 干净语义跨指纹比较，脏状态之间仍按原始字节比较", (t) => {
  const dir = gitProject(t);
  write(dir, ".gitattributes", "*.txt text\n");
  write(dir, "a.txt", "one\n");
  commitAll(dir, "files");
  write(dir, "a.txt", "one\r\n");
  git(dir, "add", "a.txt");
  const clean = takeSnapshot(dir);
  assert.match(clean.files["a.txt"], /^git /);
  write(dir, "a.txt", "two\n");
  git(dir, "add", "a.txt");
  write(dir, "a.txt", "one\r\n");
  const staged = takeSnapshot(dir);
  assert.deepEqual(changesBetween(clean, staged).changedPaths, []);
  write(dir, "a.txt", "one\n");
  assert.deepEqual(changesBetween(staged, takeSnapshot(dir)).changedPaths, ["a.txt"]);
  write(dir, "a.txt", "one\r\n");
  git(dir, "reset", "-q", "HEAD", "--", "a.txt");
  assert.deepEqual(changesBetween(staged, takeSnapshot(dir)).changedPaths, []);
});

test("归档修改、删除与非普通索引条目按实际内容结算，也兼容旧字节快照", (t) => {
  const dir = gitProject(t);
  const path = ".knit/tasks/archive/2026-10/old/task.md";
  write(dir, path, "one\n");
  commitAll(dir, "archive");
  const clean = takeSnapshot(dir);
  const legacy = { head: clean.head, files: { [path]: fingerprint(dir, path) } };
  assert.deepEqual(takeSnapshot(dir, [], legacy), legacy);
  git(dir, "update-index", "--assume-unchanged", path);
  write(dir, path, "two\n");
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.deepEqual(changesBetween(clean, takeSnapshot(dir)).changedPaths, [path]);
  git(dir, "update-index", "--no-assume-unchanged", path);
  for (const before of [clean, legacy]) {
    assert.deepEqual(changesBetween(before, takeSnapshot(dir, [], before)).changedPaths, [path]);
  }
  rmSync(join(dir, path));
  for (const before of [clean, legacy]) {
    assert.deepEqual(changesBetween(before, takeSnapshot(dir, [], before)).changedPaths, [path]);
  }
});

test("批量核对 Git、混合、旧字节、链接及新增删除指纹", (t) => {
  const dir = gitProject(t);
  for (const path of ["clean", "dirty", "legacy", "gone"]) write(dir, path, "base");
  symlinkSync("clean", join(dir, "link"));
  commitAll(dir, "files");
  rmSync(join(dir, "gone"));
  write(dir, "dirty", "reviewed");
  write(dir, "added", "new");
  const expected = takeSnapshot(dir).files;
  expected.legacy = fingerprint(dir, "legacy");
  const paths = [...Object.keys(expected), "later"];
  write(dir, "later", "after review");
  assert.deepEqual(matchingFingerprints(dir, paths, expected), new Set(Object.keys(expected)));
  rmSync(join(dir, "clean"));
  rmSync(join(dir, "link"));
  symlinkSync("dirty", join(dir, "link"));
  write(dir, "gone", "restored");
  write(dir, "legacy", "changed");
  const matching = matchingFingerprints(dir, paths, expected);
  assert.deepEqual(matching, new Set(["dirty", "added"]));
  paths.forEach((path) => assert.equal(matchesFingerprint(dir, path, expected[path]), matching.has(path)));
});

test("旧快照仍可按原始字节结算", (t) => {
  const dir = gitProject(t);
  write(dir, "a.txt", "one\n");
  write(dir, "b.txt", "one\n");
  commitAll(dir, "files");
  const before = JSON.parse(JSON.stringify({ head: git(dir, "rev-parse", "HEAD"), files: Object.fromEntries(["a.txt", "b.txt"].map((path) => [path, fingerprint(dir, path)])) }));
  write(dir, "b.txt", "two\n");
  assert.deepEqual(changesBetween(before, takeSnapshot(dir, [], before)).changedPaths, ["b.txt"]);
});

test("Git 列出未跟踪的钩子后，另一成员在取指纹期间删除它", (t) => {
  const dir = gitProject(t);
  const hook = ".agents/hooks.json";
  const before = takeSnapshot(dir);
  for (const operation of ["lstatSync", "readFileSync"]) {
    write(dir, hook, "{}");
    const original = fs[operation];
    const handle = t.mock.method(fs, operation, (path, ...args) => {
      if (path === join(dir, hook)) rmSync(path);
      return original(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(takeSnapshot(dir), before);
    } finally {
      handle.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("HEAD 动了能看出来", (t) => {
  const dir = gitProject(t);
  write(dir, "src/a.ts", "one\n");
  commitAll(dir, "files");
  const before = takeSnapshot(dir);
  assert.equal(before.head, git(dir, "rev-parse", "HEAD"));

  write(dir, "src/a.ts", "two\n");
  commitAll(dir, "change");

  const changes = changesBetween(before, takeSnapshot(dir));
  assert.deepEqual(changes.head, { before: before.head, after: git(dir, "rev-parse", "HEAD") });
  assert.match(changes.head.before, /^[0-9a-f]{40}$/);
  assert.match(changes.head.after, /^[0-9a-f]{40}$/);
  assert.notEqual(changes.head.before, changes.head.after);
  assert.deepEqual(changes.changedPaths, ["src/a.ts"]);

  // 还没有提交的仓库
  const empty = project(t);
  git(empty, "init", "-q");
  write(empty, "a.txt", "a\n");
  write(empty, "b.txt", "b\n");
  git(empty, "add", "a.txt");
  const initial = takeSnapshot(empty);
  assert.deepEqual(initial.files, { "a.txt": fingerprint(empty, "a.txt"), "b.txt": fingerprint(empty, "b.txt") });
  assert.equal(initial.head, null);
});

test("单执行器覆盖角色时仍保护流程引用的共享路径", () => {
  const parsed = parseWorkflow("version: 1\nstages:\n  - id: review\n    prompt: roles/shared.md\n    executors: [{prompt: roles/chosen.md}]\n");
  const referenced = ["roles/shared.md", "roles/chosen.md"];
  assert.deepEqual(protectedChanges([...referenced, ".knit/agents/other.md"], parsed.workflow), referenced);
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
