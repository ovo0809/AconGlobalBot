import { createHash, randomBytes } from 'node:crypto';
import { audit, checkPassword, db, docs, id, now, pack, transaction, unpack } from './db';
import { buildReport, renderPdf, validateAnalyses } from './report';
import { analyzeWithProvider, interviewWithProvider, ProviderExtractionValidationError } from './providers';
import { providerDisplayCapabilities, requireAnalysisConfig } from './provider-config';
import { buildInterviewContext, nextInterviewTurn, parseGroundedAnswer, INTERVIEW_QUESTIONS, type InterviewInput } from './interview';
import { closeVoiceSession, forgetVoiceSession, type VoiceDiagnosticEvent } from './voice-server';
import { DryRunMailProvider } from './mail';
import { getUsageSummary, purgeCaseUsage, recoverUsageReservations, UsageBudgetError } from './ai-usage';
import { loadKnowledge } from './knowledge';
import { publicKnowledgeContext } from './knowledge-public';
import type { Bootstrap, Case, Category, Client, FactStatus, Message, NotificationJob, ProfileField, ReportContent, ReportRecord, ReportJob, Review, Settings, User } from './domain';

type Input=Record<string,unknown>;
type Auth={id:string;user_id:string|null;csrf:string;mode:string;active_case:string|null;active_interview:string|null;last_ended_case:string|null;expires_at:number};
type Interview={id:string;case_id:string;auth_id:string;state:string;entry:Category|null;current_question:string|null;deadline:number|null;incomplete:number;voice_state:string;epoch:number};
export class AppError extends Error {constructor(public status:number,message:string,public code?:string){super(message);}}
function requireThat(condition:unknown,status:number,message:string,code?:string):asserts condition {if(!condition) throw new AppError(status,message,code);}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const str=(input:Input,key:string,max=5000)=>typeof input[key]==='string'?String(input[key]).trim().slice(0,max):'';
const categories:Category[]=['life','annuity','ltc','disability_income'];
const factStatuses:FactStatus[]=['confirmed','reported_unverified','unknown','declined','conflicting'];
const amountKeys=new Set(['income','expenses','debt','reserve','assets','budget']);
export const questions:Record<string,string>=INTERVIEW_QUESTIONS;
const shared=globalThis as typeof globalThis & {aeconnReportLocks?:Map<string,Promise<ReportRecord>>;aeconnLoginAttempts?:Map<string,{count:number;until:number}>;aeconnInterviewLocks?:Set<string>;aeconnReportWorker?:ReturnType<typeof setInterval>;aeconnReportWorkerBusy?:boolean};
const locks=shared.aeconnReportLocks??=new Map();
const loginAttempts=shared.aeconnLoginAttempts??=new Map();
const interviewLocks=shared.aeconnInterviewLocks??=new Set();

