import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import {
  TaskService,
  taskDirectoryName,
  renderInitialTaskBody,
  TaskGuardError,
} from "../dist/application/task-service.js";
import {
  parseTaskDocument,
  renderTaskDocument,
} from "../dist/application/task-document.js";
import {
  inputsDigestOf,
  progressRegionOf,
  PROGRESS_START,
  PROGRESS_END,
  pendingDraftDigest,
  newTaskId,
} from "../dist/contracts/task-inputs.js";
import { LockManager } from "../dist/infrastructure/locks.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

/** 真实 Git 仓库夹具：每个测试独立临时目录。 */
function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-009-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeService(dir, overrides = {}) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const service = new TaskService({
    store,
    locks: new LockManager({ root: join(dir, ".lock-root") }),
    randomHex: overrides.randomHex,
    now: overrides.now,
  });
  return { store, service };
}

function taskFile(dir, relativePath) {
  return join(dir, ".knit", relativePath);
}

function fixedDate() {
  // 2026-11-02 本地日期；getMonth/getDate 按本地时区——夹具用 UTC 月份日。
  return new Date("2026-11-02T03:04:05Z");
}

test("正式任务创建要求 Git／本地文件系统前置", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knit-009-nogit-"));
  try {
    const { store, service } = makeService(dir);
    try {
      await assert.rejects(
        () => service.newTask({ dir, title: "无 Git", slug: "nogit" }),
        (error) => error.guardReason === "git_required",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("taskDirectoryName：日期前缀与重名短序号", () => {
  const existing = ["11-02-fix-login"];
  assert.equal(taskDirectoryName(fixedDate(), "fix-login", existing), "11-02-fix-login-2");
  assert.equal(taskDirectoryName(fixedDate(), "fix-login", []), "11-02-fix-login");
  assert.equal(taskDirectoryName(fixedDate(), "fix-login", ["11-02-fix-login", "11-02-fix-login-2", "11-02-fix-login-3"]), "11-02-fix-login-4");
});

test("task.md 文档模型：分区解析与往返渲染", () => {
  const { inputsBody, progressBody } = renderInitialTaskBody("修复登录");
  const doc = { frontmatter: { id: "k-0123456789ab", status: "open", phase: "discuss", outcome: null, branch: "refs/heads/main", createdAt: "2026-11-02T00:00:00Z", title: "修复登录" }, inputsBody, progressBody, trailingBody: "" };
  const markdown = renderTaskDocument(doc);
  const parsed = parseTaskDocument(markdown);
  assert.deepEqual(parsed.frontmatter, doc.frontmatter);
  assert.ok(parsed.inputsBody.includes("## 目标与边界"));
  assert.ok(parsed.progressBody.includes("## 当前位置"));
  // 记录区不进输入摘要
  const before = inputsDigestOf(markdown);
  const appended = renderTaskDocument({ ...parsed, progressBody: parsed.progressBody + "\n追加记录\n" });
  assert.equal(inputsDigestOf(appended), before, "记录区变化不改变输入摘要");
  assert.ok(progressRegionOf(appended).includes("追加记录"));
  // 缺标记与缺 frontmatter 报结构错误
  assert.throws(() => parseTaskDocument("no frontmatter"), /frontmatter/);
  assert.throws(() => parseTaskDocument(renderTaskDocument(doc).replace(PROGRESS_START, "<!-- removed -->")), /记录区标记/);
  // 未知 frontmatter 值被拒
  const bad = renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, phase: "research" } });
  assert.throws(() => parseTaskDocument(bad), /schema/);
});

test("task new：稳定 ID、目录创建与 binding 落库", async () => {
  const dir = gitProject("new");
  const { store, service } = makeService(dir, { now: fixedDate });
  try {
    const result = await service.newTask({ dir, title: "修复登录", slug: "fix-login" });
    assert.match(result.taskId, /^k-[0-9a-f]{12}$/);
    assert.equal(result.relativePath, "tasks/11-02-fix-login/task.md");
    const binding = await store.bindings.get(result.taskId);
    assert.equal(binding.branch, null);
    assert.equal(binding.confirmedInputsDigest, null);
    assert.equal(binding.pendingDraft, null);
    const markdown = readFileSync(taskFile(dir, result.relativePath), "utf8");
    const parsed = parseTaskDocument(markdown);
    assert.equal(parsed.frontmatter.id, result.taskId);
    assert.equal(parsed.frontmatter.phase, "discuss");
    // 同 ID 歧义：已存在该 ID 的文件时重新生成
    const second = await service.newTask({ dir, title: "另一个任务" });
    assert.notEqual(second.taskId, result.taskId);
    const list = service.list({ dir });
    assert.equal(list.active.length, 2);
    assert.equal(list.archived.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task new：目录重名追加短序号；list 含归档分区", async () => {
  const dir = gitProject("dup");
  const { store, service } = makeService(dir, { now: fixedDate });
  try {
    const first = await service.newTask({ dir, title: "A", slug: "same" });
    assert.equal(first.relativePath, "tasks/11-02-same/task.md");
    const second = await service.newTask({ dir, title: "B", slug: "same" });
    assert.equal(second.relativePath, "tasks/11-02-same-2/task.md");
    // 归档分区：手工模拟归档月份目录
    const archivedDir = join(dir, ".knit", "tasks", "archive", "2026-10", "10-01-old");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, "task.md"), renderTaskDocument({
      frontmatter: { id: "k-ffffffffffff", status: "closed", phase: "deliver", outcome: "completed", branch: null, createdAt: "2026-10-01T00:00:00Z", title: "旧任务" },
      ...renderInitialTaskBody("旧任务"),
      trailingBody: "",
    }));
    const list = service.list({ dir });
    assert.equal(list.active.length, 2);
    assert.equal(list.archived.length, 1);
    assert.equal(list.archived[0].taskId, "k-ffffffffffff");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task record：只改记录区、版本核对、并行短锁串行", async () => {
  const dir = gitProject("record");
  const { store, service } = makeService(dir);
  try {
    const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
    const file = taskFile(dir, relativePath);
    const digestBefore = inputsDigestOf(readFileSync(file, "utf8"));
    const result = await service.record({ dir, taskId, body: "进展：完成调研" });
    assert.equal(result.saved, true);
    const markdown = readFileSync(file, "utf8");
    assert.equal(inputsDigestOf(markdown), digestBefore, "纯记录不改变输入摘要");
    assert.ok(progressRegionOf(markdown).includes("进展：完成调研"));
    // 版本核对：外部改动后用旧预期版本写失败（version_conflict），后来内容保留
    const before = readFileSync(file, "utf8");
    const service2 = makeService(dir).service;
    writeFileSync(file, markdown.replace("进展：完成调研", "外部编辑介入"));
    await assert.rejects(
      async () => {
        // 用旧版本重放同样的写入：服务每次读最新版本，这里直接构造旧 expected 不可行——
        // 改为并发竞争：两个服务同时 record，一个必成功，另一个版本冲突或重读成功。
        const [a, b] = await Promise.allSettled([
          service2.record({ dir, taskId, body: "并发A" }),
          service2.record({ dir, taskId, body: "并发B" }),
        ]);
        const outcomes = [a, b].map((r) => (r.status === "fulfilled" ? r.value.saved : r.reason?.code));
        assert.ok(outcomes.every((o) => o === true || o === "version_conflict" || o === "lock_busy"), `并发结果合法: ${outcomes}`);
        throw Object.assign(new Error("done"), { code: "done" });
      },
      (error) => error.code === "done",
    );
    const final = readFileSync(file, "utf8");
    assert.ok(/并发A|并发B/.test(progressRegionOf(final)), "并发记录其一生效");
    // 外部编辑的内容未被静默覆盖
    assert.ok(progressRegionOf(final).includes("外部编辑介入"), "外部编辑内容未被静默覆盖");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task adopt：分支变化保持早期 phase，deliver 回 check，清检查资格并保留历史", async () => {
  const dir = gitProject("adopt");
  const { store, service } = makeService(dir);
  try {
    const task = await service.newTask({ dir, title: "接管", slug: "adopt" });
    const file = taskFile(dir, task.relativePath);
    const doc = parseTaskDocument(readFileSync(file, "utf8"), file);
    writeFileSync(file, renderTaskDocument({
      ...doc,
      frontmatter: { ...doc.frontmatter, branch: "refs/heads/other", phase: "deliver", status: "open", outcome: null },
    }));
    const binding = await store.bindings.get(task.taskId);
    await store.bindings.save({ ...binding, branch: "refs/heads/other", lastCheckRunId: "run-000000000001" });
    const adopted = await service.adopt({ dir, taskId: task.taskId, branch: "current" });
    assert.equal(adopted.branch, "refs/heads/main");
    assert.equal(adopted.previousBranch, "refs/heads/other");
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.checkInvalidated, true);
    assert.equal(adopted.phase, "check");
    const after = parseTaskDocument(readFileSync(file, "utf8"), file);
    assert.equal(after.frontmatter.branch, "refs/heads/main");
    assert.equal(after.frontmatter.phase, "check");
    assert.equal(after.frontmatter.status, "open");
    assert.equal(after.frontmatter.outcome, null);
    assert.equal((await store.bindings.get(task.taskId)).lastCheckRunId, null);
    const again = await service.adopt({ dir, taskId: task.taskId, branch: "current" });
    assert.equal(again.adopted, false);
    assert.equal(again.checkInvalidated, false);
    await assert.rejects(
      () => service.adopt({ dir, taskId: task.taskId, branch: "refs/heads/other" }),
      (error) => error.guardReason === "branch_mismatch",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task adopt：活动 run 或未核实 Git 效果拒绝，不写 Task", async () => {
  const dir = gitProject("adopt-guard");
  const { store, service } = makeService(dir);
  const gate = { settled: async () => false };
  const guarded = new TaskService({
    store,
    locks: new LockManager({ root: join(dir, ".lock-root") }),
    runActivity: gate,
  });
  try {
    const task = await service.newTask({ dir, title: "接管守卫", slug: "adopt-guard" });
    const file = taskFile(dir, task.relativePath);
    const before = readFileSync(file, "utf8");
    const doc = parseTaskDocument(before, file);
    writeFileSync(file, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, branch: "refs/heads/other" } }));
    await assert.rejects(
      () => guarded.adopt({ dir, taskId: task.taskId, branch: "current" }),
      (error) => error.guardReason === "runs_unsettled",
    );
    assert.match(readFileSync(file, "utf8"), /^branch: refs\/heads\/other$/m);
    await store.operations.save({
      operationId: "op-adopt-unverified",
      kind: "delivery.deliver",
      state: "needs_attention",
      reason: "hook",
      recordedAt: new Date().toISOString(),
      taskId: task.taskId,
    });
    await assert.rejects(
      () => service.adopt({ dir, taskId: task.taskId, branch: "current" }),
      (error) => error.guardReason === "git_effect_unverified",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task ready：discuss → implement 并冻结输入摘要；phase 不符拒绝", async () => {
  const dir = gitProject("ready");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "T" });
    const ready = await service.ready({ dir, taskId });
    assert.equal(ready.phase, "implement");
    assert.match(ready.confirmedInputsDigest, /^[0-9a-f]{64}$/);
    const binding = await store.bindings.get(taskId);
    assert.equal(binding.confirmedInputsDigest, ready.confirmedInputsDigest);
    // 再次 ready：phase_mismatch
    await assert.rejects(() => service.ready({ dir, taskId }), (error) => {
      assert.ok(error instanceof TaskGuardError);
      assert.equal(error.details.guardReason, "phase_mismatch");
      return true;
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task update：clarify 保持 phase 且不使摘要未变任务迁移；change 回 discuss", async () => {
  const dir = gitProject("update-kind");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "T" });
    await service.ready({ dir, taskId });
    // change：回 open/discuss
    const change = await service.update({ dir, taskId, kind: "change", reason: "范围扩大", content: "## 目标与边界\n\n新目标\n", runActive: false });
    assert.equal(change.applied, "direct");
    assert.equal(change.phase, "discuss");
    assert.equal(change.digestChanged, true);
    // clarify：保持 discuss
    const clarify = await service.update({ dir, taskId, kind: "clarify", reason: "补充资料", content: "## 目标与边界\n\n新目标\n（补充定位：src/login.ts）\n", runActive: false });
    assert.equal(clarify.phase, "discuss");
    assert.equal(clarify.digestChanged, true);
    // 摘要未变的 clarify 不迁移
    const same = await service.update({ dir, taskId, kind: "clarify", reason: "解释原要求", content: "## 目标与边界\n\n新目标\n（补充定位：src/login.ts）\n", runActive: false });
    assert.equal(same.digestChanged, false);
    assert.equal(same.phase, "discuss");
    // frontmatter 转移已写回
    const binding = await store.bindings.get(taskId);
    assert.equal(binding.confirmedInputsDigest, clarify.inputsDigest);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task update：活动 run 只保存草案；apply/withdraw 按摘要与基线核对", async () => {
  const dir = gitProject("pending");
  const { store, service } = makeService(dir);
  try {
    const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
    const file = taskFile(dir, relativePath);
    const baseline = await service.readInputs({ dir, taskId });
    // 运行中：保存草案，冻结输入不变
    const saved = await service.update({ dir, taskId, kind: "clarify", reason: "运行中补充资料", content: "## 目标与边界\n\n澄清后目标\n", runActive: true, updateOperationId: "op-1" });
    assert.equal(saved.applied, "pending_saved");
    assert.ok(saved.pendingDraftDigest);
    assert.equal(saved.digestChanged, false);
    assert.equal(parseTaskDocument(readFileSync(file, "utf8")).frontmatter.phase, "discuss");
    // 第二份草案被拒（至多一份）
    await assert.rejects(
      () => service.update({ dir, taskId, kind: "clarify", reason: "再来一份", content: "x", runActive: true }),
      (error) => error instanceof TaskGuardError && error.details.guardReason === "pending_draft_exists",
    );
    // 摘要不对的 apply 拒绝，且不作用于后来草案
    await assert.rejects(
      () => service.update({ dir, taskId, expectPending: "deadbeef" }),
      (error) => error.code === "version_conflict",
    );
    assert.ok((await store.bindings.get(taskId)).pendingDraft, "错误摘要不撤回草案");
    // 基线变化：外部先改输入区再 apply —— 不覆盖后来输入
    const draft = (await store.bindings.get(taskId)).pendingDraft;
    const doc = parseTaskDocument(readFileSync(file, "utf8"));
    writeFileSync(file, renderTaskDocument({ ...doc, inputsBody: doc.inputsBody + "\n后来补充的输入\n" }));
    await assert.rejects(
      () => service.update({ dir, taskId, expectPending: draft.digest }),
      (error) => error.code === "version_conflict" && /基线/.test(error.message),
    );
    assert.ok(readFileSync(file, "utf8").includes("后来补充的输入"), "基线变化后草案不覆盖后来输入");
    // 撤回：摘要匹配才撤；后来同内容草案不受影响（摘要含操作 ID 与时间，版本各异）
    const withdrawn = await service.update({ dir, taskId, expectPending: draft.digest, withdrawReason: "用户确认不需要" });
    assert.equal(withdrawn.applied, "pending_withdrawn");
    assert.equal(withdrawn.digestChanged, false);
    assert.equal((await store.bindings.get(taskId)).pendingDraft, null);
    // 撤回留操作记录（任务029：不写 task.md，避免活动运行中 .knit 保护误伤）；输入区不变
    const operations = await store.operations.list();
    const withdrawRecord = operations.filter((op) => op.kind === "task.withdraw-pending");
    assert.equal(withdrawRecord.length, 1);
    assert.ok(withdrawRecord[0].reason.includes("用户确认不需要"));
    const after = parseTaskDocument(readFileSync(file, "utf8"));
    assert.ok(after.inputsBody.includes("后来补充的输入"));
    // 同内容重建获得新版本：digest 不同（createdAt / 操作 ID 参与摘要）
    const d1 = pendingDraftDigest({ kind: "clarify", reason: "r", content: "c", baselineDigest: "b", updateOperationId: "op-1", createdAt: "2026-01-01T00:00:00Z" });
    const d2 = pendingDraftDigest({ kind: "clarify", reason: "r", content: "c", baselineDigest: "b", updateOperationId: "op-2", createdAt: "2026-01-01T00:00:00Z" });
    assert.notEqual(d1, d2, "同内容重建也获得新版本摘要");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("输入草案竞争：存在草案时直接更新拒绝；同内容新版本、基线冲突与 apply/withdraw 互斥", async () => {
  const dir = gitProject("pending-race");
  const { store, service } = makeService(dir, { now: fixedDate });
  try {
    const task = await service.newTask({ dir, title: "草案竞争", slug: "pending-race" });
    await service.ready({ dir, taskId: task.taskId });
    const content = "## 目标与边界\n\n新目标\n";
    const draft = await service.update({
      dir,
      taskId: task.taskId,
      kind: "change",
      reason: "运行中改变目标",
      content,
      runActive: true,
      updateOperationId: "op-pending-1",
    });
    assert.equal(draft.applied, "pending_saved");
    // 有草案时不能绕过 apply 直接改输入。
    await assert.rejects(
      () => service.update({ dir, taskId: task.taskId, kind: "clarify", reason: "直接改", content: "x", runActive: false }),
      (error) => /pending_draft_exists|pending_inputs/.test(error.message),
    );
    // 旧摘要不能撤回后来同内容新版本。
    const withdrawn = await service.update({
      dir,
      taskId: task.taskId,
      expectPending: draft.pendingDraftDigest,
      withdrawReason: "先撤回",
    });
    assert.equal(withdrawn.applied, "pending_withdrawn");
    const same = await service.update({
      dir,
      taskId: task.taskId,
      kind: "change",
      reason: "运行中改变目标",
      content,
      runActive: true,
      updateOperationId: "op-pending-2",
    });
    assert.notEqual(same.pendingDraftDigest, draft.pendingDraftDigest, "同内容新操作仍是新版本");
    // apply 必须确认 run 已收敛。
    await assert.rejects(
      () => service.update({ dir, taskId: task.taskId, expectPending: same.pendingDraftDigest, runsSettled: false }),
      (error) => /runs_unsettled|收敛/.test(error.message),
    );
    // 基线输入被外部改变后，旧草案不覆盖新输入。
    const taskPath = join(dir, ".knit", task.relativePath);
    const original = readFileSync(taskPath, "utf8");
    writeFileSync(taskPath, original.replace("## 目标与边界", "## 目标与边界\n\n外部补充"), "utf8");
    await assert.rejects(
      () => service.update({ dir, taskId: task.taskId, expectPending: same.pendingDraftDigest }),
      /基线输入已变化/,
    );
    // 新版本可撤回，旧摘要不作用于它。
    const current = await store.bindings.get(task.taskId);
    await assert.rejects(
      () => service.update({ dir, taskId: task.taskId, expectPending: draft.pendingDraftDigest, withdrawReason: "旧摘要" }),
      /版本摘要不匹配/,
    );
    const last = await service.update({ dir, taskId: task.taskId, expectPending: current.pendingDraft.digest, withdrawReason: "最终撤回" });
    assert.equal(last.applied, "pending_withdrawn");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task update：apply 按草案 kind 应用；change 草案回 discuss，clarify 草案保持", async () => {
  const dir = gitProject("apply");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "T" });
    await service.ready({ dir, taskId });
    // 模拟运行中保存 change 草案
    const saved = await service.update({ dir, taskId, kind: "change", reason: "目标改变", content: "## 目标与边界\n\n改变后的目标\n", runActive: true, updateOperationId: "op-9" });
    const applied = await service.update({ dir, taskId, expectPending: saved.pendingDraftDigest });
    assert.equal(applied.applied, "pending_applied");
    assert.equal(applied.phase, "discuss", "change 草案应用后回 discuss");
    assert.equal(applied.status, "open");
    assert.equal((await store.bindings.get(taskId)).pendingDraft, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task rename：等价移动不改变输入摘要；路径线索与绑定更新", async () => {
  const dir = gitProject("rename");
  const { store, service } = makeService(dir, { now: fixedDate });
  try {
    const { taskId, relativePath } = await service.newTask({ dir, title: "T", slug: "before" });
    const file = taskFile(dir, relativePath);
    const digestBefore = inputsDigestOf(readFileSync(file, "utf8"));
    const renamed = await service.rename({ dir, taskId, newSlug: "after", equivalent: true });
    assert.equal(renamed.from, "11-02-before");
    assert.equal(renamed.to, "11-02-after");
    const binding = await store.bindings.get(taskId);
    assert.equal(binding.relativePath, "tasks/11-02-after/task.md");
    assert.equal(inputsDigestOf(readFileSync(taskFile(dir, "tasks/11-02-after/task.md"), "utf8")), digestBefore, "等价移动摘要不变");
    assert.ok(!existsSync(file), "旧目录已移动");
    // 同名目标冲突
    const other = await service.newTask({ dir, title: "X", slug: "after" });
    assert.equal(other.relativePath, "tasks/11-02-after-2/task.md", "重名追加序号");
    // 无 MM-DD 前缀的目录改名报错
    const weirdDir = join(dir, ".knit", "tasks", "nodate");
    mkdirSync(weirdDir, { recursive: true });
    writeFileSync(join(weirdDir, "task.md"), readFileSync(taskFile(dir, "tasks/11-02-after/task.md"), "utf8").replace(/^id: .*/m, "id: k-aaaaaaaaaaaa"));
    await assert.rejects(() => service.rename({ dir, taskId: "k-aaaaaaaaaaaa", newSlug: "y", equivalent: true }), /MM-DD/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("应用草案持久化转移：change 实际回 open/discuss，deliver 上 clarify 回 open/check，响应与磁盘一致（任务030）", async () => {
  const dir = gitProject("pending-phase");
  const { store, service } = makeService(dir);
  try {
    const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
    const file = taskFile(dir, relativePath);
    await service.ready({ dir, taskId });
    // 模拟实施完成推进到 deliver：直接改权威文件（本测试只关注 apply 转移持久化）。
    const doc = parseTaskDocument(readFileSync(file, "utf8"));
    writeFileSync(file, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, phase: "deliver" } }));
    const diskAfterBump = parseTaskDocument(readFileSync(file, "utf8"));
    // change 草案：应用后实际回 open/discuss。
    const changeDraft = await service.update({ dir, taskId, kind: "change", reason: "新增目标", content: "## 目标与边界\n\n新目标\n", runActive: true });
    assert.equal(changeDraft.applied, "pending_saved");
    const changeApplied = await service.update({ dir, taskId, expectPending: changeDraft.pendingDraftDigest, runsSettled: true });
    assert.equal(changeApplied.phase, "discuss");
    assert.equal(changeApplied.status, "open");
    const diskChange = parseTaskDocument(readFileSync(file, "utf8"));
    assert.equal(diskChange.frontmatter.phase, "discuss", "change 应用后磁盘 phase 应为 discuss");
    assert.equal(diskChange.frontmatter.status, "open");
    assert.equal(diskChange.frontmatter.outcome, null);
    assert.equal((await store.bindings.get(taskId)).pendingDraft, null);

    // deliver 上摘要变化的 clarify：应用后实际回 open/check。
    await service.ready({ dir, taskId });
    const doc2 = parseTaskDocument(readFileSync(file, "utf8"));
    writeFileSync(file, renderTaskDocument({ ...doc2, frontmatter: { ...doc2.frontmatter, phase: "deliver" } }));
    const clarifyDraft = await service.update({ dir, taskId, kind: "clarify", reason: "约束说明", content: "## 目标与边界\n\n澄清目标\n", runActive: true });
    const clarifyApplied = await service.update({ dir, taskId, expectPending: clarifyDraft.pendingDraftDigest, runsSettled: true });
    assert.equal(clarifyApplied.phase, "check");
    const diskClarify = parseTaskDocument(readFileSync(file, "utf8"));
    assert.equal(diskClarify.frontmatter.phase, "check", "deliver 上 clarify 应用后磁盘 phase 应为 check");
    assert.equal(diskClarify.frontmatter.status, "open");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未归档 completed 可按规定重新打开：change 回 discuss、deliver 上 clarify 回 check；已归档与 cancelled/superseded 拒绝（任务036）", async () => {
  // 未归档 completed：直接更新重新打开。
  {
    const dir = gitProject("reopen-completed");
    const { store, service } = makeService(dir);
    try {
      const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
      const file = taskFile(dir, relativePath);
      await service.ready({ dir, taskId });
      // 构造未归档 completed/deliver（模拟交付完成但尚未 archive）。
      const doc = parseTaskDocument(readFileSync(file, "utf8"));
      writeFileSync(file, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, status: "closed", phase: "deliver", outcome: "completed" } }));
      // clarify：deliver 上回 open/check，清 completed。
      const clarify = await service.update({ dir, taskId, kind: "clarify", reason: "交付后补充说明", content: "## 目标与边界\n\n补充说明\n", runActive: false });
      assert.equal(clarify.applied, "direct");
      assert.equal(clarify.status, "open");
      assert.equal(clarify.phase, "check");
      assert.equal(clarify.outcome, null);
      const disk = parseTaskDocument(readFileSync(file, "utf8"));
      assert.equal(disk.frontmatter.status, "open");
      assert.equal(disk.frontmatter.outcome, null);

      // 再次回到 completed 后 change：回 open/discuss。
      const doc2 = parseTaskDocument(readFileSync(file, "utf8"));
      writeFileSync(file, renderTaskDocument({ ...doc2, frontmatter: { ...doc2.frontmatter, status: "closed", phase: "deliver", outcome: "completed" } }));
      const change = await service.update({ dir, taskId, kind: "change", reason: "新增目标", content: "## 目标与边界\n\n新目标\n", runActive: false });
      assert.equal(change.status, "open");
      assert.equal(change.phase, "discuss");
      assert.equal(change.outcome, null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // 已完整归档：拒绝输入更新。
  {
    const dir = gitProject("reopen-archived");
    const { store, service } = makeService(dir);
    try {
      const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
      const file = taskFile(dir, relativePath);
      const doc = parseTaskDocument(readFileSync(file, "utf8"));
      writeFileSync(file, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, status: "closed", phase: "deliver", outcome: "completed" } }));
      // 物理移动到 archive 目录模拟完整归档。
      const archiveDir = join(dir, ".knit", "tasks", "archive", "2026-11");
      mkdirSync(archiveDir, { recursive: true });
      renameSync(dirname(file), join(archiveDir, basename(dirname(file))));
      await assert.rejects(
        () => service.update({ dir, taskId, kind: "clarify", reason: "归档后补充", content: "## 目标与边界\n\nx\n", runActive: false }),
        (error) => error.guardReason === "outcome_completed" || error.guardReason === "task_archived" || error.code === "io_error",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // cancelled：拒绝。
  {
    const dir = gitProject("reopen-cancelled");
    const { store, service } = makeService(dir);
    try {
      const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
      const file = taskFile(dir, relativePath);
      const doc = parseTaskDocument(readFileSync(file, "utf8"));
      writeFileSync(file, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, status: "closed", phase: "implement", outcome: "cancelled" } }));
      await assert.rejects(
        () => service.update({ dir, taskId, kind: "clarify", reason: "取消后补充", content: "## 目标与边界\n\nx\n", runActive: false }),
        (error) => error.guardReason === "outcome_cancelled",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // superseded：拒绝。
  {
    const dir = gitProject("reopen-superseded");
    const { store, service } = makeService(dir);
    try {
      const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
      const file = taskFile(dir, relativePath);
      const doc = parseTaskDocument(readFileSync(file, "utf8"));
      writeFileSync(file, renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, status: "closed", phase: "implement", outcome: "superseded" } }));
      await assert.rejects(
        () => service.update({ dir, taskId, kind: "change", reason: "替代后变更", content: "## 目标与边界\n\nx\n", runActive: false }),
        (error) => error.guardReason === "outcome_superseded",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("凭据扫描：任务记录与输入更新命中即暂停、不回显完整值；无命中正常写入（任务032）", async () => {
  // 1. 任务记录：合成私钥标记写入被拒。
  {
    const dir = gitProject("scan-record");
    const { store, service } = makeService(dir);
    try {
      const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
      const file = taskFile(dir, relativePath);
      const before = readFileSync(file, "utf8");
      const synthetic = "-----BEGIN RSA PRIVATE KEY-----\n合成占位\n-----END RSA PRIVATE KEY-----\n";
      await assert.rejects(
        () => service.record({ dir, taskId, body: `包含私钥标记\n${synthetic}` }),
        (error) => error.guardReason === "credential_scan_hit",
      );
      assert.equal(readFileSync(file, "utf8"), before, "命中后无新正文写入");
      const ok = await service.record({ dir, taskId, body: "普通记录内容" });
      assert.equal(ok.saved, true);
      assert.ok(readFileSync(file, "utf8").includes("普通记录内容"));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // 2. 输入更新直接写入：token 形态被拒，且错误消息不含完整 token。
  {
    const dir = gitProject("scan-update");
    const { store, service } = makeService(dir);
    try {
      const { taskId } = await service.newTask({ dir, title: "T" });
      const fakeToken = "ghp_" + "a".repeat(36);
      const error = await service.update({ dir, taskId, kind: "clarify", reason: "补充", content: `## 目标与边界\n\n使用 ${fakeToken} 访问\n`, runActive: false }).then(() => null, (e) => e);
      assert.ok(error, "应拒绝");
      assert.equal(error.guardReason, "credential_scan_hit");
      assert.ok(!String(error.message).includes(fakeToken), "错误不回显完整敏感值");
      // 无命中正常更新与应用草案不受影响。
      const applied = await service.update({ dir, taskId, kind: "clarify", reason: "正常", content: "## 目标与边界\n\n正常内容\n", runActive: false });
      assert.equal(applied.applied, "direct");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("task close：completed 收敛事实；cancelled 撤回草案留记录；closed 不复活", async () => {
  const dir = gitProject("close");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "T" });
    // 挂一份草案再取消：关闭撤回草案并留原因
    await service.update({ dir, taskId, kind: "clarify", reason: "补充", content: "x", runActive: true, updateOperationId: "op-2" });
    const closed = await service.close({ dir, taskId, outcome: "cancelled", runsSettled: true });
    assert.equal(closed.status, "closed");
    assert.equal(closed.outcome, "cancelled");
    assert.equal(closed.pendingWithdrawn, true);
    assert.equal((await store.bindings.get(taskId)).pendingDraft, null);
    const doc = parseTaskDocument(readFileSync(taskFile(dir, (await store.bindings.get(taskId)).relativePath), "utf8"));
    assert.ok(doc.progressBody.includes("关闭撤回输入草案"));
    assert.equal(doc.frontmatter.phase, "discuss", "取消保留停止位置");
    // 关闭后的任务不接受常规更新
    await assert.rejects(
      () => service.update({ dir, taskId, kind: "clarify", reason: "r", content: "c", runActive: false }),
      (error) => error instanceof TaskGuardError && error.details.guardReason === "outcome_cancelled",
    );
    // 迟到结果不复活：close 再次拒绝
    await assert.rejects(
      () => service.close({ dir, taskId, outcome: "superseded", runsSettled: true }),
      (error) => error instanceof TaskGuardError && error.details.guardReason === "outcome_cancelled",
    );
    // completed 需收敛事实
    const t2 = await service.newTask({ dir, title: "T2" });
    await assert.rejects(
      () => service.close({ dir, taskId: t2.taskId, outcome: "completed", runsSettled: false }),
      (error) => error instanceof TaskGuardError && error.details.guardReason === "runs_unsettled",
    );
    const ok = await service.close({ dir, taskId: t2.taskId, outcome: "completed", runsSettled: true });
    assert.equal(ok.outcome, "completed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("封存：record 明确返回未保存且不写任务文件", async () => {
  const dir = gitProject("seal");
  const { store, service } = makeService(dir);
  try {
    const { taskId, relativePath } = await service.newTask({ dir, title: "T" });
    const file = taskFile(dir, relativePath);
    const before = readFileSync(file, "utf8");
    writeFileSync(join(dir, ".knit", "tasks", "11-02-01".length === 10 ? "x" : "x"), "placeholder");
    rmSync(join(dir, ".knit", "tasks", "x"), { recursive: true, force: true });
    // 封存标记
    const dirName = relativePath.split("/")[1];
    writeFileSync(join(dir, ".knit", "tasks", dirName, ".knit-sealed"), "sealing: archive op op-123");
    const result = await service.record({ dir, taskId, body: "封存期间的补记" });
    assert.equal(result.saved, false);
    assert.equal(result.sealed, true);
    assert.match(result.reason, /archive op/);
    assert.equal(readFileSync(file, "utf8"), before, "封存中不写任务、不留修改");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("锁定与多键：任务短锁允许与项目长占用并存且顺序固定", async () => {
  const dir = gitProject("locks");
  const { store, service } = makeService(dir);
  try {
    const { taskId } = await service.newTask({ dir, title: "T" });
    // 独占项目执行占用时，record（任务短锁）仍可进行——OPERATIONS：记录允许与长阶段并行
    const locks = new LockManager({ root: join(dir, ".lock-root") });
    const projectLock = await locks.acquire({ keys: [{ scope: "project", rawKey: dir }], action: "phase.implement" });
    const result = await service.record({ dir, taskId, body: "长阶段期间的合法记录" });
    assert.equal(result.saved, true);
    // 项目锁被占时竞争者不能取得（记录短锁不影响项目锁互斥）
    await assert.rejects(() => locks.acquire({ keys: [{ scope: "project", rawKey: dir }], action: "other" }), (error) => error.code === "lock_busy");
    locks.release(projectLock);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("任务锁按稳定 ID 定位：移动后 record 用新路径仍定位同一任务", async () => {
  const dir = gitProject("identity");
  const { store, service } = makeService(dir, { now: fixedDate });
  try {
    const { taskId } = await service.newTask({ dir, title: "T", slug: "origin" });
    await service.rename({ dir, taskId, newSlug: "moved", equivalent: true });
    const result = await service.record({ dir, taskId, body: "移动后仍可记录" });
    assert.equal(result.saved, true);
    const list = service.list({ dir });
    assert.equal(list.active[0].relativePath, "tasks/11-02-moved");
    assert.ok(list.active[0].title === "T");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：task new/list/record 真实进程冒烟", async () => {
  const dir = gitProject("cli");
  try {
    execFileSync(process.execPath, [CLI, "task", "new", "--title", "CLI 任务", "--slug", "cli", "--dir", dir], { env: { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") } });
    const list = execFileSync(process.execPath, [CLI, "task", "list", "--dir", dir], { encoding: "utf8", env: { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") } });
    assert.match(list, /活跃任务（1）/);
    assert.match(list, /tasks\/11-\d{2}-cli/);
    const json = execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8", env: { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") } });
    const response = JSON.parse(json);
    assert.equal(response.protocolVersion, 1);
    assert.equal(response.outcome, "completed");
    assert.equal(response.data.active.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：task update/close 错误路径输出协议错误", async () => {
  const dir = gitProject("cli-err");
  try {
    // 未知 --kind 走协议错误（exit 1 属预期）
    let badKind;
    try {
      execFileSync(process.execPath, [CLI, "--json", "task", "update", "k-000000000000", "--kind", "research", "--dir", dir], { encoding: "utf8" });
      assert.fail("未知 --kind 应失败");
    } catch (error) {
      badKind = error.stdout;
    }
    assert.equal(JSON.parse(badKind).outcome, "error");
    // 不存在的任务：io_error → blocked，协议 JSON 仍以 exit 1 表示失败
    let missing;
    try {
      execFileSync(process.execPath, [CLI, "--json", "task", "record", "k-000000000000", "--dir", dir], { encoding: "utf8" });
      assert.fail("不存在的任务应失败");
    } catch (error) {
      assert.equal(error.status, 1);
      missing = error.stdout;
    }
    const response = JSON.parse(missing);
    assert.equal(response.outcome, "blocked");
    assert.equal(response.reasonCode, "io_error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("newTaskId 与随机源：k- 前缀稳定身份", () => {
  assert.equal(newTaskId(() => "0123456789ab"), "k-0123456789ab");
});
