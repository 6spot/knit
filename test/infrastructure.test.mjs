import { isProcessAlive } from "./helpers/run-settled.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { atomicWrite, readWithVersion } from "../dist/infrastructure/atomic.js";
import { sha256Text, sha256Bytes, digestOf, fileFacts, listFiles } from "../dist/infrastructure/fingerprint.js";
import { normalizeRoot, hashKey, safeJoin } from "../dist/infrastructure/paths.js";
import { InfrastructureError } from "../dist/infrastructure/errors.js";
import { LockManager, STATE_LOCK_WAIT_MS, orderKeys, currentIdentity, procStartTicks, heartbeatState, parseLockId } from "../dist/infrastructure/locks.js";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { ArgvGitPort, NodeProcessPort, gitSync, parseProcessTablePs, processTreePids, sameProcessStart, signalProcessTree } from "../dist/infrastructure/process.js";
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

test("运行目录与数据库权限：新建与既有 0755 目录、0644 数据库在不同 umask 下收紧到 0700／0600（任务040）", () => {
  const oldUmask = process.umask(0o022);
  try {
    // 1. 仓储打开时新建：目录 0700、db 与 sidecar 0600。
    {
      const dir = freshDir("perm-fresh");
      try {
        const dbPath = join(dir, ".knit", ".runtime", "metadata.db");
        const store = new SqliteMetadataStore(dbPath);
        assert.equal(statSync(dirname(dbPath)).mode & 0o777, 0o700, "新建运行目录 0700");
        assert.equal(statSync(dbPath).mode & 0o777, 0o600, "新建数据库 0600");
        if (existsSync(`${dbPath}-wal`)) {
          assert.equal(statSync(`${dbPath}-wal`).mode & 0o777, 0o600, "WAL 0600");
        }
        store.close();
        // 正常重开不受影响。
        const reopen = new SqliteMetadataStore(dbPath);
        reopen.close();
        assert.equal(statSync(dbPath).mode & 0o777, 0o600);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // 2. 既有 0755 目录与 0644 数据库：打开后收紧。
    {
      const dir = freshDir("perm-existing");
      try {
        const runtime = join(dir, ".knit", ".runtime");
        mkdirSync(runtime, { recursive: true, mode: 0o755 });
        const dbPath = join(runtime, "metadata.db");
        writeFileSync(dbPath, "");
        chmodSync(dbPath, 0o644);
        const store = new SqliteMetadataStore(dbPath);
        assert.equal(statSync(runtime).mode & 0o777, 0o700, "既有目录收紧 0700");
        assert.equal(statSync(dbPath).mode & 0o777, 0o600, "既有数据库收紧 0600");
        if (existsSync(`${dbPath}-wal`)) {
          assert.equal(statSync(`${dbPath}-wal`).mode & 0o777, 0o600, "WAL 0600");
        }
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    process.umask(oldUmask);
  }
});

test("文件事实：absent 如实记录，不抛错；链接按目标、文件含模式（任务027）", () => {
  const dir = freshDir("facts");
  try {
    const file = join(dir, "a.txt");
    assert.deepEqual(fileFacts(file), { kind: "absent", mode: null, sha256: null, childCount: null });
    writeFileSync(file, "hello");
    const facts = fileFacts(file);
    assert.equal(facts.kind, "file");
    assert.equal(facts.sha256, sha256Text("hello"));
    assert.equal(facts.childCount, null);
    assert.equal(facts.mode, statSync(file).mode.toString(8));
    const target = join(dir, "real.txt");
    writeFileSync(target, "target\n");
    symlinkSync("real.txt", join(dir, "link.txt"));
    const link = fileFacts(join(dir, "link.txt"));
    assert.equal(link.kind, "link");
    assert.equal(link.mode, "real.txt");
    assert.equal(link.sha256, null);
    const broken = fileFacts(join(dir, "broken.txt"));
    assert.equal(broken.kind, "absent");
    const listed = listFiles(dir);
    assert.equal(Object.keys(listed).length, 3);
    assert.ok(listed["a.txt"]);
    assert.equal(listed["link.txt"].kind, "link");
    assert.equal(listed["link.txt"].mode, "real.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 必然存活的他者身份（pid 1 与其真实启动标识）：核实为 alive／unknown，绝不会被自动回收。 */
function liveForeignIdentity() {
  return { pid: 1, procStartTicks: procStartTicks(1), machineBootId: currentIdentity().machineBootId };
}

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
    const rival = lockManagerFor(root, { identity: liveForeignIdentity() });
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
    const rival = lockManagerFor(root, { identity: liveForeignIdentity() });
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

// 044：每例独立锁根，失败后通过 owner、跨实例互斥及真实句柄释放验收。
async function isolatedLocks(name, run) {
  const root = freshDir(name);
  try {
    await run(root, lockManagerFor(root), lockManagerFor(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const reentryA = { scope: "project", rawKey: "/tmp/reentry-a" };
const reentryB = { scope: "task", rawKey: "/tmp/reentry-b" };
const reentryC = { scope: "session", rawKey: "pi/reentry-c" };
const isBusy = (error) => error.code === "lock_busy";

async function acquireAndRelease(manager, key, action = "same") {
  const lock = await manager.acquire({ keys: [key], action });
  assert.equal(manager.inspect(key).owner?.token, lock.token, "重新获取必须真实写 owner，不能沿用内存残留");
  manager.release(lock);
  assert.equal(manager.inspect(key).exists, false, "真实句柄释放后无残留引用");
}

// 058：成功混合申请必须逐键记住 owner 凭据，引用与心跳均不依赖键顺序。
for (const outerFirst of [false, true]) {
  for (const newFirst of [false, true]) {
    test(`锁058：混合申请 newFirst=${newFirst} outerFirst=${outerFirst}`, async () => {
      await isolatedLocks("locks-mixed-success", async (root, manager, rival) => {
        const outer = await manager.acquire({ keys: [reentryB], action: "same" });
        const keys = newFirst ? [reentryA, reentryB] : [reentryB, reentryA];
        const mixed = await manager.acquire({ keys, action: "same" });
        await manager.heartbeat(mixed);
        await manager.heartbeat(outer);
        await manager.heartbeat(mixed);
        if (outerFirst) manager.release(outer);
        manager.release(mixed);
        assert.equal(manager.inspect(reentryA).exists, false, "本次新键必须释放");
        assert.equal(manager.inspect(reentryB).exists, !outerFirst, "只保留真实外层引用");
        if (!outerFirst) {
          await assert.rejects(() => rival.acquire({ keys: [reentryB], action: "same" }), isBusy);
          manager.release(outer);
        }
        for (const key of [reentryA, reentryB]) {
          await acquireAndRelease(rival, key);
          await acquireAndRelease(manager, key);
        }
      });
    });
  }
}

test("锁058：合并多个独立 owner 并含重复键，心跳与释放覆盖所有引用", async () => {
  await isolatedLocks("locks-multi-owner", async (root, manager, rival) => {
    const a = await manager.acquire({ keys: [reentryA], action: "same" });
    const b = await manager.acquire({ keys: [reentryB], action: "same" });
    assert.notEqual(a.token, b.token);
    const mixed = await manager.acquire({ keys: [reentryC, reentryA, reentryB, reentryA], action: "same" });
    await manager.heartbeat(mixed);
    await manager.heartbeat(a);
    await manager.heartbeat(b);
    manager.release(a);
    manager.release(b);
    manager.release(mixed);
    for (const key of [reentryA, reentryB, reentryC]) {
      assert.equal(manager.inspect(key).exists, false);
      await acquireAndRelease(rival, key);
      await acquireAndRelease(manager, key);
    }
  });
});

test("锁058：混合句柄的错误 token 与替换 owner 均不释放他者占用", async () => {
  await isolatedLocks("locks-mixed-replacement", async (root, manager, rival) => {
    const outer = await manager.acquire({ keys: [reentryB], action: "same" });
    const mixed = await manager.acquire({ keys: [reentryA, reentryB], action: "same" });
    manager.release({ ...mixed, token: "wrong" });
    assert.equal(manager.inspect(reentryA).exists, true);
    assert.equal(manager.inspect(reentryB).exists, true);
    await assert.rejects(() => manager.heartbeat({ ...mixed, token: "wrong" }),
      (error) => error.code === "lock_token_mismatch");
    rmSync(join(outer.ownerPaths[0], ".."), { recursive: true, force: true });
    const replacement = await rival.acquire({ keys: [reentryB], action: "rival" });
    const before = readFileSync(replacement.ownerPaths[0], "utf8");
    await assert.rejects(() => manager.heartbeat(mixed), (error) => error.code === "lock_token_mismatch");
    manager.release(mixed);
    manager.release(outer);
    assert.equal(readFileSync(replacement.ownerPaths[0], "utf8"), before);
    assert.equal(manager.inspect(reentryA).exists, false);
    rival.release(replacement);
  });
});

test("锁044：重入后遇 busy 仅撤销本次引用，外层与 rival owner 不变", async () => {
  await isolatedLocks("locks-reentry-busy", async (root, manager, rival) => {
    const outer = await manager.acquire({ keys: [reentryA], action: "same" });
    const blocked = await rival.acquire({ keys: [reentryB], action: "other" });
    const beforeA = readFileSync(outer.ownerPaths[0], "utf8");
    const beforeB = readFileSync(blocked.ownerPaths[0], "utf8");
    await assert.rejects(() => manager.acquire({ keys: [reentryA, reentryB], action: "same" }), isBusy);
    assert.equal(readFileSync(outer.ownerPaths[0], "utf8"), beforeA);
    assert.equal(readFileSync(blocked.ownerPaths[0], "utf8"), beforeB);
    await assert.rejects(() => rival.acquire({ keys: [reentryA], action: "same" }), isBusy);
    manager.release(outer);
    await acquireAndRelease(rival, reentryA);
    await acquireAndRelease(manager, reentryA);
    rival.release(blocked);
  });
});

test("锁044：排序后 busy 先于重入键，未触达外层不变", async () => {
  await isolatedLocks("locks-reentry-busy-first", async (root, manager, rival) => {
    const outer = await manager.acquire({ keys: [reentryB], action: "same" });
    const blocked = await rival.acquire({ keys: [reentryA], action: "other" });
    const before = readFileSync(outer.ownerPaths[0], "utf8");
    const keys = orderKeys([reentryB, reentryA]);
    assert.deepEqual(keys, [reentryA, reentryB]);
    await assert.rejects(() => manager.acquire({ keys, action: "same" }), isBusy);
    assert.equal(readFileSync(outer.ownerPaths[0], "utf8"), before);
    await assert.rejects(() => rival.acquire({ keys: [reentryB], action: "same" }), isBusy);
    manager.release(outer);
    await acquireAndRelease(rival, reentryB);
    rival.release(blocked);
  });
});

test("锁044：重入后 mkdir 成功、owner 写失败，保留外层且清本次目录", async () => {
  await isolatedLocks("locks-reentry-write-fail", async (root, unused, rival) => {
    const injected = Object.assign(new Error("injected owner write failure"), { code: "EIO" });
    let hits = 0;
    class OwnerWriteFails extends LockManager {
      writeOwner(path, owner) {
        if (owner.rawKey === reentryB.rawKey) {
          hits += 1;
          assert.equal(existsSync(join(path, "..")), true, "注入须在 mkdir 成功后命中");
          throw injected;
        }
        return super.writeOwner(path, owner);
      }
    }
    const manager = new OwnerWriteFails({ root });
    const outer = await manager.acquire({ keys: [reentryA], action: "same" });
    const before = readFileSync(outer.ownerPaths[0], "utf8");
    await assert.rejects(() => manager.acquire({ keys: [reentryA, reentryB], action: "same" }), (error) => error === injected);
    assert.equal(hits, 1, "真实命中 owner 写失败且原错误透传");
    assert.equal(manager.inspect(reentryB).exists, false);
    assert.equal(readFileSync(outer.ownerPaths[0], "utf8"), before);
    await assert.rejects(() => rival.acquire({ keys: [reentryA], action: "same" }), isBusy);
    manager.release(outer);
    await acquireAndRelease(rival, reentryA);
    await acquireAndRelease(manager, reentryA);
    await acquireAndRelease(rival, reentryB);
  });
});

test("锁044：新建键后遇 busy，同实例与 rival 可重新获取释放", async () => {
  await isolatedLocks("locks-created-busy", async (root, manager, rival) => {
    const blocked = await rival.acquire({ keys: [reentryB], action: "other" });
    await assert.rejects(() => manager.acquire({ keys: [reentryA, reentryB], action: "same" }), isBusy);
    assert.equal(manager.inspect(reentryA).exists, false);
    assert.equal(manager.inspect(reentryB).owner?.token, blocked.token);
    await acquireAndRelease(manager, reentryA);
    await acquireAndRelease(rival, reentryA);
    rival.release(blocked);
  });
});

test("锁044：新建与多次重入逆序撤销，不泄漏真实外层引用", async () => {
  await isolatedLocks("locks-reentry-layers", async (root, manager, rival) => {
    const outer = await manager.acquire({ keys: [reentryA], action: "same" });
    const middle = await manager.acquire({ keys: [reentryA], action: "same" });
    const inner = await manager.acquire({ keys: [reentryA], action: "same" });
    const blocked = await rival.acquire({ keys: [reentryC], action: "other" });
    await assert.rejects(() => manager.acquire({ keys: [reentryA, reentryB, reentryA, reentryC], action: "same" }), isBusy);
    assert.equal(manager.inspect(reentryA).owner?.token, outer.token);
    assert.equal(manager.inspect(reentryB).exists, false);
    await acquireAndRelease(manager, reentryB);
    for (const lock of [inner, middle]) {
      manager.release(lock);
      await assert.rejects(() => rival.acquire({ keys: [reentryA], action: "same" }), isBusy);
    }
    manager.release(outer);
    await acquireAndRelease(rival, reentryA);
    await acquireAndRelease(manager, reentryA);
    rival.release(blocked);
  });
});

test("锁044：正常重入与混合新建成功后逐层释放，不同动作仍 busy", async () => {
  await isolatedLocks("locks-reentry-success", async (root, manager, rival) => {
    const outer = await manager.acquire({ keys: [reentryA], action: "same" });
    const mixed = await manager.acquire({ keys: [reentryA, reentryB], action: "same" });
    assert.equal(mixed.token, outer.token);
    assert.equal(manager.inspect(reentryB).owner?.token, mixed.token);
    await assert.rejects(() => manager.acquire({ keys: [reentryA], action: "different" }), isBusy);
    await assert.rejects(() => rival.acquire({ keys: [reentryA], action: "same" }), isBusy);
    manager.release(mixed);
    assert.equal(manager.inspect(reentryB).exists, false);
    assert.equal(manager.inspect(reentryA).owner?.token, outer.token);
    manager.release(outer);
    await acquireAndRelease(rival, reentryA);
    await acquireAndRelease(manager, reentryB);
  });
});

test("锁044：release 不删除已被其它 token 替换的 owner", async () => {
  await isolatedLocks("locks-release-replaced", async (root, manager, rival) => {
    const outer = await manager.acquire({ keys: [reentryA], action: "same" });
    rmSync(join(outer.ownerPaths[0], ".."), { recursive: true, force: true });
    const replacement = await rival.acquire({ keys: [reentryA], action: "other" });
    const before = readFileSync(replacement.ownerPaths[0], "utf8");
    manager.release(outer);
    assert.equal(readFileSync(replacement.ownerPaths[0], "utf8"), before);
    rival.release(replacement);
    await acquireAndRelease(manager, reentryA);
  });
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
    const rival = lockManagerFor(root, { identity: liveForeignIdentity() });
    await assert.rejects(
      () => rival.acquire({ keys: [{ scope: "project", rawKey: "/tmp/project-b" }, sessionKey], action: "project-b" }),
      (error) => error.code === "lock_busy",
    );
    void hashKey;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁：owner 写入失败回滚不留残留；unlock --force 可清除无 owner 残留", async () => {
  const root = freshDir("locks-residue");
  try {
    const key = { scope: "project", rawKey: "/tmp/residue" };

    // 注入 owner.json 写入失败：acquire 失败且回滚不残留
    class OwnerWriteFails extends LockManager {
      writeOwner() {
        throw new InfrastructureError("io_error", "injected owner write failure");
      }
    }
    const failing = new OwnerWriteFails({ root, now: () => new Date() });
    await assert.rejects(
      () => failing.acquire({ keys: [key], action: "crash" }),
      (error) => error.code === "io_error",
    );
    assert.equal(existsSync(join(root, "projects", hashKey(key.rawKey))), false, "回滚不留无 owner 残留");

    // 回滚后下一次 acquire 可成功
    const manager = lockManagerFor(root);
    const acquired = await manager.acquire({ keys: [key], action: "normal" });
    assert.equal(manager.inspect(key).owner.token, acquired.token);
    manager.release(acquired);

    // 模拟进程在 mkdir 后、owner 写入前死亡：目录在而 owner 缺失
    mkdirSync(join(root, "projects", hashKey(key.rawKey)), { recursive: true, mode: 0o700 });
    await assert.rejects(
      () => manager.acquire({ keys: [key], action: "blocked" }),
      (error) => error.code === "lock_busy",
    );
    await assert.rejects(
      async () => manager.unlock({ key, expectToken: "any" }),
      (error) => error.code === "lock_owner_unknown",
    );
    const removed = manager.unlock({ key, expectToken: "any", force: true });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(join(root, "projects", hashKey(key.rawKey))), false);

    // 清除后可重新占用并正常释放
    const again = await manager.acquire({ keys: [key], action: "after" });
    assert.equal(manager.inspect(key).owner.token, again.token);
    manager.release(again);
    assert.equal(manager.inspect(key).exists, false);
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

test("进程：procStartTicks 是当前进程的稳定启动身份", () => {
  const ticks = procStartTicks(process.pid);
  assert.ok(typeof ticks === "string" && ticks.length > 0, `unexpected: ${ticks}`);
  assert.equal(procStartTicks(process.pid), ticks, "同一进程多次读取身份一致");
  if (process.platform === "linux") assert.match(ticks, /^\d+$/);
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
  assert.equal(isProcessAlive(sleeper.pid), false, "子进程组已终止");
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
  const root = await port.spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    process.on("SIGTERM", () => {});
    child.once("exit", () => process.exit(0));
    console.log(child.pid);
  `], { cwd: tmpdir() });
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
    assert.equal(isProcessAlive(root.pid), false);
    assert.equal(isProcessAlive(childPid), false, "工具自建进程组也必须清理");
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

// k-6f0616f3779d：崩溃锁自动回收、心跳观察与 lock-id 解除。
async function killedHolder(root, keys) {
  const locksModule = join(import.meta.dirname, "..", "dist", "infrastructure", "locks.js");
  const script = join(root, "killed-holder.mjs");
  writeFileSync(
    script,
    `import { LockManager } from ${JSON.stringify(locksModule)};\n` +
      `const m = new LockManager({ root: process.argv[2] });\n` +
      `await m.acquire({ keys: JSON.parse(process.argv[3]), action: "crashed.worker" });\n` +
      `console.log("HELD");\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const holder = spawn(process.execPath, [script, join(root, "locks"), JSON.stringify(keys)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    let output = "";
    holder.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("HELD")) resolve();
    });
    holder.once("exit", (code) => reject(new Error(`holder exited early: ${code}`)));
  });
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  holder.kill("SIGKILL");
  await exited;
  return holder.pid;
}

test("锁回收：SIGKILL 后同启动周期 not_alive 的 project/session 锁由下次 acquire 原子回收并留记录", async () => {
  const root = freshDir("locks-reclaim");
  try {
    const project = { scope: "project", rawKey: "/tmp/reclaim-project" };
    const session = { scope: "session", rawKey: "pi:reclaim-session" };
    const deadPid = await killedHolder(root, [project, session]);
    const manager = new LockManager({ root: join(root, "locks") });
    const before = manager.inspect(project);
    assert.equal(before.processVerdict, "not_alive");
    assert.equal(manager.reclaimable(before), true);
    const acquired = await manager.acquire({ keys: [project, session], action: "next" });
    assert.equal(acquired.reclaimed?.length, 2, "两把残留锁均被回收");
    assert.deepEqual(acquired.reclaimed.map((record) => record.scope), ["project", "session"]);
    for (const record of acquired.reclaimed) {
      assert.equal(record.reason, "owner_not_alive");
      assert.equal(record.previousOwner.pid, deadPid);
      assert.equal(record.previousOwner.action, "crashed.worker");
      assert.equal(record.reclaimedBy.action, "next");
      assert.ok(existsSync(join(root, "locks", "reclaimed", record.archive, "reclaim.json")), "回收区保存记录");
      assert.ok(existsSync(join(root, "locks", "reclaimed", record.archive, "owner.json")), "原 owner 随目录改名保留");
      assert.equal(existsSync(join(root, "locks", "reclaimed", record.archive, ".reclaiming")), false, "回收守卫已清理");
    }
    assert.equal(manager.inspect(project).owner.token, acquired.token, "重建后由新 owner 持有");
    const listed = manager.listReclaimed();
    assert.equal(listed.length, 2);
    assert.ok(listed.every((record) => record.previousOwner.pid === deadPid));
    manager.release(acquired);
    assert.equal(manager.inspect(project).exists, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁回收：owner 存活、跨启动周期 unknown、owner 缺失与附属进程存活时均不回收", async () => {
  const root = freshDir("locks-no-reclaim");
  try {
    const key = { scope: "project", rawKey: "/tmp/no-reclaim" };
    const holder = lockManagerFor(root);
    const held = await holder.acquire({ keys: [key], action: "alive" });
    const rival = lockManagerFor(root, { identity: liveForeignIdentity() });
    await assert.rejects(() => rival.acquire({ keys: [key], action: "rival" }), (error) => {
      assert.equal(error.code, "lock_busy");
      assert.equal(error.details.processVerdict, "alive");
      assert.equal(error.details.ownerAction, "alive");
      assert.equal(error.details.ownerPid, process.pid);
      assert.match(error.message, /action=alive pid=\d+ 进程核实=alive/);
      assert.ok(error.details.nextActions.length > 0);
      return true;
    });
    holder.release(held);

    const ownerPath = join(root, "projects", hashKey(key.rawKey), "owner.json");
    const deadOwner = (extra) => {
      mkdirSync(dirname(ownerPath), { recursive: true });
      writeFileSync(ownerPath, JSON.stringify({
        protocol: 1, token: "dead1", action: "crashed", scope: "project", rawKey: key.rawKey,
        machineBootId: currentIdentity().machineBootId, pid: 2 ** 22 + 12345, procStartTicks: "1",
        startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), ...extra,
      }));
    };
    // 跨启动周期：unknown，不回收
    deadOwner({ machineBootId: "other-boot" });
    await assert.rejects(() => rival.acquire({ keys: [key], action: "rival" }), (error) => {
      assert.equal(error.details.processVerdict, "unknown");
      assert.match(error.details.nextActions.join(" "), /knit unlock project\/[0-9a-f]{32} --expect-token dead1 --force/);
      return true;
    });
    // 附属进程（阶段 Pi）仍存活：not_alive 但不回收
    deadOwner({ attached: [{ pid: process.pid, procStartTicks: procStartTicks(process.pid) }] });
    await assert.rejects(() => rival.acquire({ keys: [key], action: "rival" }), (error) => {
      assert.equal(error.details.processVerdict, "not_alive");
      assert.equal(error.details.attachedAlive, true);
      return true;
    });
    // owner 缺失：unknown 残留，不回收
    rmSync(ownerPath);
    await assert.rejects(() => rival.acquire({ keys: [key], action: "rival" }), (error) => error.details.processVerdict === "unknown");
    assert.equal(rival.listReclaimed().length, 0, "上述情形均未回收");
    // 附属进程也已死：回收
    deadOwner({ attached: [{ pid: 2 ** 22 + 12346, procStartTicks: "2" }] });
    const acquired = await rival.acquire({ keys: [key], action: "rival" });
    assert.equal(acquired.reclaimed?.[0]?.previousOwner.token, "dead1");
    rival.release(acquired);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁回收：另一回收者守卫进行中时 busy，守卫超时后清除重试", async () => {
  const root = freshDir("locks-reclaim-guard");
  try {
    const key = { scope: "project", rawKey: "/tmp/reclaim-guard" };
    const dir = join(root, "projects", hashKey(key.rawKey));
    mkdirSync(join(dir, ".reclaiming"), { recursive: true });
    writeFileSync(join(dir, "owner.json"), JSON.stringify({
      protocol: 1, token: "t", action: "crashed", scope: "project", rawKey: key.rawKey,
      machineBootId: currentIdentity().machineBootId, pid: 2 ** 22 + 12347, procStartTicks: "1",
      startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    }));
    const now = lockManagerFor(root);
    await assert.rejects(() => now.acquire({ keys: [key], action: "a" }), (error) => error.code === "lock_busy");
    const later = lockManagerFor(root, { now: () => new Date(Date.now() + 120_000) });
    const acquired = await later.acquire({ keys: [key], action: "b" });
    assert.equal(acquired.reclaimed?.length, 1);
    later.release(acquired);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁心跳：heartbeat 推进 heartbeatAt，heartbeatState 区分正常与超时；attachProcess 登记附属进程", async () => {
  const root = freshDir("locks-heartbeat");
  try {
    let clock = Date.parse("2026-11-07T00:00:00.000Z");
    const manager = lockManagerFor(root, { now: () => new Date(clock) });
    const key = { scope: "project", rawKey: "/tmp/heartbeat" };
    const lock = await manager.acquire({ keys: [key], action: "beat" });
    const first = manager.inspect(key).owner;
    assert.equal(heartbeatState(first, clock + 1_000, 30_000), "fresh");
    assert.equal(heartbeatState(first, clock + 31_000, 30_000), "stale");
    assert.equal(heartbeatState(null, clock, 30_000), "unknown");
    clock += 10_000;
    await manager.heartbeat(lock);
    const second = manager.inspect(key).owner;
    assert.equal(second.heartbeatAt, new Date(clock).toISOString(), "心跳前进");
    assert.equal(second.startedAt, first.startedAt);
    manager.attachProcess(lock, process.pid);
    assert.deepEqual(manager.inspect(key).owner.attached, [{ pid: process.pid, procStartTicks: procStartTicks(process.pid) }]);
    await manager.heartbeat(lock);
    assert.equal(manager.inspect(key).owner.attached.length, 1, "心跳保留附属进程登记");
    manager.attachProcess(lock, null);
    assert.deepEqual(manager.inspect(key).owner.attached, []);
    manager.release(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁 unlockById：按 scope/hash 解除，仍要求 token；非法 ID 拒绝", async () => {
  const root = freshDir("locks-unlock-id");
  try {
    const manager = lockManagerFor(root);
    const key = { scope: "task", rawKey: "/tmp/p::k-1" };
    const lock = await manager.acquire({ keys: [key], action: "hold" });
    const id = `task/${hashKey(key.rawKey)}`;
    assert.deepEqual(parseLockId(id), { scope: "task", hash: hashKey(key.rawKey) });
    assert.equal(parseLockId("task/xyz"), null);
    assert.equal(parseLockId("bogus/" + hashKey("a")), null);
    assert.throws(() => manager.unlockById({ id, expectToken: "wrong", force: true }), (error) => error.code === "lock_token_mismatch");
    assert.throws(() => manager.unlockById({ id, expectToken: lock.token }), (error) => error.code === "lock_busy");
    const removed = manager.unlockById({ id, expectToken: lock.token, force: true });
    assert.equal(removed.removed, true);
    assert.equal(removed.key, key.rawKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("state 锁：orderKeys 只在末尾追加、已有顺序不变；列表与 lock-id 可见", async () => {
  const root = mkdtempSync(join(tmpdir(), "knit-state-lock-"));
  try {
    const keys = [
      { scope: "state", rawKey: "/tmp/main" },
      { scope: "session", rawKey: "pi:1" },
      { scope: "task", rawKey: "/tmp/main::k-1" },
      { scope: "project", rawKey: "/tmp/main" },
    ];
    assert.deepEqual(orderKeys(keys).map((key) => key.scope), ["project", "task", "session", "state"]);
    const manager = new LockManager({ root });
    const lock = await manager.acquire({ keys: [keys[0]], action: "task.new" });
    const entry = manager.list().find((item) => item.scope === "state");
    assert.equal(entry.key, "/tmp/main");
    assert.deepEqual(parseLockId(entry.id), { scope: "state", hash: entry.hash });
    assert.ok(existsSync(join(root, "states", entry.hash, "owner.json")));
    manager.release(lock);
    assert.equal(manager.list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireShort：短等待内持有者释放即取得；超时仍 lock_busy，不超过等待上限太多", async () => {
  const root = mkdtempSync(join(tmpdir(), "knit-short-lock-"));
  try {
    const key = { scope: "state", rawKey: "/tmp/short" };
    const holder = new LockManager({ root });
    const rival = new LockManager({ root });
    assert.equal(STATE_LOCK_WAIT_MS <= 1000, true, "state 短等待不超过 1 秒");
    const held = await holder.acquire({ keys: [key], action: "holder" });
    const startedAt = Date.now();
    await assert.rejects(() => rival.acquireShort({ keys: [key], action: "rival" }, 80), (error) => error.code === "lock_busy");
    assert.ok(Date.now() - startedAt < 1000, "超时后立即报告");
    setTimeout(() => holder.release(held), 40);
    const acquired = await rival.acquireShort({ keys: [key], action: "rival" }, 1000);
    rival.release(acquired);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state 残留锁与其它范围一样按进程核实自动回收", async () => {
  const root = mkdtempSync(join(tmpdir(), "knit-state-reclaim-"));
  try {
    const key = { scope: "state", rawKey: "/tmp/reclaim-state" };
    const script = join(root, "child.mjs");
    const modulePath = new URL("../dist/infrastructure/locks.js", import.meta.url).href;
    writeFileSync(script, `import { LockManager } from ${JSON.stringify(modulePath)};\nawait new LockManager({ root: ${JSON.stringify(root)} }).acquire({ keys: [${JSON.stringify(key)}], action: "crashed" });\nprocess.exit(0);\n`);
    execFileSync(process.execPath, [script]);
    const manager = new LockManager({ root });
    assert.equal(manager.inspect(key).processVerdict, "not_alive");
    const lock = await manager.acquire({ keys: [key], action: "task.new" });
    assert.equal(lock.reclaimed?.[0]?.scope, "state");
    assert.equal(lock.reclaimed?.[0]?.previousOwner.action, "crashed");
    manager.release(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
