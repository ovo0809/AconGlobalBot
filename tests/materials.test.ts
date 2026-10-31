import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Bootstrap } from '../lib/domain';
import type { MaterialDetail } from '../lib/material-types';
import { db, pack } from '../lib/db';
import { processMaterialJobs, recoverMaterialJobs, approvedMaterialDocuments, validateMaterialImage } from '../lib/materials';
import { loadCaseKnowledge } from '../lib/material-knowledge';
import { publicKnowledgeContext, safeMaterialSourceUrl } from '../lib/knowledge-public';
import { encodeRecordingWav } from '../lib/recording-audio';
import { getUsageSummary } from '../lib/ai-usage';
const root=mkdtempSync(join(tmpdir(),'aeconn-materials-'));
Object.assign(process.env,{DATABASE_PATH:join(root,'test.sqlite'),KNOWLEDGE_REMOTE:'off',KNOWLEDGE_LOCAL_DIR:root,DEMO_PASSWORD:'AeconnDemo!2026',LLM_PROVIDER:'mock',VOICE_PROVIDER:'mock',RECORDING_PROVIDER:'mock',MAIL_MODE:'dry_run',AI_CASE_BUDGET_USD:'8',AI_DAILY_BUDGET_USD:'40',AI_MONTHLY_BUDGET_USD:'160'});
const service=await import('../lib/service');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
class Browser {
  cookie='';csrf='';
  async refresh(){const r=service.bootstrap(new Request('http://localhost/api/bootstrap',{headers:{cookie:this.cookie}}));this.cookie=r.headers.get('set-cookie')?.split(';')[0]??this.cookie;const data=await r.json() as Bootstrap;this.csrf=data.csrf;return data;}
  async action(input:Record<string,unknown>){let r:Response;try{r=await service.action(new Request('http://localhost/api/action',{method:'POST',headers:{cookie:this.cookie,origin:'http://localhost','content-type':'application/json','x-csrf-token':this.csrf},body:JSON.stringify(input)}));}catch(e){r=service.errorResponse(e);}this.cookie=r.headers.get('set-cookie')?.split(';')[0]??this.cookie;return r;}
  async login(email='advisor1@aeconn.example'){await this.refresh();assert.equal((await this.action({action:'login',email,password:'AeconnDemo!2026'})).status,200);await this.refresh();return this;}
  async request(body?:FormData|Record<string,unknown>,query='',headers:Record<string,string>={}){const multipart=body instanceof FormData;try{return await service.materialsRequest(new Request(`http://localhost/api/materials${query}`,{method:body?'POST':'GET',headers:{cookie:this.cookie,origin:'http://localhost','x-csrf-token':this.csrf,...(body&&!multipart?{'content-type':'application/json'}:{}),...headers},body:body?(multipart?body:JSON.stringify(body)):undefined}));}catch(e){return service.errorResponse(e);}}
}
function imageForm(requestId=randomUUID(),caseId='case-1'){const form=new FormData();form.set('caseId',caseId);form.set('title','长期护理合成培训资料');form.set('sourceNote','合成示例，非保险产品条款');form.set('consent','true');form.set('requestId',requestId);form.set('file',new Blob([png],{type:'image/png'}),'poster.png');return form;}
async function create(browser:Browser,form=imageForm()){const response=await browser.request(form);assert.equal(response.status,201,JSON.stringify(await response.clone().json()));return await response.json() as MaterialDetail;}
async function detail(browser:Browser,id:string){return await (await browser.request(undefined,`?id=${id}`)).json() as MaterialDetail;}
async function approve(browser:Browser,doc:MaterialDetail,extra:Record<string,unknown>={}){const r=await browser.request({action:'approve',id:doc.id,version:doc.version,reviewedText:'长期护理应核对照护偏好与家庭支持。金额及适用条件未知，应由顾问核实。',confirmed:true,...extra});assert.equal(r.status,200);return r.json() as Promise<MaterialDetail>;}

