import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const databaseRoot=mkdtempSync(join(tmpdir(),'aeconn-ai-usage-'));
process.env.DATABASE_PATH=join(databaseRoot,'usage.sqlite');
process.env.AI_CASE_BUDGET_USD='2';
process.env.AI_DAILY_BUDGET_USD='5';
process.env.AI_MONTHLY_BUDGET_USD='20';

const usagePromise=import('../lib/ai-usage');
const dbPromise=import('../lib/db');

test('Responses usage uses cached-token rate and releases unused reservation on settlement',async()=>{
  const usage=await usagePromise;
  const call=usage.beginUsage({context:{caseId:'case-1'},operation:'interview',model:'gpt-6-luna',reserveMicros:200_000});
  assert.equal(call.reservedMicros,200_000);
  assert.equal(usage.recordUsage(call.id,'response-1','responses',{input_tokens:1_000_000,output_tokens:100_000,input_tokens_details:{cached_tokens:200_000}},'resp_test'),true);
  assert.equal(usage.recordUsage(call.id,'response-1','responses',{input_tokens:1_000_000,output_tokens:100_000,input_tokens_details:{cached_tokens:200_000}},'resp_test'),false);
  assert.equal(usage.recordUsage(call.id,'response-1','responses',null),false,'an already recorded event is idempotent even when a retry payload is malformed');
  assert.deepEqual(usage.getUsageProgress(call.id),{costMicros:132_000,reservedMicros:200_000});
  usage.completeUsage(call.id,'settled');
  const summary=usage.getUsageSummary('org-demo','case-1',true);
  assert.equal(summary.case?.costMicros,132_000);
  assert.equal(summary.case?.heldMicros,0);
  assert.equal(summary.case?.remainingMicros,1_868_000);
  assert.equal(summary.records[0].cachedTokens,200_000);
  assert.equal(summary.estimatedNotBilled,true);
});

test('Realtime and transcription usage preserve modality detail and estimate cost',async()=>{
  const usage=await usagePromise;
  const call=usage.beginUsage({context:{caseId:'case-2',sessionId:'voice-synthetic'},operation:'realtime',model:'gpt-realtime-2.1',reserveMicros:100_000});
  assert.equal(usage.recordUsage(call.id,'rt-response','realtime',{
    input_tokens:300,output_tokens:110,
    input_token_details:{text_tokens:100,audio_tokens:200,cached_tokens:30,cached_tokens_details:{text_tokens:10,audio_tokens:20}},
    output_token_details:{text_tokens:50,audio_tokens:60},
  }),true);
  assert.equal(usage.recordUsage(call.id,'transcript-item','transcription',{type:'duration',seconds:60}),true);
  assert.equal(usage.recordUsage(call.id,'rt-without-cache-detail','realtime',{
    input_tokens:110,output_tokens:0,input_token_details:{text_tokens:10,audio_tokens:100,cached_tokens:50},output_token_details:{text_tokens:0,audio_tokens:0},
  }),true);
  assert.deepEqual(usage.getUsageProgress(call.id),{costMicros:16_112,reservedMicros:100_000});
  usage.completeUsage(call.id,'settled');
  const record=usage.getUsageSummary('org-demo','case-2',true).records[0];
  assert.equal(record.inputAudioTokens,300);
  assert.equal(record.outputAudioTokens,60);
  assert.equal(record.transcriptionSeconds,60);
});

test('Transcription token usage and malformed provider usage are handled fail-closed',async()=>{
  const usage=await usagePromise;
  const call=usage.beginUsage({context:{caseId:'case-3'},operation:'realtime',model:'gpt-realtime-2.1',reserveMicros:100_000});
  assert.equal(usage.recordUsage(call.id,'token-transcript','transcription',{type:'tokens',input_tokens:1_000,output_tokens:100,input_token_details:{text_tokens:200,audio_tokens:800}}),true);
  assert.equal(usage.getUsageProgress(call.id).costMicros,1_750);
  assert.throws(()=>usage.recordUsage(call.id,'bad','realtime',{input_tokens:1,output_tokens:1}),usage.UsageDataError);
  assert.throws(()=>usage.recordUsage(call.id,'bad-transcript','transcription',{type:'duration',seconds:-1}),usage.UsageDataError);
  usage.completeUsage(call.id,'settled');
});

