"""Native Git behavior and recovery evidence in isolated fixture repos only."""
import hashlib,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.work'/'git-cases';OUT=ROOT/'03-edge-cases'/'git'
OUT.mkdir(parents=True,exist_ok=True)
ENV=dict(os.environ);ENV.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL='/dev/null',GIT_ATTR_NOSYSTEM='1')
RESULT=[]
def setup(name):
    r=WORK/name;r.mkdir(parents=True)
    (r/'hooks').mkdir();(r/'result.txt').write_text('base result\n');(r/'unrelated.txt').write_text('baseline\n')
    (r/'tasks').mkdir();(r/'tasks'/'sample.md').write_text('id: fixture-task\nstatus: open\n')
    call(r,'init','-b','fixture');call(r,'config','core.hooksPath',str(r/'hooks'));call(r,'config','core.attributesFile','/dev/null');call(r,'config','core.fsmonitor','false')
    call(r,'add','--','result.txt','unrelated.txt','tasks/sample.md');commit(r,'baseline','result.txt','unrelated.txt','tasks/sample.md')
    (r/'unrelated.txt').write_text('user staged\n');call(r,'add','--','unrelated.txt');(r/'unrelated.txt').write_text('user unstaged\n')
    return r,call(r,'rev-parse',':unrelated.txt'),(r/'unrelated.txt').read_bytes()
def command(*args):return ['git','-c','user.name=Knit Validation','-c','user.email=knit-validation@example.invalid',*args]
def proc(r,*args):return subprocess.run(command(*args),cwd=r,env=ENV,capture_output=True,text=True)
def call(r,*args):
    p=proc(r,*args)
    if p.returncode:raise RuntimeError(args[0]+': '+p.stderr[:300])
    return p.stdout.strip()
def commit(r,message,*paths):return call(r,'commit','--only','-m',message,'--',*paths)
def paths(r,oid):return call(r,'diff-tree','--no-commit-id','--name-only','-r','--no-renames',oid).splitlines()
def preserve(r,index,work):return call(r,'rev-parse',':unrelated.txt')==index and (r/'unrelated.txt').read_bytes()==work
def bundle(r,name):call(r,'bundle','create',str(OUT/(name+'.bundle')),'--all')
def record(name,fn):
    try:data=fn();RESULT.append({'name':name,'verification':'passed',**data})
    except Exception as e:RESULT.append({'name':name,'verification':'failed','error':str(e)})


def failing_hook():
    r,index,work=setup('failing-hook');head=call(r,'rev-parse','HEAD')
    (r/'result.txt').write_text('candidate result\n');hook=r/'hooks'/'pre-commit';hook.write_text('#!/bin/sh\nexit 17\n');hook.chmod(0o700)
    attempted=proc(r,'commit','--only','-m','must fail','--','result.txt')
    assert attempted.returncode!=0 and call(r,'rev-parse','HEAD')==head and preserve(r,index,work)
    bundle(r,'failing-hook')
    return {'behavior':'hook rejected commit; HEAD and unrelated work preserved','exit_code':attempted.returncode,'head_unchanged':True,'unrelated_preserved':True}

def scope_hook():
    r,index,work=setup('scope-hook');(r/'result.txt').write_text('candidate result\n')
    hook=r/'hooks'/'pre-commit';hook.write_text('#!/bin/sh\ngit add -- unrelated.txt\n');hook.chmod(0o700)
    commit(r,'scope probe','result.txt');head=call(r,'rev-parse','HEAD');actual=paths(r,head)
    assert 'unrelated.txt' in actual
    bundle(r,'scope-hook')
    return {'behavior':'finding: pre-commit hook can expand commit scope despite --only','actual_paths':actual,'commit':head,'scope_expansion_detected':True,'unrelated_file_and_index_preserved':preserve(r,index,work),'required_boundary':'Verify actual commit tree; preserve facts and report needs_attention, never assume --only is a sandbox or auto rewrite history.'}

def lost_receipt():
    r,index,work=setup('lost-receipt');(r/'result.txt').write_text('desired committed result\n')
    before=call(r,'rev-parse','HEAD');expected_blob=call(r,'hash-object','result.txt')
    intent={'expected_parent':before,'selected_paths':['result.txt'],'expected_blob':expected_blob}
    (OUT/'lost-receipt-intent.json').write_text(json.dumps(intent,indent=2))
    args=command('commit','--only','-m','commit then crash','--','result.txt')
    child='import os,subprocess,sys;subprocess.run(sys.argv[1:],check=True,stdout=subprocess.DEVNULL);os._exit(77)'
    p=subprocess.run([sys.executable,'-c',child,*args],cwd=r,env=ENV,capture_output=True)
    assert p.returncode==77
    actual=call(r,'rev-parse','HEAD');count=call(r,'rev-list','--count','HEAD')
    assert actual!=before and call(r,'rev-parse',actual+'^')==before and paths(r,actual)==['result.txt'] and call(r,'rev-parse',actual+':result.txt')==expected_blob
    receipt={'decision':'effect already applied; checkpoint reconstructed without another commit','actual_commit':actual,'parent_matches':True,'blob_matches':True}
    (OUT/'lost-receipt-recovered.json').write_text(json.dumps(receipt,indent=2))
    assert call(r,'rev-parse','HEAD')==actual and call(r,'rev-list','--count','HEAD')==count and preserve(r,index,work)
    bundle(r,'lost-receipt')
    return {'behavior':'actual subprocess exit after successful commit, no receipt; recovered by Git facts','performer_exit':77,'no_duplicate_commit':True,'unrelated_preserved':True,'commit':actual}

def interrupted_move():
    r,index,work=setup('interrupted-move');source=r/'tasks'/'sample.md';target=r/'archive'/'sample.md'
    expected=hashlib.sha256(source.read_bytes()).hexdigest();target.parent.mkdir()
    call(r,'mv','--','tasks/sample.md','archive/sample.md')
    # Simulate next controller finding a move that happened before its checkpoint.
    assert not source.exists() and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==expected
    commit(r,'resume archive step','tasks/sample.md','archive/sample.md');oid=call(r,'rev-parse','HEAD')
    assert set(paths(r,oid))=={'tasks/sample.md','archive/sample.md'} and preserve(r,index,work)
    bundle(r,'interrupted-move')
    return {'behavior':'move already applied; verified target then archive commit, no second move','unrelated_preserved':True,'commit':oid}

record('hook-failure',failing_hook)
record('hook-scope-expansion',scope_hook)
record('commit-success-receipt-lost',lost_receipt)
record('archive-move-checkpoint-lost',interrupted_move)
(OUT/'results.json').write_text(json.dumps({'cases':RESULT,'not_product_implementation':True},ensure_ascii=False,indent=2)+'\n')
print(json.dumps(RESULT,ensure_ascii=False,indent=2))
if any(x['verification']=='failed' for x in RESULT):raise SystemExit(1)
