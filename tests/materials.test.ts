import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { Bootstrap, Case, Client, User } from '../lib/domain';
import type { MaterialDetail } from '../lib/material-types';
import { db, pack, unpack } from '../lib/db';
import { processMaterialJobs, recoverMaterialJobs, approvedMaterialDocuments, validateMaterialImage } from '../lib/materials';
import { loadCaseKnowledge } from '../lib/material-knowledge';
import { publicKnowledgeContext, safeMaterialSourceUrl } from '../lib/knowledge-public';
import { encodeRecordingWav, validateRecordingWav } from '../lib/recording-audio';
import { getUsageSummary } from '../lib/ai-usage';
const root=mkdtempSync(join(tmpdir(),'aeconn-materials-'));
Object.assign(process.env,{DATABASE_PATH:join(root,'test.sqlite'),KNOWLEDGE_REMOTE:'off',KNOWLEDGE_LOCAL_DIR:root,DEMO_PASSWORD:'AeconnDemo!2026',LLM_PROVIDER:'mock',VOICE_PROVIDER:'mock',RECORDING_PROVIDER:'mock',MAIL_MODE:'dry_run',AI_CASE_BUDGET_USD:'8',AI_DAILY_BUDGET_USD:'40',AI_MONTHLY_BUDGET_USD:'160'});
const service=await import('../lib/service');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
function assignReviewer(caseId:string,reviewerId:string|null='charles'){
  const row=db().prepare('SELECT doc FROM cases WHERE id=?').get(caseId);assert(row);const record=unpack<Case>(row.doc);record.assignedReviewerId=reviewerId;
  db().prepare('UPDATE cases SET reviewer_id=?,doc=? WHERE id=?').run(reviewerId,pack(record),caseId);
}
for(const caseId of ['case-1','case-2','case-4','case-6'])assignReviewer(caseId);
function seedReviewer(id:string,email:string,orgId='org-demo'){
  const source=db().prepare('SELECT password_hash FROM users WHERE id=?').get('charles');assert(source);
  if(orgId!=='org-demo'){const settings=db().prepare('SELECT settings FROM organizations WHERE id=?').get('org-demo');assert(settings);db().prepare('INSERT INTO organizations VALUES(?,?)').run(orgId,settings.settings);}
  const user:User={id,name:id,email,role:'reviewer',orgId,emailVerified:true};
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,orgId,email,source.password_hash,pack(user));
}
seedReviewer('reviewer-other','reviewer-other@aeconn.example');
seedReviewer('reviewer-foreign','reviewer-foreign@aeconn.example','org-foreign');
function seedTargetCase(caseId:string,owner:User){
  const passwordHash=db().prepare('SELECT password_hash FROM users WHERE id=?').get('charles')!.password_hash;
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(owner.id,owner.orgId,owner.email,passwordHash,pack(owner));
  const stamp=new Date().toISOString(),clientId=`client-${caseId}`;
  const client:Client={id:clientId,name:`${caseId} 合成客户`,birthday:'1980-01-01',gender:'不指定',phone:'+12025550999',email:`${caseId}@example.invalid`,maritalStatus:'未知',state:'CA',language:'中文',ownerAgentId:owner.id,consentStatus:'synthetic_demo',createdAt:stamp};
  const record:Case={id:caseId,clientId,ownerAgentId:owner.id,status:'draft',entry:'ltc',createdAt:stamp,updatedAt:stamp,assignedReviewerId:null,reportVersion:0};
  db().prepare('INSERT INTO clients VALUES(?,?,?)').run(clientId,owner.id,pack(client));db().prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(caseId,clientId,owner.id,null,pack(record));
}
seedTargetCase('case-foreign',{id:'advisor-foreign',name:'异组织顾问',email:'advisor-foreign@aeconn.example',role:'advisor',orgId:'org-foreign',emailVerified:true});
seedTargetCase('case-public',{id:'advisor-public',name:'公开测试顾问',email:'advisor-public@aeconn.example',role:'advisor',orgId:'org-demo',emailVerified:true,accessScope:'public_tester',sharedRunId:'synthetic-run'});
class Browser {
  cookie='';csrf='';
  async refresh(){const r=service.bootstrap(new Request('http://localhost/api/bootstrap',{headers:{cookie:this.cookie}}));this.cookie=r.headers.get('set-cookie')?.split(';')[0]??this.cookie;const data=await r.json() as Bootstrap;this.csrf=data.csrf;return data;}
  async action(input:Record<string,unknown>){let r:Response;try{r=await service.action(new Request('http://localhost/api/action',{method:'POST',headers:{cookie:this.cookie,origin:'http://localhost','content-type':'application/json','x-csrf-token':this.csrf},body:JSON.stringify(input)}));}catch(e){r=service.errorResponse(e);}this.cookie=r.headers.get('set-cookie')?.split(';')[0]??this.cookie;return r;}
  async login(email='charles@aeconn.example'){await this.refresh();assert.equal((await this.action({action:'login',email,password:'AeconnDemo!2026'})).status,200);await this.refresh();return this;}
  async request(body?:FormData|Record<string,unknown>,query='',headers:Record<string,string>={}){const multipart=body instanceof FormData;try{return await service.materialsRequest(new Request(`http://localhost/api/materials${query}`,{method:body?'POST':'GET',headers:{cookie:this.cookie,origin:'http://localhost','x-csrf-token':this.csrf,...(body&&!multipart?{'content-type':'application/json'}:{}),...headers},body:body?(multipart?body:JSON.stringify(body)):undefined}));}catch(e){return service.errorResponse(e);}}
}
function imageForm(requestId:string=randomUUID(),caseId='case-1'){const form=new FormData();form.set('caseId',caseId);form.set('title','长期护理合成培训资料');form.set('sourceNote','合成示例，非保险产品条款');form.set('consent','true');form.set('requestId',requestId);form.set('file',new Blob([png],{type:'image/png'}),'poster.png');return form;}
async function create(browser:Browser,form=imageForm()){const response=await browser.request(form);assert.equal(response.status,201,JSON.stringify(await response.clone().json()));return await response.json() as MaterialDetail;}
async function detail(browser:Browser,id:string){return await (await browser.request(undefined,`?id=${id}`)).json() as MaterialDetail;}
async function approve(browser:Browser,doc:MaterialDetail,extra:Record<string,unknown>={}){const r=await browser.request({action:'approve',id:doc.id,version:doc.version,reviewedText:'长期护理应核对照护偏好与家庭支持。金额及适用条件未知，应由顾问核实。',confirmed:true,...extra});assert.equal(r.status,200);return r.json() as Promise<MaterialDetail>;}

