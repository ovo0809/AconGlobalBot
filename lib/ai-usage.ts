import { db, id, now, pack, transaction } from './db';

export type UsageOperation='interview'|'extraction'|'report'|'realtime';
export type UsageContext={caseId:string;sessionId?:string};
export type UsageOutcome='settled'|'unknown'|'released';
export type UsageEventKind='responses'|'realtime'|'transcription';
export type TranscriptionModel='whisper-1'|'gpt-4o-mini-transcribe';
export class UsageBudgetError extends Error {readonly code='AI_BUDGET_LIMIT';}
export class UsageDataError extends Error {readonly code='AI_USAGE_DATA';}
type UsageStatus='reserved'|UsageOutcome;
type UsageCallRow={id:string;org_id:string;case_id:string;session_id:string|null;model:string;transcription_model:TranscriptionModel;operation:UsageOperation;status:UsageStatus;reserved_micros:number;actual_micros:number;budget_day_utc:string;budget_month_utc:string;created_at:string;settled_at:string|null};
type ScopeSummary={costMicros:number;heldMicros:number;remainingMicros:number};
export type UsageSummary={
  estimatedNotBilled:boolean;
  rateCardVersion:string;
  limits:{caseMicros:number;dailyMicros:number;monthlyMicros:number};
  dayUtc:string;
  monthUtc:string;
  case:ScopeSummary|null;
  day:ScopeSummary;
  month:ScopeSummary;
  records:Array<{id:string;operation:UsageOperation;model:string;status:string;createdAt:string;costMicros:number;reservedMicros:number;inputTokens:number;outputTokens:number;cachedTokens:number;inputAudioTokens:number;outputAudioTokens:number;transcriptionSeconds:number}>;
};

const RATE_CARD_VERSION='openai-2026-10-28-whisper';
const DEFAULT_TEXT_RESERVATION_MICROS=50_000;
const MIN_REALTIME_RESERVATION_MICROS=50_000;
const MONEY_SCALE=1_000_000;
const MODEL_RATES={
  'gpt-6-luna':{input:0.10,cached:0.01,output:0.50},
  'gpt-realtime-2.1':{textInput:4,cached:0.40,audioInput:32,textOutput:24,audioOutput:64},
} as const;
const TRANSCRIPTION_RATES={
  'gpt-4o-mini-transcribe':{textInput:1.25,audioInput:1.25,output:5,durationPerMinute:0.003},
  'whisper-1':{durationPerMinute:0.006},
} as const;

