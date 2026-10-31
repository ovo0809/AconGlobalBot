import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Bootstrap } from '../lib/domain';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'aeconn-share-http-')),'test.sqlite');
process.env.DEMO_PASSWORD='isolated-shared-test-password';
process.env.SHARE_DEMO_MODE='mock';
process.env.LLM_PROVIDER='mock';process.env.VOICE_PROVIDER='mock';process.env.RECORDING_PROVIDER='mock';
process.env.MAIL_MODE='dry_run';
process.env.AI_CASE_BUDGET_USD='8';process.env.AI_DAILY_BUDGET_USD='40';process.env.AI_MONTHLY_BUDGET_USD='160';
const origin='https://example.trycloudflare.com';
process.env.HTTPS_PROXY_ORIGIN=origin;
const service=await import('../lib/service');

class Session {
  cookie='';csrf='';
  async bootstrap(caseId=''){
    const response=service.bootstrap(new Request(`${origin}/api/bootstrap?caseId=${caseId}`,{headers:{cookie:this.cookie}}));
    this.cookie=response.headers.get('set-cookie')?.split(';')[0]??this.cookie;
    const data=await response.json() as Bootstrap;this.csrf=data.csrf;return data;
  }
  async action(body:Record<string,unknown>,headers:Record<string,string>={}){
    let response:Response;
    try{response=await service.action(new Request(`${origin}/api/action`,{method:'POST',headers:{cookie:this.cookie,origin,'x-csrf-token':this.csrf,'content-type':'application/json',...headers},body:JSON.stringify(body)}));}
    catch(error){response=service.errorResponse(error);}
    this.cookie=response.headers.get('set-cookie')?.split(';')[0]??this.cookie;
    return response;
  }
  async login(email:string){await this.bootstrap();return this.action({action:'login',email,password:process.env.DEMO_PASSWORD});}
}

test('public preview exposes only advisor accounts and rejects cross-origin/CSRF requests',async()=>{
  for(const email of ['admin@aeconn.example','charles@aeconn.example'])assert.equal((await new Session().login(email)).status,403);
  const advisor=new Session();assert.equal((await advisor.login('advisor1@aeconn.example')).status,200);
  const state=await advisor.bootstrap();assert.equal(state.sharedDemo,true);assert.equal(state.capabilities.voiceConfigured,false);
  assert.equal(state.reconciliation,undefined);assert.equal(state.users,undefined);
  assert.equal((await advisor.action({action:'logout'},{origin:'https://untrusted.example'})).status,403);
  assert.equal((await advisor.action({action:'logout'},{'x-csrf-token':'wrong'})).status,403);
  assert.equal((await advisor.action({action:'reconcileUsage'})).status,403);
  assert.throws(()=>service.bootstrap(new Request(`${origin}/api/bootstrap?caseId=case-7`,{headers:{cookie:advisor.cookie}})),/无权/);
});

test('shared mock interview, background report, PDF and trash complete without external requests',async()=>{
  const oldFetch=globalThis.fetch;let externalRequests=0;
  globalThis.fetch=async()=>{externalRequests++;throw new Error('External request forbidden in shared preview');};
  try{
    const advisor=new Session();assert.equal((await advisor.login('advisor2@aeconn.example')).status,200);
    await advisor.bootstrap();
    assert.equal((await advisor.action({action:'enterClient',caseId:'case-7'})).status,200);
    await advisor.bootstrap();
    assert.equal((await advisor.action({action:'chooseEntry',entry:'life'})).status,200);
    assert.equal((await advisor.action({action:'voiceToken'})).status,409);
    assert.equal((await advisor.action({action:'message',eventId:'shared-synthetic-answer',text:'我希望了解家庭保障，计划明年开始。'})).status,200);
    assert.equal((await advisor.action({action:'end'})).status,200);
    await service.processReportJobs();
    const state=await advisor.bootstrap('case-7');assert.equal(state.reportJob?.status,'ready');assert.ok(state.reports[0]?.provider.includes('mock'));
    const pdf=service.reportDownload(new Request(`${origin}${state.reports[0].pdfUrl}`,{headers:{cookie:advisor.cookie}}));
    assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
    assert.equal((await advisor.action({action:'deleteCase',caseId:'case-7'})).status,200);
    assert.ok((await advisor.bootstrap()).deletedCases?.some(c=>c.id==='case-7'));
    assert.equal((await advisor.action({action:'restoreCase',caseId:'case-7'})).status,200);
    assert.equal((await advisor.action({action:'deleteCase',caseId:'case-7'})).status,200);
    assert.equal((await advisor.action({action:'purgeCase',caseId:'case-7',confirmation:'永久删除'})).status,200);
    assert.ok(!(await advisor.bootstrap()).deletedCases?.some(c=>c.id==='case-7'));
    assert.equal(externalRequests,0);
  }finally{globalThis.fetch=oldFetch;}
});
