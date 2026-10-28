'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Bootstrap, Case, Category, FactStatus, ProfileField, ReportRecord } from '../lib/domain';
import { BrowserVoiceClient, type BrowserVoiceState } from '../lib/browser-voice';
import { UsagePanel } from './components/usage-panel';

type ActionBody = Record<string, unknown> & { action: string };
type ActionResult = Record<string, unknown> & { error?: string; caseId?: string };
type ActionFn = (body: ActionBody, options?: { caseId?: string; noRefresh?: boolean }) => Promise<ActionResult | null>;
type Toast = { kind: 'success' | 'error' | 'info'; text: string } | null;

const categories: { id: Category; title: string; caption: string; icon: string }[] = [
  { id: 'life', title: '人寿', caption: '家庭责任与已有保障', icon: '◇' },
  { id: 'disability_income', title: '伤残保险', caption: '收入中断与工作保障', icon: '◒' },
  { id: 'annuity', title: '年金', caption: '退休目标与资金安排', icon: '◎' },
  { id: 'ltc', title: '长期护理', caption: '照护偏好与家庭支持', icon: '⌁' },
];

const roleNames = { advisor: '顾问', reviewer: 'Charles 审核人', admin: '管理员' } as const;
const statusNames: Record<string, string> = {
  new: '尚未访谈', draft: '报告草稿', needs_report: '待生成报告', interviewing: '访谈进行中', ended: '访谈已结束', report_ready: '报告已生成', reviewed: '已复核',
  pending_review: '待复核', approved: '已复核', returned: '退回补问', quote_handoff: '已转现有报价流程',
};
const factLabels: Record<string, string> = {
  goal: '主要目标', horizon: '目标时间', dependents: '家庭责任', state: '居住州', employment: '工作情况', income: '收入',
  expenses: '家庭开支', debt: '债务', reserve: '应急储备', assets: '资产与资金', existing_life: '现有人寿保障', existing_di: '现有伤残保障', existing_ltc: '现有照护安排',
  budget: '预算', liquidity: '流动性偏好', retirement: '退休计划', care: '照护考虑',
};
const factStatusNames: Record<FactStatus, string> = {
  confirmed: '已确认', reported_unverified: '客户自述·待核验', unknown: '不知道', declined: '不愿提供', conflicting: '存在冲突',
};
const moneyFactKeys = new Set(['income','expenses','debt','reserve','assets','budget']);

function Icon({ name }: { name: 'search' | 'plus' | 'user' | 'chat' | 'file' | 'review' | 'settings' | 'exit' | 'mic' | 'mute' | 'send' | 'pause' | 'speaker' | 'close' | 'check' | 'alert' | 'download' | 'retry' }) {
  const paths: Record<string, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, plus: <><path d="M12 5v14M5 12h14"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>, chat: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5A8 8 0 1 1 21 15Z"/>,
    file: <><path d="M6 2h9l4 4v16H6z"/><path d="M15 2v5h5M9 12h6M9 16h6"/></>, review: <><path d="M5 3h14v18H5z"/><path d="m8 10 2 2 5-5M8 16h8"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.4 3.1a8 8 0 0 0-1.7 1L5 6.1 3 9.5 5 11a7 7 0 0 0 0 2l-2 1.5L5 18l2.4-1a8 8 0 0 0 1.7 1l.4 3h5l.4-3a8 8 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1Z"/></>,
    exit: <><path d="M10 17l5-5-5-5M15 12H3M21 3v18h-7"/></>, mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></>,
    mute: <><path d="m4 4 16 16M9.5 5.5V5a2.5 2.5 0 0 1 5 0v6M7 11a5 5 0 0 0 8 4M19 11a7 7 0 0 1-.8 3.2M12 18v4"/></>, send: <path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/>,
    pause: <><path d="M9 5v14M15 5v14"/></>, speaker: <><path d="M11 5 6 9H3v6h3l5 4zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/></>, close: <path d="m6 6 12 12M18 6 6 18"/>,
    check: <path d="m5 12 4 4L19 6"/>, alert: <><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 18h.01"/></>, download: <><path d="M12 3v12M7 11l5 5 5-5M4 21h16"/></>, retry: <><path d="M20 6v6h-6M4 18v-6h6"/><path d="M18 9a7 7 0 0 0-12-2L4 12M6 15a7 7 0 0 0 12 2l2-5"/></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

async function getBootstrap(caseId?: string): Promise<Bootstrap> {
  const url = caseId ? `/api/bootstrap?caseId=${encodeURIComponent(caseId)}` : '/api/bootstrap';
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('无法读取当前会话，请刷新重试。');
  return response.json() as Promise<Bootstrap>;
}

export default function Home() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<Toast>(null);
  const [handback, setHandback] = useState(false);
  const selectedCaseIdRef = useRef<string | undefined>(undefined);
  const sessionMode = data?.mode;
  const sessionUserId = data?.user?.id;

  const refresh = useCallback(async (caseId?: string) => {
    const next = await getBootstrap(caseId ?? selectedCaseIdRef.current);
    if (next.mode === 'client' || next.mode === 'anonymous') selectedCaseIdRef.current = undefined;
    else if (next.activeCase) selectedCaseIdRef.current = next.activeCase.id;
    setData(next);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch((error: Error) => setToast({ kind: 'error', text: error.message })).finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const verify = () => { setLoading(true); void refresh().catch(() => undefined).finally(() => setLoading(false)); };
    const pageShow = () => verify();
    const visibility = () => { if (document.visibilityState === 'visible') verify(); };
    window.addEventListener('focus', verify);
    window.addEventListener('pageshow', pageShow);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('focus', verify); window.removeEventListener('pageshow', pageShow); document.removeEventListener('visibilitychange', visibility); };
  }, [refresh]);

  useEffect(() => {
    if (!sessionMode) return;
    const channel = new BroadcastChannel('aeconn-session-mode');
    channel.postMessage({ mode: sessionMode, userId: sessionUserId ?? null, at: Date.now() });
    channel.onmessage = () => { setLoading(true); void refresh().catch(() => undefined).finally(() => setLoading(false)); };
    return () => channel.close();
  }, [sessionMode, sessionUserId, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const act = useCallback(async (body: ActionBody, options?: { caseId?: string; noRefresh?: boolean }) => {
    if (!data) return null;
    setBusy(body.action);
    try {
      const response = await fetch('/api/action', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrf }, body: JSON.stringify(body),
      });
      const result = await response.json() as ActionResult;
      if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
      if (body.action === 'login' || body.action === 'logout') selectedCaseIdRef.current = undefined;
      if (!options?.noRefresh) await refresh(options?.caseId ?? result.caseId);
      return result;
    } catch (error) {
      const text = error instanceof Error ? error.message : '操作未完成，请重试。';
      setToast({ kind: 'error', text });
      throw error;
    } finally { setBusy(''); }
  }, [data, refresh]);

  if (loading) return <LoadingScreen />;
  if (!data || data.mode === 'anonymous') return <LoginScreen busy={busy === 'login'} onLogin={async (email, password) => { await act({ action: 'login', email, password }); }} toast={toast} />;
  if (data.mode === 'client') return <ClientAssistant data={data} busy={busy} act={act} refresh={refresh} setHandback={setHandback} setToast={setToast} />;
  return <InternalWorkspace data={data} busy={busy} act={act} refresh={refresh} handback={handback} setHandback={setHandback} setToast={setToast} toast={toast} selectedCaseIdRef={selectedCaseIdRef} />;
}

