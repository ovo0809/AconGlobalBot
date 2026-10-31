import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'aeconn-reconciliation-')),'reconciliation.sqlite');
process.env.AI_CASE_BUDGET_USD='8';
process.env.AI_DAILY_BUDGET_USD='40';
process.env.AI_MONTHLY_BUDGET_USD='160';

const usagePromise=import('../lib/ai-usage');
const reconciliationPromise=import('../lib/usage-reconciliation');
const dbPromise=import('../lib/db');

const responseUsage=(input=1_000,output=100)=>({input_tokens:input,output_tokens:output,input_tokens_details:{cached_tokens:0}});

test('manual settlement previews exact release, commits atomically, and is idempotent',async()=>{
  const usage=await usagePromise,reconciliation=await reconciliationPromise,{db}=await dbPromise;
  const call=usage.beginUsage({context:{caseId:'case-1'},operation:'interview',model:'gpt-6-luna',reserveMicros:1_000_000});
  usage.recordUsage(call.id,'manual-event','responses',responseUsage());usage.completeUsage(call.id,'unknown');
  const overview=reconciliation.getReconciliationOverview('org-demo'),pending=overview.pending.find(item=>item.id===call.id)!;
  assert.equal('caseId' in pending,false);assert.equal('sessionId' in pending,false);
  const input={orgId:'org-demo',actorId:'admin',callId:call.id,version:pending.version,amountUsd:'0.000300',evidenceRef:'OpenAI usage export row 18',note:'已核对官方导出中的对应调用金额。'};
  assert.deepEqual(reconciliation.previewManualSettlement(input),{callId:call.id,version:pending.version,recordedMicros:150,confirmedMicros:300,accountedMicros:300,releasedMicros:999_700,evidenceRef:input.evidenceRef,note:input.note});
  const committed=reconciliation.settleManualUsage({...input,requestId:'manual-request-1',confirmed:true});
  assert.deepEqual(reconciliation.settleManualUsage({...input,requestId:'manual-request-1',confirmed:true}),committed);
  assert.throws(()=>reconciliation.settleManualUsage({...input,amountUsd:'0.000301',requestId:'manual-request-1',confirmed:true}),/不同内容/);
  const adminRow=db().prepare('SELECT doc FROM users WHERE id=?').get('admin') as {doc:string};
  db().prepare("UPDATE users SET doc=json_set(doc,'$.role','advisor') WHERE id=?").run('admin');
  assert.throws(()=>reconciliation.settleManualUsage({...input,requestId:'manual-request-1',confirmed:true}),/仅管理员/,'idempotent replay still requires current admin authority');
  db().prepare('UPDATE users SET doc=? WHERE id=?').run(adminRow.doc,'admin');
  assert.throws(()=>reconciliation.settleManualUsage({...input,requestId:4 as never,confirmed:true}),/请求编号无效/);
  assert.throws(()=>reconciliation.previewManualSettlement({...input,evidenceRef:null as never}),/输入格式无效/);
  const row=db().prepare('SELECT status,actual_micros,reserved_micros FROM ai_usage_calls WHERE id=?').get(call.id) as Record<string,number|string>;
  assert.deepEqual({...row},{status:'settled',actual_micros:300,reserved_micros:1_000_000});
  const after=reconciliation.getReconciliationOverview('org-demo');assert.equal(after.pending.some(item=>item.id===call.id),false);
  assert.equal(after.history[0].releasedMicros,999_700);assert.equal(after.history[0].actorId,'admin');
});

