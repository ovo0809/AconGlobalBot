import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Bootstrap } from '../lib/domain';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'aeconn-reconciliation-http-')),'service.sqlite');
process.env.DEMO_PASSWORD='AeconnDemo!2026';
process.env.LLM_PROVIDER='mock';process.env.VOICE_PROVIDER='mock';
process.env.AI_CASE_BUDGET_USD='8';process.env.AI_DAILY_BUDGET_USD='40';process.env.AI_MONTHLY_BUDGET_USD='160';
const origin='http://localhost:3000';
const servicePromise=import('../lib/service');
const usagePromise=import('../lib/ai-usage');
const reconciliationPromise=import('../lib/usage-reconciliation');

class Session {
  cookie='';csrf='';
  async bootstrap(){
    const service=await servicePromise,response=service.bootstrap(new Request(`${origin}/api/bootstrap`,{headers:{cookie:this.cookie}}));
    if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie')!.split(';')[0];
    const data=await response.json() as Bootstrap;this.csrf=data.csrf;return data;
  }
  async action(input:Record<string,unknown>,overrides:Record<string,string>={}){
    const service=await servicePromise;let response:Response;
    try{response=await service.action(new Request(`${origin}/api/action`,{method:'POST',headers:{cookie:this.cookie,'x-csrf-token':this.csrf,origin,'content-type':'application/json',...overrides},body:JSON.stringify(input)}));}
    catch(error){response=service.errorResponse(error);}
    if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie')!.split(';')[0];
    return {status:response.status,data:await response.json()};
  }
  async login(email:string){await this.bootstrap();assert.equal((await this.action({action:'login',email,password:'AeconnDemo!2026'})).status,200);return this.bootstrap();}
}

test('reconciliation endpoints enforce admin, client-mode, CSRF and same-origin boundaries',async()=>{
  const usage=await usagePromise,call=usage.beginUsage({context:{caseId:'case-1'},operation:'interview',model:'gpt-6-luna'});
  usage.completeUsage(call.id,'unknown');
  const anonymous=new Session();assert.equal((await anonymous.action({action:'reconcileUsage'})).status,401);
  for(const email of ['advisor1@aeconn.example','charles@aeconn.example']){
    const user=new Session(),state=await user.login(email);assert.equal(state.reconciliation,undefined);
    for(const action of ['reconcileUsage','previewUsageSettlement','settleUsage'])assert.equal((await user.action({action,callId:call.id})).status,403);
  }
  const advisor=new Session();await advisor.login('advisor1@aeconn.example');
  assert.equal((await advisor.action({action:'enterClient',caseId:'case-2'})).status,200);
  assert.equal((await advisor.bootstrap()).reconciliation,undefined);
  assert.equal((await advisor.action({action:'settleUsage',callId:call.id})).status,403);
  const admin=new Session(),state=await admin.login('admin@aeconn.example');
  assert(state.reconciliation?.pending.some(item=>item.id===call.id));
  assert.deepEqual(state.clients,[]);assert.deepEqual(state.cases,[]);assert.equal(state.activeCase,null);
  const text=JSON.stringify(state.reconciliation);assert(!text.includes('case-1'));assert(!text.includes('sessionId'));assert(!text.includes('clientName'));
  assert.equal((await admin.action({action:'reconcileUsage'},{'x-csrf-token':'wrong'})).status,403);
  assert.equal((await admin.action({action:'reconcileUsage'},{origin:'https://foreign.invalid'})).status,403);
  const result=await admin.action({action:'reconcileUsage'});assert.equal(result.status,200);assert.equal(result.data.result,0);
  assert.equal((await admin.bootstrap()).reconciliation?.pending.find(item=>item.id===call.id)?.status,'unknown');
});

test('admin preview is read-only; explicit commit is idempotent and stale data stays protected',async()=>{
  const usage=await usagePromise,call=usage.beginUsage({context:{caseId:'case-3'},operation:'report',model:'gpt-6-luna'});
  usage.completeUsage(call.id,'unknown');
  const admin=new Session();await admin.login('admin@aeconn.example');
  const pending=(await admin.bootstrap()).reconciliation!.pending.find(item=>item.id===call.id)!;
  const fields={callId:call.id,version:pending.version,amountUsd:'0',evidenceRef:'Synthetic official rejection request test-03',note:'隔离合成凭据，确认请求未开始计费。',previewToken:''};
  const preview=await admin.action({action:'previewUsageSettlement',...fields});assert.equal(preview.status,200);fields.previewToken=preview.data.preview.previewToken;
  assert.equal((await admin.bootstrap()).reconciliation?.pending.find(item=>item.id===call.id)?.status,'unknown');
  assert.equal((await admin.action({action:'settleUsage',...fields,requestId:'test-manual-03',confirmed:false})).status,400);
  assert.equal((await admin.action({action:'settleUsage',...fields,previewToken:'',requestId:'no-preview',confirmed:true})).status,409);
  assert.equal((await admin.action({action:'settleUsage',...fields,amountUsd:'1',requestId:'tampered-preview',confirmed:true})).status,409);
  assert.equal((await admin.action({action:'settleUsage',...fields,evidenceRef:'changed evidence',requestId:'tampered-evidence',confirmed:true})).status,409);
  const first=await admin.action({action:'settleUsage',...fields,requestId:'test-manual-03',confirmed:true});assert.equal(first.status,200);assert.equal(first.data.result.releasedMicros,50_000);
  assert.deepEqual(await admin.action({action:'settleUsage',...fields,requestId:'test-manual-03',confirmed:true}),first);
  assert.equal((await admin.action({action:'settleUsage',...fields,amountUsd:'1',requestId:'test-manual-03',confirmed:true})).status,409);
  const after=await admin.bootstrap();assert(!after.reconciliation?.pending.some(item=>item.id===call.id));
  assert.equal(after.reconciliation?.history.filter(item=>item.callId===call.id).length,1);
  const late=usage.beginUsage({context:{caseId:'case-4'},operation:'report',model:'gpt-6-luna'});usage.completeUsage(late.id,'unknown');
  const old=(await admin.bootstrap()).reconciliation!.pending.find(item=>item.id===late.id)!;
  const lateFields={...fields,callId:late.id,version:old.version};
  lateFields.previewToken=(await admin.action({action:'previewUsageSettlement',...lateFields})).data.preview.previewToken;
  usage.recordUsage(late.id,'late-final','responses',{input_tokens:100,output_tokens:100});
  assert.equal((await admin.action({action:'settleUsage',...lateFields,requestId:'stale-04',confirmed:true})).status,409);
});

test('background reconciliation recovers a durable completion after restart without model requests',async()=>{
  const usage=await usagePromise,reconciliation=await reconciliationPromise,service=await servicePromise;
  const call=usage.beginUsage({context:{caseId:'case-5'},operation:'report',model:'gpt-6-luna'});
  usage.recordUsage(call.id,'complete-receipt','responses',{input_tokens:100,output_tokens:100});
  reconciliation.recordUsageCompletion(call.id,'settled');usage.recoverUsageReservations();
  assert.equal(service.processUsageReconciliation('org-demo'),1);assert.equal(service.processUsageReconciliation('org-demo'),0);
  const state=reconciliation.getReconciliationOverview('org-demo');assert.equal(state.history.find(item=>item.callId===call.id)?.method,'automatic');
  assert.deepEqual(state.limits,{caseMicros:8_000_000,dailyMicros:40_000_000,monthlyMicros:160_000_000});
});
