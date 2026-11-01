"""Exercise the real interactive Pi CLI in an isolated pseudo-terminal."""
import fcntl,json,os,pty,shutil,signal,struct,subprocess,termios,threading,time,uuid
from pathlib import Path
from pi_rpc_probe import PI,PROVIDER,MODEL,THINKING,PiCLI
ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.work'/'interactive';WORK.mkdir(parents=True)
EXT=WORK/'extension';EXT.mkdir();TARGET=EXT/'probe.ts';shutil.copy2(ROOT/'scripts'/'host_probe.mjs',TARGET)
LOG=EXT/'host-events.jsonl';OUT=ROOT/'03-edge-cases'/'interactive.json'
result={'status':'running','mode':'actual CLI interactive PTY','sdk_imported':False};p=None;master=None

def entries():
    if not LOG.exists():return []
    return [json.loads(x) for x in LOG.read_text().split('\n') if x]
def wait_for(fn,seconds=120):
    end=time.monotonic()+seconds
    while not fn():
        if p.poll() is not None:raise RuntimeError('Interactive CLI exited before observation')
        if time.monotonic()>end:raise TimeoutError('Interactive observation deadline')
        time.sleep(0.05)
def send(text):os.write(master,(text+'\r').encode())
try:
    env=dict(os.environ)
    for key in ('PI_SESSION_ID','PI_SESSION_FILE','PI_PROVIDER','PI_MODEL','PI_REASONING_LEVEL'):env.pop(key,None)
    env.update(TERM='xterm-256color',COLORTERM='truecolor',PI_OFFLINE='1',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0',PI_HARDWARE_CURSOR='0',PI_PROGRAM_STATUS='0')
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,110,0,0))
    def setup():os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
    args=[PI,'--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','--no-tools','--extension',str(TARGET),'--provider',PROVIDER,'--model',MODEL,'--thinking',THINKING,'--session-dir',str(WORK/'sessions'),'--name','Knit interactive validation']
    p=subprocess.Popen(args,cwd=WORK,env=env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=setup);os.close(slave)
    def drain():
        with (WORK/'terminal-private.bin').open('wb') as stream:
            while True:
                try:data=os.read(master,65536)
                except OSError:return
                if not data:return
                stream.write(data);stream.flush()
                if b'\x1b[6n' in data:
                    try:os.write(master,b'\x1b[1;1R')
                    except OSError:pass
    threading.Thread(target=drain,daemon=True).start()
    wait_for(lambda:any(e['event']=='session_start' for e in entries()),seconds=20);time.sleep(0.4)
    send('/knit-probe-status');wait_for(lambda:any(e['event']=='status' for e in entries()),seconds=10)
    TARGET.write_text(TARGET.read_text().replace("const version='v1'","const version='v2'"))
    send('/reload');wait_for(lambda:any(e['event']=='session_start' and e['version']=='v2' for e in entries()),seconds=15)
    send('/knit-probe-status');wait_for(lambda:any(e['event']=='status' and e['version']=='v2' for e in entries()),seconds=10)
    result['interactive_slash_reload_loaded_v2']=True
    passive='PTY_PASSIVE_'+uuid.uuid4().hex;before=len([e for e in entries() if e['event']=='agent_start'])
    send('/knit-probe-notify passive '+passive)
    wait_for(lambda:any(e['event']=='sent' and e.get('token')==passive for e in entries()),seconds=10);time.sleep(1)
    assert len([e for e in entries() if e['event']=='agent_start'])==before
    result['passive_callback_did_not_start_model']=True
    wake='PTY_WAKE_'+uuid.uuid4().hex;send('/knit-probe-notify wake '+wake)
    wait_for(lambda:any(e['event']=='assistant' and e.get('text','').strip()==wake for e in entries()))
    wait_for(lambda:len([e for e in entries() if e['event']=='agent_end'])>=1);time.sleep(0.5)
    result['outside_turn_callback_woke_interactive_model']=True
    os.write(master,b'\x03');time.sleep(0.1);os.write(master,b'\x03');p.wait(timeout=10)
    result['interactive_exit_code']=p.returncode
    sessions=list((WORK/'sessions').glob('*.jsonl'));assert len(sessions)==1
    records=[json.loads(x) for x in sessions[0].read_text().split('\n') if x]
    assert any(e.get('type')=='custom_message' and passive in str(e.get('content','')) for e in records)
    result['passive_notice_in_native_history']=True
    session=next(e['id'] for e in records if e.get('type')=='session');result['native_session_id']=session
    inspect=PiCLI(WORK/'inspect','interactive-inspect',session=sessions[0])
    try:
        assert inspect.id==session
        result['usage']=inspect.stats()
    finally:inspect.close()
    result['status']='passed'
except Exception as error:
    import traceback
    result.update(status='inconclusive' if isinstance(error,TimeoutError) else 'failed',error=str(error),traceback=traceback.format_exc())
finally:
    if p and p.poll() is None:
        os.killpg(p.pid,signal.SIGTERM)
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=3)
    if master is not None:os.close(master)
    OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
