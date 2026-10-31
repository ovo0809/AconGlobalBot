import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { audit, db, docs, id, now, pack, transaction, unpack } from './db';
import type { User } from './domain';
import { materialTranscoderAvailable, transcodeMaterialVideo, type MaterialTranscodeResult } from './material-transcoder';
import {
  MATERIAL_IMPORT_CHUNK_BYTES,
  MATERIAL_IMPORT_MAX_BYTES,
  MATERIAL_IMPORT_MAX_SECONDS,
  type MaterialImportJob,
  type MaterialImportSegment,
  type MaterialImportSource,
} from './material-import-types';

export class MaterialImportError extends Error {constructor(public status:number,message:string){super(message);}}
function requireImport(value:unknown,status:number,message:string):asserts value {if(!value)throw new MaterialImportError(status,message);}

const MAX_TEMP_RESERVATION_BYTES=6*1024*1024*1024;
const MAX_OPEN_JOBS=2;
const EXPIRES_MS=24*60*60*1000;
const activeStates=['uploading','queued','preparing','ready','failed'] as const;
type StoredMaterialImportJob=MaterialImportJob&{chunkHashes:string[];receivedBytes:number};
type ImportDependencies={available?:()=>boolean;transcode?:typeof transcodeMaterialVideo};
const runtime=globalThis as typeof globalThis&{aeconnMaterialImportBusy?:boolean;aeconnMaterialImportCurrent?:{id:string;controller:AbortController};aeconnMaterialImportLocks?:Map<string,Promise<void>>};

const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store, private','Vary':'Cookie'}});}
function requireReviewer(user:User){requireImport(user.role==='reviewer'&&user.accessScope!=='public_tester',403,'仅复核账号可准备大视频资料。');}
function text(value:unknown,max:number,label:string){requireImport(typeof value==='string'&&value.trim().length>0&&value.trim().length<=max,400,`${label}格式或长度无效。`);return value.trim();}
function optionalText(value:unknown,max:number,label:string){requireImport(typeof value==='string'&&value.trim().length<=max,400,`${label}格式或长度无效。`);return value.trim();}
function integer(value:unknown,min:number,max:number,label:string){requireImport(typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max,400,`${label}无效。`);return value;}
// Uploaded media is runtime state, not an asset to include in the Next bundle.
function databasePath(){return resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH||'./data/aeconn.sqlite');}
function importRoot(){return resolve(dirname(databasePath()),'material-imports');}
function safePath(...parts:string[]){
  const root=importRoot(),target=resolve(root,...parts),rel=relative(root,target);
  requireImport(rel!==''&&!isAbsolute(rel)&&!rel.startsWith('..'+sep)&&rel!=='..',500,'资料暂存路径无效。');
  return target;
}
function jobDirectory(jobId:string){requireImport(/^[0-9a-f-]{36}$/i.test(jobId),500,'资料任务编号无效。');return safePath(jobId);}
function uploadPath(jobId:string){return join(jobDirectory(jobId),'source.upload');}
// MediaTranscoder requires a recognized extension. Only verified ISO BMFF input
// is renamed to this server-generated path; user filenames never form a path.
function sourcePath(jobId:string){return join(jobDirectory(jobId),'source.mp4');}
function outputDirectory(jobId:string){return join(jobDirectory(jobId),'segments');}
function cleanFiles(jobId:string){const target=jobDirectory(jobId);rmSync(target,{recursive:true,force:true});}
function publicJob(job:StoredMaterialImportJob):MaterialImportJob {return{id:job.id,requestId:job.requestId,title:job.title,sourceNote:job.sourceNote,caseId:job.caseId,filename:job.filename,size:job.size,lastModified:job.lastModified,state:job.state,receivedChunks:job.receivedChunks,totalChunks:job.totalChunks,...(job.durationSeconds===undefined?{}:{durationSeconds:job.durationSeconds}),...(job.sourceHash===undefined?{}:{sourceHash:job.sourceHash}),segments:job.segments,error:job.error,createdAt:job.createdAt,updatedAt:job.updatedAt};}
function save(job:StoredMaterialImportJob){job.updatedAt=now();db().prepare('UPDATE material_import_jobs SET state=?,doc=? WHERE id=?').run(job.state,pack(job),job.id);}
function rowJob(jobId:string,user:User){
  requireReviewer(user);const row=db().prepare('SELECT owner_id,doc FROM material_import_jobs WHERE id=?').get(jobId);
  requireImport(row&&row.owner_id===user.id,404,'大视频任务不存在或无权访问。');return unpack<StoredMaterialImportJob>(row.doc);
}
function checkedJob(jobId:string,user:User,checkCase:(caseId:string)=>void){const job=rowJob(jobId,user);checkCase(job.caseId);return job;}
function parseJson(bytes:Uint8Array){try{const value=JSON.parse(Buffer.from(bytes).toString('utf8'));requireImport(value&&typeof value==='object'&&!Array.isArray(value),400,'请求内容无效。');return value as Record<string,unknown>;}catch(error){if(error instanceof MaterialImportError)throw error;throw new MaterialImportError(400,'请求内容无效。');}}
async function readBounded(request:Request,max:number){
  const length=Number(request.headers.get('content-length')||0);requireImport(Number.isSafeInteger(length)&&length>=0&&length<=max,413,'上传分段超过大小限制。');
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let total=0;
  while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;requireImport(total<=max,413,'上传分段超过大小限制。');chunks.push(part.value);}
  requireImport(!length||length===total,400,'上传分段长度不完整。');return Buffer.concat(chunks,total);
}
async function fileHash(path:string){return new Promise<string>((accept,reject)=>{const digest=createHash('sha256'),stream=createReadStream(path);stream.on('data',chunk=>digest.update(chunk));stream.once('error',reject);stream.once('end',()=>accept(digest.digest('hex')));});}
function expectedChunkBytes(job:StoredMaterialImportJob,index:number){return index===job.totalChunks-1?job.size-index*MATERIAL_IMPORT_CHUNK_BYTES:MATERIAL_IMPORT_CHUNK_BYTES;}
function readStoredChunk(path:string,offset:number,length:number){const result=Buffer.alloc(length),fd=openSync(path,'r');let read=0;try{while(read<length){const count=readSync(fd,result,read,length-read,offset+read);if(!count)break;read+=count;}}finally{closeSync(fd);}requireImport(read===length,409,'暂存分段损坏，请重新开始。');return result;}
async function withJobMutation<T>(jobId:string,operation:()=>Promise<T>|T):Promise<T>{
  const locks=runtime.aeconnMaterialImportLocks??=new Map(),previous=locks.get(jobId)??Promise.resolve();let release!:()=>void;const gate=new Promise<void>(accept=>{release=accept;}),queued=previous.then(()=>gate);locks.set(jobId,queued);await previous;
  try{return await operation();}finally{release();if(locks.get(jobId)===queued)locks.delete(jobId);}
}

