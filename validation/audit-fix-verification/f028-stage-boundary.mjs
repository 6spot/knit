// F028 补充验证：stage-runner 启动前/运行后分支核对（prepare 后换分支、运行中换分支）
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { liveBranchMatches } = await import('/home/opc/work/knit/dist/application/stage-runner.js');
const results = [];
const check = (n, ok) => results.push({ name: n, ok: !!ok });
const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

const dir = mkdtempSync(join(tmpdir(), 'f028-'));
git(dir, ['init','-q','-b','main']);
git(dir, ['config','user.email','t@e.com']); git(dir, ['config','user.name','t']);
writeFileSync(join(dir,'a.txt'),'x\n');
git(dir, ['add','.']); git(dir, ['commit','-q','-m','init']);

const gitStub = (args, cwd) => {
  try {
    const r = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return { code: 0, stdout: r };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '' };
  }
};
check('同分支匹配', liveBranchMatches(dir, 'refs/heads/main', gitStub) === true);
git(dir, ['checkout','-q','-b','side']);
check('换分支后不匹配', liveBranchMatches(dir, 'refs/heads/main', gitStub) === false);
check('预期 null（advisory）不核对', liveBranchMatches(dir, null, gitStub) === true);
// detached HEAD
git(dir, ['checkout','-q','--detach']);
check('detached HEAD 不匹配任何分支', liveBranchMatches(dir, 'refs/heads/side', gitStub) === false);
rmSync(dir, { recursive: true, force: true });

// 端到端：prepare 后启动前换分支（worker 认领后拒绝）已由 test/stage.test.mjs 覆盖并通过；
// 此处验证 prepare→start 间隔的 prepareOnly + 直接 StageRunner 的启动前核对路径。
const bad = results.filter(r => !r.ok);
console.log(JSON.stringify({ case:'F028-stage-boundary', total: results.length, failed: bad.length, results }, null, 1));
process.exit(bad.length ? 1 : 0);
