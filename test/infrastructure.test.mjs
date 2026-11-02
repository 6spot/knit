import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { atomicWrite, readWithVersion } from "../dist/infrastructure/atomic.js";
import { sha256Text, sha256Bytes, digestOf, fileFacts, listFiles } from "../dist/infrastructure/fingerprint.js";
import { normalizeRoot, hashKey, safeJoin } from "../dist/infrastructure/paths.js";
import { InfrastructureError } from "../dist/infrastructure/errors.js";
import { LockManager, orderKeys, currentIdentity, procStartTicks } from "../dist/infrastructure/locks.js";
import { ArgvGitPort, NodeProcessPort, gitSync, processTreePids, signalProcessTree } from "../dist/infrastructure/process.js";
import { decideStartStep, decideStepCheckpoint, decideComplete, decideAbandon, findStepByIdempotencyKey, newOperation } from "../dist/infrastructure/operations.js";

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `knit-infra-${prefix}-`));
}

test("原子写：预期版本不符不覆盖后来内容", () => {
  const dir = freshDir("atomic");
  try {
    const path = join(dir, "state.json");
    const first = atomicWrite({ path, data: Buffer.from("v1") });
    writeFileSync(path, "v2-by-rival"); // 模拟后来者覆盖
    assert.throws(
      () => atomicWrite({ path, data: Buffer.from("v3"), expectedSha256: first.sha256 }),
      (error) => error.code === "version_conflict",
    );
    assert.equal(readFileSync(path, "utf8"), "v2-by-rival", "后来内容必须保留");
    // 正确预期版本可发布
    const third = atomicWrite({ path, data: Buffer.from("v3"), expectedSha256: sha256Text("v2-by-rival") });
    assert.equal(third.sha256, sha256Text("v3"));
    // expectedSha256: null 要求文件不存在
    const newPath = join(dir, "new.json");
    atomicWrite({ path: newPath, data: Buffer.from("x"), expectedSha256: null });
    assert.throws(
      () => atomicWrite({ path: newPath, data: Buffer.from("y"), expectedSha256: null }),
      (error) => error.code === "version_conflict",
    );
    // 无残留临时文件
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".knit-tmp-")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("原子写：私有权限 0600 与嵌套目录创建", () => {
  const dir = freshDir("perm");
  try {
    const nested = join(dir, "a", "b", "file.txt");
    atomicWrite({ path: nested, data: Buffer.from("secret") });
    const mode = statSync(nested).mode & 0o777;
    assert.equal(mode, 0o600, `file mode ${mode.toString(8)}`);
    const dirMode = statSync(join(dir, "a", "b")).mode & 0o777;
    assert.ok((dirMode & 0o077) === 0, `目录不应含组／他人权限: ${dirMode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("原子写失败路径：临时文件清理后原文件保留", () => {
  const dir = freshDir("atomic-fail");
  try {
    const path = join(dir, "f.txt");
    atomicWrite({ path, data: Buffer.from("keep") });
    // 只读目录强制 rename 失败
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const subFile = join(sub, "x.txt");
    atomicWrite({ path: subFile, data: Buffer.from("v1") });
    chmodSync(sub, 0o500);
    try {
      assert.throws(() => atomicWrite({ path: subFile, data: Buffer.from("v2"), expectedSha256: sha256Text("v1") }));
      assert.equal(readFileSync(subFile, "utf8"), "v1", "失败后原文件保留");
    } finally {
      chmodSync(sub, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("指纹与路径：稳定键、safeJoin 拒绝越界与符号链接逃逸", () => {
  assert.equal(hashKey("a"), hashKey("a"));
  assert.notEqual(hashKey("a"), hashKey("b"));
  assert.equal(digestOf({ x: 1, y: "2" }), digestOf({ y: "2", x: 1 }));
  assert.notEqual(digestOf({ x: 1 }), digestOf({ x: 2 }));

  const dir = freshDir("paths");
  try {
    const root = normalizeRoot(dir);
    assert.equal(normalizeRoot(join(dir, "sub", "..")), root);
    // 常规相对路径
    assert.equal(safeJoin(root, "tasks/a.md"), join(root, "tasks", "a.md"));
    // 绝对路径拒绝
    assert.throws(() => safeJoin(root, "/etc/passwd"), (error) => error.code === "path_escape");
    // .. 越界拒绝
    assert.throws(() => safeJoin(root, "../outside"), (error) => error.code === "path_escape");
    // NUL 拒绝
    assert.throws(() => safeJoin(root, "a\0b"), (error) => error.code === "path_escape");
    // 符号链接指向项目外：拒绝
    const outside = freshDir("outside");
    try {
      writeFileSync(join(outside, "secret.txt"), "s");
      const link = join(root, "link");
      execFileSync("ln", ["-s", outside, link]);
      assert.throws(() => safeJoin(root, "link/secret.txt"), (error) => error.code === "path_escape");
      // 等价改名（目录内移动）不拒绝
      mkdirSync(join(root, "t1"));
      assert.equal(safeJoin(root, "t1/../t2"), join(root, "t2"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件事实：absent 如实记录，不抛错", () => {
  const dir = freshDir("facts");
  try {
    const file = join(dir, "a.txt");
    assert.deepEqual(fileFacts(file), { kind: "absent", mode: null, sha256: null, childCount: null });
    writeFileSync(file, "hello");
    const facts = fileFacts(file);
    assert.equal(facts.kind, "file");
    assert.equal(facts.sha256, sha256Text("hello"));
    assert.equal(facts.childCount, null);
    const listed = listFiles(dir);
    assert.equal(Object.keys(listed).length, 1);
    assert.ok(listed["a.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function lockManagerFor(root, overrides = {}) {
  return new LockManager({ root, now: () => new Date(), ...overrides });
}

test("锁：占用互斥、owner 记录与 token 释放", async () => {
  const root = freshDir("locks");
  try {
    const manager = lockManagerFor(root);
    const key = { scope: "project", rawKey: "/tmp/some-project" };
    const acquired = await manager.acquire({ keys: [key], action: "test" });
    assert.ok(acquired.token);
    // 第二个管理者（不同进程身份）被拒
    const rival = lockManagerFor(root, { identity: { pid: 1, procStartTicks: "1", machineBootId: currentIdentity().machineBootId } });
    await assert.rejects(
      () => rival.acquire({ keys: [key], action: "rival" }),
      (error) => error.code === "lock_busy",
    );
    // inspect：只读不建目录，alive 判定
    const status = manager.inspect(key);
    assert.equal(status.exists, true);
    assert.equal(status.processVerdict, "alive");
    assert.equal(status.owner.token, acquired.token);
    assert.equal(status.owner.action, "test");
    // 心跳更新 heartbeatAt
    await manager.heartbeat(acquired);
    const afterBeat = manager.inspect(key);
    assert.ok(afterBeat.owner.heartbeatAt >= status.owner.heartbeatAt);
    // 错误 token 不能心跳
    await assert.rejects(() => manager.heartbeat({ token: "wrong", keys: [key], ownerPaths: acquired.ownerPaths }),
      (error) => error.code === "lock_token_mismatch");
    // 错误 token 不能释放他人锁
    manager.release({ token: "wrong", keys: [key] });
    assert.equal(manager.inspect(key).exists, true);
    // 正确 token 释放
    manager.release(acquired);
    assert.equal(manager.inspect(key).exists, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁：多键失败按 token 释放本次已取得锁", async () => {
  const root = freshDir("locks-multi");
  try {
    const manager = lockManagerFor(root);
    const rival = lockManagerFor(root, { identity: { pid: 2, procStartTicks: "2", machineBootId: currentIdentity().machineBootId } });
    // 对手先持有第二键
    const second = { scope: "session", rawKey: "pi/native-s-1" };
    await rival.acquire({ keys: [second], action: "rival" });
    // 我方请求两键：第一键成功，第二键失败 → 第一键也必须被释放
    await assert.rejects(
      () => manager.acquire({ keys: [{ scope: "project", rawKey: "/tmp/p1" }, second], action: "mine" }),
      (error) => error.code === "lock_busy",
    );
    assert.equal(manager.inspect({ scope: "project", rawKey: "/tmp/p1" }).exists, false, "本次已取得的锁被释放");
    assert.equal(manager.inspect(second).owner.action, "rival", "对手锁不受影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁：只读 inspect 不创建目录", () => {
  const root = freshDir("locks-readonly");
  try {
    const manager = lockManagerFor(root);
    const status = manager.inspect({ scope: "project", rawKey: "/tmp/never" });
    assert.equal(status.exists, false);
    assert.equal(status.owner, null);
    assert.equal(existsSync(join(root, "projects")), false, "只读查询不建锁目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁：PID 复用由 starttime 识别，身份未知不冒充死亡", async () => {
  const root = freshDir("locks-pid");
  try {
    const bootId = currentIdentity().machineBootId;
    const manager = lockManagerFor(root);
    // 伪造 owner：PID 复用场景（记录的 starttime 与当前进程不同）
    const key = { scope: "project", rawKey: "/tmp/reused" };
    await manager.acquire({ keys: [key], action: "old" });
    const ownerPath = join(root, "projects", hashKey("/tmp/reused"), "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: process.pid, procStartTicks: "1" }));
    const verdict = manager.inspect(key).processVerdict;
    assert.equal(verdict, "not_alive", "starttime 不匹配 → PID 复用，判 not_alive");
    // 身份未知：跨机 boot id
    writeFileSync(ownerPath, JSON.stringify({ ...owner, machineBootId: "other-machine" }));
    assert.equal(manager.inspect(key).processVerdict, "unknown");
    // owner 文件损坏
    writeFileSync(ownerPath, "{broken");
    assert.deepEqual(manager.inspect(key), { exists: true, owner: null, processVerdict: "unknown" });
    void bootId;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁：同 Session 跨项目是同一把 session 锁", async () => {
  const root = freshDir("locks-session");
  try {
    const manager = lockManagerFor(root);
    const sessionKey = { scope: "session", rawKey: "pi/01a1981c-6f75-749d-b9c2-7e5c897950a6" };
    await manager.acquire({ keys: [{ scope: "project", rawKey: "/tmp/project-a" }, sessionKey], action: "project-a" });
    // 另一项目复用同一原生会话：session 键冲突，即使项目键不同
    const rival = lockManagerFor(root, { identity: { pid: 3, procStartTicks: "3", machineBootId: currentIdentity().machineBootId } });
    await assert.rejects(
      () => rival.acquire({ keys: [{ scope: "project", rawKey: "/tmp/project-b" }, sessionKey], action: "project-b" }),
      (error) => error.code === "lock_busy",
    );
    void hashKey;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁：固定顺序排序，同类键按 rawKey", () => {
  const ordered = orderKeys([
    { scope: "session", rawKey: "pi/b" },
    { scope: "project", rawKey: "/tmp/z" },
    { scope: "session", rawKey: "pi/a" },
    { scope: "project", rawKey: "/tmp/a" },
  ]);
  assert.deepEqual(ordered.map((key) => `${key.scope}:${key.rawKey}`), [
    "project:/tmp/a",
    "project:/tmp/z",
    "session:pi/a",
    "session:pi/b",
  ]);
});

test("锁：心跳原子更新在版本被外部改动时拒绝", async () => {
  const root = freshDir("locks-beat");
  try {
    const manager = lockManagerFor(root);
    const key = { scope: "project", rawKey: "/tmp/beat" };
    const acquired = await manager.acquire({ keys: [key], action: "beat" });
    // 外部篡改 owner（同 token 不同内容，模拟并发写）：心跳的 expectedSha256 不再匹配
    const ownerPath = acquired.ownerPaths[0];
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, action: "tampered" }));
    await assert.rejects(
      () => manager.heartbeat(acquired),
      (error) => error.code === "version_conflict",
    );
    // 正常路径：紧接获取后的心跳不冲突
    const fresh = await manager.acquire({ keys: [{ scope: "project", rawKey: "/tmp/beat2" }], action: "beat2" });
    await manager.heartbeat(fresh);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("进程：procStartTicks 是当前进程的数字字符串", () => {
  const ticks = procStartTicks(process.pid);
  assert.ok(ticks !== null && /^\d+$/.test(ticks), `unexpected: ${ticks}`);
  assert.equal(procStartTicks(2 ** 22), null, "不存在进程返回 null");
});

test("Git：argv 调用与 NUL 解析、固定环境", async () => {
  const dir = freshDir("git");
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "hello");
    const port = new ArgvGitPort();
    const add = await port.run(["add", "a.txt"], { cwd: dir });
    assert.equal(add.code, 0);
    const commit = await port.run(["commit", "-q", "-m", "msg with \"quote\" and $VAR"], { cwd: dir });
    assert.equal(commit.code, 0, commit.stderr);
    const log = await port.run(["log", "-1", "--format=%s"], { cwd: dir });
    assert.equal(log.stdout.trim(), 'msg with "quote" and $VAR', "argv 传参不经 shell");
    // pager 禁用
    const head = gitSync(["rev-parse", "HEAD"], dir);
    assert.equal(head.code, 0);
    assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
    // 错误命令返回非零与 stderr，不抛
    const bad = await port.run(["rev-parse", "--verify", "definitely-not-a-ref"], { cwd: dir });
    assert.equal(bad.code, 128);
    assert.ok(bad.stderr.length > 0);
    // 缺少 git 可执行
    const missing = new ArgvGitPort("definitely-not-git-binary");
    const failed = await missing.run(["status"], { cwd: dir });
    assert.equal(failed.code, -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("操作检查点：意图→执行→核验→完成与放弃", () => {
  let op = newOperation({
    operationId: "op-1",
    kind: "git_commit",
    steps: [{ stepId: "s1", kind: "git_commit", idempotencyKey: "commit:abc", before: { head: "aaa" }, after: { head: "bbb" } }],
  }, "2026-11-01T00:00:00Z");
  assert.equal(op.state, "planned");
  assert.equal(op.steps[0].state, "planned");

  // 开始执行
  const start = decideStartStep(op, "s1");
  assert.equal(start.allowed, true);
  assert.equal(start.state, "running");
  op = { ...op, state: "running", steps: [{ ...op.steps[0], state: "running" }] };

  // 观察到期望 after → 检查点完成
  const cp = decideStepCheckpoint(op, "s1", { after: { head: "bbb" }, evidence: { realOid: "bbb", "before.head": "aaa" } });
  assert.equal(cp.allowed, true);
  op = { ...op, steps: [{ ...op.steps[0], state: "completed", evidence: { realOid: "bbb" } }] };

  // 收束 completed
  const done = decideComplete(op);
  assert.equal(done.allowed, true);
  assert.equal(done.state, "completed");

  // completed 不改回 running
  assert.deepEqual(decideStartStep({ ...op, state: "completed" }, "s1").allowed, false);

  // 幂等键重复定位
  assert.equal(findStepByIdempotencyKey(op, "commit:abc").stepId, "s1");
  assert.equal(findStepByIdempotencyKey(op, "nope"), null);
});

test("操作检查点：after 不匹配与效果未知进 needs_attention，不盲目重试", () => {
  const base = newOperation({
    operationId: "op-2",
    kind: "file_move",
    steps: [{ stepId: "s1", kind: "file_move", idempotencyKey: "move:1", before: { path: "a" }, after: { path: "b" } }],
  }, "2026-11-01T00:00:00Z");
  const running = { ...base, state: "running", steps: [{ ...base.steps[0], state: "running" }] };

  // 观察结果既不是期望 after：保留现场
  const mismatch = decideStepCheckpoint(running, "s1", { after: { path: "c" }, evidence: {} });
  assert.equal(mismatch.state, "needs_attention");
  assert.equal(mismatch.step.state, "needs_attention");

  // needs_attention 不允许直接开新步骤
  assert.deepEqual(decideStartStep({ ...running, state: "needs_attention" }, "s1"), { allowed: false, reason: "operation_needs_attention" });

  // 有未知效果的运行中操作不能直接 abandoned
  const midRun = { ...running, state: "running" };
  assert.deepEqual(decideAbandon(midRun), { allowed: false, reason: "operation_needs_attention" });

  // 明确撤回且无未知效果才 abandoned
  const idle = { ...base, state: "planned" };
  const abandoned = decideAbandon(idle);
  assert.equal(abandoned.allowed, true);
  assert.equal(abandoned.state, "abandoned");
  // abandoned 不改回 running
  assert.deepEqual(decideStartStep({ ...idle, state: "abandoned" }, "s1"), { allowed: false, reason: "operation_abandoned" });
});

test("操作检查点：before 匹配的幂等重入返回既有证据", () => {
  const base = newOperation({
    operationId: "op-3",
    kind: "git_commit",
    steps: [{ stepId: "s1", kind: "git_commit", idempotencyKey: "k", before: null, after: { head: "bbb" } }],
  }, "2026-11-01T00:00:00Z");
  // 已完成步骤的幂等重入：不重执行
  const completedOp = { ...base, state: "running", steps: [{ ...base.steps[0], state: "completed", evidence: { realOid: "bbb" } }] };
  const reentry = decideStartStep(completedOp, "s1");
  assert.equal(reentry.allowed, true);
  assert.equal(reentry.step.state, "completed");
  assert.equal(reentry.step.evidence.realOid, "bbb");
  // before 为 null（无已知起点）时核验只看 after
  const cp = decideStepCheckpoint({ ...completedOp, steps: [{ ...completedOp.steps[0], state: "running", evidence: null }] }, "s1", {
    after: { head: "bbb" },
    evidence: { realOid: "bbb" },
  });
  assert.equal(cp.step.state, "completed");
});

test("进程：spawn/wait/killProcessGroup 对真实子进程", async () => {
  const port = new NodeProcessPort();
  const proc = await port.spawn("sh", ["-c", "echo ok"], { cwd: tmpdir() });
  assert.ok(proc.pid > 0);
  let output = "";
  const reader = proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
  }
  assert.equal(output.trim(), "ok");
  const quick = await port.spawn("sh", ["-c", "exit 0"], { cwd: tmpdir() });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const wait = await port.wait(quick);
  assert.ok(wait.exitCode === null || wait.exitCode === 0, JSON.stringify(wait));
  // kill 进程组：sleep 子进程被终止
  const sleeper = await port.spawn("sh", ["-c", "sleep 30"], { cwd: tmpdir() });
  await port.killProcessGroup(sleeper, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(existsSync(`/proc/${sleeper.pid}`), false, "子进程组已终止");
  void sha256Bytes;
  void readWithVersion;
  void InfrastructureError;
});

test("锁：显式 unlock 要求 token，alive 需 force；旧 token 不删新占用", async () => {
  const root = freshDir("locks-unlock");
  try {
    const manager = lockManagerFor(root);
    const key = { scope: "project", rawKey: "/tmp/unlock-project" };
    const first = await manager.acquire({ keys: [key], action: "first" });
    const listed = manager.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, key.rawKey);
    assert.equal(listed[0].processVerdict, "alive");
    await assert.rejects(
      async () => manager.unlock({ key, expectToken: "wrong-token" }),
      (error) => error.code === "lock_token_mismatch",
    );
    await assert.rejects(
      async () => manager.unlock({ key, expectToken: first.token }),
      (error) => error.code === "lock_busy",
    );
    const removed = manager.unlock({ key, expectToken: first.token, force: true });
    assert.equal(removed.removed, true);
    manager.release(first); // 旧 token 此时已无 owner，不误删任何东西

    const second = await manager.acquire({ keys: [key], action: "second" });
    manager.release(first); // 旧 token 不得删除新 owner
    assert.equal(manager.inspect(key).owner?.token, second.token);
    await assert.rejects(
      async () => manager.unlock({ key, expectToken: first.token, force: true }),
      (error) => error.code === "lock_token_mismatch",
    );
    manager.unlock({ key, expectToken: second.token, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁：跨进程 mkdir 竞争只有一个持有者", async () => {
  const root = freshDir("locks-multiprocess");
  const script = join(root, "holder.mjs");
  const locksModule = join(import.meta.dirname, "..", "dist", "infrastructure", "locks.js");
  writeFileSync(
    script,
    `import { LockManager } from ${JSON.stringify(locksModule)};\n` +
      `const m = new LockManager({ root: process.argv[2] });\n` +
      `const l = await m.acquire({ keys: [{ scope: "project", rawKey: "/tmp/shared" }], action: "child" });\n` +
      `console.log("HELD");\n` +
      `await new Promise((r) => setTimeout(r, 3000));\n` +
      `m.release(l);\n`,
  );
  const holder = spawn(process.execPath, [script, root], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      holder.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("HELD")) resolve();
      });
      holder.once("exit", (code) => reject(new Error(`holder exited early: ${code}`)));
    });
    const rival = spawnSyncNode(script, root);
    assert.notEqual(rival.code, 0, "竞争进程不能取得锁");
    assert.match(rival.stderr, /lock_busy/);
  } finally {
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

function spawnSyncNode(script, root) {
  try {
    execFileSync(process.execPath, [script, root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stderr: String(error.stderr ?? error.message) };
  }
}

test("进程树：取消时清理工具自建进程组的后代", async () => {
  const port = new NodeProcessPort();
  const root = await port.spawn("sh", ["-c", "setsid sleep 30 & echo $!; wait"], { cwd: tmpdir() });
  try {
    const reader = root.stdout.getReader();
    const { value } = await reader.read();
    const childPid = Number(new TextDecoder().decode(value).trim().split("\n")[0]);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const tree = processTreePids(root.pid);
    assert.ok(tree.includes(root.pid));
    assert.ok(tree.includes(childPid), `树应包含工具子进程: ${tree.join(",")}`);
    signalProcessTree(root.pid, "SIGTERM", tree);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(`/proc/${root.pid}`), false);
    assert.equal(existsSync(`/proc/${childPid}`), false, "工具自建进程组也必须清理");
  } finally {
    signalProcessTree(root.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test("锁：权限不足显式失败，不创建假占用", async () => {
  const parent = freshDir("locks-perm");
  const root = join(parent, "locks");
  try {
    chmodSync(parent, 0o500);
    const manager = new LockManager({ root });
    await assert.rejects(
      () => manager.acquire({ keys: [{ scope: "project", rawKey: "/tmp/perm" }], action: "perm" }),
      (error) => error.code === "io_error" && error.details?.permission === true,
    );
    assert.equal(existsSync(root), false);
  } finally {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});