test('upload idempotency, review gate, revision conflicts, scope isolation, immutable snapshot, and withdrawal',async()=>{
  const browser=await new Browser().login();const requestId=randomUUID();const upload=await create(browser,imageForm(requestId));assert.equal(upload.state,'queued');
  assert.equal((await browser.request(imageForm(requestId))).status,200);assert.equal((await browser.request(imageForm(requestId,'case-2'))).status,409);
  assert.equal(approvedMaterialDocuments('case-1').length,0);await processMaterialJobs();const pending=await detail(browser,upload.id);assert.equal(pending.state,'needs_review');assert.match(pending.originalText,/模拟/);
  assert.equal((await browser.request({action:'approve',id:pending.id,version:pending.version,reviewedText:'长期护理',confirmed:false})).status,400);
  let approved=await approve(browser,pending);assert.equal(approved.scope,'case');
  const knowledge=await loadCaseKnowledge('case-1','长期护理照护');assert(knowledge.sources.some(source=>source.path.startsWith('uploads/')));const source=knowledge.sources[0];assert(safeMaterialSourceUrl(source));assert.equal(publicKnowledgeContext(knowledge),undefined);
  assert.equal(approvedMaterialDocuments('case-2').length,0);assert.equal(approvedMaterialDocuments('case-7').length,0);
  const originalVersion=await (await browser.request(undefined,`?id=${upload.id}&revision=${source.revision}`)).json();
  assert.equal((await browser.request({action:'save',id:upload.id,version:pending.version,reviewedText:'stale'})).status,409);
  let r=await browser.request({action:'save',id:upload.id,version:approved.version,reviewedText:'长期护理更新稿'});assert.equal(r.status,200);assert.equal(approvedMaterialDocuments('case-1').length,0);
  approved=await approve(browser,await r.json() as MaterialDetail,{allowAcrossCases:true});assert.equal(approved.scope,'library');assert.equal(approvedMaterialDocuments('case-2').length,1);assert.equal(approvedMaterialDocuments('case-7').length,0);
  assert.deepEqual(await (await browser.request(undefined,`?id=${upload.id}&revision=${source.revision}`)).json(),originalVersion);
  r=await browser.request({action:'withdraw',id:approved.id,version:approved.version});assert.equal(r.status,200);assert.equal(approvedMaterialDocuments('case-1').length,0);assert.equal(approvedMaterialDocuments('case-2').length,0);
  assert.equal(getUsageSummary('org-demo','case-1',true).records.length,0,'mock never creates paid usage');
});

test('local advisor auth, CSRF, role, other owner, case ownership, raw media and client isolation',async()=>{
  const owner=await new Browser().login();const upload=await create(owner);
  assert.equal((await new Browser().request()).status,401);
  for(const email of ['admin@aeconn.example','charles@aeconn.example'])assert.equal((await (await new Browser().login(email)).request()).status,403);
  const other=await new Browser().login('advisor2@aeconn.example');assert.equal((await other.request(undefined,`?id=${upload.id}`)).status,404);assert.equal((await other.request(undefined,`?id=${upload.id}&original=1`)).status,404);
  assert.equal((await owner.request(imageForm(),'',{'x-csrf-token':'bad'})).status,403);assert.equal((await owner.request(imageForm(),'',{origin:'https://evil.example'})).status,403);assert.equal((await owner.request(imageForm(randomUUID(),'case-7'))).status,403);
  assert.equal((await owner.request(undefined,`?id=${upload.id}&original=1`)).headers.get('content-type'),'image/png');
  assert.equal((await owner.action({action:'enterClient',caseId:'case-3'})).status,200);await owner.refresh();assert.equal((await owner.request()).status,403);assert.equal((await owner.request(undefined,`?id=${upload.id}&original=1`)).status,403);
  assert.equal((await owner.action({action:'end'})).status,200);
  await processMaterialJobs();
});

test('server bounds media types, dimensions, duration and rejects gaps in video audio',async()=>{
  assert.throws(()=>validateMaterialImage(new Uint8Array(23)));assert.throws(()=>validateMaterialImage(Buffer.from('<svg onload=alert(1)>bad</svg>')));
  const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);assert.throws(()=>validateMaterialImage(huge));
  const browser=await new Browser().login();const form=imageForm();form.set('file',new Blob([Buffer.from('0000ftypisom00000000000000000000')],{type:'video/mp4'}),'video.mp4');
  form.set('frame0',new Blob([png]),'frame.png');form.set('audio0',new Blob([new Uint8Array(encodeRecordingWav(new Int16Array(16000)))]),'audio.wav');
  form.set('manifest',JSON.stringify({durationSeconds:1,frames:[{field:'frame0',startSeconds:0}],audio:[{field:'audio0',startSeconds:.5}]}));assert.equal((await browser.request(form)).status,400);
  form.set('manifest',JSON.stringify({durationSeconds:1,frames:[{field:'frame0',startSeconds:0}],audio:[{field:'audio0',startSeconds:0}]}));const uploaded=await create(browser,form);await processMaterialJobs();const result=await detail(browser,uploaded.id);assert.equal(result.state,'needs_review');assert.equal(result.parts.length,2);assert(result.parts.every(part=>part.state==='done'));assert.match(result.coverage,/非逐帧/);assert.match(result.originalText,/音轨/);
});

