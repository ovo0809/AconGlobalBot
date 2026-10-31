import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Bootstrap } from '../lib/domain';
import { stampSharedLiveMarker, writeSharedLiveConfig, type SharedLiveConfig } from '../lib/shared-live-access';
import { createSharedLiveTesters } from '../scripts/shared-live-runtime';

const dir=mkdtempSync(join(tmpdir(),'aeconn-live-scope-'));
process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SHARED_LIVE_CONFIG_PATH=join(dir,'live.json');
process.env.DEMO_PASSWORD='test-only-local-password';process.env.LLM_PROVIDER='mock';process.env.VOICE_PROVIDER='openai';
process.env.OPENAI_API_KEY='test-only-not-a-real-key';process.env.OPENAI_REALTIME_MODEL='gpt-realtime-2.1';process.env.OPENAI_TRANSCRIPTION_MODEL='whisper-1';
process.env.AI_CASE_BUDGET_USD='8';process.env.AI_DAILY_BUDGET_USD='40';process.env.AI_MONTHLY_BUDGET_USD='160';
delete process.env.HTTPS_PROXY_ORIGIN;
const {db}=await import('../lib/db');db();
const runId=randomUUID(),testers=createSharedLiveTesters(process.env.DATABASE_PATH,runId);
const config:SharedLiveConfig={enabled:true,runId,origin:'https://scope-test.trycloudflare.com',port:3003,testerUserIds:testers.userIds,expiresAt:new Date(Date.now()+60_000).toISOString()};writeSharedLiveConfig(config);
const service=await import('../lib/service');
let externalRequests=0;globalThis.fetch=async()=>{externalRequests++;throw new Error('Network forbidden in scope tests');};