function LoadingScreen() {
  return <main className="loading-screen"><Brand /><div className="loader"/><p>正在恢复安全会话…</p></main>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark">A</span><span><b>Aeconn</b>{!compact && <small>AI AGENT</small>}</span></div>;
}

function ToastView({ toast }: { toast: Toast }) {
  if (!toast) return null;
  return <div role="status" className={`toast toast-${toast.kind}`}><Icon name={toast.kind === 'error' ? 'alert' : 'check'} />{toast.text}</div>;
}

function LoginScreen({ busy, onLogin, toast }: { busy:boolean; onLogin:(email:string,password:string)=>Promise<void>; toast:Toast }) {
  const [email, setEmail] = useState('advisor1@aeconn.example');
  const [password, setPassword] = useState('AeconnDemo!2026');
  return <main className="login-page">
    <section className="login-story">
      <Brand /><div className="story-copy"><span className="eyebrow">保险顾问访谈与人工交接</span><h1>让每一次对话，<br/>都成为有依据的下一步。</h1><p>采集客户情况、整理来源、生成内部报告，再由 Charles 复核。这个 Demo 仅使用合成资料。</p></div>
      <div className="trust-note"><Icon name="check"/><span>服务端权限隔离 · 模拟分析明确标识 · 邮件仅预览</span></div>
    </section>
    <section className="login-panel"><form className="login-card" onSubmit={(event) => { event.preventDefault(); void onLogin(email, password); }}>
      <div><span className="demo-pill">合成数据 Demo</span><h2>欢迎回来</h2><p>登录 Aeconn 内部工作台</p></div>
      <label>工作邮箱<input name="email" type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required /></label>
      <button className="button button-primary button-full" disabled={busy}>{busy ? '正在验证…' : '登录工作台'}</button>
      <details className="demo-accounts"><summary>查看本地演示账号</summary><p>顾问：advisor1@aeconn.example</p><p>审核：charles@aeconn.example</p><p>管理员：admin@aeconn.example</p><p>密码：AeconnDemo!2026</p></details>
      <p className="privacy-copy">仅供本地演示，请勿录入真实客户资料。</p>
    </form></section><ToastView toast={toast}/>
  </main>;
}

