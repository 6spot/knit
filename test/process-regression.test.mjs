import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockManager, currentIdentity } from "../dist/infrastructure/locks.js";
import { NodeProcessPort, parseProcessTablePs, machineBootId } from "../dist/infrastructure/process.js";
import { isProcessAlive, isRunSettled } from "./helpers/run-settled.mjs";

test("进程059：worker与协调器使用相同的本机启动身份", () => {
  assert.equal(currentIdentity().machineBootId, machineBootId());
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

test("进程059：wait取得真实退出码，快速退出后重复wait仍可读取", async () => {
  const port = new NodeProcessPort();
  const child = await port.spawn(process.execPath, ["-e", "process.exit(7)"], { cwd: tmpdir() });
  assert.deepEqual(await port.wait(child), { exitCode: 7, signal: null });
  assert.deepEqual(await port.wait(child), { exitCode: 7, signal: null });
});

test("运行059：终态回执早于worker释放锁时，等待实际退出后再交接", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "knit-settle-gate-"));
  const key = { scope: "project", rawKey: root };
  const moduleUrl = new URL("../dist/infrastructure/locks.js", import.meta.url).href;
  const code = `
    import { LockManager } from ${JSON.stringify(moduleUrl)};
    const manager = new LockManager({ root: ${JSON.stringify(join(root, "locks"))} });
    const held = await manager.acquire({ keys: [${JSON.stringify(key)}], action: "gate" });
    process.on("message", () => { manager.release(held); process.exit(0); });
    process.send("terminal-published");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  try {
    await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("gate exited before ready")));
    });
    const status = { state: "completed", handle: { pid: child.pid } };
    assert.equal(isRunSettled(status), false, "业务完成不能证明finally已释放锁");
    const rival = new LockManager({ root: join(root, "locks") });
    await assert.rejects(() => rival.acquire({ keys: [key], action: "next" }), (error) => error.code === "lock_busy");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.send("finish-finally");
    await exited;
    assert.equal(isRunSettled(status), true);
    const next = await rival.acquire({ keys: [key], action: "next" });
    rival.release(next);
    assert.equal(rival.inspect(key).exists, false);
  } finally {
    if (isProcessAlive(child.pid)) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
