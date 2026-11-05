/**
 * 016 快照对照与逐路径恢复：真实 Git、真实文件、真实 index。
 * 不使用 mock fs，不调用模型；伪造快照损坏用于核实中断记录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { TaskService } from "../dist/application/task-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { SnapshotService } from "../dist/application/snapshot.js";
import { RestoreService } from "../dist/application/restore.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { readWithVersion } from "../dist/infrastructure/atomic.js";
import { sha256Text } from "../dist/contracts/digest.js";

const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-016-${prefix}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\nignored.txt\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "text.txt"), "base\n");
  writeFileSync(join(dir, "gone.txt"), "gone\n");
  writeFileSync(join(dir, "bin.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(dir, "bin.sh"), 0o755);
  writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 1, 255, 2]));
  symlinkSync("text.txt", join(dir, "link"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "keep.txt"), "keep\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  // 快照前的 index 与工作区不同，恢复 --index 才有独立内容可对照。
  writeFileSync(join(dir, "text.txt"), "staged-index\n");
  git(dir, ["add", "text.txt"]);
  writeFileSync(join(dir, "text.txt"), "base\n");
  writeFileSync(join(dir, "untracked.txt"), "untracked-base\n");
  return dir;
}

async function snapshotFixture(prefix, setup) {
  const dir = project(prefix);
  if (setup !== undefined) setup(dir);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({ store, locks, randomHex, lockRoot: join(dir, ".locks") });
  const restores = new RestoreService({ store, locks, randomHex });
  const task = await tasks.newTask({ dir, title: "restore task", slug: "restore-task", verification: "independent" });
  await tasks.ready({ dir, taskId: task.taskId });
  const prepared = await coordinator.prepare({
    dir,
    taskId: task.taskId,
    phase: "implement",
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: { runtime: "pi", provider: "test", model: "fake" },
  });
  const runId = prepared.request.runId;
  const snapshot = new SnapshotService({ randomHex }).create({ root: dir, runId });
  assert.equal(snapshot.state, "ready", snapshot.reason ?? "");
  return { dir, store, locks, tasks, restores, task, runId, snapshot };
}

function cleanup(fixture) {
  fixture.store.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

/** 把 v2 manifest 降级成 v1 形状：补全副本、去除引用字段，模拟旧版快照。 */
function downgradeToV1(dir, runId) {
  const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
  const manifestPath = join(snapshotDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const entry of manifest.entries) {
    if (entry.source === "head") {
      const data = execFileSync("git", ["cat-file", "blob", entry.headOid], { cwd: dir });
      const destination = join(snapshotDir, "files", entry.path);
      mkdirSync(join(destination, ".."), { recursive: true });
      if (entry.kind === "symlink") symlinkSync(data.toString("utf8"), destination);
      else writeFileSync(destination, data);
      delete entry.source;
      delete entry.headOid;
    }
    if (entry.indexSource === "head") {
      const data = execFileSync("git", ["cat-file", "blob", entry.indexHeadOid], { cwd: dir });
      const destination = join(snapshotDir, "index", entry.path);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, data);
      delete entry.indexSource;
      delete entry.indexHeadOid;
    }
  }
  manifest.schemaVersion = 1;
  delete manifest.savedBytes;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function fingerprint(dir, path) {
  const target = join(dir, path);
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) return `symlink:${readlinkSync(target)}`;
    if (stats.isFile()) return `file:${readFileSync(target).toString("hex")}`;
  } catch {
    return "absent";
  }
  return "other";
}