function InternalWorkspace({ data, busy, act, refresh, handback, setHandback, setToast, toast, selectedCaseIdRef }: { data:Bootstrap; busy:string; act:ActionFn; refresh:(caseId?:string)=>Promise<Bootstrap>; handback:boolean; setHandback:(value:boolean)=>void; setToast:(v:Toast)=>void; toast:Toast; selectedCaseIdRef:React.MutableRefObject<string|undefined> }) {
  const [nav, setNav] = useState<'workspace'|'review'|'settings'>(data.user?.role === 'admin' ? 'settings' : data.user?.role === 'reviewer' ? 'review' : 'workspace');
  const [search, setSearch] = useState('');
  const [newClient, setNewClient] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const activeCase = data.activeCase;
  const activeCaseId = activeCase?.id;
  const reportJob = data.reportJob;
  const filteredCases = data.cases.filter(item => (item.clientName || '').toLowerCase().includes(search.toLowerCase()));

  useEffect(()=>{
    const shouldPoll=Boolean(document.visibilityState==='visible'&&activeCaseId&&reportJob?.caseId===activeCaseId&&(reportJob.status==='queued'||reportJob.status==='generating'||reportJob.status==='ready'&&data.reports.length===0));
    if(!shouldPoll)return;
    const timer=window.setTimeout(()=>void refresh(activeCaseId),750);
    return()=>window.clearTimeout(timer);
  },[activeCaseId,data.reports.length,refresh,reportJob?.caseId,reportJob?.status]);

  async function selectCase(item: Case) { selectedCaseIdRef.current = item.id; setReportOpen(false); setMobileDetail(true); await refresh(item.id); }
  async function logout() { await act({action:'logout'}); }
  if (data.user?.role === 'admin') return <AdminScreen data={data} busy={busy} act={act} logout={logout} toast={toast}/>;

  return <main className="app-shell">
    <aside className="rail"><Brand compact/><nav aria-label="主导航">
      {data.user?.role === 'advisor' && <button className={nav==='workspace'?'active':''} onClick={()=>setNav('workspace')}><Icon name="chat"/><span>客户</span></button>}
      <button className={nav==='review'?'active':''} onClick={()=>setNav('review')}><Icon name="review"/><span>{data.user?.role === 'reviewer'?'审核':'复核'}</span></button>
      <button className={nav==='settings'?'active':''} onClick={()=>setNav('settings')}><Icon name="settings"/><span>设置</span></button>
    </nav><button className="rail-profile" onClick={()=>setNav('settings')}><span className="avatar">{data.user?.name.slice(0,1)}</span><span>{data.user?.name}</span></button></aside>

    {(nav === 'workspace' || nav === 'review') && <aside className={`case-sidebar ${mobileDetail ? 'mobile-hide' : ''}`}>
      <header><div><span className="eyebrow">{nav==='review'?'交接队列':'客户工作区'}</span><h2>{nav==='review'?'待 Charles 复核':'我的客户'}</h2></div>{data.user?.role==='advisor' && <button className="icon-button" aria-label="新建客户" onClick={()=>setNewClient(true)}><Icon name="plus"/></button>}</header>
      <label className="search-field"><Icon name="search"/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索客户或案例"/></label>
      <div className="case-list">{filteredCases.map(item=><button key={item.id} className={`case-item ${activeCase?.id===item.id?'selected':''}`} onClick={()=>void selectCase(item)}>
        <span className="avatar avatar-soft">{(item.clientName||'客').slice(0,1)}</span><span className="case-copy"><b>{item.clientName||'合成客户'}</b><small>{statusNames[item.status]||item.status}</small></span><time>{new Date(item.updatedAt).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}</time>
      </button>)}</div>
      {filteredCases.length===0 && <EmptyState title="没有匹配的案例" body="换个关键词，或建立一位合成客户。"/>}
    </aside>}

    <section className={`workspace ${nav==='settings'?'no-sidebar':''} ${mobileDetail||nav==='settings'?'mobile-show':''}`}>
      <header className="workspace-header"><div>{nav!=='settings'&&<button className="icon-button mobile-back" aria-label="返回案例列表" onClick={()=>setMobileDetail(false)}>‹</button>}<h1>{nav==='settings'?'账户设置':activeCase?.clientName||'选择一个案例'}</h1>{activeCase && nav!=='settings' && <span className={`status status-${activeCase.status}`}>{statusNames[activeCase.status]||activeCase.status}</span>}</div><div className="header-actions">{data.demo&&<span className="demo-pill">合成数据</span>}<button className="text-button" onClick={()=>void logout()}><Icon name="exit"/>退出</button></div></header>
      {nav==='settings' ? <UserSettings user={data.user!}/> : activeCase ? <CaseWorkspace data={data} busy={busy} act={act} reportOpen={reportOpen} setReportOpen={setReportOpen} setToast={setToast} setHandoff={setHandoff}/> : <WelcomeWorkspace advisor={data.user?.name||''} onNew={()=>setNewClient(true)} reviewer={data.user?.role==='reviewer'}/>}
    </section>
    {newClient && <NewClientModal busy={busy==='createClient'} onClose={()=>setNewClient(false)} onSubmit={async form=>{ const result=await act({action:'createClient',...form}); setNewClient(false); selectedCaseIdRef.current=result?.caseId; setToast({kind:'success',text:'客户档案与首个案例已建立。'}); }}/>}
    {handoff && <HandoffBanner onClose={()=>setHandoff(false)}/>} {handback&&<HandbackBanner onClose={()=>setHandback(false)}/>}<ToastView toast={toast}/>
  </main>;
}

function EmptyState({ title, body }: {title:string;body:string}) { return <div className="empty-state"><span>○</span><b>{title}</b><p>{body}</p></div>; }

function WelcomeWorkspace({advisor,onNew,reviewer}:{advisor:string;onNew:()=>void;reviewer:boolean}) {
  return <div className="welcome-workspace"><div className="welcome-orb">A</div><span className="eyebrow">上午好，{advisor}</span><h2>{reviewer?'从待复核队列开始':'今天，从一段清楚的对话开始。'}</h2><p>{reviewer?'请选择左侧案例，核对来源、缺失信息与四类初步方向。':'先收齐六项基础资料，再将设备交给客户进入受限访谈模式。'}</p>{!reviewer&&<button className="button button-primary" onClick={onNew}><Icon name="plus"/>建立合成客户</button>}</div>;
}

function CaseWorkspace({data,busy,act,reportOpen,setReportOpen,setToast,setHandoff}:{data:Bootstrap;busy:string;act:ActionFn;reportOpen:boolean;setReportOpen:(v:boolean)=>void;setToast:(v:Toast)=>void;setHandoff:(v:boolean)=>void}) {
  const caseRecord=data.activeCase!;
  const client=data.clients.find(item=>item.id===caseRecord.clientId);
  const latest=data.reports[0];
  const [tab,setTab]=useState<'conversation'|'profile'|'report'|'mail'|'usage'>('conversation');
  const usage=data.usage;
  const analysisProvider=data.capabilities.analysis.toLowerCase();
  const usageProvider=analysisProvider.includes('mock')?'mock':analysisProvider.includes('openai')?'openai':'other';
  useEffect(()=>{ if(reportOpen)setTab('report'); },[reportOpen]);
  const enterClient=async()=>{ await act({action:'enterClient',caseId:caseRecord.id}); };
  return <>
    <div className="case-banner"><div className="client-identity"><span className="avatar avatar-large">{(client?.name||'客').slice(0,1)}</span><div><b>{client?.name}</b><span>{client?.state||'州待补充'} · {client?.language||'中文'} · 案例 {caseRecord.id.slice(-6)}</span></div></div>
      {data.user?.role==='advisor' && <div className="case-banner-actions"><button className="button button-secondary" onClick={()=>void act({action:'createCase',clientId:caseRecord.clientId})} disabled={busy==='createCase'}><Icon name="plus"/>新案例</button><button className="button button-accent" onClick={()=>void enterClient()} disabled={busy==='enterClient'}><Icon name="chat"/>{busy==='enterClient'?'正在切换…':'开始客户访谈'}</button></div>}
    </div>
    <nav className="tabs" aria-label="案例详情">
      <button className={tab==='conversation'?'active':''} onClick={()=>setTab('conversation')}>访谈记录</button><button className={tab==='profile'?'active':''} onClick={()=>setTab('profile')}>画像与来源</button><button className={tab==='report'?'active':''} onClick={()=>{setTab('report');setReportOpen(true)}}>内部报告 {latest&&<i>v{latest.version}</i>}</button><button className={tab==='mail'?'active':''} onClick={()=>setTab('mail')}>通知预览</button><button className={tab==='usage'?'active':''} onClick={()=>setTab('usage')}>费用与用量</button>
    </nav>
    <div className="workspace-body">
      {tab==='conversation'&&<ConversationView data={data}/>} {tab==='profile'&&<ProfileView data={data} act={act} busy={busy} setToast={setToast}/>} {tab==='report'&&<ReportView data={data} report={latest} act={act} busy={busy} setHandoff={setHandoff}/>} {tab==='mail'&&<MailView data={data} report={latest} act={act} busy={busy}/>} {tab==='usage'&&<UsagePanel usage={usage} provider={usageProvider}/>}
    </div>
  </>;
}

