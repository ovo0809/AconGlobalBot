'use client';
/* Authenticated user-upload previews intentionally use the original endpoint. */
/* eslint-disable @next/next/no-img-element */

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Case } from '../lib/domain';
import type { MaterialDetail, MaterialSummary } from '../lib/material-types';
import { prepareMaterialImage, prepareMaterialVideo, validateMaterialFile, type MaterialPreparationStage } from '../lib/material-browser';

type ListResponse={items:MaterialSummary[];provider:'mock'|'openai';configured:boolean};
const stateLabels:Record<MaterialSummary['state'],string>={queued:'等待处理',processing:'正在提取',needs_review:'待复核',approved:'已允许参考',failed:'处理失败',withdrawn:'已撤回'};
const stageLabels:Record<MaterialPreparationStage,string>={reading:'正在读取文件',inspecting:'正在检查视频',frames:'正在提取关键画面',audio:'正在整理音轨',ready:'正在上传'};

async function responseJson<T>(response:Response):Promise<T>{const value=await response.json().catch(()=>({})) as T&{error?:string};if(!response.ok)throw new Error(value.error||'资料操作未完成，请重试。');return value;}
function textBytes(value:string){return new TextEncoder().encode(value).byteLength;}

export function MaterialLibrary({csrf,cases,activeCaseId}:{csrf:string;cases:Case[];activeCaseId?:string}){
  const [library,setLibrary]=useState<ListResponse>({items:[],provider:'mock',configured:true});
  const [selected,setSelected]=useState<MaterialDetail|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[message,setMessage]=useState<{kind:'error'|'success'|'info';text:string}|null>(null);
  const [title,setTitle]=useState(''),[sourceNote,setSourceNote]=useState(''),[caseId,setCaseId]=useState(activeCaseId||cases[0]?.id||''),[consent,setConsent]=useState(false),[file,setFile]=useState<File|null>(null);
  const [reviewedText,setReviewedText]=useState(''),[reviewNote,setReviewNote]=useState(''),[confirmed,setConfirmed]=useState(false),[allowAcrossCases,setAllowAcrossCases]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null),uploadAbort=useRef<AbortController|null>(null),uploadRequestId=useRef('');

  const load=useCallback(async()=>{const response=await fetch('/api/materials',{credentials:'same-origin',cache:'no-store'});const result=await responseJson<ListResponse>(response);setLibrary(result);return result;},[]);
  const open=useCallback(async(id:string)=>{setBusy('detail');try{const response=await fetch(`/api/materials?id=${encodeURIComponent(id)}`,{credentials:'same-origin',cache:'no-store'}),detail=await responseJson<MaterialDetail>(response);setSelected(detail);setReviewedText(detail.reviewedText||detail.originalText);setReviewNote('');setConfirmed(false);setAllowAcrossCases(false);}catch(error){setMessage({kind:'error',text:error instanceof Error?error.message:'无法读取资料。'});}finally{setBusy('');}},[]);
  useEffect(()=>{void load().catch(error=>setMessage({kind:'error',text:error instanceof Error?error.message:'无法读取资料库。'})).finally(()=>setLoading(false));},[load]);
  useEffect(()=>{
    if(!library.items.some(item=>item.state==='queued'||item.state==='processing'))return;
    const timer=window.setTimeout(()=>void load().then(()=>selected&&(selected.state==='queued'||selected.state==='processing')?open(selected.id):undefined).catch(error=>setMessage({kind:'error',text:error instanceof Error?error.message:'无法刷新处理状态。'})),1000);
    return()=>window.clearTimeout(timer);
  },[library.items,load,open,selected]);
  useEffect(()=>()=>uploadAbort.current?.abort(),[]);
  useEffect(()=>{uploadRequestId.current='';},[caseId,file,sourceNote,title]);

  async function upload(event:FormEvent){
    event.preventDefault();if(!file||!title.trim()||!caseId||!consent)return;
    const controller=new AbortController();uploadAbort.current=controller;setBusy('upload');setMessage(null);
    try{
      const kind=validateMaterialFile(file);
      const prepared=kind==='image'?await prepareMaterialImage(file,controller.signal):await prepareMaterialVideo(file,{signal:controller.signal,onStage:value=>setMessage({kind:'info',text:stageLabels[value]})});
      setMessage({kind:'info',text:stageLabels.ready});
      const form=new FormData();form.set('title',title.trim());form.set('sourceNote',sourceNote.trim());form.set('caseId',caseId);form.set('consent','true');uploadRequestId.current||=crypto.randomUUID();form.set('requestId',uploadRequestId.current);form.set('file',file,file.name);form.set('manifest',JSON.stringify(prepared.manifest));
      for(const item of prepared.frames)form.set(item.field,item.blob,`${item.field}.jpg`);for(const item of prepared.audio)form.set(item.field,item.blob,`${item.field}.wav`);
      const response=await fetch('/api/materials',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'x-csrf-token':csrf},body:form,signal:controller.signal});
      const created=await responseJson<MaterialSummary>(response);uploadRequestId.current='';await load();setTitle('');setSourceNote('');setConsent(false);setFile(null);if(fileInput.current)fileInput.current.value='';setMessage({kind:'success',text:'资料已上传，提取完成后需要人工复核。'});await open(created.id);
    }catch(error){if((error as Error).name!=='AbortError')setMessage({kind:'error',text:error instanceof Error?error.message:'资料上传未完成。'});}finally{uploadAbort.current=null;setBusy('');}
  }

  async function act(action:'save'|'approve'|'withdraw'|'retry'){
    if(!selected)return;if(textBytes(reviewedText)>64_000){setMessage({kind:'error',text:'复核文字不能超过 64 KB。'});return;}
    setBusy(action);setMessage(null);
    try{const response=await fetch('/api/materials',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action,id:selected.id,version:selected.version,reviewedText,note:reviewNote.trim(),confirmed:action==='approve'?confirmed:undefined,allowAcrossCases:action==='approve'?allowAcrossCases:undefined})}),detail=await responseJson<MaterialDetail>(response);setSelected(detail);setReviewedText(detail.reviewedText||detail.originalText);setReviewNote('');setConfirmed(false);setAllowAcrossCases(false);await load();setMessage({kind:'success',text:action==='approve'?'资料已复核，之后可供 AI 参考。':action==='withdraw'?'资料已撤回，不再供 AI 参考。':action==='retry'?'已重新排队处理。':'复核稿已保存。'});}catch(error){setMessage({kind:'error',text:error instanceof Error?error.message:'资料操作未完成。'});}finally{setBusy('');}
  }

  if(loading)return <div className="material-loading">正在读取资料库…</div>;
  return <div className="workspace-body material-scroll" role="region" aria-label="资料库内容" tabIndex={0}><div className="material-library">
    <section className="material-upload panel" aria-labelledby="material-upload-title"><header><div><span className="eyebrow">PRIVATE KNOWLEDGE</span><h2 id="material-upload-title">上传参考资料</h2><p>图片或视频会先提取为待复核文字，只有复核通过后才供 AI 参考。</p></div><span className="source-pill">{!library.configured?'提取服务未配置':library.provider==='openai'?'真实提取已配置':'模拟提取'}</span></header>
      <form onSubmit={upload}><div className="material-form-grid"><label>资料名称<input value={title} onChange={event=>setTitle(event.target.value)} maxLength={120} required/></label><label>关联案例<select value={caseId} onChange={event=>setCaseId(event.target.value)} required><option value="">请选择案例</option>{cases.map(record=><option key={record.id} value={record.id}>{record.clientName||record.id}</option>)}</select></label><label className="material-file">图片或视频<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,video/*" onChange={event=>setFile(event.target.files?.[0]||null)} required/><small>图片不超过 8 MB；视频不超过 32 MB、10 分钟。</small></label><label>来源说明<textarea value={sourceNote} onChange={event=>setSourceNote(event.target.value)} rows={3} maxLength={1000} placeholder="来源、机构、发布日期或授权范围"/></label></div><label className="check-label material-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>我确认有权处理这份资料，并理解视频仅抽取音轨和每 30 秒的关键画面。{library.provider==='openai'?'上传内容将发送至 OpenAI 云端完成提取。':'当前为明确标识的模拟提取。'}</span></label><div className="material-upload-actions"><button className="button button-primary" disabled={Boolean(busy)||!library.configured||!file||!consent}>{busy==='upload'?'正在准备资料…':'上传并自动提取'}</button>{busy==='upload'&&<button type="button" className="button button-secondary" onClick={()=>uploadAbort.current?.abort()}>取消</button>}</div></form>
    </section>
    {message&&<p role="status" className={`material-message ${message.kind}`}>{message.text}</p>}
    <div className="material-workspace">
      <section className="material-list panel" aria-label="资料处理列表"><header><div><span className="eyebrow">PROCESSING LOG</span><h2>资料处理列表</h2></div><span>{library.items.length} 项</span></header>{library.items.length?<div>{library.items.map(item=><button key={item.id} disabled={Boolean(busy)} className={selected?.id===item.id?'selected':''} onClick={()=>void open(item.id)}><span className="material-kind" aria-hidden="true">{item.kind==='image'?'图':'影'}</span><span><b>{item.title}</b><small>{item.filename}</small></span><span className={`status material-state-${item.state}`}>{stateLabels[item.state]}</span></button>)}</div>:<p className="material-empty">还没有上传资料。</p>}</section>
      <section className="material-detail panel" aria-label="资料复核">{selected?<><header><div><span className="eyebrow">SOURCE REVIEW</span><h2>{selected.title}</h2><p>{selected.filename} · {stateLabels[selected.state]}</p></div>{selected.state==='failed'&&<button className="button button-secondary" disabled={Boolean(busy)} onClick={()=>void act('retry')}>重新处理</button>}</header>{selected.error&&<p className="material-message error">{selected.error}</p>}<div className="material-preview">{selected.kind==='image'?<img src={`/api/materials?id=${encodeURIComponent(selected.id)}&original=1`} alt={`${selected.title} 原始图片`}/>:<video src={`/api/materials?id=${encodeURIComponent(selected.id)}&original=1`} controls preload="metadata"/>}</div><dl className="material-meta"><div><dt>来源说明</dt><dd>{selected.sourceNote||'未填写'}</dd></div><div><dt>提取覆盖</dt><dd>{selected.coverage}</dd></div><div><dt>参考范围</dt><dd>{selected.scope==='library'?'本人通用资料库':'仅关联案例'}</dd></div></dl><label>AI 原始提取<textarea value={selected.originalText} readOnly rows={8}/></label><label>人工复核稿<textarea value={reviewedText} onChange={event=>setReviewedText(event.target.value)} rows={12} maxLength={64_000}/><small>{textBytes(reviewedText).toLocaleString()} / 64,000 bytes</small></label><label>复核备注<textarea value={reviewNote} onChange={event=>setReviewNote(event.target.value)} rows={3} maxLength={1000}/></label>{selected.state==='approved'&&reviewedText!==selected.reviewedText&&<p className="material-warning">修改已批准资料后，保存会先撤回 AI 参考资格，待重新复核。</p>}<label className="check-label material-review-check"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>已核对原资料及提取范围</span></label><label className="check-label material-review-check"><input type="checkbox" checked={allowAcrossCases} onChange={event=>setAllowAcrossCases(event.target.checked)}/><span>这是通用参考资料，不含客户个人信息，可用于我名下其他案例</span></label><div className="material-review-actions"><button className="button button-secondary" disabled={Boolean(busy)||selected.state==='queued'||selected.state==='processing'||selected.state==='failed'} onClick={()=>void act('save')}>保存复核稿</button><button className="button button-primary" disabled={Boolean(busy)||!confirmed||selected.state==='queued'||selected.state==='processing'||selected.state==='failed'} onClick={()=>void act('approve')}>复核通过并允许 AI 参考</button>{selected.state==='approved'&&<button className="button button-danger" disabled={Boolean(busy)} onClick={()=>void act('withdraw')}>撤回参考资格</button>}</div><details className="material-events"><summary>查看处理记录</summary>{selected.parts.map((part,index)=><div key={`${part.kind}-${part.position}-${index}`}><p>{part.kind==='image'?'画面':'音频'} {part.startSeconds.toFixed(1)}–{part.endSeconds.toFixed(1)} 秒 · {part.state==='done'?'已完成':'等待处理'}</p>{part.text&&<pre>{part.text}</pre>}</div>)}{selected.events.map((event,index)=><p key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleString('zh-CN')}</time> · {event.action} · {event.detail}</p>)}</details></>:<div className="material-empty material-empty-detail"><h2>选择一份资料</h2><p>查看原文件、提取结果、覆盖范围和处理记录。</p></div>}</section>
    </div>
  </div></div>;
}