test('Whisper duration uses its approved rate while the default transcription model remains mini',async()=>{
  const usage=await usagePromise,{db}=await dbPromise;
  const whisper=usage.beginUsage({context:{caseId:'case-3'},operation:'realtime',model:'gpt-realtime-2.1',transcriptionModel:'whisper-1',reserveMicros:100_000});
  assert.equal((db().prepare('SELECT transcription_model FROM ai_usage_calls WHERE id=?').get(whisper.id) as {transcription_model:string}).transcription_model,'whisper-1');
  assert.equal(usage.recordUsage(whisper.id,'whisper-minute','transcription',{type:'duration',seconds:60}),true);
  assert.equal(usage.getUsageProgress(whisper.id).costMicros,6_000);
  assert.throws(()=>usage.recordUsage(whisper.id,'whisper-tokens','transcription',{type:'tokens',input_tokens:1,output_tokens:0,input_token_details:{text_tokens:0,audio_tokens:1}}),usage.UsageDataError);
  usage.completeUsage(whisper.id,'settled');

  const mini=usage.beginUsage({context:{caseId:'case-3'},operation:'realtime',model:'gpt-realtime-2.1',reserveMicros:100_000});
  assert.equal((db().prepare('SELECT transcription_model FROM ai_usage_calls WHERE id=?').get(mini.id) as {transcription_model:string}).transcription_model,'gpt-4o-mini-transcribe');
  usage.recordUsage(mini.id,'mini-minute','transcription',{type:'duration',seconds:60});
  assert.equal(usage.getUsageProgress(mini.id).costMicros,3_000);
  usage.completeUsage(mini.id,'settled');

  assert.throws(()=>usage.beginUsage({context:{caseId:'case-3'},operation:'realtime',model:'gpt-realtime-2.1',transcriptionModel:'unknown-transcriber' as never}),usage.UsageBudgetError);
});

