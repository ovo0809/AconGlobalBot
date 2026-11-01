import { createHash } from 'node:crypto';
import { audit, db, docs, id, now, pack, transaction, unpack } from './db';
import type { Case, User } from './domain';
import { requireAnalysisConfig } from './provider-config';
import { RecordingTranscriptionError, recordingProviderConfig, transcribeRecordingChunk, type RecordingTranscriptionResult } from './recording-transcription';
import { validateRecordingWav } from './recording-audio';
import { materialAudioTailWarning } from './material-audio-coverage';
import { recoverMaterialCoverage, materialRecoveryText, type MaterialRecoveryAudio } from './material-recovery';
import { MaterialExtractionError, extractMaterialImage } from './material-extractor';
import { MATERIAL_MAX_ORIGINAL_BYTES, MATERIAL_MAX_REQUEST_BYTES, MATERIAL_MAX_STORAGE_BYTES, MATERIAL_MAX_TEXT_BYTES, MATERIAL_MAX_VIDEO_SECONDS, type MaterialDetail, type MaterialPart, type MaterialProvider, type MaterialSummary } from './material-types';
import { validateMaterialImportSource } from './material-imports';

export class MaterialError extends Error {constructor(public status:number,message:string){super(message);}}
function requireMaterial(value:unknown,status:number,message:string):asserts value {if(!value)throw new MaterialError(status,message);}
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store, private','Vary':'Cookie'}});
type StoredMaterial=Omit<MaterialDetail,'parts'>;
type StoredPart=MaterialPart & {mimeType:string;transcription?:RecordingTranscriptionResult};
type PreparedPart={doc:StoredPart;bytes:Uint8Array};
const state=globalThis as typeof globalThis & {aeconnMaterialBusy?:boolean};
function cleanText(value:unknown,max:number,label:string){requireMaterial(typeof value==='string'&&value.trim().length<=max,400,`${label}格式或长度无效。`);return value.trim();}
function textBytes(value:string){return Buffer.byteLength(value,'utf8');}

