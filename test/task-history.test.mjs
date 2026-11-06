import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { TaskService, renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";
import { LockManager } from "../dist/infrastructure/locks.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

/** 真实 Git 仓库夹具：每个测试独立临时目录。 */
function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-history-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeService(dir) {
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const service = new TaskService({ store, locks: new LockManager({ root: join(dir, ".lock-root") }) });
  return { store, service };
}

function archiveMarkdown(overrides = {}) {
  const frontmatter = {
    id: "k-aaaaaaaaaaaa",
    status: "closed",
    stage: "deliver",
    outcome: "completed",
    branch: "refs/heads/main",
    createdAt: "2026-10-01T00:00:00.000Z",
    title: "跨机旧任务",
    ...overrides,
  };
  return renderTaskDocument({
    frontmatter,
    ...renderInitialTaskBody(frontmatter.title),
    trailingBody: "",
  });
}

function writeArchive(dir, month, name, markdown) {
  const archiveDir = join(dir, ".knit", "tasks", "archive", month, name);
  mkdirSync(archiveDir, { recursive: true });
  const file = join(archiveDir, "task.md");
  writeFileSync(file, markdown);
  return file;
}

function commitAll(dir, message) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

/** 目录树快照：记录文件内容摘要与元数据，不记录读取会变化的 atime。 */
function treeSnapshot(root) {
  const entries = [];
  const walk = (current) => {
    const names = readdirSync(current, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const full = join(current, name);
      const rel = relative(root, full).split(sep).join("/");
      const dirent = readdirSync(current, { withFileTypes: true }).find((entry) => entry.name === name);
      if (dirent?.isDirectory()) {
        entries.push({ path: rel, type: "dir" });
        walk(full);
      } else if (dirent?.isSymbolicLink()) {
        entries.push({ path: rel, type: "link", target: readlinkSync(full) });
      } else {
        const stats = statSync(full);
        entries.push({
          path: rel,
          type: "file",
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        });
      }
    }
  };
  walk(root);
  return entries;
}

function completionPath(dir, taskId) {
  return join(dir, ".knit", ".runtime", "completions", `${taskId}.json`);
}

test("跨机历史：清空本机 runtime／metadata 后，已入库有效档案显示 git-history", async () => {
  const dir = gitProject("clone");
  try {
    writeArchive(dir, "2026-10", "10-01-old", archiveMarkdown());
    commitAll(dir, "archive old task");
    rmSync(join(dir, ".knit", ".runtime"), { recursive: true, force: true });
    assert.equal(existsSync(join(dir, ".knit", ".runtime", "metadata.db")), false);

    const { store, service } = makeService(dir);
    try {
      const list = service.list({ dir });
      assert.equal(list.active.length, 0);
      assert.equal(list.archived.length, 1);
      assert.equal(list.archived[0].taskId, "k-aaaaaaaaaaaa");
      assert.equal(list.archived[0].history.kind, "git-history");
      assert.deepEqual(list.archived[0].history.problems, []);
      assert.deepEqual(list.problems, []);
      assert.deepEqual(await store.bindings.list(), [], "只读展示不创建绑定");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未跟踪的有效归档显示 local-only，不冒充已入库", () => {
  const dir = gitProject("untracked");
  try {
    writeArchive(dir, "2026-10", "10-01-local", archiveMarkdown({ id: "k-bbbbbbbbbbbb" }));
    const { store, service } = makeService(dir);
    try {
      const list = service.list({ dir });
      assert.equal(list.archived.length, 1);
      assert.equal(list.archived[0].history.kind, "local-only");
      assert.deepEqual(list.archived[0].history.problems, []);
      assert.deepEqual(list.problems, []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档结束字段无效（status=open）显示 invalid 并附问题明细", () => {
  const dir = gitProject("invalid");
  try {
    writeArchive(dir, "2026-10", "10-01-open", archiveMarkdown({
      id: "k-cccccccccccc",
      status: "open",
      stage: "start",
      outcome: null,
    }));
    writeArchive(dir, "2026-10", "10-02-no-branch", archiveMarkdown({
      id: "k-999999999999",
      branch: null,
    }));
    commitAll(dir, "track invalid archives");
    const { store, service } = makeService(dir);
    try {
      const list = service.list({ dir });
      assert.equal(list.archived.length, 2);
      const open = list.archived.find((entry) => entry.taskId === "k-cccccccccccc");
      assert.equal(open.history.kind, "invalid");
      assert.ok(open.history.problems.some((problem) => problem.includes("status=open")));
      assert.ok(open.history.problems.some((problem) => problem.includes("outcome=null")), "无效 outcome 仍报结束字段问题");
      assert.ok(!open.history.problems.some((problem) => problem.includes("stage=start")), "无效 outcome 下不把停止位置误报为交付位置");
      const noBranch = list.archived.find((entry) => entry.taskId === "k-999999999999");
      assert.equal(noBranch.history.kind, "invalid");
      assert.ok(noBranch.history.problems.some((problem) => problem.includes("branch")));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档结束位置：completed 要求 deliver，cancelled／superseded 接受非空停止位置", () => {
  const dir = gitProject("end-stage");
  try {
    writeArchive(dir, "2026-10", "10-01-cancelled", archiveMarkdown({
      id: "k-121212121212",
      outcome: "cancelled",
      stage: "check",
    }));
    writeArchive(dir, "2026-10", "10-02-superseded", archiveMarkdown({
      id: "k-131313131313",
      outcome: "superseded",
      stage: "start",
    }));
    writeArchive(dir, "2026-10", "10-03-completed-early", archiveMarkdown({
      id: "k-141414141414",
      outcome: "completed",
      stage: "check",
    }));
    const { store, service } = makeService(dir);
    try {
      const list = service.list({ dir });
      const cancelled = list.archived.find((entry) => entry.taskId === "k-121212121212");
      assert.equal(cancelled.history.kind, "local-only", "取消保留停止位置仍是有效档案");
      assert.deepEqual(cancelled.history.problems, []);
      const superseded = list.archived.find((entry) => entry.taskId === "k-131313131313");
      assert.equal(superseded.history.kind, "local-only");
      assert.deepEqual(superseded.history.problems, []);
      const early = list.archived.find((entry) => entry.taskId === "k-141414141414");
      assert.equal(early.history.kind, "invalid", "completed 未到 deliver 仍为异常档案");
      assert.ok(early.history.problems.some((problem) => problem.includes("completed 应为 deliver")));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏归档只记 problems 不中断 list；活动区解析失败仍严格抛错", () => {
  const dir = gitProject("broken");
  try {
    writeArchive(dir, "2026-10", "10-01-good", archiveMarkdown({ id: "k-dddddddddddd" }));
    writeArchive(dir, "2026-10", "10-02-broken", "broken-not-yaml\n");
    const { store, service } = makeService(dir);
    try {
      const list = service.list({ dir });
      assert.equal(list.archived.length, 1, "损坏归档不进入条目，但其余条目仍返回");
      assert.equal(list.archived[0].taskId, "k-dddddddddddd");
      assert.equal(list.problems.length, 1);
      assert.match(list.problems[0].path, /tasks\/archive\/2026-10\/10-02-broken\/task\.md$/);
      assert.match(list.problems[0].message, /frontmatter/);

      // 活动区是业务权威：同样的结构错误必须暴露，不能静默跳过。
      const activeDir = join(dir, ".knit", "tasks", "10-03-broken-active");
      mkdirSync(activeDir, { recursive: true });
      writeFileSync(join(activeDir, "task.md"), "broken-not-yaml\n");
      assert.throws(() => service.list({ dir }), /frontmatter/);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活动区与多个归档同 ID：记录重复来源诊断，操作定位仍活动区优先", async () => {
  const dir = gitProject("duplicate");
  const { store, service } = makeService(dir);
  try {
    const active = await service.newTask({ dir, title: "活动任务", slug: "active" });
    const archiveOne = writeArchive(dir, "2026-11", "11-01-copy", archiveMarkdown({
      id: active.taskId,
      title: "归档副本一",
    }));
    const archiveTwo = writeArchive(dir, "2026-11", "11-02-copy", archiveMarkdown({
      id: active.taskId,
      title: "归档副本二",
    }));

    const list = service.list({ dir });
    assert.ok(list.active.some((entry) => entry.taskId === active.taskId));
    assert.equal(list.archived.length, 2);
    const duplicates = list.problems.filter((problem) => problem.message.includes("重复来源"));
    assert.equal(duplicates.length, 2, "两个归档位置各记一次重复来源");
    assert.ok(duplicates.every((problem) => problem.message.includes(active.taskId)));
    assert.ok(duplicates.some((problem) => problem.message.includes("11-01-copy")));

    // 操作定位沿用活动区优先：record 写活动区，不碰归档副本。
    const result = await service.record({ dir, taskId: active.taskId, body: "活动区优先定位" });
    assert.equal(result.saved, true);
    assert.match(readFileSync(join(dir, ".knit", active.relativePath), "utf8"), /活动区优先定位/);
    assert.doesNotMatch(readFileSync(archiveOne, "utf8"), /活动区优先定位/);
    assert.doesNotMatch(readFileSync(archiveTwo, "utf8"), /活动区优先定位/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list 只读：调用前后文件系统与 Git 状态零变化", () => {
  const dir = gitProject("readonly");
  const { store, service } = makeService(dir);
  try {
    writeArchive(dir, "2026-10", "10-01-tracked", archiveMarkdown({ id: "k-eeeeeeeeeeee" }));
    commitAll(dir, "track archive");
    writeArchive(dir, "2026-10", "10-02-untracked", archiveMarkdown({ id: "k-ffffffffffff" }));

    // Git 事实与目录快照分开采集：status 可能刷新 index mtime，不能夹在 list 与快照之间。
    const gitFacts = () => ({
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
      tracked: execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8" }),
      status: execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: dir, encoding: "utf8" }),
    });
    const gitBefore = gitFacts();
    const before = treeSnapshot(dir);
    const list = service.list({ dir });
    const after = treeSnapshot(dir);
    const gitAfter = gitFacts();

    assert.equal(list.archived.find((entry) => entry.taskId === "k-eeeeeeeeeeee").history.kind, "git-history");
    assert.equal(list.archived.find((entry) => entry.taskId === "k-ffffffffffff").history.kind, "local-only");
    assert.deepEqual(after, before, "list 前后工作区、.git 与 runtime 文件均无变化");
    assert.deepEqual(gitAfter, gitBefore, "list 前后 HEAD、跟踪清单与 Git 状态不变");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-history 归档不改变绑定／完成资格，且不可 adopt／close", async () => {
  const dir = gitProject("qualification");
  try {
    writeArchive(dir, "2026-10", "10-01-history", archiveMarkdown({ id: "k-111111111111" }));
    commitAll(dir, "track archive");
    rmSync(join(dir, ".knit", ".runtime"), { recursive: true, force: true });
    const { store, service } = makeService(dir);
    try {
      const list = service.list({ dir });
      assert.equal(list.archived[0].history.kind, "git-history");
      assert.deepEqual(await store.bindings.list(), []);
      assert.equal(existsSync(completionPath(dir, "k-111111111111")), false);
      assert.equal(existsSync(join(dir, ".knit", ".runtime", "checks")), false);

      await assert.rejects(
        () => service.adopt({ dir, taskId: "k-111111111111", branch: "current" }),
        (error) => error.guardReason === "task_archived",
      );
      await assert.rejects(
        () => service.close({ dir, taskId: "k-111111111111", outcome: "completed", runsSettled: true }),
        (error) => error.guardReason === "binding_missing" || error.guardReason === "task_archived",
      );
      assert.deepEqual(await store.bindings.list(), [], "拒绝路径不补建绑定");
      assert.equal(existsSync(completionPath(dir, "k-111111111111")), false);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git 查询失败：按未验证处理并附「Git 跟踪状态不可判定」，不冒充已入库", () => {
  const dir = mkdtempSync(join(tmpdir(), "knit-history-nogit-"));
  try {
    mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
    writeArchive(dir, "2026-10", "10-01-nogit", archiveMarkdown({ id: "k-222222222222" }));
    const { store, service } = makeService(dir);
    try {
      const list = service.list({ dir });
      assert.equal(list.archived.length, 1);
      assert.equal(list.archived[0].history.kind, "local-only");
      assert.ok(list.archived[0].history.problems.some((problem) => problem.includes("Git 跟踪状态不可判定")));
      assert.ok(list.problems.some((problem) => problem.message.includes("Git 跟踪状态不可判定")));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：文本归档条目带历史标注，JSON 输出含 history 与 problems", () => {
  const dir = gitProject("cli");
  const env = { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") };
  try {
    writeArchive(dir, "2026-10", "10-01-cli", archiveMarkdown({ id: "k-333333333333" }));
    commitAll(dir, "track archive");
    const text = execFileSync(process.execPath, [CLI, "task", "list", "--archive", "--dir", dir], { cwd: dir, encoding: "utf8", env });
    assert.match(text, /归档 2026-10（1）/);
    assert.match(text, /跨机历史 1 条/);

    const json = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--archive", "--dir", dir], { cwd: dir, encoding: "utf8", env }));
    assert.equal(json.outcome, "completed");
    assert.equal(json.data.scope, "archive");
    assert.equal(json.data.archived[0].history.kind, "git-history");
    assert.deepEqual(json.data.archived[0].history.problems, []);
    assert.deepEqual(json.data.problems, []);

    writeArchive(dir, "2026-10", "10-02-broken", "broken-not-yaml\n");
    const withProblem = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--archive", "--dir", dir], { cwd: dir, encoding: "utf8", env }));
    assert.equal(withProblem.data.archived.length, 1);
    assert.equal(withProblem.data.problems.length, 1);
    assert.match(withProblem.data.problems[0].path, /10-02-broken\/task\.md$/);
    const textWithProblem = execFileSync(process.execPath, [CLI, "task", "list", "--archive", "--dir", dir], { cwd: dir, encoding: "utf8", env });
    assert.match(textWithProblem, /档案异常 1 条/);
    assert.match(textWithProblem, /10-02-broken/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：task list --archive 按月分组，--month 过滤且隐含归档视图", () => {
  const dir = gitProject("archive-months");
  const env = { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") };
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args, "--dir", dir], { cwd: dir, encoding: "utf8", env });
  try {
    writeArchive(dir, "2026-10", "10-01-older", archiveMarkdown({ id: "k-111111111111", title: "十月任务", createdAt: "2026-10-01T00:00:00.000Z" }));
    writeArchive(dir, "2026-11", "11-02-newer", archiveMarkdown({ id: "k-222222222222", title: "十一月任务", outcome: "cancelled", createdAt: "2026-11-02T00:00:00.000Z" }));

    const summary = run("task", "list");
    assert.match(summary, /归档 2（knit task list --archive）/);

    const all = run("task", "list", "--archive");
    assert.match(all, /归档 2026-11（1）/);
    assert.match(all, /归档 2026-10（1）/);
    assert.ok(all.indexOf("2026-11") < all.indexOf("2026-10"), "月份倒序");
    assert.match(all, /  日期 +ID +结论 +标题/);
    assert.match(all, /11-02 +k-222222222222 +cancelled +十一月任务/);
    assert.match(all, /10-01 +k-111111111111 +completed +十月任务/);

    const month = run("task", "list", "--month", "2026-10");
    assert.match(month, /归档 2026-10（1）/);
    assert.doesNotMatch(month, /2026-11/);
    assert.doesNotMatch(month, /十一月任务/);

    const json = JSON.parse(run("--json", "task", "list", "--archive", "--month", "2026-11"));
    assert.equal(json.data.scope, "archive");
    assert.equal(json.data.month, "2026-11");
    assert.equal(json.data.archived.length, 1);
    assert.equal(json.data.archivedCount, 2);

    assert.match(run("task", "list", "--month", "2026-09"), /归档 2026-09（0）/);

    let invalid = null;
    try {
      run("task", "list", "--month", "2026-13");
    } catch (error) {
      invalid = error;
    }
    assert.ok(invalid, "非法归档月份应拒绝");
    assert.match(String(invalid.stderr), /非法归档月份/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
