import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = resolve(process.argv[2]);
const workspace = mkdtempSync(join(tmpdir(), 'knit-audit-stage-'));
try {
  mkdirSync(join(workspace, 'test'));
  symlinkSync(join(root, 'dist'), join(workspace, 'dist'), 'dir');
  symlinkSync(join(root, 'assets'), join(workspace, 'assets'), 'dir');
  symlinkSync(join(root, 'test', 'fixtures'), join(workspace, 'test', 'fixtures'), 'dir');
  const source = readFileSync(join(root, 'test', 'stage.test.mjs'), 'utf8');
  const prefix = source.slice(0, source.indexOf('test("implement→check'));
  if (!prefix.includes('async function startRun')) throw new Error('audit fixture helper marker missing');
  const tests = `
test('AUDIT branch mismatch and checkpoint branch facts', async () => {
 const dir = project('audit-branch'); const s = services(dir);
 try {
  const task = await s.tasks.newTask({dir,title:'branch audit',slug:'branch-audit',branch:'main'});
  await s.tasks.ready({dir,taskId:task.taskId});
  git(dir, ['switch', '-q', '-c', 'unrelated']);
  let output;
  try {
   const run = await startRun(s, dir, task.taskId, 'implement', {report:{summary:'audit branch'}});
   await waitTerminal(s, dir, run.runId);
   const stored = parseTaskDocument(readFileSync(join(dir,'.knit',task.relativePath),'utf8'));
   output = {started:true,taskBranch:stored.frontmatter.branch,head:git(dir,['branch','--show-current']).trim()};
  } catch (error) { output={started:false,reason:error.guardReason ?? error.message}; }
  console.log('AUDIT_RESULT',JSON.stringify({case:'task-run-branch',...output}));
 } finally {s.store.close();rmSync(dir,{recursive:true,force:true});}
});
test('AUDIT pending input while worker owns lock', async () => {
 const dir = project('audit-pending'); const s = services(dir);
 try {
  const task=await readyTask(dir,s);
  const run=await startRun(s,dir,task.taskId,'implement',{delayMs:700,report:{summary:'audit active'}});
  let output;
  try {const r=await s.tasks.update({dir,taskId:task.taskId,kind:'clarify',reason:'audit active clarification',content:'## 目标与边界\\n\\nactive draft\\n'});output={saved:r.pendingDraftDigest!==null};}
  catch(error){output={saved:false,reason:error.code,message:error.message};}
  console.log('AUDIT_RESULT',JSON.stringify({case:'active-run-input-draft',...output}));
  await waitTerminal(s,dir,run.runId);
 }finally{s.store.close();rmSync(dir,{recursive:true,force:true});}
});
`;
  const file = join(workspace, 'test', 'audit.test.mjs');
  writeFileSync(file, prefix + tests);
  const result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 45000 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(workspace, { recursive: true, force: true }); }
