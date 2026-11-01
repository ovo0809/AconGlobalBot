'use client';
/* Authenticated user-upload previews intentionally use the original endpoint. */
/* eslint-disable @next/next/no-img-element */

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Case } from '../lib/domain';
import type { MaterialImportJob } from '../lib/material-import-types';
import type { MaterialAutoCheck, MaterialDetail, MaterialSummary } from '../lib/material-types';
import { prepareMaterialImage, prepareMaterialVideo, validateMaterialFile, type MaterialPreparationStage } from '../lib/material-browser';
import { isSupportedMaterialVideoFile, matchesMaterialImportFile, materialImportProgress, uploadMaterialImportChunks, validateLargeMaterialVideo } from '../lib/material-import-browser';

type ListResponse={items:MaterialSummary[];provider:'mock'|'openai';configured:boolean};
type ImportListResponse={available:boolean;items:MaterialImportJob[]};
const stateLabels:Record<MaterialSummary['state'],string>={queued:'等待处理',processing:'正在提取',needs_review:'待复核',approved:'已允许参考',failed:'处理失败',withdrawn:'已撤回'};
const stageLabels:Record<MaterialPreparationStage,string>={reading:'正在读取文件',inspecting:'正在检查视频',frames:'正在提取关键画面',audio:'正在整理音轨',ready:'正在上传'};
const scopeLabels:Record<string,string>={case:'仅关联案例',library:'原顾问通用范围',organization:'公司通用资料'};

async function responseJson<T>(response:Response):Promise<T>{const value=await response.json().catch(()=>({})) as T&{error?:string};if(!response.ok)throw new Error(value.error||'资料操作未完成，请重试。');return value;}
function textBytes(value:string){return new TextEncoder().encode(value).byteLength;}
const wait=(milliseconds:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal?.aborted){reject(new DOMException('资料处理已取消。','AbortError'));return;}const timer=window.setTimeout(done,milliseconds);function done(){signal?.removeEventListener('abort',cancel);resolve();}function cancel(){window.clearTimeout(timer);reject(new DOMException('资料处理已取消。','AbortError'));}signal?.addEventListener('abort',cancel,{once:true});});

function AutoCheckSummary({check}:{check:MaterialAutoCheck}){
  const audio=check.audio.filter(item=>item.status==='done'&&item.result?.segments.length).length;
  const frames=check.frames.filter(item=>item.status==='done'&&item.text).length;
  return <section className="material-warning" aria-label="视频自动检查"><strong>{check.status==='running'?'正在自动检查与补提取':check.issues.length?'自动检查完成，有内容需重点核对':audio||frames?'已自动补提取':'自动检查完成，未发现明显时间缺口'}</strong><p>已补转写 {audio} 段，补画面 {frames} 张。原提取结果与各次处理记录保留。</p>{check.issues.length>0&&<ul>{check.issues.map((issue,index)=><li key={index}>{issue.startSeconds.toFixed(1)}–{issue.endSeconds.toFixed(1)} 秒：{issue.message}</li>)}</ul>}{check.stoppedReason&&<p>{check.stoppedReason}</p>}<small>自动检查不能保证逐字完整。优先检查上面标出的区间；确认参考范围后，再允许 AI 使用。</small></section>;
}