function ConversationView({data}:{data:Bootstrap}) {
  const messages=data.messages;
  return <section className="conversation-view"><div className="timeline-heading"><div><h3>访谈记录</h3><p>最终转写会成为事实来源；临时字幕不会进入画像。</p></div><span className="source-pill">{data.capabilities.voiceConfigured?'真实语音已配置':'模拟语音／文字记录'}</span></div>
    <div className="message-history">{messages.length?messages.map(message=><article key={message.id} className={`history-message ${message.role}`}><span className="message-role">{message.role==='assistant'?'Aeconn 助手':'客户'}</span><p>{message.text}</p><footer><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>{message.interrupted&&<span>已被打断</span>}{!message.final&&<span className="warning-text">转写待确认</span>}</footer></article>):<EmptyState title="还没有访谈记录" body="进入客户模式，选择一个入口后即可开始。"/>}</div>
  </section>;
}

function ProfileView({data,act,busy,setToast}:{data:Bootstrap;act:ActionFn;busy:string;setToast:(v:Toast)=>void}) {
  const [editing,setEditing]=useState<ProfileField|null>(null);
  const facts=data.facts;
  const missingKeys=Object.keys(factLabels).filter(key=>!facts.some(fact=>fact.key===key));
  return <section><div className="section-heading"><div><h3>画像与来源</h3><p>客户自述不等于顾问核验；修正事实会创建新的报告版本。</p></div><div className="section-actions"><span className="source-pill">{facts.length} 项事实</span>{missingKeys.length>0&&<select aria-label="添加事实" value="" onChange={event=>{const key=event.target.value;if(key)setEditing({key,value:null,currency:null,period:null,factStatus:'unknown',sourceMessageIds:[],confirmedBy:null,confirmedAt:null})}}><option value="">＋ 添加事实</option>{missingKeys.map(key=><option key={key} value={key}>{factLabels[key]}</option>)}</select>}</div></div>
    <div className="fact-grid">{facts.map(fact=><button className={`fact-card fact-${fact.factStatus}`} key={fact.key} onClick={()=>setEditing(fact)}><span>{factLabels[fact.key]||fact.key}</span><b>{fact.value===null?'未提供':String(fact.value)} {fact.currency||''} {fact.period?`/ ${fact.period}`:''}</b><small>{factStatusNames[fact.factStatus]}</small><footer>{fact.sourceMessageIds.length?`${fact.sourceMessageIds.length} 个来源`:'无消息来源'}</footer></button>)}</div>
    {!facts.length&&<EmptyState title="画像尚未形成" body="完成访谈后，系统会将有来源的事实整理在这里。"/>}
    {editing&&<FactModal fact={editing} busy={busy==='updateFact'} onClose={()=>setEditing(null)} onSave={async value=>{await act({action:'updateFact',caseId:data.activeCase!.id,...value});setEditing(null);setToast({kind:'success',text:'事实已更新，旧报告已标记过时。'});}}/>}
  </section>;
}