test('upload idempotency, review gate, revision conflicts, scope isolation, immutable snapshot, and withdrawal',async()=>{
  const browser=await new Browser().login();const requestId=randomUUID();const upload=await create(browser,imageForm(requestId));assert.equal(upload.state,'queued');
  assert.equal((await browser.request(imageForm(requestId))).status,200);assert.equal((await browser.request(imageForm(requestId,'case-2'))).status,409);
  const uploadEvents=JSON.stringify((await detail(browser,upload.id)).events);db().prepare('UPDATE material_documents SET owner_id=? WHERE id=?').run('advisor-1',upload.id);
  assert.equal(db().prepare('SELECT owner_id FROM material_documents WHERE id=?').get(upload.id)!.owner_id,'advisor-1');assert.equal(JSON.stringify((await detail(browser,upload.id)).events),uploadEvents,'changing role access preserves original history');
  assert.equal(approvedMaterialDocuments('case-1').length,0);await processMaterialJobs();const pending=await detail(browser,upload.id);assert.equal(pending.state,'needs_review');assert.match(pending.originalText,/模拟/);
  assert.equal((await browser.request({action:'approve',id:pending.id,version:pending.version,reviewedText:'长期护理',confirmed:false})).status,400);
  let approved=await approve(browser,pending,{scope:'organization',approvedOrgId:'org-foreign',approvedBy:'reviewer-foreign'});assert.equal(approved.scope,'case');
  const knowledge=await loadCaseKnowledge('case-1','长期护理照护');assert(knowledge.sources.some(source=>source.path.startsWith('uploads/')));const source=knowledge.sources[0];assert(safeMaterialSourceUrl(source));assert.equal(publicKnowledgeContext(knowledge),undefined);
  const caseSnapshot=await (await browser.request(undefined,`?id=${upload.id}&revision=${source.revision}`)).json();assert.equal(caseSnapshot.scope,'case');assert.equal(caseSnapshot.approvedOrgId,'org-demo');assert.equal(caseSnapshot.approvedBy,'charles');
  assert.equal(approvedMaterialDocuments('case-2').length,0);assert.equal(approvedMaterialDocuments('case-7').length,0);
  const originalVersion=await (await browser.request(undefined,`?id=${upload.id}&revision=${source.revision}`)).json();
  assert.equal((await browser.request({action:'save',id:upload.id,version:pending.version,reviewedText:'stale'})).status,409);
  let r=await browser.request({action:'save',id:upload.id,version:approved.version,reviewedText:'长期护理更新稿'});assert.equal(r.status,200);assert.equal(approvedMaterialDocuments('case-1').length,0);
  assignReviewer('case-2',null);
  approved=await approve(browser,await r.json() as MaterialDetail,{allowAcrossCases:true,scope:'case',approvedOrgId:'org-foreign',approvedBy:'reviewer-foreign'});assert.equal(approved.scope,'organization');assert.equal(approvedMaterialDocuments('case-2').length,1);assert.equal(approvedMaterialDocuments('case-7').length,1,'organization material reaches another advisor in the same organization');
  const organizationSource=approvedMaterialDocuments('case-7').find(doc=>doc.path.includes(upload.id))!;const organizationSnapshot=await (await browser.request(undefined,`?id=${upload.id}&revision=${organizationSource.revision}`)).json();assert.equal(organizationSnapshot.scope,'organization');assert.equal(organizationSnapshot.approvedOrgId,'org-demo');assert.equal(organizationSnapshot.approvedBy,'charles');
  assert.equal(approvedMaterialDocuments('case-foreign').length,0);assert.equal(approvedMaterialDocuments('case-public').length,0);
  const legacyId=randomUUID(),legacyDoc={...approved,id:legacyId,title:'旧版顾问个人通用资料',scope:'library' as const,state:'approved' as const,events:[...approved.events]};
  db().prepare('INSERT INTO material_documents VALUES(?,?,?,?,?,?,?,?,?)').run(legacyId,'advisor-1','case-1',randomUUID(),randomUUID().replaceAll('-',''),legacyDoc.state,pack(legacyDoc),'image/png',png);
  const legacyRevision=randomUUID().replaceAll('-','').padEnd(64,'0');db().prepare('INSERT INTO material_versions VALUES(?,?,?)').run(legacyId,legacyRevision,pack({title:legacyDoc.title,content:'旧版个人通用正文',sourceNote:'旧版范围',coverage:'合成',provider:'mock',scope:'library',approvedBy:'advisor-1',approvedAt:new Date().toISOString(),filename:'legacy.png'}));
  assert(approvedMaterialDocuments('case-2').some(doc=>doc.path.includes(legacyId)));assert(!approvedMaterialDocuments('case-7').some(doc=>doc.path.includes(legacyId)),'legacy advisor library scope is not widened to the organization');db().prepare('DELETE FROM material_documents WHERE id=?').run(legacyId);
  assert.deepEqual(await (await browser.request(undefined,`?id=${upload.id}&revision=${source.revision}`)).json(),originalVersion);
  r=await browser.request({action:'withdraw',id:approved.id,version:approved.version});assert.equal(r.status,200);assert.equal(approvedMaterialDocuments('case-1').length,0);assert.equal(approvedMaterialDocuments('case-2').length,0);
  assert.equal(getUsageSummary('org-demo','case-1',true).records.length,0,'mock never creates paid usage');
});