test("snapshot show 与逐路径恢复：二进制、模式、删除、未跟踪、符号链接和 index", async () => {
  const fixture = await snapshotFixture("all");
  const { dir, restores, task, runId } = fixture;
  try {
    const runDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    const textEntry = manifest.entries.find((entry) => entry.path === "text.txt");
    assert.ok(textEntry.indexDigest, "tracked file 必须保存 index 摘要");
    assert.ok(existsSync(join(runDir, "index", "text.txt")), "不同 index 内容必须落盘");
    assert.equal(existsSync(join(runDir, "files", "created.txt")), false);

    writeFileSync(join(dir, "text.txt"), "later worktree\n");
    git(dir, ["add", "text.txt"]);
    writeFileSync(join(dir, "text.txt"), "later worktree 2\n");
    chmodSync(join(dir, "bin.sh"), 0o644);
    rmSync(join(dir, "gone.txt"));
    rmSync(join(dir, "link"));
    symlinkSync("README.md", join(dir, "link"));
    writeFileSync(join(dir, "binary.bin"), "broken binary");
    writeFileSync(join(dir, "untracked.txt"), "untracked-later\n");
    writeFileSync(join(dir, "created.txt"), "created later\n");

    const shown = restores.show({ dir, runId, path: "text.txt" });
    assert.equal(shown.entries.length, 1);
    assert.equal(JSON.stringify(shown).includes("base\n"), false, "show 不输出正文");

    const preview = restores.preview({
      dir,
      runId,
      paths: ["text.txt", "bin.sh", "gone.txt", "link", "binary.bin", "untracked.txt", "created.txt"],
      index: true,
      removeCreated: true,
    });
    const byPath = Object.fromEntries(preview.plans.map((item) => [item.path, item]));
    assert.equal(byPath["text.txt"].action, "restore");
    assert.equal(byPath["text.txt"].indexAction, "set");
    assert.equal(byPath["gone.txt"].action, "restore");
    assert.equal(byPath["link"].action, "restore");
    assert.equal(byPath["binary.bin"].action, "restore");
    assert.equal(byPath["untracked.txt"].action, "restore");
    assert.equal(byPath["created.txt"].action, "delete");
    assert.equal(byPath["created.txt"].guard, "remove_created_required");

    const expect = Object.fromEntries(preview.plans.map((item) => [item.path, item.current.fingerprint]));
    const result = await restores.restore({
      dir,
      runId,
      paths: preview.plans.map((item) => item.path),
      index: true,
      removeCreated: true,
      expect,
    });
    assert.equal(result.state, "completed");
    assert.equal(readFileSync(join(dir, "text.txt"), "utf8"), "base\n");
    assert.equal(lstatSync(join(dir, "bin.sh")).mode & 0o111, 0o111);
    assert.equal(readlinkSync(join(dir, "link")), "text.txt");
    assert.deepEqual(readFileSync(join(dir, "binary.bin")), Buffer.from([0, 1, 255, 2]));
    assert.equal(readFileSync(join(dir, "untracked.txt"), "utf8"), "untracked-base\n");
    assert.equal(existsSync(join(dir, "gone.txt")), true, "快照中的文件应重建");
    assert.equal(existsSync(join(dir, "created.txt")), false, "--remove-created 删除后来路径");
    assert.equal(git(dir, ["ls-files", "-s", "--", "text.txt"]).trim().split(/\s+/)[1], textEntry.indexOid, "index 恢复为快照 blob");
    assert.equal(readFileSync(join(dir, result.recordPath), "utf8").includes('"state": "completed"'), true);
  } finally {
    cleanup(fixture);
  }
});

test("后续修改与指纹不匹配即停；删除后来路径必须显式 --remove-created", async () => {
  const fixture = await snapshotFixture("guard");
  const { dir, restores, runId } = fixture;
  try {
    writeFileSync(join(dir, "created.txt"), "later\n");
    const preview = restores.preview({ dir, runId, paths: ["created.txt"] });
    const expect = { "created.txt": preview.plans[0].current.fingerprint };
    await assert.rejects(
      () => restores.restore({ dir, runId, paths: ["created.txt"], expect }),
      (error) => error.details?.guardReason === "remove_created_required",
    );
    assert.equal(existsSync(join(dir, "created.txt")), true);
    writeFileSync(join(dir, "created.txt"), "changed after preview\n");
    await assert.rejects(
      () => restores.restore({ dir, runId, paths: ["created.txt"], removeCreated: true, expect }),
      (error) => error.details?.guardReason === "stale_input",
    );
    assert.equal(existsSync(join(dir, "created.txt")), true);
  } finally {
    cleanup(fixture);
  }
});