function integer(value:unknown,name:string){
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new UsageDataError(`Invalid OpenAI usage field: ${name}.`);
  return value;
}
function object(value:unknown,name:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new UsageDataError(`Invalid OpenAI usage object: ${name}.`);
  return value as Record<string,unknown>;
}
function optionalObject(value:unknown,name:string){return value===undefined?{}:object(value,name);}
function optionalInteger(value:unknown,name:string){return value===undefined?0:integer(value,name);}
function dollarsLimit(name:string,fallback:number){
  const raw=process.env[name];
  if(raw===undefined||raw.trim()==='')return Math.round(fallback*MONEY_SCALE);
  const value=Number(raw);
  if(!Number.isFinite(value)||value<0)throw new UsageBudgetError('费用上限配置必须是有限的非负金额。');
  const scaled=Math.round(value*MONEY_SCALE);
  if(!Number.isSafeInteger(scaled))throw new UsageBudgetError('费用上限配置超出可支持范围。');
  return scaled;
}
function configuredLimits(){return {caseMicros:dollarsLimit('AI_CASE_BUDGET_USD',2),dailyMicros:dollarsLimit('AI_DAILY_BUDGET_USD',5),monthlyMicros:dollarsLimit('AI_MONTHLY_BUDGET_USD',20)};}
function utcBuckets(date=new Date()){const iso=date.toISOString();return {day:iso.slice(0,10),month:iso.slice(0,7)};}
function pending(row:UsageCallRow){return row.status==='reserved'||row.status==='unknown';}
function held(row:UsageCallRow){return pending(row)?Math.max(0,row.reserved_micros-row.actual_micros):0;}
function cost(row:UsageCallRow){return row.status==='released'?0:row.actual_micros;}
function rowsFor(orgId:string){return db().prepare('SELECT * FROM ai_usage_calls WHERE org_id=?').all(orgId) as unknown as UsageCallRow[];}
function periodCosts(orgId:string,period:'day'|'month',value:string){
  const length=period==='day'?10:7;
  const rows=db().prepare(`SELECT events.call_id,SUM(events.estimated_usd_micros) cost FROM ai_usage_events events JOIN ai_usage_calls calls ON calls.id=events.call_id WHERE calls.org_id=? AND substr(events.created_at,1,?)=? GROUP BY events.call_id`).all(orgId,length,value) as {call_id:string;cost:number}[];
  return new Map(rows.map(row=>[row.call_id,row.cost]));
}
function scope(rows:UsageCallRow[],limit:number,periodCost?:Map<string,number>){
  let costMicros=0,heldMicros=0;
  for(const row of rows){
    // Unresolved reservations remain a current-period hold after UTC day/month rollover.
    heldMicros+=held(row);
    // Known cost inside an unresolved call stays in the current guard after rollover.
    if(!periodCost||pending(row))costMicros+=cost(row);
    else if(row.status==='settled')costMicros+=periodCost.get(row.id)??0;
  }
  return {costMicros,heldMicros,remainingMicros:Math.max(0,limit-costMicros-heldMicros)};
}
function usageCall(callId:string){
  const row=db().prepare('SELECT * FROM ai_usage_calls WHERE id=?').get(callId) as unknown as UsageCallRow|undefined;
  if(!row)throw new UsageDataError('Usage reservation not found.');
  return row;
}
function validateModel(operation:UsageOperation,model:string){
  if(operation==='realtime'){
    if(model!=='gpt-realtime-2.1')throw new UsageBudgetError('所选实时语音模型没有已批准的费率表，已停止调用。');
  }else if(model!=='gpt-6-luna')throw new UsageBudgetError('所选文字模型没有已批准的费率表，已停止调用。');
}