test('only the assigned local reviewer can list, upload, inspect and mutate materials',async()=>{
  const owner=await new Browser().login();const upload=await create(owner);await processMaterialJobs();const pending=await detail(owner,upload.id);const approved=await approve(owner,pending);const revision=approvedMaterialDocuments('case-1').find(doc=>doc.path.includes(upload.id))!.revision;
  assert.equal((await new Browser().request()).status,401);
  for(const email of ['admin@aeconn.example','advisor1@aeconn.example','advisor2@aeconn.example']){
    const denied=await new Browser().login(email);assert.equal((await denied.request()).status,403);assert.equal((await denied.request(imageForm())).status,403);
    for(const query of [`?id=${upload.id}`,`?id=${upload.id}&original=1`,`?id=${upload.id}&revision=${revision}`])assert.equal((await denied.request(undefined,query)).status,403);
    for(const action of ['save','approve','withdraw','retry'])assert.equal((await denied.request({action,id:upload.id,version:approved.version,reviewedText:'不得修改',confirmed:true})).status,403);
  }
  for(const email of ['reviewer-other@aeconn.example','reviewer-foreign@aeconn.example']){
    const denied=await new Browser().login(email);assert.deepEqual((await (await denied.request()).json()).items,[]);assert.equal((await denied.request(imageForm())).status,403);
    for(const query of [`?id=${upload.id}`,`?id=${upload.id}&original=1`,`?id=${upload.id}&revision=${revision}`])assert.equal((await denied.request(undefined,query)).status,404);
  }
  assert.equal((await owner.request(imageForm(),'',{'x-csrf-token':'bad'})).status,403);assert.equal((await owner.request(imageForm(),'',{origin:'https://evil.example'})).status,403);assert.equal((await owner.request(imageForm(randomUUID(),'case-7'))).status,403);
  assert.equal((await owner.request(undefined,`?id=${upload.id}&original=1`)).headers.get('content-type'),'image/png');
  const advisor=await new Browser().login('advisor1@aeconn.example');assert.equal((await advisor.action({action:'enterClient',caseId:'case-3'})).status,200);await advisor.refresh();assert.equal((await advisor.request()).status,403);assert.equal((await advisor.request(undefined,`?id=${upload.id}&original=1`)).status,403);assert.equal((await advisor.action({action:'end'})).status,200);
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
  failAudio=false;assert.equal((await browser.request({action:'retry',id:failed.id,version:failed.version})).status,200);await processMaterialJobs({frames:async()=>{throw new Error('synthetic fixture has no decodable frames');}});const result=await detail(browser,upload.id);
  assert.equal(images,1);assert.equal(audio,3,'coarse timing now gets one bounded short repair');assert.equal(result.autoCheck?.audio.length,1);assert.equal(result.autoCheck?.status,'attention');assert.equal(result.state,'needs_review');assert(result.events.some(event=>event.action==='timing_warning'));assert.match(result.originalText,/仅定位到整段音轨/);assert.match(result.originalText,/\[0\.0–1\.0s\] 合成转写/);assert(!approvedMaterialDocuments('case-1').some(doc=>doc.path.includes(upload.id)));
});

