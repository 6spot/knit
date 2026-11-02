// 029 真实重入路径验证：run.accept.stage 在 acceptStageLocked→applyJournalLocked 间重入
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'acc043-'));
const { LockManager } = await import('/home/opc/work/knit/dist/infrastructure/locks.js');
const m = new LockManager({ root });
const key = { scope:'task', rawKey:'/p::k-1' };
// 模拟 acceptStageLocked 持锁
const outer = await m.acquire({ keys:[key], action:'run.accept.stage' });
// 模拟 applyJournalLocked 内重入
let innerErr = null, inner = null;
try { inner = await m.acquire({ keys:[key], action:'run.accept.stage' }); } catch (e) { innerErr = e.code; }
console.log(JSON.stringify({ case:'accept-stage-reentry', reentryOk: inner !== null && inner.token === outer.token, innerErr }));
// 内层释放后外层仍持锁；外层释放后目录清理
m.release(inner);
const stillHeld = m.inspect(key).owner?.token === outer.token;
m.release(outer);
const cleaned = m.inspect(key).owner === null;
console.log(JSON.stringify({ stillHeldAfterInnerRelease: stillHeld, cleanedAfterOuterRelease: cleaned }));
rmSync(root,{recursive:true,force:true});