class Session{
  cookie='';csrf='';lastSetCookie='';
  constructor(public config:SharedLiveConfig|null=null){}
  request(path:string,body?:Record<string,unknown>,extra:Record<string,string>={}){
    const origin=this.config?.origin??'http://127.0.0.1:3000';
    const headers=new Headers({cookie:this.cookie,origin,'x-csrf-token':this.csrf,'content-type':'application/json',...extra});
    if(this.config)stampSharedLiveMarker(headers,this.config);
    return new Request(origin+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  }
  async bootstrap(caseId=''){
    const response=service.bootstrap(this.request('/api/bootstrap?caseId='+caseId));this.lastSetCookie=response.headers.get('set-cookie')??'';this.cookie=this.lastSetCookie.split(';')[0]||this.cookie;
    const data=await response.json() as Bootstrap;this.csrf=data.csrf;return data;
  }
  async action(body:Record<string,unknown>,extra:Record<string,string>={}){
    let response:Response;try{response=await service.action(this.request('/api/action',body,extra));}catch(error){response=service.errorResponse(error);}
    if(response.headers.get('set-cookie')){this.lastSetCookie=response.headers.get('set-cookie')!;this.cookie=this.lastSetCookie.split(';')[0];}
    return {status:response.status,body:await response.json()};
  }
  async login(email:string,password:string){await this.bootstrap();return this.action({action:'login',email,password});}
}
const a=new Session(config),b=new Session(config),local=new Session();let caseA='',caseB='',sessionA='';

test('public HTTP sessions reject local accounts, local cookies and cross-case reads without exposing usage',async()=>{
  for(const email of ['advisor1','advisor2','charles','admin'])assert.equal((await new Session(config).login(email+'@aeconn.example',process.env.DEMO_PASSWORD!)).status,401);
  assert.equal((await new Session().login(testers.credentials[0].email,testers.credentials[0].password)).status,401);
  assert.equal((await local.login('advisor1@aeconn.example',process.env.DEMO_PASSWORD!)).status,200);
  assert.equal((await a.login(testers.credentials[0].email,testers.credentials[0].password)).status,200);assert.match(a.lastSetCookie,/Secure/);
  assert.equal((await b.login(testers.credentials[1].email,testers.credentials[1].password)).status,200);
  for(const user of [a,b]){const state=await user.bootstrap();assert.equal(state.publicAccess,true);assert.equal(state.usage,undefined);assert.equal(state.reconciliation,undefined);assert.equal(state.cases.length,0);}
  const replayPublic=new Session(config);replayPublic.cookie=local.cookie;assert.equal((await replayPublic.bootstrap()).mode,'anonymous');
  const replayLocal=new Session();replayLocal.cookie=a.cookie;assert.equal((await replayLocal.bootstrap()).mode,'anonymous');
  for(const [index,user] of [a,b].entries()){
    const result=await user.action({action:'createClient',name:`共享合成${index}`,birthday:'1980-01-01',gender:'不指定',phone:'+12025550101',email:'synthetic@example.invalid',maritalStatus:'已婚'});assert.equal(result.status,200);if(index===0)caseA=result.body.caseId;else caseB=result.body.caseId;
  }
  assert.throws(()=>service.bootstrap(b.request('/api/bootstrap?caseId='+caseA)),/无权/);
  assert.throws(()=>service.bootstrap(a.request('/api/bootstrap?caseId=case-1')),/无权/);
  assert.equal((await a.bootstrap(caseA)).usage,undefined);
  assert.equal((await a.action({action:'reconcileUsage'})).status,403);
  for(const method of ['GET','POST']){
    await assert.rejects(()=>service.recordingRequest(a.request('/api/recording?caseId='+caseA,method==='POST'?{action:'start',consent:true}:undefined)),/共享语音测试仅开放/);
  }
  assert.equal((await a.action({action:'logout'},{origin:'https://evil.example'})).status,403);
  assert.equal((await a.action({action:'logout'},{'x-csrf-token':'wrong'})).status,403);
});

test('voice tokens are bound to listener and sharing run without consuming mismatched tokens',async()=>{
  for(const [user,caseId] of [[a,caseA],[local,'case-1']] as const){await user.bootstrap();assert.equal((await user.action({action:'enterClient',caseId})).status,200);await user.bootstrap();assert.equal((await user.action({action:'chooseEntry',entry:'life'})).status,200);}
  sessionA=(await a.bootstrap()).clientSession!.id;
  const publicToken=(await a.action({action:'voiceToken'})).body.token,localToken=(await local.action({action:'voiceToken'})).body.token;
  assert.equal(service.voiceHooks.consumeToken(publicToken),null);
  assert.equal(service.voiceHooks.consumeToken(localToken,{audience:'public',runId}),null);
  assert.equal(service.voiceHooks.consumeToken(publicToken,{audience:'public',runId:'old-run'}),null);
  assert.equal(service.voiceHooks.consumeToken(publicToken,{audience:'public',runId})?.caseId,caseA);
  assert.equal(service.voiceHooks.consumeToken(localToken)?.caseId,'case-1');
});

test('local unknown holds and both public testers share the same atomic organization budget',async()=>{
  const usage=await import('../lib/ai-usage');
  for(let i=1;i<=5;i++){const r=usage.beginUsage({context:{caseId:`case-${i}`},operation:'interview',model:'gpt-6-luna',reserveMicros:i===5?6_000_000:8_000_000});usage.completeUsage(r.id,'unknown');}
  const first=usage.beginUsage({context:{caseId:caseA},operation:'interview',model:'gpt-6-luna',reserveMicros:1_500_000});
  assert.throws(()=>usage.beginUsage({context:{caseId:caseB},operation:'interview',model:'gpt-6-luna',reserveMicros:1_500_000}),/费用上限/);
  const summary=usage.getUsageSummary('org-demo',caseA);assert.equal(summary.day.heldMicros,39_500_000);assert.equal(summary.day.remainingMicros,500_000);assert.equal(first.reservedMicros,1_500_000);
  assert.equal(externalRequests,0);
});

test('disabled/changed runs invalidate public sessions and tokens while local interview stays active',async()=>{
  const token=(await a.action({action:'voiceToken'})).body.token;
  const localSession=(await local.bootstrap()).clientSession!.id;
  writeFileSync(process.env.SHARED_LIVE_CONFIG_PATH!,JSON.stringify({enabled:false,runId}));
  assert.equal(service.voiceHooks.isActive(sessionA),false);assert.equal(service.voiceHooks.isActive(localSession),true);
  assert.equal(service.voiceHooks.consumeToken(token,{audience:'public',runId}),null);
  const next={...config,runId:randomUUID()};writeSharedLiveConfig(next);
  const later=new Session(next);later.cookie=a.cookie;assert.equal((await later.bootstrap()).mode,'anonymous');
  assert.equal((await later.login(testers.credentials[0].email,testers.credentials[0].password)).status,401);
});