test('audible video gaps get at most four automatic retries and preserve the original extraction',async t=>{
  const browser=await new Browser().login(),keys=['LLM_PROVIDER','RECORDING_PROVIDER','OPENAI_MODEL','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
  Object.assign(process.env,{LLM_PROVIDER:'openai',RECORDING_PROVIDER:'openai',OPENAI_MODEL:'gpt-6-luna',OPENAI_API_KEY:'fake-no-network',RECORDING_TRANSCRIPTION_MODEL:'whisper-1'});
  let images=0,audio=0;
  t.mock.method(globalThis,'fetch',async (url:RequestInfo|URL,options?:RequestInit)=>{
    if(String(url).includes('/audio/transcriptions')){
      audio++;const form=options?.body as FormData,file=form.get('file');assert(file instanceof Blob);
      const duration=validateRecordingWav(new Uint8Array(await file.arrayBuffer())).durationSeconds;
      return new Response(JSON.stringify(audio===1?{duration,text:'合成前段',segments:[{start:0,end:4,text:'合成前段'}]}:{duration,text:'',segments:[]}));
    }
    images++;return new Response(JSON.stringify({id:'resp_tail_coverage',status:'completed',usage:{input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:0}},output:[{type:'message',content:[{type:'output_text',text:'合成画面'}]}]}));
  });
  const audible=new Int16Array(16_000*60);audible.fill(2_000);
  const form=imageForm(randomUUID(),'case-1');form.set('file',new Blob([Buffer.from('0000ftypisom00000000000000000000')],{type:'video/mp4'}),'tail-warning.mp4');
  form.set('frame0',new Blob([png]),'frame.png');form.set('audio0',new Blob([new Uint8Array(encodeRecordingWav(audible))]),'audio.wav');
  form.set('manifest',JSON.stringify({durationSeconds:60,frames:[{field:'frame0',startSeconds:0}],audio:[{field:'audio0',startSeconds:0}]}));
  const upload=await create(browser,form);await processMaterialJobs({frames:async()=>{throw new Error('synthetic fixture has no decodable video frames');}});const result=await detail(browser,upload.id);

  assert.equal(images,1);assert.equal(audio,5,'one original transcription plus at most four repair calls');assert.equal(result.state,'needs_review');
  assert.equal(result.autoCheck?.audio.length,4);assert.equal(result.autoCheck?.status,'attention');assert(result.autoCheck?.issues.some(issue=>issue.startSeconds===4&&issue.endSeconds===60));
  assert.match(result.originalText,/合成前段/);assert.match(result.originalText,/自动检查仍需注意/);assert.match(result.originalText,/4\.0–60\.0s/);
  assert(!approvedMaterialDocuments('case-1').some(doc=>doc.path.includes(upload.id)));
  await processMaterialJobs({frames:async()=>{throw new Error('must not run again');}});assert.equal(audio,5,'completed automatic attempts are not replayed');
});

