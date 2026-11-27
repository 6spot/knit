import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aliveAmong } from "../dist/application/run-control.js";
import { gitSync, parseProcessTablePs, procStartTicks, processIdentities, processTreePids, recordedProcess, sameProcessStart, signalProcessTree, withFileLock } from "../dist/infrastructure/process.js";

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

test("进程身份：仅查询存活的目标 PID，批量判活共用一次 ps", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "knit-targeted-ps-"));
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  const ps = join(dir, "ps");
  writeFileSync(ps, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$0.log"\nexec /bin/ps "$@"\n', { mode: 0o755 });
  process.env.PATH = `${dir}:${path}`;
  const dead = 2147483647;
  const file = join(dir, "worker.json");
  writeFileSync(file, JSON.stringify({ pid: dead, start: "stale" }));
  assert.equal(recordedProcess(file), null);
  assert.equal(procStartTicks(dead), null);
  assert.deepEqual(aliveAmong([{ pid: dead, start: "stale" }]), []);
  assert.equal(existsSync(`${ps}.log`), false);

  const pids = [process.pid, process.ppid];
  const table = processIdentities([...pids, dead]);
  assert.deepEqual([...table.keys()].sort(), [...pids].sort());
  const workers = pids.map((pid) => ({ pid, start: table.get(pid).startTicks }));
  assert.ok(workers.every((item) => typeof item.start === "string"));
  assert.equal(procStartTicks(process.pid), workers[0].start);
  writeFileSync(file, JSON.stringify(workers[0]));
  assert.equal(recordedProcess(file), process.pid);
  const unknown = { pid: process.pid, start: null };
  assert.deepEqual(aliveAmong([...workers, { pid: process.pid, start: "stale" }, unknown]), [...workers, unknown]);
  if (process.platform === "linux") assert.equal(existsSync(`${ps}.log`), false);
  if (process.platform !== "linux") {
    assert.deepEqual(readFileSync(`${ps}.log`, "utf8").trim().split("\n"), [pids, [process.pid], [process.pid], pids]
      .map((ids) => `-p ${ids.join(",")} -o pid=,ppid=,pgid=,stat=,lstart=,comm=`));
  }
});

test("ps 正常无匹配返回空表，诊断输出表示不可用", { skip: process.platform === "linux" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "knit-ps-result-"));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; rmSync(dir, { recursive: true, force: true }); });
  process.env.PATH = dir;
  const path = join(dir, "ps");
  writeFileSync(path, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.deepEqual(processIdentities([process.pid]), new Map());
  writeFileSync(path, "#!/bin/sh\necho unavailable >&2\nexit 1\n");
  assert.equal(processIdentities([process.pid]), null);
});

test("短命子进程尚未回收时过滤僵尸，回收后返回空表", async () => {
  const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  const closed = once(child, "close");
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && !spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "stat="], { encoding: "utf8" }).stdout.trim().startsWith("Z")) {}
  assert.ok(isProcessAlive(child.pid));
  assert.deepEqual(processIdentities([child.pid]), new Map());
  await closed;
  assert.deepEqual(processIdentities([child.pid]), new Map());
});

test("锁回调保留 SQLite 业务异常，损坏或缺失的登记返回 null", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "knit-registration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const error = Object.assign(new Error("business busy"), { errcode: 5 });
  assert.throws(() => withFileLock(join(dir, "lock"), 0, () => { throw error; }, assert.fail), (actual) => actual === error);
  const file = join(dir, "pane.json");
  assert.equal(recordedProcess(file), null);
  for (const value of ["{", "null", '{}', JSON.stringify({ pid: process.pid, start: 1 })]) {
    writeFileSync(file, value);
    assert.equal(recordedProcess(file), null);
  }
});

