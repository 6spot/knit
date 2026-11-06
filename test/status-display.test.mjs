/**
 * 展示标签（任务 k-c8e440a3d4dd）：run 状态投影给出任务标题、slug 与阶段显示名；
 * 人读输出标题与阶段名优先，短 ID 退居次要；归档、缺失与流程降级如实回退。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** 测试内改写已发布请求的阶段，覆盖锚点展示；不改状态与结果文件。 */
function setRunPhase(dir, runId, phase) {
  const file = join(dir, ".knit", ".runtime", "runs", runId, "request.json");
  const request = JSON.parse(readFileSync(file, "utf8"));
  request.phase = phase;
  writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`);
}

test("状态投影与 run status：标题、slug、阶段名优先；归档可读、缺失与降级回退（任务 k-c8e440a3d4dd、k-80202ada97d0）", async () => {
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

    // JSON 保留完整任务 ID；人读首行标题优先，旧的重复任务行已删除。
    const json = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "status", "--run", runId, "--dir", dir], { encoding: "utf8" }));
    assert.equal(json.data.taskTitle, TITLE);
    assert.equal(json.data.taskSlug, SLUG);
    assert.equal(json.data.stageName, "实现");
    assert.equal(json.data.taskId, task.taskId);
    const humanRun = execFileSync(process.execPath, [CLI, "status", "--run", runId, "--dir", dir], { encoding: "utf8" });
    const firstLine = humanRun.split("\n")[0];
    assert.equal(firstLine, `任务：「${truncated(TITLE)}」${shortId(task.taskId)}（阶段：实现 implement）`);
    assert.doesNotMatch(humanRun, /^任务: /m, "旧的重复任务行已删除");
    assert.match(humanRun, new RegExp(`run ${runId}:`), "完整 run ID 仍可复制");
    assert.match(humanRun, /耗时 /, "耗时保留在 run 行");

    // knit run status 与 knit status --run 首行同口径。
    const humanRunStatus = execFileSync(process.execPath, [CLI, "run", "status", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(humanRunStatus.split("\n")[0], firstLine);
    assert.doesNotMatch(humanRunStatus, /^任务: /m, "旧的重复任务行已删除");
    assert.match(humanRunStatus, new RegExp(`run ${runId}:`), "完整 run ID 仍可复制");

    // knit status <task> 的阶段行显示显示名与 id。
    const humanTask = execFileSync(process.execPath, [CLI, "status", task.taskId, "--dir", dir], { encoding: "utf8" });
    assert.match(humanTask, new RegExp(`任务：「${truncated(TITLE)}」${shortId(task.taskId)}`));
    assert.match(humanTask, /阶段：实现（implement）/);
    assert.match(humanTask, new RegExp(`任务 ID: ${task.taskId}`), "完整任务 ID 仍可复制");

    // 锚点阶段：start／deliver 使用内置显示名，配置阶段仍用 name。
    setRunPhase(dir, runId, "start");
    assert.equal((await service.runStatus(dir, runId)).stageName, "准备");
    const startHuman = execFileSync(process.execPath, [CLI, "status", "--run", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(startHuman.split("\n")[0], `任务：「${truncated(TITLE)}」${shortId(task.taskId)}（阶段：准备 start）`);
    const startRunHuman = execFileSync(process.execPath, [CLI, "run", "status", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(startRunHuman.split("\n")[0], startHuman.split("\n")[0]);
    setRunPhase(dir, runId, "deliver");
    assert.equal((await service.runStatus(dir, runId)).stageName, "收尾");
    const deliverHuman = execFileSync(process.execPath, [CLI, "status", "--run", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(deliverHuman.split("\n")[0], `任务：「${truncated(TITLE)}」${shortId(task.taskId)}（阶段：收尾 deliver）`);
    const deliverRunHuman = execFileSync(process.execPath, [CLI, "run", "status", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(deliverRunHuman.split("\n")[0], deliverHuman.split("\n")[0]);
    setRunPhase(dir, runId, "implement");

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

    // 标题缺失（空白）退 slug；slug 也缺失时退短 ID。
    const archivedTaskFile = join(target, "task.md");
    writeFileSync(archivedTaskFile, readFileSync(archivedTaskFile, "utf8").replace(/^title: .*$/m, 'title: " "'));
    const slugOnly = await service.runStatus(dir, runId);
    assert.equal(slugOnly.taskTitle, null);
    assert.equal(slugOnly.taskSlug, SLUG);
    const slugHuman = execFileSync(process.execPath, [CLI, "status", "--run", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(slugHuman.split("\n")[0], `任务：${SLUG}（${shortId(task.taskId)}）（阶段：实现 implement）`);
    const slugRunHuman = execFileSync(process.execPath, [CLI, "run", "status", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(slugRunHuman.split("\n")[0], slugHuman.split("\n")[0]);

    // 任务文档缺失：只回退展示字段，不阻塞 run 状态。
    rmSync(target, { recursive: true, force: true });
    const missing = await service.runStatus(dir, runId);
    assert.equal(missing.taskTitle, null);
    assert.equal(missing.taskSlug, null);
    assert.equal(missing.stageName, "实现");
    const missingHuman = execFileSync(process.execPath, [CLI, "status", "--run", runId, "--dir", dir], { encoding: "utf8" });
    assert.match(missingHuman.split("\n")[0], new RegExp(`^任务：${shortId(task.taskId)}（阶段：实现 implement）$`));
    const missingRunHuman = execFileSync(process.execPath, [CLI, "run", "status", runId, "--dir", dir], { encoding: "utf8" });
    assert.equal(missingRunHuman.split("\n")[0], missingHuman.split("\n")[0]);

    // 流程配置降级：阶段名回退阶段 id。
    writeFileSync(join(dir, ".knit", "workflow.yaml"), "version: 2\nstages:\n  - id: implement\n");
    const fallback = await service.runStatus(dir, runId);
    assert.equal(fallback.stageName, "implement");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