function ReportView({data,report,act,busy,setHandoff}:{data:Bootstrap;report?:ReportRecord;act:ActionFn;busy:string;setHandoff:(v:boolean)=>void}) {
  const reportJob=data.reportJob;
  const jobActive=reportJob?.status==='queued'||reportJob?.status==='generating';
  if(!report) return <section className="report-empty"><div className="report-illustration">{jobActive?<div className="loader"/>:<Icon name={reportJob?.status==='failed'?'alert':'file'}/>}</div><h3>{jobActive?'正在后台生成内部报告':reportJob?.status==='failed'?'报告生成未完成':'内部报告尚未生成'}</h3><p>{jobActive?'您可以继续查看访谈记录，报告和 PDF 就绪后会自动更新。':reportJob?.status==='failed'?'访谈资料已经保存，可以安全重试。':'结束访谈后会自动生成绑定确定快照的报告与 PDF。模拟分析会明确标识。'}</p>{!jobActive&&<button className="button button-primary" disabled={busy==='generateReport'} onClick={()=>void act({action:'generateReport',caseId:data.activeCase!.id})}><Icon name="retry"/>{busy==='generateReport'?'正在重试…':reportJob?.status==='failed'?'重试生成报告':'生成报告'}</button>}</section>;
  return <section className="report-view"><div className="report-meta"><div><span className="eyebrow">内部使用 · v{report.version}</span><h2>{report.title}</h2><p>{report.summary}</p></div><div className="report-actions"><span className={`status ${report.reviewStatus==='approved'?'status-approved':''}`}>{statusNames[report.reviewStatus]||report.reviewStatus}</span><a className="button button-secondary" href={report.pdfUrl} target="_blank" rel="noreferrer"><Icon name="download"/>预览 PDF</a></div></div>
    {jobActive&&<div className="disclosure"><div className="loader loader-small"/><p><b>新版本正在后台生成</b><br/>当前报告仍可查看，生成完成后会自动更新。</p></div>}
    {reportJob?.status==='failed'&&<div className="disclosure warning"><Icon name="alert"/><p><b>新版本生成未完成</b><br/>事实与旧报告均已保存，可安全重试。</p><button className="button button-secondary" disabled={busy==='generateReport'} onClick={()=>void act({action:'generateReport',caseId:data.activeCase!.id})}>重试</button></div>}
    <div className="disclosure"><Icon name="alert"/><p><b>{report.provider.includes('mock')?'演示规则，待业务审核':'已配置云端分析'}</b><br/>{report.provider.includes('mock')?'本报告由确定性演示规则生成，不代表保险建议或业务准确率。':`分析来源：${report.provider}`}</p></div>
    {report.stale&&<div className="disclosure warning"><Icon name="alert"/><p><b>这不是最新事实版本</b><br/>事实已修改，请重新生成后再确认发送。</p></div>}
    <div className="report-sections">{report.sections.map((section,index)=><details open={index===0} key={section.title}><summary><span>{String(index+1).padStart(2,'0')}</span>{section.title}</summary><p>{section.body}</p></details>)}</div>
    <div className="analysis-grid">{report.analyses.map(item=><article key={item.category}><span>{categories.find(c=>c.id===item.category)?.title}</span><b>{statusNames[item.status]||item.status.replaceAll('_',' ')}</b><p>{item.reasonSummary}</p><small>缺失：{item.missingFields.join('、')||'无'}</small></article>)}</div>
    <div className="report-footer-actions">{data.user?.role==='advisor'&&<button className="button button-primary" disabled={busy==='submitReview'} onClick={()=>void act({action:'submitReview',caseId:report.caseId})}>提交 Charles 复核</button>}{data.user?.role==='reviewer'&&<ReviewActions report={report} act={act} busy={busy} setHandoff={setHandoff}/>}</div>
  </section>;
}

function ReviewActions({report,act,busy,setHandoff}:{report:ReportRecord;act:ActionFn;busy:string;setHandoff:(v:boolean)=>void}) {
  const [reason,setReason]=useState('');
  const submit=async(decision:string)=>{await act({action:'review',caseId:report.caseId,decision,reason});if(decision==='approved')setHandoff(true);};
  return <div className="review-actions"><label>复核理由／备注<textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="请记录复核依据；退回或修改时说明具体原因"/></label><div><button className="button button-secondary" disabled={!reason||busy==='review'} onClick={()=>void submit('returned')}>退回补问</button><button className="button button-secondary" disabled={!reason||busy==='review'} onClick={()=>void submit('amended')}>记录修改</button><button className="button button-primary" disabled={!reason||busy==='review'} onClick={()=>void submit('approved')}><Icon name="check"/>确认复核</button></div></div>;
}

function MailView({data,report,act,busy}:{data:Bootstrap;report?:ReportRecord;act:ActionFn;busy:string}) {
  if(!report)return <EmptyState title="没有可预览的通知" body="先生成内部报告与实际 PDF 附件。"/>;
  const jobs=data.notifications.filter(job=>job.reportVersion===report.version);
  return <section><div className="section-heading"><div><h3>通知预览</h3><p>公司与归属顾问分别收到完整正文及同版本 PDF。</p></div><span className="source-pill source-warning">MAIL_MODE · DRY RUN</span></div>
    <div className="mail-policy"><Icon name="alert"/><div><b>当前仅预览，不会实际发送</b><p>未复核草稿政策：{data.settings?.unreviewedSendPolicy||'pending'}。发送批准与 Charles 复核保持独立。</p></div></div>
    <div className="recipient-row">{report.recipients.map(recipient=><div key={recipient.email}><span className="avatar avatar-soft">{recipient.name.slice(0,1)}</span><p><b>{recipient.name}</b><small>{recipient.email}</small></p><span className={`verification ${recipient.verified?'verified':''}`}>{recipient.verified?'已核验':'未核验'}</span></div>)}</div>
    <article className="email-preview"><header><div><span>主题</span><b>{report.title}｜v{report.version}</b></div><span className="demo-pill">完整正文</span></header><pre>{jobs[0]?.body||report.fullText}</pre><footer><a href={report.pdfUrl} target="_blank" rel="noreferrer"><Icon name="file"/><span><b>Aeconn_Report_v{report.version}.pdf</b><small>实际生成附件 · 点击预览</small></span></a></footer></article>
    {jobs.length?<div className="delivery-list">{jobs.map(job=><div key={job.id}><span>{job.recipient}</span><b>{job.status==='previewed'?'已生成预览':job.status}</b>{job.error&&<button onClick={()=>void act({action:'retryNotification',jobId:job.id})}>重试</button>}</div>)}</div>:<div className="send-confirm"><p>是否确认将 v{report.version} 报告发送给公司和您本人？</p><div><button className="button button-secondary" disabled={busy==='cancelSend'} onClick={()=>void act({action:'cancelSend',caseId:report.caseId,version:report.version})}>暂不发送</button><button className="button button-primary" disabled={busy==='approveSend'||report.stale} onClick={()=>void act({action:'approveSend',caseId:report.caseId,version:report.version,snapshotId:report.snapshotId,recipientFingerprint:report.recipientFingerprint})}>{busy==='approveSend'?'正在生成预览…':'确认发送（仅预览）'}</button></div></div>}
  </section>;
}

