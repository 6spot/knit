// 044：失败 acquire 后外层保护、真实释放次数与替换 token 的后果验证。
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { LockManager } from '../../dist/infrastructure/locks.js';
const root = mkdtempSync(join(tmpdir(), 'lock044-consequence-'));
const results = [];
const check = (name, ok) => results.push({ name, ok: !!ok });
const keyA = { scope: 'project', rawKey: '/proj-a' };
const keyB = { scope: 'task', rawKey: '/proj-a::k-1' };
try {
  const manager = new LockManager({ root });
  const rival = new LockManager({ root });
  const outer = await manager.acquire({ keys: [keyA], action: 'same' });
  const blocked = await rival.acquire({ keys: [keyB], action: 'other' });
  let failure;
  try { await manager.acquire({ keys: [keyA, keyB], action: 'same' }); } catch (error) { failure = error; }
  check('混合请求真实遇 busy', failure?.code === 'lock_busy');
  rival.release(blocked);
  let unexpectedRival;
  let rivalError;
  try { unexpectedRival = await rival.acquire({ keys: [keyA], action: 'other' }); } catch (error) { rivalError = error; }
  check('失败后外层锁保护保留', rivalError?.code === 'lock_busy');
  // 修复前可抓到保护丢失；继续独立核实 release，不把旧的风险当成已证实结果。
  if (unexpectedRival) {
    const before = readFileSync(unexpectedRival.ownerPaths[0], 'utf8');
    manager.release(outer);
    check('旧外层 release 保留 rival owner', readFileSync(unexpectedRival.ownerPaths[0], 'utf8') === before);
    rival.release(unexpectedRival);
  } else {
    const inner = await manager.acquire({ keys: [keyA], action: 'same' });
    check('真实内层重入沿用 token', inner.token === outer.token);
    manager.release(inner);
    check('释放内层后外层 owner 保留', manager.inspect(keyA).owner?.token === outer.token);
    manager.release(outer);
    check('真实外层释放后目录消失', !manager.inspect(keyA).exists);
  }
  const replacement = await rival.acquire({ keys: [keyA], action: 'other' });
  check('外层释放后 rival 有真实 owner', rival.inspect(keyA).owner?.token === replacement.token);
  rival.release(replacement);
  const fresh = await manager.acquire({ keys: [keyA], action: 'same' });
  check('原实例可正常重新获取', manager.inspect(keyA).owner?.token === fresh.token);
  // 另行制造 owner token 变更，验证旧句柄不会删除新 owner；不宣称历史误删。
  rmSync(dirname(fresh.ownerPaths[0]), { recursive: true, force: true });
  const changed = await rival.acquire({ keys: [keyA], action: 'other' });
  const changedBefore = readFileSync(changed.ownerPaths[0], 'utf8');
  manager.release(fresh);
  check('release 不删除已变更 token 的 owner', readFileSync(changed.ownerPaths[0], 'utf8') === changedBefore);
  rival.release(changed);
} catch (error) {
  results.push({ name: 'unexpected error', ok: false, error: String(error) });
} finally {
  rmSync(root, { recursive: true, force: true });
}
const bad = results.filter(result => !result.ok);
console.log(JSON.stringify({ case: '044-lock-reentry-consequence', total: results.length, failed: bad.length, results }, null, 1));
process.exitCode = bad.length ? 1 : 0;