/** Parse dimensions, never trust filename or client MIME. No executable SVG/HTML is accepted. */
export function validateMaterialImage(bytes:Uint8Array,maxDimension=2048):'image/png'|'image/jpeg'|'image/webp' {
  requireMaterial(bytes.length>=24&&bytes.length<=8*1024*1024,400,'图片为空或超过 8 MB。');
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);let width=0,height=0,mime:'image/png'|'image/jpeg'|'image/webp';
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString('ascii',12,16)==='IHDR') {mime='image/png';width=b.readUInt32BE(16);height=b.readUInt32BE(20);}
  else if(b[0]===255&&b[1]===216) {
    mime='image/jpeg';let p=2;
    while(p+8<b.length){if(b[p++]!==255)continue;let marker=b[p++];while(marker===255)marker=b[p++];if(marker===217||marker===218)break;if(marker===0||marker===1||marker>=208&&marker<=215)continue;const size=b.readUInt16BE(p);if(size<2||p+size>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=b.readUInt16BE(p+3);width=b.readUInt16BE(p+5);break;}p+=size;}
  } else if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'&&b.length>=30){
    mime='image/webp';const kind=b.toString('ascii',12,16);
    if(kind==='VP8X'){requireMaterial((b[20]&2)===0,400,'请上传静态图片。');width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(kind==='VP8 '&&b[23]===157&&b[24]===1&&b[25]===42){width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
    else if(kind==='VP8L'&&b[20]===47){const bits=b.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  } else throw new MaterialError(400,'仅支持 PNG、JPEG、WebP 静态图片。');
  requireMaterial(width>0&&height>0&&width<=maxDimension&&height<=maxDimension&&width*height<=40_000_000,400,'图片尺寸无效或过大，请重新选择图片。');
  return mime!;
}

export function materialProviderConfig():{provider:MaterialProvider;configured:boolean} {
  try {const config=requireAnalysisConfig();return {provider:config?'openai':'mock',configured:!config||config.provider==='openai'};}
  catch {return {provider:process.env.LLM_PROVIDER==='mock'?'mock':'openai',configured:false};}
}
// Upload ownership is provenance; review access follows current case assignment.
// Keep original uploader IDs and immutable approval snapshots when roles change.
const materialAccessFrom='FROM material_documents m JOIN cases c ON c.id=m.case_id JOIN users owner ON owner.id=c.owner_id JOIN users uploader ON uploader.id=m.owner_id';
function requireReviewer(user:User){requireMaterial(user.role==='reviewer'&&user.accessScope!=='public_tester',403,'仅复核账号可上传和管理资料。');}
function ownerDocument(materialId:string,user:User):StoredMaterial {
  requireReviewer(user);
  const row=db().prepare(`SELECT m.doc ${materialAccessFrom} WHERE m.id=? AND c.reviewer_id=? AND owner.org_id=? AND uploader.org_id=?`).get(materialId,user.id,user.orgId,user.orgId);
  requireMaterial(row,404,'资料不存在或无权访问。');return unpack<StoredMaterial>(row.doc);
}
function partsFor(materialId:string){return docs<StoredPart>('SELECT doc FROM material_parts WHERE material_id=? ORDER BY position',materialId);}
export function materialDetail(materialId:string,user:User):MaterialDetail {return {...ownerDocument(materialId,user),parts:partsFor(materialId).map(part=>({kind:part.kind,position:part.position,startSeconds:part.startSeconds,endSeconds:part.endSeconds,state:part.state,text:part.text}))};}
function saveDocument(doc:StoredMaterial){doc.updatedAt=now();doc.version++;db().prepare('UPDATE material_documents SET state=?,doc=? WHERE id=?').run(doc.state,pack(doc),doc.id);}
function event(doc:StoredMaterial,action:string,detail:string){doc.events.push({at:now(),action,detail});}
function summary(doc:StoredMaterial):MaterialSummary {const {id,title,filename,kind,state,provider,caseId,createdAt,updatedAt,version,error,scope}=doc;return {id,title,filename,kind,state,provider,caseId,createdAt,updatedAt,version,error,scope:scope??'case'};}
export function listMaterials(user:User){requireReviewer(user);return {items:docs<StoredMaterial>(`SELECT m.doc ${materialAccessFrom} WHERE c.reviewer_id=? AND owner.org_id=? AND uploader.org_id=? ORDER BY m.rowid DESC LIMIT 60`,user.id,user.orgId,user.orgId).map(summary),...materialProviderConfig()};}

async function readBounded(request:Request,max:number){
  const length=Number(request.headers.get('content-length')||0);requireMaterial(Number.isFinite(length)&&length<=max,413,'上传内容超过大小限制。');
  const reader=request.body?.getReader();requireMaterial(reader,400,'上传内容为空。');const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new MaterialError(413,'上传内容超过大小限制。');}chunks.push(value);}}finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
function formFile(form:FormData,name:string){const value=form.get(name);requireMaterial(value instanceof File&&value.size>0,400,`缺少文件 ${name}。`);return value;}
function numeric(value:unknown,label:string){requireMaterial(typeof value==='number'&&Number.isFinite(value)&&value>=0,400,`${label}无效。`);return value;}