test('ten minute material accepts forty contiguous short audio chunks without widening duration or approval',async()=>{
  const browser=await new Browser().login();
  const form=imageForm(randomUUID(),'case-1');form.set('file',new Blob([Buffer.from('0000ftypisom00000000000000000000')],{type:'video/mp4'}),'short-chunks.mp4');
  form.set('frame0',new Blob([png]),'frame.png');
  const wav=new Uint8Array(encodeRecordingWav(new Int16Array(15*16000)));
  const audio=Array.from({length:40},(_,index)=>({field:`audio${index}`,startSeconds:index*15}));
  for(const item of audio)form.set(item.field,new Blob([wav]),'audio.wav');
  form.set('manifest',JSON.stringify({durationSeconds:600,frames:[{field:'frame0',startSeconds:0}],audio}));
  const upload=await create(browser,form);await processMaterialJobs();const result=await detail(browser,upload.id);
  assert.equal(result.parts.filter(part=>part.kind==='audio').length,40);assert.equal(result.parts.at(-1)?.endSeconds,600);assert.equal(result.state,'needs_review');
  assert(!approvedMaterialDocuments('case-1').some(doc=>doc.path.includes(upload.id)));
});

test('automatic repair through the real transcription adapter settles usage once and remains approval-gated',async t=>{
  const browser=await new Browser().login(),keys=['LLM_PROVIDER','RECORDING_PROVIDER','OPENAI_MODEL','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
  Object.assign(process.env,{LLM_PROVIDER:'openai',RECORDING_PROVIDER:'openai',OPENAI_MODEL:'gpt-6-luna',OPENAI_API_KEY:'fake-no-network',RECORDING_TRANSCRIPTION_MODEL:'whisper-1'});
  let images=0,audio=0;
  t.mock.method(globalThis,'fetch',async (url:RequestInfo|URL,options?:RequestInit)=>{
    if(String(url).includes('/audio/transcriptions')){
      audio++;const form=options?.body as FormData,file=form.get('file');assert(file instanceof Blob);
      const duration=validateRecordingWav(new Uint8Array(await file.arrayBuffer())).durationSeconds;
      const text=audio===1?'原始前段':`自动补回 ${audio-1}`;
      return new Response(JSON.stringify({duration,text,segments:[{start:0,end:audio===1?4:duration,text}]}));
    }
    images++;return new Response(JSON.stringify({id:'resp_repair_success',status:'completed',usage:{input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:0}},output:[{type:'message',content:[{type:'output_text',text:'合成画面'}]}]}));
  });
  const audible=new Int16Array(16_000*20);audible.fill(2_000);
  const form=imageForm(randomUUID(),'case-1');form.set('file',new Blob([Buffer.from('0000ftypisom00000000000000000000')],{type:'video/mp4'}),'repair-success.mp4');
  form.set('frame0',new Blob([png]),'frame.png');form.set('audio0',new Blob([new Uint8Array(encodeRecordingWav(audible))]),'audio.wav');
  form.set('manifest',JSON.stringify({durationSeconds:20,frames:[{field:'frame0',startSeconds:0}],audio:[{field:'audio0',startSeconds:0}]}));
  const upload=await create(browser,form);await processMaterialJobs({frames:async()=>{throw new Error('frames are unnecessary after complete audio recovery');}});const result=await detail(browser,upload.id);

  assert.equal(images,1);assert.equal(audio,3);assert.equal(result.state,'needs_review');assert.equal(result.autoCheck?.status,'supplemented');assert.deepEqual(result.autoCheck?.issues,[]);
  assert.match(result.originalText,/原始前段/);assert.match(result.originalText,/自动补回 1/);assert.match(result.originalText,/自动补回 2/);
  const usage=db().prepare("SELECT session_id,status FROM ai_usage_calls WHERE operation='transcription' AND session_id LIKE ? ORDER BY created_at").all(`material:${upload.id}:%`) as Array<{session_id:string;status:string}>;
  assert.equal(usage.length,3);assert(usage.every(record=>record.status==='settled'));assert.equal(new Set(usage.map(record=>record.session_id)).size,3,'the original call and each repair retain a distinct ledger entry');
  assert.equal((await browser.request({action:'approve',id:result.id,version:result.version,reviewedText:result.originalText,confirmed:false})).status,400);assert(!approvedMaterialDocuments('case-1').some(doc=>doc.path.includes(upload.id)));
  await processMaterialJobs({frames:async()=>{throw new Error('must not run again');}});assert.equal(audio,3);assert.equal(db().prepare("SELECT count(*) n FROM ai_usage_calls WHERE operation='transcription' AND session_id LIKE ?").get(`material:${upload.id}:%`)!.n,3);
});

