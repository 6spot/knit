import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { searchHistory } from "../dist/application/history-search.js";
import { renderInitialTaskBody } from "../dist/application/task-service.js";
import { renderTaskDocument } from "../dist/application/task-document.js";
import { TaskToolSchema } from "../dist/contracts/bridge-tools.js";
import { checkSchema } from "../dist/contracts/schema.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

function gitProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-search-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, ".knit", "tasks"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function writeTask(dir, relativeDir, { id, title, body = "", status = "open", phase = "discuss", outcome = null }) {
  const base = renderInitialTaskBody(title);
  const markdown = renderTaskDocument({
    frontmatter: {
      id,
      status,
      phase,
      outcome,
      branch: "refs/heads/main",
      createdAt: "2026-11-04T00:00:00.000Z",
      title,
    },
    inputsBody: `${base.inputsBody.trimEnd()}\n\n${body}`,
    progressBody: base.progressBody,
    trailingBody: "",
  });
  const taskDir = join(dir, relativeDir);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.md"), markdown);
  return taskDir;
}

function commitAll(dir, message) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

/** 目录树快照：记录文件内容与元数据，不记录读取会变化的 atime。 */
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
      } else if (dirent?.isFile()) {
        const stats = statSync(full);
        entries.push({
          path: rel,
          type: "file",
          size: stats.size,
          sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        });
      }
    }
  };
  walk(root);
  return entries;
}