async function parseUpload(request:Request,user:User){
  const body=await readBounded(request,MATERIAL_MAX_REQUEST_BYTES);let form:FormData;
  try {form=await new Request('http://localhost/upload',{method:'POST',headers:{'content-type':request.headers.get('content-type')||''},body:new Uint8Array(body)}).formData();}catch{throw new MaterialError(400,'上传表单无效。');}
  requireMaterial(form.get('consent')==='true',400,'请确认有权使用资料并同意云端处理。');
  const file=formFile(form,'file');requireMaterial(file.size<=MATERIAL_MAX_ORIGINAL_BYTES,413,'原文件最多 32 MB。');
  const title=cleanText(form.get('title'),120,'资料名称');requireMaterial(title,400,'请输入资料名称。');
  const sourceNote=cleanText(form.get('sourceNote')??'',1600,'资料来源');const caseId=cleanText(form.get('caseId'),100,'案例');
  const requestId=cleanText(form.get('requestId'),100,'请求编号');requireMaterial(/^[a-zA-Z0-9_-]{16,100}$/.test(requestId),400,'请求编号无效。');
  const original=new Uint8Array(await file.arrayBuffer());const magic=Buffer.from(original.subarray(0,32));
  let importSource;
  if(form.has('importSource')){
    let reference:unknown;try{reference=JSON.parse(String(form.get('importSource')));}catch{throw new MaterialError(400,'视频准备来源无效。');}
    importSource=await validateMaterialImportSource(user,caseId,reference,original);
  }
  const video=magic.toString('ascii',4,8)==='ftyp'||magic.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  const kind=video?'video':'image';const mimeType=video?(magic.toString('ascii',4,8)==='ftyp'?'video/mp4':'video/webm'):validateMaterialImage(original,10000);
  requireMaterial(!importSource||kind==='video',400,'自动准备来源必须对应视频分段。');
  let manifest:{durationSeconds:number;audioDurationSeconds?:number;frames:Record<string,unknown>[];audio:Record<string,unknown>[]}|null=null;
  if(form.has('manifest')){try{manifest=JSON.parse(String(form.get('manifest')));}catch{throw new MaterialError(400,'媒体处理清单无效。');}}
  const parts:PreparedPart[]=[];
  if(kind==='image'&&!manifest){const mime=validateMaterialImage(original);parts.push({bytes:original,doc:{kind:'image',position:0,startSeconds:0,endSeconds:0,state:'queued',text:'',mimeType:mime}});}
  else {
    requireMaterial(manifest&&typeof manifest==='object'&&Array.isArray(manifest.frames)&&Array.isArray(manifest.audio),400,'缺少媒体处理清单，请用页面重新上传。');
    const duration=numeric(manifest.durationSeconds,'视频时长');
    requireMaterial(!importSource||Math.abs(duration-(importSource.endSeconds-importSource.startSeconds))<=0.5,400,'视频分段时长与准备记录不一致。');
    if(manifest.audioDurationSeconds!==undefined){const audioDuration=numeric(manifest.audioDurationSeconds,'原音轨时长');requireMaterial(kind==='image'?audioDuration===0:Math.abs(audioDuration-duration)<=0.25,400,'视频和原音轨长度差异过大，请拆分或转换后上传。');}
    requireMaterial(kind==='image'?duration===0&&manifest.frames.length===1&&manifest.audio.length===0:duration>0&&duration<=MATERIAL_MAX_VIDEO_SECONDS&&manifest.frames.length>=1&&manifest.frames.length<=20&&manifest.audio.length>=1&&manifest.audio.length<=41,400,'视频最多 10 分钟，须包含声音及抽样画面。');
    const seen=new Set<string>();let previousFrame=-1;
    for(const raw of manifest.frames){requireMaterial(raw&&typeof raw==='object',400,'画面清单无效。');const field=cleanText(raw.field,30,'画面编号'),start=numeric(raw.startSeconds,'画面时间');requireMaterial(/^frame\d+$/.test(field)&&!seen.has(field)&&start>previousFrame&&start<=duration,400,'画面时间或编号无效。');seen.add(field);previousFrame=start;const item=formFile(form,field);requireMaterial(item.size<=8*1024*1024,413,'画面文件过大。');const bytes=new Uint8Array(await item.arrayBuffer());parts.push({bytes,doc:{kind:'image',position:parts.length,startSeconds:start,endSeconds:start,state:'queued',text:'',mimeType:validateMaterialImage(bytes)}});}
    let audioEnd=0;
    for(const raw of manifest.audio){requireMaterial(raw&&typeof raw==='object',400,'音轨清单无效。');const field=cleanText(raw.field,30,'音轨编号'),start=numeric(raw.startSeconds,'音轨时间');requireMaterial(/^audio\d+$/.test(field)&&!seen.has(field)&&Math.abs(start-audioEnd)<0.1,400,'音轨存在缺口或重复。');seen.add(field);const item=formFile(form,field);requireMaterial(item.size<=2_000_000,413,'音轨分段过大。');const bytes=new Uint8Array(await item.arrayBuffer());let seconds:number;try{seconds=validateRecordingWav(bytes).durationSeconds;}catch{throw new MaterialError(400,'音轨须为连续的单声道 16 kHz WAV 分段。');}audioEnd=start+seconds;parts.push({bytes,doc:{kind:'audio',position:parts.length,startSeconds:start,endSeconds:audioEnd,state:'queued',text:'',mimeType:'audio/wav'}});}
    requireMaterial(kind==='image'||Math.abs(audioEnd-duration)<0.25,400,'音轨长度与视频不一致，请重新处理。');
  }
  const filename=file.name.replace(/[\\/\u0000-\u001f\u007f]/g,'_').slice(0,180);
  const audioDifference=manifest?.audioDurationSeconds===undefined?'':`浏览器解码音轨 ${manifest.audioDurationSeconds.toFixed(3)} 秒；与视频相差 ${Math.abs(manifest.audioDurationSeconds-manifest.durationSeconds).toFixed(3)} 秒，尾部不足补静音、超出裁去。`;
  const sourceCoverage=importSource?`原视频：${importSource.filename}；源文件 SHA-256：${importSource.sourceHash}；第 ${importSource.index+1} 段按本机转码时间轴约 ${importSource.startSeconds.toFixed(1)}–${importSource.endSeconds.toFixed(1)} 秒（与原片可能有不超过 1 秒的编码偏差）；以下时间相对此分段。` : '';
  const coverage=kind==='image'?'单张图片文字与可辨认图表；小字、模糊处须对照原图核对。':`${sourceCoverage}音轨分段覆盖 ${manifest!.durationSeconds.toFixed(1)} 秒；${audioDifference}抽样 ${manifest!.frames.length} 帧（时间点：${manifest!.frames.map(frame=>Number(frame.startSeconds).toFixed(1)+'s').join('、')}）。非逐帧识别，画面切换间的信息可能遗漏，需人工核对原视频。`;
  return {caseId,title,sourceNote,requestId,filename,kind,mimeType,original,parts,coverage,importSource,fingerprint:hash(pack({title,sourceNote,caseId,original:hash(original),...(importSource?{importSource}:{}),parts:parts.map(part=>({hash:hash(part.bytes),...part.doc}))}))} as const;
}