function readAuth(request:Request):Auth|null {
  const token=request.headers.get('cookie')?.match(/(?:^|;\s*)aeconn_session=([^;]+)/)?.[1];
  if(!token) return null;
  return db().prepare('SELECT * FROM auth_sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now()) as Auth|undefined ?? null;
}
function cookie(token:string,request:Request){return `aeconn_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${new URL(request.url).protocol==='https:'||process.env.HTTPS_PROXY_ORIGIN?.startsWith('https://')?'; Secure':''}`;}
function newAuth(request:Request,userId:string|null=null):{auth:Auth;cookie:string}{
  const token=randomBytes(32).toString('hex'); const auth:Auth={id:id(),user_id:userId,csrf:randomBytes(32).toString('hex'),mode:userId?'advisor':'anonymous',active_case:null,active_interview:null,last_ended_case:null,expires_at:Date.now()+8*60*60*1000};
  db().prepare('INSERT INTO auth_sessions(id,token_hash,user_id,csrf,mode,expires_at) VALUES(?,?,?,?,?,?)').run(auth.id,digest(token),userId,auth.csrf,auth.mode,auth.expires_at);
  return {auth,cookie:cookie(token,request)};
}
function userFor(auth:Auth):User {requireThat(auth.user_id,401,'请先登录。');const user=docs<User>('SELECT doc FROM users WHERE id=?',auth.user_id)[0];requireThat(user,401,'会话已失效。');return user;}
function requireAdvisorMode(auth:Auth):User {requireThat(auth.mode==='advisor',403,'客户模式期间无法访问内部资料，请先结束访谈并交还手机。');return userFor(auth);}
function caseFor(user:User,caseId:string,ownerOnly=false,includeDeleted=false):Case {
  const record=docs<Case>('SELECT doc FROM cases WHERE id=?',caseId)[0];requireThat(record,404,'案例不存在。','CASE_NOT_FOUND');
  const owner=docs<User>('SELECT doc FROM users WHERE id=?',record.ownerAgentId)[0];
  requireThat(owner?.orgId===user.orgId && (record.ownerAgentId===user.id && user.role==='advisor' || !ownerOnly && user.role==='reviewer' && record.assignedReviewerId===user.id),403,'您无权查看此案例。');requireThat(includeDeleted||!record.deletedAt,404,'案例不存在。','CASE_NOT_FOUND');return record;
}
function saveCase(record:Case){record.updatedAt=now();db().prepare('UPDATE cases SET reviewer_id=?,doc=? WHERE id=?').run(record.assignedReviewerId,pack(record),record.id);}
function caseDisplayName(record:Case,clientName:string|undefined){if(!clientName)return undefined;const number=record.caseNumber??0;return number>0?`${clientName}（${number}）`:clientName;}
function currentInterview(auth:Auth):Interview {
  requireThat(auth.mode==='client'&&auth.active_interview&&auth.active_case,403,'当前不在客户访谈模式。');
  const session=db().prepare('SELECT * FROM interviews WHERE id=? AND auth_id=? AND case_id=?').get(auth.active_interview,auth.id,auth.active_case) as Interview|undefined;
  requireThat(session&&['active','paused'].includes(session.state),409,'访谈已结束。');
  const user=userFor(auth);caseFor(user,session.case_id,true);return session;
}
const messagesFor=(caseId:string)=>docs<Message>('SELECT doc FROM messages WHERE case_id=? ORDER BY rowid',caseId);
const factsFor=(caseId:string)=>docs<ProfileField>('SELECT doc FROM profile_fields WHERE case_id=? ORDER BY field_key',caseId);
function settingsFor(user:User):Settings {const row=db().prepare('SELECT settings FROM organizations WHERE id=?').get(user.orgId)!;return {...unpack<Settings>(row.settings),mailMode:process.env.MAIL_MODE||'dry_run'};}
function recipientsFor(record:Case){const owner=docs<User>('SELECT doc FROM users WHERE id=?',record.ownerAgentId)[0];const settings=settingsFor(owner);return [{email:settings.companyEmail,name:'公司邮箱（Charles 管理）',verified:settings.companyVerified},{email:owner.email,name:owner.name,verified:owner.emailVerified}];}
function recipientFingerprint(record:Case){return digest(pack(recipientsFor(record)));}
function reportRecord(content:ReportContent,record:Case):ReportRecord {return {...content,stale:content.version!==record.reportVersion||record.status==='needs_report',recipientFingerprint:recipientFingerprint(record),recipients:recipientsFor(record),pdfUrl:`/api/report?caseId=${encodeURIComponent(record.id)}&version=${content.version}&format=pdf`,pdfReady:true};}
function addMessage(sessionId:string,caseId:string,role:'user'|'assistant',text:string,eventId=id(),turnId=eventId,interrupted=false,final=true,source:Message['source']='customer',actorId?:string,reference?:Pick<Message,'knowledge'|'knowledgeRefs'>):Message {
  const message:Message={id:id(),caseId,sessionId,role,text,final,eventId,turnId,interrupted,createdAt:now(),playbackStatus:interrupted?'interrupted':'unknown',correctionOf:null,source,actorId,...(role==='assistant'?reference:{})};
  db().prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)').run(message.id,caseId,sessionId,eventId,turnId,role,pack(message));
  return docs<Message>('SELECT doc FROM messages WHERE session_id=? AND (event_id=? OR turn_id=?) AND role=?',sessionId,eventId,turnId,role)[0];
}
function interviewInput(session:Interview):InterviewInput{const record=docs<Case>('SELECT doc FROM cases WHERE id=?',session.case_id)[0];const client=docs<Client>('SELECT doc FROM clients WHERE id=?',record.clientId)[0];return {usageContext:{caseId:session.case_id,sessionId:session.id},caseRecord:{id:session.case_id},entry:session.entry??'life',knownClient:{state:client.state,language:client.language},facts:factsFor(session.case_id),messages:messagesFor(session.case_id)};}
function knowledgeQuery(entry:Category|null,facts:ProfileField[],messages:Message[]){
  const topic={life:'家庭责任 人寿保障',annuity:'退休 现金流 流动性',ltc:'长期照护 安排',disability_income:'职业 收入中断 伤残保障'};
  // Used only for local ranking; no customer query is sent to GitHub.
  return [entry?topic[entry]:'',...facts.filter(f=>f.value!==null).map(f=>`${f.key} ${String(f.value).slice(0,500)}`),...messages.filter(m=>m.role==='user'&&m.final).slice(-4).map(m=>m.text.slice(0,1000))].join('\n');
}
function askNext(session:Interview,eventId?:string){const next=nextInterviewTurn(interviewInput(session));db().prepare('UPDATE interviews SET current_question=? WHERE id=?').run(next.targetKey,session.id);addMessage(session.id,session.case_id,'assistant',next.reply,eventId);}
function validateFact(fact:ProfileField,messages:Message[]){
  requireThat(Object.hasOwn(questions,fact.key),400,'未知事实字段。');requireThat(factStatuses.includes(fact.factStatus),400,'事实状态无效。');
  requireThat(fact.value===null||typeof fact.value==='string'||typeof fact.value==='number',400,'事实值格式错误。');
  if(['unknown','declined'].includes(fact.factStatus)) requireThat(fact.value===null,400,'未知或拒答必须保存为空，不能保存为零。');
  if(amountKeys.has(fact.key)&&fact.value!==null){requireThat(typeof fact.value==='number'&&Number.isFinite(fact.value)&&fact.value>=0,400,'金额必须是非负数字。');requireThat(['USD','CNY','CAD','EUR','HKD'].includes(fact.currency??'')&&['month','year','once'].includes(fact.period??''),400,'金额需要币种与月／年／一次性周期。');}
  requireThat(Array.isArray(fact.sourceMessageIds)&&fact.sourceMessageIds.every(ref=>messages.some(message=>message.id===ref&&message.final&&message.role==='user')),400,'事实来源必须属于当前案例的最终客户消息。');
  requireThat(fact.value===null||fact.sourceMessageIds.length>0,400,'有值的事实必须具有来源。');
}
function saveFact(caseId:string,fact:ProfileField){validateFact(fact,messagesFor(caseId));db().prepare('INSERT INTO profile_fields VALUES(?,?,?) ON CONFLICT(case_id,field_key) DO UPDATE SET doc=excluded.doc').run(caseId,fact.key,pack(fact));}
function parseAnswer(key:string,text:string,messageId:string):ProfileField|null {
  return parseGroundedAnswer(key,text,messageId);
}

async function respondToText(session:Interview,text:string,eventId:string){
  const replyId=`${eventId}:reply`;
  if(db().prepare("SELECT id FROM messages WHERE session_id=? AND event_id=? AND role='assistant'").get(session.id,replyId))return;
  requireThat(!interviewLocks.has(session.id),409,'上一条回答正在处理，请稍后重试。');
  requireThat(session.voice_state==='ended'||session.voice_state==='error',409,'语音连接正在接收文字，请先停止语音或暂停后恢复文字访谈。');
  interviewLocks.add(session.id);
  try{
    const message=addMessage(session.id,session.case_id,'user',text,eventId);
    const input=interviewInput(session);
    const knowledge=await loadKnowledge(knowledgeQuery(input.entry,input.facts,input.messages));
    requireThat(voiceHooks.isActive(session.id)&&db().prepare('SELECT epoch FROM interviews WHERE id=?').get(session.id)?.epoch===session.epoch,409,'访谈已暂停或结束，回答已保存，未继续生成问题。');
    let turn;
    try{turn=await interviewWithProvider({...input,knowledge});}
    catch(error){if(error instanceof UsageBudgetError)throw new AppError(429,`${error.message} 您的回答已保存，可结束访谈交还顾问。`);throw new AppError(503,'您的回答已保存。云端访谈暂时未完成，请稍后重试或交还顾问；不会使用模拟回复冒充 AI。');}
    requireThat(voiceHooks.isActive(session.id)&&db().prepare('SELECT epoch FROM interviews WHERE id=?').get(session.id)?.epoch===session.epoch,409,'访谈已暂停或结束，回答已保存，未继续生成问题。');
    transaction(()=>{
      if(turn){for(const fact of turn.facts)saveFact(session.case_id,fact);addMessage(session.id,session.case_id,'assistant',turn.reply,replyId,replyId,false,true,'customer',undefined,{knowledge,knowledgeRefs:turn.knowledgeRefs??[]});}
      else if(session.current_question){const fact=parseAnswer(session.current_question,text,message.id);if(fact){saveFact(session.case_id,fact);askNext(session,replyId);}else addMessage(session.id,session.case_id,'assistant','请确认金额、币种和月／年／一次性周期，例如“5000 美元 每月”。也可以回答“不知道”或“不愿提供”。',replyId);}
      else askNext(session,replyId);
    });
  }finally{interviewLocks.delete(session.id);}
}

