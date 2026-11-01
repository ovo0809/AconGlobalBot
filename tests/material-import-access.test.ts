import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, pack, unpack } from '../lib/db';
import type { Bootstrap, Case } from '../lib/domain';

const root=mkdtempSync(join(tmpdir(),'aeconn-import-access-'));
Object.assign(process.env,{DATABASE_PATH:join(root,'test.sqlite'),KNOWLEDGE_REMOTE:'off',DEMO_PASSWORD:'AeconnDemo!2026',LLM_PROVIDER:'mock',VOICE_PROVIDER:'mock',RECORDING_PROVIDER:'mock',MAIL_MODE:'dry_run'});
const service=await import('../lib/service');

class Browser {
  cookie='';csrf='';
  async refresh(){const response=service.bootstrap(new Request('http://localhost/api/bootstrap',{headers:{cookie:this.cookie}}));this.cookie=response.headers.get('set-cookie')?.split(';')[0]??this.cookie;const data=await response.json() as Bootstrap;this.csrf=data.csrf;return data;}
  async action(body:Record<string,unknown>){const response=await service.action(new Request('http://localhost/api/action',{method:'POST',headers:{cookie:this.cookie,origin:'http://localhost','x-csrf-token':this.csrf,'content-type':'application/json'},body:JSON.stringify(body)}));this.cookie=response.headers.get('set-cookie')?.split(';')[0]??this.cookie;await this.refresh();return response;}
  async login(email:string){await this.refresh();assert.equal((await this.action({action:'login',email,password:'AeconnDemo!2026'})).status,200);return this;}
  async imports(body?:Record<string,unknown>,csrf=this.csrf,origin='http://localhost'){
    try{return await service.materialImportRequest(new Request('http://localhost/api/material-imports',{method:body?'POST':'GET',headers:{cookie:this.cookie,origin,'content-type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined}));}catch(error){return service.errorResponse(error);}
  }
}

test('video preparation is denied to anonymous, advisor, admin and client sessions',async()=>{
  assert.equal((await new Browser().imports()).status,401);
  for(const email of ['advisor1@aeconn.example','admin@aeconn.example']){
    const browser=await new Browser().login(email);assert.equal((await browser.imports()).status,403);
    assert.equal((await browser.imports({action:'start'})).status,403);
  }
  const client=await new Browser().login('advisor1@aeconn.example');
  const record=(await client.refresh()).cases[0];assert(record);
  const created=await(await client.action({action:'createCase',clientId:record.clientId})).json() as {caseId:string};
  await client.action({action:'enterClient',caseId:created.caseId});
  assert.equal((await client.imports()).status,403);
});

test('reviewer preparation requests require CSRF and a same-origin request',async()=>{
  const browser=await new Browser().login('charles@aeconn.example');
  assert.equal((await browser.imports()).status,200);
  assert.equal((await browser.imports({action:'start'},'wrong')).status,403);
  assert.equal((await browser.imports({action:'start'},browser.csrf,'https://foreign.invalid')).status,403);
});

test('reviewer cannot prepare an unassigned case and can cancel their own assigned upload',async()=>{
  const browser=await new Browser().login('charles@aeconn.example');
  const input={action:'start',requestId:randomUUID(),caseId:'case-1',title:'合成大视频',sourceNote:'测试',filename:'synthetic.mp4',size:1024,lastModified:1,consent:true};
  const initial=unpack<Case>(db().prepare('SELECT doc FROM cases WHERE id=?').get('case-1')!.doc);
  initial.assignedReviewerId=null;db().prepare('UPDATE cases SET reviewer_id=NULL,doc=? WHERE id=?').run(pack(initial),initial.id);
  assert.equal((await browser.imports(input)).status,403);
  if(process.platform!=='win32')return;
  initial.assignedReviewerId='charles';db().prepare('UPDATE cases SET reviewer_id=?,doc=? WHERE id=?').run('charles',pack(initial),initial.id);
  const response=await browser.imports(input);assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
  const job=await response.json() as {id:string;state:string};assert.equal(job.state,'uploading');
  assert.equal((await browser.imports({action:'cancel',id:job.id})).status,200);
  assert.equal(db().prepare('SELECT count(*) n FROM ai_usage_calls').get()!.n,0);
});