async function upload(request:Request,user:User,checkCase:(caseId:string)=>void){
  const input=await parseUpload(request,user);checkCase(input.caseId);
  if(input.importSource){
    const source=input.importSource;
    const previous=db().prepare("SELECT id,owner_id,case_id,original,doc FROM material_documents WHERE json_extract(doc,'$.importSource.jobId')=? AND json_extract(doc,'$.importSource.index')=?").get(source.jobId,source.index);
    if(previous){
      const prior=unpack<StoredMaterial>(previous.doc);
      requireMaterial(previous.owner_id===user.id&&previous.case_id===input.caseId&&hash(new Uint8Array(previous.original as Uint8Array))===hash(input.original)&&prior.importSource?.sourceHash===source.sourceHash,409,'已提交的视频来源不一致，请核对原任务。');
      // A lost response may require preparing JPEG/WAV again. The verified source
      // segment identifies the existing material; derived bytes must not requeue it.
      return json(materialDetail(String(previous.id),user));
    }
  }
  const existing=db().prepare('SELECT id,fingerprint FROM material_documents WHERE owner_id=? AND request_id=?').get(user.id,input.requestId);
  if(existing){requireMaterial(existing.fingerprint===input.fingerprint,409,'同一上传编号的内容已改变，请重新上传。');return json(materialDetail(String(existing.id),user));}
  const config=materialProviderConfig();requireMaterial(config.configured,409,'资料识别需要完整的 OpenAI 配置，或明确选择模拟模式。');
  if(input.kind==='video'){const audio=recordingProviderConfig();requireMaterial(audio.configured&&audio.provider===config.provider,409,'视频声音转写与图片识别的服务配置不一致。');}
  const stamp=now(),document:StoredMaterial={id:id(),title:input.title,filename:input.filename,kind:input.kind,state:'queued',provider:config.provider,caseId:input.caseId,createdAt:stamp,updatedAt:stamp,version:1,error:null,sourceNote:input.sourceNote,originalText:'',reviewedText:'',coverage:input.coverage,events:[{at:stamp,action:'uploaded',detail:`已上传；${config.provider==='mock'?'模拟处理，不代表真实识别':'使用已配置的 OpenAI 云端处理'}；未复核，不供 AI 参考。`}]};
  if(input.importSource){document.importSource=input.importSource;event(document,'video_prepared',`本机自动压缩分段；批次 ${input.importSource.jobId}，转码时间轴约 ${input.importSource.startSeconds.toFixed(1)}–${input.importSource.endSeconds.toFixed(1)} 秒，与原片可能有不超过 1 秒的编码偏差。`);}
  transaction(()=>{
    const count=Number((db().prepare('SELECT count(*) n FROM material_documents WHERE owner_id=?').get(user.id) as {n:number}).n);requireMaterial(count<60,409,'当前资料库最多 60 份资料。');
    const bytes=Number((db().prepare('SELECT COALESCE(SUM(length(original)),0) n FROM material_documents').get() as {n:number}).n)+Number((db().prepare('SELECT COALESCE(SUM(length(bytes)),0) n FROM material_parts').get() as {n:number}).n);
    requireMaterial(bytes+input.original.byteLength+input.parts.reduce((sum,part)=>sum+part.bytes.byteLength,0)<=MATERIAL_MAX_STORAGE_BYTES,409,'本机资料存储已达 2 GB 上限，请由维护人员整理。');
    db().prepare('INSERT INTO material_documents VALUES(?,?,?,?,?,?,?,?,?)').run(document.id,user.id,input.caseId,input.requestId,input.fingerprint,document.state,pack(document),input.mimeType,input.original);
    for(const part of input.parts)db().prepare('INSERT INTO material_parts VALUES(?,?,?,?,?,?)').run(document.id,part.doc.position,'queued',part.doc.mimeType,part.bytes,pack(part.doc));
    audit(user.id,input.caseId,'material.uploaded',{materialId:document.id,kind:document.kind});
  });
  return json(materialDetail(document.id,user),201);
}

