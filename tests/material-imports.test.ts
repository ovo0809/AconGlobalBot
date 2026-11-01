import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Case, User } from '../lib/domain';
import type { MaterialImportJob } from '../lib/material-import-types';

const root=mkdtempSync(join(tmpdir(),'aeconn-material-imports-'));
Object.assign(process.env,{DATABASE_PATH:join(root,'test.sqlite'),DEMO_PASSWORD:'AeconnDemo!2026'});
const imports=await import('../lib/material-imports');
const types=await import('../lib/material-import-types');
const database=await import('../lib/db');
const {db,pack,unpack}=database;

function reviewer(id='charles'){return unpack<User>(db().prepare('SELECT doc FROM users WHERE id=?').get(id)!.doc);}
function assign(caseId='case-1',reviewerId='charles') {const row=db().prepare('SELECT doc FROM cases WHERE id=?').get(caseId)!;const record=unpack<Case>(row.doc);record.assignedReviewerId=reviewerId;db().prepare('UPDATE cases SET reviewer_id=?,doc=? WHERE id=?').run(reviewerId,pack(record),caseId);}
assign();
const secondReviewer:User={...reviewer(),id:'reviewer-import-2',email:'reviewer-import-2@example.invalid'};db().prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(secondReviewer.id,secondReviewer.orgId,secondReviewer.email,db().prepare('SELECT password_hash FROM users WHERE id=?').get('charles')!.password_hash,pack(secondReviewer));assign('case-2',secondReviewer.id);
const checkCase=(caseId:string)=>{const row=db().prepare('SELECT reviewer_id,doc FROM cases WHERE id=?').get(caseId);if(!row||row.reviewer_id!=='charles'||unpack<Case>(row.doc).deletedAt)throw new imports.MaterialImportError(404,'案例不存在');};
const checkSecondCase=(caseId:string)=>{const row=db().prepare('SELECT reviewer_id,doc FROM cases WHERE id=?').get(caseId);if(!row||row.reviewer_id!==secondReviewer.id||unpack<Case>(row.doc).deletedAt)throw new imports.MaterialImportError(404,'案例不存在');};
async function call(request:Request,user=reviewer()){return imports.handleMaterialImportRequest(request,user,checkCase,{available:()=>true});}
function jsonRequest(body:Record<string,unknown>){return new Request('http://localhost/api/material-imports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
function startBody(extra:Record<string,unknown>={}){return{action:'start',requestId:randomUUID(),caseId:'case-1',title:'合成长视频资料',sourceNote:'自动测试合成字节',filename:'synthetic.mp4',size:types.MATERIAL_IMPORT_CHUNK_BYTES+3,lastModified:1,consent:true,...extra};}
function sourceBytes(length:number,fill=0){assert(length>=12);const bytes=new Uint8Array(length);bytes.fill(fill);bytes.set(Buffer.from('ftyp'),4);return bytes;}
async function start(extra:Record<string,unknown>={}){const response=await call(jsonRequest(startBody(extra)));assert.equal(response.status,201);return response.json() as Promise<MaterialImportJob>;}
async function put(job:MaterialImportJob,index:number,bytes:Uint8Array){return call(new Request(`http://localhost/api/material-imports?id=${job.id}&index=${index}`,{method:'PUT',headers:{'content-length':String(bytes.byteLength)},body:Buffer.from(bytes)}));}
async function action(job:MaterialImportJob,name:string,extra:Record<string,unknown>={}){return call(jsonRequest({action:name,id:job.id,...extra}));}

test('large import chunks are sequential, idempotent and bound to the owning reviewer',async()=>{
  const input=startBody(),first=await call(jsonRequest(input)),job=await first.json() as MaterialImportJob;assert.equal(first.status,201);assert.equal(job.totalChunks,2);assert.equal(job.receivedChunks,0);
  const repeat=await call(jsonRequest(input));assert.equal(repeat.status,201);assert.equal((await repeat.json()).id,job.id);
  await assert.rejects(()=>start({requestId:randomUUID()}),/已有未完成/);await assert.rejects(()=>call(new Request(`http://localhost/api/material-imports?id=${job.id}`,{method:'PUT',headers:{'content-length':'0'}})),/缺少大视频任务或分段编号/);
  await assert.rejects(()=>put(job,1,new Uint8Array(3)),/按顺序/);
  const chunk0=sourceBytes(types.MATERIAL_IMPORT_CHUNK_BYTES,7);assert.equal((await put(job,0,chunk0)).status,200);assert.equal((await put(job,0,chunk0)).status,200);
  const changed=chunk0.slice();changed[0]=8;await assert.rejects(()=>put(job,0,changed),/内容不一致/);
  assert.equal((await put(job,1,new Uint8Array([1,2,3]))).status,200);
  const other={...reviewer(),id:'reviewer-other'};await assert.rejects(()=>imports.handleMaterialImportRequest(new Request(`http://localhost/api/material-imports?id=${job.id}`),other,()=>undefined,{available:()=>true}),/不存在或无权/);
  const prepared=await action(job,'prepare');assert.equal((await prepared.json()).state,'queued');
  await assert.rejects(()=>call(jsonRequest({...input,title:'changed'})),/资料信息已改变/);
  await action(job,'cancel');
  const maximum=await start({size:types.MATERIAL_IMPORT_MAX_BYTES,filename:'maximum.mp4'});assert.equal(maximum.totalChunks,256);await action(maximum,'cancel');await assert.rejects(()=>start({size:types.MATERIAL_IMPORT_MAX_BYTES+1}),/视频大小无效/);
  const invalidContainer=await start({size:16,filename:'misleading.mp4'});await put(invalidContainer,0,new Uint8Array(16));await assert.rejects(()=>action(invalidContainer,'prepare'),/只支持 MP4 或 MOV/);await action(invalidContainer,'cancel');
});

test('queued video is converted by an injected local transcoder and source bytes are verified',async()=>{
  const job=await start({size:16,filename:'tiny-synthetic.mp4'});await put(job,0,sourceBytes(16,9));await action(job,'prepare');
  await imports.processMaterialImports(async input=>{mkdirSync(input.outputDirectory,{recursive:true});writeFileSync(join(input.outputDirectory,'part-000.mp4'),new Uint8Array([4,5,6]));return{durationSeconds:12,segments:[{filename:'part-000.mp4',startSeconds:0,endSeconds:12,bytes:3}]};});
  const ready=await (await call(new Request(`http://localhost/api/material-imports?id=${job.id}`))).json() as MaterialImportJob;assert.equal(ready.state,'ready');assert.equal(ready.durationSeconds,12);assert.equal(ready.segments.length,1);assert.match(ready.sourceHash!,/^[a-f0-9]{64}$/);assert.match(ready.segments[0].sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(imports.validateMaterialImportSource(reviewer(),'case-1',{jobId:job.id,index:0},new Uint8Array([4,5,6])),{jobId:job.id,index:0,filename:'tiny-synthetic.mp4',sourceHash:ready.sourceHash,startSeconds:0,endSeconds:12});
  assert.throws(()=>imports.validateMaterialImportSource(reviewer(),'case-1',{jobId:job.id,index:0},new Uint8Array([0])),/内容与准备结果不一致/);
  const segment=await call(new Request(`http://localhost/api/material-imports?id=${job.id}&segment=0`));assert.equal(segment.status,200);assert.deepEqual(new Uint8Array(await segment.arrayBuffer()),new Uint8Array([4,5,6]));
  const materialId=randomUUID(),materialDoc={id:materialId,importSource:{jobId:job.id,index:0}};db().prepare('INSERT INTO material_documents VALUES(?,?,?,?,?,?,?,?,?)').run(materialId,'charles','case-1',randomUUID(),'fingerprint','queued',pack(materialDoc),'video/mp4',new Uint8Array([4,5,6]));
  assert.throws(()=>db().prepare('INSERT INTO material_documents VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),'charles','case-1',randomUUID(),'fingerprint-2','queued',pack({...materialDoc,id:randomUUID()}),'video/mp4',new Uint8Array([4,5,6])),/UNIQUE/);
  const ack=await action(job,'ack',{index:0,materialId});assert.equal((await ack.json()).segments[0].materialId,materialId);assert.equal(imports.validateMaterialImportSource(reviewer(),'case-1',{jobId:job.id,index:0},new Uint8Array([4,5,6])).jobId,job.id,'lost upload or ack responses remain safely retryable');assert.equal((await action(job,'ack',{index:0,materialId})).status,200);const completed=await action(job,'complete');assert.equal((await completed.json()).state,'completed');assert.equal(existsSync(join(dirname(process.env.DATABASE_PATH!), 'material-imports',job.id)),false);assert.equal(imports.validateMaterialImportSource(reviewer(),'case-1',{jobId:job.id,index:0},new Uint8Array([4,5,6])).jobId,job.id,'lost final responses remain retryable only through the bound material');
});

test('cancel, restart recovery and case cleanup keep only lightweight history',async()=>{
  const cancelled=await start({size:2,filename:'cancel.mp4'});await put(cancelled,0,new Uint8Array([1,2]));assert.equal((await action(cancelled,'cancel').then(r=>r.json())).state,'cancelled');assert.equal(existsSync(join(dirname(process.env.DATABASE_PATH!), 'material-imports',cancelled.id)),false);
  const interrupted=await start({size:16,filename:'restart.mp4'});await put(interrupted,0,sourceBytes(16,2));await action(interrupted,'prepare');const stored=unpack<Record<string,unknown>>(db().prepare('SELECT doc FROM material_import_jobs WHERE id=?').get(interrupted.id)!.doc);stored.state='preparing';db().prepare("UPDATE material_import_jobs SET state='preparing',doc=? WHERE id=?").run(pack(stored),interrupted.id);imports.recoverMaterialImports();let recovered=await (await call(new Request(`http://localhost/api/material-imports?id=${interrupted.id}`))).json() as MaterialImportJob;assert.equal(recovered.state,'failed');assert.match(recovered.error!,/重启中断/);assert.equal(imports.materialImportBlocksCaseDeletion('case-1'),false);
  const expired=unpack<Record<string,unknown>>(db().prepare('SELECT doc FROM material_import_jobs WHERE id=?').get(interrupted.id)!.doc);expired.updatedAt='2000-01-01T00:00:00.000Z';db().prepare('UPDATE material_import_jobs SET doc=? WHERE id=?').run(pack(expired),interrupted.id);imports.recoverMaterialImports();recovered=await (await call(new Request(`http://localhost/api/material-imports?id=${interrupted.id}`))).json() as MaterialImportJob;assert.equal(recovered.state,'cancelled');assert.match(recovered.error!,/24 小时/);assert.equal(db().prepare('SELECT count(*) n FROM material_import_jobs WHERE id=?').get(interrupted.id)!.n,1,'expired jobs retain lightweight history');
  imports.purgeCaseMaterialImports('case-1');assert.equal(db().prepare('SELECT count(*) n FROM material_import_jobs WHERE case_id=?').get('case-1')!.n,0);assert.equal(existsSync(join(dirname(process.env.DATABASE_PATH!), 'material-imports',interrupted.id)),false);
});

test('cancel wins against in-flight chunk upload, hashing and transcoder completion',async()=>{
  const uploading=await start({size:3,filename:'concurrent-upload.mp4'});let releaseChunk!:()=>void,markReading!:()=>void;const reading=new Promise<void>(accept=>{markReading=accept;}),release=new Promise<void>(accept=>{releaseChunk=accept;});
  const stream=new ReadableStream<Uint8Array>({start(controller){markReading();void release.then(()=>{controller.enqueue(new Uint8Array([1,2,3]));controller.close();});}});
  const putPromise=call(new Request(`http://localhost/api/material-imports?id=${uploading.id}&index=0`,{method:'PUT',headers:{'content-length':'3'},body:stream,duplex:'half'} as RequestInit&{duplex:'half'}));await reading;await action(uploading,'cancel');releaseChunk();await assert.rejects(()=>putPromise,/不能继续上传/);assert.equal((await (await call(new Request(`http://localhost/api/material-imports?id=${uploading.id}`))).json()).state,'cancelled');

  const hashing=await start({size:types.MATERIAL_IMPORT_CHUNK_BYTES,filename:'concurrent-hash.mp4'});await put(hashing,0,sourceBytes(types.MATERIAL_IMPORT_CHUNK_BYTES));const preparePromise=action(hashing,'prepare');await action(hashing,'cancel');await assert.rejects(()=>preparePromise,/已取消或损坏|状态已改变/);assert.equal((await (await call(new Request(`http://localhost/api/material-imports?id=${hashing.id}`))).json()).state,'cancelled');

  const transcoding=await start({size:16,filename:'concurrent-transcode.mp4'});await put(transcoding,0,sourceBytes(16,8));await action(transcoding,'prepare');let releaseTranscode!:()=>void,markTranscoding!:()=>void;const transcoderStarted=new Promise<void>(accept=>{markTranscoding=accept;}),transcoderRelease=new Promise<void>(accept=>{releaseTranscode=accept;});
  const processing=imports.processMaterialImports(async input=>{mkdirSync(input.outputDirectory,{recursive:true});writeFileSync(join(input.outputDirectory,'part-000.mp4'),new Uint8Array([6]));markTranscoding();await transcoderRelease;return{durationSeconds:1,segments:[{filename:'part-000.mp4',startSeconds:0,endSeconds:1,bytes:1}]};});await transcoderStarted;await action(transcoding,'cancel');releaseTranscode();await processing;const final=await (await call(new Request(`http://localhost/api/material-imports?id=${transcoding.id}`))).json() as MaterialImportJob;assert.equal(final.state,'cancelled');assert.equal(existsSync(join(dirname(process.env.DATABASE_PATH!), 'material-imports',transcoding.id)),false);
});

test('transcoder output names cannot escape the server-generated job directory',async()=>{
  const job=await start({size:16,filename:'path-check.mp4'});await put(job,0,sourceBytes(16,4));await action(job,'prepare');await imports.processMaterialImports(async input=>{mkdirSync(input.outputDirectory,{recursive:true});return{durationSeconds:1,segments:[{filename:'../outside.mp4',startSeconds:0,endSeconds:1,bytes:1}]};});const failed=await (await call(new Request(`http://localhost/api/material-imports?id=${job.id}`))).json() as MaterialImportJob;assert.equal(failed.state,'failed');assert.match(failed.error!,/分段名称无效/);await action(job,'cancel');
});

test('temporary storage reservation covers worst-case transcoded output',async()=>{
  const first=await start({size:types.MATERIAL_IMPORT_MAX_BYTES,filename:'large-a.mp4'});const secondInput=startBody({requestId:randomUUID(),caseId:'case-2',size:types.MATERIAL_IMPORT_MAX_BYTES,filename:'large-b.mp4'});
  await assert.rejects(()=>imports.handleMaterialImportRequest(jsonRequest(secondInput),secondReviewer,checkSecondCase,{available:()=>true}),/暂存空间不足/);await action(first,'cancel');
});
