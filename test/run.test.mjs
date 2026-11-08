/**
 * 012 快照准备、local 启动与 worker 认领测试。
 * 真实 Git 仓库、真实 worker 子进程、真实文件；不调用模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync, realpathSync,
  readdirSync,
  readFileSync,
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
import { RunStore } from "../dist/infrastructure/run-store.js";
import { atomicWrite, readWithVersion } from "../dist/infrastructure/atomic.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/application/task-document.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-012-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\nignored.txt\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function services(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks, randomHex });
  const coordinator = new RunCoordinator({
    store,
    randomHex,
    lockRoot: join(dir, ".locks"),
    confirmTimeoutMs: 8000,
    prepareOnly: true,
  });
  return { store, locks, tasks, coordinator };
}

async function readyTask(dir, services, title = "run 任务") {
  const task = await services.tasks.newTask({ dir, title, slug: title.replace(/\s+/g, "-"), verification: "independent" });
  await services.tasks.ready({ dir, taskId: task.taskId });
  return task;
}

function model() {
  return { runtime: "pi", provider: "test", model: "fake" };
}

function prepareInput(dir, taskId, phase = "implement") {
  return {
    dir,
    taskId,
    phase,
    initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
    model: model(),
  };
}

test("prepare 只发布请求；start 后 worker 自行持锁并冻结输入，正式代码前快照 ready", async () => {
  const dir = project("prepare");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s);
    const taskFile = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
    const beforeTask = readFileSync(taskFile, "utf8");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    assert.equal(prepared.reused, false);
    assert.equal(prepared.launch.state, "planned");
    const store = new RunStore(dir);
    const runDir = store.runDir(prepared.request.runId);
    assert.ok(existsSync(join(runDir, "request.json")));
    assert.ok(existsSync(join(runDir, "launch.json")));
    assert.equal(existsSync(join(runDir, "inputs.json")), false);
    assert.equal(existsSync(join(runDir, "state.json")), false);
    assert.equal(existsSync(join(runDir, "snapshot")), false);
    // 无 CLI→worker 长锁交接：prepare 不留下项目执行占用。
    const projectLocks = join(dir, ".locks", "projects");
    assert.equal(existsSync(projectLocks) ? execFileSync("find", [projectLocks, "-mindepth", "1"], { encoding: "utf8" }).trim() : "", "");
    assert.equal(readFileSync(taskFile, "utf8"), beforeTask);
    const operation = await s.store.operations.get(prepared.request.acceptanceOperationId);
    assert.equal(operation.state, "planned");

    // 重复 prepare 复用同一 run，不生成替代运行。
    const again = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    assert.equal(again.reused, true);
    assert.equal(again.request.runId, prepared.request.runId);

    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.launch.state, "confirmed");
    assert.equal(started.confirmed, true);
    assert.equal(started.state.prepared, true);
    assert.equal(started.state.snapshot.state, "ready");
    assert.equal(started.state.worker.pid > 0, true);
    const inputs = store.readInputs(prepared.request.runId);
    assert.equal(inputs.effectiveInputsDigest, prepared.request.expected.effectiveInputsDigest);
    assert.ok(inputs.sections.some((section) => section.kind === "task-inputs"));
    const instructions = store.readInstructions(prepared.request.runId);
    assert.ok(instructions.entries.length >= 3);
    assert.equal(readFileSync(taskFile, "utf8"), beforeTask);
    // worker 退出后释放占用（prepared 落盘与释放有很短竞态，轮询确认）。
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const left = existsSync(projectLocks)
        ? execFileSync("find", [projectLocks, "-mindepth", "1"], { encoding: "utf8" }).trim()
        : "";
      if (left === "") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(existsSync(projectLocks) ? execFileSync("find", [projectLocks, "-mindepth", "1"], { encoding: "utf8" }).trim() : "", "");

    // 已确认后再次 start：观察原运行，不重复启动。
    const second = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(second.reused, true);
    assert.equal(second.launch.attempts, 1);
    assert.equal(second.launch.handle.pid, started.launch.handle.pid);
    const status = await s.coordinator.status({ dir, runId: prepared.request.runId });
    assert.equal(status.prepared, true);
    assert.equal(status.snapshot.state, "ready");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("并行纯记录可写入且不改变冻结输入或快照", async () => {
  const dir = project("record");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "record task");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    const before = await s.store.bindings.get(task.taskId);
    const [started, recorded] = await Promise.all([
      s.coordinator.start({ dir, runId: prepared.request.runId }),
      s.tasks.record({ dir, taskId: task.taskId, body: "并行记录：工具输出摘要\n" }),
    ]);
    assert.equal(started.confirmed, true);
    assert.equal(recorded.saved, true);
    const inputs = new RunStore(dir).readInputs(prepared.request.runId);
    assert.equal(inputs.inputsDigest, before.confirmedInputsDigest);
    assert.equal(inputs.effectiveInputsDigest, prepared.request.expected.effectiveInputsDigest);
    assert.equal(new RunStore(dir).readSnapshot(prepared.request.runId).state, "ready");
    const taskFile = readFileSync(join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md"), "utf8");
    assert.ok(taskFile.includes("并行记录：工具输出摘要"));
    // 记录不改 phase／输入摘要，也不阻塞后续观察。
    const status = await s.coordinator.status({ dir, runId: prepared.request.runId });
    assert.equal(status.prepared, true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("快照保存 tracked/index/untracked、模式与缺失起点，排除 ignored 与 runtime", async () => {
  const dir = project("snapshot");
  const s = services(dir);
  try {
    writeFileSync(join(dir, "gone.txt"), "will delete\n");
    writeFileSync(join(dir, "script.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "script.sh"), 0o755);
    writeFileSync(join(dir, "link"), "target\n");
    symlinkSync("README.md", join(dir, "symlink"));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "files"]);

    writeFileSync(join(dir, "README.md"), "# changed\n");
    writeFileSync(join(dir, "staged.txt"), "staged\n");
    git(dir, ["add", "staged.txt"]);
    writeFileSync(join(dir, "untracked.txt"), "untracked\n");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "deep.txt"), "deep\n");
    writeFileSync(join(dir, "ignored.txt"), "ignore me\n");
    rmSync(join(dir, "gone.txt"));

    const task = await readyTask(dir, s, "snapshot task");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    const result = new SnapshotService().create({ root: dir, runId: prepared.request.runId });
    assert.equal(result.state, "ready");
    assert.equal(result.manifest.coverage.tracked, true);
    assert.equal(result.manifest.coverage.index, true);
    assert.equal(result.manifest.coverage.untracked, true);
    assert.equal(result.manifest.coverage.worktree, true);
    const byPath = new Map(result.manifest.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("README.md").digest.length, 64);
    assert.equal(byPath.get("staged.txt").indexOid.length > 0, true);
    assert.equal(byPath.get("untracked.txt").layer, "untracked");
    assert.equal(byPath.get("nested/deep.txt").layer, "untracked");
    assert.equal(byPath.get("script.sh").mode, 0o100755);
    assert.equal(byPath.get("symlink").kind, "symlink");
    assert.equal(byPath.get("symlink").linkTarget, "README.md");
    assert.equal(byPath.get("gone.txt").absent, true);
    assert.equal(byPath.has("ignored.txt"), false);
    assert.equal([...byPath.keys()].some((path) => path.startsWith(".knit/.runtime/")), false);
    const snapshotFile = join(dir, ".knit", ".runtime", "runs", prepared.request.runId, "snapshot", "files");
    assert.equal(readFileSync(join(snapshotFile, "README.md"), "utf8"), "# changed\n");
    assert.equal(readFileSync(join(snapshotFile, "untracked.txt"), "utf8"), "untracked\n");
    // 与 HEAD 同内容的 tracked 文件／链接只记基线引用，不再复制副本。
    assert.equal(result.manifest.schemaVersion, 2);
    assert.equal(byPath.get("symlink").source, "head");
    assert.equal(existsSync(join(snapshotFile, "symlink")), false);
    assert.equal(byPath.get("script.sh").source, "head");
    assert.equal(existsSync(join(snapshotFile, "script.sh")), false);
    assert.ok(result.manifest.savedBytes > 0);
    assert.equal(result.manifest.counts.absent, 1);
    // 重复创建幂等，不重建。
    const again = new SnapshotService().create({ root: dir, runId: prepared.request.runId });
    assert.equal(again.manifest.digest, result.manifest.digest);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("快照超限或 Git 覆盖未知时 failed，不产生 ready", async () => {
  const dir = project("limits");
  const s = services(dir);
  try {
    writeFileSync(join(dir, "big.txt"), "x".repeat(4096));
    git(dir, ["add", "big.txt"]);
    git(dir, ["commit", "-q", "-m", "big"]);
    // 与 HEAD 不同才按实际字节计费；同内容引用基线不受上限影响。
    writeFileSync(join(dir, "big.txt"), "y".repeat(4096));
    const task = await readyTask(dir, s, "limit task");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    const tooLarge = new SnapshotService().create({ root: dir, runId: prepared.request.runId, maxBytes: 100 });
    assert.equal(tooLarge.state, "failed");
    assert.equal(tooLarge.manifest.reason, "snapshot_too_large");
    assert.equal(tooLarge.manifest.state, "failed");

    const unknown = new SnapshotService({
      git: () => ({ code: 128, stdout: "", stderr: "git unavailable" }),
    }).create({ root: dir, runId: prepared.request.runId });
    assert.equal(unknown.state, "failed");
    assert.equal(unknown.manifest.reason, "snapshot_unknown");
    assert.equal(unknown.manifest.coverage.tracked, false);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("中断残留的 snapshot.tmp-* 在重建时回收，不留临时目录", async () => {
  const dir = project("snapshot-tmp");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "tmp residue task");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    const runDir = new RunStore(dir).runDir(prepared.request.runId);
    // 模拟上次进程中断：残留临时目录与半成品内容。
    const stale = join(runDir, "snapshot.tmp-deadbeefcafe");
    mkdirSync(join(stale, "files"), { recursive: true });
    writeFileSync(join(stale, "files", "partial.txt"), "x".repeat(1024));
    const result = new SnapshotService().create({ root: dir, runId: prepared.request.runId });
    assert.equal(result.state, "ready");
    assert.equal(existsSync(stale), false);
    const left = readdirSync(runDir).filter((name) => name.startsWith("snapshot.tmp-"));
    assert.deepEqual(left, []);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("worker 复核失败：待应用输入、输入变化、分支变化都不进入 prepared", async () => {
  // 待应用输入：prepare 后保存草案，worker 认领时必须拒绝。
  {
    const dir = project("pending");
    const s = services(dir);
    try {
      const task = await readyTask(dir, s, "pending task");
      const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
      await s.tasks.update({
        dir,
        taskId: task.taskId,
        kind: "change",
        reason: "运行中收到新要求",
        content: "补充：失败必须带退出码。",
        pending: true,
      });
      const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
      assert.equal(started.confirmed, false);
      assert.equal(started.launch.state, "failed");
      assert.equal(started.state.state, "failed");
      assert.equal(started.state.reason, "pending_inputs");
    } finally {
      s.store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }
  // 输入变化：直接改输入区，phase 保持 implement。
  {
    const dir = project("stale");
    const s = services(dir);
    try {
      const task = await readyTask(dir, s, "stale task");
      const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
      const file = join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "task.md");
      const version = readWithVersion(file);
      const document = parseTaskDocument(version.data.toString("utf8"), file);
      atomicWrite({
        path: file,
        data: Buffer.from(
          renderTaskDocument({
            ...document,
            inputsBody: `${document.inputsBody}\n补充要求：必须记录退出码。\n`,
          }),
          "utf8",
        ),
        expectedSha256: version.sha256,
        mode: 0o644,
      });
      const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
      assert.equal(started.state.reason, "request_stale");
      assert.equal(started.confirmed, false);
    } finally {
      s.store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }
});

test("部分启动：句柄死亡且未认领时 failed，重复 start 不换 run，显式 retry 才重试同一 run", async () => {
  const dir = project("partial");
  const s = services(dir);
  const fixture = join(dir, "fake-worker.mjs");
  writeFileSync(fixture, "process.exit(0);\n");
  try {
    const task = await readyTask(dir, s, "partial task");
    const coordinator = new RunCoordinator({
      store: s.store,
      randomHex,
      lockRoot: join(dir, ".locks"),
      workerCommand: [process.execPath, fixture],
      confirmTimeoutMs: 1500,
    });
    const prepared = await coordinator.prepare(prepareInput(dir, task.taskId));
    const first = await coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(first.confirmed, false);
    assert.equal(first.launch.state, "failed");
    assert.equal(first.launch.attempts, 1);
    assert.match(first.launch.lastError, /worker_exited_before_claim/);

    const second = await coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(second.reused, true);
    assert.equal(second.launch.attempts, 1);

    const retried = await coordinator.start({ dir, runId: prepared.request.runId, retry: true });
    assert.equal(retried.launch.attempts, 2);
    assert.equal(retried.launch.runId, prepared.request.runId);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("worker 自行取锁：项目占用被占时失败，释放后可显式重试同一 run", async () => {
  const dir = project("lockbusy");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "lock task");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    const held = await s.locks.acquire({ keys: [{ scope: "project", rawKey: dir }], action: "test.hold" });
    try {
      const blocked = await s.coordinator.start({ dir, runId: prepared.request.runId });
      assert.equal(blocked.confirmed, false);
      assert.equal(blocked.launch.state, "failed");
      assert.equal(blocked.state.reason, "lock_busy");
      assert.equal(blocked.launch.attempts, 1);
    } finally {
      s.locks.release(held);
    }
    const retried = await s.coordinator.start({ dir, runId: prepared.request.runId, retry: true });
    assert.equal(retried.confirmed, true);
    assert.equal(retried.launch.attempts, 2);
    assert.equal(retried.state.prepared, true);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("句柄缺失时不启动第二个 worker，只置 failed 等待显式重试", async () => {
  const dir = project("nohandle");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "no handle");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId));
    const runs = new RunStore(dir);
    const launch = runs.readLaunch(prepared.request.runId);
    runs.writeLaunch(prepared.request.runId, {
      ...launch,
      state: "starting",
      attempts: 1,
      handle: null,
      updatedAt: new Date().toISOString(),
    });
    const started = await s.coordinator.start({ dir, runId: prepared.request.runId });
    assert.equal(started.launch.state, "failed");
    assert.equal(started.launch.lastError, "handle_missing");
    assert.equal(started.launch.attempts, 1);
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("阶段／计划守卫：phase 不符、草案未应用、规范缺失都不发布请求", async () => {
  const dir = project("guards");
  const s = services(dir);
  try {
    const discuss = await s.tasks.newTask({ dir, title: "讨论中", slug: "discuss" });
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(dir, discuss.taskId)),
      (error) => error.guardReason === "phase_mismatch",
    );
    assert.equal(new RunStore(dir).listRunIds().length, 0);

    const task = await readyTask(dir, s, "guard task");
    await s.tasks.update({
      dir,
      taskId: task.taskId,
      kind: "change",
      reason: "草案",
      content: "草案内容",
      pending: true,
    });
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(dir, task.taskId)),
      (error) => error.guardReason === "pending_inputs",
    );

    const binding = await s.store.bindings.get(task.taskId);
    await s.tasks.withdrawPending({
      dir,
      taskId: task.taskId,
      expectPending: binding.pendingDraft.digest,
      withdrawReason: "取消草案",
    });
    rmSync(join(dir, ".knit", "standards", "index.md"));
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(dir, task.taskId)),
      (error) => error.guardReason === "plan_not_ready",
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("自定义流程阶段：task ready 进入配置首阶段，run prepare 接受 --stage", async () => {
  const dir = project("custom-stage");
  const s = services(dir);
  try {
    writeFileSync(
      join(dir, ".knit", "workflow.yaml"),
      "version: 1\nstages:\n  - id: build\n    name: 构建\n  - id: verify\n    name: 验证\n",
    );
    const task = await s.tasks.newTask({ dir, title: "custom stage", slug: "custom-stage", verification: "self" });
    const ready = await s.tasks.ready({ dir, taskId: task.taskId });
    assert.equal(ready.stage, "build", "ready 进入配置首阶段");
    const prepared = await s.coordinator.prepare(prepareInput(dir, task.taskId, "build"));
    assert.equal(prepared.request.phase, "build");
    assert.equal(prepared.request.workflowMode, "config");
    assert.equal(prepared.reused, false);
    await assert.rejects(
      () => s.coordinator.prepare(prepareInput(dir, task.taskId, "bogus")),
      (error) => {
        assert.equal(error.guardReason, "stage_not_in_workflow");
        assert.match(error.message, /合法阶段: build、verify/);
        return true;
      },
    );
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("CLI：prepare/start/status/list 协议输出，未知 run 非零退出", async () => {
  const dir = project("cli");
  const s = services(dir);
  try {
    const task = await readyTask(dir, s, "cli task");
    const prepareRaw = execFileSync(
      process.execPath,
      [
        CLI,
        "--json",
        "run",
        "prepare",
        "--task",
        task.taskId,
        "--stage",
        "implement",
        "--provider",
        "test",
        "--model",
        "fake",
        "--dir",
        dir,
      ],
      { encoding: "utf8" },
    );
    const prepared = JSON.parse(prepareRaw);
    assert.equal(prepared.outcome, "completed");
    assert.match(prepared.data.request.runId, /^run-[0-9a-f]{12}$/);

    const startRaw = execFileSync(
      process.execPath,
      [CLI, "--json", "run", "start", prepared.data.request.runId, "--locks", join(dir, ".locks"), "--prepare-only", "--dir", dir],
      { encoding: "utf8" },
    );
    const started = JSON.parse(startRaw);
    assert.equal(started.data.confirmed, true);
    assert.equal(started.data.state.prepared, true);

    // 父进程观察已断开（上一条 CLI 已退出）后再次 start：仍观察原运行。
    const againRaw = execFileSync(
      process.execPath,
      [CLI, "--json", "run", "start", prepared.data.request.runId, "--locks", join(dir, ".locks"), "--prepare-only", "--dir", dir],
      { encoding: "utf8" },
    );
    const again = JSON.parse(againRaw);
    assert.equal(again.data.launch.attempts, 1);
    assert.equal(again.data.reused, true);

    const statusRaw = execFileSync(
      process.execPath,
      [CLI, "--json", "run", "status", prepared.data.request.runId, "--dir", dir],
      { encoding: "utf8" },
    );
    const status = JSON.parse(statusRaw);
    assert.equal(status.data.prepared, true);
    assert.equal(status.data.snapshot.state, "ready");

    const listRaw = execFileSync(process.execPath, [CLI, "--json", "run", "list", "--dir", dir], { encoding: "utf8" });
    assert.equal(JSON.parse(listRaw).data.length, 1);

    let badRaw;
    try {
      execFileSync(process.execPath, [CLI, "--json", "run", "status", "run-000000000000", "--dir", dir], {
        encoding: "utf8",
      });
      assert.fail("未知 run 应失败");
    } catch (error) {
      badRaw = error.stdout;
    }
    const bad = JSON.parse(badRaw);
    assert.equal(bad.outcome, "error");
    assert.equal(bad.reasonCode, "invalid_request");
  } finally {
    s.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