function startJob(user:User,input:Record<string,unknown>,checkCase:(caseId:string)=>void,available:()=>boolean){
  requireReviewer(user);
  const requestId=text(input.requestId,80,'上传编号');requireImport(/^[0-9a-f-]{36}$/i.test(requestId),400,'上传编号无效。');
  const caseId=text(input.caseId,100,'案例'),title=text(input.title,120,'资料名称'),sourceNote=optionalText(input.sourceNote??'',1600,'资料来源'),filename=text(input.filename,240,'文件名').replace(/[\\/\u0000-\u001f\u007f]/g,'_');
  const size=integer(input.size,1,MATERIAL_IMPORT_MAX_BYTES,'视频大小'),lastModified=integer(input.lastModified,0,Number.MAX_SAFE_INTEGER,'文件修改时间');requireImport(input.consent===true,400,'请先确认有权处理这份资料。');checkCase(caseId);requireImport(available(),409,'大视频自动处理目前仅支持 Windows 本机 Demo。');
  const existing=db().prepare('SELECT doc FROM material_import_jobs WHERE owner_id=? AND json_extract(doc,\'$.requestId\')=?').get(user.id,requestId);
  if(existing){const job=unpack<StoredMaterialImportJob>(existing.doc);requireImport(job.caseId===caseId&&job.title===title&&job.sourceNote===sourceNote&&job.filename===filename&&job.size===size&&job.lastModified===lastModified,409,'同一上传编号的资料信息已改变，请重新选择文件。');return publicJob(job);}
  const open=docs<StoredMaterialImportJob>(`SELECT doc FROM material_import_jobs WHERE state IN (${activeStates.map(()=>'?').join(',')})`,...activeStates);
  requireImport(!open.some(job=>db().prepare('SELECT owner_id FROM material_import_jobs WHERE id=?').get(job.id)?.owner_id===user.id),409,'当前账号已有未完成的大视频任务，请先完成或取消。');
  requireImport(open.length<MAX_OPEN_JOBS,409,'当前已有两个大视频任务，请稍后再试。');
  // Reserve both a normalized copy and final parts at their worst bounded size.
  const maxOutputBytes=Math.ceil(MATERIAL_IMPORT_MAX_SECONDS/180)*32*1024*1024,reserve=(job:StoredMaterialImportJob)=>job.size+2*maxOutputBytes,reserved=open.reduce((sum,job)=>sum+reserve(job),0)+size+2*maxOutputBytes;requireImport(reserved<=MAX_TEMP_RESERVATION_BYTES,409,'本机大视频暂存空间不足，请先完成或取消现有任务。');
  const stamp=now(),job:StoredMaterialImportJob={id:id(),requestId,title,sourceNote,caseId,filename,size,lastModified,state:'uploading',receivedChunks:0,totalChunks:Math.ceil(size/MATERIAL_IMPORT_CHUNK_BYTES),segments:[],error:null,createdAt:stamp,updatedAt:stamp,chunkHashes:[],receivedBytes:0};
  mkdirSync(jobDirectory(job.id),{recursive:true});transaction(()=>{db().prepare('INSERT INTO material_import_jobs VALUES(?,?,?,?,?)').run(job.id,user.id,caseId,job.state,pack(job));audit(user.id,caseId,'material_import.started',{jobId:job.id,size,totalChunks:job.totalChunks});});return publicJob(job);
}