async function finalizeInterviewFacts(caseId:string){
  const sessions=db().prepare("SELECT * FROM interviews WHERE case_id=? AND state='ended'").all(caseId) as Interview[];
  for(const session of sessions){
    const input=interviewInput(session);
    const finalized=input.messages.filter(m=>m.sessionId===session.id&&m.role==='user'&&m.final);
    const hash=digest(pack(finalized));
    const prior=db().prepare('SELECT transcript_hash FROM interview_extractions WHERE session_id=?').get(session.id);
    if(prior?.transcript_hash===hash)continue;
    // A real voice transcript must not silently finish with mock extraction.
    if(finalized.some(m=>m.eventId.includes(':voice:')))requireThat(requireAnalysisConfig(),409,'语音事实提取需要完整的云端文字模型配置。');
    const before=digest(pack({facts:input.facts,messages:input.messages}));
    const output=finalized.length?await interviewWithProvider(input,true):null;
    requireThat(before===digest(pack({facts:factsFor(caseId),messages:messagesFor(caseId)})),409,'提取期间资料已变化，请重试。');
    transaction(()=>{for(const fact of output?.facts??[])saveFact(caseId,fact);db().prepare('INSERT INTO interview_extractions VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET transcript_hash=excluded.transcript_hash,updated_at=excluded.updated_at').run(session.id,hash,now());});
  }
}

function reportJobFor(caseId:string):ReportJob|undefined{return docs<ReportJob>('SELECT doc FROM report_jobs WHERE case_id=?',caseId)[0];}
function saveReportJob(job:ReportJob){db().prepare('INSERT INTO report_jobs VALUES(?,?,?) ON CONFLICT(case_id) DO UPDATE SET status=excluded.status,doc=excluded.doc').run(job.caseId,job.status,pack(job));}
function enqueueReport(caseId:string){const old=reportJobFor(caseId);if(old&&['queued','generating'].includes(old.status))return;saveReportJob({caseId,status:'queued',attempts:old?.attempts??0,error:null,updatedAt:now()});}
const EXTRACTION_VALIDATION_MESSAGE='事实提取未通过来源校验，原对话已保存；请核对后重试。';
function reportFailureMessage(error:unknown){return error instanceof ProviderExtractionValidationError?EXTRACTION_VALIDATION_MESSAGE:error instanceof UsageBudgetError?`${error.message} 原对话已保存，额度不足时不会继续生成报告。`:'事实提取或报告未完成，原对话已保存。请检查云端配置或待核对用量后重试。';}
function reportFailureAudit(error:unknown){return error instanceof ProviderExtractionValidationError?{failureCode:error.code,category:error.category}:error instanceof UsageBudgetError?{failureCode:error.code,category:'budget'}:{failureCode:'REPORT_GENERATION_FAILED',category:'provider_or_generation'};}

/** Persistent single-process queue. Work runs independently of any browser request. */
export async function processReportJobs(){
  if(shared.aeconnReportWorkerBusy)return;
  shared.aeconnReportWorkerBusy=true;
  try{
    const job=transaction(()=>{const next=docs<ReportJob>("SELECT doc FROM report_jobs WHERE status='queued' ORDER BY rowid LIMIT 1")[0];if(next)saveReportJob({...next,status:'generating',attempts:next.attempts+1,error:null,updatedAt:now()});return next;});
    if(job){
      try{await generateReport(job.caseId);saveReportJob({...job,status:'ready',attempts:job.attempts+1,error:null,updatedAt:now()});}
      catch(error){saveReportJob({...job,status:'failed',attempts:job.attempts+1,error:reportFailureMessage(error),updatedAt:now()});audit(null,job.caseId,'report.background_failed',reportFailureAudit(error));}
    }
  }finally{shared.aeconnReportWorkerBusy=false;}
}

export function recoverReportJobs(){
  // Called once by the server on startup, never by a request handler.
  transaction(()=>{
    for(const row of db().prepare("SELECT * FROM interviews WHERE state='finishing'").all() as Interview[]){db().prepare("UPDATE interviews SET state='ended',ended_at=?,voice_state='ended',incomplete=1 WHERE id=?").run(now(),row.id);const record=docs<Case>('SELECT doc FROM cases WHERE id=?',row.case_id)[0];record.status='needs_report';saveCase(record);enqueueReport(row.case_id);}
    for(const job of docs<ReportJob>("SELECT doc FROM report_jobs WHERE status='generating'"))saveReportJob({...job,status:'queued',error:null,updatedAt:now()});
  });
}
export function startReportWorker(){if(shared.aeconnReportWorker)return;recoverUsageReservations();recoverReportJobs();shared.aeconnReportWorker=setInterval(()=>{void processReportJobs();},500);shared.aeconnReportWorker.unref();}