function editMaterial(user:User,input:Record<string,unknown>){
  return transaction(()=>{
    const document=ownerDocument(cleanText(input.id,100,'资料编号'),user);requireMaterial(input.version===document.version,409,'资料已更新，请刷新后再操作。');
    const action=input.action,note=cleanText(input.note??'',2000,'复核备注');
    requireMaterial(!['queued','processing'].includes(document.state),409,'资料仍在处理，请等待完成。');
    if(action==='retry'){
      requireMaterial(document.state==='failed',409,'仅失败的资料可以重试。');requireMaterial(document.events.filter(row=>row.action==='retry').length<3,409,'已达到重试次数，请核对失败原因。');
      requireMaterial(materialProviderConfig().configured&&materialProviderConfig().provider===document.provider,409,'处理服务配置已改变，请恢复原配置。');
      db().prepare("UPDATE material_parts SET state='queued' WHERE material_id=? AND state='processing'").run(document.id);document.state='queued';document.error=null;event(document,'retry','人工重试未完成分段，已完成结果保留；不清除历史用量或未确认预留。');
    } else if(action==='withdraw') {
      requireMaterial(document.state==='approved',409,'资料尚未启用。');document.state='withdrawn';event(document,'withdrawn',`已停止后续检索；已有对话上下文和报告快照保留。${note}`);
    } else if(action==='save'||action==='approve') {
      requireMaterial(['needs_review','approved','withdrawn'].includes(document.state),409,'请先完成自动提取。');
      const text=cleanText(input.reviewedText,MATERIAL_MAX_TEXT_BYTES,'复核正文');requireMaterial(text&&textBytes(text)<=MATERIAL_MAX_TEXT_BYTES,400,'复核正文不能为空或超过 64 KB。');
      requireMaterial(!/(?:-----BEGIN .*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,})/.test(text),400,'正文疑似包含密钥，请移除后再保存。');
      document.reviewedText=text;
      if(action==='approve'){
        requireMaterial(input.confirmed===true,400,'请确认已核对原资料和提取覆盖范围。');
        document.scope=input.allowAcrossCases===true?'organization':'case';
        const snapshot={title:document.title,content:text,sourceNote:document.sourceNote,coverage:document.coverage,provider:document.provider,scope:document.scope,approvedBy:user.id,approvedOrgId:user.orgId,approvedAt:now(),filename:document.filename};const revision=hash(pack(snapshot));
        db().prepare('INSERT INTO material_versions VALUES(?,?,?)').run(document.id,revision,pack(snapshot));document.state='approved';event(document,'approved',`由 ${user.name} 复核；${document.scope==='organization'?'已明确确认为不含客户个人信息的通用资料，供本公司所有顾问案例参考（不含外部共享测试账号）':'仅关联案例可参考'}。${note}`);
      } else {document.state='needs_review';event(document,'saved',`已保存修订，须重新复核后才能参考。${note}`);}
    } else throw new MaterialError(400,'不支持的资料操作。');
    saveDocument(document);audit(user.id,document.caseId,`material.${String(action)}`,{materialId:document.id,version:document.version});return materialDetail(document.id,user);
  });
}

