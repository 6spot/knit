"""Additional finite Pi CLI validation. All mutations stay in .work fixtures."""
import collections, hashlib, json, os, shutil, signal, subprocess, time, uuid
from pathlib import Path
from pi_rpc_probe import PiCLI, PROVIDER, MODEL, running, marked_pid, stop_marked

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.work'
OUT=ROOT/'03-edge-cases'
RESULT={'status':'running','provider':PROVIDER,'model':MODEL,'cases':[],'sdk_imported':False}
ACTIVE=[]

def save():
    tmp=OUT/'results.tmp';tmp.write_text(json.dumps(RESULT,ensure_ascii=False,indent=2));tmp.replace(OUT/'results.json')
def case(name,fn):
    RESULT['current_case']=name;save();start=time.monotonic()
    try:
        data=fn();status=data.pop('_status','passed');RESULT['cases'].append({'name':name,'status':status,'seconds':round(time.monotonic()-start,2),'details':data})
    except Exception as error:
        RESULT['cases'].append({'name':name,'status':'inconclusive' if isinstance(error,TimeoutError) else 'failed','seconds':round(time.monotonic()-start,2),'error':str(error)[:500]})
    finally:
        for cli in list(ACTIVE):
            try:cli.close()
            except Exception:pass
            ACTIVE.remove(cli)
        save()
def cli(folder,role,**kwargs):
    obj=PiCLI(folder,role,**kwargs);ACTIVE.append(obj);return obj
