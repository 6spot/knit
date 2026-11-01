"""Zero-model-request reproduction of startup descriptor versus availability."""
import json,os,subprocess
from pathlib import Path
from pi_rpc_probe import PI,PROVIDER,MODEL
ROOT=Path(__file__).resolve().parents[1]
ENV=dict(os.environ)
for key in ('PI_SESSION_ID','PI_SESSION_FILE','PI_PROVIDER','PI_MODEL','PI_REASONING_LEVEL'):ENV.pop(key,None)
ENV.update(PI_OFFLINE='1',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0')
base=[PI,'--mode','rpc','--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','--no-tools','--no-session','--provider',PROVIDER]
cases=[]
for chosen in (MODEL,'knit-not-a-model-8c923'):
    requests=[{'id':'state','type':'get_state'},{'id':'models','type':'get_available_models'},{'id':'set','type':'set_model','provider':PROVIDER,'modelId':chosen}]
    process=subprocess.run(base+['--model',chosen],input=''.join(json.dumps(x)+'\n' for x in requests),cwd=ROOT/'.work/control-repeat',env=ENV,capture_output=True,text=True,timeout=15)
    responses={}
    for line in process.stdout.splitlines():
        try:obj=json.loads(line)
        except ValueError:continue
        if obj.get('type')=='response':responses[obj.get('id')]=obj
    state=responses.get('state',{}).get('data',{}).get('model',{});models=responses.get('models',{}).get('data',{}).get('models',[])
    cases.append({'requested_model':chosen,'startup_selected':{k:state.get(k) for k in ('provider','id')},'locally_available':any(x.get('provider')==PROVIDER and x.get('id')==chosen for x in models),'RPC_set_model_success':responses.get('set',{}).get('success'),'model_requests':0,'exit_code':process.returncode})
assert cases[0]['locally_available'] and cases[0]['RPC_set_model_success']
assert not cases[1]['locally_available'] and not cases[1]['RPC_set_model_success']
report={'status':'passed','cases':cases,'finding':'Startup can synthesize an unregistered model descriptor. Exact get_state match alone does not establish availability; check registry or call set_model before prompt.'}
(ROOT/'03-edge-cases/model-selection.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