async function putChunk(request:Request,user:User,jobId:string,index:number,checkCase:(caseId:string)=>void){
  requireImport(Number.isSafeInteger(index)&&index>=0,400,'上传分段编号无效。');const bytes=await readBounded(request,MATERIAL_IMPORT_CHUNK_BYTES),checksum=hash(bytes);
  return withJobMutation(jobId,()=>{const job=checkedJob(jobId,user,checkCase);requireImport(job.state==='uploading'&&index<job.totalChunks,409,'当前任务不能继续上传分段。');const expected=expectedChunkBytes(job,index);requireImport(bytes.byteLength===expected,400,'上传分段长度不完整。');const path=uploadPath(job.id);
    if(index<job.receivedChunks){requireImport(job.chunkHashes[index]===checksum,409,'已上传分段内容不一致，请重新开始。');requireImport(hash(readStoredChunk(path,index*MATERIAL_IMPORT_CHUNK_BYTES,expected))===checksum,409,'暂存分段损坏，请重新开始。');return publicJob(job);}
    requireImport(index===job.receivedChunks,409,'请按顺序上传视频分段。');const actual=existsSync(path)?statSync(path).size:0;requireImport(actual===job.receivedBytes,409,'暂存文件状态不一致，请重新开始。');appendFileSync(path,bytes);job.chunkHashes.push(checksum);job.receivedChunks+=1;job.receivedBytes+=bytes.byteLength;save(job);return publicJob(job);
  });
}

async function prepareJob(user:User,job:StoredMaterialImportJob,checkCase:(caseId:string)=>void){
  requireImport(job.state==='uploading',409,'当前任务不能开始准备。');requireImport(job.receivedChunks===job.totalChunks&&job.receivedBytes===job.size&&existsSync(uploadPath(job.id))&&statSync(uploadPath(job.id)).size===job.size,409,'视频尚未完整上传。');
  const header=readStoredChunk(uploadPath(job.id),0,Math.min(32,job.size));requireImport(header.length>=12&&header.toString('ascii',4,8)==='ftyp',400,'大视频自动处理目前只支持 MP4 或 MOV 容器。');
  let sourceHash:string;try{sourceHash=await fileHash(uploadPath(job.id));}catch{throw new MaterialImportError(409,'暂存视频已取消或损坏，请重新开始。');}return withJobMutation(job.id,()=>{const current=checkedJob(job.id,user,checkCase);requireImport(current.state==='uploading'&&current.receivedChunks===current.totalChunks&&current.receivedBytes===current.size&&existsSync(uploadPath(current.id)),409,'任务状态已改变，不能开始准备。');renameSync(uploadPath(current.id),sourcePath(current.id));current.sourceHash=sourceHash;current.state='queued';current.error=null;save(current);audit(user.id,current.caseId,'material_import.queued',{jobId:current.id,sourceHash});return publicJob(current);});
}

