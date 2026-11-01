"""Repeat control-plane checks without any model requests; capture exact guards."""
import json,os,re,shutil,subprocess,time,uuid
from pathlib import Path
from pi_rpc_probe import PI,PROVIDER,MODEL,PiCLI,running,stop_marked
ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.work'/'control-repeat';WORK.mkdir(parents=True)
RESULT={'model_requests':0,'sdk_imported':False};obj=None;pid=None;nonce='KNIT_RPC_BASH_'+uuid.uuid4().hex
try:
    (WORK/'AGENTS.md').write_text('CANARY_CONTEXT_MUST_NOT_LOAD_'+nonce)
    ext=WORK/'.pi'/'extensions';ext.mkdir(parents=True)
    (ext/'blocked.ts').write_text("import fs from 'node:fs';export default function(pi){fs.writeFileSync('extension-was-loaded.txt','unexpected');pi.registerCommand('canary-blocked',{handler:async()=>{}})}")
    obj=PiCLI(WORK,'control-repeat',isolated=True)
    for command in ('get_state','get_messages','get_entries','get_tree'):assert obj.call(command)['success']
    commands=obj.call('get_commands').get('data',{}).get('commands',[])
    assert not any(x.get('name')=='canary-blocked' for x in commands) and not (WORK/'extension-was-loaded.txt').exists()
    RESULT['project_extension_disabled']=True
    result=obj.call('bash',command='printf knit-control-plane',excludeFromContext=True)['data'];assert result['exitCode']==0 and result['output']=='knit-control-plane'
    rid=obj.send('bash',command="python3 -u -c 'import os,time;print(\""+nonce+" \"+str(os.getpid()),flush=True);time.sleep(120)'",excludeFromContext=True)
    def find():
        global pid
        for e in obj.events:
            match=re.search(re.escape(nonce)+r'\s+(\d+)',json.dumps(e))
            if match:pid=int(match[1]);return True
        return False
    obj.until(find,seconds=10)
    obj.call('abort_bash');obj.until(lambda:rid in obj.responses,seconds=10)
    response=obj.responses.pop(rid);assert response['success'] and response['data']['cancelled'] and not running(pid)
    RESULT.update(explicit_bash_executed=True,explicit_bash_cancelled=True,child_terminated=True)
    before=obj.refresh()['sessionId'];missing=WORK/'does-not-exist.jsonl'
    opened=obj.call('switch_session',allow_failure=True,sessionPath=str(missing))
    after=obj.refresh();messages=obj.call('get_messages')['data']['messages']
    RESULT['missing_session']={'command_success':opened.get('success'),'session_id_changed':after['sessionId']!=before,'messages':len(messages),'file_created':missing.exists()}
    stats=obj.stats();assert not stats.get('assistant_messages') and stats['tokens'].get('total',0)==0
    RESULT['model_tokens']=0
    obj.close();RESULT['EOF_exit_code']=obj.p.returncode;assert obj.p.returncode==0
    RESULT['status']='passed'
finally:
    stop_marked(pid,nonce)
    if obj:obj.close()

# Startup selection errors must be inspected before sending a model prompt.
env=dict(os.environ)
for key in ('PI_SESSION_ID','PI_SESSION_FILE','PI_PROVIDER','PI_MODEL','PI_REASONING_LEVEL'):env.pop(key,None)
env.update(PI_OFFLINE='1',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0')
base=[PI,'--mode','rpc','--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','--no-tools','--no-session']
RESULT['startup_invalid_selection']=[]
for provider,model in [('knit-not-a-provider','knit-not-a-model'),(PROVIDER,'knit-not-a-model-8c923')]:
    proc=subprocess.run(base+['--provider',provider,'--model',model],input='{"id":"state","type":"get_state"}\n',cwd=WORK,env=env,capture_output=True,text=True,timeout=15)
    state=None
    for line in proc.stdout.splitlines():
        try:o=json.loads(line)
        except ValueError:continue
        if o.get('command')=='get_state':state=o.get('data',{}).get('model',{})
    RESULT['startup_invalid_selection'].append({'requested_provider':provider,'requested_model':model,'exit_code':proc.returncode,'selected_model':None if state is None else {k:state.get(k) for k in ('provider','id')},'fallback_detected':state is not None and (state.get('provider'),state.get('id'))!=(provider,model),'stderr_present':bool(proc.stderr)})
(ROOT/'03-edge-cases'/'control-repeat.json').write_text(json.dumps(RESULT,ensure_ascii=False,indent=2)+'\n');print(json.dumps(RESULT,ensure_ascii=False,indent=2))
