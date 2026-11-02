// F037 交付链路核对：检查阶段授权修改规范后，交付 validCheck 是否仍然可过
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CLI = '/home/opc/work/knit/dist/cli/knit.js';
const dir = mkdtempSync(join(tmpdir(), 'f037-'));
execFileSync('git', ['init','-q','-b','main'], {cwd:dir});
execFileSync('git', ['config','user.email','t@e.com'], {cwd:dir});
execFileSync('git', ['config','user.name','t'], {cwd:dir});
writeFileSync(join(dir,'a.txt'),'x\n');
execFileSync('git',['add','.'],{cwd:dir});
execFileSync('git',['commit','-q','-m','init'],{cwd:dir});
execFileSync(process.execPath,[CLI,'init','--client','pi','--dir',dir],{encoding:'utf8'});
const store = (await import('/home/opc/work/knit/dist/infrastructure/sqlite-metadata-store.js')).SqliteMetadataStore;
const s = new store(join(dir,'.knit','.runtime','metadata.db'));
const { TaskService } = await import('/home/opc/work/knit/dist/application/task-service.js');
const { RunCoordinator } = await import('/home/opc/work/knit/dist/application/run-coordinator.js');
const { DeliveryService } = await import('/home/opc/work/knit/dist/application/delivery-service.js');
const { RunStore } = await import('/home/opc/work/knit/dist/infrastructure/run-store.js');
const tasks = new TaskService({ store: s });
const created = await tasks.newTask({ dir, title:'f037', slug:'f037', branch:'refs/heads/main' });
await tasks.ready({ dir, taskId: created.taskId });
const stdPath = '.knit/standards/release.md';
writeFileSync(join(dir,stdPath),'# v1\n');
execFileSync('git',['add','.'],{cwd:dir}); execFileSync('git',['commit','-q','-m','std'],{cwd:dir});
const coord = new RunCoordinator({ store: s });
const prep = await coord.prepare({ dir, taskId: created.taskId, phase:'implement',
  initiator:{client:'cli',knitSessionId:null,nativeSessionId:null,cwd:dir},
  model:{runtime:'pi',provider:'fake',model:'fake-model'},
  authorizedStandardPaths:[stdPath] });
console.log('PREPARE_OK', prep.request.expected.authorizedStandardOutputs?.length);
// 模拟实施完成：改规范 + scope + check
writeFileSync(join(dir,stdPath),'# v2\n');
writeFileSync(join(dir,'.knit','workflow.md'), ['# 工作流','','## 交付授权','','允许在当前分支按任务范围提交并归档。',''].join('\n'));
const { mergeScope, currentEntry } = await import('/home/opc/work/knit/dist/application/scope.js');
const runs = new RunStore(dir);
const runId = prep.request.runId;
// request 已由 prepare 发布；本 run 即实施 run，后续 state/result/接收操作都写它
const scope = mergeScope(runs.readScope(created.taskId) ?? {schemaVersion:1,taskId:created.taskId,runIds:[],entries:[],digest:'',updatedAt:''},
  { runId, taskId:created.taskId, paths:[stdPath], root:dir, now:new Date().toISOString() });
runs.writeScope(created.taskId, scope);
const { parseTaskDocument, renderTaskDocument } = await import('/home/opc/work/knit/dist/application/task-document.js');
const { locateTaskDocument } = await import('/home/opc/work/knit/dist/application/task-service.js');
const located = locateTaskDocument(dir, created.taskId);
const doc = parseTaskDocument(located.raw.toString('utf8'), located.dir + '/task.md');
const fs = await import('node:fs');
fs.writeFileSync(join(located.dir,'task.md'), renderTaskDocument({ ...doc, frontmatter: { ...doc.frontmatter, phase:'deliver' } }));
const binding = await s.bindings.get(created.taskId);
// 用 check 阶段同样授权的 plan 计算 digest（模拟检查阶段本身授权）
const { ContextPlanner } = await import('/home/opc/work/knit/dist/application/context-planner.js');
const planner = new ContextPlanner({ store: s });
// 真实链路：check prepare 时磁盘已是 v2；validCheck 两侧同读磁盘当前内容，摘要一致
const checkPlan = await planner.plan({ dir, taskId: created.taskId, role:'check' });
const check = { schemaVersion:1, runId:'run-checkf037aaaa', taskId:created.taskId, verdict:'pass', branch:'refs/heads/main',
  report:{ summary:'检查', verdict:'pass', coverage:[stdPath] },
  inputsDigest: checkPlan.inputsDigest, standardsDigest: checkPlan.standardsDigest, effectiveInputsDigest: checkPlan.effectiveInputsDigest,
  scopeDigest: scope.digest, recordedAt:new Date().toISOString() };
runs.writeCheck(check.runId, check);
// 运行状态与接收操作必须已收敛（真实链路由 worker 写入）
const nowIso = new Date().toISOString();
// 发布 run 收敛：state completed + result + 接收操作 completed（接收操作 ID = request.acceptanceOperationId）
runs.writeState(runId, { schemaVersion:1, runId, taskId:created.taskId, phase:'implement', state:'completed',
  worker:{workerId:'w1',pid:1,bootId:'b',procStartTicks:null,hostname:'h'}, claimedAt:nowIso, updatedAt:nowIso, prepared:true, preparedAt:nowIso, snapshot:null, reason:null });
try {
  runs.writeResult(runId, { schemaVersion:1, runId, taskId:created.taskId, phase:'implement', state:'completed',
    report:{summary:'实现',changedPaths:[stdPath]}, reportSummary:'实现',
    nativeEntries:{startEntryId:null,leafEntryId:null},
    usage:{inputTokens:null,outputTokens:null},
    session:null,
    actualChangedPaths:[stdPath], actualEntries:[],
    acceptanceOperationId:prep.request.acceptanceOperationId, recordedAt:nowIso, failureReason:null });
} catch(e) { console.log('result-shape', e.message); }
await s.operations.save({ operationId:prep.request.acceptanceOperationId, kind:'run.accept', state:'completed', recordedAt:nowIso });
// 冻结摘要按 check 时的 plan 口径（真实链路由接收写入）
await s.bindings.save({ ...binding, lastCheckRunId: check.runId, scope: scope.entries, scopeRunIds:[runId], confirmedInputsDigest: checkPlan.inputsDigest, confirmedStandardsDigest: checkPlan.standardsDigest });
console.log('runIds', runs.listRunIds());
for (const rid of runs.listRunIds()) {
  const rq = runs.readRequest(rid);
  const st = runs.readState(rid);
  let rs = null; try { rs = runs.readResult(rid); } catch {}
  console.log('run', rid, 'taskId', rq?.taskId, 'state', st?.state, 'result', rs !== null);
}
const delivery = new DeliveryService({ store: s, locks: null, now: () => new Date(), randomHex: (n)=>'a'.repeat(n*2) });
try {
  const r = await delivery.deliver({ dir, taskId: created.taskId, branch:'refs/heads/main', authorizationRef:'workflow:.knit/workflow.md#交付授权' });
  console.log('DELIVER', r.state, r.reason ?? '');
} catch (e) {
  console.log('DELIVER_REJECTED', e.guardReason ?? e.code, e.message);
}
s.close();
rmSync(dir,{recursive:true,force:true});