function cancelJob(user:User,job:StoredMaterialImportJob){
  requireImport(!['completed','cancelled'].includes(job.state),409,'任务已经结束。');job.state='cancelled';job.error=null;save(job);if(runtime.aeconnMaterialImportCurrent?.id===job.id)runtime.aeconnMaterialImportCurrent.controller.abort();else cleanFiles(job.id);audit(user.id,job.caseId,'material_import.cancelled',{jobId:job.id});return publicJob(job);
}

function retryJob(user:User,job:StoredMaterialImportJob){requireImport(job.state==='failed'&&existsSync(sourcePath(job.id))&&statSync(sourcePath(job.id)).size===job.size,409,'没有可重试的完整视频。');job.state='queued';job.error=null;job.segments=[];save(job);audit(user.id,job.caseId,'material_import.retried',{jobId:job.id});return publicJob(job);}

function acknowledgeSegment(user:User,job:StoredMaterialImportJob,input:Record<string,unknown>){
  requireImport(job.state==='ready',409,'视频分段尚未准备完成。');const index=integer(input.index,0,job.segments.length-1,'视频分段编号'),materialId=text(input.materialId,100,'资料编号'),segment=job.segments[index];
  const row=db().prepare('SELECT owner_id,case_id,doc,original FROM material_documents WHERE id=?').get(materialId);requireImport(row&&row.owner_id===user.id&&row.case_id===job.caseId&&hash(new Uint8Array(row.original as Uint8Array))===segment.sha256,409,'资料分段不存在、内容或归属不一致。');
  const document=unpack<{importSource?:{jobId?:string;index?:number}}>(row.doc);requireImport(document.importSource?.jobId===job.id&&document.importSource.index===index,409,'资料分段来源无法核对。');
  requireImport(!job.segments.some((item,i)=>i!==index&&item.materialId===materialId),409,'同一资料不能对应多个视频分段。');if(segment.materialId)requireImport(segment.materialId===materialId,409,'视频分段已经关联其他资料。');segment.materialId=materialId;save(job);audit(user.id,job.caseId,'material_import.segment_acknowledged',{jobId:job.id,index,materialId});return publicJob(job);
}

function completeJob(user:User,job:StoredMaterialImportJob){requireImport(job.state==='ready'&&job.segments.length>0&&job.segments.every(segment=>segment.materialId),409,'请先完成所有视频分段上传。');job.state='completed';job.error=null;save(job);cleanFiles(job.id);audit(user.id,job.caseId,'material_import.completed',{jobId:job.id,segments:job.segments.length});return publicJob(job);}

function safeFailureMessage(error:unknown){
  if(error instanceof MaterialImportError)return error.message;
  if(error instanceof Error&&error.name==='AbortError')return '视频准备已取消。';
  const message=error instanceof Error?error.message:'';
  return message.length<=240&&/^(?:大视频|视频|Windows|无法|转码)/.test(message)&&!/[\\/]/.test(message)?message:'视频准备未完成，请检查文件格式后重试。';
}