test('budget rejects before paid fetch, failure retains state, manual retry and restart preserve completed parts',async t=>{
  const browser=await new Browser().login();const original={...process.env};t.after(()=>{for(const key of ['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL','AI_CASE_BUDGET_USD']){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}});
  Object.assign(process.env,{LLM_PROVIDER:'openai',OPENAI_MODEL:'gpt-6-luna',OPENAI_API_KEY:'fake-no-network',AI_CASE_BUDGET_USD:'0'});
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({id:`response_${calls}`,status:'completed',usage:{input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:0}},output:[{type:'message',content:[{type:'output_text',text:'长期护理合成海报文字'}]}]}));});
  const created=await create(browser);await processMaterialJobs();let failed=await detail(browser,created.id);assert.equal(failed.state,'failed');assert.equal(calls,0);assert.equal(getUsageSummary('org-demo','case-1',true).records.length,0);
  process.env.AI_CASE_BUDGET_USD='8';let r=await browser.request({action:'retry',id:failed.id,version:failed.version});assert.equal(r.status,200);await processMaterialJobs();const completed=await detail(browser,created.id);assert.equal(completed.state,'needs_review');assert.equal(calls,1);assert.equal(getUsageSummary('org-demo','case-1',true).records[0].status,'settled');
  const stored={...completed,state:'processing'};db().prepare("UPDATE material_documents SET state='processing',doc=? WHERE id=?").run(pack(stored),stored.id);recoverMaterialJobs();failed=await detail(browser,created.id);assert.equal(failed.state,'failed');r=await browser.request({action:'retry',id:failed.id,version:failed.version});assert.equal(r.status,200);await processMaterialJobs();assert.equal(calls,1,'completed segments are not charged twice after restart');
});

test('video retry retains completed images, records safe failures and flags coarse audio timing for review',async t=>{
  const browser=await new Browser().login(),keys=['LLM_PROVIDER','RECORDING_PROVIDER','OPENAI_MODEL','OPENAI_API_KEY'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
  Object.assign(process.env,{LLM_PROVIDER:'openai',RECORDING_PROVIDER:'openai',OPENAI_MODEL:'gpt-6-luna',OPENAI_API_KEY:'fake-no-network'});
  let images=0,audio=0,failAudio=true;
  t.mock.method(globalThis,'fetch',async (url:RequestInfo|URL)=>{
    if(String(url).includes('/audio/transcriptions')){audio++;return failAudio?new Response('private upstream body',{status:503}):new Response(JSON.stringify({duration:1,text:'合成转写',segments:[{start:0,end:3,text:'合成转写'}]}));}
    images++;return new Response(JSON.stringify({id:'resp_material_test',status:'completed',usage:{input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:0}},output:[{type:'message',content:[{type:'output_text',text:'合成画面'}]}]}));
  });
  const form=imageForm();form.set('file',new Blob([Buffer.from('0000ftypisom00000000000000000000')],{type:'video/mp4'}),'video.mp4');
  form.set('frame0',new Blob([png]),'frame.png');form.set('audio0',new Blob([new Uint8Array(encodeRecordingWav(new Int16Array(16000)))]),'audio.wav');
  form.set('manifest',JSON.stringify({durationSeconds:1,frames:[{field:'frame0',startSeconds:0}],audio:[{field:'audio0',startSeconds:0}]}));
  const upload=await create(browser,form);await processMaterialJobs();const failed=await detail(browser,upload.id);
  assert.equal(failed.state,'failed');assert.match(failed.error!,/HTTP 503/);assert(!JSON.stringify(failed).includes('private upstream body'));assert.equal(failed.parts[0].state,'done');
  failAudio=false;assert.equal((await browser.request({action:'retry',id:failed.id,version:failed.version})).status,200);await processMaterialJobs();const result=await detail(browser,upload.id);
  assert.equal(images,1);assert.equal(audio,2);assert.equal(result.state,'needs_review');assert(result.events.some(event=>event.action==='timing_warning'));assert.match(result.originalText,/仅定位到整段音轨/);assert.match(result.originalText,/\[0\.0–1\.0s\] 合成转写/);assert(!approvedMaterialDocuments('case-1').some(doc=>doc.path.includes(upload.id)));
});

