import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSync, parseProcessTablePs, procStartTicks, processTreePids, sameProcessStart, signalProcessTree } from "../dist/infrastructure/process.js";

/** 本机存活检查：权限未知视作仍存活。 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

test("进程：procStartTicks 是当前进程的稳定启动身份", () => {
  const ticks = procStartTicks(process.pid);
  assert.ok(typeof ticks === "string" && ticks.length > 0, `unexpected: ${ticks}`);
  assert.equal(procStartTicks(process.pid), ticks, "同一进程多次读取身份一致");
  if (process.platform === "linux") assert.match(ticks, /^\d+$/);
  assert.equal(procStartTicks(2 ** 22), null, "不存在进程返回 null");
});

test("Git：argv 调用与 NUL 解析、固定环境", () => {
  const dir = mkdtempSync(join(tmpdir(), "knit-infra-git-"));
  try {
    assert.equal(gitSync(["init", "-q", "-b", "main"], dir).code, 0);
    assert.equal(gitSync(["config", "user.email", "t@example.com"], dir).code, 0);
    assert.equal(gitSync(["config", "user.name", "t"], dir).code, 0);
    writeFileSync(join(dir, "a.txt"), "hello");
    assert.equal(gitSync(["add", "a.txt"], dir).code, 0);
    const commit = gitSync(["commit", "-q", "-m", "msg with \"quote\" and $VAR"], dir);
    assert.equal(commit.code, 0, commit.stderr);
    const log = gitSync(["log", "-1", "--format=%s"], dir);
    assert.equal(log.stdout.trim(), 'msg with "quote" and $VAR', "argv 传参不经 shell");
    const head = gitSync(["rev-parse", "HEAD"], dir);
    assert.equal(head.code, 0);
    assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
    // 错误命令返回非零与 stderr，不抛
    const bad = gitSync(["rev-parse", "--verify", "definitely-not-a-ref"], dir);
    assert.equal(bad.code, 128);
    assert.ok(bad.stderr.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进程树：取消时清理工具自建进程组的后代", async () => {
  const root = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    process.on("SIGTERM", () => {});
    child.once("exit", () => process.exit(0));
    // console.log 在有颜色的终端里会给数字加颜色码，读的一方解析不出进程号。
    process.stdout.write(String(child.pid));
  `], { cwd: tmpdir(), detached: true });
  try {
    const [output] = await once(root.stdout, "data");
    const childPid = Number(output.toString());
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const tree = processTreePids(root.pid);
    assert.ok(tree.includes(root.pid));
    assert.ok(tree.includes(childPid), `树应包含工具子进程: ${tree.join(",")}`);
    signalProcessTree(root.pid, "SIGTERM", tree);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(isProcessAlive(root.pid), false);
    assert.equal(isProcessAlive(childPid), false, "工具自建进程组也必须清理");
  } finally {
    signalProcessTree(root.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test("进程身份：ps 回退带可执行名；同秒不同命令视为不同进程，旧格式只比 lstart", () => {
  const table = parseProcessTablePs("  200 1 200 Tue Nov  3 10:20:30 2026 /usr/local/bin/node\n  201 1 201 Tue Nov  3 10:20:30 2026 sleep\n");
  assert.equal(table.get(200).startTicks, "Tue Nov  3 10:20:30 2026|/usr/local/bin/node");
  assert.equal(table.get(201).startTicks, "Tue Nov  3 10:20:30 2026|sleep");
  assert.equal(sameProcessStart(table.get(200).startTicks, table.get(201).startTicks), false, "同秒 PID 复用：命令不同即不同");
  assert.equal(sameProcessStart(table.get(200).startTicks, table.get(200).startTicks), true);
  assert.equal(sameProcessStart("Tue Nov  3 10:20:30 2026", table.get(200).startTicks), true, "升级前记录只比 lstart");
  assert.equal(sameProcessStart("Tue Nov  3 10:20:31 2026", table.get(200).startTicks), false);
  assert.equal(sameProcessStart("123", "123"), true);
  assert.equal(sameProcessStart("123", "124"), false, "Linux starttime 精确比较");
});

test("进程059：ps解析兼容24字符日期、单日空白和多位日，忽略残缺行", () => {
  const table = parseProcessTablePs(`
  100 1 100 Tue Nov  3 10:20:30 2026   
  101 100 101 Tue Nov 3 10:20:30 2026
  102 100 101 Mon Nov 23 10:20:30 2026
  103 100 101 broken
`);
  assert.equal(table.size, 3);
  assert.deepEqual(table.get(100), { ppid: 1, pgid: 100, startTicks: "Tue Nov  3 10:20:30 2026" });
  assert.equal(table.get(101).startTicks, table.get(100).startTicks);
  assert.equal(table.get(102).startTicks, "Mon Nov 23 10:20:30 2026");
});