test('deleted cases stop references; withdrawal remains possible; purge clears materials and snapshots',async()=>{
  const browser=await new Browser().login();const uploaded=await create(browser,imageForm(randomUUID(),'case-4'));await processMaterialJobs();const approved=await approve(browser,await detail(browser,uploaded.id),{allowAcrossCases:true});assert(approvedMaterialDocuments('case-2').some(doc=>doc.path.includes(uploaded.id)));
  const advisor=await new Browser().login('advisor1@aeconn.example');assert.equal((await advisor.action({action:'deleteCase',caseId:'case-4'})).status,200);assert(!approvedMaterialDocuments('case-2').some(doc=>doc.path.includes(uploaded.id)));
  assert.equal((await browser.request({action:'withdraw',id:approved.id,version:approved.version})).status,200);
  assert.equal((await advisor.action({action:'purgeCase',caseId:'case-4',confirmation:'永久删除'})).status,200);
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
  const advisor=await new Browser().login('advisor1@aeconn.example');const sessionId=randomUUID(),auth=db().prepare('SELECT id FROM auth_sessions WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get('advisor-1')!;
  db().prepare("INSERT INTO interviews(id,case_id,auth_id,state,entry,created_at) VALUES(?,?,?,'ended','ltc',?)").run(sessionId,'case-6',String(auth.id),new Date().toISOString());
  const voice=JSON.parse(await service.voiceHooks.getContext(sessionId));assert(voice.referenceKnowledge.sources.some((source:{path:string})=>source.path.includes(uploaded.id)));
  const generated=await advisor.action({action:'generateReport',caseId:'case-6'});assert.equal(generated.status,200,JSON.stringify(await generated.clone().json()));
  const report=db().prepare('SELECT doc,pdf FROM reports WHERE case_id=? ORDER BY version DESC LIMIT 1').get('case-6')!;
  assert(JSON.parse(String(report.doc)).knowledge.sources.some((source:{path:string})=>source.path.includes(uploaded.id)));
  assert.equal(Buffer.from(report.pdf as Uint8Array).subarray(0,4).toString(),'%PDF');
  assert.deepEqual(db().prepare('SELECT doc FROM profile_fields WHERE case_id=? ORDER BY field_key').all('case-6'),beforeFacts);
});

test('video originals support private byte ranges, including suffixes, retries and unsatisfiable positions',async()=>{
  const browser=await new Browser().login();assignReviewer('case-1');
  const uploaded=await create(browser),bytes=Buffer.from('0000ftypisom00000000000000000000');
  const usageBefore=db().prepare('SELECT count(*) n FROM ai_usage_calls').get()!.n;
  db().prepare('UPDATE material_documents SET original=?,mime_type=?,doc=? WHERE id=?').run(bytes,'video/mp4',pack({...uploaded,kind:'video'}),uploaded.id);
  const query=`?id=${uploaded.id}&original=1`;
  for(const [range,start,end] of [['bytes=4-7',4,7],['bytes=8-',8,bytes.length-1],['bytes=-8',bytes.length-8,bytes.length-1],['bytes=0-99999999999999999999',0,bytes.length-1],['bytes=-99999999999999999999',0,bytes.length-1]] as const){
    const response=await browser.request(undefined,query,{range});
    assert.equal(response.status,206,range);assert.equal(response.headers.get('accept-ranges'),'bytes');
    assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'),String(end-start+1));assert.equal(response.headers.get('content-type'),'video/mp4');
    assert.equal(response.headers.get('cache-control'),'no-store, private');assert.equal(response.headers.get('vary'),'Cookie');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
  }
  for(const range of [`bytes=${bytes.length}-`,`bytes=99999999999999999999-`,'bytes=7-4','bytes=-0']){
    const response=await browser.request(undefined,query,{range});assert.equal(response.status,416,range);
    assert.equal(response.headers.get('content-range'),`bytes */${bytes.length}`);assert.equal((await response.arrayBuffer()).byteLength,0);
  }
  for(const headers of [{},{range:'bytes=0-1,4-5'},{range:'seconds=0-1'},{range:'bytes=invalid'},{range:'bytes=0-1','if-range':'"unmatched-validator"'}] as Record<string,string>[]){
    const response=await browser.request(undefined,query,headers);assert.equal(response.status,200);
    assert.equal(response.headers.get('content-range'),null);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  }
  for(const caller of [new Browser(),await new Browser().login('advisor1@aeconn.example'),await new Browser().login('reviewer-other@aeconn.example')]){
    const response=await caller.request(undefined,query,{range:'bytes=0-1'});assert([401,403,404].includes(response.status));assert.equal(response.headers.get('content-range'),null);
  }
  assert.equal(db().prepare('SELECT count(*) n FROM ai_usage_calls').get()!.n,usageBefore);
});

test('a prepared source segment is idempotent even when a lost response requires different derived frames',async()=>{
  const browser=await new Browser().login(),jobId=randomUUID(),stamp=new Date().toISOString();assignReviewer('case-1');
  const original=Buffer.from('0000ftypisom00000000000000000000'),checksum=createHash('sha256').update(original).digest('hex');
  const job={id:jobId,requestId:randomUUID(),title:'合成视频',sourceNote:'无真实内容',caseId:'case-1',filename:'synthetic-source.mp4',size:original.length,lastModified:1,state:'ready',receivedChunks:1,totalChunks:1,durationSeconds:1,sourceHash:checksum,segments:[{index:0,filename:'part-000.mp4',startSeconds:0,endSeconds:1,bytes:original.length,sha256:checksum}],error:null,createdAt:stamp,updatedAt:stamp,receivedBytes:original.length,chunkHashes:[checksum]};
  db().prepare('INSERT INTO material_import_jobs VALUES(?,?,?,?,?)').run(jobId,'charles','case-1','ready',pack(job));
  function preparedForm(requestId:string,frame=png){
    const form=imageForm(requestId);form.set('file',new Blob([original],{type:'video/mp4'}),'part-000.mp4');
    form.set('frame0',new Blob([new Uint8Array(frame)]),'frame.png');form.set('audio0',new Blob([new Uint8Array(encodeRecordingWav(new Int16Array(16000)))]),'audio.wav');
    form.set('manifest',JSON.stringify({durationSeconds:1,frames:[{field:'frame0',startSeconds:0}],audio:[{field:'audio0',startSeconds:0}]}));form.set('importSource',JSON.stringify({jobId,index:0}));return form;
  }
  const concurrent=await Promise.all([browser.request(preparedForm(`${jobId}-0`)),browser.request(preparedForm(randomUUID(),Buffer.concat([png,Buffer.from([0])])))]);
  assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,201]);
  const [first,duplicate]=await Promise.all(concurrent.map(response=>response.json() as Promise<MaterialDetail>));
  assert.equal(duplicate.id,first.id);
  assert.equal(first.importSource?.sourceHash,checksum);assert.match(first.coverage,/转码时间轴约 0.0–1.0 秒/);
  // Preserve the completed state; retry must not turn it into another cloud job.
  const completed={...first,state:'needs_review'};db().prepare("UPDATE material_documents SET state='needs_review',doc=? WHERE id=?").run(pack(completed),first.id);
  for(const requestId of [`${jobId}-0`,randomUUID()]){
    const response=await browser.request(preparedForm(requestId,Buffer.concat([png,Buffer.from([0])])));
    assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const retried=await response.json() as MaterialDetail;
    assert.equal(retried.id,first.id);assert.equal(retried.state,'needs_review');
  }
  assert.equal(db().prepare("SELECT count(*) n FROM material_documents WHERE json_extract(doc,'$.importSource.jobId')=?").get(jobId)!.n,1);
});
