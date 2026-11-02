/**
 * 010 Session 索引、选择与上下文计划测试。
 * 全部使用真实临时 Git 仓库、真实 SQLite 元数据库与真实 Pi 格式 JSONL 文件；
 * 不调用模型、不写产品 .knit（夹具内独立项目除外）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { SessionService, SELECTION_ENTRY_TYPE } from "../dist/application/session-service.js";
import { ContextPlanner } from "../dist/application/context-planner.js";
import { TaskService } from "../dist/application/task-service.js";
import { inputsDigestOf } from "../dist/contracts/task-inputs.js";
import { candidateDigestOf, renderCandidate } from "../dist/contracts/standards.js";
import { sha256Text } from "../dist/infrastructure/fingerprint.js";
import { piSessionDir } from "../dist/adapters/pi/native-file.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");

function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-010-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function installTemplates(dir) {
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
}

let counter = 0;
function hexSource() {
  return () => {
    counter += 1;
    return counter.toString(16).padStart(12, "0").slice(-12);
  };
}

const FIXED_NOW = () => new Date("2026-11-02T03:04:05.000Z");

function makeServices(dir, options = {}) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const agentDir = options.agentDir ?? join(dir, ".agent");
  const randomHex = options.randomHex ?? hexSource();
  const now = options.now ?? FIXED_NOW;
  return {
    store,
    agentDir,
    session: new SessionService({ store, agentDir, randomHex, now }),
    planner: new ContextPlanner({ store, randomHex, now }),
    tasks: new TaskService({ store, randomHex, now }),
  };
}

/** 写真实 Pi 格式会话文件：首行 session 头 + 条目（id/parentId/type）。 */
function writeNativeSession(agentDir, cwd, nativeId, entries, stamp = "2026-11-02T00-00-00-000Z") {
  const dir = piSessionDir(cwd, agentDir);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: nativeId, cwd, timestamp: "2026-11-02T00:00:00.000Z" }),
    ...entries.map((entry) => JSON.stringify({ timestamp: "2026-11-02T00:00:01.000Z", ...entry })),
  ];
  const file = join(dir, `${stamp}_${nativeId}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function appendEntry(file, entry) {
  writeFileSync(file, JSON.stringify({ timestamp: "2026-11-02T00:00:02.000Z", ...entry }) + "\n", { flag: "a" });
}

function selectionEntry(id, parentId, data) {
  return { type: "custom", customType: SELECTION_ENTRY_TYPE, id, parentId, data };
}

test("session attach：预分配原生 ID，opening→available 与稳定记录位置", async () => {
  const dir = gitProject("attach");
  const { store, session, agentDir } = makeServices(dir);
  try {
    const first = await session.attach({ dir, kind: "main", role: "implement" });
    assert.equal(first.created, true);
    assert.match(first.record.knitSessionId, /^s-[0-9a-f]{12}$/);
    assert.equal(first.record.status, "opening");
    assert.equal(first.record.reason, "native_file_not_persisted");
    assert.equal(first.record.sessionFile, null);
    assert.equal(first.record.nativeReadable, false);
    assert.equal(first.record.cwd, dir);

    const nativeId = first.record.ref.nativeSessionId;
    const file = writeNativeSession(agentDir, dir, nativeId, [
      { type: "message", id: "e1", parentId: null },
    ]);
    const second = await session.attach({ dir, nativeSessionId: nativeId, kind: "main", role: "implement" });
    assert.equal(second.created, false, "同一原生身份与角色复用稳定 Knit Session ID");
    assert.equal(second.record.knitSessionId, first.record.knitSessionId);
    assert.equal(second.record.status, "available");
    assert.equal(second.record.sessionFile, file);
    assert.equal(second.record.nativeReadable, true);
    assert.notEqual(second.record.lastVerifiedAt, null);

    const verified = await session.verify(first.record.knitSessionId);
    assert.equal(verified.status, "available");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session attach：身份不符 incompatible，项目与角色不混淆，主会话不被 worker 复用", async () => {
  const dir = gitProject("identity");
  const other = gitProject("identity-other");
  const { store, session, agentDir } = makeServices(dir);
  try {
    // 文件存在但会话头 id 不符：不交另一记录解释。
    const mismatchFile = writeNativeSession(agentDir, dir, "actual-id", [{ type: "message", id: "e1", parentId: null }]);
    const mismatched = await session.attach({
      dir,
      nativeSessionId: "expected-id",
      kind: "main",
      role: "implement",
      sessionFile: mismatchFile,
    });
    assert.equal(mismatched.record.status, "incompatible");
    assert.equal(mismatched.record.reason, "native_id_mismatch");
    assert.equal(mismatched.problem, "id_mismatch");

    // 同一原生 ID 在另一项目复用：拒绝，索引保留原项目。
    await assert.rejects(
      () => session.attach({ dir: other, nativeSessionId: "expected-id", kind: "main", role: "implement" }),
      (error) => error.guardReason === "project_conflict",
    );

    // 角色不同是不同索引对象（不互相覆盖），但共享原生文件。
    const asCheck = await session.attach({ dir, nativeSessionId: "expected-id", kind: "main", role: "check" });
    assert.notEqual(asCheck.record.knitSessionId, mismatched.record.knitSessionId);
    assert.equal(asCheck.record.ref.role, "check");

    // 活跃主会话不得被 worker 复用。
    const mainFile = writeNativeSession(agentDir, dir, "main-live", [{ type: "message", id: "m1", parentId: null }]);
    const main = await session.attach({ dir, nativeSessionId: "main-live", kind: "main", role: "implement" });
    assert.equal(main.record.status, "available");
    assert.ok(existsSync(mainFile));
    await assert.rejects(
      () =>
        session.attach({
          dir,
          nativeSessionId: "main-live",
          kind: "sub",
          role: "implement",
          parentKnitSessionId: main.record.knitSessionId,
        }),
      (error) => error.guardReason === "main_session_reuse",
    );
    // 子会话必须登记父会话。
    await assert.rejects(
      () => session.attach({ dir, nativeSessionId: "sub-1", kind: "sub", role: "implement" }),
      (error) => error.guardReason === "parent_required",
    );
    // 独立原生文件的子会话可登记，父关系与来源如实保存。
    const subFile = writeNativeSession(agentDir, dir, "sub-1", [{ type: "message", id: "s1", parentId: null }]);
    const sub = await session.attach({
      dir,
      nativeSessionId: "sub-1",
      kind: "sub",
      role: "implement",
      parentKnitSessionId: main.record.knitSessionId,
      sessionFile: subFile,
      source: { kind: "resume_fallback", fromSessionId: main.record.knitSessionId, reason: "old_record_missing" },
    });
    assert.equal(sub.record.kind, "sub");
    assert.equal(sub.record.parentSessionId, main.record.knitSessionId);
    assert.equal(sub.record.source.kind, "resume_fallback");
    assert.equal(sub.record.selection, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("task use/clear：未落盘只待确认，原生有效路径为权威，清除不复活旧选择", async () => {
  const dir = gitProject("selection");
  installTemplates(dir);
  const { store, session, tasks, agentDir } = makeServices(dir);
  try {
    const t1 = await tasks.newTask({ dir, title: "任务一", slug: "one" });
    const t2 = await tasks.newTask({ dir, title: "任务二", slug: "two" });

    const file = writeNativeSession(agentDir, dir, "main-sel", [
      { type: "message", id: "e1", parentId: null },
      selectionEntry("e2", "e1", { taskId: t1.taskId, branch: "refs/heads/main", operationId: "sel-native-1" }),
      { type: "message", id: "e3", parentId: "e2" },
    ]);
    const attached = await session.attach({ dir, nativeSessionId: "main-sel", kind: "main", role: "implement" });
    const knitId = attached.record.knitSessionId;

    // 未落盘：只记待确认，不宣称已保存选择。
    const pending = await session.useTask({ dir, knitSessionId: knitId, taskId: t2.taskId, persisted: false });
    assert.equal(pending.effectiveTaskId, null);
    assert.equal(pending.selection.persisted, false);
    assert.equal(pending.selection.pendingReason, "native_entry_not_persisted");

    // 原生有效路径上的最后事件为准：仍是 t1，快照与原生不一致如实报告。
    const resolved = await session.resolveSelection(dir, knitId);
    assert.equal(resolved.source, "native");
    assert.equal(resolved.taskId, t1.taskId);
    assert.equal(resolved.effective, true);
    assert.equal(resolved.entryRef, "e2");
    assert.equal(resolved.snapshotMatches, false);

    // 未落盘的清除不生效：不能宣称已清除。
    await session.clearTask({ dir, knitSessionId: knitId, persisted: false });
    assert.equal((await session.resolveSelection(dir, knitId)).taskId, t1.taskId);

    // 已落盘的清除事件生效，且更早选择不复活。
    appendEntry(file, selectionEntry("e4", "e3", { taskId: null, branch: "refs/heads/main", operationId: "sel-clear" }));
    const cleared = await session.resolveSelection(dir, knitId);
    assert.equal(cleared.taskId, null);
    assert.equal(cleared.effective, false);
    assert.equal(cleared.entryRef, "e4");

    // 后续选择 t2 生效。
    appendEntry(file, selectionEntry("e5", "e4", { taskId: t2.taskId, branch: "refs/heads/main", operationId: "sel-native-2" }));
    assert.equal((await session.resolveSelection(dir, knitId)).taskId, t2.taskId);

    // 切树：新叶挂在 e2 下，e4/e5 不在有效路径上，不能复活旧分支选择。
    appendEntry(file, { type: "message", id: "e6", parentId: "e2" });
    const switched = await session.resolveSelection(dir, knitId);
    assert.equal(switched.source, "native");
    assert.equal(switched.entryRef, "e2", "有效路径上最后一个选择事件是 e2");
    assert.equal(switched.taskId, t1.taskId);

    // 有效路径上没有任何选择事件：返回未生效并说明原因，不回退索引快照。
    const file2 = writeNativeSession(agentDir, dir, "main-branch", [
      { type: "message", id: "f1", parentId: null },
      selectionEntry("f2", "f1", { taskId: t1.taskId, branch: null, operationId: "sel-old" }),
      { type: "message", id: "f3", parentId: "f2" },
    ]);
    const attached2 = await session.attach({ dir, nativeSessionId: "main-branch", kind: "main", role: "implement" });
    const knitId2 = attached2.record.knitSessionId;
    assert.equal((await session.resolveSelection(dir, knitId2)).entryRef, "f2");
    appendEntry(file2, { type: "message", id: "f4", parentId: "f1" });
    const noSelection = await session.resolveSelection(dir, knitId2);
    assert.equal(noSelection.taskId, null);
    assert.equal(noSelection.effective, false);
    assert.equal(noSelection.reason, "selection_entry_not_on_active_path");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("选择分支与当前分支不一致：不生效，不把旧树选择投到新分支", async () => {
  const dir = gitProject("selection-branch");
  installTemplates(dir);
  const { store, session, tasks, agentDir } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "分支选择", slug: "branch-sel" });
    writeNativeSession(agentDir, dir, "main-other-branch", [
      { type: "message", id: "b1", parentId: null },
      selectionEntry("b2", "b1", { taskId: task.taskId, branch: "refs/heads/other", operationId: "sel-other" }),
    ]);
    const attached = await session.attach({ dir, nativeSessionId: "main-other-branch", kind: "main", role: "implement" });
    const resolved = await session.resolveSelection(dir, attached.record.knitSessionId);
    assert.equal(resolved.taskId, null);
    assert.equal(resolved.effective, false);
    assert.equal(resolved.reason, "branch_changed");
    assert.equal(resolved.entryRef, "b2");
    await assert.rejects(
      () => session.useTask({
        dir,
        knitSessionId: attached.record.knitSessionId,
        taskId: task.taskId,
        branch: "refs/heads/other",
        persisted: true,
        entryRef: "b2",
      }),
      (error) => error.guardReason === "branch_mismatch",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("临时 cwd 与项目迁移不误选：cwd 不一致返回未生效", async () => {
  const dir = gitProject("cwd");
  const elsewhere = gitProject("cwd-other");
  const { store, session, tasks, agentDir } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "T", slug: "t" });
    const file = writeNativeSession(agentDir, dir, "main-cwd", [
      { type: "message", id: "e1", parentId: null },
      selectionEntry("e2", "e1", { taskId: task.taskId, branch: null, operationId: "sel-1" }),
    ]);
    const attached = await session.attach({ dir, nativeSessionId: "main-cwd", kind: "main", role: "implement" });
    assert.equal((await session.resolveSelection(dir, attached.record.knitSessionId)).taskId, task.taskId);
    const other = await session.resolveSelection(elsewhere, attached.record.knitSessionId);
    assert.equal(other.taskId, null);
    assert.equal(other.effective, false);
    assert.equal(other.reason, "cwd_mismatch");
    assert.ok(existsSync(file));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("context：分层输入、规范／角色指纹、草案与候选只作背景", async () => {
  const dir = gitProject("context");
  installTemplates(dir);
  const { store, planner, tasks } = makeServices(dir);
  try {
    const task = await tasks.newTask({ dir, title: "上下文", slug: "ctx" });
    const taskFile = join(dir, ".knit", task.relativePath);
    const before = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(before.ready, true);
    assert.equal(before.inputsDigest, inputsDigestOf(readFileSync(taskFile, "utf8")));
    const kinds = before.sections.map((section) => section.kind);
    for (const kind of ["task-inputs", "workflow", "role", "standard", "progress"]) {
      assert.ok(kinds.includes(kind), `缺少 ${kind} 分层`);
    }
    const roleSection = before.sections.find((section) => section.kind === "role");
    assert.equal(roleSection.path, ".knit/agents/implement.md");
    assert.equal(roleSection.digest, sha256Text(readFileSync(join(dir, ".knit", "agents", "implement.md"), "utf8")));
    assert.equal(roleSection.mode, "system");
    const progress = before.sections.find((section) => section.kind === "progress");
    assert.equal(progress.background, true);
    assert.equal(progress.countsTowardInputs, false);
    assert.equal(before.toolPolicy.mode, "write");
    const checkPlan = await planner.plan({ dir, taskId: task.taskId, role: "check" });
    assert.equal(checkPlan.toolPolicy.mode, "read");
    assert.equal(checkPlan.sections.find((section) => section.kind === "role").path, ".knit/agents/check.md");

    // 任务候选规范只作背景，不改变需求摘要（DESIGN.md 第8.2节：任务辅助资料 standards.md）。
    const candidateBase = {
      candidateId: "c-0123456789ab",
      title: "候选规则",
      problem: "问题",
      evidence: "",
      scope: "",
      rule: "建议规则",
      verification: "",
    };
    writeFileSync(
      join(dir, ".knit", "tasks", task.relativePath.split("/")[1], "standards.md"),
      `# 规范候选\n\n${renderCandidate({ ...candidateBase, digest: candidateDigestOf(candidateBase) })}\n`,
    );
    const withCandidate = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    const candidate = withCandidate.sections.find((section) => section.kind === "standard-candidate");
    assert.equal(candidate.background, true);
    assert.equal(candidate.countsTowardInputs, false);
    assert.equal(withCandidate.inputsDigest, before.inputsDigest);
    assert.ok(withCandidate.excluded.some((item) => item.reason === "candidate_not_applied"));

    // 活动运行中的输入草案只作背景。
    await tasks.update({
      dir,
      taskId: task.taskId,
      kind: "change",
      reason: "运行中调整",
      content: "## 目标与边界\n\n新内容\n",
      runActive: true,
      updateOperationId: "op-draft-1",
    });
    const withDraft = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    const draft = withDraft.sections.find((section) => section.kind === "pending-draft");
    assert.equal(draft.background, true);
    assert.equal(draft.countsTowardInputs, false);
    assert.equal(withDraft.inputsDigest, before.inputsDigest);
    assert.ok(withDraft.excluded.some((item) => item.reason === "pending_draft_not_applied"));

    // 纯记录不改变需求摘要。
    await tasks.record({ dir, taskId: task.taskId, body: "记录：仅进度\n" });
    const afterRecord = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(afterRecord.inputsDigest, before.inputsDigest);

    // 角色文件缺失：必需角色不就绪，计划不标 ready。
    rmSync(join(dir, ".knit", "agents", "implement.md"));
    const missingRole = await planner.plan({ dir, taskId: task.taskId, role: "implement" });
    assert.equal(missingRole.ready, false);
    assert.ok(missingRole.blockers.includes("role_file_missing:implement"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history：只读摘要，不复制正文、不修改原生文件", async () => {
  const dir = gitProject("history");
  const { store, session, agentDir } = makeServices(dir);
  try {
    const file = writeNativeSession(agentDir, dir, "main-hist", [
      { type: "message", id: "e1", parentId: null, content: "机密正文" },
      { type: "message", id: "e2", parentId: "e1", content: "更多正文" },
      { type: "custom", customType: "other", id: "e3", parentId: "e2" },
    ]);
    const attached = await session.attach({ dir, nativeSessionId: "main-hist", kind: "main", role: "implement" });
    const before = readFileSync(file).toString("hex");
    const history = await session.history(attached.record.knitSessionId, 2);
    assert.equal(history.problem, null);
    assert.equal(history.entries.length, 2);
    assert.deepEqual(history.entries.map((entry) => entry.id), ["e2", "e3"]);
    assert.equal(JSON.stringify(history).includes("机密正文"), false, "历史摘要不得复制聊天正文");
    assert.equal(readFileSync(file).toString("hex"), before, "只读历史不得修改原生文件");

    const badFile = join(agentDir, "bad.jsonl");
    writeFileSync(badFile, '{"type":"message","id":"x"}\n');
    const bad = await session.attach({ dir, nativeSessionId: "bad", kind: "main", role: "implement", sessionFile: badFile });
    assert.equal(bad.record.status, "incompatible");
    const badHistory = await session.history(bad.record.knitSessionId);
    assert.equal(badHistory.problem, "no_session_header");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：session attach 与 context --json 走协议输出", async () => {
  const dir = gitProject("cli");
  installTemplates(dir);
  const agentDir = join(dir, ".agent");
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  try {
    const tasks = new TaskService({ store, now: FIXED_NOW });
    const task = await tasks.newTask({ dir, title: "CLI 任务", slug: "cli" });
    const attachRaw = execFileSync(
      process.execPath,
      [CLI, "--json", "session", "attach", "--native", "cli-native", "--kind", "main", "--role", "implement", "--agent-dir", agentDir, "--dir", dir],
      { encoding: "utf8" },
    );
    const attached = JSON.parse(attachRaw);
    assert.equal(attached.outcome, "completed");
    assert.equal(attached.data.record.status, "opening");
    const knitId = attached.data.record.knitSessionId;

    const listRaw = execFileSync(process.execPath, [CLI, "--json", "session", "list", "--dir", dir], { encoding: "utf8" });
    const listed = JSON.parse(listRaw);
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].knitSessionId, knitId);

    const contextRaw = execFileSync(
      process.execPath,
      [CLI, "--json", "context", "--task", task.taskId, "--role", "implement", "--dir", dir],
      { encoding: "utf8" },
    );
    const plan = JSON.parse(contextRaw);
    assert.equal(plan.outcome, "completed");
    assert.equal(plan.data.ready, true);
    assert.equal(plan.data.taskId, task.taskId);

    // 未知任务：协议错误而非崩溃。
    let useRaw;
    try {
      execFileSync(
        process.execPath,
        [CLI, "--json", "task", "use", "k-000000000000", "--session", knitId, "--dir", dir],
        { encoding: "utf8" },
      );
      assert.fail("未知任务应失败");
    } catch (error) {
      useRaw = error.stdout;
    }
    const used = JSON.parse(useRaw);
    assert.equal(used.outcome, "error");
    assert.equal(used.reasonCode, "invalid_request");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