test("历史检索：活动、归档、run 与 Git 返回可核对来源；AND、limit、无匹配与只读", () => {
  const dir = gitProject("scopes");
  try {
    const activeId = "k-aaaaaaaaaaaa";
    const activeDir = writeTask(dir, ".knit/tasks/11-04-active", {
      id: activeId,
      title: "打包安装流程确认",
      body: "## 决定\n\n- 保留一键打包安装步骤（alpha beta）\n",
    });
    writeFileSync(join(activeDir, "plan.md"), "# 计划\n\n- 后续核对打包安装输出\n");
    writeFileSync(join(activeDir, "design.md"), "# 设计\n\nalpha beta 取舍\n");
    mkdirSync(join(activeDir, "research"), { recursive: true });
    writeFileSync(join(activeDir, "research", "notes.md"), "# 调研\n\n打包安装验证记录\n");

    writeTask(dir, ".knit/tasks/archive/2026-11/11-01-old", {
      id: "k-bbbbbbbbbbbb",
      title: "旧归档线索",
      status: "closed",
      phase: "deliver",
      outcome: "completed",
    });

    // 实际 run 路径：摘要包含任务 ID 与查询词；不读取 snapshot/ 与 claim。
    const runDir = join(dir, ".knit", ".runtime", "runs", "run-aaaaaaaaaaaa");
    mkdirSync(join(runDir, "snapshot"), { recursive: true });
    writeFileSync(join(runDir, "result.json"), JSON.stringify({ taskId: activeId, report: { summary: "运行证据：打包安装成功" } }) + "\n");
    writeFileSync(join(runDir, "snapshot", "copied.txt"), "快照副本不应命中\n");
    // 兼容设计文本中的 .knit/runs 路径。
    const legacyRunDir = join(dir, ".knit", "runs", "run-bbbbbbbbbbbb");
    mkdirSync(legacyRunDir, { recursive: true });
    writeFileSync(join(legacyRunDir, "result.json"), JSON.stringify({ taskId: null, report: { summary: "设计稿来源：历史检索" } }) + "\n");

    commitAll(dir, "fix: 打包安装后的历史线索");

    const taskHits = searchHistory({ dir, query: "打包安装", scope: "task" });
    assert.ok(taskHits.length >= 3, `活动任务多处命中: ${taskHits.length}`);
    assert.ok(taskHits.every((hit) => hit.kind === "task" && hit.taskId === activeId));
    assert.ok(taskHits.some((hit) => hit.ref.endsWith(`/task.md:${hit.line}`)));
    assert.ok(taskHits.some((hit) => hit.path.endsWith("/plan.md")));
    assert.ok(taskHits.some((hit) => hit.path.endsWith("/research/notes.md")));
    assert.ok(taskHits.every((hit) => /^\.knit\/tasks\/11-04-active\/.+:\d+$/.test(hit.ref)), "ref 为项目相对 path:line");

    const andHit = searchHistory({ dir, query: ["alpha", "beta"], scope: "task" });
    assert.ok(andHit.some((hit) => hit.path.endsWith("/design.md")), "全部查询词命中才返回");
    assert.deepEqual(searchHistory({ dir, query: ["alpha", "gamma"], scope: "task" }), []);
    assert.ok(searchHistory({ dir, query: "ALPHA", scope: "task" }).some((hit) => hit.path.endsWith("/design.md")), "大小写不敏感");

    const archiveHits = searchHistory({ dir, query: "旧归档线索", scope: "archive" });
    assert.equal(archiveHits.length, 1);
    assert.equal(archiveHits[0].kind, "archive");
    assert.equal(archiveHits[0].taskId, "k-bbbbbbbbbbbb");
    assert.match(archiveHits[0].ref, /^\.knit\/tasks\/archive\/2026-11\/11-01-old\/task\.md:\d+$/);

    const runHits = searchHistory({ dir, query: "运行证据", scope: "run" });
    assert.equal(runHits.length, 1);
    assert.equal(runHits[0].kind, "run");
    assert.equal(runHits[0].taskId, activeId);
    assert.equal(runHits[0].ref, "run:run-aaaaaaaaaaaa");
    assert.match(runHits[0].path, /^\.knit\/\.runtime\/runs\/run-aaaaaaaaaaaa\/result\.json$/);
    assert.equal(searchHistory({ dir, query: "快照副本", scope: "run" }).length, 0, "不检索 snapshot/ 副本");

    const legacyRunHits = searchHistory({ dir, query: "设计稿来源", scope: "run" });
    assert.equal(legacyRunHits.length, 1);
    assert.equal(legacyRunHits[0].ref, "run:run-bbbbbbbbbbbb");
    assert.match(legacyRunHits[0].path, /^\.knit\/runs\/run-bbbbbbbbbbbb\/result\.json$/);

    const gitHits = searchHistory({ dir, query: "历史线索", scope: "git" });
    assert.equal(gitHits.length, 1);
    assert.equal(gitHits[0].kind, "git");
    assert.equal(gitHits[0].taskId, null);
    assert.equal(gitHits[0].path, "git");
    assert.match(gitHits[0].ref, /^commit:[0-9a-f]{40}$/);
    assert.match(gitHits[0].snippet, /历史线索/);

    const all = searchHistory({ dir, query: "打包安装" });
    assert.ok(all.some((hit) => hit.kind === "task"));
    assert.ok(all.some((hit) => hit.kind === "run"));
    assert.ok(all.some((hit) => hit.kind === "git"));
    assert.ok(all.length <= 20);

    assert.deepEqual(searchHistory({ dir, query: "不存在的查询词" }), []);
    assert.equal(searchHistory({ dir, query: "打包安装", limit: 1 }).length, 1);
    assert.equal(searchHistory({ dir, query: "打包安装", limit: 5 }).length, 5, "limit 按全局命中计算，跨范围不被重复扣减");
    assert.ok(searchHistory({ dir, query: "打包安装", limit: 1000 }).length <= 100);

    assert.equal(checkSchema(TaskToolSchema, { action: "search", query: ["打包安装"], scope: "task", limit: 2 }), true);

    const before = treeSnapshot(dir);
    searchHistory({ dir, query: "打包安装" });
    searchHistory({ dir, query: "历史线索", scope: "git" });
    assert.deepEqual(treeSnapshot(dir), before, "检索前后工作区、.git 与 runtime 无变化");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI task search：JSON 空数组、文本、limit 与非法参数；不创建元数据", () => {
  const dir = gitProject("cli");
  const env = { ...process.env, KNIT_LOCKS_ROOT: join(dir, ".lock-root") };
  try {
    writeTask(dir, ".knit/tasks/11-04-cli", {
      id: "k-cccccccccccc",
      title: "CLI 检索关键字",
      body: "## 记录\n\n关键字命中\n",
    });

    const json = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "search", "关键字命中", "--scope", "task", "--dir", dir], { cwd: dir, encoding: "utf8", env }));
    assert.equal(json.outcome, "completed");
    assert.ok(Array.isArray(json.data));
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].taskId, "k-cccccccccccc");
    assert.match(json.data[0].ref, /^\.knit\/tasks\/11-04-cli\/task\.md:\d+$/);

    const text = execFileSync(process.execPath, [CLI, "task", "search", "关键字命中", "--scope", "task", "--dir", dir], { cwd: dir, encoding: "utf8", env });
    assert.match(text, /匹配记录（1）/);
    assert.match(text, /关键字命中/);

    const empty = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "search", "无此词", "--dir", dir], { cwd: dir, encoding: "utf8", env }));
    assert.equal(empty.outcome, "completed");
    assert.deepEqual(empty.data, []);

    const limited = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "search", "关键字命中", "--scope", "task", "--limit", "1", "--dir", dir], { cwd: dir, encoding: "utf8", env }));
    assert.equal(limited.data.length, 1);

    for (const args of [
      ["task", "search", "关键字命中", "--scope", "nope"],
      ["task", "search", "关键字命中", "--limit", "0"],
      ["task", "search", "关键字命中", "--limit", "abc"],
    ]) {
      const result = spawnSync(process.execPath, [CLI, "--json", ...args, "--dir", dir], { cwd: dir, encoding: "utf8", env });
      assert.equal(result.status, 1, args.join(" "));
      const response = JSON.parse(result.stdout);
      assert.equal(response.outcome, "error");
      assert.equal(response.reasonCode, "invalid_request");
    }

    assert.equal(existsSync(join(dir, ".knit", ".runtime")), false, "只读检索不创建 metadata/runtime");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
