import { createHash, randomBytes } from 'node:crypto';
import { audit, checkPassword, db, docs, id, now, pack, transaction, unpack } from './db';
import { buildReport, renderPdf, validateAnalyses } from './report';
import { analyzeWithProvider } from './providers';
import { providerDisplayCapabilities } from './provider-config';
import { closeVoiceSession } from './voice-server';
import { DryRunMailProvider } from './mail';
import type { Bootstrap, Case, Category, Client, FactStatus, Message, NotificationJob, ProfileField, ReportContent, ReportRecord, Review, Settings, User } from './domain';

type Input=Record<string,unknown>;
type Auth={id:string;user_id:string|null;csrf:string;mode:string;active_case:string|null;active_interview:string|null;last_ended_case:string|null;expires_at:number};
type Interview={id:string;case_id:string;auth_id:string;state:string;entry:Category|null;current_question:string|null;deadline:number|null;incomplete:number;voice_state:string};
export class AppError extends Error {constructor(public status:number,message:string){super(message);}}
function requireThat(condition:unknown,status:number,message:string):asserts condition {if(!condition) throw new AppError(status,message);}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const str=(input:Input,key:string,max=5000)=>typeof input[key]==='string'?String(input[key]).trim().slice(0,max):'';
const categories:Category[]=['life','annuity','ltc','disability_income'];
const factStatuses:FactStatus[]=['confirmed','reported_unverified','unknown','declined','conflicting'];
const amountKeys=new Set(['income','expenses','debt','reserve','assets','budget']);
export const questions:Record<string,string>={goal:'您最希望解决什么问题？大约计划什么时候开始？',horizon:'这个目标的时间范围是多久？',dependents:'哪些家人依赖您的收入？如果收入停止，家庭有哪些责任？',state:'您目前居住在哪个州？',employment:'您目前从事什么工作？收入是否稳定？',income:'您的收入大约是多少？请说明币种，以及每月或每年。',expenses:'家庭支出大约是多少？请说明币种及每月或每年。',debt:'目前有哪些债务？如提供金额，请说明币种和一次性余额。',reserve:'紧急储备大约是多少？请说明币种和一次性金额。',assets:'可支配资产大约是多少？请说明币种和一次性金额。',existing_life:'目前有哪些人寿保障？您认为是否覆盖家庭责任？',existing_di:'目前有哪些收入中断或伤残保障？',existing_ltc:'目前有哪些长期照护保障或安排？',budget:'您愿意考虑的预算是多少？请说明币种及每月或每年。',liquidity:'您对随时取用资金有哪些需要？',retirement:'您有哪些退休收入来源、计划和时间安排？',care:'如果未来需要长期照护，谁可以协助？您主要担心什么？'};
const questionOrder=(entry:Category|null)=>{
  const first=entry==='annuity'?['goal','retirement','liquidity']:entry==='ltc'?['goal','care']:entry==='disability_income'?['goal','employment','income']:['goal','dependents','existing_life'];
  return [...new Set([...first,...Object.keys(questions)])];
};
const shared=globalThis as typeof globalThis & {aeconnReportLocks?:Map<string,Promise<ReportRecord>>;aeconnLoginAttempts?:Map<string,{count:number;until:number}>};
const locks=shared.aeconnReportLocks??=new Map();
const loginAttempts=shared.aeconnLoginAttempts??=new Map();

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
function caseFor(user:User,caseId:string,ownerOnly=false):Case {
  const record=docs<Case>('SELECT doc FROM cases WHERE id=?',caseId)[0];requireThat(record,404,'案例不存在。');
  const owner=docs<User>('SELECT doc FROM users WHERE id=?',record.ownerAgentId)[0];
  requireThat(owner?.orgId===user.orgId && (record.ownerAgentId===user.id && user.role==='advisor' || !ownerOnly && user.role==='reviewer' && record.assignedReviewerId===user.id),403,'您无权查看此案例。');return record;
}
function saveCase(record:Case){record.updatedAt=now();db().prepare('UPDATE cases SET reviewer_id=?,doc=? WHERE id=?').run(record.assignedReviewerId,pack(record),record.id);}
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
function addMessage(sessionId:string,caseId:string,role:'user'|'assistant',text:string,eventId=id(),turnId=eventId,interrupted=false):Message {
  const message:Message={id:id(),caseId,sessionId,role,text,final:true,eventId,turnId,interrupted,createdAt:now(),playbackStatus:interrupted?'interrupted':'unknown',correctionOf:null};
  db().prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)').run(message.id,caseId,sessionId,eventId,turnId,role,pack(message));
  return docs<Message>('SELECT doc FROM messages WHERE session_id=? AND (event_id=? OR turn_id=?) AND role=?',sessionId,eventId,turnId,role)[0];
}
function askNext(session:Interview){const facts=factsFor(session.case_id);const key=questionOrder(session.entry).find(key=>!facts.some(field=>field.key===key));db().prepare('UPDATE interviews SET current_question=? WHERE id=?').run(key??null,session.id);addMessage(session.id,session.case_id,'assistant',key?questions[key]:'谢谢，已保存您提供的情况。您可以补充遗漏的信息，或点击结束并将手机交还顾问。');}
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
  const base:ProfileField={key,value:text,currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:[messageId],confirmedBy:null,confirmedAt:null};
  if(/^(不知道|未知|不清楚|需要补充|unknown)$/i.test(text)) return {...base,value:null,factStatus:'unknown'};
  if(/^(不愿提供|不愿回答|拒答|跳过|declined)$/i.test(text)) return {...base,value:null,factStatus:'declined'};
  if(!amountKeys.has(key))return base;
  const amount=text.replace(/,/g,'').match(/(?<![\w.])-?\d+(?:\.\d+)?/);const currency=/USD|美元|美金|\$/i.test(text)?'USD':/CNY|人民币|元/i.test(text)?'CNY':/CAD|加元/i.test(text)?'CAD':/EUR|欧元/i.test(text)?'EUR':/HKD|港币/i.test(text)?'HKD':null;
  const period=/每月|月|month/i.test(text)?'month':/每年|年|year/i.test(text)?'year':/一次|余额|总额|once/i.test(text)?'once':null;
  if(!amount||!currency||!period||Number(amount[0])<0)return null;
  return {...base,value:Number(amount[0]),currency,period};
}