function UserSettings({user}:{user:NonNullable<Bootstrap['user']>}) {return <div className="settings-card"><span className="avatar avatar-xlarge">{user.name.slice(0,1)}</span><div><span className="eyebrow">当前账户</span><h2>{user.name}</h2><p>{user.email}</p><span className="source-pill">{roleNames[user.role]}</span></div></div>}

function AdminScreen({data,busy,act,logout,toast}:{data:Bootstrap;busy:string;act:ActionFn;logout:()=>Promise<void>;toast:Toast}) {
  const settings=data.settings!; const [companyEmail,setCompanyEmail]=useState(settings.companyEmail); const [policy,setPolicy]=useState(settings.unreviewedSendPolicy);
  return <main className="admin-page"><header><Brand/><div><span className="demo-pill">管理员无业务资料权限</span><button className="text-button" onClick={()=>void logout()}><Icon name="exit"/>退出</button></div></header><section className="admin-content"><div className="section-heading"><div><span className="eyebrow">系统配置</span><h1>账户与发送策略</h1><p>管理员管理账户和配置，不自动获得客户案例访问权。</p></div></div>
    <div className="admin-grid"><form className="panel" onSubmit={e=>{e.preventDefault();void act({action:'updateSettings',companyEmail,companyVerified:settings.companyVerified,unreviewedSendPolicy:policy})}}><h2>公司通知地址</h2><label>Charles 管理的公司邮箱<input type="email" value={companyEmail} onChange={e=>setCompanyEmail(e.target.value)}/></label><label>未复核草稿发送策略<select value={policy} onChange={e=>setPolicy(e.target.value as typeof policy)}><option value="pending">pending · 待决定</option><option value="reviewed_only">reviewed_only · 仅已复核</option><option value="allow">allow · 允许草稿</option></select></label><p className="helper">Demo 始终使用 dry-run。策略生效后仍需归属顾问逐版本确认。</p><button className="button button-primary" disabled={busy==='updateSettings'}>保存配置</button></form>
    <div className="panel"><h2>合成测试账户</h2><div className="user-list">{data.users?.map(user=><AdminUserRow key={user.id} user={user} busy={busy==='updateUserEmail'} act={act}/>)}</div></div></div>
  </section><ToastView toast={toast}/></main>;
}

function AdminUserRow({user,busy,act}:{user:NonNullable<Bootstrap['users']>[number];busy:boolean;act:ActionFn}) {
  const [editing,setEditing]=useState(false); const [email,setEmail]=useState(user.email); const [verified,setVerified]=useState(user.emailVerified);
  if(editing)return <form className="user-edit" onSubmit={async event=>{event.preventDefault();await act({action:'updateUserEmail',userId:user.id,email,verified});setEditing(false)}}><label>邮箱<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label className="check-label"><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)}/>已人工核验</label><div><button type="button" className="button button-secondary" onClick={()=>setEditing(false)}>取消</button><button className="button button-primary" disabled={busy}>保存</button></div></form>;
  return <div><span className="avatar avatar-soft">{user.name.slice(0,1)}</span><p><b>{user.name}</b><small>{user.email} · {roleNames[user.role]}</small></p><span className={`verification ${user.emailVerified?'verified':''}`}>{user.emailVerified?'已核验':'未核验'}</span>{user.role==='advisor'&&<button className="text-button" onClick={()=>setEditing(true)}>编辑</button>}</div>;
}

function NewClientModal({busy,onClose,onSubmit}:{busy:boolean;onClose:()=>void;onSubmit:(v:Record<string,string>)=>Promise<void>}) {
  const [form,setForm]=useState({name:'',birthday:'',gender:'',phone:'',email:'',maritalStatus:'',state:'CA',language:'中文'});
  const update=(key:string,value:string)=>setForm(prev=>({...prev,[key]:value}));
  return <div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section role="dialog" aria-modal="true" aria-labelledby="new-client-title" className="modal modal-wide"><header><div><span className="eyebrow">合成资料</span><h2 id="new-client-title">建立客户档案</h2><p>六项基础资料齐全后才能开始访谈。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close"/></button></header><form onSubmit={e=>{e.preventDefault();void onSubmit(form)}}><div className="form-grid"><label>姓名 *<input value={form.name} onChange={e=>update('name',e.target.value)} required/></label><label>生日 *<input type="date" value={form.birthday} onChange={e=>update('birthday',e.target.value)} required/></label><label>性别 *<select value={form.gender} onChange={e=>update('gender',e.target.value)} required><option value="">请选择</option><option>女性</option><option>男性</option><option>非二元／其他</option></select></label><label>电话号码 *<input type="tel" value={form.phone} onChange={e=>update('phone',e.target.value)} pattern="[+() 0-9-]{7,20}" required/></label><label>邮箱 *<input type="email" value={form.email} onChange={e=>update('email',e.target.value)} required/></label><label>婚姻状态 *<select value={form.maritalStatus} onChange={e=>update('maritalStatus',e.target.value)} required><option value="">请选择</option><option>单身</option><option>已婚</option><option>伴侣关系</option><option>离异</option><option>丧偶</option></select></label><label>居住州<input value={form.state} onChange={e=>update('state',e.target.value)} maxLength={2}/></label><label>访谈语言<select value={form.language} onChange={e=>update('language',e.target.value)}><option>中文</option><option>English</option></select></label></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy}>{busy?'正在建立…':'建立档案与案例'}</button></div></form></section></div>;
}

