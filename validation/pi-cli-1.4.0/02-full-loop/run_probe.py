import collections, datetime, hashlib, json, os, queue, re, signal, subprocess, threading, time, traceback, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT / 'repo'
SESSIONS = ROOT / 'sessions'
PI = '/Users/me/.pi/agent/bin/pi'
PROVIDER, MODEL = os.environ.get('PI_PROVIDER'), os.environ.get('PI_MODEL')
THINKING = os.environ.get('PI_REASONING_LEVEL', 'high')
ENV = dict(os.environ)
ENV.update(PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_ATTR_NOSYSTEM='1')
for key in ('PI_SESSION_ID','PI_SESSION_FILE','PI_PROVIDER','PI_MODEL','PI_REASONING_LEVEL'):
    ENV.pop(key, None)
REPORT = {'status':'running','started_at':datetime.datetime.now().isoformat(),'pi':'1.4.0','provider':PROVIDER,'model':MODEL,'sdk_used':False,'stages':[]}
CLIENTS = []

def save(stage=None):
    if stage: REPORT['current_stage'] = stage
    temp = ROOT / 'report.tmp'
    temp.write_text(json.dumps(REPORT,ensure_ascii=False,indent=2))
    temp.replace(ROOT / 'report.json')

def git(*args):
    p = subprocess.run(['git','-c','core.hooksPath='+str(ROOT/'empty-hooks'),'-c','core.attributesFile=/dev/null','-c','core.fsmonitor=false',*args],cwd=REPO,env=ENV,capture_output=True,text=True)
    if p.returncode: raise RuntimeError('git '+args[0]+': '+p.stderr[:400])
    return p.stdout.strip()

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def source_hashes(): return {p:sha(REPO/p) for p in ('duration.py','test_duration.py')}
def final_json(text):
    s=text.strip()
    s=re.sub(r'^\x60{3}(?:json)?\s*','',s)
    s=re.sub(r'\s*\x60{3}$','',s)
    return json.loads(s)

class CLI:
    def __init__(self,role,resume=None,tools='read,write,edit,bash,grep,find,ls'):
        self.role,self.events,self.responses,self.q=role,[],{},queue.Queue()
        self.last_event=time.monotonic()
        self.log=(ROOT/(role+'-events.jsonl')).open('a')
        self.stderr=(ROOT/(role+'-stderr.log')).open('wb')
        args=[PI,'--mode','rpc','--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','--session-dir',str(SESSIONS),'--provider',PROVIDER,'--model',MODEL,'--thinking',THINKING,'--append-system-prompt','This is an isolated CLI integration experiment. Work only inside the supplied temporary repository. Do not inspect home directories, environment secrets, credentials, network resources or unrelated.txt. Do not run git add/commit/reset/stash/switch. Keep work minimal. Follow the exact task scope.']
        args += ['--tools',tools] if tools else ['--no-tools']
        args += ['--session',resume] if resume else ['--session-id',str(uuid.uuid4()),'--name','Knit CLI probe '+role]
        self.p=subprocess.Popen(args,cwd=REPO,env=ENV,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.stderr,start_new_session=True)
        CLIENTS.append(self)
        def read():
            for raw in self.p.stdout:
                try: self.q.put(json.loads(raw))
                except Exception: self.q.put({'type':'invalid_record'})
            self.q.put({'type':'process_eof'})
        threading.Thread(target=read,daemon=True).start()
        state=self.call('get_state').get('data',{})
        actual=state.get('model',{})
        if (actual.get('provider'),actual.get('id')) != (PROVIDER,MODEL):
            raise RuntimeError('Requested native model not available with minimal CLI resources; no model fallback attempted')
        self.id,self.file=state.get('sessionId'),state.get('sessionFile')
        self.priced=any(isinstance(v,(int,float)) and v>0 for v in actual.get('cost',{}).values())
    def send(self,kind,**data):
        rid=str(uuid.uuid4())
        self.p.stdin.write((json.dumps({'id':rid,'type':kind,**data})+'\n').encode());self.p.stdin.flush()
        return rid
    def pump(self,timeout=1):
        try: obj=self.q.get(timeout=timeout)
        except queue.Empty:
            if self.p.poll() is not None: raise RuntimeError(self.role+' CLI exited unexpectedly')
            return
        if obj.get('type')=='process_eof': raise RuntimeError(self.role+' CLI EOF')
        if obj.get('type')=='response': self.responses[obj.get('id')]=obj
        else:
            self.events.append(obj);self.last_event=time.monotonic()
            safe={k:obj[k] for k in ('type','toolName','toolCallId','isError','durationMs','aborted','attempt','success') if k in obj}
            if obj.get('type')=='message_end':
                msg=obj.get('message',{});safe.update(role=msg.get('role'),stopReason=msg.get('stopReason'))
            self.log.write(json.dumps(safe)+'\n');self.log.flush()
    def call(self,kind,**data):
        rid=self.send(kind,**data);start=time.monotonic()
        while rid not in self.responses:
            self.pump()
            if time.monotonic()-start>30: raise RuntimeError(self.role+' control command did not respond: '+kind)
        obj=self.responses.pop(rid)
        if not obj.get('success'): raise RuntimeError(self.role+' command rejected: '+kind+' '+str(obj.get('error',''))[:250])
        return obj
    def run(self,message):
        start=time.monotonic();begin=len(self.events)
        self.call('prompt',message=message)
        last_save=0
        while not any(x.get('type')=='agent_settled' for x in self.events[begin:]):
            self.pump()
            now=time.monotonic()
            if now-last_save>5:
                REPORT['live']={'role':self.role,'elapsed_seconds':round(now-start,1),'seconds_since_event':round(now-self.last_event,1),'events':len(self.events)-begin};save();last_save=now
        segment=self.events[begin:]
        if any(x.get('aborted') for x in segment if x.get('type')=='agent_settled'): raise RuntimeError(self.role+' was aborted')
        text=self.call('get_last_assistant_text').get('data',{}).get('text','')
        (ROOT/(self.role+'-final.txt')).write_text(text)
        stats=self.call('get_session_stats').get('data',{})
        result={'role':self.role,'session_id':self.id,'session_file':self.file,'native_file_exists':bool(self.file and Path(self.file).exists()),'elapsed_seconds':round(time.monotonic()-start,2),'events':dict(collections.Counter(x.get('type') for x in segment)),'tokens':stats.get('tokens'),'cost_usd':stats.get('cost') if self.priced else None,'cost_source':'native CLI statistics; unpriced model is unknown','assistant_messages':stats.get('assistantMessages')}
        REPORT['stages'].append(result);save()
        return final_json(text)
    def close(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            try: self.p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.p.pid,signal.SIGTERM)
                try:self.p.wait(timeout=3)
                except subprocess.TimeoutExpired:os.killpg(self.p.pid,signal.SIGKILL);self.p.wait()
        self.stderr.close();self.log.close()