export function bootstrap(request:Request):Response {
  let auth=readAuth(request);let setCookie:string|undefined;if(!auth){const created=newAuth(request);auth=created.auth;setCookie=created.cookie;}
  const capabilities={...providerDisplayCapabilities(),mail:'dry-run（未发送）'};
  const data:Bootstrap={csrf:auth.csrf,mode:'anonymous',user:null,clients:[],cases:[],activeCase:null,messages:[],facts:[],reports:[],notifications:[],reviews:[],capabilities,demo:true};
  if(auth.user_id){const user=userFor(auth);
    if(auth.mode==='client'){
      const session=currentInterview(auth);data.mode='client';data.clientSession={id:session.id,state:session.state,entry:session.entry};
      data.activeCase={id:session.case_id,entry:session.entry,clientId:'',ownerAgentId:'',status:'interviewing',createdAt:'',updatedAt:'',assignedReviewerId:null,reportVersion:0};
      data.messages=messagesFor(session.case_id).filter(message=>message.sessionId===session.id);
    }else{
      data.mode='advisor';data.user=user;
      if(user.role==='admin'){data.settings=settingsFor(user);data.users=docs<User>('SELECT doc FROM users WHERE org_id=?',user.orgId);}
      else {
        data.cases=user.role==='advisor'?docs<Case>('SELECT doc FROM cases WHERE owner_id=? ORDER BY rowid DESC',user.id):docs<Case>('SELECT doc FROM cases WHERE reviewer_id=? ORDER BY rowid DESC',user.id);
        const clientIds=new Set(data.cases.map(record=>record.clientId));data.clients=docs<Client>('SELECT doc FROM clients').filter(client=>clientIds.has(client.id));
        data.cases=data.cases.map(record=>({...record,clientName:data.clients.find(client=>client.id===record.clientId)?.name}));
        const selected=new URL(request.url).searchParams.get('caseId')||auth.last_ended_case||data.cases[0]?.id;
        if(selected){data.activeCase=caseFor(user,selected);data.activeCase.clientName=data.clients.find(client=>client.id===data.activeCase?.clientId)?.name;data.messages=messagesFor(selected);data.facts=factsFor(selected);data.reports=docs<ReportContent>('SELECT doc FROM reports WHERE case_id=? ORDER BY version DESC',selected).map(content=>reportRecord(content,data.activeCase!));data.notifications=docs<NotificationJob>('SELECT doc FROM notification_jobs WHERE case_id=? ORDER BY rowid',selected);data.reviews=docs<Review>('SELECT doc FROM reviews WHERE case_id=? ORDER BY rowid',selected);}
      }
    }
  }
  return json(data,200,setCookie);
}
export function json(value:unknown,status=200,setCookie?:string):Response {const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Vary':'Cookie'};if(setCookie)headers['Set-Cookie']=setCookie;return new Response(JSON.stringify(value),{status,headers});}
export function errorResponse(error:unknown){return json({error:error instanceof AppError?error.message:'操作未完成。资料已保存，请重试；如反复出现，请查看不含客户资料的服务日志。'},error instanceof AppError?error.status:500);}

async function generateReport(caseId:string,reviewStatus='draft',reviewNote?:string):Promise<ReportRecord>{
  const existing=locks.get(caseId);if(existing){requireThat(!reviewNote,409,'另一份报告正在生成，请完成后再提交复核。');return existing;}
  const task=(async()=>{
    let record=docs<Case>('SELECT doc FROM cases WHERE id=?',caseId)[0];requireThat(record,404,'案例不存在。');
    requireThat(!db().prepare("SELECT id FROM interviews WHERE case_id=? AND state IN ('active','paused','finishing')").get(caseId),409,'请先结束访谈，等待转写收尾。');
    const owner=docs<User>('SELECT doc FROM users WHERE id=?',record.ownerAgentId)[0];const client=docs<Client>('SELECT doc FROM clients WHERE id=?',record.clientId)[0];
    const messages=messagesFor(caseId);let facts=factsFor(caseId);const incomplete=!!db().prepare('SELECT id FROM interviews WHERE case_id=? AND incomplete=1').get(caseId);
    const before=digest(pack({messages,facts}));
    const originalSnapshot=digest(pack({before,reviewStatus,reviewNote,rule:'demo_unapproved_v1'}));
    const prior=docs<ReportContent>('SELECT doc FROM reports WHERE case_id=? AND snapshot_id=?',caseId,originalSnapshot)[0];if(prior)return reportRecord(prior,record);
    const output=await analyzeWithProvider({messages,facts});const {analyses,provider}=output;
    requireThat(before===digest(pack({messages:messagesFor(caseId),facts:factsFor(caseId)})),409,'生成期间事实发生变化，请重新生成。');
    if(output.facts){for(const fact of output.facts)validateFact(fact,messages);const merged=new Map(facts.map(f=>[f.key,f]));for(const fact of output.facts){const old=merged.get(fact.key);if(!old||old.factStatus==='reported_unverified')merged.set(fact.key,{...fact,confirmedBy:null,confirmedAt:null,factStatus:fact.factStatus==='confirmed'?'reported_unverified':fact.factStatus});}facts=[...merged.values()];}
    validateAnalyses(analyses,facts,messages);
    const snapshotId=digest(pack({before:digest(pack({messages,facts})),reviewStatus,reviewNote,rule:'demo_unapproved_v1'}));
    record=docs<Case>('SELECT doc FROM cases WHERE id=?',caseId)[0];const version=record.reportVersion+1;
    const report=buildReport({client,owner,caseRecord:record,version,snapshotId,reviewStatus,createdAt:now(),facts,messages,analyses,incompleteTranscript:incomplete,provider,reviewNote});const pdf=await renderPdf(report);
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
    const created=newAuth(request,String(row.id));db().prepare('UPDATE auth_sessions SET expires_at=0 WHERE id=?').run(auth.id);audit(String(row.id),null,'auth.login');return json({ok:true},200,created.cookie);
  }
  const user=userFor(auth);
  if(auth.mode==='client')requireThat(['chooseEntry','message','pause','resume','end','voiceToken'].includes(name),403,'客户模式期间禁止内部操作。');
  if(name==='logout') {requireAdvisorMode(auth);db().prepare('UPDATE auth_sessions SET expires_at=0 WHERE id=?').run(auth.id);return json({ok:true},200,'aeconn_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');}
  if(name==='end'){
    if(auth.mode==='advisor'&&auth.last_ended_case){if(input.caseId)requireThat(input.caseId===auth.last_ended_case,409,'结束案例不匹配。');caseFor(user,auth.last_ended_case,true);return json({ok:true,caseId:auth.last_ended_case});}
    const session=currentInterview(auth);if(input.caseId)requireThat(input.caseId===session.case_id,403,'案例范围不匹配。');
    transaction(()=>{db().prepare("UPDATE interviews SET state='finishing',deadline=? WHERE id=?").run(Date.now()+1700,session.id);db().prepare("UPDATE auth_sessions SET mode='advisor',last_ended_case=active_case,active_case=NULL,active_interview=NULL WHERE id=?").run(auth.id);db().prepare('DELETE FROM voice_tokens WHERE interview_id=?').run(session.id);});
    await closeVoiceSession(session.id);
    db().prepare("UPDATE interviews SET state='ended',ended_at=?,voice_state='ended' WHERE id=?").run(now(),session.id);const record=caseFor(user,session.case_id,true);record.status='needs_report';saveCase(record);audit(user.id,record.id,'interview.ended');return json({ok:true,caseId:record.id});
  }
  if(['chooseEntry','message','pause','resume','voiceToken'].includes(name)){
    const session=currentInterview(auth);if(input.caseId)requireThat(input.caseId===session.case_id,403,'案例范围不匹配。');
    if(name==='chooseEntry'){requireThat(session.state==='active'&&!session.entry,409,'入口已选定。');const entry=str(input,'entry') as Category;requireThat(categories.includes(entry),400,'请选择四个入口之一。');db().prepare('UPDATE interviews SET entry=? WHERE id=?').run(entry,session.id);const record=caseFor(user,session.case_id,true);record.entry=entry;saveCase(record);session.entry=entry;askNext(session);}
    if(name==='message'){
      requireThat(session.state==='active'&&session.entry,409,'请先选择入口并恢复访谈。');const text=str(input,'text',4000),eventId=str(input,'eventId',100);requireThat(text&&eventId,400,'消息及事件编号不能为空。');
      if(!db().prepare("SELECT id FROM messages WHERE session_id=? AND event_id=? AND role='user'").get(session.id,eventId)){
        transaction(()=>{const message=addMessage(session.id,session.case_id,'user',text,eventId);if(session.current_question){const fact=parseAnswer(session.current_question,text,message.id);if(fact){saveFact(session.case_id,fact);askNext(session);}else addMessage(session.id,session.case_id,'assistant','请确认金额、币种和月／年／一次性周期，例如“5000 美元 每月”。也可以回答“不知道”或“不愿提供”。');}else addMessage(session.id,session.case_id,'assistant','已保存补充。顾问会在内部复核，您可以继续补充或结束访谈。');});
      }
    }
    if(name==='pause'){db().prepare("UPDATE interviews SET state='paused',voice_state='ended',deadline=? WHERE id=?").run(Date.now()+1700,session.id);await closeVoiceSession(session.id);db().prepare('UPDATE interviews SET deadline=NULL WHERE id=?').run(session.id);}
    if(name==='resume'){db().prepare("UPDATE interviews SET state='active' WHERE id=?").run(session.id);}
    if(name==='voiceToken'){requireThat(session.state==='active'&&session.entry,409,'请先选择入口并恢复访谈。');requireThat(providerDisplayCapabilities().voiceConfigured,409,'实时语音未配置，可继续文字访谈或明确标记的模拟演示。');const token=randomBytes(32).toString('hex');db().prepare('INSERT INTO voice_tokens VALUES(?,?,?,?)').run(digest(token),session.id,auth.id,Date.now()+30_000);return json({ok:true,token});}
    return json({ok:true});
  }
  requireAdvisorMode(auth);
  if(name==='createClient'){
    requireThat(user.role==='advisor',403,'仅顾问可以建档。');const nameValue=str(input,'name',100),birthday=str(input,'birthday',10),gender=str(input,'gender',40),phone=str(input,'phone',40),email=str(input,'email',254),maritalStatus=str(input,'maritalStatus',40);
    requireThat(nameValue&&gender&&maritalStatus&&/^\d{4}-\d{2}-\d{2}$/.test(birthday)&&Number.isFinite(Date.parse(birthday))&&new Date(birthday).toISOString().slice(0,10)===birthday&&birthday>='1900-01-01'&&birthday<=now().slice(0,10),400,'请完整填写姓名、有效生日、性别和婚姻状态。');requireThat(/^\+?[\d\s()-]{7,25}$/.test(phone)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),400,'请填写有效电话号码与邮箱。');
    const client:Client={id:id(),name:nameValue,birthday,gender,phone,email,maritalStatus,state:str(input,'state',80),language:str(input,'language',50)||'普通话',ownerAgentId:user.id,consentStatus:'purpose_explained_demo',createdAt:now()};
    const caseRecord=transaction(()=>{db().prepare('INSERT INTO clients VALUES(?,?,?)').run(client.id,user.id,pack(client));return createCase(client.id,user.id);});audit(user.id,caseRecord.id,'client.created');return json({ok:true,clientId:client.id,caseId:caseRecord.id});
  }
  if(name==='createCase'){const client=docs<Client>('SELECT doc FROM clients WHERE id=?',str(input,'clientId'))[0];requireThat(user.role==='advisor'&&client?.ownerAgentId===user.id,403,'无权为此客户创建访谈。');return json({ok:true,caseId:createCase(client.id,user.id).id});}
  if(name==='enterClient'){
    const record=caseFor(user,str(input,'caseId'),true);requireThat(!db().prepare("SELECT id FROM interviews WHERE case_id=? AND state IN ('active','paused','finishing')").get(record.id),409,'此案例已有进行中的访谈。请回到原设备结束，或新建一次访谈。');requireThat(record.reportVersion===0,409,'已有报告的案例请新建访谈，以保留历史。');
    const sessionId=id();transaction(()=>{db().prepare("INSERT INTO interviews(id,case_id,auth_id,state,created_at) VALUES(?,?,?,'active',?)").run(sessionId,record.id,auth.id,now());db().prepare("UPDATE auth_sessions SET mode='client',active_case=?,active_interview=?,last_ended_case=NULL WHERE id=?").run(record.id,sessionId,auth.id);record.status='interviewing';saveCase(record);});audit(user.id,record.id,'client_mode.entered');return json({ok:true,caseId:record.id});
  }
  if(name==='generateReport'){const record=caseFor(user,str(input,'caseId'),true);const report=await generateReport(record.id);return json({ok:true,version:report.version});}
  if(name==='updateFact'){
    const record=caseFor(user,str(input,'caseId'));requireThat(!locks.has(record.id),409,'报告正在生成，请稍后修改。');requireThat(!db().prepare("SELECT id FROM interviews WHERE case_id=? AND state IN ('active','paused','finishing')").get(record.id),409,'请先结束访谈再更正事实。');const key=str(input,'key',60),reason=str(input,'reason',2000),factStatus=str(input,'factStatus') as FactStatus;requireThat(reason,400,'请填写更正理由。');
    const value=['unknown','declined'].includes(factStatus)?null:input.value;requireThat(value===null||typeof value==='string'||typeof value==='number',400,'事实值格式无效。');
    transaction(()=>{const message=addMessage(`advisor-correction-${record.id}`,record.id,'user',`顾问事实更正：${key}=${value??factStatus}；理由：${reason}`);const fact:ProfileField={key,value:value as string|number|null,currency:str(input,'currency',3)||null,period:str(input,'period',10)||null,factStatus,sourceMessageIds:[message.id],confirmedBy:factStatus==='confirmed'?user.id:null,confirmedAt:factStatus==='confirmed'?now():null};saveFact(record.id,fact);record.status='needs_report';saveCase(record);audit(user.id,record.id,'fact.corrected',{key,reasonRecorded:true});});
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
function createCase(clientId:string,ownerId:string):Case {const createdAt=now();const record:Case={id:id(),clientId,ownerAgentId:ownerId,status:'new',entry:null,createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0};db().prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(record.id,clientId,ownerId,null,pack(record));return record;}
export function reportDownload(request:Request):Response {const auth=readAuth(request);requireThat(auth,401,'请先登录。');const user=requireAdvisorMode(auth),params=new URL(request.url).searchParams,record=caseFor(user,params.get('caseId')||'');const version=Number(params.get('version'));const row=db().prepare('SELECT doc,pdf FROM reports WHERE case_id=? AND version=?').get(record.id,version);requireThat(row,404,'报告不存在。');if(params.get('format')!=='pdf')return json(reportRecord(unpack<ReportContent>(row.doc),record));return new Response(new Uint8Array(row.pdf as Uint8Array),{headers:{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="aeconn-${record.id}-v${version}.pdf"`,'Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});}
export function notifications(request:Request):Response {const auth=readAuth(request);requireThat(auth,401,'请先登录。');const record=caseFor(requireAdvisorMode(auth),new URL(request.url).searchParams.get('caseId')||'');return json(docs<NotificationJob>('SELECT doc FROM notification_jobs WHERE case_id=?',record.id));}

export const voiceHooks={
  consumeToken(token:string){return transaction(()=>{const row=db().prepare('SELECT * FROM voice_tokens WHERE token_hash=?').get(digest(token));if(!row)return null;db().prepare('DELETE FROM voice_tokens WHERE token_hash=?').run(digest(token));if(Number(row.expires_at)<Date.now())return null;const session=db().prepare("SELECT i.* FROM interviews i JOIN auth_sessions a ON a.id=i.auth_id WHERE i.id=? AND i.auth_id=? AND i.state='active' AND a.mode='client' AND a.active_interview=i.id AND a.expires_at>?").get(String(row.interview_id),String(row.auth_id),Date.now()) as Interview|undefined;return session?{sessionId:session.id,caseId:session.case_id}:null;});},
  isActive(sessionId:string){return !!db().prepare("SELECT i.id FROM interviews i JOIN auth_sessions a ON a.id=i.auth_id WHERE i.id=? AND i.state='active' AND a.mode='client' AND a.active_interview=i.id AND a.expires_at>?").get(sessionId,Date.now());},
  persist(sessionId:string,event:{eventId:string;turnId:string;role:'user'|'assistant';text:string;interrupted?:boolean}){
    const session=db().prepare('SELECT * FROM interviews WHERE id=?').get(sessionId) as Interview|undefined;if(!session||!(session.state==='active'||['finishing','paused'].includes(session.state)&&Number(session.deadline)>Date.now())||!event.text?.trim())return;
    addMessage(sessionId,session.case_id,event.role,event.text.slice(0,8000),event.eventId,event.turnId,event.interrupted);
  },
  status(sessionId:string,state:string){if(state==='incomplete'||state==='transcript_incomplete'){db().prepare('UPDATE interviews SET incomplete=1 WHERE id=?').run(sessionId);return;}db().prepare("UPDATE interviews SET voice_state=? WHERE id=? AND state IN ('active','finishing','paused')").run(state,sessionId);}
};