function FactModal({fact,busy,onClose,onSave}:{fact:ProfileField;busy:boolean;onClose:()=>void;onSave:(v:Record<string,unknown>)=>Promise<void>}) {
  const isMoney=moneyFactKeys.has(fact.key); const [value,setValue]=useState(String(fact.value??'')); const [currency,setCurrency]=useState(fact.currency||'USD'); const [period,setPeriod]=useState(fact.period||'year'); const [status,setStatus]=useState(fact.factStatus); const [reason,setReason]=useState(''); const noValue=status==='unknown'||status==='declined';
  return <div className="modal-backdrop"><section className="modal"><header><div><span className="eyebrow">修正事实</span><h2>{factLabels[fact.key]||fact.key}</h2></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></header><form onSubmit={e=>{e.preventDefault();void onSave({key:fact.key,value:noValue?null:isMoney?Number(value):value,currency:isMoney&&!noValue?currency:null,period:isMoney&&!noValue?period:null,factStatus:status,reason})}}><label>内容<input type={isMoney?'number':'text'} min={isMoney?'0':undefined} value={noValue?'':value} onChange={e=>setValue(e.target.value)} disabled={noValue} required={!noValue}/></label>{isMoney&&!noValue&&<div className="form-grid"><label>币种<select value={currency} onChange={e=>setCurrency(e.target.value)}><option>USD</option><option>CNY</option><option>CAD</option><option>EUR</option><option>HKD</option></select></label><label>周期<select value={period} onChange={e=>setPeriod(e.target.value)}><option value="month">每月</option><option value="year">每年</option><option value="once">一次性／余额</option></select></label></div>}<label>事实状态<select value={status} onChange={e=>setStatus(e.target.value as FactStatus)}>{Object.entries(factStatusNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>修正理由 *<textarea value={reason} onChange={e=>setReason(e.target.value)} required/></label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy}>{busy?'正在保存…':'保存并创建新版本'}</button></div></form></section></div>;
}

function HandoffBanner({onClose}:{onClose:()=>void}) {return <div className="handoff-banner" role="status"><span className="success-ring"><Icon name="check"/></span><div><b>复核已完成</b><p>人工标记可进入现有报价流程；系统没有生成报价。</p></div><button onClick={onClose} className="icon-button"><Icon name="close"/></button></div>}

function HandbackBanner({onClose}:{onClose:()=>void}) {return <div className="handoff-banner handback-banner" role="status"><span className="success-ring"><Icon name="check"/></span><div><b>设备已回到顾问模式</b><p>请确认手机已交还。报告会在服务端后台生成，内部内容不会自动展开或朗读。</p></div><button onClick={onClose} className="icon-button" aria-label="关闭提示"><Icon name="close"/></button></div>}

function ClientAssistant({data,busy,act,refresh,setHandback,setToast}:{data:Bootstrap;busy:string;act:ActionFn;refresh:(caseId?:string)=>Promise<Bootstrap>;setHandback:(value:boolean)=>void;setToast:(v:Toast)=>void}) {
  const session=data.clientSession!; const [draft,setDraft]=useState(''); const [muted,setMuted]=useState(false); const [ending,setEnding]=useState(false); const [interim,setInterim]=useState<{role:'user'|'assistant';text:string}|null>(null); const [voiceState,setVoiceState]=useState<BrowserVoiceState>('idle'); const messagesEnd=useRef<HTMLDivElement>(null); const voiceRef=useRef<BrowserVoiceClient|null>(null);
  const [pendingText,setPendingText]=useState<{text:string;eventId:string;saved:boolean}|null>(null);
  const [liveMessages,setLiveMessages]=useState(data.messages);
  useEffect(()=>setLiveMessages(data.messages),[data.messages]);
  useEffect(()=>()=>{void voiceRef.current?.stopAll()},[]);
  useEffect(()=>{
    const pauseOnLeave=()=>{void voiceRef.current?.stopAll();void fetch('/api/action',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,headers:{'content-type':'application/json','x-csrf-token':data.csrf},body:JSON.stringify({action:'pause'})}).catch(()=>undefined)};
    window.addEventListener('pagehide',pauseOnLeave);
    return()=>window.removeEventListener('pagehide',pauseOnLeave);
  },[data.csrf]);
  const started=Boolean(session.entry); const voiceConfigured=data.capabilities.voiceConfigured;
  const stateLabel:Record<BrowserVoiceState,string>={idle:'等待开始',connecting:'正在连接',listening:'正在听您说',thinking:'正在思考',speaking:'正在回答',reconnecting:'连接恢复中',paused:'访谈已暂停',ended:'访谈已结束',error:'语音不可用'};
  async function choose(entry:Category){await act({action:'chooseEntry',entry});setVoiceState('idle');}
  async function startVoice(){
    if(!voiceRef.current) voiceRef.current=new BrowserVoiceClient({csrf:data.csrf,onState:setVoiceState,onInterim:event=>setInterim(event),onError:text=>setToast({kind:'error',text}),onInterrupted:()=>setInterim(null),onMicPermission:granted=>{if(!granted)setToast({kind:'error',text:'麦克风权限未开启，您仍可用文字继续。'})},onFinal:event=>{setInterim(null);setLiveMessages(previous=>[...previous,{id:crypto.randomUUID(),caseId:'client-safe',sessionId:session.id,turnId:crypto.randomUUID(),eventId:crypto.randomUUID(),role:event.role,text:event.text,final:true,interrupted:event.interrupted,createdAt:new Date().toISOString()}])}});
    try{await voiceRef.current.start();setToast({kind:'info',text:voiceConfigured?'正在建立实时语音连接。':'实时服务未配置；请使用文字完成演示。'});}catch{/* client reports a safe error through callbacks */}
  }
  async function submitText(message:{text:string;eventId:string;saved:boolean}){
    setPendingText(message);setVoiceState('thinking');
    try{await act({action:'message',text:message.text,eventId:message.eventId});setPendingText(null);setVoiceState('idle');}
    catch(error){const saved=error instanceof Error&&error.message.includes('已保存');setPendingText({...message,saved});setVoiceState('idle');if(saved)await refresh().catch(()=>undefined);}
  }
  function sendMessage(e:FormEvent){e.preventDefault();if(!draft.trim()||pendingText)return;const text=draft.trim();setDraft('');if(voiceRef.current?.sendText(text)){setVoiceState('thinking');return;}void submitText({text,eventId:crypto.randomUUID(),saved:false});}
  async function togglePause(){setInterim(null);if(session.state==='paused'){await act({action:'resume'});voiceRef.current=null;}else{await voiceRef.current?.stopAll();voiceRef.current=null;await act({action:'pause'});}}
  function toggleMute(){const next=!muted;setMuted(next);voiceRef.current?.setMuted(next)}
  async function end(){setEnding(true);setInterim(null);await voiceRef.current?.stopAll();let caseId:string|undefined;try{const result=await act({action:'end'},{noRefresh:true});caseId=result?.caseId;setHandback(true);await refresh(caseId);}catch{setEnding(false);await refresh(caseId).catch(()=>undefined)}}
  if(ending)return <main className="client-page"><section className="generating-state"><div className="loader"/><span className="eyebrow">访谈已结束</span><h1>请将手机交还给顾问</h1><p>正在保存最后的确定转写。内部报告将在顾问界面后台生成，不会向客户展示或朗读。</p></section></main>;
  return <main className="client-page"><div className="client-backdrop"><Brand/><div><span className="eyebrow">受限客户模式</span><h1>安心说，我们一次聊一件事。</h1><p>这个模式只能访问当前案例的客户可见内容。</p></div><span className="demo-pill">{voiceConfigured?'实时语音已配置':'模拟功能 · 合成资料'}</span></div>
    <section className="assistant-panel"><header><div className="assistant-identity"><span className="assistant-avatar">A</span><div><b>Aeconn AI 助手</b><span><i className={`state-dot state-${voiceState}`}/>{started?stateLabel[voiceState]:'准备访谈'}</span></div></div>{started&&<button className="icon-button" aria-label={session.state==='paused'?'恢复访谈':'暂停访谈'} onClick={()=>void togglePause()}><Icon name="pause"/></button>}</header>
      <div className="assistant-content">{!started?<WelcomeAssistant onChoose={choose} busy={busy==='chooseEntry'}/>:<><div className="privacy-intro"><Icon name="check"/><p>我会通过几个问题了解您的情况，供顾问后续跟进。您可以回答“不知道”或“不愿提供”。</p></div><span className="source-pill interview-source">{data.capabilities.interview?.includes('云端 AI')?'文字访谈 · 真实 API（待验收）':data.capabilities.interview==='云端配置不完整'?'文字访谈 · 云端配置不完整':'文字访谈 · 本地演示逻辑'}</span>{session.state==='paused'&&<div className="paused-card"><Icon name="pause"/><b>访谈已暂停</b><p>采集与播音均已停止。点击右上角按钮后才会恢复。</p></div>}<div className="chat-stream">{liveMessages.map(message=><div key={message.id} className={`bubble-row ${message.role}`}><div className="bubble"><p>{message.text}</p>{message.role==='assistant'&&<button aria-label="重播这条回答" onClick={()=>void voiceRef.current?.replayLast()}><Icon name="speaker"/>重播</button>}</div></div>)}{interim&&<div className={`bubble-row ${interim.role} interim-row`} aria-live="polite"><div className="bubble"><span>实时字幕</span><p>{interim.text}</p></div></div>}<div ref={messagesEnd}/></div></>}</div>
      {started&&<footer className="assistant-controls">{pendingText&&<div className="pending-message" role="status"><Icon name={pendingText.saved?'check':'alert'}/><div><b>{pendingText.saved?'回答已保存，云端回复未完成':'发送未完成'}</b><p>{pendingText.text}</p></div><button className="button button-secondary" disabled={busy==='message'} onClick={()=>void submitText(pendingText)}>用原回答重试</button></div>}{voiceState==='error'&&<div className="inline-error"><Icon name="alert"/><span>实时语音不可用，您仍可用文字继续。</span></div>}{voiceState==='idle'&&session.state!=='paused'&&<button className="voice-start" onClick={()=>void startVoice()}><Icon name="mic"/><span><b>开始连续语音对话</b><small>授权后无需每句话点发送</small></span></button>}<div className="voice-row"><button className={`voice-button ${voiceState==='listening'?'listening':''}`} onClick={()=>voiceState==='idle'||voiceState==='error'?void startVoice():toggleMute()} aria-label={muted?'取消静音':'麦克风静音'}><Icon name={muted?'mute':'mic'}/></button><div><b>{muted?'已静音':stateLabel[voiceState]}</b><span>{voiceConfigured?'真实服务已配置 · 待目标手机验证':'模拟界面 · 未调用实时语音服务'}</span></div><button className="end-button" disabled={busy==='end'} onClick={()=>void end()}>结束对话</button></div><form className="message-form" onSubmit={sendMessage}><input aria-label="文字回答" value={draft} onChange={e=>setDraft(e.target.value)} disabled={Boolean(pendingText)} placeholder={pendingText?'请先重试已保存的回答':'输入文字回答，或说‘不知道’…'}/><button aria-label="发送" disabled={!draft.trim()||busy==='message'||Boolean(pendingText)}><Icon name="send"/></button></form></footer>}
    </section><ToastView toast={null}/>
  </main>;
}

function WelcomeAssistant({onChoose,busy}:{onChoose:(v:Category)=>Promise<void>;busy:boolean}) {return <div className="assistant-welcome"><span className="assistant-avatar assistant-avatar-large">A</span><h2>您好，我是 Aeconn AI 助手</h2><p>请选择今天最想先聊的方向。入口只决定起问顺序，最终会同时检查四类需求。</p><div className="category-grid">{categories.map(category=><button key={category.id} disabled={busy} onClick={()=>void onChoose(category.id)}><span>{category.icon}</span><div><b>{category.title}</b><small>{category.caption}</small></div></button>)}</div><div className="client-disclaimer"><Icon name="alert"/><span>本 Demo 不选择具体产品、不报价、不保证收益，也不会提交申请。</span></div></div>}
