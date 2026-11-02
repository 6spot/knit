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

async function snapshotFixture(prefix) {
  const dir = project(prefix);
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({ store, locks, randomHex, lockRoot: join(dir, ".locks") });
  const restores = new RestoreService({ store, locks, randomHex });
  const task = await tasks.newTask({ dir, title: "restore task", slug: "restore-task" });
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
    const preview = restores.preview({ dir, runId, paths: [".knit/tasks/11-02-restore-task/task.md"] });
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
    writeFileSync(taskPath, readFileSync(taskPath, "utf8").replace(/^phase: .*$/m, "phase: deliver"));
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
    assert.match(readFileSync(taskPath, "utf8"), /^phase: check$/m);
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