export function MaterialLibrary({csrf,cases,activeCaseId}:{csrf:string;cases:Case[];activeCaseId?:string}){
  const [library,setLibrary]=useState<ListResponse>({items:[],provider:'mock',configured:true});
  const [imports,setImports]=useState<ImportListResponse>({available:false,items:[]});
  const [importLoadError,setImportLoadError]=useState('');
  const [selected,setSelected]=useState<MaterialDetail|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[message,setMessage]=useState<{kind:'error'|'success'|'info';text:string}|null>(null);
  const [title,setTitle]=useState(''),[sourceNote,setSourceNote]=useState(''),[caseId,setCaseId]=useState(activeCaseId||cases[0]?.id||''),[consent,setConsent]=useState(false),[file,setFile]=useState<File|null>(null);
  const [reviewedText,setReviewedText]=useState(''),[reviewNote,setReviewNote]=useState(''),[confirmed,setConfirmed]=useState(false),[allowAcrossCases,setAllowAcrossCases]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null),uploadAbort=useRef<AbortController|null>(null),uploadRequestId=useRef(''),importRequestId=useRef(''),activeImportId=useRef('');

  const load=useCallback(async()=>{const response=await fetch('/api/materials',{credentials:'same-origin',cache:'no-store'});const result=await responseJson<ListResponse>(response);setLibrary(result);return result;},[]);
  const loadImports=useCallback(async()=>{try{const response=await fetch('/api/material-imports',{credentials:'same-origin',cache:'no-store'});const result=await responseJson<ImportListResponse>(response);setImports(result);setImportLoadError('');return result;}catch(error){setImportLoadError(error instanceof Error?error.message:'无法读取大视频任务，请重试。');throw error;}},[]);
  const importAction=useCallback(async(body:Record<string,unknown>,signal?:AbortSignal)=>{const response=await fetch('/api/material-imports',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body),signal});return responseJson<MaterialImportJob>(response);},[csrf]);
  const open=useCallback(async(id:string)=>{setBusy('detail');try{const response=await fetch(`/api/materials?id=${encodeURIComponent(id)}`,{credentials:'same-origin',cache:'no-store'}),detail=await responseJson<MaterialDetail>(response);setSelected(detail);setReviewedText(detail.reviewedText||detail.originalText);setReviewNote('');setConfirmed(false);setAllowAcrossCases(false);}catch(error){setMessage({kind:'error',text:error instanceof Error?error.message:'无法读取资料。'});}finally{setBusy('');}},[]);
  useEffect(()=>{void Promise.all([load(),loadImports().catch(()=>({available:false,items:[]}))]).catch(error=>setMessage({kind:'error',text:error instanceof Error?error.message:'无法读取资料库。'})).finally(()=>setLoading(false));},[load,loadImports]);
  useEffect(()=>{
    if(!library.items.some(item=>item.state==='queued'||item.state==='processing'))return;
    const timer=window.setTimeout(()=>void load().then(()=>selected&&(selected.state==='queued'||selected.state==='processing')?open(selected.id):undefined).catch(error=>setMessage({kind:'error',text:error instanceof Error?error.message:'无法刷新处理状态。'})),1000);
    return()=>window.clearTimeout(timer);
  },[library.items,load,open,selected]);
  useEffect(()=>{if(!imports.items.some(item=>item.state==='queued'||item.state==='preparing'))return;const timer=window.setTimeout(()=>void loadImports().catch(()=>undefined),1000);return()=>window.clearTimeout(timer);},[imports.items,loadImports]);
  useEffect(()=>()=>uploadAbort.current?.abort(),[]);
  useEffect(()=>{uploadRequestId.current='';importRequestId.current='';},[caseId,file,sourceNote,title]);

  function updateImport(job:MaterialImportJob){setImports(value=>({...value,items:[job,...value.items.filter(item=>item.id!==job.id)]}));setMessage({kind:'info',text:materialImportProgress(job)});}

  async function waitForPrepared(job:MaterialImportJob,signal:AbortSignal){
    let current=job;
    while(current.state==='queued'||current.state==='preparing'){
      await wait(1000,signal);const response=await fetch(`/api/material-imports?id=${encodeURIComponent(current.id)}`,{credentials:'same-origin',cache:'no-store',signal});current=await responseJson<MaterialImportJob>(response);updateImport(current);
    }
    if(current.state==='failed')throw new Error(current.error||'大视频本机准备失败，请重试。');
    if(current.state!=='ready'&&current.state!=='completed')throw new Error('大视频处理已停止。');
    return current;
  }

  async function submitPreparedImport(job:MaterialImportJob,signal:AbortSignal){
    let current=job;
    for(const segment of current.segments){
      if(segment.materialId)continue;
      setMessage({kind:'info',text:`正在提取第 ${segment.index+1}/${current.segments.length} 段；已完成部分会保留。`});
      const segmentResponse=await fetch(`/api/material-imports?id=${encodeURIComponent(current.id)}&segment=${segment.index}`,{credentials:'same-origin',cache:'no-store',signal});
      if(!segmentResponse.ok)throw new Error((await segmentResponse.json().catch(()=>({})) as {error?:string}).error||'无法读取已准备的视频分段。');
      const blob=await segmentResponse.blob();if(blob.size!==segment.bytes)throw new Error('视频分段大小校验失败，请重试。');
      const segmentFile=new File([blob],segment.filename,{type:'video/mp4'});
      const prepared=await prepareMaterialVideo(segmentFile,{signal,onStage:value=>setMessage({kind:'info',text:`第 ${segment.index+1}/${current.segments.length} 段：${stageLabels[value]}`})});
      const suffix=`（第${segment.index+1}/${current.segments.length}段）`;
      const form=new FormData(),segmentTitle=`${current.title.slice(0,120-suffix.length)}${suffix}`;
      form.set('title',segmentTitle);form.set('sourceNote',current.sourceNote);form.set('caseId',current.caseId);form.set('consent','true');form.set('requestId',`${current.id}-${segment.index}`);form.set('file',segmentFile,segment.filename);form.set('manifest',JSON.stringify(prepared.manifest));form.set('importSource',JSON.stringify({jobId:current.id,index:segment.index}));
      for(const item of prepared.frames)form.set(item.field,item.blob,`${item.field}.jpg`);for(const item of prepared.audio)form.set(item.field,item.blob,`${item.field}.wav`);
      const uploadResponse=await fetch('/api/materials',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'x-csrf-token':csrf},body:form,signal}),created=await responseJson<MaterialSummary>(uploadResponse);
      current=await importAction({action:'ack',id:current.id,index:segment.index,materialId:created.id},signal);updateImport(current);
    }
    current=await importAction({action:'complete',id:current.id},signal);updateImport(current);await load();await loadImports();setTitle('');setSourceNote('');setConsent(false);setFile(null);importRequestId.current='';if(fileInput.current)fileInput.current.value='';setMessage({kind:'success',text:`大视频已分成 ${current.segments.length} 段送入提取；提取完成后请逐段复核。`});
  }

  async function continueImport(job:MaterialImportJob,sourceFile:File|null,signal:AbortSignal){
    let current=job;activeImportId.current=job.id;
    if(current.state==='uploading'){
      if(!sourceFile||!matchesMaterialImportFile(current,sourceFile))throw new Error(`请选择原文件“${current.filename}”继续上传。`);
      current=await uploadMaterialImportChunks({file:sourceFile,job:current,csrf,signal,onProgress:updateImport});
      current=await importAction({action:'prepare',id:current.id},signal);updateImport(current);
    }else if(current.state==='failed'){current=await importAction({action:'retry',id:current.id},signal);updateImport(current);}
    current=await waitForPrepared(current,signal);if(current.state==='ready')await submitPreparedImport(current,signal);activeImportId.current='';
  }

  async function startLargeImport(sourceFile:File,signal:AbortSignal){
    if(importLoadError)throw new Error(`无法读取大视频处理状态：${importLoadError}`);
    if(!imports.available)throw new Error('当前设备未启用本机大视频自动处理；小视频仍可直接上传。');
    validateLargeMaterialVideo(sourceFile); // The server confirms duration without reading up to 2 GB into browser memory.
    importRequestId.current||=crypto.randomUUID();
    const matching=imports.items.find(item=>item.state==='uploading'&&matchesMaterialImportFile(item,sourceFile)&&item.caseId===caseId&&item.title===title.trim()&&item.sourceNote===sourceNote.trim());
    // Preserve the creation response even if the user cancels; it contains the ID
    // needed to release the newly created task and its reserved local storage.
    const requestId=importRequestId.current;
    let job=matching;
    if(!job){
      try{job=await importAction({action:'start',requestId,caseId,title:title.trim(),sourceNote:sourceNote.trim(),filename:sourceFile.name,size:sourceFile.size,lastModified:sourceFile.lastModified,consent:true},AbortSignal.timeout(30_000));}
      catch(error){
        // If the response was lost, recover its server-owned ID before cancelling.
        if(signal.aborted){
          const recovered=await loadImports();const created=recovered.items.find(item=>item.requestId===requestId);
          if(created){await cancelImport(created);throw new DOMException('资料处理已取消。','AbortError');}
        }
        throw error;
      }
    }
    if(signal.aborted){await cancelImport(job);throw new DOMException('资料处理已取消。','AbortError');}
    updateImport(job);await continueImport(job,sourceFile,signal);
  }

  async function upload(event:FormEvent){
    event.preventDefault();if(!file||!title.trim()||!caseId||!consent)return;
    const controller=new AbortController();uploadAbort.current=controller;setBusy('upload');setMessage(null);
    try{
      if(isSupportedMaterialVideoFile(file)&&file.size>32*1024*1024){await startLargeImport(file,controller.signal);return;}
      const kind=validateMaterialFile(file);let prepared;
      try{prepared=kind==='image'?await prepareMaterialImage(file,controller.signal):await prepareMaterialVideo(file,{signal:controller.signal,onStage:value=>setMessage({kind:'info',text:stageLabels[value]})});}
      catch(error){if(kind==='video'&&imports.available&&(error as Error).name!=='AbortError'){await startLargeImport(file,controller.signal);return;}throw error;}
      setMessage({kind:'info',text:stageLabels.ready});
      const form=new FormData();form.set('title',title.trim());form.set('sourceNote',sourceNote.trim());form.set('caseId',caseId);form.set('consent','true');uploadRequestId.current||=crypto.randomUUID();form.set('requestId',uploadRequestId.current);form.set('file',file,file.name);form.set('manifest',JSON.stringify(prepared.manifest));
      for(const item of prepared.frames)form.set(item.field,item.blob,`${item.field}.jpg`);for(const item of prepared.audio)form.set(item.field,item.blob,`${item.field}.wav`);
      const response=await fetch('/api/materials',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'x-csrf-token':csrf},body:form,signal:controller.signal});
      const created=await responseJson<MaterialSummary>(response);uploadRequestId.current='';await load();setTitle('');setSourceNote('');setConsent(false);setFile(null);if(fileInput.current)fileInput.current.value='';setMessage({kind:'success',text:'资料已上传，提取完成后需要人工复核。'});await open(created.id);
    }catch(error){if((error as Error).name!=='AbortError')setMessage({kind:'error',text:error instanceof Error?error.message:'资料上传未完成。'});}finally{uploadAbort.current=null;activeImportId.current='';setBusy('');}
  }

  async function resumeImport(job:MaterialImportJob){const controller=new AbortController();uploadAbort.current=controller;setBusy('upload');setMessage(null);try{await continueImport(job,file,controller.signal);}catch(error){if((error as Error).name!=='AbortError')setMessage({kind:'error',text:error instanceof Error?error.message:'大视频处理未完成。'});}finally{uploadAbort.current=null;activeImportId.current='';setBusy('');}}
  async function cancelImport(job:MaterialImportJob){uploadAbort.current?.abort();setBusy('cancel-import');try{const updated=await importAction({action:'cancel',id:job.id});updateImport(updated);await loadImports();setMessage({kind:'info',text:'已停止大视频处理；已经送入提取的分段仍保留。'});}catch(error){setMessage({kind:'error',text:error instanceof Error?error.message:'无法停止大视频处理。'});}finally{setBusy('');}}
  async function cancelCurrent(){const id=activeImportId.current;uploadAbort.current?.abort();if(!id)return;setBusy('cancel-import');try{const updated=await importAction({action:'cancel',id});updateImport(updated);await loadImports();setMessage({kind:'info',text:'已停止大视频处理；已经送入提取的分段仍保留。'});}catch(error){setMessage({kind:'error',text:error instanceof Error?error.message:'无法停止大视频处理。'});}finally{activeImportId.current='';setBusy('');}}

  async function act(action:'save'|'approve'|'withdraw'|'retry'){
    if(!selected)return;if(textBytes(reviewedText)>64_000){setMessage({kind:'error',text:'复核文字不能超过 64 KB。'});return;}
    setBusy(action);setMessage(null);
    try{const response=await fetch('/api/materials',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action,id:selected.id,version:selected.version,reviewedText,note:reviewNote.trim(),confirmed:action==='approve'?confirmed:undefined,allowAcrossCases:action==='approve'?allowAcrossCases:undefined})}),detail=await responseJson<MaterialDetail>(response);setSelected(detail);setReviewedText(detail.reviewedText||detail.originalText);setReviewNote('');setConfirmed(false);setAllowAcrossCases(false);await load();setMessage({kind:'success',text:action==='approve'?'资料已复核，之后可供 AI 参考。':action==='withdraw'?'资料已撤回，不再供 AI 参考。':action==='retry'?'已重新排队处理。':'复核稿已保存。'});}catch(error){setMessage({kind:'error',text:error instanceof Error?error.message:'资料操作未完成。'});}finally{setBusy('');}
  }

  if(loading)return <div className="material-loading">正在读取资料库…</div>;
  return <div className="workspace-body material-scroll" role="region" aria-label="资料库内容" tabIndex={0}><div className="material-library">
    <section className="material-upload panel" aria-labelledby="material-upload-title"><header><div><span className="eyebrow">REVIEWED KNOWLEDGE</span><h2 id="material-upload-title">上传参考资料</h2><p>上传后自动检查视频缺口并限次补提取，重点核对仍存疑的区间，确认后 AI 才能参考。</p></div><span className="source-pill">{!library.configured?'提取服务未配置':library.provider==='openai'?'真实提取已配置':'模拟提取'}</span></header>
      <form onSubmit={upload}><div className="material-form-grid"><label>资料名称<input value={title} onChange={event=>setTitle(event.target.value)} maxLength={120} required/></label><label>关联复核案例<select value={caseId} onChange={event=>setCaseId(event.target.value)} required><option value="">请选择已分配案例</option>{cases.map(record=><option key={record.id} value={record.id}>{record.clientName||record.id}</option>)}</select></label><label className="material-file">图片或视频<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,video/*" onChange={event=>setFile(event.target.files?.[0]||null)} required/><small>图片不超过 8 MB；MP4／MOV 大视频支持至 2 GB、2 小时，本机自动压缩分段。WebM 仍限 32 MB、10 分钟。</small></label><label>来源说明<textarea value={sourceNote} onChange={event=>setSourceNote(event.target.value)} rows={3} maxLength={1000} placeholder="来源、机构、发布日期或授权范围"/></label></div>{!cases.length&&<p className="material-warning">当前没有分配给 Charles 的案例，暂时不能上传资料。</p>}{importLoadError?<p className="material-message error">{importLoadError} <button type="button" className="text-button" onClick={()=>void loadImports().catch(()=>undefined)}>重新加载大视频任务</button></p>:!imports.available&&<p className="material-warning">当前设备未启用大视频自动处理；图片和小视频仍可上传。</p>}<label className="check-label material-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>我确认有权处理这份资料，并理解视频会提取音轨、定时抽样画面及片尾画面（最多 20 帧），并对疑似遗漏片段自动补转写／补画面；仍不能保证识别全部字幕。大视频的本机压缩不调用 AI；各分段提取{library.provider==='openai'?'将发送至 OpenAI，并受现有费用保护。':'使用明确标识的模拟服务。'}</span></label><div className="material-upload-actions"><button className="button button-primary" disabled={Boolean(busy)||!library.configured||!file||!consent||!cases.length}>{busy==='upload'?'正在处理资料…':'上传并自动提取'}</button>{busy==='upload'&&<button type="button" className="button button-secondary" onClick={()=>void cancelCurrent()}>取消</button>}</div></form>
      {imports.items.some(item=>item.state!=='cancelled')&&<div className="material-events"><h3>大视频处理进度</h3>{imports.items.filter(item=>item.state!=='cancelled').map(item=><div key={item.id}><p><b>{item.title}</b> · {item.filename}<br/><span>{materialImportProgress(item)}</span></p><div className="material-upload-actions">{item.state!=='completed'&&<button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={()=>void resumeImport(item)}>{item.state==='uploading'?'选择原文件并继续':'继续处理'}</button>}{!['completed','cancelled'].includes(item.state)&&<button type="button" className="button button-danger" disabled={Boolean(busy)} onClick={()=>void cancelImport(item)}>停止</button>}</div></div>)}</div>}
    </section>
    {message&&<p role="status" className={`material-message ${message.kind}`}>{message.text}</p>}
    <div className="material-workspace">
      <section className="material-list panel" aria-label="资料处理列表"><header><div><span className="eyebrow">PROCESSING LOG</span><h2>资料处理列表</h2></div><span>{library.items.length} 项</span></header>{library.items.length?<div>{library.items.map(item=><button key={item.id} disabled={Boolean(busy)} className={selected?.id===item.id?'selected':''} onClick={()=>void open(item.id)}><span className="material-kind" aria-hidden="true">{item.kind==='image'?'图':'影'}</span><span><b>{item.title}</b><small>{item.filename}</small></span><span className={`status material-state-${item.state}`}>{stateLabels[item.state]}</span></button>)}</div>:<p className="material-empty">还没有上传资料。</p>}</section>
      <section className="material-detail panel" aria-label="资料复核">{selected?<><header><div><span className="eyebrow">SOURCE REVIEW</span><h2>{selected.title}</h2><p>{selected.filename} · {stateLabels[selected.state]}</p></div>{selected.state==='failed'&&<button className="button button-secondary" disabled={Boolean(busy)} onClick={()=>void act('retry')}>重新处理</button>}</header>{selected.error&&<p className="material-message error">{selected.error}</p>}<div className="material-preview">{selected.kind==='image'?<img src={`/api/materials?id=${encodeURIComponent(selected.id)}&original=1`} alt={`${selected.title} 原始图片`}/>:<video key={selected.id} aria-label="资料视频预览" src={`/api/materials?id=${encodeURIComponent(selected.id)}&original=1`} controls preload="metadata" playsInline/>}</div><dl className="material-meta"><div><dt>来源说明</dt><dd>{selected.sourceNote||'未填写'}</dd></div><div><dt>提取覆盖</dt><dd>{selected.coverage}</dd></div><div><dt>参考范围</dt><dd>{scopeLabels[selected.scope??'case']??'仅关联案例'}</dd></div></dl>{selected.autoCheck&&<AutoCheckSummary check={selected.autoCheck}/>}{!selected.autoCheck&&selected.state!=='approved'&&selected.events.filter(event=>event.action==='coverage_warning').map((event,i)=><p key={i} className="material-warning" role="status">提取覆盖待核对：{event.detail}</p>)}<label>AI 原始提取<textarea value={selected.originalText} readOnly rows={8}/></label><label>人工复核稿<textarea value={reviewedText} onChange={event=>setReviewedText(event.target.value)} rows={12} maxLength={64_000}/><small>{textBytes(reviewedText).toLocaleString()} / 64,000 bytes</small></label><label>复核备注<textarea value={reviewNote} onChange={event=>setReviewNote(event.target.value)} rows={3} maxLength={1000}/></label>{selected.state==='approved'&&reviewedText!==selected.reviewedText&&<p className="material-warning">修改已批准资料后，保存会先撤回 AI 参考资格，待重新复核。</p>}<label className="check-label material-review-check"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>已核对原资料及提取范围</span></label><label className="check-label material-review-check"><input type="checkbox" checked={allowAcrossCases} onChange={event=>setAllowAcrossCases(event.target.checked)}/><span>这是通用参考资料，不含客户个人信息，可供公司内所有顾问的案例参考</span></label><div className="material-review-actions"><button className="button button-secondary" disabled={Boolean(busy)||selected.state==='queued'||selected.state==='processing'||selected.state==='failed'} onClick={()=>void act('save')}>保存复核稿</button><button className="button button-primary" disabled={Boolean(busy)||!confirmed||selected.state==='queued'||selected.state==='processing'||selected.state==='failed'} onClick={()=>void act('approve')}>复核通过并允许 AI 参考</button>{selected.state==='approved'&&<button className="button button-danger" disabled={Boolean(busy)} onClick={()=>void act('withdraw')}>撤回参考资格</button>}</div><details className="material-events"><summary>查看处理记录</summary>{selected.parts.map((part,index)=><div key={`${part.kind}-${part.position}-${index}`}><p>{part.kind==='image'?'画面':'音频'} {part.startSeconds.toFixed(1)}–{part.endSeconds.toFixed(1)} 秒 · {part.state==='done'?'已完成':'等待处理'}</p>{part.text&&<pre>{part.text}</pre>}</div>)}{selected.autoCheck?.audio.map(attempt=><div key={attempt.key}><p>自动补转写 · {attempt.status}</p>{attempt.result&&<pre>{attempt.result.segments.map(segment=>segment.text).join('\n')}</pre>}{attempt.error&&<p>{attempt.error}</p>}</div>)}{selected.autoCheck?.frames.map((attempt,index)=><div key={index}><p>自动补画面约 {attempt.timeSeconds.toFixed(1)} 秒 · {attempt.status}</p>{attempt.text&&<pre>{attempt.text}</pre>}{attempt.error&&<p>{attempt.error}</p>}</div>)}{selected.events.map((event,index)=><p key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleString('zh-CN')}</time> · {event.action} · {event.detail}</p>)}</details></>:<div className="material-empty material-empty-detail"><h2>选择一份资料</h2><p>查看原文件、提取结果、覆盖范围和处理记录。</p></div>}</section>
    </div>
  </div></div>;
}
