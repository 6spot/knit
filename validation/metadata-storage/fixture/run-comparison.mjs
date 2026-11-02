#!/usr/bin/env node
/**
 * 比较驱动：对文件版与 SQLite 版执行同一场景脚本（任务004）。
 * 用法：node run-comparison.mjs [file|sqlite|both]   默认 both。
 * 输出机器可读 JSON 结果到 stdout；详细断言失败直接抛错。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeStore, runScenarios } from "./store-factory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = HERE;
// 文件版崩溃恢复需等锁过期接管；测试用短窗（2s）控时长，默认 15s 见 file-store.mjs。
// 这一等待本身是两后端的真实差异：SQLite 版 WAL 释放是即时的。
process.env.KNIT_FIXTURE_LOCK_STALE_MS ??= "2000";

function snapshotDir(root) {
  const out = {};
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[path.relative(root, full)] = st.size;
    }
  };
  walk(root);
  return out;
}

function spawnRivalFactory(root, kind) {
  // rival 子进程独立打开同一 store；打印 JSON 行结果。
  return async function spawnRival(script, t) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, FIXTURES, root], {
      env: { ...process.env, KNIT_STORE_KIND: kind },
      cwd: FIXTURES,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const completed = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, completed, stderr };
  };
}

async function runOnce(kind) {
  const root = mkdtempSync(path.join(tmpdir(), `knit-mstore-${kind}-`));
  const helpers = {
    spawnRival: spawnRivalFactory(root, kind),
    snapshotDir: (dir) => snapshotDir(dir),
    makeFreshStore: () => makeStore(root, kind),
  };
  const store = await makeStore(root, kind);
  const t0 = Date.now();
  const counters = await runScenarios(store, "cmp", helpers);
  const elapsedMs = Date.now() - t0;
  if (typeof store.close === "function") await store.close();
  return { kind, root, counters, elapsedMs };
}

const target = process.argv[2] ?? "both";
const kinds = target === "both" ? ["file", "sqlite"] : [target];
const results = [];
for (const kind of kinds) {
  const result = await runOnce(kind);
  results.push(result);
  console.log(`[${kind}] 8 scenarios PASS in ${result.elapsedMs}ms at ${result.root}`);
}
console.log(JSON.stringify({ results: results.map(({ kind, counters, elapsedMs }) => ({ kind, counters, elapsedMs })) }, null, 2));
