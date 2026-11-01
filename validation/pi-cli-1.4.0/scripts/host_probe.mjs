// Test fixture only. Uses the installed host API; imports no Pi SDK.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const version='v1';
const log=(event,data={})=>fs.appendFileSync(path.join(dir,'host-events.jsonl'),JSON.stringify({time:Date.now(),event,version,...data})+'\n');
export default function(pi){
  let current;
  const timers=new Set();
  pi.on('session_start',(event,ctx)=>{current=ctx;log('session_start',{reason:event.reason,session:ctx.sessionManager.getSessionId()});});
  pi.on('session_shutdown',()=>{for(const timer of timers)clearTimeout(timer);timers.clear();log('shutdown');});
  pi.on('agent_start',()=>log('agent_start'));
  pi.on('agent_end',()=>log('agent_end'));
  pi.on('message_end',(event)=>{
    const message=event.message;
    if(message?.role==='assistant')log('assistant',{text:message.content.filter(x=>x.type==='text').map(x=>x.text).join('')});
    if(message?.role==='custom')log('custom_message',{customType:message.customType});
  });
  pi.registerCommand('knit-probe-status',{description:'Validation status marker',handler:async(args,ctx)=>{pi.appendEntry('knit-validation',{version});log('status',{session:ctx.sessionManager.getSessionId()});}});
  pi.registerCommand('knit-probe-reload',{description:'Reload this temporary fixture',handler:async(args,ctx)=>{log('reload_requested');await ctx.reload();}});
  pi.registerCommand('knit-probe-notify',{description:'Schedule a temporary completion message',handler:async(args,ctx)=>{
    const [mode,token]=args.trim().split(/\s+/);const origin=ctx.sessionManager.getSessionId();
    log('scheduled',{mode,token,origin});
    const timer=setTimeout(()=>{
      timers.delete(timer);
      try{
        const active=current?.sessionManager.getSessionId();
        if(active!==origin){log('dropped_context_changed',{origin,active,token});return;}
        log('callback',{mode,token,idle:current.isIdle(),origin});
        pi.sendMessage({customType:'knit-cli-validation',content:mode==='passive'?'Validation notice '+token:'Reply exactly '+token+' with no tools.',display:true,details:{validation:true}},mode==='queued'?{triggerTurn:true,deliverAs:'followUp'}:{triggerTurn:mode!=='passive'});
        log('sent',{mode,token});
      }catch(error){log('callback_error',{name:error?.name,message:String(error?.message).slice(0,200)});}
    },500);
    timers.add(timer);
  }});
}
