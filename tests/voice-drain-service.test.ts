import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { attachVoiceServer } from '../lib/voice-server';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'aeconn-drain-service-')),'test.sqlite');
process.env.LLM_PROVIDER='mock';
process.env.VOICE_PROVIDER='mock';
process.env.AI_CASE_BUDGET_USD='8';
process.env.AI_DAILY_BUDGET_USD='40';
process.env.AI_MONTHLY_BUDGET_USD='160';
const {db,pack}=await import('../lib/db');
const service=await import('../lib/service');

for(const action of ['pause','end'] as const){
  test(`${action} keeps delayed final speech inside the durable persistence window`,async(t)=>{
    const sessionId=`drain-${action}`,caseId=action==='pause'?'case-1':'case-2';
    const bootstrap=service.bootstrap(new Request('http://127.0.0.1/api/bootstrap'));
    const cookie=bootstrap.headers.get('set-cookie')!.split(';')[0];
    const {csrf}=await bootstrap.json() as {csrf:string};
    const auth=db().prepare('SELECT id FROM auth_sessions ORDER BY rowid DESC LIMIT 1').get() as {id:string};
    db().prepare("UPDATE auth_sessions SET user_id='advisor-1',mode='client',active_case=?,active_interview=? WHERE id=?").run(caseId,sessionId,auth.id);
    db().prepare("INSERT INTO interviews(id,case_id,auth_id,state,entry,voice_state,created_at) VALUES(?,?,?,'active','life','listening',?)").run(sessionId,caseId,auth.id,new Date().toISOString());

    const upstream=new WebSocketServer({host:'127.0.0.1',port:0});
    await new Promise<void>(resolve=>upstream.once('listening',resolve));
    const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
    let provider:WebSocket|undefined,resolveReady!:()=>void;
    const ready=new Promise<void>(resolve=>{resolveReady=resolve;});
    upstream.on('connection',socket=>{
      provider=socket;
      socket.send(pack({type:'session.created'}));
      socket.on('message',data=>{
        const event=JSON.parse(data.toString());
        if(event.type==='session.update')socket.send(pack({type:'session.updated'}));
        if(event.type==='response.create'){
          socket.send(pack({type:'response.created',response:{id:`response-${action}`}}));
          socket.send(pack({type:'input_audio_buffer.speech_started',item_id:`input-${action}`}));
          socket.send(pack({type:'input_audio_buffer.speech_stopped',item_id:`input-${action}`}));
          socket.send(pack({type:'input_audio_buffer.committed',item_id:`input-${action}`}));
          resolveReady();
        }
      });
    });
    const server=createServer();
    const relay=attachVoiceServer(server,{...service.voiceHooks,consumeToken:()=>({sessionId,caseId})},{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'synthetic',model:'gpt-realtime-2.1',transcriptionModel:'whisper-1'}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
    const address=server.address();assert(address&&typeof address!=='string');
    const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=synthetic`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
    browser.on('error',()=>undefined);await ready;
    const started=Date.now();
    const ending=service.action(new Request('http://127.0.0.1/api/action',{method:'POST',headers:{cookie,origin:'http://127.0.0.1','x-csrf-token':csrf,'content-type':'application/json'},body:pack({action,caseId})}));
    const delayed=setTimeout(()=>{
      if(provider?.readyState!==WebSocket.OPEN)return;
      provider.send(pack({type:'conversation.item.input_audio_transcription.completed',item_id:`input-${action}`,transcript:'我每月的预算是五百美元。',usage:{type:'duration',seconds:2}}));
      provider.send(pack({type:'response.done',response:{id:`response-${action}`,usage:{input_tokens:0,output_tokens:0,input_token_details:{text_tokens:0,audio_tokens:0,cached_tokens:0},output_token_details:{text_tokens:0,audio_tokens:0}}}}));
    },2_100);
    t.after(()=>clearTimeout(delayed));
    const response=await ending;assert.equal(response.status,200);
    assert(Date.now()-started>=2_100,'must drain beyond the old 1.5 second timeout');
    const messages=db().prepare("SELECT doc FROM messages WHERE session_id=? AND role='user'").all(sessionId);
    assert.equal(messages.length,1,'the late final must survive the HTTP end/pause deadline');
    assert.equal(JSON.parse(String(messages[0].doc)).final,true);
    const usage=db().prepare('SELECT status,actual_micros FROM ai_usage_calls WHERE session_id=?').get(sessionId);
    assert.equal(usage?.status,'settled');assert.equal(usage.actual_micros,200);
    service.voiceHooks.persist(sessionId,{role:'user',text:'结束后不应保存',eventId:`late-${action}`,turnId:'late',final:true});
    assert.equal(db().prepare('SELECT COUNT(*) n FROM messages WHERE session_id=?').get(sessionId)?.n,1);
    if(action==='end')assert.equal(db().prepare('SELECT status FROM report_jobs WHERE case_id=?').get(caseId)?.status,'queued');
  });
}
