/**
 * 展示标签（任务 k-c8e440a3d4dd）：run 状态投影给出任务标题、slug 与阶段显示名；
 * 人读输出标题与阶段名优先，短 ID 退居次要；归档、缺失与流程降级如实回退。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { TaskService } from "../dist/application/task-service.js";
import { StatusService } from "../dist/application/status-service.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const TEMPLATES = join(import.meta.dirname, "..", "assets", "templates", ".knit");
const TITLE = "很长的任务标题用于验证展示截断行为是否超过二十字";
const SLUG = "display-labels";

let counter = 0;
const randomHex = () => {
  counter += 1;
  return counter.toString(16).padStart(12, "0").slice(-12);
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function project(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-status-display-${prefix}-`)));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n");
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function shortId(id) {
  const dash = id.indexOf("-");
  return `${id.slice(0, dash + 1)}${id.slice(dash + 1, dash + 7)}`;
}

function truncated(title) {
  return `${Array.from(title).slice(0, 20).join("")}…`;
}

test("状态投影与 run status：标题、slug、阶段名优先；归档可读、缺失与降级回退（任务 k-c8e440a3d4dd）", async () => {
  const dir = project("run");
  const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
  const tasks = new TaskService({ store, randomHex });
  const coordinator = new RunCoordinator({
    store,
    randomHex,
    lockRoot: join(dir, ".locks"),
    confirmTimeoutMs: 8000,
    prepareOnly: true,
  });
  try {
    const task = await tasks.newTask({ dir, title: TITLE, slug: SLUG });
    await tasks.ready({ dir, taskId: task.taskId });
    const prepared = await coordinator.prepare({
      dir,
      taskId: task.taskId,
      phase: "implement",
      initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: dir },
      model: { runtime: "pi", provider: "test", model: "fake" },
    });
    const runId = prepared.request.runId;
    const service = new StatusService({ store });

    // 正常：标题读任务文档，slug 去掉日期前缀，阶段名取配置。
    const view = await service.runStatus(dir, runId);
    assert.equal(view.taskTitle, TITLE);
    assert.equal(view.taskSlug, SLUG);
    assert.equal(view.stageName, "实现");
    assert.equal(view.taskId, task.taskId);

    // JSON 只增字段；人读首行标题优先，完整任务 ID 仍可复制。
    const json = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "status", "--run", runId, "--dir", dir], { encoding: "utf8" }));
    assert.equal(json.data.taskTitle, TITLE);
    assert.equal(json.data.taskSlug, SLUG);
    assert.equal(json.data.stageName, "实现");
    assert.equal(json.data.taskId, task.taskId);
    const humanRun = execFileSync(process.execPath, [CLI, "status", "--run", runId, "--dir", dir], { encoding: "utf8" });
    const firstLine = humanRun.split("\n")[0];
    assert.equal(firstLine, `任务：「${truncated(TITLE)}」${shortId(task.taskId)}（阶段：实现 implement）`);
    assert.match(humanRun, new RegExp(`任务: ${task.taskId} / implement`), "完整任务 ID 仍可复制");
    assert.match(humanRun, new RegExp(`run ${runId}:`), "完整 run ID 仍可复制");

    // knit status <task> 的阶段行显示显示名与 id。
    const humanTask = execFileSync(process.execPath, [CLI, "status", task.taskId, "--dir", dir], { encoding: "utf8" });
    assert.match(humanTask, new RegExp(`任务：「${truncated(TITLE)}」${shortId(task.taskId)}`));
    assert.match(humanTask, /阶段：实现（implement）/);
    assert.match(humanTask, new RegExp(`任务 ID: ${task.taskId}`), "完整任务 ID 仍可复制");

    // 归档任务仍可读出标题与 slug。
    const taskName = task.relativePath.split("/")[1];
    const source = join(dir, ".knit", "tasks", taskName);
    const target = join(dir, ".knit", "tasks", "archive", "2026-11", taskName);
    mkdirSync(join(dir, ".knit", "tasks", "archive", "2026-11"), { recursive: true });
    renameSync(source, target);
    const archived = await service.runStatus(dir, runId);
    assert.equal(archived.taskTitle, TITLE);
    assert.equal(archived.taskSlug, SLUG);
    assert.equal(archived.stageName, "实现");

    // 任务文档缺失：只回退展示字段，不阻塞 run 状态。
    rmSync(target, { recursive: true, force: true });
    const missing = await service.runStatus(dir, runId);
    assert.equal(missing.taskTitle, null);
    assert.equal(missing.taskSlug, null);
    assert.equal(missing.stageName, "实现");
    const missingHuman = execFileSync(process.execPath, [CLI, "status", "--run", runId, "--dir", dir], { encoding: "utf8" });
    assert.match(missingHuman.split("\n")[0], new RegExp(`^任务：${shortId(task.taskId)}（阶段：实现 implement）$`));

    // 流程配置降级：阶段名回退阶段 id。
    writeFileSync(join(dir, ".knit", "workflow.yaml"), "version: 2\nstages:\n  - id: implement\n");
    const fallback = await service.runStatus(dir, runId);
    assert.equal(fallback.stageName, "implement");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
