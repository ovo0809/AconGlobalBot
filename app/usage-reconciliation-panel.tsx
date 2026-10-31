'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { ReconciliationOverview } from '../lib/usage-reconciliation-types';

type Preview = {
  previewToken:string;
  callId:string;
  version:string;
  recordedMicros:number;
  confirmedMicros:number;
  accountedMicros:number;
  releasedMicros:number;
  evidenceRef:string;
  note:string;
};

type ActionResponse={ok?:boolean;error?:string;preview?:Preview;result?:unknown};

const money=(micros:number)=>`$${(micros/1_000_000).toFixed(6).replace(/0+$/,'').replace(/\.$/,'')}`;
const dateTime=(value:string|null)=>value?`${new Date(value).toISOString().slice(0,19).replace('T',' ')} UTC`:'进行中';
const shortId=(value:string)=>value.length>13?`${value.slice(0,8)}…${value.slice(-4)}`:value;
const methodName=(method:'manual'|'automatic')=>method==='manual'?'人工结算':'自动结算';
const staleError=(error:unknown)=>error instanceof Error&&(/(记录|调用).*(变化|版本|已结算|完成结算|不再.*待核对)/.test(error.message)||/结算预览.*失效/.test(error.message));

async function post(csrf:string,body:Record<string,unknown>):Promise<ActionResponse>{
  const response=await fetch('/api/action',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({})) as ActionResponse;
  if(!response.ok)throw Object.assign(new Error(result.error||'操作未完成，请重试。'),{status:response.status});
  return result;
}