test('deleted cases stop references; withdrawal remains possible; purge clears materials and snapshots',async()=>{
  const browser=await new Browser().login();const uploaded=await create(browser,imageForm(randomUUID(),'case-4'));await processMaterialJobs();const approved=await approve(browser,await detail(browser,uploaded.id),{allowAcrossCases:true});assert(approvedMaterialDocuments('case-2').some(doc=>doc.path.includes(uploaded.id)));
  assert.equal((await browser.action({action:'deleteCase',caseId:'case-4'})).status,200);assert(!approvedMaterialDocuments('case-2').some(doc=>doc.path.includes(uploaded.id)));
  assert.equal((await browser.request({action:'withdraw',id:approved.id,version:approved.version})).status,200);
  assert.equal((await browser.action({action:'purgeCase',caseId:'case-4',confirmation:'永久删除'})).status,200);
  assert.equal((await browser.request(undefined,`?id=${uploaded.id}`)).status,404);assert.equal(db().prepare('SELECT count(*) n FROM material_parts WHERE material_id=?').get(uploaded.id)!.n,0);assert.equal(db().prepare('SELECT count(*) n FROM material_versions WHERE material_id=?').get(uploaded.id)!.n,0);
});

test('approved mock materials never become real cloud references after provider switch',async()=>{
  const browser=await new Browser().login();const uploaded=await create(browser);await processMaterialJobs();await approve(browser,await detail(browser,uploaded.id));assert(approvedMaterialDocuments('case-1').some(doc=>doc.path.includes(uploaded.id)));
  const config={provider:process.env.LLM_PROVIDER,key:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL};Object.assign(process.env,{LLM_PROVIDER:'openai',OPENAI_MODEL:'gpt-6-luna',OPENAI_API_KEY:'fake-no-network'});
  try{assert(!approvedMaterialDocuments('case-1').some(doc=>doc.path.includes(uploaded.id)));}finally{for(const [name,value] of Object.entries({LLM_PROVIDER:config.provider,OPENAI_API_KEY:config.key,OPENAI_MODEL:config.model})){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});

test('approved private references reach voice context and report PDF without becoming customer facts',async()=>{
  const browser=await new Browser().login();const uploaded=await create(browser,imageForm(randomUUID(),'case-6'));await processMaterialJobs();await approve(browser,await detail(browser,uploaded.id));
  const beforeFacts=db().prepare('SELECT doc FROM profile_fields WHERE case_id=? ORDER BY field_key').all('case-6');
  const sessionId=randomUUID(),auth=db().prepare('SELECT id FROM auth_sessions WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get('advisor-1')!;
  db().prepare("INSERT INTO interviews(id,case_id,auth_id,state,entry,created_at) VALUES(?,?,?,'ended','ltc',?)").run(sessionId,'case-6',String(auth.id),new Date().toISOString());
  const voice=JSON.parse(await service.voiceHooks.getContext(sessionId));assert(voice.referenceKnowledge.sources.some((source:{path:string})=>source.path.includes(uploaded.id)));
  const generated=await browser.action({action:'generateReport',caseId:'case-6'});assert.equal(generated.status,200,JSON.stringify(await generated.clone().json()));
  const report=db().prepare('SELECT doc,pdf FROM reports WHERE case_id=? ORDER BY version DESC LIMIT 1').get('case-6')!;
  assert(JSON.parse(String(report.doc)).knowledge.sources.some((source:{path:string})=>source.path.includes(uploaded.id)));
  assert.equal(Buffer.from(report.pdf as Uint8Array).subarray(0,4).toString(),'%PDF');
  assert.deepEqual(db().prepare('SELECT doc FROM profile_fields WHERE case_id=? ORDER BY field_key').all('case-6'),beforeFacts);
});