test("Task 输入恢复经 task update，保留 frontmatter、记录与后来记录", async () => {
  const fixture = await snapshotFixture("task-input");
  const { dir, restores, tasks, task, runId } = fixture;
  try {
    const taskPath = join(dir, ".knit", task.relativePath);
    const before = readFileSync(taskPath, "utf8");
    await tasks.update({
      dir,
      taskId: task.taskId,
      kind: "change",
      reason: "后来输入",
      content: "# 后来输入\n\n后来内容\n",
      runActive: false,
    });
    const current = readFileSync(taskPath, "utf8");
    assert.notEqual(current, before);
    const taskDirName = task.relativePath.split("/")[1];
    const preview = restores.preview({ dir, runId, paths: [`.knit/tasks/${taskDirName}/task.md`] });
    assert.equal(preview.plans[0].guard, "task_input");
    const result = await restores.restore({
      dir,
      runId,
      paths: [preview.plans[0].path],
      expect: { [preview.plans[0].path]: preview.plans[0].current.fingerprint },
    });
    assert.equal(result.state, "completed");
    assert.equal(result.taskInputUpdated, true);
    const after = readFileSync(taskPath, "utf8");
    assert.match(after, /待讨论确认/, "旧输入区回到快照模板");
    assert.doesNotMatch(after, /后来内容/);
    const taskDoc = await tasks.readInputs({ dir, taskId: task.taskId });
    assert.match(taskDoc.inputsDigest, /^[0-9a-f]{64}$/);
  } finally {
    cleanup(fixture);
  }
});

test("分支变化拒绝；恢复源码会清空旧检查资格并把 deliver 回 check", async () => {
  const fixture = await snapshotFixture("check");
  const { dir, restores, store, task, runId } = fixture;
  try {
    const binding = await store.bindings.get(task.taskId);
    assert.ok(binding);
    await store.bindings.save({ ...binding, lastCheckRunId: "run-000000000001" });
    const taskPath = join(dir, ".knit", task.relativePath);
    writeFileSync(taskPath, readFileSync(taskPath, "utf8").replace(/^stage: .*$/m, "stage: deliver"));
    const text = readFileSync(join(dir, "text.txt"), "utf8");
    const preview = restores.preview({ dir, runId, paths: ["README.md"] });
    const result = await restores.restore({
      dir,
      runId,
      paths: ["README.md"],
      expect: { "README.md": preview.plans[0].current.fingerprint },
    });
    assert.equal(result.checkInvalidated, true);
    assert.equal((await store.bindings.get(task.taskId)).lastCheckRunId, null);
    assert.match(readFileSync(taskPath, "utf8"), /^stage: check$/m);
    assert.equal(readFileSync(join(dir, "text.txt"), "utf8"), text);

    git(dir, ["checkout", "-q", "-b", "other"]);
    assert.throws(
      () => restores.preview({ dir, runId, paths: ["text.txt"] }),
      (error) => error.details?.guardReason === "branch_changed",
    );
  } finally {
    cleanup(fixture);
  }
});

test("恢复预览后 index 或工作区变化停止；损坏 index 快照留下可核实的中断记录", async () => {
  const fixture = await snapshotFixture("interrupt");
  const { dir, restores, runId } = fixture;
  try {
    writeFileSync(join(dir, "text.txt"), "later\n");
    const preview = restores.preview({ dir, runId, paths: ["text.txt"], index: true });
    const expect = { "text.txt": preview.plans[0].current.fingerprint };
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    const indexFile = join(snapshotDir, "index", "text.txt");
    assert.equal(existsSync(indexFile), true);
    writeFileSync(indexFile, "corrupt-index\n");
    await assert.rejects(
      () => restores.restore({ dir, runId, paths: ["text.txt"], index: true, expect }),
      /index 摘要不符|index 内容缺失/,
    );
    const records = await import("node:fs").then(({ readdirSync }) => readdirSync(join(dir, ".knit", ".runtime", "restores")));
    assert.ok(records.length >= 1);
    const record = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "restores", records[0]), "utf8"));
    assert.equal(record.state, "needs_attention");
    assert.equal(record.results[0].status, "failed");
  } finally {
    cleanup(fixture);
  }
});