export async function handleMaterialImportRequest(request:Request,user:User,checkCase:(caseId:string)=>void,dependencies:ImportDependencies={}):Promise<Response>{
  requireReviewer(user);const url=new URL(request.url),jobId=url.searchParams.get('id')?.trim()??'';
  if(request.method==='GET'){
    if(!jobId){const items=docs<StoredMaterialImportJob>('SELECT doc FROM material_import_jobs WHERE owner_id=? ORDER BY rowid DESC LIMIT 20',user.id).filter(job=>{try{checkCase(job.caseId);return true;}catch{return false;}}).map(publicJob);return json({available:(dependencies.available??materialTranscoderAvailable)(),items});}
    const job=checkedJob(jobId,user,checkCase),segmentValue=url.searchParams.get('segment');if(segmentValue===null)return json(publicJob(job));
    const index=Number(segmentValue);requireImport(job.state==='ready'&&Number.isSafeInteger(index)&&index>=0&&index<job.segments.length,404,'视频分段不存在。');const segment=job.segments[index],path=safePath(job.id,'segments',segment.filename);requireImport(existsSync(path),404,'视频分段文件不存在。');const bytes=readFileSync(path);requireImport(bytes.byteLength===segment.bytes&&hash(bytes)===segment.sha256,409,'视频分段校验失败，请重试准备。');return new Response(bytes,{headers:{'Content-Type':'video/mp4','Content-Length':String(bytes.byteLength),'Content-Disposition':`attachment; filename="${segment.filename}"`,'Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
  }
  if(request.method==='PUT'){const rawIndex=url.searchParams.get('index');requireImport(jobId&&rawIndex!==null,400,'缺少大视频任务或分段编号。');return json(await putChunk(request,user,jobId,Number(rawIndex),checkCase));}
  requireImport(request.method==='POST',405,'请求方法不支持。');const body=parseJson(await readBounded(request,100_000));if(body.action==='start')return json(startJob(user,body,checkCase,dependencies.available??materialTranscoderAvailable),201);
  const action=text(body.action,30,'操作'),job=checkedJob(text(body.id,100,'任务编号'),user,checkCase);
  if(action==='prepare')return json(await prepareJob(user,job,checkCase));if(action==='retry')return json(retryJob(user,job));if(action==='cancel')return json(cancelJob(user,job));if(action==='ack')return json(acknowledgeSegment(user,job,body));if(action==='complete')return json(completeJob(user,job));throw new MaterialImportError(400,'不支持的大视频操作。');
}

function authorizedForProcessing(jobId:string){
  const row=db().prepare(`SELECT j.owner_id,j.case_id,u.doc user_doc,c.reviewer_id,c.doc case_doc,owner.doc owner_doc FROM material_import_jobs j JOIN users u ON u.id=j.owner_id JOIN cases c ON c.id=j.case_id JOIN users owner ON owner.id=c.owner_id WHERE j.id=?`).get(jobId);
  if(!row||row.reviewer_id!==row.owner_id)return false;const user=unpack<User>(row.user_doc),owner=unpack<User>(row.owner_doc),record=unpack<{deletedAt?:string}>(row.case_doc);return user.role==='reviewer'&&user.accessScope!=='public_tester'&&user.orgId===owner.orgId&&!record.deletedAt;
}

function cleanupExpiredMaterialImports(){
  const cutoff=Date.now()-EXPIRES_MS;for(const job of docs<StoredMaterialImportJob>("SELECT doc FROM material_import_jobs WHERE state NOT IN ('completed','cancelled')")){
    if(Date.parse(job.updatedAt)>=cutoff)continue;if(runtime.aeconnMaterialImportCurrent?.id===job.id)runtime.aeconnMaterialImportCurrent.controller.abort();job.state='cancelled';job.error='大视频暂存超过 24 小时，已自动清理。';save(job);cleanFiles(job.id);
  }
}

export async function processMaterialImports(transcode:typeof transcodeMaterialVideo=transcodeMaterialVideo){
  cleanupExpiredMaterialImports();if(runtime.aeconnMaterialImportBusy)return;runtime.aeconnMaterialImportBusy=true;let job:StoredMaterialImportJob|undefined;
  try{
    job=docs<StoredMaterialImportJob>("SELECT doc FROM material_import_jobs WHERE state='queued' ORDER BY rowid LIMIT 1")[0];if(!job)return;
    if(!authorizedForProcessing(job.id)){job.state='failed';job.error='关联案例已删除、取消交接或当前复核账号无权处理。';save(job);return;}
    job.state='preparing';job.error=null;save(job);const controller=new AbortController();runtime.aeconnMaterialImportCurrent={id:job.id,controller};const out=outputDirectory(job.id);rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
    try{
      requireImport(Boolean(job.sourceHash)&&await fileHash(sourcePath(job.id))===job.sourceHash,409,'完整视频校验失败，请重新上传。');requireImport(!controller.signal.aborted,409,'视频准备已取消。');
      const result:MaterialTranscodeResult=await transcode({sourcePath:sourcePath(job.id),outputDirectory:out,signal:controller.signal,maxDurationSeconds:MATERIAL_IMPORT_MAX_SECONDS});
      const current=db().prepare('SELECT doc FROM material_import_jobs WHERE id=?').get(job.id);if(!current)return;job=unpack<StoredMaterialImportJob>(current.doc);if(job.state==='cancelled'){cleanFiles(job.id);return;}
      const segments:MaterialImportSegment[]=[];for(const [index,item]of result.segments.entries()){requireImport(item.filename===`part-${String(index).padStart(3,'0')}.mp4`,409,'转码视频分段名称无效。');const path=safePath(job.id,'segments',item.filename);requireImport(existsSync(path)&&statSync(path).size===item.bytes&&item.bytes>0&&item.bytes<=32*1024*1024,409,'转码视频分段无效。');segments.push({index,filename:item.filename,startSeconds:item.startSeconds,endSeconds:item.endSeconds,bytes:item.bytes,sha256:await fileHash(path)});requireImport(!controller.signal.aborted,409,'视频准备已取消。');}
      requireImport(result.durationSeconds>0&&result.durationSeconds<=MATERIAL_IMPORT_MAX_SECONDS&&segments.length>0,409,'转码结果不完整。');const latest=db().prepare('SELECT doc FROM material_import_jobs WHERE id=?').get(job.id);requireImport(latest,409,'大视频任务已删除。');job=unpack<StoredMaterialImportJob>(latest.doc);if(job.state==='cancelled'){cleanFiles(job.id);return;}requireImport(job.state==='preparing',409,'任务状态已改变，不能保存转码结果。');job.durationSeconds=result.durationSeconds;job.segments=segments;job.state='ready';job.error=null;save(job);const owner=String(db().prepare('SELECT owner_id FROM material_import_jobs WHERE id=?').get(job.id)?.owner_id??'');audit(owner||null,job.caseId,'material_import.ready',{jobId:job.id,durationSeconds:result.durationSeconds,segments:segments.length});
    }catch(error){const current=db().prepare('SELECT doc FROM material_import_jobs WHERE id=?').get(job.id);if(current){job=unpack<StoredMaterialImportJob>(current.doc);if(job.state==='cancelled')cleanFiles(job.id);else{job.state='failed';job.error=safeFailureMessage(error);save(job);rmSync(outputDirectory(job.id),{recursive:true,force:true});}}else cleanFiles(job.id);}
    finally{if(runtime.aeconnMaterialImportCurrent?.id===job.id)runtime.aeconnMaterialImportCurrent=undefined;}
  }finally{runtime.aeconnMaterialImportBusy=false;}
}

export function validateMaterialImportSource(user:User,caseId:string,input:unknown,original:Uint8Array):MaterialImportSource {
  requireReviewer(user);requireImport(input&&typeof input==='object'&&!Array.isArray(input),400,'大视频来源无效。');const value=input as Record<string,unknown>,job=rowJob(text(value.jobId,100,'任务编号'),user);requireImport(job.caseId===caseId&&Boolean(job.sourceHash),409,'大视频任务与当前案例不一致或尚未准备完成。');const index=integer(value.index,0,job.segments.length-1,'视频分段编号'),segment=job.segments[index],retryingCompleted=job.state==='completed'&&Boolean(segment.materialId);requireImport(job.state==='ready'||retryingCompleted,409,'大视频任务与当前案例不一致或尚未准备完成。');requireImport(hash(original)===segment.sha256,409,'视频分段内容与准备结果不一致。');
  if(segment.materialId){const row=db().prepare('SELECT owner_id,case_id,doc,original FROM material_documents WHERE id=?').get(segment.materialId);const document=row?unpack<{importSource?:{jobId?:string;index?:number}}>(row.doc):null;requireImport(row&&row.owner_id===user.id&&row.case_id===caseId&&document?.importSource?.jobId===job.id&&document.importSource.index===index&&hash(new Uint8Array(row.original as Uint8Array))===segment.sha256,409,'已关联的视频资料无法核对。');}
  return {jobId:job.id,index,filename:job.filename,sourceHash:job.sourceHash!,startSeconds:segment.startSeconds,endSeconds:segment.endSeconds};
}

export function recoverMaterialImports(){
  for(const job of docs<StoredMaterialImportJob>("SELECT doc FROM material_import_jobs WHERE state IN ('completed','cancelled')"))cleanFiles(job.id);
  cleanupExpiredMaterialImports();for(const job of docs<StoredMaterialImportJob>("SELECT doc FROM material_import_jobs WHERE state NOT IN ('completed','cancelled')")){
    if(job.state==='preparing'){job.state='failed';job.error='视频准备因服务重启中断，完整源文件仍保留，可手动重试。';save(job);rmSync(outputDirectory(job.id),{recursive:true,force:true});}
  }
}
export function materialImportBlocksCaseDeletion(caseId:string){return Boolean(db().prepare("SELECT id FROM material_import_jobs WHERE case_id=? AND state IN ('uploading','queued','preparing') LIMIT 1").get(caseId));}
export function purgeCaseMaterialImports(caseId:string){const jobs=docs<StoredMaterialImportJob>('SELECT doc FROM material_import_jobs WHERE case_id=?',caseId);if(runtime.aeconnMaterialImportCurrent&&jobs.some(job=>job.id===runtime.aeconnMaterialImportCurrent!.id))runtime.aeconnMaterialImportCurrent.controller.abort();for(const job of jobs)cleanFiles(job.id);db().prepare('DELETE FROM material_import_jobs WHERE case_id=?').run(caseId);}