export function UsageReconciliationPanel({csrf,overview,onRefresh}:{csrf:string;overview:ReconciliationOverview;onRefresh:()=>Promise<unknown>}){
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [amountUsd,setAmountUsd]=useState('');
  const [evidenceRef,setEvidenceRef]=useState('');
  const [note,setNote]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState<'preview'|'settle'|'automatic'|''>('');
  const [message,setMessage]=useState<{kind:'success'|'error'|'info';text:string}|null>(null);
  const requestId=useRef<string|null>(null);
  const busyRef=useRef(false);
  const previewGeneration=useRef(0);
  const mounted=useRef(true);
  const selected=overview.pending.find(item=>item.id===selectedId)??null;

  const invalidate=useCallback(()=>{previewGeneration.current++;setPreview(null);setConfirmed(false);requestId.current=null;setMessage(null);},[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestId.current=null;};},[]);
  useEffect(()=>{
    if(selectedId&&!overview.pending.some(item=>item.id===selectedId)){setSelectedId(null);setAmountUsd('');setEvidenceRef('');setNote('');invalidate();}
  },[invalidate,overview.pending,selectedId]);
  useEffect(()=>{
    if(preview&&(!selected||selected.version!==preview.version)){
      previewGeneration.current++;setPreview(null);setConfirmed(false);requestId.current=null;
      setMessage({kind:'error',text:'记录已变化，原结算预览已经作废。请按最新数据重新核对。'});
    }
  },[preview,selected]);

  function begin(kind:'preview'|'settle'|'automatic'){
    if(busyRef.current)return false;
    busyRef.current=true;setBusy(kind);return true;
  }
  function finish(){busyRef.current=false;if(mounted.current)setBusy('');}

  const runAutomatic=useCallback(async(silent=false)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy('automatic');
    try{
      const response=await post(csrf,{action:'reconcileUsage'});
      if(!mounted.current)return;
      await onRefresh();
      if(!silent){const count=typeof response.result==='number'?response.result:0;setMessage({kind:'success',text:count>0?`自动核对已结算 ${count} 笔调用。`:'没有发现可自动结算的新记录。'});}
    }catch(error){
      if(!mounted.current)return;
      if(!silent)setMessage({kind:'error',text:error instanceof Error?error.message:'自动核对未完成。'});
    }finally{busyRef.current=false;if(mounted.current)setBusy('');}
  },[csrf,onRefresh]);

  function selectCall(callId:string){
    setSelectedId(callId);setAmountUsd('');setEvidenceRef('');setNote('');invalidate();
  }
  async function previewSettlement(event:FormEvent){
    event.preventDefault();if(!selected||selected.status!=='unknown')return;
    if(!begin('preview'))return;
    const generation=previewGeneration.current;
    setMessage(null);
    try{
      const response=await post(csrf,{action:'previewUsageSettlement',callId:selected.id,version:selected.version,amountUsd,evidenceRef,note});
      if(!response.preview?.previewToken)throw new Error('服务端没有返回有效的结算预览。');
      if(!mounted.current||generation!==previewGeneration.current)return;
      setPreview(response.preview);setConfirmed(false);requestId.current=null;
      setMessage({kind:'info',text:'请核对结算后计入金额与释放金额，再勾选确认。'});
    }catch(error){
      if(!mounted.current)return;
      const stale=staleError(error);
      setPreview(null);setConfirmed(false);requestId.current=null;
      setMessage({kind:'error',text:stale?'记录已变化，预览已失效。正在刷新最新数据，请重新核对。':error instanceof Error?error.message:'无法生成结算预览。'});
      if(stale)await onRefresh().catch(()=>undefined);
    }finally{finish();}
  }
  async function settle(){
    if(!selected||!preview||selected.version!==preview.version||!confirmed||busyRef.current)return;
    if(!begin('settle'))return;
    requestId.current??=crypto.randomUUID();
    setMessage(null);
    try{
      await post(csrf,{action:'settleUsage',callId:selected.id,version:preview.version,amountUsd,evidenceRef,note,previewToken:preview.previewToken,requestId:requestId.current,confirmed:true});
      if(!mounted.current)return;
      await onRefresh();
      setSelectedId(null);setAmountUsd('');setEvidenceRef('');setNote('');setPreview(null);setConfirmed(false);requestId.current=null;
      setMessage({kind:'success',text:'结算已保存，确认未使用的预留已经释放。'});
    }catch(error){
      if(!mounted.current)return;
      const stale=staleError(error);
      if(stale){setPreview(null);setConfirmed(false);requestId.current=null;await onRefresh().catch(()=>undefined);}
      setMessage({kind:'error',text:stale?'记录已变化，未执行结算。请按最新数据重新预览。':error instanceof Error?error.message:'结算未完成，请重试。'});
    }finally{finish();}
  }

  return <section className="panel reconciliation-panel" aria-labelledby="usage-reconciliation-title">
    <div className="reconciliation-heading"><div><span className="eyebrow">内部费用控制</span><h2 id="usage-reconciliation-title">调用对账与结算</h2></div><button type="button" className="button button-secondary" onClick={()=>void runAutomatic()} disabled={Boolean(busy)}>{busy==='automatic'?'正在核对…':'立即自动核对'}</button></div>
    <p className="helper">后台每 30 秒核对已完整保存的供应商用量，并自动结算；这里也可以立即触发一次核对。这不是云端账单轮询。历史记录若缺少完整用量，需要根据官方账单或用量导出人工核对；时间经过或空白账单不会自动释放。</p>
    <div className="budget-limits" aria-label="应用费用上限"><span>每案例 <b>{money(overview.limits.caseMicros)}</b></span><span>每天 <b>{money(overview.limits.dailyMicros)}</b></span><span>每月 <b>{money(overview.limits.monthlyMicros)}</b></span></div>
    {message&&<p role="status" className={`reconciliation-message ${message.kind}`}>{message.text}</p>}
    <div className="reconciliation-list" aria-label="待核对调用">
      {!overview.pending.length&&<p className="reconciliation-empty">当前没有待核对或进行中的调用。</p>}
      {overview.pending.map(item=><article key={item.id} className={`reconciliation-row ${selectedId===item.id?'selected':''}`}>
        <div className="reconciliation-row-title"><b title={item.id}>{shortId(item.id)}</b><span className={`status ${item.status==='unknown'?'status-warning':''}`}>{item.status==='unknown'?'待人工核对':'调用进行中'}</span></div>
        <dl><div><dt>开始（UTC）</dt><dd>{dateTime(item.createdAt)}</dd></div><div><dt>结束（UTC）</dt><dd>{dateTime(item.closedAt)}</dd></div><div><dt>类型</dt><dd>{item.operation}</dd></div><div><dt>模型</dt><dd>{item.model}</dd></div><div><dt>已记录估算</dt><dd>{money(item.recordedMicros)}</dd></div><div><dt>原预留</dt><dd>{money(item.reservedMicros)}</dd></div><div><dt>待释放核对</dt><dd>{money(item.heldMicros)}</dd></div></dl>
        <div className="reconciliation-row-action">{item.automaticReady&&<span className="source-pill">具备自动结算凭据</span>}<button type="button" className="button button-secondary" onClick={()=>selectCall(item.id)} disabled={item.status!=='unknown'||Boolean(busy)}>{item.status==='unknown'?'人工结算':'等待调用结束'}</button></div>
      </article>)}
    </div>
    {selected&&<form className="settlement-form" onSubmit={previewSettlement}>
      <h3>人工结算 {shortId(selected.id)}</h3>
      <label>官方确认的本次最终金额（USD）<input value={amountUsd} onChange={event=>{setAmountUsd(event.target.value);invalidate();}} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?" placeholder="例如 0.041324" disabled={Boolean(busy)} required/></label>
      <label>官方证据编号或文件引用<input value={evidenceRef} onChange={event=>{setEvidenceRef(event.target.value);invalidate();}} maxLength={240} placeholder="例如 OpenAI Usage 导出文件名与行号" disabled={Boolean(busy)} required/></label>
      <label>核对说明<textarea value={note} onChange={event=>{setNote(event.target.value);invalidate();}} maxLength={1000} rows={3} placeholder="说明如何确认本次最终金额；确认零金额时必须写明拒绝发生在生成回复前。" disabled={Boolean(busy)} required/></label>
      <button className="button button-primary" disabled={Boolean(busy)}>{busy==='preview'?'正在生成预览…':'预览结算结果'}</button>
    </form>}
    {preview&&selected&&<div className="settlement-preview" aria-label="结算预览">
      <h3>结算预览</h3><dl><div><dt>本地已记录</dt><dd>{money(preview.recordedMicros)}</dd></div><div><dt>官方确认</dt><dd>{money(preview.confirmedMicros)}</dd></div><div><dt>结算后计入保护</dt><dd>{money(preview.accountedMicros)}</dd></div><div><dt>释放预留</dt><dd>{money(preview.releasedMicros)}</dd></div></dl>
      <label className="check-label"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={Boolean(busy)}/><span>我已核对官方证据，确认以上金额；若最终金额为 $0，也确认这是有证据的零费用调用。</span></label>
      <button type="button" className="button button-primary" onClick={()=>void settle()} disabled={!confirmed||Boolean(busy)}>{busy==='settle'?'正在结算…':'确认结算并释放预留'}</button>
    </div>}
    <details className="reconciliation-history"><summary>查看结算历史（{overview.history.length}）</summary>{!overview.history.length?<p className="helper">尚无结算历史。</p>:<div>{overview.history.map(item=><article key={item.id}><p><b>{methodName(item.method)}</b> · {shortId(item.callId)} · {dateTime(item.createdAt)}</p><p>计入 {money(item.accountedMicros)}，释放 {money(item.releasedMicros)}</p><p>证据：{item.evidenceRef}</p><p>说明：{item.note}</p></article>)}</div>}</details>
  </section>;
}