export function beginUsage(input:{context:UsageContext;operation:UsageOperation;model:string;transcriptionModel?:TranscriptionModel;reserveMicros?:number}){
  validateModel(input.operation,input.model);
  const transcriptionModel=input.transcriptionModel??'gpt-4o-mini-transcribe';
  if(transcriptionModel!=='whisper-1'&&transcriptionModel!=='gpt-4o-mini-transcribe')throw new UsageBudgetError('所选语音转写模型没有已批准的费率表，已停止调用。');
  const requested=input.reserveMicros===undefined?null:integer(input.reserveMicros,'reserveMicros');
  if(requested===0)throw new UsageBudgetError('费用预留必须大于零。');
  return transaction(()=>{
    const identity=db().prepare('SELECT users.org_id FROM cases JOIN users ON users.id=cases.owner_id WHERE cases.id=?').get(input.context.caseId) as {org_id?:unknown}|undefined;
    if(typeof identity?.org_id!=='string')throw new UsageBudgetError('无法确认案例的费用归属，已停止调用。');
    const limits=configuredLimits(),buckets=utcBuckets(),all=rowsFor(identity.org_id);
    const caseScope=scope(all.filter(row=>row.case_id===input.context.caseId),limits.caseMicros);
    const dayScope=scope(all,limits.dailyMicros,periodCosts(identity.org_id,'day',buckets.day));
    const monthScope=scope(all,limits.monthlyMicros,periodCosts(identity.org_id,'month',buckets.month));
    const available=Math.min(caseScope.remainingMicros,dayScope.remainingMicros,monthScope.remainingMicros);
    const reservation=requested??(input.operation==='realtime'?available:DEFAULT_TEXT_RESERVATION_MICROS);
    if(reservation<=0||reservation>available||(input.operation==='realtime'&&reservation<MIN_REALTIME_RESERVATION_MICROS))throw new UsageBudgetError('已达到 OpenAI 应用费用上限。');
    const usageId=id(),createdAt=now();
    db().prepare('INSERT INTO ai_usage_calls(id,org_id,case_id,session_id,provider,model,transcription_model,operation,status,reserved_micros,actual_micros,budget_day_utc,budget_month_utc,rate_card_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(usageId,identity.org_id,input.context.caseId,input.context.sessionId??null,'openai',input.model,transcriptionModel,input.operation,'reserved',reservation,0,buckets.day,buckets.month,RATE_CARD_VERSION,createdAt);
    return {id:usageId,reservedMicros:reservation};
  });
}

function normalizedUsage(model:string,transcriptionModel:TranscriptionModel,kind:UsageEventKind,usage:unknown){
  const value=object(usage,'usage');
  let inputTokens=0,cachedInputTokens=0,outputTokens=0,inputTextTokens=0,inputAudioTokens=0,cachedTextTokens=0,cachedAudioTokens=0,outputTextTokens=0,outputAudioTokens=0,transcriptionMs=0,estimatedMicros=0;
  if(kind==='responses'){
    if(model!=='gpt-6-luna')throw new UsageDataError('Responses usage does not match the reserved model.');
    inputTokens=integer(value.input_tokens,'input_tokens');outputTokens=integer(value.output_tokens,'output_tokens');
    const details=optionalObject(value.input_tokens_details,'input_tokens_details');cachedInputTokens=optionalInteger(details.cached_tokens,'cached_tokens');
    if(cachedInputTokens>inputTokens)throw new UsageDataError('Cached input tokens exceed input tokens.');
    const rate=MODEL_RATES[model];estimatedMicros=Math.ceil((inputTokens-cachedInputTokens)*rate.input+cachedInputTokens*rate.cached+outputTokens*rate.output);
  }else if(kind==='realtime'){
    if(model!=='gpt-realtime-2.1')throw new UsageDataError('Realtime usage does not match the reserved model.');
    inputTokens=integer(value.input_tokens,'input_tokens');outputTokens=integer(value.output_tokens,'output_tokens');
    const inputDetails=object(value.input_token_details,'input_token_details'),outputDetails=object(value.output_token_details,'output_token_details');
    inputTextTokens=integer(inputDetails.text_tokens,'input_token_details.text_tokens');inputAudioTokens=integer(inputDetails.audio_tokens,'input_token_details.audio_tokens');cachedInputTokens=integer(inputDetails.cached_tokens,'input_token_details.cached_tokens');
    const cachedDetails=optionalObject(inputDetails.cached_tokens_details,'cached_tokens_details');cachedTextTokens=optionalInteger(cachedDetails.text_tokens,'cached_tokens_details.text_tokens');cachedAudioTokens=optionalInteger(cachedDetails.audio_tokens,'cached_tokens_details.audio_tokens');
    // If modality detail is absent, allocate cached tokens to text first. This leaves
    // more higher-priced audio uncached and therefore gives a conservative estimate.
    if(inputDetails.cached_tokens_details===undefined&&cachedInputTokens>0){cachedTextTokens=Math.min(cachedInputTokens,inputTextTokens);cachedAudioTokens=cachedInputTokens-cachedTextTokens;}
    if(cachedTextTokens>inputTextTokens||cachedAudioTokens>inputAudioTokens||cachedTextTokens+cachedAudioTokens!==cachedInputTokens)throw new UsageDataError('Realtime cached token details are inconsistent.');
    outputTextTokens=integer(outputDetails.text_tokens,'output_token_details.text_tokens');outputAudioTokens=integer(outputDetails.audio_tokens,'output_token_details.audio_tokens');
    if(inputTextTokens+inputAudioTokens!==inputTokens||outputTextTokens+outputAudioTokens!==outputTokens)throw new UsageDataError('Realtime token details are inconsistent.');
    const rate=MODEL_RATES[model];estimatedMicros=Math.ceil((inputTextTokens-cachedTextTokens)*rate.textInput+(inputAudioTokens-cachedAudioTokens)*rate.audioInput+cachedInputTokens*rate.cached+outputTextTokens*rate.textOutput+outputAudioTokens*rate.audioOutput);
  }else{
    if(value.type==='duration'){
      const seconds=value.seconds;if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0)throw new UsageDataError('Invalid transcription duration.');
      transcriptionMs=Math.round(seconds*1_000);estimatedMicros=Math.ceil(seconds/60*TRANSCRIPTION_RATES[transcriptionModel].durationPerMinute*MONEY_SCALE);
    }else if(value.type==='tokens'){
      if(transcriptionModel==='whisper-1')throw new UsageDataError('Whisper transcription usage requires duration in seconds.');
      const rate=TRANSCRIPTION_RATES[transcriptionModel];
      inputTokens=integer(value.input_tokens,'input_tokens');outputTokens=integer(value.output_tokens,'output_tokens');
      const details=object(value.input_token_details,'input_token_details');inputTextTokens=integer(details.text_tokens,'input_token_details.text_tokens');inputAudioTokens=integer(details.audio_tokens,'input_token_details.audio_tokens');
      if(inputTextTokens+inputAudioTokens!==inputTokens)throw new UsageDataError('Transcription input token details are inconsistent.');
      estimatedMicros=Math.ceil(inputTextTokens*rate.textInput+inputAudioTokens*rate.audioInput+outputTokens*rate.output);
    }else throw new UsageDataError('Invalid transcription usage type.');
  }
  return {inputTokens,cachedInputTokens,outputTokens,inputTextTokens,inputAudioTokens,cachedTextTokens,cachedAudioTokens,outputTextTokens,outputAudioTokens,transcriptionMs,estimatedMicros};
}

