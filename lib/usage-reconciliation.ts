import { createHash } from 'node:crypto';
import { db, id, now, pack, transaction, unpack } from './db';
import { getUsageSummary, UsageDataError } from './ai-usage';
import type { User } from './domain';
import type { ManualSettlementCommitInput, ManualSettlementInput, ManualSettlementPreview, ReconciliationHistoryItem, ReconciliationOverview } from './usage-reconciliation-types';

type CallRow={id:string;org_id:string;operation:string;model:string;status:string;reserved_micros:number;actual_micros:number;created_at:string;settled_at:string|null};
type HistoryRow={id:string;request_id:string;call_id:string;org_id:string;actor_id:string|null;method:'manual'|'automatic';recorded_micros:number;confirmed_micros:number;accounted_micros:number;released_micros:number;evidence_ref:string;note:string;call_version:string;payload_hash:string;created_at:string};
type ReceiptRow={call_id:string;outcome:'settled'|'released';usage_fingerprint:string;created_at:string};

const hash=(value:unknown)=>createHash('sha256').update(pack(value)).digest('hex');
const machineId=/^[A-Za-z0-9_.:-]{1,128}$/;

function callFor(callId:string):CallRow {
  const row=db().prepare('SELECT id,org_id,operation,model,status,reserved_micros,actual_micros,created_at,settled_at FROM ai_usage_calls WHERE id=?').get(callId) as CallRow|undefined;
  if(!row)throw new UsageDataError('待核对调用不存在。');
  return row;
}

function usageEvidence(callId:string){
  const events=db().prepare(`SELECT event_key,kind,COALESCE(request_id,''),input_tokens,cached_input_tokens,output_tokens,input_text_tokens,input_audio_tokens,cached_text_tokens,cached_audio_tokens,output_text_tokens,output_audio_tokens,transcription_ms,estimated_usd_micros,created_at
    FROM ai_usage_events WHERE call_id=? ORDER BY id`).all(callId);
  const adjustments=db().prepare('SELECT amount_micros,charge_day_utc,created_at FROM ai_usage_adjustments WHERE call_id=? ORDER BY id').all(callId);
  return {events,adjustments};
}

function usageFingerprint(row:CallRow){
  const evidence=usageEvidence(row.id);
  return hash({id:row.id,orgId:row.org_id,reservedMicros:row.reserved_micros,actualMicros:row.actual_micros,evidence});
}

function callVersion(row:CallRow){
  return hash({usage:usageFingerprint(row),status:row.status,closedAt:row.settled_at,reconciliations:Number((db().prepare('SELECT COUNT(*) count FROM ai_usage_reconciliations WHERE call_id=?').get(row.id) as {count:number}).count)});
}

function eventCount(callId:string){return Number((db().prepare('SELECT COUNT(*) count FROM ai_usage_events WHERE call_id=?').get(callId) as {count:number}).count);}

function validateAdmin(orgId:string,actorId:string){
  const row=db().prepare('SELECT org_id,doc FROM users WHERE id=?').get(actorId) as {org_id:string;doc:string}|undefined;
  if(!row||row.org_id!==orgId)throw new UsageDataError('结算操作人与组织不匹配。');
  const user=unpack<User>(row.doc);
  if(user.role!=='admin')throw new UsageDataError('仅管理员可以人工结算待核对调用。');
}

function exactUsd(value:string){
  if(typeof value!=='string'||! /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value))throw new UsageDataError('确认金额必须是最多六位小数的非负美元金额。');
  const [whole,fraction='']=value.split('.');
  const micros=Number(whole)*1_000_000+Number(fraction.padEnd(6,'0'));
  if(!Number.isSafeInteger(micros))throw new UsageDataError('确认金额超出可支持范围。');
  return micros;
}

function settlementFields(input:ManualSettlementInput){
  if(typeof input.orgId!=='string'||typeof input.actorId!=='string'||typeof input.callId!=='string'||typeof input.version!=='string'||typeof input.amountUsd!=='string'||typeof input.evidenceRef!=='string'||typeof input.note!=='string')throw new UsageDataError('人工结算输入格式无效。');
  validateAdmin(input.orgId,input.actorId);
  if(input.evidenceRef.trim().length<4||input.evidenceRef.trim().length>500)throw new UsageDataError('请填写可追溯的核对凭据。');
  if(input.note.trim().length<8||input.note.trim().length>1000)throw new UsageDataError('请填写至少八个字符的结算说明。');
  const row=callFor(input.callId);
  if(row.org_id!==input.orgId)throw new UsageDataError('待核对调用不属于当前组织。');
  if(row.status!=='unknown')throw new UsageDataError(row.status==='reserved'?'进行中的调用不能结算。':'该调用已经完成结算。');
  const version=callVersion(row);
  if(input.version!==version)throw new UsageDataError('调用记录已变化，请刷新后重新预览结算。');
  const confirmedMicros=exactUsd(input.amountUsd),recordedMicros=Number(row.actual_micros);
  if(confirmedMicros<recordedMicros)throw new UsageDataError('确认金额低于本地已记录用量，需先核对差异，不能释放预留。');
  return {row,version,recordedMicros,confirmedMicros,accountedMicros:confirmedMicros,releasedMicros:Math.max(0,Number(row.reserved_micros)-confirmedMicros),evidenceRef:input.evidenceRef.trim(),note:input.note.trim()};
}