try:
    if not PROVIDER or not MODEL: raise RuntimeError('Current Pi model identity missing')
    REPO.mkdir();SESSIONS.mkdir();(ROOT/'empty-hooks').mkdir()
    (REPO/'.gitignore').write_text('__pycache__/\n*.pyc\n')
    (REPO/'unrelated.txt').write_text('baseline\n')
    task=REPO/'tasks'/'cli-loop'/'task.md';task.parent.mkdir(parents=True)
    task.write_text('# CLI loop experiment\n\nImplement parse_duration(text: str) -> int in duration.py with standard-library unittest tests.\n\nAccept integer h/m/s groups in descending order, each at most once, outer/inter-group whitespace allowed. Reject missing units, negatives, decimals, duplicates, reversed order, junk and empty input with ValueError. Non-string input raises TypeError. Zero is valid. No extra dependencies. Do not alter unrelated.txt.\n')
    git('init','-b','cli-loop');git('add','--','.gitignore','unrelated.txt','tasks/cli-loop/task.md')
    git('-c','user.name=Knit CLI Test','-c','user.email=knit-test@example.invalid','commit','-m','test baseline')
    REPORT['baseline_commit']=git('rev-parse','HEAD')
    (REPO/'unrelated.txt').write_text('user staged content\n');git('add','--','unrelated.txt')
    (REPO/'unrelated.txt').write_text('user unstaged content\n')
    unrelated_index=git('rev-parse',':unrelated.txt');unrelated_work=sha(REPO/'unrelated.txt')
    save('implementation')
    impl=CLI('implementation')
    impl_result=impl.run('Read tasks/cli-loop/task.md. Implement exactly duration.py and test_duration.py, using only Python standard library. Run python3 -m unittest -v. No other repository changes and no Git mutations. Final response must be one JSON object with summary, changedPaths, validation and blockers. Keep the implementation small.')
    REPORT['implementation_report']=impl_result
    impl_id,impl_file=impl.id,impl.file
    impl.close()
    if not impl_file or not Path(impl_file).is_file(): raise RuntimeError('Native implementation history was not persisted')
    if git('rev-parse',':unrelated.txt')!=unrelated_index or sha(REPO/'unrelated.txt')!=unrelated_work: raise RuntimeError('Implementation touched unrelated work')
    before=source_hashes();save('independent-check')
    check=CLI('check',tools='read,bash,grep,find,ls')
    check_result=check.run('You are an independent checker with no implementation conversation. Read tasks/cli-loop/task.md and inspect duration.py and test_duration.py yourself. Run the unittest suite and additional inline boundary checks. Do not edit any files and do not perform Git mutations. Final response is one JSON object: verdict (pass/changes_requested/blocked), findings, validation, unverified. Do not claim pass without running verification.')
    REPORT['check_report']=check_result;check.close()
    if check.id==impl_id: raise RuntimeError('Check session was not independent')
    if source_hashes()!=before: raise RuntimeError('Checker modified implementation')
    if check_result.get('verdict')!='pass': raise RuntimeError('Independent check did not pass')
    verify=subprocess.run(['python3','-m','unittest','-v'],cwd=REPO,env=ENV,capture_output=True,text=True)
    (ROOT/'controller-unittest.txt').write_text(verify.stdout+verify.stderr)
    if verify.returncode: raise RuntimeError('Controller unittest failed')
    save('native-session-resume')
    resumed=CLI('resume',resume=impl_file,tools='')
    old_messages=len(resumed.call('get_messages').get('data',{}).get('messages',[]))
    if resumed.id!=impl_id or not old_messages: raise RuntimeError('Original native session not restored')
    recall=resumed.run('Do not read files or call tools. Based only on this conversation history, return one JSON object with files (relative paths you created previously), function (the exported function name), and rejectedExample (one invalid string input). Do not modify anything.')
    REPORT['resume']={'same_session_id':resumed.id==impl_id,'messages_before_new_prompt':old_messages,'recall':recall}
    resumed.close()
    if set(recall.get('files',[]))!={'duration.py','test_duration.py'} or recall.get('function')!='parse_duration': raise RuntimeError('Native history recall did not match actual implementation')
    if source_hashes()!=before: raise RuntimeError('Resume modified source')
    save('git-delivery')
    if git('symbolic-ref','HEAD')!='refs/heads/cli-loop': raise RuntimeError('Unexpected branch')
    git('add','--','duration.py','test_duration.py')
    git('-c','user.name=Knit CLI Test','-c','user.email=knit-test@example.invalid','commit','--only','-m','implement duration parser','--','duration.py','test_duration.py')
    work=git('rev-parse','HEAD');REPORT['work_commit']=work
    if set(git('diff-tree','--no-commit-id','--name-only','-r','--no-renames',work).splitlines())!={'duration.py','test_duration.py'}: raise RuntimeError('Work commit scope mismatch')
    task.write_text(task.read_text()+'\n## Result\nCompleted; independent check and controller unittest passed.\nWork commit: '+work+'\nImplementation native session: '+impl_id+'\nCheck native session: '+check.id+'\n')
    dest='archive/'+datetime.datetime.now().strftime('%Y-%m')+'/cli-loop/task.md'
    (REPO/dest).parent.mkdir(parents=True)
    git('mv','--','tasks/cli-loop/task.md',dest)
    git('-c','user.name=Knit CLI Test','-c','user.email=knit-test@example.invalid','commit','--only','-m','archive CLI loop experiment','--','tasks/cli-loop/task.md',dest)
    archive=git('rev-parse','HEAD');REPORT['archive_commit']=archive
    if set(git('diff-tree','--no-commit-id','--name-only','-r','--no-renames',archive).splitlines())!={'tasks/cli-loop/task.md',dest}: raise RuntimeError('Archive commit scope mismatch')
    REPORT['protection']={'unrelated_index_preserved':git('rev-parse',':unrelated.txt')==unrelated_index,'unrelated_worktree_preserved':sha(REPO/'unrelated.txt')==unrelated_work,'final_status':git('status','--short'),'archive_path':dest}
    if not all(REPORT['protection'][key] for key in ('unrelated_index_preserved','unrelated_worktree_preserved')): raise RuntimeError('Unrelated work not preserved')
    REPORT['status']='passed';REPORT.pop('live',None);save('complete')
except Exception as exc:
    REPORT.update(status='failed',error=str(exc),failure_type=type(exc).__name__);save('failed')
finally:
    for cli in CLIENTS:
        if cli.p.poll() is None:
            try:cli.close()
            except Exception:pass
    REPORT['finished_at']=datetime.datetime.now().isoformat();save()
    print(json.dumps({'status':REPORT['status'],'report':str(ROOT/'report.json'),'error':REPORT.get('error')},ensure_ascii=False))
