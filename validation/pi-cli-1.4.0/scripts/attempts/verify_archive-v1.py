"""Read-only archive verification; uses temp clone repos, never calls a model."""
import hashlib,json,os,re,stat,subprocess,sys,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ENV=dict(os.environ);ENV.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL='/dev/null',GIT_ATTR_NOSYSTEM='1')
RESULT={'status':'running','model_requests':0,'checks':{}}
def run(args,cwd=None):
    p=subprocess.run(args,cwd=cwd,env=ENV,capture_output=True,text=True)
    if p.returncode:raise RuntimeError('Verification command failed: '+args[0]+' '+p.stderr[:300])
    return p.stdout.strip()
def git(*args):return ['git','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','core.fsmonitor=false',*args]
try:
    manifest=json.loads((ROOT/'MANIFEST.json').read_text());checked=0
    for item in manifest['files']:
        p=ROOT/item['path'];assert p.is_file(),str(p)
        assert hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256'],item['path']
        checked+=1
    inventory={str(p.relative_to(ROOT)) for p in ROOT.rglob('*') if p.is_file() and '.work' not in p.relative_to(ROOT).parts and '__pycache__' not in p.relative_to(ROOT).parts and p.suffix!='.pyc' and p.name not in ('MANIFEST.json','ARCHIVE-CHECK.json')}
    assert inventory=={x['path'] for x in manifest['files']},'Manifest inventory mismatch'
    RESULT['checks']['manifest_files']=checked
    records=0
    for item in manifest['files']:
        p=ROOT/item['path']
        if p.suffix=='.json':json.loads(p.read_text())
        elif p.suffix=='.jsonl':
            for line in p.read_text().splitlines():
                if line:json.loads(line);records+=1
    RESULT['checks']['JSONL_records_parsed']=records
    for name in ('README.md','MATRIX.md'):
        for target in re.findall(r'\]\(([^)]+)\)',(ROOT/name).read_text()):
            if target=='ARCHIVE-CHECK.json':continue  # Produced by this verification run.
            if '://' not in target and not target.startswith('#'):assert (ROOT/target.split('#')[0]).exists(),target
    RESULT['checks']['local_links']=True
    private=ROOT/'private-native';assert stat.S_IMODE(private.stat().st_mode)==0o700
    for p in private.rglob('*'):assert stat.S_IMODE(p.stat().st_mode)==(0o700 if p.is_dir() else 0o600)
    # Current project's ignore rules are part of the evidence protection.
    run(['git','check-ignore',str(private),str(ROOT/'.work')],cwd=ROOT)
    assert not subprocess.run(['git','check-ignore',str(ROOT/'README.md')],cwd=ROOT,capture_output=True).returncode==0
    RESULT['checks']['private_modes_and_git_ignore']=True
    sensitive=[];secrets=re.compile(rb'(?:sk-[A-Za-z0-9]{24,}|Bearer [A-Za-z0-9._~-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)')
    for item in manifest['files']:
        if item['path'].startswith('private-native/') or item['path'].endswith('.bundle'):continue
        p=ROOT/item['path']
        if secrets.search(p.read_bytes()):sensitive.append(item['path'])
    assert not sensitive,'Possible credential-like data in public evidence: '+str(sensitive)
    RESULT['checks']['public_credential_pattern_scan']=True
    loop=json.loads((ROOT/'02-full-loop/report.json').read_text());bundles=[]
    with tempfile.TemporaryDirectory(prefix='knit-archive-verify-') as td:
        base=Path(td)
        for number,bundle in enumerate(sorted(ROOT.rglob('*.bundle'))):
            if '.work' in bundle.parts:continue
            repo=base/str(number);run(git('clone','--quiet',str(bundle),str(repo)))
            run(git('bundle','verify',str(bundle)),repo);run(git('fsck','--full'),repo)
            # Preserve both index and worktree layers from the original fixture.
            side=ROOT/'02-full-loop' if bundle.parent.name=='02-full-loop' else ROOT/'03-edge-cases/git'/bundle.stem
            for filename,extra in [('index.diff',['--index']),('worktree.diff',[])]:
                patch=side/filename
                if patch.stat().st_size:run(git('apply',*extra,str(patch)),repo)
            assert run(git('show',':unrelated.txt'),repo)==(side/'unrelated-index.txt').read_text().strip()
            assert run(git('status','--short','--','unrelated.txt'),repo)=='MM unrelated.txt'
            if bundle.parent.name=='02-full-loop':
                for key,expected in [('work_commit',{'duration.py','test_duration.py'}),('archive_commit',{'tasks/cli-loop/task.md','archive/2026-11/cli-loop/task.md'})]:
                    actual=set(run(git('diff-tree','--no-commit-id','--name-only','--no-renames','-r',loop[key]),repo).splitlines());assert actual==expected
                run([sys.executable,'-m','unittest','-v'],repo)
            bundles.append(str(bundle.relative_to(ROOT)))
    RESULT['checks']['bundles_cloned_fsck_and_dirty_state_replayed']=bundles
    RESULT['checks']['unittest_from_cloned_bundle']=True
    usage=json.loads((ROOT/'USAGE.json').read_text());t=usage['totals'];assert sum(t.get(k,0) for k in ('input','output','cacheRead','cacheWrite'))==t['totalTokens']
    assert sum(x['tokens']['totalTokens'] for x in usage['all_sessions'])==t['totalTokens']
    RESULT['checks']['usage_arithmetic']=True
    first=json.loads((ROOT/'03-edge-cases/results-attempt1.json').read_text());rerun=json.loads((ROOT/'03-edge-cases/results-rerun.json').read_text());final={c['name']:c for c in first['cases']};final.update({c['name']:c for c in rerun['cases']});assert all(c['status']=='passed' for c in final.values())
    assert json.loads((ROOT/'03-edge-cases/interactive.json').read_text())['status']=='passed'
    assert all(x['verification']=='passed' for x in json.loads((ROOT/'03-edge-cases/git/results.json').read_text())['cases'])
    RESULT['checks']['all_final_case_results_resolved']=True
    pending=[]
    runners=('run_edge_cases.py','run_interactive.py','run_control_repeat.py','run_git_cases.py')
    for line in subprocess.check_output(['ps','-axo','pid=,comm=,args=']).decode('utf-8','replace').splitlines():
        fields=line.split(None,2)
        if len(fields)!=3:continue
        pid,comm,args=fields
        marked_child='python' in Path(comm).name.lower() and any(marker in args for marker in ('KNIT_CANCEL_','KNIT_CRASH_','KNIT_QUEUE_','KNIT_RPC_BASH_'))
        if marked_child:pending.append(int(pid))
        original=json.loads((ROOT/'PATHS.json').read_text())['original_root']
        if str(ROOT) not in args and original not in args:continue
        if comm.endswith('node') and ('--mode rpc' in args or '--extension' in args):pending.append(int(pid))
        if 'python' in Path(comm).name.lower() and any(args.endswith('/scripts/'+name) or '/scripts/'+name+' ' in args for name in runners):pending.append(int(pid))
    assert not pending,'Probe processes still running: '+str(pending)
    RESULT['checks']['remaining_probe_processes']=pending
    RESULT['status']='passed'
except Exception as error:
    import traceback
    RESULT.update(status='failed',error=str(error),traceback=traceback.format_exc())
finally:
    (ROOT/'ARCHIVE-CHECK.json').write_text(json.dumps(RESULT,ensure_ascii=False,indent=2)+'\n');print(json.dumps(RESULT,ensure_ascii=False,indent=2))
if RESULT['status']!='passed':raise SystemExit(1)