export function recordUsage(callId:string,eventKey:string,kind:UsageEventKind,usage:unknown,requestId?:string){
  const machineId=/^[A-Za-z0-9_.:-]{1,256}$/;
  if(!machineId.test(eventKey))throw new UsageDataError('Usage event key is invalid.');
  if(requestId!==undefined&&(typeof requestId!=='string'||!machineId.test(requestId)))throw new UsageDataError('Usage request ID is invalid.');
  return transaction(()=>{
    const row=usageCall(callId);
    if(db().prepare('SELECT id FROM ai_usage_events WHERE call_id=? AND event_key=?').get(callId,eventKey))return false;
    const event=normalizedUsage(row.model,row.transcription_model,kind,usage),eventId=id();
    const detail={inputTokens:event.inputTokens,cachedInputTokens:event.cachedInputTokens,outputTokens:event.outputTokens,inputTextTokens:event.inputTextTokens,inputAudioTokens:event.inputAudioTokens,cachedTextTokens:event.cachedTextTokens,cachedAudioTokens:event.cachedAudioTokens,outputTextTokens:event.outputTextTokens,outputAudioTokens:event.outputAudioTokens,transcriptionMs:event.transcriptionMs};
    const inserted=db().prepare('INSERT OR IGNORE INTO ai_usage_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(eventId,callId,eventKey,kind,requestId??null,event.inputTokens,event.cachedInputTokens,event.outputTokens,event.inputTextTokens,event.inputAudioTokens,event.cachedTextTokens,event.cachedAudioTokens,event.outputTextTokens,event.outputAudioTokens,event.transcriptionMs,event.estimatedMicros,pack(detail),now()).changes;
    if(!inserted)return false;
    const total=(db().prepare('SELECT COALESCE(SUM(estimated_usd_micros),0) total FROM ai_usage_events WHERE call_id=?').get(callId) as {total:number}).total;
    db().prepare("UPDATE ai_usage_calls SET actual_micros=?,status=CASE WHEN status='released' THEN 'unknown' ELSE status END,settled_at=CASE WHEN status='released' THEN ? ELSE settled_at END WHERE id=?").run(total,now(),callId);
    return true;
  });
}

export function completeUsage(callId:string,outcome:UsageOutcome){
  transaction(()=>{
    const row=usageCall(callId);
    if(row.status!=='reserved'){
      if(row.status===outcome)return;
      throw new UsageDataError('Usage reservation is already complete.');
    }
    if(outcome==='released'){
      const events=(db().prepare('SELECT COUNT(*) count FROM ai_usage_events WHERE call_id=?').get(callId) as {count:number}).count;
      if(events>0)throw new UsageDataError('已有可计费用量的调用不能释放费用预留。');
    }
    db().prepare('UPDATE ai_usage_calls SET status=?,settled_at=? WHERE id=?').run(outcome,now(),callId);
  });
}

export function getUsageProgress(callId:string){const row=usageCall(callId);return {costMicros:row.actual_micros,reservedMicros:row.reserved_micros};}

export function recoverUsageReservations(){return db().prepare("UPDATE ai_usage_calls SET status='unknown',settled_at=? WHERE status='reserved'").run(now()).changes;}

export function getUsageSummary(orgId:string,caseId?:string,includeRecords=false):UsageSummary{
  const limits=configuredLimits(),buckets=utcBuckets(),all=rowsFor(orgId);
  let caseSummary:ScopeSummary|null=null;
  if(caseId){
    const owner=db().prepare('SELECT users.org_id FROM cases JOIN users ON users.id=cases.owner_id WHERE cases.id=?').get(caseId) as {org_id?:unknown}|undefined;
    if(owner?.org_id!==orgId)throw new UsageBudgetError('无法确认案例的费用归属。');
    caseSummary=scope(all.filter(row=>row.case_id===caseId),limits.caseMicros);
  }
  const records=caseId&&includeRecords?(db().prepare(`SELECT calls.*,COALESCE(SUM(events.input_tokens),0) input_tokens,COALESCE(SUM(events.output_tokens),0) output_tokens,COALESCE(SUM(events.cached_input_tokens),0) cached_tokens,COALESCE(SUM(events.input_audio_tokens),0) input_audio_tokens,COALESCE(SUM(events.output_audio_tokens),0) output_audio_tokens,COALESCE(SUM(events.transcription_ms),0) transcription_ms FROM ai_usage_calls calls LEFT JOIN ai_usage_events events ON events.call_id=calls.id WHERE calls.org_id=? AND calls.case_id=? GROUP BY calls.id ORDER BY calls.created_at DESC LIMIT 50`).all(orgId,caseId) as Record<string,unknown>[]).map(row=>({
    id:String(row.id),operation:String(row.operation) as UsageOperation,model:String(row.model),status:String(row.status),createdAt:String(row.created_at),costMicros:Number(row.actual_micros),reservedMicros:Number(row.reserved_micros),inputTokens:Number(row.input_tokens),outputTokens:Number(row.output_tokens),cachedTokens:Number(row.cached_tokens),inputAudioTokens:Number(row.input_audio_tokens),outputAudioTokens:Number(row.output_audio_tokens),transcriptionSeconds:Number(row.transcription_ms)/1_000,
  })):[];
  return {estimatedNotBilled:true,rateCardVersion:RATE_CARD_VERSION,limits,dayUtc:buckets.day,monthUtc:buckets.month,case:caseSummary,day:scope(all,limits.dailyMicros,periodCosts(orgId,'day',buckets.day)),month:scope(all,limits.monthlyMicros,periodCosts(orgId,'month',buckets.month)),records};
}
