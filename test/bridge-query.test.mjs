/**
 * 任务042：Pi 桥接命令展示结构化查询结果。
 * 用公开 Extension API 替身加载安装后的真实桥接模板，
 * 令 core CLI 返回成功 data，断言通知内容确实可见。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");
const BRIDGE_TEMPLATE = join(import.meta.dirname, "..", "assets", "templates", "pi", "extensions", "knit.ts");

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-042-${prefix}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  execFileSync(process.execPath, [CLI, "init", "--client", "pi", "--dir", dir], { encoding: "utf8" });
  return dir;
}

/** 最小公开 API 替身：捕获 registerCommand handler 与 ui.notify 通知。 */
/* 模板为 TypeScript；Node 24 类型剥离直接加载 .ts。 */
function makeHostStub() {
  const commands = new Map();
  const notifications = [];
  const pi = {
    on: () => {},
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: () => {},
  };
  const ctx = {
    ui: { notify: (text, level) => notifications.push({ text: String(text), level }) },
    reload: async () => {},
    sessionManager: { getSessionId: () => "stub-session" },
  };
  return { commands, notifications, pi, ctx };
}

async function loadBridge(dir) {
  // 安装映射与清单已 ready；用临时副本替换 __BRIDGE_BASELINE__ 占位后经 tsc 编译加载。
  const { execFileSync } = await import("node:child_process");
  const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
  const source = readFileSync(BRIDGE_TEMPLATE, "utf8").replace("__BRIDGE_BASELINE__", "stub-baseline");
  const bridgeTs = join(dir, ".bridge-stub.ts");
  writeFileSync(bridgeTs, source);
  // 编译产物放进测试项目的 .pi/extensions/.bridge-build/，与安装布局同构（root 推导 = 项目根）。
  const buildDir = join(dir, ".pi", "extensions");
  mkdirSync(buildDir, { recursive: true });
  // 让 bridge-stub.ts 解析 typebox：项目 node_modules 链接到测试项目根（编译后移除）。
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "dir");
  const sourcePath = join(buildDir, "bridge-stub.ts");
  writeFileSync(sourcePath, source);
  const compiled = spawnSync(tsc, ["--ignoreConfig", "--skipLibCheck", "--types", "node", "--target", "es2022", "--module", "es2022", "--moduleResolution", "node10", "--ignoreDeprecations", "6.0", "--outDir", buildDir, sourcePath], { encoding: "utf8", cwd: import.meta.dirname });
  if (compiled.status !== 0) throw new Error(`桥接模板编译失败: ${compiled.stderr || compiled.stdout}`);
  // 模板 import typebox —— 解析到项目 node_modules；bridge-out 内相对引用需重定位。typebox 由测试进程的 node_modules 提供。
  const module = await import(pathToFileURL(join(buildDir, "bridge-stub.js")).href);
  const host = makeHostStub();
  module.default(host.pi);
  return { host, bridgePath: bridgeTs };
}

test("桥接命令展示结构化查询结果：task list、status、按任务查询可见；失败与空列表有准确提示（任务042）", async () => {
  const dir = project("query");
  try {
    const { host, bridgePath } = await loadBridge(dir);
    await host.commands.get("knit").handler("task new --title 桥接查询 --slug bridge-query", host.ctx);
    const createdNotice = host.notifications.at(-1);
    assert.equal(createdNotice.level, "info");
    assert.match(createdNotice.text, /桥接查询/, "创建结果按任务身份展示");

    // /knit task list。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("task list", host.ctx);
    const listNotice = host.notifications.at(-1);
    assert.equal(listNotice.level, "info");
    assert.match(listNotice.text, /活跃任务（1）/);
    assert.match(listNotice.text, /桥接查询/);

    // /knit status（项目概览）。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("status", host.ctx);
    const overviewNotice = host.notifications.at(-1);
    assert.match(overviewNotice.text, /任务（1）/);
    assert.match(overviewNotice.text, /活跃运行（\d+）/);

    // /knit-status（别名命令）。
    host.notifications.length = 0;
    await host.commands.get("knit-status").handler("", host.ctx);
    const statusNotice = host.notifications.at(-1);
    assert.match(statusNotice.text, /任务（1）/);

    // /knit status <taskId>（按任务查询）。
    const taskListJson = JSON.parse(execFileSync(process.execPath, [CLI, "--json", "task", "list", "--dir", dir], { encoding: "utf8" }));
    const id = taskListJson.data.active[0].taskId;
    host.notifications.length = 0;
    await host.commands.get("knit").handler(`status ${id}`, host.ctx);
    const byIdNotice = host.notifications.at(-1);
    assert.match(byIdNotice.text, new RegExp(id));
    assert.match(byIdNotice.text, /运行（\d+）/);

    // 失败响应：未知子命令给出错误提示而非通用完成。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("definitely-not-a-command", host.ctx);
    const failureNotice = host.notifications.at(-1);
    assert.equal(failureNotice.level, "warning");
    assert.notEqual(failureNotice.text, "Knit 命令已完成");

    // 空列表：归档空列表显示（无）。
    host.notifications.length = 0;
    await host.commands.get("knit").handler("task list", host.ctx);
    assert.match(host.notifications.at(-1).text, /已归档（0）：\n  - （无）/s);

    rmSync(join(dir, ".pi", "extensions"), { recursive: true, force: true });
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    void dirname;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