function originalResponse(request:Request,bytes:Uint8Array<ArrayBuffer>,mimeType:string){
  const size=bytes.byteLength;
  const headers=new Headers({'Content-Type':mimeType,'Content-Length':String(size),'Accept-Ranges':'bytes','Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
  const range=request.headers.get('range');
  // No validators are published for private originals. Ignore conditional,
  // malformed or multipart ranges and return the complete representation.
  const match=!request.headers.has('if-range')&&range&&range.length<=256?/^bytes=(\d*)-(\d*)$/i.exec(range.trim()):null;
  if(!match||(!match[1]&&!match[2]))return new Response(bytes,{headers});
  const total=BigInt(size),suffix=!match[1],amount=suffix?BigInt(match[2]):0n;
  const start=suffix?(amount>=total?0n:total-amount):BigInt(match[1]);
  const requestedEnd=suffix||!match[2]?total-1n:BigInt(match[2]);
  if(!size||(suffix&&amount===0n)||start>=total||requestedEnd<start){
    headers.set('Content-Range',`bytes */${size}`);headers.set('Content-Length','0');
    return new Response(null,{status:416,headers});
  }
  const end=requestedEnd>=total?total-1n:requestedEnd;
  headers.set('Content-Range',`bytes ${start}-${end}/${size}`);
  headers.set('Content-Length',String(end-start+1n));
  return new Response(bytes.subarray(Number(start),Number(end)+1),{status:206,headers});
}

export async function handleMaterialRequest(request:Request,user:User,checkCase:(caseId:string)=>void):Promise<Response>{
  requireReviewer(user);
  if(request.method==='GET'){
    const params=new URL(request.url).searchParams,materialId=params.get('id');if(!materialId)return json(listMaterials(user));
    ownerDocument(materialId,user);
    if(params.get('original')==='1') {const row=db().prepare('SELECT original,mime_type FROM material_documents WHERE id=?').get(materialId)!;return originalResponse(request,new Uint8Array(row.original as Uint8Array),String(row.mime_type));}
    const revision=params.get('revision');if(revision){requireMaterial(/^[a-f0-9]{64}$/.test(revision),400,'版本编号无效。');const row=db().prepare('SELECT doc FROM material_versions WHERE material_id=? AND revision=?').get(materialId,revision);requireMaterial(row,404,'资料版本不存在。');return json(unpack(row.doc));}
    return json(materialDetail(materialId,user));
  }
  requireMaterial(request.method==='POST',405,'请求方法不支持。');
  if(request.headers.get('content-type')?.startsWith('multipart/form-data'))return upload(request,user,checkCase);
  const body=await readBounded(request,100_000);let input:Record<string,unknown>;try{input=JSON.parse(body.toString('utf8'));}catch{throw new MaterialError(400,'请求内容无效。');}requireMaterial(input&&typeof input==='object'&&!Array.isArray(input),400,'请求内容无效。');
  const document=ownerDocument(cleanText(input.id,100,'资料编号'),user);if(input.action!=='withdraw')checkCase(document.caseId);return json(editMaterial(user,input));
}

/** Never replay an uncertain network request automatically on restart. */
export function recoverMaterialJobs(){for(const doc of docs<StoredMaterial>("SELECT doc FROM material_documents WHERE state='processing'")){doc.state='failed';doc.error='处理因服务重启中断；已完成分段保留，请核对后重试。';event(doc,'interrupted',doc.error);saveDocument(doc);}}
export async function processMaterialJobs(recoveryDependencies?:Parameters<typeof recoverMaterialCoverage>[1]){
  if(state.aeconnMaterialBusy)return;state.aeconnMaterialBusy=true;
  try {
    const document=transaction(()=>{const doc=docs<StoredMaterial>("SELECT doc FROM material_documents WHERE state='queued' ORDER BY rowid LIMIT 1")[0];if(doc){doc.state='processing';event(doc,'processing','开始自动提取，结果仍须人工复核。');saveDocument(doc);}return doc;});if(!document)return;
    try {
      const config=materialProviderConfig();requireMaterial(config.configured&&config.provider===document.provider,409,'提取服务配置已改变，请恢复原配置后重试。');
      const record=docs<Case>('SELECT doc FROM cases WHERE id=?',document.caseId)[0];requireMaterial(record&&!record.deletedAt,409,'关联案例已删除，处理已停止。');
      for(const part of partsFor(document.id)){
        const row=db().prepare('SELECT state,bytes FROM material_parts WHERE material_id=? AND position=?').get(document.id,part.position)!;if(row.state==='done')continue;
        db().prepare("UPDATE material_parts SET state='processing' WHERE material_id=? AND position=?").run(document.id,part.position);
        const context={caseId:document.caseId,sessionId:`material:${document.id}:${part.position}`};
        if(part.kind==='image')part.text=(await extractMaterialImage({image:new Uint8Array(row.bytes as Uint8Array),mimeType:part.mimeType as 'image/png'|'image/jpeg'|'image/webp',context,provider:document.provider})).text;
        else {
          const audio=new Uint8Array(row.bytes as Uint8Array);
          const previous=partsFor(document.id).find(candidate=>candidate.kind==='audio'&&candidate.state==='done'&&Math.abs(candidate.endSeconds-part.startSeconds)<.1);
          const result=await transcribeRecordingChunk({audio,context,provider:document.provider,allowChunkTimingFallback:true,previousText:previous?.transcription?.segments.map(segment=>segment.text).join(' ')});
          part.transcription=result;
          part.text=result.segments.map(segment=>`[${(part.startSeconds+segment.startSeconds).toFixed(1)}–${(part.startSeconds+segment.endSeconds).toFixed(1)}s] ${segment.text}`).join('\n')||'【该分段未识别到可辨认语音，请核对原音轨】';
          if(result.timingWarning){part.text=`【${result.timingWarning}】\n${part.text}`;event(document,'timing_warning',`音轨 ${part.startSeconds.toFixed(1)}s：${result.timingWarning}`);}
          const warning=materialAudioTailWarning(audio,result,part.startSeconds);
          if(warning){part.text=`【覆盖待核对：${warning}】\n${part.text}`;event(document,'coverage_warning',warning);}
        }
        part.state='done';db().prepare("UPDATE material_parts SET state='done',doc=? WHERE material_id=? AND position=?").run(pack(part),document.id,part.position);
        event(document,'part_completed',`${part.kind==='image'?'画面':'音轨'} ${part.startSeconds.toFixed(1)}s 已处理。`);saveDocument(document);
      }
      document.originalText=partsFor(document.id).sort((a,b)=>a.startSeconds-b.startSeconds||a.kind.localeCompare(b.kind)).map(part=>`## ${part.kind==='image'?'画面':'音轨'} ${part.startSeconds.toFixed(1)}s\n${part.text}`).join('\n\n');
      if(document.kind==='video'){
        const audio:MaterialRecoveryAudio[]=partsFor(document.id).filter(part=>part.kind==='audio').map(part=>({...part,audio:new Uint8Array(db().prepare('SELECT bytes FROM material_parts WHERE material_id=? AND position=?').get(document.id,part.position)!.bytes as Uint8Array)}));
        document.autoCheck=await recoverMaterialCoverage({materialId:document.id,caseId:document.caseId,provider:document.provider,audio,state:document.autoCheck,
          loadVideo:()=>{const source=db().prepare('SELECT original,mime_type FROM material_documents WHERE id=?').get(document.id)!;return {video:new Uint8Array(source.original as Uint8Array),mimeType:String(source.mime_type)};},
          checkpoint:(check,action,detail)=>{document.autoCheck=check;event(document,action,detail);saveDocument(document);},
        },recoveryDependencies);
        const supplement=materialRecoveryText(document.autoCheck,audio);
        if(textBytes(document.originalText+supplement)<=MATERIAL_MAX_TEXT_BYTES)document.originalText+=supplement;
        else {
          const message='自动补提取文字较多，完整补充保留在处理记录中；请整理复核稿后再允许参考。';
          document.autoCheck.status='attention';document.autoCheck.issues.push({startSeconds:0,endSeconds:Math.max(...audio.map(part=>part.endSeconds)),message});event(document,'recovery_text_limit',message);
        }
      }
      requireMaterial(textBytes(document.originalText)<=MATERIAL_MAX_TEXT_BYTES,422,'提取文字超过 64 KB，请拆分视频后上传；已完成分段可查看。');
      document.reviewedText=document.originalText;document.state='needs_review';document.error=null;event(document,'extracted','提取完成，尚未允许 AI 参考。请核对金额、条件、例外和画面覆盖。');saveDocument(document);
    } catch(error){document.state='failed';document.error=error instanceof MaterialError||error instanceof RecordingTranscriptionError||error instanceof MaterialExtractionError?error.message:(error instanceof Error&&'code' in error&&error.code==='AI_BUDGET_LIMIT'?'关联案例或组织的调用额度不足，请核对后重试。':'自动提取未完成，请检查媒体格式、云端配置或额度后重试。');event(document,'failed',document.error);saveDocument(document);}
  } finally {state.aeconnMaterialBusy=false;}
}

export function materialBlocksCaseDeletion(caseId:string){return Boolean(db().prepare("SELECT id FROM material_documents WHERE case_id=? AND state IN ('queued','processing') LIMIT 1").get(caseId));}
export function purgeCaseMaterials(caseId:string){db().prepare('DELETE FROM material_documents WHERE case_id=?').run(caseId);}

export function approvedMaterialDocuments(caseId:string){
  const identity=db().prepare('SELECT owner_id,doc FROM cases WHERE id=?').get(caseId);if(!identity||unpack<Case>(identity.doc).deletedAt)return [];
  const owner=docs<User>('SELECT doc FROM users WHERE id=?',String(identity.owner_id))[0];if(!owner||owner.accessScope==='public_tester')return [];
  const rows=db().prepare(`SELECT m.id,m.owner_id,m.case_id,c.doc case_doc,v.revision,v.doc snapshot ${materialAccessFrom} JOIN material_versions v ON v.material_id=m.id WHERE owner.org_id=? AND uploader.org_id=? AND m.state='approved' AND v.rowid=(SELECT MAX(v2.rowid) FROM material_versions v2 WHERE v2.material_id=m.id) AND (m.case_id=? OR (json_extract(v.doc,'$.scope')='library' AND m.owner_id=?) OR (json_extract(v.doc,'$.scope')='organization' AND json_extract(v.doc,'$.approvedOrgId')=?)) ORDER BY m.rowid DESC LIMIT 60`).all(owner.orgId,owner.orgId,caseId,owner.id,owner.orgId);
  let bytes=0;const provider=materialProviderConfig().provider;
  return rows.flatMap(row=>{
    const snapshot=unpack<{title:string;content:string;sourceNote:string;coverage:string;provider:MaterialProvider;scope?:string;approvedOrgId?:string}>(row.snapshot);
    const legacyLibrary=snapshot.scope==='library'&&row.owner_id===owner.id;
    const organizationLibrary=snapshot.scope==='organization'&&snapshot.approvedOrgId===owner.orgId;
    if(unpack<Case>(row.case_doc).deletedAt||row.case_id!==caseId&&!legacyLibrary&&!organizationLibrary||snapshot.provider==='mock'&&provider!=='mock')return [];
    const content=`来源：${snapshot.sourceNote||'上传者未补充外部来源'}\n覆盖范围：${snapshot.coverage}\n\n${snapshot.content}`;bytes+=textBytes(content);if(bytes>512_000)return [];
    return [{title:snapshot.title,path:`uploads/${String(row.id)}/${snapshot.title}`,url:`/api/materials?id=${encodeURIComponent(String(row.id))}&revision=${String(row.revision)}`,revision:String(row.revision),content,reviewStatus:snapshot.provider==='mock'?'demo_unapproved' as const:'reference_only' as const}];
  });
}
