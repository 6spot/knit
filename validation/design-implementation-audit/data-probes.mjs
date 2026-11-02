import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root=resolve(process.argv[2]);
const workspace=mkdtempSync(join(tmpdir(),'knit-audit-data-'));
const suites=[
['delivery.test.mjs','test("正常交付',String.raw`
test('AUDIT external change after formal pass',async()=>{
 const dir=project('audit-stale');const s=services(dir);
 try{
  const task=await makeDeliverable(dir,s);writeFileSync(join(dir,'app.txt'),'unchecked audit edit\n');
  let accepted=false,reason=null;
  try{await s.delivery.validCheck(dir,task.taskId,await s.store.bindings.get(task.taskId),BRANCH);accepted=true;}catch(e){reason=e.guardReason??e.message;}
  console.log('AUDIT_RESULT',JSON.stringify({case:'scope-current-content-validation',acceptedAfterExternalEdit:accepted,reason}));
 }finally{s.store.close();rmSync(dir,{recursive:true,force:true});}
});
test('AUDIT synthetic credential write and commit',async()=>{
 const dir=project('audit-secret');const s=services(dir);
 try{
  // 任务032：写入与限定提交前凭据扫描生效，命中即拒绝。
  let taskWritten=false,taskRejected=null;
  try{await s.tasks.newTask({dir,title:'-----BEGIN PRIVATE KEY----- audit placeholder',slug:'audit-marker',branch:BRANCH});taskWritten=true;}catch(e){taskRejected=e.guardReason??e.code??String(e);}
  const task=await makeDeliverable(dir,s);
  writeFileSync(join(dir,'app.txt'),'-----BEGIN PRIVATE KEY-----\nAUDIT_SYNTHETIC_PLACEHOLDER_NOT_A_KEY\n-----END PRIVATE KEY-----\n');
  const scope={...task.scope,entries:[currentEntry(dir,'app.txt')]};scope.digest=scopeDigest(scope.entries);
  const runs=new RunStore(dir);runs.writeScope(task.taskId,scope);const auditCheck={...task.check,runId:'run-abcdefabcdef',scopeDigest:scope.digest};runs.writeCheck(auditCheck.runId,auditCheck);
  const binding=await s.store.bindings.get(task.taskId);await s.store.bindings.save({...binding,lastCheckRunId:auditCheck.runId,scope:scope.entries});
  let deliveryState=null,workCommitCreated=false,deliveryRejected=null;
  try{const r=await s.delivery.deliver({dir,taskId:task.taskId,branch:BRANCH,authorizationRef:'workflow:.knit/workflow.md#交付授权'});deliveryState=r.state;workCommitCreated=!!r.workCommit;}catch(e){deliveryRejected=e.guardReason??e.code??String(e);}
  console.log('AUDIT_RESULT',JSON.stringify({case:'synthetic-credential-boundaries',taskWritten,taskRejected,deliveryState,workCommitCreated,deliveryRejected}));
 }finally{s.store.close();rmSync(dir,{recursive:true,force:true});}
});
`],
['standards.test.mjs','test("propose',String.raw`
test('AUDIT adoption parent symlink',async()=>{
 const dir=gitProject('audit-link');const outside=mkdtempSync(join(tmpdir(),'knit-audit-outside-'));installTemplates(dir);const s=makeServices(dir);
 try{
  writeFileSync(join(outside,'rules.md'),'# Outside\n');
  (await import('node:fs')).symlinkSync(outside,join(dir,'.knit','standards','ext'),'dir');
  const task=await s.tasks.newTask({dir,title:'audit standards'});const p=await s.standards.propose(candidateInput(dir,task.taskId));const target='.knit/standards/ext/rules.md';
  await s.standards.review({dir,taskId:task.taskId,decision:'applied',reason:'audit approved synthetic candidate',targets:[target]});
  let applied=false,reason=null;try{const r=await s.standards.apply({dir,taskId:task.taskId,candidateId:p.candidate.candidateId,target});applied=r.applied;}catch(e){reason=e.guardReason??e.message;}
  console.log('AUDIT_RESULT',JSON.stringify({case:'standards-parent-symlink',applied,outsideChanged:readFileSync(join(outside,'rules.md'),'utf8')!=='# Outside\n',reason}));
 }finally{s.store.close();rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('AUDIT adoption version and index recovery',async()=>{
 const dir=gitProject('audit-adoption');installTemplates(dir);const s=makeServices(dir);
 try{
  const task=await s.tasks.newTask({dir,title:'audit recovery'});const p=await s.standards.propose(candidateInput(dir,task.taskId));const target='.knit/standards/audit.md';const input={dir,taskId:task.taskId,candidateId:p.candidate.candidateId,target};
  writeFileSync(join(dir,target),'# Audit standard\n');
  await s.standards.review({dir,taskId:task.taskId,decision:'applied',reason:'audit approved synthetic candidate',targets:[target]});
  const indexPath=join(dir,'.knit','standards','index.md');const oldIndex=readFileSync(indexPath,'utf8');
  await s.standards.apply(input);writeFileSync(indexPath,oldIndex);
  const retry=await s.standards.apply(input);
  console.log('AUDIT_RESULT',JSON.stringify({case:'adoption-index-recovery',alreadyApplied:retry.alreadyApplied,indexRepaired:readFileSync(indexPath,'utf8').includes('audit.md')}));
  const candidatesFile=join(dir,p.file);writeFileSync(candidatesFile,readFileSync(candidatesFile,'utf8').replace(p.candidate.rule,'AUDIT V2 RULE'));
  assert.equal(parseCandidates(readFileSync(candidatesFile,'utf8')).candidates[0].rule,'AUDIT V2 RULE','updated candidate is actually v2');
  await s.standards.review({dir,taskId:task.taskId,decision:'applied',reason:'audit approved updated candidate',targets:[target]});
  const updated=await s.standards.apply(input);
  console.log('AUDIT_RESULT',JSON.stringify({case:'adoption-candidate-version',alreadyApplied:updated.alreadyApplied,containsV2:readFileSync(join(dir,target),'utf8').includes('AUDIT V2 RULE')}));
 }finally{s.store.close();rmSync(dir,{recursive:true,force:true});}
});
`]
];
try{
 mkdirSync(join(workspace,'test'));symlinkSync(join(root,'dist'),join(workspace,'dist'),'dir');symlinkSync(join(root,'assets'),join(workspace,'assets'),'dir');
 for(const [file,marker,body] of suites){const source=readFileSync(join(root,'test',file),'utf8');const end=source.indexOf(marker);if(end<0)throw new Error('fixture marker missing');const path=join(workspace,'test',file);writeFileSync(path,source.slice(0,end)+body);const r=spawnSync(process.execPath,['--test',path],{encoding:'utf8',timeout:30000});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');if(r.error)throw r.error;if(r.status!==0)process.exitCode=1;}
}finally{rmSync(workspace,{recursive:true,force:true});}
