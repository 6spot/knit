"""Finite validation helper using installed Pi CLI only; not Knit implementation."""
import collections, json, os, queue, re, signal, subprocess, threading, time, uuid
from pathlib import Path

PI = '/Users/me/.pi/agent/bin/pi'
PROVIDER = os.environ.get('PI_PROVIDER')
MODEL = os.environ.get('PI_MODEL')
THINKING = os.environ.get('PI_REASONING_LEVEL', 'high')

class PiCLI:
    def __init__(self, folder, role, tools='', session=None, extensions=(), isolated=False, discover=False):
        self.folder=Path(folder); self.folder.mkdir(parents=True,exist_ok=True)
        self.role=role; self.q=queue.Queue(); self.responses={}; self.events=[]; self.stderr=self.folder/(role+'-stderr.log')
        self.log=(self.folder/(role+'-events.jsonl')).open('a')
        env=dict(os.environ)
        env.update(PI_OFFLINE='1',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0')
        for key in ('PI_SESSION_ID','PI_SESSION_FILE','PI_PROVIDER','PI_MODEL','PI_REASONING_LEVEL'): env.pop(key,None)
        if isolated: env['PI_CODING_AGENT_DIR']=str(self.folder/'isolated-agent')
        args=[PI,'--mode','rpc','--offline','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--session-dir',str(self.folder/'sessions')]
        args+=['--approve'] if discover else ['--no-extensions','--no-approve']
        if not isolated: args+=['--provider',PROVIDER,'--model',MODEL,'--thinking',THINKING]
        args+=['--tools',tools] if tools else ['--no-tools']
        for extension in extensions: args+=['--extension',str(extension)]
        args+=['--session',str(session)] if session else ['--session-id',str(uuid.uuid4()),'--name','Knit validation '+role]
        args+=['--append-system-prompt','This is a temporary CLI validation fixture. Follow the precise test request. Do not inspect home, environment secrets, credentials, unrelated projects or network resources. Do not mutate Git.']
        self.err=self.stderr.open('wb')
        self.p=subprocess.Popen(args,cwd=self.folder,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.err,start_new_session=True)
        def read():
            for raw in self.p.stdout:
                try:self.q.put(json.loads(raw))
                except Exception:self.q.put({'type':'invalid_record'})
            self.q.put({'type':'process_eof'})
        threading.Thread(target=read,daemon=True).start()
        state=self.call('get_state').get('data',{})
        self.id,self.file=state.get('sessionId'),state.get('sessionFile')
        native=state.get('model',{})
        if not isolated:
            try:
                self.call('set_model',provider=PROVIDER,modelId=MODEL)
                if (native.get('provider'),native.get('id'))!=(PROVIDER,MODEL):
                    raise RuntimeError('Selected native model unavailable; no fallback')
            except Exception:
                self.close()
                raise
        self.priced=any(isinstance(x,(int,float)) and x>0 for x in native.get('cost',{}).values())
    def send(self,kind,**data):
        rid=str(uuid.uuid4());self.p.stdin.write((json.dumps({'id':rid,'type':kind,**data},ensure_ascii=False)+'\n').encode());self.p.stdin.flush();return rid
    def pump(self,seconds=0.5):
        try:o=self.q.get(timeout=seconds)
        except queue.Empty:
            if self.p.poll() is not None:raise RuntimeError('CLI exited')
            return
        if o.get('type')=='process_eof':raise RuntimeError('CLI EOF')
        if o.get('type')=='response':self.responses[o.get('id')]=o
        else:
            self.events.append(o)
            safe={k:o[k] for k in ('type','toolName','toolCallId','durationMs','isError','aborted','name') if k in o}
            if o.get('type')=='message_end':safe.update(role=o.get('message',{}).get('role'),stopReason=o.get('message',{}).get('stopReason'))
            self.log.write(json.dumps(safe,ensure_ascii=False)+'\n');self.log.flush()
    def call(self,kind,allow_failure=False,**data):
        rid=self.send(kind,**data);end=time.monotonic()+30
        while rid not in self.responses:
            self.pump()
            if time.monotonic()>end:raise TimeoutError('Control command timeout: '+kind)
        o=self.responses.pop(rid)
        if not allow_failure and not o.get('success'):raise RuntimeError('Command rejected: '+kind+' '+str(o.get('error',''))[:200])
        return o
    def until(self,predicate,seconds=180):
        end=time.monotonic()+seconds
        while not predicate():
            self.pump()
            if time.monotonic()>end:raise TimeoutError('Test observation deadline exceeded')
    def observe(self,seconds):
        end=time.monotonic()+seconds
        while time.monotonic()<end:self.pump(min(0.3,max(0.01,end-time.monotonic())))
    def prompt(self,text):return self.call('prompt',message=text)
    def settled(self,start=0):return any(e.get('type')=='agent_settled' for e in self.events[start:])
    def last_text(self):return self.call('get_last_assistant_text').get('data',{}).get('text','')
    def stats(self):
        s=self.call('get_session_stats').get('data',{})
        return {'tokens':s.get('tokens',{}),'cost_usd':s.get('cost') if self.priced else None,'assistant_messages':s.get('assistantMessages'),'tool_calls':s.get('toolCalls')}
    def refresh(self):
        s=self.call('get_state').get('data',{});self.file=s.get('sessionFile');return s
    def close(self):
        if self.p.poll() is None:
            try:self.call('clear_queue');self.call('abort')
            except Exception:pass
            try:self.p.stdin.close();self.p.wait(timeout=5)
            except Exception:
                try:os.killpg(self.p.pid,signal.SIGTERM);self.p.wait(timeout=3)
                except Exception:
                    try:os.killpg(self.p.pid,signal.SIGKILL);self.p.wait(timeout=3)
                    except Exception:pass
        self.err.close();self.log.close()

def running(pid):
    p=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
    return p.returncode==0 and p.stdout.strip() and not p.stdout.strip().startswith('Z')

def marked_pid(events,nonce):
    for e in events:
        if e.get('type')!='tool_execution_update':continue
        content=e.get('partialResult',{}).get('content',[])
        for block in content:
            match=re.search(re.escape(nonce)+r'\s+(\d+)',block.get('text',''))
            if match:return int(match[1])
    return None

def stop_marked(pid,nonce):
    if not pid or not running(pid):return
    args=subprocess.check_output(['ps','-p',str(pid),'-o','args=']).decode('utf-8','replace')
    if nonce not in args:raise RuntimeError('Refuse to signal unverified PID')
    pgid=os.getpgid(pid)
    if pgid==os.getpgrp():raise RuntimeError('Refuse to signal controller group')
    os.killpg(pgid,signal.SIGTERM)
    end=time.monotonic()+3
    while running(pid) and time.monotonic()<end:time.sleep(0.05)
    if running(pid):os.killpg(pgid,signal.SIGKILL)