test("进程树：目标与调用方共享进程组时仅终止目标", async () => {
  const probe = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { signalProcessTree } from ${JSON.stringify(new URL("../dist/infrastructure/process.js", import.meta.url).href)};
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    const exit = once(child, 'exit');
    const { signaled, errors } = signalProcessTree(child.pid, 'SIGTERM');
    console.log(JSON.stringify({ onlyChild: signaled.length === 1 && signaled[0] === child.pid, errors, exit: await exit }));
  `], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const output = [];
  probe.stdout.on("data", (chunk) => output.push(chunk));
  assert.deepEqual(await once(probe, "close"), [0, null]);
  assert.deepEqual(JSON.parse(Buffer.concat(output)), { onlyChild: true, errors: [], exit: [null, "SIGTERM"] });
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
  const table = parseProcessTablePs("  200 1 200 S Tue Nov  3 10:20:30 2026 /usr/local/bin/node\n  201 1 201 R Tue Nov  3 10:20:30 2026 sleep\n");
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
  100 1 100 Ss Tue Nov  3 10:20:30 2026
  101 100 101 R Tue Nov 3 10:20:30 2026
  102 100 101 S Mon Nov 23 10:20:30 2026
  103 100 101 Z+ Mon Nov 23 10:20:30 2026 defunct
`);
  assert.equal(table.size, 3);
  assert.deepEqual(table.get(100), { ppid: 1, pgid: 100, startTicks: "Tue Nov  3 10:20:30 2026" });
  assert.equal(table.get(101).startTicks, table.get(100).startTicks);
  assert.equal(table.get(102).startTicks, "Mon Nov 23 10:20:30 2026");
});

test("recordedProcess：有启动标识时严格核对防 PID 复用，缺失 start 时回退 kill(0)", () => {
  const dir = mkdtempSync(join(tmpdir(), "knit-recorded-proc-"));
  try {
    const file = join(dir, "worker.json");
    writeFileSync(file, JSON.stringify({ pid: process.pid, start: null }));
    assert.equal(recordedProcess(file), process.pid);
    writeFileSync(file, JSON.stringify({ pid: 2147483647, start: null }));
    assert.equal(recordedProcess(file), null);
    writeFileSync(file, JSON.stringify({ pid: process.pid, start: "Thu Jan  1 00:00:00 1970|other" }));
    assert.equal(recordedProcess(file), null, "进程表可用时，不同启动标识仍拒绝复用 PID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("macOS 沙箱禁止 /bin/ps 时，recordedProcess、aliveAmong、processTreePids 与 signalProcessTree 正常判活和终止", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knit-ps-sandbox-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const mod = fileURLToPath(new URL("../dist/infrastructure/process.js", import.meta.url));
  const nullStart = join(dir, "worker-null.json");
  const realStart = join(dir, "worker-real.json");
  writeFileSync(nullStart, JSON.stringify({ pid: child.pid, start: null }));
  writeFileSync(realStart, JSON.stringify({ pid: child.pid, start: procStartTicks(child.pid) }));
  try {
    const probe = spawnSync("sandbox-exec", [
      "-p", '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))',
      process.execPath, "--input-type=module", "-e", `
        import { aliveAmong } from ${JSON.stringify(new URL("../dist/application/run-control.js", import.meta.url).href)};
        import { readFileSync } from 'node:fs';
        import { processIdentities, processTable, processTreePids, recordedProcess, signalProcessTree } from ${JSON.stringify(mod)};
        const pid = Number(process.argv[1]);
        const before = {
          tableSize: processTable().size,
          identities: processIdentities([pid]),
          alive: aliveAmong([JSON.parse(readFileSync(process.argv[3], 'utf8')), { pid: 2147483647, start: 'stale' }]).map((item) => item.pid),
          nullStart: recordedProcess(process.argv[2]),
          realStart: recordedProcess(process.argv[3]),
          tree: processTreePids(pid),
        };
        signalProcessTree(pid, "SIGTERM", before.tree);
        console.log(JSON.stringify(before));
      `, String(child.pid), nullStart, realStart,
    ], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const out = JSON.parse(probe.stdout.trim());
    assert.equal(out.tableSize, 0);
    assert.equal(out.identities, null);
    assert.deepEqual(out.alive, [child.pid]);
    assert.equal(out.nullStart, child.pid);
    assert.equal(out.realStart, child.pid);
    assert.deepEqual(out.tree, [child.pid]);
    await once(child, "exit");
    assert.equal(recordedProcess(nullStart), null);
    assert.equal(recordedProcess(realStart), null);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