test('manual settlement rejects active, stale, under-recorded, cross-org, and non-admin changes',async()=>{
  const usage=await usagePromise,reconciliation=await reconciliationPromise,{db,pack}=await dbPromise;
  const active=usage.beginUsage({context:{caseId:'case-2'},operation:'report',model:'gpt-6-luna',reserveMicros:50_000});
  const placeholder={orgId:'org-demo',actorId:'admin',callId:active.id,version:'x',amountUsd:'0',evidenceRef:'official zero evidence',note:'供应商明确拒绝且未创建任何响应。'};
  assert.throws(()=>reconciliation.previewManualSettlement(placeholder),/进行中的调用/);usage.completeUsage(active.id,'released');

  const call=usage.beginUsage({context:{caseId:'case-2'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(call.id,'known','responses',responseUsage());usage.completeUsage(call.id,'unknown');
  const version=reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===call.id)!.version;
  const base={...placeholder,callId:call.id,version,amountUsd:'0.000149'};
  assert.throws(()=>reconciliation.previewManualSettlement(base),/低于本地已记录/);
  assert.throws(()=>reconciliation.previewManualSettlement({...base,amountUsd:'0.000150',actorId:'advisor-1'}),/仅管理员/);
  db().prepare('INSERT INTO organizations VALUES(?,?)').run('org-other',pack({}));
  assert.throws(()=>reconciliation.previewManualSettlement({...base,amountUsd:'0.000150',orgId:'org-other'}),/组织不匹配/);
  usage.recordUsage(call.id,'late-before-preview','responses',responseUsage(1,0));
  assert.throws(()=>reconciliation.previewManualSettlement({...base,amountUsd:'0.000151'}),/已变化/);
});

test('automatic reconciliation requires an exact durable completion receipt',async()=>{
  const usage=await usagePromise,reconciliation=await reconciliationPromise,{db}=await dbPromise;
  const noProof=usage.beginUsage({context:{caseId:'case-3'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.completeUsage(noProof.id,'unknown');db().prepare("UPDATE ai_usage_calls SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(noProof.id);
  assert.equal(reconciliation.reconcilePendingUsage('org-demo'),0);
  assert.equal((db().prepare('SELECT status FROM ai_usage_calls WHERE id=?').get(noProof.id) as {status:string}).status,'unknown','age alone never releases a hold');

  const metered=usage.beginUsage({context:{caseId:'case-3'},operation:'realtime',model:'gpt-realtime-2.1',reserveMicros:100_000});
  usage.recordUsage(metered.id,'zero-provider-event','realtime',{input_tokens:0,output_tokens:0,input_token_details:{text_tokens:0,audio_tokens:0,cached_tokens:0},output_token_details:{text_tokens:0,audio_tokens:0}});
  assert.equal(reconciliation.recordUsageCompletion(metered.id,'settled'),true);assert.equal(reconciliation.recordUsageCompletion(metered.id,'settled'),false);
  usage.recoverUsageReservations();
  assert.equal(reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===metered.id)?.automaticReady,true);
  assert.equal(reconciliation.reconcilePendingUsage('org-demo'),1);assert.equal(reconciliation.reconcilePendingUsage('org-demo'),0);
  assert.equal((db().prepare('SELECT status FROM ai_usage_calls WHERE id=?').get(metered.id) as {status:string}).status,'settled');

  const zero=usage.beginUsage({context:{caseId:'case-3'},operation:'report',model:'gpt-6-luna',reserveMicros:50_000});
  reconciliation.recordUsageCompletion(zero.id,'released');usage.recoverUsageReservations();assert.equal(reconciliation.reconcilePendingUsage(),1);
  assert.equal((db().prepare('SELECT status FROM ai_usage_calls WHERE id=?').get(zero.id) as {status:string}).status,'released');
});

test('late provider usage reopens a reconciled call and invalidates automatic proof',async()=>{
  const usage=await usagePromise,reconciliation=await reconciliationPromise,{db}=await dbPromise;
  const call=usage.beginUsage({context:{caseId:'case-4'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(call.id,'initial','responses',responseUsage());usage.completeUsage(call.id,'unknown');
  const pending=reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===call.id)!;
  reconciliation.settleManualUsage({orgId:'org-demo',actorId:'admin',callId:call.id,version:pending.version,amountUsd:'0.000200',evidenceRef:'provider activity export',note:'人工核对后确认最终调用金额。',requestId:'late-manual',confirmed:true});
  usage.recordUsage(call.id,'late-unique','responses',responseUsage(10,0));
  const row=db().prepare('SELECT status,actual_micros FROM ai_usage_calls WHERE id=?').get(call.id) as {status:string;actual_micros:number};
  assert.equal(row.status,'unknown');assert.equal(row.actual_micros,200,'late usage fills the confirmed total instead of double charging it');
  const reopened=reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===call.id)!;
  assert.equal(reopened.automaticReady,false);assert.equal(reopened.recordedMicros,200);
  assert.equal(reconciliation.getReconciliationOverview('org-demo').history.some(item=>item.callId===call.id),true,'immutable reconciliation history remains');

  const gap=usage.beginUsage({context:{caseId:'case-4'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(gap.id,'gap-initial','responses',responseUsage());usage.completeUsage(gap.id,'unknown');
  const gapPending=reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===gap.id)!;
  const gapInput={orgId:'org-demo',actorId:'admin',callId:gap.id,version:gapPending.version,amountUsd:'0.000300',evidenceRef:'provider activity total',note:'官方记录确认本次调用总额为三百微美元。'};
  reconciliation.settleManualUsage({...gapInput,requestId:'gap-manual',confirmed:true});
  usage.recordUsage(gap.id,'gap-fill','responses',responseUsage());
  let gapRow=db().prepare('SELECT status,actual_micros FROM ai_usage_calls WHERE id=?').get(gap.id) as {status:string;actual_micros:number};
  assert.deepEqual({...gapRow},{status:'unknown',actual_micros:300},'an exact late gap fill does not increase the confirmed total');
  const gapReopened=reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===gap.id)!;
  assert.equal(reconciliation.previewManualSettlement({...gapInput,version:gapReopened.version}).confirmedMicros,300,'the same official final remains acceptable after the gap is filled');
  usage.recordUsage(gap.id,'above-confirmed','responses',responseUsage(10,0));
  gapRow=db().prepare('SELECT status,actual_micros FROM ai_usage_calls WHERE id=?').get(gap.id) as {status:string;actual_micros:number};
  assert.deepEqual({...gapRow},{status:'unknown',actual_micros:301},'provider events above the confirmation become the conservative recorded total');
  const aboveVersion=reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===gap.id)!.version;
  assert.throws(()=>reconciliation.previewManualSettlement({...gapInput,version:aboveVersion}),/低于本地已记录/);

  const normallySettled=usage.beginUsage({context:{caseId:'case-4'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(normallySettled.id,'normal-initial','responses',responseUsage());
  reconciliation.recordUsageCompletion(normallySettled.id,'settled');
  usage.completeUsage(normallySettled.id,'settled');
  usage.recordUsage(normallySettled.id,'normal-late','responses',responseUsage(10,0));
  assert.equal((db().prepare('SELECT status FROM ai_usage_calls WHERE id=?').get(normallySettled.id) as {status:string}).status,'unknown','late usage reopens a normally settled call backed by a durable completion receipt');
  assert.equal((db().prepare('SELECT COUNT(*) count FROM ai_usage_completion_receipts WHERE call_id=?').get(normallySettled.id) as {count:number}).count,0,'late usage invalidates the stale completion receipt');
});

test('manual adjustments use the original charge day and purge retains only anonymous totals',async()=>{
  const usage=await usagePromise,reconciliation=await reconciliationPromise,{db,transaction}=await dbPromise;
  const call=usage.beginUsage({context:{caseId:'case-5'},operation:'report',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(call.id,'purge-event','responses',responseUsage());usage.completeUsage(call.id,'unknown');
  db().prepare("UPDATE ai_usage_calls SET created_at='2001-02-03T04:05:06.000Z' WHERE id=?").run(call.id);
  const pending=reconciliation.getReconciliationOverview('org-demo').pending.find(item=>item.id===call.id)!;
  reconciliation.settleManualUsage({orgId:'org-demo',actorId:'admin',callId:call.id,version:pending.version,amountUsd:'0.000400',evidenceRef:'official cost export row 44',note:'按官方费用导出确认最终金额。',requestId:'purge-manual',confirmed:true});
  assert.equal((db().prepare('SELECT charge_day_utc FROM ai_usage_adjustments WHERE call_id=?').get(call.id) as {charge_day_utc:string}).charge_day_utc,'2001-02-03');
  transaction(()=>usage.purgeCaseUsage('case-5'));
  assert.equal((db().prepare('SELECT COUNT(*) count FROM ai_usage_reconciliations WHERE call_id=?').get(call.id) as {count:number}).count,0);
  assert.equal((db().prepare('SELECT cost_micros FROM ai_deleted_usage_daily WHERE org_id=? AND day_utc=?').get('org-demo','2001-02-03') as {cost_micros:number}).cost_micros,250,'manual adjustment is charged to the original call day');
  const anonymous=JSON.stringify(db().prepare("SELECT * FROM ai_deleted_usage_daily WHERE day_utc='2001-02-03'").all());
  for(const privateValue of [call.id,'case-5','official cost export'])assert.equal(anonymous.includes(privateValue),false);
});