test('Atomic reservations enforce case, day and month limits without double-spend',async()=>{
  const usage=await usagePromise;
  const previous={case:process.env.AI_CASE_BUDGET_USD,day:process.env.AI_DAILY_BUDGET_USD,month:process.env.AI_MONTHLY_BUDGET_USD};
  try{
    process.env.AI_CASE_BUDGET_USD='0.1';process.env.AI_DAILY_BUDGET_USD='5';process.env.AI_MONTHLY_BUDGET_USD='20';
    const first=usage.beginUsage({context:{caseId:'case-4'},operation:'interview',model:'gpt-6-luna',reserveMicros:60_000});
    assert.throws(()=>usage.beginUsage({context:{caseId:'case-4'},operation:'report',model:'gpt-6-luna',reserveMicros:60_000}),usage.UsageBudgetError);
    usage.completeUsage(first.id,'released');
    const replacement=usage.beginUsage({context:{caseId:'case-4'},operation:'report',model:'gpt-6-luna',reserveMicros:60_000});
    assert.equal(replacement.reservedMicros,60_000);
    usage.completeUsage(replacement.id,'released');

    const baseline=usage.getUsageSummary('org-demo');
    process.env.AI_CASE_BUDGET_USD='2';process.env.AI_DAILY_BUDGET_USD=String((baseline.day.costMicros+100_000)/1_000_000);
    const dayHold=usage.beginUsage({context:{caseId:'case-8'},operation:'interview',model:'gpt-6-luna',reserveMicros:60_000});
    assert.throws(()=>usage.beginUsage({context:{caseId:'case-9'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000}),usage.UsageBudgetError);
    usage.completeUsage(dayHold.id,'released');

    process.env.AI_DAILY_BUDGET_USD='5';process.env.AI_MONTHLY_BUDGET_USD=String((baseline.month.costMicros+100_000)/1_000_000);
    const monthHold=usage.beginUsage({context:{caseId:'case-8'},operation:'interview',model:'gpt-6-luna',reserveMicros:60_000});
    assert.throws(()=>usage.beginUsage({context:{caseId:'case-9'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000}),usage.UsageBudgetError);
    usage.completeUsage(monthHold.id,'released');
  }finally{
    process.env.AI_CASE_BUDGET_USD=previous.case;process.env.AI_DAILY_BUDGET_USD=previous.day;process.env.AI_MONTHLY_BUDGET_USD=previous.month;
  }
});

test('Unknown and recovered reservations stay held across UTC budget rollover',async()=>{
  const usage=await usagePromise,{db}=await dbPromise;
  const before=usage.getUsageSummary('org-demo');
  const unknown=usage.beginUsage({context:{caseId:'case-5'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(unknown.id,'small-response','responses',{input_tokens:10,output_tokens:10,input_tokens_details:{cached_tokens:0}});
  usage.completeUsage(unknown.id,'unknown');
  db().prepare("UPDATE ai_usage_calls SET budget_day_utc='2000-01-01',budget_month_utc='2000-01' WHERE id=?").run(unknown.id);
  let summary=usage.getUsageSummary('org-demo','case-5');
  assert.equal(summary.day.costMicros+summary.day.heldMicros,before.day.costMicros+before.day.heldMicros+50_000);
  assert.equal(summary.month.costMicros+summary.month.heldMicros,before.month.costMicros+before.month.heldMicros+50_000);
  assert.equal(summary.case?.costMicros,6);
  assert.equal(summary.case?.heldMicros,49_994);

  const stranded=usage.beginUsage({context:{caseId:'case-6'},operation:'extraction',model:'gpt-6-luna',reserveMicros:50_000});
  assert.equal(usage.recoverUsageReservations()>=1,true);
  const status=(db().prepare('SELECT status FROM ai_usage_calls WHERE id=?').get(stranded.id) as {status:string}).status;
  assert.equal(status,'unknown');
  summary=usage.getUsageSummary('org-demo','case-6');
  assert.equal(summary.case?.heldMicros,50_000);

  const beforeSettled=usage.getUsageSummary('org-demo');
  const crossMidnight=usage.beginUsage({context:{caseId:'case-10'},operation:'report',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(crossMidnight.id,'cross-midnight-response','responses',{input_tokens:10,output_tokens:10,input_tokens_details:{cached_tokens:0}});
  usage.completeUsage(crossMidnight.id,'settled');
  db().prepare("UPDATE ai_usage_calls SET budget_day_utc='2000-01-01',budget_month_utc='2000-01' WHERE id=?").run(crossMidnight.id);
  const afterSettled=usage.getUsageSummary('org-demo');
  assert.equal(afterSettled.day.costMicros,beforeSettled.day.costMicros+6);
  assert.equal(afterSettled.month.costMicros,beforeSettled.month.costMicros+6);
});

test('A reservation with provider usage cannot be released, and late usage revives a released call',async()=>{
  const usage=await usagePromise;
  const metered=usage.beginUsage({context:{caseId:'case-11'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(metered.id,'metered','responses',{input_tokens:1,output_tokens:0,input_tokens_details:{cached_tokens:0}});
  assert.throws(()=>usage.completeUsage(metered.id,'released'),usage.UsageDataError);
  usage.completeUsage(metered.id,'unknown');

  const late=usage.beginUsage({context:{caseId:'case-12'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.completeUsage(late.id,'released');
  usage.recordUsage(late.id,'late-response','responses',{input_tokens:1,output_tokens:0,input_tokens_details:{cached_tokens:0}});
  const summary=usage.getUsageSummary('org-demo','case-12',true);
  assert.equal(summary.records[0].status,'unknown');
  assert.equal(summary.case?.costMicros,1);
  assert.equal(summary.case?.heldMicros,49_999);
});

test('Ledger stores only normalized numeric usage and rejects unknown models or bad limits',async()=>{
  const usage=await usagePromise,{db}=await dbPromise;
  assert.throws(()=>usage.beginUsage({context:{caseId:'case-7'},operation:'interview',model:'unpriced-model'}),usage.UsageBudgetError);
  assert.throws(()=>usage.beginUsage({context:{caseId:'missing'},operation:'interview',model:'gpt-6-luna'}),usage.UsageBudgetError);
  const call=usage.beginUsage({context:{caseId:'case-7'},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  usage.recordUsage(call.id,'safe','responses',{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0},secret:'must-not-persist'});
  const detail=String((db().prepare('SELECT detail FROM ai_usage_events WHERE call_id=?').get(call.id) as {detail:string}).detail);
  assert.equal(detail.includes('must-not-persist'),false);
  usage.completeUsage(call.id,'settled');

  const prior=process.env.AI_CASE_BUDGET_USD;process.env.AI_CASE_BUDGET_USD='not-a-number';
  try{assert.throws(()=>usage.getUsageSummary('org-demo'),usage.UsageBudgetError);}finally{process.env.AI_CASE_BUDGET_USD=prior;}
  process.env.AI_CASE_BUDGET_USD='0';
  try{assert.throws(()=>usage.beginUsage({context:{caseId:'case-8'},operation:'interview',model:'gpt-6-luna',reserveMicros:1}),usage.UsageBudgetError);}finally{process.env.AI_CASE_BUDGET_USD=prior;}
});