test("越界与父级符号链接拒绝；快照缺失/未 ready 不冒充可恢复", async () => {
  const fixture = await snapshotFixture("escape");
  const { dir, restores, runId } = fixture;
  try {
    assert.throws(
      () => restores.preview({ dir, runId, paths: ["../outside"] }),
      (error) => error.details?.guardReason === "path_escape",
    );
    const outside = mkdtempSync(join(tmpdir(), "knit-016-outside-"));
    symlinkSync(outside, join(dir, "escape-dir"));
    assert.throws(
      () => restores.preview({ dir, runId, paths: ["escape-dir/file"] }),
      (error) => error.details?.guardReason === "path_escape",
    );
    rmSync(outside, { recursive: true, force: true });
    assert.throws(
      () => restores.preview({ dir, runId: "run-000000000000", paths: ["text.txt"] }),
      (error) => error.details?.guardReason === "unknown_run",
    );
  } finally {
    cleanup(fixture);
  }
});

test("snapshot CLI：show／预览／--expect 执行保持 stdout 协议", async () => {
  const fixture = await snapshotFixture("cli");
  const { dir, runId } = fixture;
  try {
    const run = (args) => {
      const result = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], { cwd: dir, encoding: "utf8" });
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
    const shown = run(["snapshot", "show", runId, "--path", "text.txt"]);
    assert.equal(shown.code, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout);
    assert.equal(shownJson.outcome, "completed");
    assert.equal(shownJson.data.entries.length, 1);
    writeFileSync(join(dir, "text.txt"), "cli later\n");
    const preview = run(["snapshot", "restore", runId, "--path", "text.txt"]);
    assert.equal(preview.code, 0, preview.stderr);
    const previewJson = JSON.parse(preview.stdout);
    assert.equal(previewJson.outcome, "completed");
    const plan = previewJson.data.preview.plans[0];
    assert.equal(plan.action, "restore");
    const executed = run(["snapshot", "restore", runId, "--path", "text.txt", "--expect", `text.txt=${plan.current.fingerprint}`]);
    assert.equal(executed.code, 0, executed.stderr);
    const executedJson = JSON.parse(executed.stdout);
    assert.equal(executedJson.outcome, "completed");
    assert.equal(executedJson.data.state, "completed");
    assert.equal(readFileSync(join(dir, "text.txt"), "utf8"), "base\n");
    const bad = run(["snapshot", "restore", runId, "--path", "text.txt", "--expect", "file:bad"]);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.stdout).outcome, "error");
  } finally {
    cleanup(fixture);
  }
});

test("HEAD 基线引用恢复：内容、模式与 index 均按记录 OID 还原", async () => {
  const fixture = await snapshotFixture("baseline");
  const { dir, restores, runId } = fixture;
  try {
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    const manifest = JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8"));
    const readme = manifest.entries.find((entry) => entry.path === "README.md");
    const text = manifest.entries.find((entry) => entry.path === "text.txt");
    assert.equal(readme.source, "head");
    assert.equal(readme.indexSource, "head");
    assert.equal(existsSync(join(snapshotDir, "files", "README.md")), false, "HEAD 同内容不写 worktree 副本");
    assert.equal(existsSync(join(snapshotDir, "index", "README.md")), false, "HEAD 同 OID 不写 index 副本");
    assert.equal(text.source, "head", "工作区 text.txt 与 HEAD 同字节");
    assert.equal(text.indexSource, undefined, "暂存内容与 HEAD 不同必须复制");
    assert.equal(existsSync(join(snapshotDir, "index", "text.txt")), true);

    writeFileSync(join(dir, "README.md"), "# later\n");
    writeFileSync(join(dir, "text.txt"), "later worktree\n");
    git(dir, ["add", "text.txt"]);
    writeFileSync(join(dir, "text.txt"), "later worktree 2\n");
    chmodSync(join(dir, "bin.sh"), 0o644);

    const preview = restores.preview({ dir, runId, paths: ["README.md", "text.txt", "bin.sh"], index: true });
    const expect = Object.fromEntries(preview.plans.map((item) => [item.path, item.current.fingerprint]));
    const result = await restores.restore({ dir, runId, paths: ["README.md", "text.txt", "bin.sh"], index: true, expect });
    assert.equal(result.state, "completed");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n");
    assert.equal(readFileSync(join(dir, "text.txt"), "utf8"), "base\n");
    assert.equal(lstatSync(join(dir, "bin.sh")).mode & 0o111, 0o111, "模式来自 manifest，不依赖副本");
    assert.equal(lstatSync(join(dir, "README.md")).mode & 0o111, 0);
    const indexOid = (path) => git(dir, ["ls-files", "-s", "--", path]).trim().split(/\s+/)[1];
    assert.equal(indexOid("README.md"), readme.indexOid);
    assert.equal(indexOid("text.txt"), text.indexOid);
  } finally {
    cleanup(fixture);
  }
});