export function bootstrap(request:Request):Response {
  let auth=readAuth(request);let setCookie:string|undefined;if(!auth){const created=newAuth(request);auth=created.auth;setCookie=created.cookie;}
  const capabilities={...providerDisplayCapabilities(),mail:'dry-run（未发送）'};
  const data:Bootstrap={csrf:auth.csrf,mode:'anonymous',user:null,clients:[],cases:[],activeCase:null,messages:[],facts:[],reports:[],notifications:[],reviews:[],capabilities,demo:true};
  if(auth.user_id){const user=userFor(auth);
    if(auth.mode==='client'){
      const session=currentInterview(auth);data.mode='client';data.clientSession={id:session.id,state:session.state,entry:session.entry};
      data.activeCase={id:session.case_id,entry:session.entry,clientId:'',ownerAgentId:'',status:'interviewing',createdAt:'',updatedAt:'',assignedReviewerId:null,reportVersion:0};
      data.messages=messagesFor(session.case_id).filter(message=>message.sessionId===session.id).map(message=>{
        const knowledge=publicKnowledgeContext(message.knowledge);
        return {...message,knowledge,knowledgeRefs:message.knowledgeRefs?.filter(ref=>knowledge?.sources.some(source=>source.id===ref))};
      });
    }else{
      data.mode='advisor';data.user=user;
      // Only internal roles receive totals; case-level entries follow caseFor authorization.
      data.usage=getUsageSummary(user.orgId);
      if(user.role==='admin'){data.settings=settingsFor(user);data.users=docs<User>('SELECT doc FROM users WHERE org_id=?',user.orgId);}
      else {
        const scopedCases=user.role==='advisor'?docs<Case>('SELECT doc FROM cases WHERE owner_id=? ORDER BY rowid DESC',user.id):docs<Case>('SELECT doc FROM cases WHERE reviewer_id=? ORDER BY rowid DESC',user.id);
        data.cases=scopedCases.filter(record=>!record.deletedAt);
        if(user.role==='advisor')data.deletedCases=scopedCases.filter(record=>record.deletedAt);
        const allClientIds=new Set(scopedCases.map(record=>record.clientId)),activeClientIds=new Set(data.cases.map(record=>record.clientId));
        const scopedClients=docs<Client>('SELECT doc FROM clients').filter(client=>allClientIds.has(client.id));data.clients=scopedClients.filter(client=>activeClientIds.has(client.id));
        data.cases=data.cases.map(record=>({...record,clientName:caseDisplayName(record,scopedClients.find(client=>client.id===record.clientId)?.name)}));
        if(data.deletedCases)data.deletedCases=data.deletedCases.map(record=>({...record,clientName:caseDisplayName(record,scopedClients.find(client=>client.id===record.clientId)?.name)}));
        const requested=new URL(request.url).searchParams.get('caseId');const selected=requested||(auth.last_ended_case&&data.cases.some(record=>record.id===auth.last_ended_case)?auth.last_ended_case:data.cases[0]?.id);
        if(selected){data.activeCase=caseFor(user,selected);data.usage=getUsageSummary(user.orgId,selected,true);data.activeCase.clientName=caseDisplayName(data.activeCase,data.clients.find(client=>client.id===data.activeCase?.clientId)?.name);data.messages=messagesFor(selected);data.facts=factsFor(selected);data.reports=docs<ReportContent>('SELECT doc FROM reports WHERE case_id=? ORDER BY version DESC',selected).map(content=>reportRecord(content,data.activeCase!));data.reportJob=reportJobFor(selected);data.notifications=docs<NotificationJob>('SELECT doc FROM notification_jobs WHERE case_id=? ORDER BY rowid',selected);data.reviews=docs<Review>('SELECT doc FROM reviews WHERE case_id=? ORDER BY rowid',selected);}
      }
    }
  }
  return json(data,200,setCookie);
}
export function json(value:unknown,status=200,setCookie?:string):Response {const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Vary':'Cookie'};if(setCookie)headers['Set-Cookie']=setCookie;return new Response(JSON.stringify(value),{status,headers});}
export function errorResponse(error:unknown){if(error instanceof ProviderExtractionValidationError)return json({error:EXTRACTION_VALIDATION_MESSAGE,code:error.code},422);return json({error:error instanceof AppError||error instanceof UsageBudgetError?error.message:'操作未完成。资料已保存，请重试；如反复出现，请查看不含客户资料的服务日志。',...(error instanceof AppError&&error.code?{code:error.code}:{})},error instanceof AppError?error.status:error instanceof UsageBudgetError?429:500);}

async function generateReport(caseId:string,reviewStatus='draft',reviewNote?:string):Promise<ReportRecord>{
  const existing=locks.get(caseId);if(existing){requireThat(!reviewNote,409,'另一份报告正在生成，请完成后再提交复核。');return existing;}
  const task=(async()=>{
    let record=docs<Case>('SELECT doc FROM cases WHERE id=?',caseId)[0];requireThat(record,404,'案例不存在。');
    requireThat(!db().prepare("SELECT id FROM interviews WHERE case_id=? AND state IN ('active','paused','finishing')").get(caseId),409,'请先结束访谈，等待转写收尾。');
    await finalizeInterviewFacts(caseId);
    const owner=docs<User>('SELECT doc FROM users WHERE id=?',record.ownerAgentId)[0];const client=docs<Client>('SELECT doc FROM clients WHERE id=?',record.clientId)[0];
    const messages=messagesFor(caseId);const facts=factsFor(caseId);const incomplete=!!db().prepare('SELECT id FROM interviews WHERE case_id=? AND incomplete=1').get(caseId);
    const before=digest(pack({messages,facts}));
    const knowledge=await loadKnowledge(knowledgeQuery(record.entry,facts,messages));
    requireThat(before===digest(pack({messages:messagesFor(caseId),facts:factsFor(caseId)})),409,'检索期间资料发生变化，请重新生成。');
    const originalSnapshot=digest(pack({before,reviewStatus,reviewNote,rule:'demo_unapproved_v1',knowledge}));
    const prior=docs<ReportContent>('SELECT doc FROM reports WHERE case_id=? AND snapshot_id=?',caseId,originalSnapshot)[0];if(prior)return reportRecord(prior,record);
    const output=await analyzeWithProvider({messages,facts,knowledge,usageContext:{caseId}});const {analyses,provider}=output;
    requireThat(before===digest(pack({messages:messagesFor(caseId),facts:factsFor(caseId)})),409,'生成期间事实发生变化，请重新生成。');
    validateAnalyses(analyses,facts,messages,knowledge);
    const snapshotId=originalSnapshot;
    record=docs<Case>('SELECT doc FROM cases WHERE id=?',caseId)[0];const version=record.reportVersion+1;
    const report=buildReport({client,owner,caseRecord:record,version,snapshotId,reviewStatus,createdAt:now(),facts,messages,analyses,incompleteTranscript:incomplete,provider,reviewNote,knowledge});const pdf=await renderPdf(report);
    requireThat(pdf.length>500&&pdf.subarray(0,4).toString()==='%PDF',500,'PDF 生成失败，未创建发送任务。');
    requireThat(before===digest(pack({messages:messagesFor(caseId),facts:factsFor(caseId)})),409,'生成期间事实发生变化，请重新生成。');
    transaction(()=>{for(const fact of facts)saveFact(caseId,fact);db().prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(caseId,version,snapshotId,pack(report),pdf);record.reportVersion=version;record.status=reviewStatus==='reviewed'?'reviewed':reviewStatus==='returned'?'returned':'draft';saveCase(record);audit(owner.id,caseId,'report.generated',{version,snapshotId,provider});});
    return reportRecord(report,record);
  })();locks.set(caseId,task);try{return await task;}finally{locks.delete(caseId);}
}

export async function action(request:Request):Promise<Response>{
  const auth=readAuth(request);requireThat(auth,401,'会话已过期，请刷新页面。');
  requireThat(request.headers.get('x-csrf-token')===auth.csrf,403,'会话校验失败，请刷新页面。');
  // Next may normalize Request.url to localhost; the browser's same-origin Host remains authoritative.
  const requestUrl=new URL(request.url);const expectedOrigin=process.env.HTTPS_PROXY_ORIGIN||`${requestUrl.protocol}//${request.headers.get('host')||requestUrl.host}`;
  requireThat(request.headers.get('origin')===expectedOrigin,403,'请求来源校验失败。');
  const raw=await request.text();requireThat(raw.length<=32_768,413,'输入过长。');let input:Input;try{input=JSON.parse(raw);}catch{throw new AppError(400,'请求格式错误。');}requireThat(input&&typeof input==='object'&&!Array.isArray(input),400,'请求格式错误。');
  const name=str(input,'action',80);requireThat(name,400,'缺少操作。');
  if(name==='login'){
    requireThat(auth.mode!=='client',403,'请先结束客户访谈。');const email=str(input,'email',254).toLowerCase();const password=str(input,'password',256);
    const attempt=loginAttempts.get(email);requireThat(!attempt||attempt.until<Date.now()||attempt.count<10,429,'登录尝试过多，请一分钟后重试。');
    loginAttempts.set(email,{count:attempt&&attempt.until>Date.now()?attempt.count+1:1,until:Date.now()+60_000});
    const row=db().prepare('SELECT id,password_hash FROM users WHERE email=?').get(email);requireThat(row&&checkPassword(password,String(row.password_hash)),401,'邮箱或密码不正确。');
    loginAttempts.delete(email);const created=newAuth(request,String(row.id));db().prepare('UPDATE auth_sessions SET expires_at=0 WHERE id=?').run(auth.id);audit(String(row.id),null,'auth.login');return json({ok:true},200,created.cookie);
  }
  const user=userFor(auth);
  if(auth.mode==='client')requireThat(['chooseEntry','message','pause','resume','end','voiceToken'].includes(name),403,'客户模式期间禁止内部操作。');
  if(name==='logout') {requireAdvisorMode(auth);db().prepare('UPDATE auth_sessions SET expires_at=0 WHERE id=?').run(auth.id);return json({ok:true},200,'aeconn_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');}
  if(name==='end'){
    if(auth.mode==='advisor'&&auth.last_ended_case){if(input.caseId)requireThat(input.caseId===auth.last_ended_case,409,'结束案例不匹配。');caseFor(user,auth.last_ended_case,true);return json({ok:true,caseId:auth.last_ended_case});}
    const session=currentInterview(auth);if(input.caseId)requireThat(input.caseId===session.case_id,403,'案例范围不匹配。');
    transaction(()=>{db().prepare("UPDATE interviews SET state='finishing',epoch=epoch+1,deadline=? WHERE id=?").run(Date.now()+1700,session.id);db().prepare("UPDATE auth_sessions SET mode='advisor',last_ended_case=active_case,active_case=NULL,active_interview=NULL WHERE id=?").run(auth.id);db().prepare('DELETE FROM voice_tokens WHERE interview_id=?').run(session.id);});
    await closeVoiceSession(session.id);
    const record=caseFor(user,session.case_id,true);transaction(()=>{db().prepare("UPDATE interviews SET state='ended',ended_at=?,voice_state='ended' WHERE id=?").run(now(),session.id);record.status='needs_report';saveCase(record);enqueueReport(record.id);audit(user.id,record.id,'interview.ended');});return json({ok:true,caseId:record.id});
  }
  if(['chooseEntry','message','pause','resume','voiceToken'].includes(name)){
    const session=currentInterview(auth);if(input.caseId)requireThat(input.caseId===session.case_id,403,'案例范围不匹配。');
    if(name==='chooseEntry'){requireThat(session.state==='active'&&!session.entry,409,'入口已选定。');const entry=str(input,'entry') as Category;requireThat(categories.includes(entry),400,'请选择四个入口之一。');db().prepare('UPDATE interviews SET entry=? WHERE id=?').run(entry,session.id);const record=caseFor(user,session.case_id,true);record.entry=entry;saveCase(record);session.entry=entry;askNext(session);}
    if(name==='message'){
      requireThat(session.state==='active'&&session.entry,409,'请先选择入口并恢复访谈。');const text=str(input,'text',4000),eventId=str(input,'eventId',100);requireThat(text&&eventId,400,'消息及事件编号不能为空。');
      await respondToText(session,text,eventId);
    }
    if(name==='pause'){db().prepare("UPDATE interviews SET state='paused',epoch=epoch+1,voice_state='ended',deadline=? WHERE id=?").run(Date.now()+1700,session.id);await closeVoiceSession(session.id);db().prepare('UPDATE interviews SET deadline=NULL WHERE id=?').run(session.id);}
    if(name==='resume'){db().prepare("UPDATE interviews SET state='active' WHERE id=?").run(session.id);}
    if(name==='voiceToken'){requireThat(session.state==='active'&&session.entry,409,'请先选择入口并恢复访谈。');requireThat(providerDisplayCapabilities().voiceConfigured,409,'实时语音未配置，可继续文字访谈或明确标记的模拟演示。');const token=randomBytes(32).toString('hex');db().prepare('INSERT INTO voice_tokens VALUES(?,?,?,?)').run(digest(token),session.id,auth.id,Date.now()+30_000);return json({ok:true,token});}
    return json({ok:true});
  }
  requireAdvisorMode(auth);
  if(name==='createClient'){
    requireThat(user.role==='advisor',403,'仅顾问可以建档。');const nameValue=str(input,'name',100),birthday=str(input,'birthday',10),gender=str(input,'gender',40),phone=str(input,'phone',40),email=str(input,'email',254),maritalStatus=str(input,'maritalStatus',40);
    requireThat(nameValue&&gender&&maritalStatus&&/^\d{4}-\d{2}-\d{2}$/.test(birthday)&&Number.isFinite(Date.parse(birthday))&&new Date(birthday).toISOString().slice(0,10)===birthday&&birthday>='1900-01-01'&&birthday<=now().slice(0,10),400,'请完整填写姓名、有效生日、性别和婚姻状态。');requireThat(/^\+?[\d\s()-]{7,25}$/.test(phone)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),400,'请填写有效电话号码与邮箱。');
    const client:Client={id:id(),name:nameValue,birthday,gender,phone,email,maritalStatus,state:str(input,'state',80),language:str(input,'language',50)||'普通话',ownerAgentId:user.id,consentStatus:'purpose_explained_demo',createdAt:now(),nextCaseNumber:0};
    const caseRecord=transaction(()=>{db().prepare('INSERT INTO clients VALUES(?,?,?)').run(client.id,user.id,pack(client));return createCase(client.id,user.id);});audit(user.id,caseRecord.id,'client.created');return json({ok:true,clientId:client.id,caseId:caseRecord.id});
  }
  if(name==='createCase'){const client=docs<Client>('SELECT doc FROM clients WHERE id=?',str(input,'clientId'))[0];requireThat(user.role==='advisor'&&client?.ownerAgentId===user.id,403,'无权为此客户创建访谈。');return json({ok:true,caseId:transaction(()=>createCase(client.id,user.id)).id});}
  if(name==='deleteCase'||name==='restoreCase'||name==='purgeCase'){
    requireThat(user.role==='advisor',403,'仅归属顾问可以管理案例。');const record=caseFor(user,str(input,'caseId'),true,name!=='deleteCase');
    if(name==='restoreCase'){requireThat(record.deletedAt,409,'案例未被删除。');transaction(()=>{record.deletedAt=null;record.deletedBy=null;saveCase(record);audit(user.id,record.id,'case.restored');});return json({ok:true,nextCaseId:record.id});}
    requireThat(!db().prepare("SELECT id FROM interviews WHERE case_id=? AND state IN ('active','paused','finishing')").get(record.id),409,'进行中的访谈不能删除，请先结束访谈。');requireThat(!locks.has(record.id)&&!['queued','generating'].includes(reportJobFor(record.id)?.status??''),409,'报告正在生成，暂时不能删除案例。');
    if(name==='purgeCase'){
      requireThat(record.deletedAt,409,'请先将案例移入已删除案例。');requireThat(str(input,'confirmation',20)==='永久删除',400,'请输入“永久删除”确认此操作。');
      const sessions=db().prepare('SELECT id FROM interviews WHERE case_id=?').all(record.id) as {id:string}[];
      requireThat(!sessions.some(session=>interviewLocks.has(session.id)),409,'访谈消息仍在处理，请稍后重试。');
      requireThat(!db().prepare("SELECT id FROM ai_usage_calls WHERE case_id=? AND status='reserved'").get(record.id),409,'仍有进行中的调用记录，请等待结算后再永久删除。');
      transaction(()=>{
        purgeCaseUsage(record.id);
        db().prepare("UPDATE auth_sessions SET mode=CASE WHEN active_case=? OR active_interview IN (SELECT id FROM interviews WHERE case_id=?) THEN 'advisor' ELSE mode END,active_case=CASE WHEN active_case=? THEN NULL ELSE active_case END,active_interview=CASE WHEN active_interview IN (SELECT id FROM interviews WHERE case_id=?) THEN NULL ELSE active_interview END,last_ended_case=CASE WHEN last_ended_case=? THEN NULL ELSE last_ended_case END WHERE active_case=? OR active_interview IN (SELECT id FROM interviews WHERE case_id=?) OR last_ended_case=?").run(record.id,record.id,record.id,record.id,record.id,record.id,record.id,record.id);
        db().prepare('DELETE FROM voice_tokens WHERE interview_id IN (SELECT id FROM interviews WHERE case_id=?)').run(record.id);
        db().prepare('DELETE FROM interview_extractions WHERE session_id IN (SELECT id FROM interviews WHERE case_id=?)').run(record.id);
        db().prepare('DELETE FROM notification_jobs WHERE case_id=?').run(record.id);
        db().prepare('DELETE FROM approvals WHERE case_id=?').run(record.id);
        for(const table of ['reviews','reports','profile_fields','messages','report_jobs','audit_events','interviews'])db().prepare(`DELETE FROM ${table} WHERE case_id=?`).run(record.id);
        db().prepare('DELETE FROM cases WHERE id=?').run(record.id);
        if(!db().prepare('SELECT id FROM cases WHERE client_id=? LIMIT 1').get(record.clientId))db().prepare('DELETE FROM clients WHERE id=?').run(record.clientId);
      });
      for(const session of sessions)forgetVoiceSession(session.id);
      return json({ok:true});
    }
    transaction(()=>{record.deletedAt=now();record.deletedBy=user.id;saveCase(record);db().prepare('UPDATE auth_sessions SET last_ended_case=NULL WHERE id=? AND last_ended_case=?').run(auth.id,record.id);audit(user.id,record.id,'case.soft_deleted');});
    const next=docs<Case>('SELECT doc FROM cases WHERE owner_id=? ORDER BY rowid DESC',user.id).find(item=>!item.deletedAt);return json({ok:true,nextCaseId:next?.id??null});
  }
  if(name==='enterClient'){
    const record=caseFor(user,str(input,'caseId'),true);requireThat(!locks.has(record.id)&&!['queued','generating'].includes(reportJobFor(record.id)?.status??''),409,'报告正在生成，请等待完成或新建访谈。');requireThat(!db().prepare("SELECT id FROM interviews WHERE case_id=? AND state IN ('active','paused','finishing')").get(record.id),409,'此案例已有进行中的访谈。请回到原设备结束，或新建一次访谈。');requireThat(record.reportVersion===0,409,'已有报告的案例请新建访谈，以保留历史。');
    const sessionId=id();transaction(()=>{db().prepare("INSERT INTO interviews(id,case_id,auth_id,state,created_at) VALUES(?,?,?,'active',?)").run(sessionId,record.id,auth.id,now());db().prepare("UPDATE auth_sessions SET mode='client',active_case=?,active_interview=?,last_ended_case=NULL WHERE id=?").run(record.id,sessionId,auth.id);record.status='interviewing';saveCase(record);});audit(user.id,record.id,'client_mode.entered');return json({ok:true,caseId:record.id});
  }
  if(name==='generateReport'){const record=caseFor(user,str(input,'caseId'),true);const old=reportJobFor(record.id);try{const report=await generateReport(record.id);saveReportJob({caseId:record.id,status:'ready',attempts:(old?.attempts??0)+1,error:null,updatedAt:now()});return json({ok:true,version:report.version});}catch(error){saveReportJob({caseId:record.id,status:'failed',attempts:(old?.attempts??0)+1,error:reportFailureMessage(error),updatedAt:now()});throw error;}}
  if(name==='updateFact'){
    const record=caseFor(user,str(input,'caseId'));requireThat(!locks.has(record.id),409,'报告正在生成，请稍后修改。');requireThat(!db().prepare("SELECT id FROM interviews WHERE case_id=? AND state IN ('active','paused','finishing')").get(record.id),409,'请先结束访谈再更正事实。');const key=str(input,'key',60),reason=str(input,'reason',2000),factStatus=str(input,'factStatus') as FactStatus;requireThat(reason,400,'请填写更正理由。');
    const empty=['unknown','declined','conflicting'].includes(factStatus);const value=empty?null:input.value;requireThat(value===null||typeof value==='string'||typeof value==='number',400,'事实值格式无效。');requireThat(empty||value!==null,400,'已有事实需要值；未知请选择未知状态。');
    const currency=empty?null:str(input,'currency',3)||null,period=empty?null:str(input,'period',10)||null;
    requireThat(amountKeys.has(key)||currency===null&&period===null,400,'非金额事实不能设置币种或周期。');
    const old=factsFor(record.id).find(f=>f.key===key);requireThat(factStatus!=='conflicting'||old?.sourceMessageIds.length,400,'标记冲突需要已有事实来源，并在理由中记录冲突内容。');
    transaction(()=>{const eventId=id();const message=addMessage(`advisor-correction-${record.id}`,record.id,'user',`顾问事实更正：${key}=${value??factStatus}；理由：${reason}`,eventId,eventId,false,true,'advisor',user.id);const fact:ProfileField={key,value:value as string|number|null,currency,period,factStatus,sourceMessageIds:factStatus==='conflicting'?[...new Set([...(old?.sourceMessageIds??[]),message.id])]:[message.id],confirmedBy:factStatus==='confirmed'?user.id:null,confirmedAt:factStatus==='confirmed'?now():null};saveFact(record.id,fact);record.status='needs_report';saveCase(record);audit(user.id,record.id,'fact.corrected',{key,reasonRecorded:true});});
    const report=await generateReport(record.id);return json({ok:true,version:report.version});
  }
  if(name==='submitReview'){const record=caseFor(user,str(input,'caseId'),true);requireThat(record.reportVersion>0&&record.status!=='needs_report',409,'请先生成当前报告。');record.assignedReviewerId='charles';record.status='pending_review';saveCase(record);audit(user.id,record.id,'review.submitted');return json({ok:true});}
  if(name==='review'){
    requireThat(user.role==='reviewer',403,'仅 Charles 可以复核。');const record=caseFor(user,str(input,'caseId'));const decision=str(input,'decision'),reason=str(input,'reason',2000);requireThat(['approved','returned','amended','quote_handoff'].includes(decision),400,'复核动作无效。');requireThat(reason,400,'请填写复核意见或修改理由。');requireThat(record.reportVersion>0&&record.status!=='needs_report',409,'请先由顾问生成当前报告。');
    const review:Review={id:id(),caseId:record.id,reportVersion:record.reportVersion,reviewerId:user.id,decision,reason,createdAt:now()};
    // A review creates a new immutable report version; advice is never a global rules change.
    const report=await generateReport(record.id,decision==='returned'?'returned':'reviewed',`${decision}：${reason}`);review.reportVersion=report.version;transaction(()=>{db().prepare('INSERT INTO reviews VALUES(?,?,?)').run(review.id,record.id,pack(review));if(decision==='quote_handoff'){const fresh=caseFor(user,record.id);fresh.status='quote_handoff';saveCase(fresh);}audit(user.id,record.id,'review.recorded',{decision,version:report.version});});return json({ok:true,version:report.version});
  }
  if(name==='approveSend'){
    const record=caseFor(user,str(input,'caseId'),true);const version=Number(input.version);requireThat(version===record.reportVersion&&record.status!=='needs_report',409,'报告已变化，请重新预览并确认。');
    const report=docs<ReportContent>('SELECT doc FROM reports WHERE case_id=? AND version=?',record.id,version)[0];requireThat(report&&input.snapshotId===report.snapshotId,409,'报告快照已变化。');requireThat(input.recipientFingerprint===recipientFingerprint(record),409,'收件人已变化，请重新预览并确认。');
    const settings=settingsFor(user);if(settings.mailMode!=='dry_run'){requireThat(settings.unreviewedSendPolicy==='allow'||report.reviewStatus==='reviewed',409,'未复核草稿发送政策待定或要求复核，禁止真实投递。');requireThat(recipientsFor(record).every(recipient=>recipient.verified&&!/\.example$|\.invalid$/.test(recipient.email)),409,'真实收件人尚未核验。');throw new AppError(409,'真实邮件服务尚未接入并验收。Demo 仅支持 dry-run 预览。');}
    const pdfRow=db().prepare('SELECT pdf FROM reports WHERE case_id=? AND version=?').get(record.id,version);requireThat(pdfRow?.pdf instanceof Uint8Array&&pdfRow.pdf.length>500&&report.fullText.length>200,409,'正文或 PDF 不完整，不能生成邮件任务。');
    transaction(()=>{let approval=db().prepare('SELECT id FROM approvals WHERE case_id=? AND report_version=? AND recipient_fingerprint=?').get(record.id,version,recipientFingerprint(record));if(!approval){const approvalId=id();db().prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)').run(approvalId,record.id,version,report.snapshotId,recipientFingerprint(record),user.id,now());approval={id:approvalId};}for(const recipient of recipientsFor(record)){const preview=new DryRunMailProvider().preview({idempotencyKey:`${record.id}:${version}:${recipient.email}`,recipient:recipient.email,recipientVerified:recipient.verified,body:report.fullText,pdf:pdfRow.pdf as Uint8Array,version,snapshotId:report.snapshotId,approvedSnapshotId:report.snapshotId,reviewed:report.reviewStatus==='reviewed',policy:settings.unreviewedSendPolicy});const job:NotificationJob={id:id(),caseId:record.id,reportVersion:version,recipient:preview.recipient,status:'dry_run',body:preview.body,attachmentUrl:`/api/report?caseId=${record.id}&version=${version}&format=pdf`,approvalId:String(approval.id),attempts:0,error:null};db().prepare('INSERT OR IGNORE INTO notification_jobs VALUES(?,?,?,?,?,?,?)').run(job.id,record.id,version,recipient.email,'full_report',job.approvalId,pack(job));}audit(user.id,record.id,'send.approved_dry_run',{version});});return json({ok:true});
  }
  if(name==='cancelSend'){const record=caseFor(user,str(input,'caseId'),true);audit(user.id,record.id,'send.cancelled',{version:record.reportVersion});return json({ok:true});}
  if(name==='retryNotification'){const job=docs<NotificationJob>('SELECT doc FROM notification_jobs WHERE id=?',str(input,'jobId'))[0];requireThat(job,404,'任务不存在。');caseFor(user,job.caseId,true);requireThat(job.status!=='unknown',409,'投递状态未知，需先向服务商对账，禁止盲目重发。');requireThat(!['accepted','delivered'].includes(job.status),409,'已接受或送达的目标不会重发。');requireThat(job.status==='dry_run',409,'真实投递尚未启用。');return json({ok:true});}
  if(name==='updateSettings'||name==='updateUserEmail'){
    requireThat(user.role==='admin',403,'仅管理员可修改配置。');
    if(name==='updateSettings'){const email=str(input,'companyEmail',254),policy=str(input,'unreviewedSendPolicy');requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&['pending','allow','reviewed_only'].includes(policy),400,'邮箱或发送政策无效。');const settings=settingsFor(user);settings.companyEmail=email;settings.companyVerified=input.companyVerified===true;settings.unreviewedSendPolicy=policy as Settings['unreviewedSendPolicy'];db().prepare('UPDATE organizations SET settings=? WHERE id=?').run(pack(settings),user.orgId);}
    else{const target=docs<User>('SELECT doc FROM users WHERE id=? AND org_id=?',str(input,'userId'),user.orgId)[0],email=str(input,'email',254).toLowerCase();requireThat(target&&target.role==='advisor'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),400,'请选择顾问并填写有效邮箱。');target.email=email;target.emailVerified=input.verified===true;db().prepare('UPDATE users SET email=?,doc=? WHERE id=?').run(email,pack(target),target.id);}audit(user.id,null,'settings.updated');return json({ok:true});
  }
  throw new AppError(400,'未知操作。');
}
function createCase(clientId:string,ownerId:string):Case {const createdAt=now(),client=docs<Client>('SELECT doc FROM clients WHERE id=?',clientId)[0];requireThat(client&&client.ownerAgentId===ownerId,403,'您无权为此客户建立案例。');const caseNumber=client.nextCaseNumber??0;client.nextCaseNumber=caseNumber+1;const record:Case={id:id(),clientId,ownerAgentId:ownerId,status:'new',entry:null,createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0,caseNumber};db().prepare('UPDATE clients SET doc=? WHERE id=?').run(pack(client),client.id);db().prepare('INSERT INTO cases(id,client_id,owner_id,reviewer_id,doc) VALUES(?,?,?,?,?)').run(record.id,clientId,ownerId,null,pack(record));return record;}
export function reportDownload(request:Request):Response {const auth=readAuth(request);requireThat(auth,401,'请先登录。');const user=requireAdvisorMode(auth),params=new URL(request.url).searchParams,record=caseFor(user,params.get('caseId')||'');const version=Number(params.get('version'));const row=db().prepare('SELECT doc,pdf FROM reports WHERE case_id=? AND version=?').get(record.id,version);requireThat(row,404,'报告不存在。');if(params.get('format')!=='pdf')return json(reportRecord(unpack<ReportContent>(row.doc),record));return new Response(new Uint8Array(row.pdf as Uint8Array),{headers:{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="aeconn-${record.id}-v${version}.pdf"`,'Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});}
export function notifications(request:Request):Response {const auth=readAuth(request);requireThat(auth,401,'请先登录。');const record=caseFor(requireAdvisorMode(auth),new URL(request.url).searchParams.get('caseId')||'');return json(docs<NotificationJob>('SELECT doc FROM notification_jobs WHERE case_id=?',record.id));}

export const voiceHooks={
  async getContext(sessionId:string){const session=db().prepare('SELECT * FROM interviews WHERE id=?').get(sessionId) as Interview|undefined;requireThat(session,404,'访谈不存在。');const input=interviewInput(session);const referenceKnowledge=await loadKnowledge(knowledgeQuery(input.entry,input.facts,input.messages));return JSON.stringify({...buildInterviewContext(input),referenceKnowledge});},
  consumeToken(token:string){return transaction(()=>{const row=db().prepare('SELECT * FROM voice_tokens WHERE token_hash=?').get(digest(token));if(!row)return null;db().prepare('DELETE FROM voice_tokens WHERE token_hash=?').run(digest(token));if(Number(row.expires_at)<Date.now())return null;const session=db().prepare("SELECT i.* FROM interviews i JOIN auth_sessions a ON a.id=i.auth_id WHERE i.id=? AND i.auth_id=? AND i.state='active' AND a.mode='client' AND a.active_interview=i.id AND a.expires_at>?").get(String(row.interview_id),String(row.auth_id),Date.now()) as Interview|undefined;return session?{sessionId:session.id,caseId:session.case_id}:null;});},
  isActive(sessionId:string){return !!db().prepare("SELECT i.id FROM interviews i JOIN auth_sessions a ON a.id=i.auth_id WHERE i.id=? AND i.state='active' AND a.mode='client' AND a.active_interview=i.id AND a.expires_at>?").get(sessionId,Date.now());},
  persist(sessionId:string,event:import('./voice-server').VoicePersistEvent){
    const session=db().prepare('SELECT * FROM interviews WHERE id=?').get(sessionId) as Interview|undefined;if(!session||!(session.state==='active'||['finishing','paused'].includes(session.state)&&Number(session.deadline)>Date.now())||!event.text?.trim())return;
    addMessage(sessionId,session.case_id,event.role,event.text.slice(0,8000),event.eventId,event.turnId,event.interrupted,event.final??true,'customer',undefined,event.role==='assistant'?{knowledge:event.knowledge}:undefined);
  },
  status(sessionId:string,state:string){if(state==='incomplete'||state==='transcript_incomplete'){db().prepare('UPDATE interviews SET incomplete=1 WHERE id=?').run(sessionId);return;}db().prepare("UPDATE interviews SET voice_state=? WHERE id=? AND state IN ('active','finishing','paused')").run(state,sessionId);},
  diagnostic(sessionId:string,event:VoiceDiagnosticEvent){
    const session=db().prepare('SELECT case_id FROM interviews WHERE id=?').get(sessionId) as {case_id?:unknown}|undefined;
    if(typeof session?.case_id!=='string')return;
    const action=event.stage==='preflight'||event.stage==='context'?'voice.start_failed':'voice.stopped';
    audit(null,session.case_id,action,{code:event.code,stage:event.stage,sessionId});
  }
};