function previewResult(fields:ReturnType<typeof settlementFields>):ManualSettlementPreview {
  return {callId:fields.row.id,version:fields.version,recordedMicros:fields.recordedMicros,confirmedMicros:fields.confirmedMicros,accountedMicros:fields.accountedMicros,releasedMicros:fields.releasedMicros,evidenceRef:fields.evidenceRef,note:fields.note};
}

function historyItem(row:HistoryRow):ReconciliationHistoryItem {
  return {id:row.id,callId:row.call_id,method:row.method,recordedMicros:Number(row.recorded_micros),confirmedMicros:Number(row.confirmed_micros),accountedMicros:Number(row.accounted_micros),releasedMicros:Number(row.released_micros),evidenceRef:row.evidence_ref,note:row.note,createdAt:row.created_at,actorId:row.actor_id};
}

export function previewManualSettlement(input:ManualSettlementInput):ManualSettlementPreview {return previewResult(settlementFields(input));}

export function settleManualUsage(input:ManualSettlementCommitInput):ManualSettlementPreview {
  if(!input||typeof input!=='object')throw new UsageDataError('人工结算输入格式无效。');
  if(input.confirmed!==true)throw new UsageDataError('请先确认结算预览。');
  if(typeof input.requestId!=='string'||!machineId.test(input.requestId))throw new UsageDataError('结算请求编号无效。');
  if(typeof input.orgId!=='string'||typeof input.actorId!=='string'||typeof input.callId!=='string'||typeof input.version!=='string'||typeof input.amountUsd!=='string'||typeof input.evidenceRef!=='string'||typeof input.note!=='string')throw new UsageDataError('人工结算输入格式无效。');
  validateAdmin(input.orgId,input.actorId);
  const normalized={orgId:input.orgId,actorId:input.actorId,callId:input.callId,version:input.version,amountUsd:input.amountUsd,evidenceRef:input.evidenceRef.trim(),note:input.note.trim(),confirmed:true};
  const payloadHash=hash(normalized);
  return transaction(()=>{
    const prior=db().prepare('SELECT * FROM ai_usage_reconciliations WHERE request_id=?').get(input.requestId) as HistoryRow|undefined;
    if(prior){
      if(prior.payload_hash!==payloadHash)throw new UsageDataError('结算请求编号已用于不同内容。');
      return {callId:prior.call_id,version:prior.call_version,recordedMicros:Number(prior.recorded_micros),confirmedMicros:Number(prior.confirmed_micros),accountedMicros:Number(prior.accounted_micros),releasedMicros:Number(prior.released_micros),evidenceRef:prior.evidence_ref,note:prior.note};
    }
    const fields=settlementFields(input),reconciliationId=id(),createdAt=now();
    db().prepare(`INSERT INTO ai_usage_reconciliations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(reconciliationId,input.requestId,fields.row.id,input.orgId,input.actorId,'manual',fields.recordedMicros,fields.confirmedMicros,fields.accountedMicros,fields.releasedMicros,fields.evidenceRef,fields.note,fields.version,payloadHash,createdAt);
    const eventTotal=Number((db().prepare('SELECT COALESCE(SUM(estimated_usd_micros),0) total FROM ai_usage_events WHERE call_id=?').get(fields.row.id) as {total:number}).total),adjustment=fields.accountedMicros-eventTotal;
    if(!Number.isSafeInteger(eventTotal)||eventTotal<0||!Number.isSafeInteger(adjustment)||adjustment<0)throw new UsageDataError('费用账本汇总超出可支持范围。');
    // Replace the prior derived gap. Reconciliation history stays immutable and
    // records every decision, while only the latest effective total affects spend.
    db().prepare('DELETE FROM ai_usage_adjustments WHERE call_id=?').run(fields.row.id);
    if(adjustment>0)db().prepare('INSERT INTO ai_usage_adjustments VALUES(?,?,?,?,?,?)').run(id(),fields.row.id,reconciliationId,adjustment,fields.row.created_at.slice(0,10),createdAt);
    db().prepare("UPDATE ai_usage_calls SET actual_micros=?,status='settled',settled_at=? WHERE id=? AND status='unknown'").run(fields.accountedMicros,createdAt,fields.row.id);
    db().prepare('DELETE FROM ai_usage_completion_receipts WHERE call_id=?').run(fields.row.id);
    return previewResult(fields);
  });
}

export function recordUsageCompletion(callId:string,outcome:'settled'|'released'){
  return transaction(()=>{
    const row=callFor(callId);
    if(row.status!=='reserved')throw new UsageDataError('只有进行中的调用可以记录完成凭据。');
    const count=eventCount(callId);
    if(outcome==='released'&&(count>0||row.actual_micros>0))throw new UsageDataError('已有用量的调用不能记录为零费用释放。');
    if(outcome==='settled'&&count===0)throw new UsageDataError('缺少完整 provider usage，不能记录自动结算凭据。');
    const fingerprint=usageFingerprint(row),prior=db().prepare('SELECT * FROM ai_usage_completion_receipts WHERE call_id=?').get(callId) as ReceiptRow|undefined;
    if(prior){if(prior.outcome!==outcome||prior.usage_fingerprint!==fingerprint)throw new UsageDataError('调用完成凭据与既有记录冲突。');return false;}
    db().prepare('INSERT INTO ai_usage_completion_receipts VALUES(?,?,?,?)').run(callId,outcome,fingerprint,now());return true;
  });
}

export function reconcilePendingUsage(orgId?:string){
  const rows=db().prepare(`SELECT calls.*,receipts.outcome receipt_outcome,receipts.usage_fingerprint receipt_fingerprint
    FROM ai_usage_calls calls JOIN ai_usage_completion_receipts receipts ON receipts.call_id=calls.id
    WHERE calls.status='unknown' ${orgId?'AND calls.org_id=?':''} ORDER BY calls.created_at`).all(...(orgId?[orgId]:[])) as Array<CallRow&{receipt_outcome:'settled'|'released';receipt_fingerprint:string}>;
  let reconciled=0;
  for(const candidate of rows){
    transaction(()=>{
      const row=callFor(candidate.id),receipt=db().prepare('SELECT * FROM ai_usage_completion_receipts WHERE call_id=?').get(row.id) as ReceiptRow|undefined;
      if(row.status!=='unknown'||!receipt||receipt.usage_fingerprint!==usageFingerprint(row))return;
      const count=eventCount(row.id);
      if(receipt.outcome==='released'&&(count>0||row.actual_micros>0))return;
      if(receipt.outcome==='settled'&&count===0)return;
      const recordedMicros=Number(row.actual_micros),releasedMicros=Math.max(0,Number(row.reserved_micros)-recordedMicros),createdAt=now();
      const requestId=`auto:${row.id}:${receipt.usage_fingerprint}`,payloadHash=hash({callId:row.id,outcome:receipt.outcome,fingerprint:receipt.usage_fingerprint});
      const prior=db().prepare('SELECT id FROM ai_usage_reconciliations WHERE request_id=?').get(requestId);
      if(!prior)db().prepare('INSERT INTO ai_usage_reconciliations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id(),requestId,row.id,row.org_id,null,'automatic',recordedMicros,recordedMicros,recordedMicros,releasedMicros,`server-completion:${receipt.usage_fingerprint.slice(0,16)}`,'服务端已在调用关闭前保存完整用量完成凭据。',callVersion(row),payloadHash,createdAt);
      db().prepare('UPDATE ai_usage_calls SET status=?,settled_at=? WHERE id=? AND status=?').run(receipt.outcome,createdAt,row.id,'unknown');
      reconciled+=1;
    });
  }
  return reconciled;
}

export function getReconciliationOverview(orgId:string):ReconciliationOverview {
  const calls=db().prepare("SELECT id,org_id,operation,model,status,reserved_micros,actual_micros,created_at,settled_at FROM ai_usage_calls WHERE org_id=? AND status IN ('unknown','reserved') ORDER BY created_at").all(orgId) as CallRow[];
  const pending=calls.map(row=>{
    const receipt=db().prepare('SELECT * FROM ai_usage_completion_receipts WHERE call_id=?').get(row.id) as ReceiptRow|undefined;
    return {id:row.id,operation:row.operation,model:row.model,createdAt:row.created_at,closedAt:row.settled_at,status:row.status as 'unknown'|'reserved',recordedMicros:Number(row.actual_micros),reservedMicros:Number(row.reserved_micros),heldMicros:Math.max(0,Number(row.reserved_micros)-Number(row.actual_micros)),version:callVersion(row),automaticReady:row.status==='unknown'&&Boolean(receipt&&receipt.usage_fingerprint===usageFingerprint(row))};
  });
  const rows=db().prepare('SELECT * FROM ai_usage_reconciliations WHERE org_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(orgId) as HistoryRow[];
  return {limits:getUsageSummary(orgId).limits,pending,history:rows.map(historyItem)};
}