test("amend 后 HEAD 变化但对象仍在：按快照记录 OID 恢复成功", async () => {
  const fixture = await snapshotFixture("amend");
  const { dir, restores, runId } = fixture;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "runs", runId, "snapshot", "manifest.json"), "utf8"));
    const readme = manifest.entries.find((entry) => entry.path === "README.md");
    writeFileSync(join(dir, "README.md"), "# amended\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-q", "--amend", "--no-edit"]);
    assert.notEqual(git(dir, ["rev-parse", "HEAD"]).trim(), manifest.base.head, "HEAD 必须已变化");
    assert.equal(spawnSync("git", ["cat-file", "-e", readme.headOid], { cwd: dir }).status, 0, "旧 blob 仍存在");

    writeFileSync(join(dir, "README.md"), "broken\n");
    const preview = restores.preview({ dir, runId, paths: ["README.md"] });
    const result = await restores.restore({
      dir,
      runId,
      paths: ["README.md"],
      expect: { "README.md": preview.plans[0].current.fingerprint },
    });
    assert.equal(result.state, "completed");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n");
  } finally {
    cleanup(fixture);
  }
});

test("基线对象被 reflog expire + gc 清除：报 snapshot_baseline_unavailable 且不部分恢复", async () => {
  const fixture = await snapshotFixture("gc");
  const { dir, restores, runId } = fixture;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "runs", runId, "snapshot", "manifest.json"), "utf8"));
    const readme = manifest.entries.find((entry) => entry.path === "README.md");
    writeFileSync(join(dir, "README.md"), "# amended for gc\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-q", "--amend", "--no-edit"]);
    git(dir, ["reflog", "expire", "--expire=now", "--all"]);
    git(dir, ["gc", "--prune=now"]);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", readme.headOid], { cwd: dir }).status,
      0,
      "旧 blob 必须已被清除",
    );

    writeFileSync(join(dir, "README.md"), "broken\n");
    const preview = restores.preview({ dir, runId, paths: ["README.md"] });
    await assert.rejects(
      () =>
        restores.restore({
          dir,
          runId,
          paths: ["README.md"],
          expect: { "README.md": preview.plans[0].current.fingerprint },
        }),
      (error) =>
        error.details?.guardReason === "snapshot_baseline_unavailable" &&
        error.message.includes("README.md"),
    );
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "broken\n", "失败不留下部分恢复");
  } finally {
    cleanup(fixture);
  }
});

