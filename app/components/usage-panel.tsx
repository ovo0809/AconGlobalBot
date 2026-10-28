'use client';

import type { UsageSummary } from '../../lib/ai-usage';

type UsageScope=NonNullable<UsageSummary['case']>;
type UsageRecord=UsageSummary['records'][number];

const operationNames: Record<string,string> = {
  interview: '文字访谈', extraction: '事实整理', report: '报告生成', realtime: '连续语音', transcription: '语音转写',
};
const statusNames: Record<string,string> = {
  reserved: '已预留', settled: '已记录', unknown: '待核对', released: '已释放',
};

function money(micros:number) {
  const dollars=Math.max(0,micros)/1_000_000;
  return dollars<0.01&&dollars>0?`$${dollars.toFixed(4)}`:`$${dollars.toFixed(2)}`;
}

function BudgetCard({title,subtitle,scope,limit}:{title:string;subtitle:string;scope:UsageScope|null;limit:number}) {
  const spent=scope?.costMicros??0;
  const held=scope?.heldMicros??0;
  const used=spent+held;
  const percent=limit>0?Math.min(100,Math.max(0,used/limit*100)):100;
  return <article className="usage-budget-card">
    <header><div><span>{title}</span><small>{subtitle}</small></div><b>{money(scope?.remainingMicros??limit)} 剩余</b></header>
    <div className="usage-progress" role="progressbar" aria-label={`${title}已占用`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used,limit)}>
      <span style={{width:`${percent}%`}}/>
    </div>
    <footer><span>已知估算 <b>{money(spent)}</b></span><span>预留／待核对 <b>{money(held)}</b></span><span>上限 <b>{money(limit)}</b></span></footer>
  </article>;
}

function usageParts(record:UsageRecord) {
  const parts:string[]=[];
  if(record.inputTokens||record.outputTokens)parts.push(`总 token ${record.inputTokens.toLocaleString('zh-CN')} 入 / ${record.outputTokens.toLocaleString('zh-CN')} 出`);
  if(record.cachedTokens)parts.push(`其中缓存 ${record.cachedTokens.toLocaleString('zh-CN')}`);
  if(record.inputAudioTokens||record.outputAudioTokens)parts.push(`其中音频 ${record.inputAudioTokens.toLocaleString('zh-CN')} 入 / ${record.outputAudioTokens.toLocaleString('zh-CN')} 出`);
  if(record.transcriptionSeconds)parts.push(`转写 ${Math.round(record.transcriptionSeconds)} 秒`);
  return parts.length?parts.join(' · '):'尚无已确认的模型用量明细';
}

export function UsagePanel({usage,provider}:{usage?:UsageSummary;provider:'mock'|'openai'|'other'}) {
  if(!usage)return <section className="usage-panel"><div className="usage-intro usage-intro-warning"><div><b>费用记录暂不可用</b><p>服务端尚未返回费用保护状态；在状态恢复前不应开启付费模型。</p></div></div></section>;
  const {limits}=usage;
  const isMock=provider==='mock';
  const providerCopy=provider==='mock'
    ? '当前运行在模拟模式，不会发起付费模型请求。已有历史记录仍会保留在下方。'
    : provider==='openai'
      ? '当前已选择 OpenAI；达到保护阈值后，本应用会停止继续创建模型响应。'
      : '当前选择的云端服务不在这套 OpenAI 费用保护范围内；切换服务前应另行配置对应上限。';
  const providerLabel=provider==='mock'?'MOCK · $0 新增调用':provider==='openai'?'OPENAI · 受额度保护':'OPENAI 账本 · 当前未启用';
  return <section className="usage-panel">
    <div className={`usage-intro ${isMock?'usage-intro-mock':''} ${provider==='other'?'usage-intro-warning':''}`}>
      <div><span className="eyebrow">应用级支出保护</span><h3>费用与用量</h3><p>{providerCopy}</p></div>
      <span className="source-pill">{providerLabel}</span>
    </div>
    <div className="usage-budget-grid">
      {usage.case&&<BudgetCard title="当前案例" subtitle="案例累计" scope={usage.case} limit={limits.caseMicros}/>}
      <BudgetCard title="今日组织用量" subtitle={`${usage.dayUtc} · UTC`} scope={usage.day} limit={limits.dailyMicros}/>
      <BudgetCard title="本月组织用量" subtitle={`${usage.monthUtc} · UTC`} scope={usage.month} limit={limits.monthlyMicros}/>
    </div>
    <div className="usage-note"><b>如何理解这些数字</b><p>金额按公开费率和 API 返回的用量估算，最终以 OpenAI 账单为准。预留及待核对金额会继续占用额度，避免断线或延迟记录后重复消费；日／月额度按 UTC 重置。</p></div>
    <div className="usage-records">
      <div className="section-heading"><div><h3>近期调用记录</h3><p>仅保存模型、用途、用量和费用状态，不在费用记录中保存对话正文。</p></div>{usage.rateCardVersion&&<span className="source-pill">费率 {usage.rateCardVersion}</span>}</div>
      {usage.records.length===0?<div className="usage-empty"><span>○</span><b>尚无付费调用记录</b><p>{isMock?'模拟访谈和模拟报告不会写成付费用量。':'首次受保护的 OpenAI 调用完成后，用量会显示在这里。'}</p></div>:<div className="usage-record-list">
        {usage.records.map(record=><article key={record.id} className="usage-record">
          <div className="usage-record-main"><span className={`usage-state usage-state-${record.status}`}>{statusNames[record.status]||record.status}</span><div><b>{operationNames[record.operation]||record.operation}</b><p>{record.model}</p></div></div>
          <div className="usage-record-detail"><p>{usageParts(record)}</p><small>{new Date(record.createdAt).toLocaleString('zh-CN',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})} UTC</small></div>
          <div className="usage-record-cost"><b>{money(record.costMicros)}</b>{record.status==='reserved'||record.status==='unknown'?<small>占用 {money(Math.max(record.reservedMicros,record.costMicros))}</small>:<small>费率估算</small>}</div>
        </article>)}
      </div>}
    </div>
  </section>;
}
