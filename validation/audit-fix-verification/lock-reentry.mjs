// 044：每个场景独立锁根；所有 acquire 都 await，release 均使用实际句柄。
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { LockManager, orderKeys } from '../../dist/infrastructure/locks.js';
const results = [];
const check = (name, ok) => results.push({ name, ok: !!ok });
const keyA = { scope: 'project', rawKey: '/proj-a' };
const keyB = { scope: 'task', rawKey: '/proj-a::k-1' };
const keyC = { scope: 'session', rawKey: 'pi/reentry' };
const codeOf = async (manager, keys, action = 'same') => {
  try {
    const acquired = await manager.acquire({ keys, action });
    manager.release(acquired);
    return null;
  } catch (error) { return error.code ?? error.message; }
};
async function scenario(name, run) {
  const root = mkdtempSync(join(tmpdir(), 'lock044-'));
  try { await run(root, new LockManager({ root }), new LockManager({ root })); }
  catch (error) { results.push({ name: `${name}: unexpected error`, ok: false, error: String(error) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
async function cycle(manager, key, label) {
  const acquired = await manager.acquire({ keys: [key], action: 'same' });
  check(`${label}: 真实 owner`, manager.inspect(key).owner?.token === acquired.token);
  manager.release(acquired);
  check(`${label}: 释放无残留`, !manager.inspect(key).exists);
}

await scenario('正常重入和混合成功', async (root, manager, rival) => {
  const first = await manager.acquire({ keys: [keyA], action: 'same' });
  const again = await manager.acquire({ keys: [keyA, keyB], action: 'same' });
  check('重入返回同一 token', again.token === first.token);
  check('重入 owner 版本一致', again.ownerVersions[0] === first.ownerVersions[0]);
  check('新键与返回 token 一致', manager.inspect(keyB).owner?.token === again.token);
  check('同键不同动作 busy', await codeOf(manager, [keyA], 'other') === 'lock_busy');
  check('跨实例仍互斥', await codeOf(rival, [keyA]) === 'lock_busy');
  manager.release(again);
  check('内层释放后 owner 未变', manager.inspect(keyA).owner?.token === first.token);
  check('混合新键已释放', !manager.inspect(keyB).exists);
  manager.release(first);
  check('全部释放后 owner 为 null', manager.inspect(keyA).owner === null);
});

await scenario('重入后新键 busy', async (root, manager, rival) => {
  const outer = await manager.acquire({ keys: [keyA], action: 'same' });
  const blocked = await rival.acquire({ keys: [keyB], action: 'other' });
  const before = readFileSync(outer.ownerPaths[0], 'utf8');
  const rivalBefore = readFileSync(blocked.ownerPaths[0], 'utf8');
  check('混合请求因新键 busy 失败', await codeOf(manager, [keyA, keyB]) === 'lock_busy');
  check('外层 owner/token 不变', manager.inspect(keyA).owner?.token === outer.token && existsSync(outer.ownerPaths[0]) && readFileSync(outer.ownerPaths[0], 'utf8') === before);
  check('他者 owner 不变', readFileSync(blocked.ownerPaths[0], 'utf8') === rivalBefore);
  check('失败后 rival 仍 busy', await codeOf(rival, [keyA]) === 'lock_busy');
  manager.release(outer);
  await cycle(rival, keyA, '释放外层后 rival');
  await cycle(manager, keyA, '原实例重新获取');
  rival.release(blocked);
});

await scenario('busy 排在重入之前', async (root, manager, rival) => {
  const outer = await manager.acquire({ keys: [keyB], action: 'same' });
  const blocked = await rival.acquire({ keys: [keyA], action: 'other' });
  const keys = orderKeys([keyB, keyA]);
  check('实际排序先 busy 键', keys[0] === keyA);
  check('首键失败为 busy', await codeOf(manager, keys) === 'lock_busy');
  check('尚未触达外层不变', manager.inspect(keyB).owner?.token === outer.token);
  manager.release(outer);
  await cycle(rival, keyB, '未触达外层释放后');
  rival.release(blocked);
});

await scenario('mkdir 后 owner 写失败', async (root, unused, rival) => {
  let hits = 0;
  let directoryExisted = false;
  const injected = Object.assign(new Error('injected owner write failure'), { code: 'EIO' });
  class OwnerWriteFails extends LockManager {
    writeOwner(path, owner) {
      if (owner.rawKey === keyB.rawKey) {
        hits += 1;
        directoryExisted = existsSync(dirname(path));
        throw injected;
      }
      return super.writeOwner(path, owner);
    }
  }
  const manager = new OwnerWriteFails({ root });
  const outer = await manager.acquire({ keys: [keyA], action: 'same' });
  let caught;
  try { await manager.acquire({ keys: [keyA, keyB], action: 'same' }); } catch (error) { caught = error; }
  check('故障在 mkdir 后真实命中一次', hits === 1 && directoryExisted);
  check('保留原 owner 写失败错误对象', caught === injected);
  check('本次无 owner 目录已清理', !manager.inspect(keyB).exists);
  check('owner 写失败保留外层 token', manager.inspect(keyA).owner?.token === outer.token);
  check('owner 写失败后 rival 仍 busy', await codeOf(rival, [keyA]) === 'lock_busy');
  manager.release(outer);
  await cycle(rival, keyA, '写失败后外层释放');
  await cycle(manager, keyA, '写失败后原实例');
  await cycle(rival, keyB, '写失败键重新获取');
});

await scenario('多层重入及本次新建后失败', async (root, manager, rival) => {
  const outer = await manager.acquire({ keys: [keyA], action: 'same' });
  const inner = await manager.acquire({ keys: [keyA], action: 'same' });
  const blocked = await rival.acquire({ keys: [keyC], action: 'other' });
  check('多次重入混合失败为 busy', await codeOf(manager, [keyA, keyB, keyA, keyC]) === 'lock_busy');
  check('多层外层 owner 保留', manager.inspect(keyA).owner?.token === outer.token);
  check('本次新建目录清理', !manager.inspect(keyB).exists);
  await cycle(manager, keyB, '新建键内存回滚');
  await cycle(rival, keyB, '新建键跨实例再用');
  manager.release(inner);
  check('释放内层后 rival 仍 busy', await codeOf(rival, [keyA]) === 'lock_busy');
  manager.release(outer);
  await cycle(rival, keyA, '所有真实外层释放');
  await cycle(manager, keyA, '多层后原实例');
  rival.release(blocked);
});

await scenario('release 保留替换 token', async (root, manager, rival) => {
  const outer = await manager.acquire({ keys: [keyA], action: 'same' });
  rmSync(dirname(outer.ownerPaths[0]), { recursive: true, force: true });
  const replacement = await rival.acquire({ keys: [keyA], action: 'other' });
  const before = readFileSync(replacement.ownerPaths[0], 'utf8');
  manager.release(outer);
  check('release 保留其它 token 的 owner', readFileSync(replacement.ownerPaths[0], 'utf8') === before);
  rival.release(replacement);
  await cycle(manager, keyA, '替换 token 后原实例');
});

const bad = results.filter(result => !result.ok);
console.log(JSON.stringify({ case: '044-lock-reentry', total: results.length, failed: bad.length, results }, null, 1));
process.exitCode = bad.length ? 1 : 0;