test("v1 manifest（无 source 字段）按全量副本恢复，行为不变", async () => {
  const fixture = await snapshotFixture("v1");
  const { dir, restores, runId } = fixture;
  try {
    const manifest = downgradeToV1(dir, runId);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.savedBytes, undefined);
    assert.equal(manifest.entries.some((entry) => "source" in entry || "indexSource" in entry), false);
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    assert.equal(existsSync(join(snapshotDir, "files", "README.md")), true);
    assert.equal(existsSync(join(snapshotDir, "index", "README.md")), true);
    assert.equal(new RunStore(dir).readSnapshot(runId).schemaVersion, 1);

    writeFileSync(join(dir, "README.md"), "# later\n");
    writeFileSync(join(dir, "text.txt"), "later index\n");
    git(dir, ["add", "text.txt"]);
    writeFileSync(join(dir, "text.txt"), "later worktree\n");
    const preview = restores.preview({ dir, runId, paths: ["README.md", "text.txt"], index: true });
    const expect = Object.fromEntries(preview.plans.map((item) => [item.path, item.current.fingerprint]));
    const result = await restores.restore({ dir, runId, paths: ["README.md", "text.txt"], index: true, expect });
    assert.equal(result.state, "completed");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n");
    assert.equal(readFileSync(join(dir, "text.txt"), "utf8"), "base\n");
  } finally {
    cleanup(fixture);
  }
});

test("file↔symlink 类型变化不跨类型引用基线，恢复原类型", async () => {
  const fixture = await snapshotFixture("types", (dir) => {
    writeFileSync(join(dir, "switch"), "README.md");
    symlinkSync("README.md", join(dir, "reverse"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "types"]);
    // 字节相同但类型对调：不能被误判为 HEAD 同类型基线。
    rmSync(join(dir, "switch"));
    symlinkSync("README.md", join(dir, "switch"));
    rmSync(join(dir, "reverse"));
    writeFileSync(join(dir, "reverse"), "README.md");
  });
  const { dir, restores, runId } = fixture;
  try {
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    const manifest = JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8"));
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("switch").source, undefined);
    assert.equal(byPath.get("reverse").source, undefined);
    assert.equal(lstatSync(join(snapshotDir, "files", "switch")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(snapshotDir, "files", "reverse")).isFile(), true);

    rmSync(join(dir, "switch"));
    writeFileSync(join(dir, "switch"), "broken\n");
    rmSync(join(dir, "reverse"));
    symlinkSync("elsewhere", join(dir, "reverse"));
    const preview = restores.preview({ dir, runId, paths: ["switch", "reverse"] });
    const expect = Object.fromEntries(preview.plans.map((item) => [item.path, item.current.fingerprint]));
    const result = await restores.restore({ dir, runId, paths: ["switch", "reverse"], expect });
    assert.equal(result.state, "completed");
    assert.equal(lstatSync(join(dir, "switch")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(dir, "switch")), "README.md");
    assert.equal(lstatSync(join(dir, "reverse")).isFile(), true);
    assert.equal(readFileSync(join(dir, "reverse"), "utf8"), "README.md");
  } finally {
    cleanup(fixture);
  }
});

test("未知较新版本 manifest（v3）：show／preview／restore 只报 version_conflict，不返回内容", async () => {
  const fixture = await snapshotFixture("v3");
  const { dir, restores, runId } = fixture;
  try {
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    const manifestPath = join(snapshotDir, "manifest.json");
    const newer = JSON.parse(readFileSync(manifestPath, "utf8"));
    newer.schemaVersion = 3;
    newer.addedInLaterVersion = true;
    writeFileSync(manifestPath, JSON.stringify(newer, null, 2) + "\n");
    const original = readFileSync(manifestPath);
    const isVersionConflict = (error) => {
      assert.equal(error.code, "version_conflict");
      assert.equal(error.details.found, 3);
      assert.equal(error.details.expected, 2);
      assert.match(error.details.path, /snapshot[/\\]manifest\.json$/);
      return true;
    };

    assert.throws(() => restores.show({ dir, runId }), isVersionConflict, "show 不给内容");
    assert.throws(() => restores.preview({ dir, runId, paths: ["README.md"] }), isVersionConflict, "preview 不返回计划");
    await assert.rejects(
      () => restores.restore({ dir, runId, paths: ["README.md"], expect: { "README.md": "file:deadbeef:100644" } }),
      isVersionConflict,
      "restore 不执行写入",
    );
    assert.deepEqual(readFileSync(manifestPath), original, "只读报告不覆盖原 manifest");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n", "未尝试恢复工作区");
  } finally {
    cleanup(fixture);
  }
});

