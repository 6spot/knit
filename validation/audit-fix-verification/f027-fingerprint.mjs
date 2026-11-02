// F027 业务级验证：scope 指纹按当前事实采样，类型/模式/内容变化都能检出
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = join(tmpdir(), 'f027-' + process.pid + '-' + Date.now());
mkdirSync(root);
const { mergeScope, emptyScope, scopeEntriesCurrent, currentEntry } = await import('/home/opc/work/knit/dist/application/scope.js');
const results = [];
function check(name, cond) { results.push({ name, ok: !!cond }); }

// 1) mergeScope 采样带 factsKind 与 mode
let scope = emptyScope('k-test', '2026-11-02T00:00:00Z');
writeFileSync(join(root, 'a.txt'), 'hello');
scope = mergeScope(scope, { runId: 'run-1', taskId: 'k-test', paths: ['a.txt'], root, now: '2026-11-02T00:00:01Z' });
const entry = scope.entries[0];
check('mergeScope 采样带 factsKind=file', entry.factsKind === 'file');
check('mergeScope 采样带 mode', typeof entry.mode === 'string' && entry.mode.startsWith('1'));

// 2) 外部编辑后 scopeEntriesCurrent 为 false（原审计复现条件：外部编辑后旧 pass 仍通过）
writeFileSync(join(root, 'a.txt'), 'HELLO-EDITED');
check('外部编辑后检测到漂移', scopeEntriesCurrent(root, scope.entries) === false);
writeFileSync(join(root, 'a.txt'), 'hello');
check('还原字节后恢复一致', scopeEntriesCurrent(root, scope.entries) === true);

// 3) chmod 0644→0755 后检测到漂移（原审计复现条件）
chmodSync(join(root, 'a.txt'), 0o755);
check('chmod 后检测到模式漂移', scopeEntriesCurrent(root, scope.entries) === false);
chmodSync(join(root, 'a.txt'), 0o644);
check('还原模式后恢复一致', scopeEntriesCurrent(root, scope.entries) === true);

// 4) 文件→符号链接类型漂移
symlinkSync('/etc/hostname', join(root, 'b.txt'));
writeFileSync(join(root, 'a.txt'), 'hello');
scope = mergeScope(scope, { runId: 'run-2', taskId: 'k-test', paths: ['b.txt'], root, now: '2026-11-02T00:00:02Z' });
check('符号链接条目 kind=link 且 digest 为目标字符串', scope.entries[1].factsKind === 'link' && scope.entries[1].digest === '/etc/hostname');
rmSync(join(root,"b.txt"));symlinkSync("/etc/os-release",join(root,"b.txt"));
check('符号链接目标变化检测到漂移', scopeEntriesCurrent(root, scope.entries) === false);

// 5) 旧记录（无 factsKind）仅核内容，不追溯失效
const legacy = { path: 'a.txt', digest: scope.entries[0].digest, absent: false };
check('旧条目内容一致时仍通过', scopeEntriesCurrent(root, [legacy]) === true);
chmodSync(join(root, 'a.txt'), 0o600);
check('旧条目 chmod 不追溯失效（兼容语义）', scopeEntriesCurrent(root, [legacy]) === true);

// 6) currentEntry 缺失路径记 absent，删除后漂移
rmSync(join(root, 'b.txt'));
check('路径删除检测到漂移', scopeEntriesCurrent(root, scope.entries) === false);

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ case: 'F027-fingerprint', total: results.length, failed: failed.length, results }, null, 1));
rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
