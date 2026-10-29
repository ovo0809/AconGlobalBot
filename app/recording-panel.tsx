'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserRecordingClient,
  controlRecording,
  loadRecording,
  type BrowserRecordingState,
} from '../lib/browser-recording';
import type { RecordingDetail, RecordingSegment, RecordingSpeaker } from '../lib/recording-types';

type Props={caseId:string;csrf:string;onChanged:()=>void|Promise<void>};

const speakerNames:Record<RecordingSpeaker,string>={customer:'客户',advisor:'顾问',unclear:'待确认'};
const stateNames:Record<string,string>={recording:'正在录音',paused:'录音已暂停',queued:'等待转写',transcribing:'正在转写',review:'等待顾问复核',confirmed:'客户原话已确认，报告正在后台处理',failed:'处理失败'};
const SEGMENTS_PER_PAGE=20;

function clock(seconds:number){
  const value=Math.max(0,Math.floor(seconds));
  const hours=Math.floor(value/3600),minutes=Math.floor(value%3600/60),secs=value%60;
  return hours?`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`:`${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
}
function safeError(cause:unknown){
  const raw=cause instanceof Error?cause.message:'操作失败，请稍后重试。';
  if(/费用|额度|上限|预算|spending|budget/i.test(raw))return '当前案例暂不能继续调用，请由顾问核对后重试。';
  return raw.slice(0,240).replace(/sk[-_][A-Za-z0-9_-]+/gi,'[已隐藏]').replace(/token=[^\s&]+/gi,'token=[已隐藏]');
}

export function RecordingPanel({caseId,csrf,onChanged}:Props){
  const [detail,setDetail]=useState<RecordingDetail|null>(null);
  const [segments,setSegments]=useState<RecordingSegment[]>([]);
  const [consent,setConsent]=useState(false);
  const [reviewed,setReviewed]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [reviewPage,setReviewPage]=useState(0);
  const dirtyRef=useRef(false);
  const [browserState,setBrowserState]=useState<BrowserRecordingState>('idle');
  const [duration,setDuration]=useState(0);
  const [busy,setBusy]=useState<string|null>(null);
  const [controllable,setControllable]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const clientRef=useRef<BrowserRecordingClient|null>(null);
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const audioUrlRef=useRef<string|null>(null);

  const applyDetail=useCallback((next:RecordingDetail)=>{
    setDetail(next);setDuration(current=>Math.max(current,next.session?.durationSeconds??0));
    if(next.session)setControllable(true);
    if(!dirtyRef.current)setSegments(next.segments);
  },[]);

  const refresh=useCallback(async()=>{
    try{const next=await loadRecording(caseId);clientRef.current?.hydrate(next);applyDetail(next);setError(null);}
    catch(cause){setError(safeError(cause));}
  },[applyDetail,caseId]);

  useEffect(()=>{
    dirtyRef.current=false;setDirty(false);setReviewed(false);setReviewPage(0);setDuration(0);setControllable(false);setNotice(null);setError(null);
    const client=new BrowserRecordingClient({caseId,csrf,onState:setBrowserState,onDuration:setDuration,onDetail:next=>{applyDetail(next);if(next.leaseToken)setControllable(true);},onError:setError});
    clientRef.current=client;
    void refresh();
    return()=>{if(clientRef.current===client)clientRef.current=null;void client.dispose();if(audioUrlRef.current)URL.revokeObjectURL(audioUrlRef.current);audioRef.current?.pause();};
  },[applyDetail,caseId,csrf,refresh]);

  const serverState=detail?.session?.state;
  useEffect(()=>{
    if(serverState!=='queued'&&serverState!=='transcribing')return;
    const timer=setInterval(()=>void refresh(),1_500);return()=>clearInterval(timer);
  },[refresh,serverState]);

  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{
      if(browserState!=='recording'&&browserState!=='uploading'&&browserState!=='finishing')return;
      event.preventDefault();event.returnValue='';
    };
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[browserState]);

  const run=async(name:string,action:()=>Promise<void>)=>{
    setBusy(name);setError(null);setNotice(null);
    try{await action();}
    catch(cause){setError(safeError(cause));}
    finally{setBusy(null);}
  };

  const start=()=>run('start',async()=>{
    if(!consent)throw new Error('请先确认客户已知情并同意录音和云端转写。');
    await clientRef.current?.start();setNotice('录音已开始。系统每 60 秒安全保存一个分段。');
  });
  const resume=()=>run('resume',async()=>{await clientRef.current?.resume();setNotice('录音已恢复。');});
  const pause=()=>run('pause',async()=>{await clientRef.current?.pause();setNotice('麦克风已停止，已完成的分段已保存。');await onChanged();});
  const finish=()=>run('finish',async()=>{await clientRef.current?.finish();setNotice('录音已结束，后台正在逐段转写。');await refresh();await onChanged();});
  const retryUpload=()=>run('upload',async()=>{await clientRef.current?.retryUploads();setNotice('未上传的录音分段已保存。您可以恢复录音。');});
  const retryServer=()=>run('retry',async()=>{const next=await controlRecording(csrf,{action:'retry',caseId,sessionId:detail?.session?.id});applyDetail(next);setNotice('已重新加入转写队列。');});

  const updateSegment=(id:string,patch:Partial<Pick<RecordingSegment,'speaker'|'text'>>)=>{
    dirtyRef.current=true;setDirty(true);setReviewed(false);setSegments(values=>values.map(segment=>segment.id===id?{...segment,...patch}:segment));
  };
  const customerCount=useMemo(()=>segments.filter(segment=>segment.speaker==='customer'&&segment.text.trim()).length,[segments]);
  const unclearCount=useMemo(()=>segments.filter(segment=>segment.speaker==='unclear').length,[segments]);
  const reviewPages=Math.max(1,Math.ceil(segments.length/SEGMENTS_PER_PAGE));
  const visibleSegments=segments.slice(reviewPage*SEGMENTS_PER_PAGE,(reviewPage+1)*SEGMENTS_PER_PAGE);
  useEffect(()=>{if(reviewPage>=reviewPages)setReviewPage(reviewPages-1);},[reviewPage,reviewPages]);
  const confirm=()=>run('confirm',async()=>{
    if(!reviewed)throw new Error('请先确认已经核对说话人和客户原话。');
    if(customerCount===0)throw new Error('请至少标记一条客户原话；顾问发言不能作为客户事实来源。');
    const next=await controlRecording(csrf,{action:'confirm',caseId,sessionId:detail?.session?.id,segments:segments.map(({id,speaker,text})=>({id,speaker,text:text.trim()}))});
    dirtyRef.current=false;setDirty(false);applyDetail(next);setNotice('客户原话已确认，报告和 PDF 已进入后台生成队列。');await onChanged();
  });

  const play=async(index:number)=>{
    setError(null);
    try{
      audioRef.current?.pause();if(audioUrlRef.current)URL.revokeObjectURL(audioUrlRef.current);
      const response=await fetch(`/api/recording?caseId=${encodeURIComponent(caseId)}&audioIndex=${index}`,{cache:'no-store',credentials:'same-origin'});
      if(!response.ok){const data=await response.json().catch(()=>({error:'无法播放此录音分段。'})) as {error?:string};throw new Error(data.error||'无法播放此录音分段。');}
      audioUrlRef.current=URL.createObjectURL(await response.blob());
      const audio=new Audio(audioUrlRef.current);audioRef.current=audio;await audio.play();
    }catch(cause){setError(safeError(cause));}
  };

  if(!detail)return <section className="recording-panel"><div className="recording-loading" role="status">正在读取录音状态…</div>{error&&<div className="inline-error">{error}</div>}</section>;
  const localActive=browserState==='recording'||browserState==='uploading'||browserState==='finishing';
  const recoverable=serverState==='recording'&&!localActive;

  return <section className="recording-panel" aria-labelledby="recording-title">
    <header className="recording-header"><div><span className="eyebrow">长时会谈</span><h2 id="recording-title">录音转写＋会后报告</h2><p>适合顾问和客户一起会谈。录音最长 2 小时，结束后统一转写，不会启动 AI 语音回复。</p></div><span className={`source-pill ${detail.provider==='mock'?'source-warning':''}`}>{detail.provider==='mock'?'模拟转写':'OpenAI 转写'}</span></header>
    {error&&<div className="inline-error" role="alert">{error}</div>}
    {!error&&detail.session?.error&&<div className="inline-error" role="alert">{safeError(new Error(detail.session.error))}</div>}
    {detail.session?.incomplete&&<div className="recording-recovery"><b>这次录音可能不完整</b><p>页面离开或连接中断时，尚未保存的音频可能丢失。请核对已保存的转写；报告会保留不完整标记。</p></div>}
    {notice&&<div className="recording-notice" role="status">{notice}</div>}
    {!detail.session&&<div className="recording-start-card">
      <div className="recording-consent"><b>开始前确认</b><p>客户已知道麦克风会持续录音，音频会分段保存并发送到所选云端服务转写。顾问需要在报告生成前核对说话人和客户原话。</p></div>
      <label className="check-label"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>客户已知情并同意本次录音与转写</label>
      <button className="button button-primary" disabled={!consent||Boolean(busy)||!detail.configured} onClick={start}>开始录音</button>
      {!detail.configured&&<p className="recording-hint">转写服务尚未配置，当前无法开始录音。</p>}
    </div>}
    {detail.session&&serverState!=='review'&&serverState!=='confirmed'&&<div className="recording-session-card">
      <div className="recording-meter"><span className={localActive?'recording-pulse':''}/><div><b>{localActive?(browserState==='uploading'?'正在保存分段':'正在录音'):stateNames[serverState!]||serverState}</b><small>{clock(duration)} / 02:00:00 · 已保存 {detail.session.chunkCount} 段</small></div></div>
      {recoverable&&<div className="recording-recovery"><b>这页没有正在运行的麦克风</b><p>刷新或离开页面会丢失尚未保存的片段。点击恢复会更换上传凭证，并从最后一个已保存分段继续。</p></div>}
      {serverState==='queued'||serverState==='transcribing'?<div className="recording-progress"><div><span style={{width:`${detail.session.chunkCount?Math.round(detail.session.transcribedChunks/detail.session.chunkCount*100):0}%`}}/></div><p>已转写 {detail.session.transcribedChunks} / {detail.session.chunkCount} 个分段。可以离开此页面，后台会继续处理。</p></div>:null}
      <div className="recording-actions">
        {localActive&&browserState==='recording'&&<button className="button button-secondary" disabled={Boolean(busy)} onClick={pause}>暂停并保存</button>}
        {(serverState==='paused'||recoverable||browserState==='error')&&<button className="button button-primary" disabled={Boolean(busy)} onClick={resume}>恢复录音</button>}
        {browserState==='error'&&<button className="button button-secondary" disabled={Boolean(busy)} onClick={retryUpload}>重试未上传分段</button>}
        {(localActive||(serverState==='paused'&&controllable))&&<button className="button button-danger" disabled={Boolean(busy)||browserState==='uploading'} onClick={finish}>结束并开始转写</button>}
        {serverState==='failed'&&<button className="button button-secondary" disabled={Boolean(busy)} onClick={retryServer}>重新转写失败分段</button>}
      </div>
    </div>}
    {serverState==='review'&&<div className="transcript-review">
      <div className="recording-review-intro"><div><h3>核对转写和说话人</h3><p>Whisper 不会可靠区分顾问和客户。只有标为“客户”的原话会进入事实提取；“待确认”和“顾问”内容不会成为客户事实。</p></div><span className="status">客户 {customerCount} 条 · 待确认 {unclearCount} 条</span></div>
      {reviewPages>1&&<nav className="recording-pagination" aria-label="转写复核分页"><button className="button button-secondary" disabled={reviewPage===0} onClick={()=>setReviewPage(page=>page-1)}>上一页</button><span>第 {reviewPage+1} / {reviewPages} 页 · 共 {segments.length} 段</span><button className="button button-secondary" disabled={reviewPage===reviewPages-1} onClick={()=>setReviewPage(page=>page+1)}>下一页</button></nav>}
      <div className="recording-segments">{visibleSegments.map(segment=><article key={segment.id} className={`recording-segment speaker-${segment.speaker}`}>
        <div className="recording-segment-meta"><span>{clock(segment.startSeconds)}–{clock(segment.endSeconds)}</span><button className="text-button" type="button" onClick={()=>void play(segment.chunkIndex)}>播放此段</button></div>
        <label>说话人<select value={segment.speaker} onChange={event=>updateSegment(segment.id,{speaker:event.target.value as RecordingSpeaker})}>{Object.entries(speakerNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>核对后的文字<textarea value={segment.text} maxLength={4000} onChange={event=>updateSegment(segment.id,{text:event.target.value})}/></label>
        {segment.text!==segment.originalText&&<details><summary>查看原始转写</summary><p>{segment.originalText}</p></details>}
      </article>)}</div>
      <label className="check-label recording-review-check"><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>我已核对说话人和文字；只有客户亲自陈述的内容被标为“客户”</label>
      <div className="recording-actions"><button className="button button-primary" disabled={Boolean(busy)||!reviewed||customerCount===0} onClick={confirm}>确认客户原话并生成报告</button>{dirty&&<span className="recording-hint">修改尚未确认</span>}</div>
    </div>}
    {serverState==='confirmed'&&<div className="recording-complete"><b>客户原话已保存，报告正在后台处理</b><p>原始录音已从应用存储清除。报告与 PDF 就绪后可到“内部报告”查看；当前状态不代表报告已经生成成功。</p></div>}
  </section>;
}