test("手写 v1 manifest（全量副本、无 source 字段）：restore 成功且语义与 v2 前一致", async () => {
  const fixture = await snapshotFixture("v1-manual");
  const { dir, restores, runId } = fixture;
  try {
    const snapshotDir = join(dir, ".knit", ".runtime", "runs", runId, "snapshot");
    const manifestPath = join(snapshotDir, "manifest.json");
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const readme = "# demo\n";
    const text = "base\n";
    const untracked = "untracked-base\n";
    const manifest = {
      schemaVersion: 1,
      runId,
      state: "ready",
      createdAt: new Date().toISOString(),
      base: { head, branch: "main", absent: false },
      coverage: { tracked: true, index: true, untracked: true, worktree: true },
      entries: [
        { path: "README.md", layer: "tracked", kind: "file", mode: 0o100644, size: Buffer.byteLength(readme), digest: sha256Text(readme), linkTarget: null, absent: false, indexOid: null },
        { path: "text.txt", layer: "tracked", kind: "file", mode: 0o100644, size: Buffer.byteLength(text), digest: sha256Text(text), linkTarget: null, absent: false, indexOid: null },
        { path: "untracked.txt", layer: "untracked", kind: "file", mode: 0o100644, size: Buffer.byteLength(untracked), digest: sha256Text(untracked), linkTarget: null, absent: false, indexOid: null },
      ],
      counts: { tracked: 2, untracked: 1, absent: 0 },
      bytes: Buffer.byteLength(readme) + Buffer.byteLength(text) + Buffer.byteLength(untracked),
      maxBytes: 67108864,
      digest: "v1-manual",
      reason: null,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    mkdirSync(join(snapshotDir, "files"), { recursive: true });
    writeFileSync(join(snapshotDir, "files", "README.md"), readme);
    writeFileSync(join(snapshotDir, "files", "text.txt"), text);
    writeFileSync(join(snapshotDir, "files", "untracked.txt"), untracked);

    const stored = new RunStore(dir).readSnapshot(runId);
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.entries.some((entry) => "source" in entry || "indexSource" in entry), false);

    // HEAD 内容改走后，恢复仍必须取快照副本，证明 v1 语义是全量副本。
    writeFileSync(join(dir, "README.md"), "# head-moved\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-q", "-m", "head moves"]);
    writeFileSync(join(dir, "README.md"), "# worktree\n");

    const preview = restores.preview({ dir, runId, paths: ["README.md"] });
    assert.equal(preview.plans[0].action, "restore");
    const result = await restores.restore({
      dir,
      runId,
      paths: ["README.md"],
      expect: { "README.md": preview.plans[0].current.fingerprint },
    });
    assert.equal(result.state, "completed");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), readme, "从 snapshot/files 读取，不依赖 HEAD");
  } finally {
    cleanup(fixture);
  }
});

test("v1 快照重复 snapshot／restore 幂等：不升级写法、不重复改动", async () => {
  const fixture = await snapshotFixture("v1-idem");
  const { dir, restores, runId } = fixture;
  try {
    downgradeToV1(dir, runId);
    const manifestPath = join(dir, ".knit", ".runtime", "runs", runId, "snapshot", "manifest.json");
    const before = readFileSync(manifestPath);
    assert.equal(JSON.parse(before.toString("utf8")).schemaVersion, 1);

    const again = new SnapshotService({ randomHex }).create({ root: dir, runId });
    assert.equal(again.state, "ready");
    assert.equal(again.manifest.schemaVersion, 1);
    assert.deepEqual(readFileSync(manifestPath), before, "ready 快照重跑不重写 manifest");

    writeFileSync(join(dir, "README.md"), "# later\n");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preview = restores.preview({ dir, runId, paths: ["README.md"] });
      const result = await restores.restore({
        dir,
        runId,
        paths: ["README.md"],
        expect: { "README.md": preview.plans[0].current.fingerprint },
      });
      assert.equal(result.state, "completed");
      assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\n");
    }
    assert.deepEqual(readFileSync(manifestPath), before, "恢复不改写 v1 manifest");
  } finally {
    cleanup(fixture);
  }
});