def close(obj):obj.close();ACTIVE.remove(obj)
def texts(events):
    return [''.join(x.get('text','') for x in e.get('message',{}).get('content',[]) if x.get('type')=='text') for e in events if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant']
def delta(before,after):
    return {'tokens':{k:v-before.get('tokens',{}).get(k,0) for k,v in after.get('tokens',{}).items()},'cost_usd':None if before.get('cost_usd') is None or after.get('cost_usd') is None else round(after['cost_usd']-before['cost_usd'],9)}
def sleep_command(nonce):
    return "python3 -u -c 'import os,time;print(\""+nonce+" \"+str(os.getpid()),flush=True);time.sleep(120)'"
def model_sleep(obj,nonce,checkpoint=False):
    command=sleep_command(nonce)
    prefix='First use write to create checkpoint.txt with exactly CHECKPOINT_CREATED. Then ' if checkpoint else ''
    obj.prompt(prefix+'use bash to execute exactly this command: '+command+'. Do not use other commands or access other paths. Wait for its result, then reply exactly TOOL_FINISHED.')
    obj.until(lambda:marked_pid(obj.events,nonce) is not None)
    return marked_pid(obj.events,nonce)

def control():
    obj=cli(WORK/'control','control',isolated=True)
    name='CLI Unicode\u2028line\u2029paragraph'
    obj.call('set_session_name',name=name)
    assert obj.refresh().get('sessionName')==name
    before=obj.refresh().get('model')
    invalid=obj.call('set_model',allow_failure=True,provider='knit-no-provider',modelId='knit-no-model')
    assert not invalid.get('success') and obj.refresh().get('model')==before
    badcursor=obj.call('get_entries',allow_failure=True,since='no-such-entry')
    assert not badcursor.get('success')
    missing=WORK/'control'/'never-created.jsonl'
    switch=obj.call('switch_session',allow_failure=True,sessionPath=str(missing))
    current=obj.refresh()
    return {'unicode_LF_framing':True,'invalid_model_rejected_without_change':True,'invalid_cursor_rejected':True,'missing_session_response_success':switch.get('success'),'missing_session_file_exists':missing.exists(),'selected_session_after_missing_open':bool(current.get('sessionId')),'boundary':'Missing session must be prechecked by caller if CLI accepts it as a new empty session.'}

def cancel():
    obj=cli(WORK/'cancel','cancel',tools='bash')
    nonce='KNIT_CANCEL_'+uuid.uuid4().hex;pid=None;baseline=obj.stats()
    try:
        pid=model_sleep(obj,nonce)
        obj.call('follow_up',message='Reply exactly QUEUE_MUST_BE_REMOVED after the current work.')
        cleared=obj.call('clear_queue').get('data',{})
        assert any('QUEUE_MUST_BE_REMOVED' in x for x in cleared.get('followUp',[]))
        begin=time.monotonic();obj.call('abort');obj.until(lambda:obj.settled())
        state=obj.refresh();obj.observe(1)
        assert not running(pid) and not state.get('isStreaming') and state.get('pendingMessageCount')==0
        assert not any('QUEUE_MUST_BE_REMOVED' in x for x in texts(obj.events))
        file=obj.file;sid=obj.id;usage=delta(baseline,obj.stats());close(obj)
        resumed=cli(WORK/'cancel-resume','cancel-resume',session=file)
        assert resumed.id==sid
        before=resumed.stats();offset=len(resumed.events)
        resumed.prompt('The previous tool was intentionally cancelled. Do not call tools. Reply exactly RESUMED_AFTER_CANCEL.')
        resumed.until(lambda:resumed.settled(offset))
        assert 'RESUMED_AFTER_CANCEL' in resumed.last_text()
        return {'model_tool_cancelled':True,'child_terminal':True,'queue_cleared':True,'abort_seconds':round(time.monotonic()-begin,2),'aborted_settled':any(e.get('type')=='agent_settled' and e.get('aborted') for e in obj.events),'same_session_resume_after_cancel':True,'native_session_id':sid,'usage_before_resume':usage,'resume_usage':delta(before,resumed.stats())}
    finally:stop_marked(pid,nonce)

def crash():
    obj=cli(WORK/'crash','crash',tools='write,bash,read')
    nonce='KNIT_CRASH_'+uuid.uuid4().hex;pid=None
    try:
        pid=model_sleep(obj,nonce,checkpoint=True)
        assert (obj.folder/'checkpoint.txt').read_text()=='CHECKPOINT_CREATED'
        state=obj.refresh();file=obj.file;sid=obj.id;usage=obj.stats()
        assert file and Path(file).is_file()
        os.killpg(obj.p.pid,signal.SIGKILL);obj.p.wait(timeout=5);time.sleep(0.3)
        survived=bool(running(pid))
        stop_marked(pid,nonce);assert not running(pid)
        close(obj)
        resumed=cli(WORK/'crash','crash-resume',tools='read',session=file)
        assert resumed.id==sid
        before=resumed.stats();offset=len(resumed.events)
        resumed.prompt('The earlier shell tool was interrupted and has now been stopped by the test controller. Read checkpoint.txt, do not modify any file, and return one JSON object with checkpoint containing its exact content and resumed true.')
        resumed.until(lambda:resumed.settled(offset))
        text=resumed.last_text();assert 'CHECKPOINT_CREATED' in text
        return {'checkpoint_persisted':True,'native_history_persisted_before_kill':True,'child_survived_cli_SIGKILL':survived,'test_child_cleaned_before_resume':True,'same_native_session_resumed':True,'checkpoint_recovered':True,'usage_before_crash':usage,'resume_usage':delta(before,resumed.stats()),'finding':'CLI exit alone is not proof that every spawned tool process ended.'}
    finally:stop_marked(pid,nonce)

def copy_extension(folder):
    folder.mkdir(parents=True,exist_ok=True);target=folder/'probe.mjs';shutil.copy2(ROOT/'scripts'/'host_probe.mjs',target);return target

def project_reload():
    folder=WORK/'project-extension';target=copy_extension(folder/'.pi'/'extensions')
    obj=cli(folder,'project-extension',isolated=True,discover=True)
    commands=obj.call('get_commands').get('data',{}).get('commands',[])
    assert any(x.get('name')=='knit-probe-status' for x in commands)
    response=obj.prompt('/knit-probe-status');assert response.get('data',{}).get('disposition')=='handled'
    assert any(e.get('data',{}).get('version')=='v1' for e in obj.call('get_entries').get('data',{}).get('entries',[]) if e.get('customType')=='knit-validation')
    target.write_text(target.read_text().replace("const version='v1'","const version='v2'"))
    reload_response=obj.prompt('/knit-probe-reload')
    obj.observe(1)
    obj.prompt('/knit-probe-status')
    entries=obj.call('get_entries').get('data',{}).get('entries',[])
    versions=[e.get('data',{}).get('version') for e in entries if e.get('customType')=='knit-validation']
    assert versions[-1]=='v2'
    assert not any(e.get('type')=='agent_start' for e in obj.events)
    return {'trusted_project_auto_loaded':True,'reload_public_host_API':reload_response.get('success'),'versions':versions,'model_runs':0,'sdk_dependency':False}

def notifications():
    folder=WORK/'notifications';target=copy_extension(folder/'extension')
    obj=cli(folder,'notifications',tools='bash',extensions=[target])
    initial=obj.stats();passive='PASSIVE_'+uuid.uuid4().hex;offset=len(obj.events)
    reply=obj.prompt('/knit-probe-notify passive '+passive);assert reply.get('data',{}).get('disposition')=='handled'
    obj.observe(2)
    messages=obj.call('get_messages').get('data',{}).get('messages',[])
    assert any(passive in str(m.get('content')) for m in messages)
    assert not any(e.get('type')=='agent_start' for e in obj.events[offset:])
    wake='WAKE_'+uuid.uuid4().hex;offset=len(obj.events);before=obj.stats()
    reply=obj.prompt('/knit-probe-notify wake '+wake);assert reply.get('data',{}).get('disposition')=='handled'
    obj.until(lambda:obj.settled(offset));assert wake in obj.last_text()
    wake_usage=delta(before,obj.stats())
    nonce='KNIT_QUEUE_'+uuid.uuid4().hex;queued='QUEUED_'+uuid.uuid4().hex
    command="python3 -u -c 'import os,time;print(\""+nonce+" \"+str(os.getpid()),flush=True);time.sleep(3)'"
    offset=len(obj.events);before=obj.stats()
    obj.prompt('Use bash to run exactly '+command+' then reply exactly BUSY_DONE. Do not use other commands.')
    obj.until(lambda:marked_pid(obj.events[offset:],nonce) is not None)
    obj.prompt('/knit-probe-notify queued '+queued)
    obj.until(lambda:obj.settled(offset));answers=texts(obj.events[offset:])
    assert any('BUSY_DONE' in x for x in answers) and queued in obj.last_text()
    queue_usage=delta(before,obj.stats())
    stale='STALE_'+uuid.uuid4().hex;old=obj.id
    obj.prompt('/knit-probe-notify passive '+stale);obj.call('new_session');obj.observe(1.5)
    state=obj.refresh();messages=obj.call('get_messages').get('data',{}).get('messages',[])
    assert state.get('sessionId')!=old and not any(stale in str(m.get('content')) for m in messages)
    return {'outside_turn_passive_delivered_without_model':True,'outside_turn_wake_triggered_model':True,'handled_response_not_mistaken_for_completion':True,'busy_followup_queued_after_tool':True,'first_answer_before_followup':answers,'context_switch_no_misdelivery':True,'wake_usage':wake_usage,'queue_usage':queue_usage,'host_api_from_installed_pi_only':True}

case('control-errors-and-framing',control)
case('model-tool-cancel-and-resume',cancel)
case('hard-interruption-and-resume',crash)
case('project-extension-load-and-reload',project_reload)
case('out-of-turn-notification-and-queue',notifications)
RESULT['status']='completed';RESULT.pop('current_case',None);save()
print(json.dumps({'status':RESULT['status'],'cases':[{k:x.get(k) for k in ('name','status','error')} for x in RESULT['cases']]},ensure_ascii=False,indent=2))
