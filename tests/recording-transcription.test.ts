import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'aeconn-recording-transcription-')),'test.sqlite');
process.env.AI_CASE_BUDGET_USD='2';
process.env.AI_DAILY_BUDGET_USD='5';
process.env.AI_MONTHLY_BUDGET_USD='20';

const providerPromise=import('../lib/recording-transcription');
const audioPromise=import('../lib/recording-audio');
const usagePromise=import('../lib/ai-usage');

function restoreEnv(t:test.TestContext,keys:string[]){
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
}

async function wav(seconds=1){
  const {encodeRecordingWav}=await audioPromise;
  return encodeRecordingWav(new Int16Array(16_000*seconds));
}

function openAIResponse(duration=1,text='测试转写',status=200){
  return new Response(JSON.stringify({duration,text,segments:text?[{id:0,start:0,end:duration,text}]:[],usage:{type:'duration',seconds:Math.ceil(duration)}}),{
    status,headers:{'content-type':'application/json','x-request-id':`req_${duration}_${status}`},
  });
}

test('recording provider selection is explicit and mock never calls OpenAI',async(t)=>{
  restoreEnv(t,['RECORDING_PROVIDER','LLM_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL','OPENAI_TRANSCRIPTION_MODEL']);
  const provider=await providerPromise,audio=await wav();
  process.env.OPENAI_API_KEY='synthetic-unused';process.env.OPENAI_TRANSCRIPTION_MODEL='gpt-4o-mini-transcribe';delete process.env.RECORDING_TRANSCRIPTION_MODEL;delete process.env.RECORDING_PROVIDER;process.env.LLM_PROVIDER='mock';
  const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('mock mode must not use the network');});
  assert.deepEqual(provider.recordingProviderConfig(),{provider:'mock',configured:true});
  const result=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1'},provider:'mock'});
  assert.match(result.segments[0].text,/模拟转写/);assert.equal(network.mock.callCount(),0);

  process.env.RECORDING_PROVIDER='openai';
  assert.deepEqual(provider.recordingProviderConfig(),{provider:'openai',configured:true},'recording model is independent from the realtime transcription selector');
  delete process.env.OPENAI_API_KEY;
  assert.deepEqual(provider.recordingProviderConfig(),{provider:'openai',configured:false});
  await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-1'},provider:'openai'}),(error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_PROVIDER_NOT_CONFIGURED');
  assert.equal(network.mock.callCount(),0,'missing credentials are rejected before reserving or fetching');
});

test('Whisper multipart transcription settles trusted duration usage',async(t)=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL']);
  process.env.RECORDING_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-test-key';process.env.RECORDING_TRANSCRIPTION_MODEL='whisper-1';
  const provider=await providerPromise,{getUsageSummary}=await usagePromise,audio=await wav(10);
  const network=t.mock.method(globalThis,'fetch',async(url:URL|string,options?:RequestInit)=>{
    assert.equal(String(url),'https://api.openai.com/v1/audio/transcriptions');assert.equal(options?.method,'POST');
    assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer synthetic-test-key');
    const form=options?.body as FormData;
    assert.equal(form.get('model'),'whisper-1');assert.equal(form.get('response_format'),'verbose_json');assert.equal(form.get('timestamp_granularities[]'),'segment');
    const file=form.get('file');assert(file instanceof Blob);assert.equal(file.type,'audio/wav');
    return openAIResponse(10,'客户计划明年开始。');
  });
  const result=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1',sessionId:'recording-success'},provider:'openai'});
  assert.equal(result.durationSeconds,10);assert.equal(result.segments[0].text,'客户计划明年开始。');assert.equal(network.mock.callCount(),1);
  const record=getUsageSummary('org-demo','case-1',true).records[0];
  assert.equal(record.operation,'transcription');assert.equal(record.model,'whisper-1');assert.equal(record.status,'settled');assert.equal(record.transcriptionSeconds,10);assert.equal(record.costMicros,1_000);assert.equal(record.reservedMicros,1_100);
});

test('transcription budget is checked before the OpenAI request',async(t)=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL','AI_CASE_BUDGET_USD']);
  process.env.RECORDING_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-test-key';process.env.RECORDING_TRANSCRIPTION_MODEL='whisper-1';process.env.AI_CASE_BUDGET_USD='0.00005';
  const provider=await providerPromise,{UsageBudgetError}=await usagePromise,audio=await wav();
  const network=t.mock.method(globalThis,'fetch',async()=>openAIResponse());
  await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-2'},provider:'openai'}),(error:unknown)=>error instanceof UsageBudgetError);
  assert.equal(network.mock.callCount(),0);
});

test('ambiguous upstream failures retain a measured cost and unknown reservation',async(t)=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL']);
  process.env.RECORDING_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-test-key';process.env.RECORDING_TRANSCRIPTION_MODEL='whisper-1';
  const provider=await providerPromise,{getUsageSummary}=await usagePromise,audio=await wav();
  t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('synthetic timeout','TimeoutError');});
  await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-3',sessionId:'recording-timeout'},provider:'openai'}),(error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.usageOutcome==='unknown');
  const record=getUsageSummary('org-demo','case-3',true).records[0];
  assert.equal(record.status,'unknown');assert.equal(record.transcriptionSeconds,1);assert.equal(record.costMicros,100);assert.equal(record.reservedMicros,200);
});

test('malformed or duration-mismatched responses fail closed and remain unknown',async(t)=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL']);
  process.env.RECORDING_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-test-key';process.env.RECORDING_TRANSCRIPTION_MODEL='whisper-1';
  const provider=await providerPromise,{getUsageSummary}=await usagePromise,audio=await wav();
  const network=t.mock.method(globalThis,'fetch',async()=>new Response('{bad json',{status:200,headers:{'x-request-id':'req_bad'}}));
  await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-4',sessionId:'recording-malformed'},provider:'openai'}),(error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_RESPONSE_INVALID');
  assert.equal(getUsageSummary('org-demo','case-4',true).records[0].status,'unknown');

  network.mock.mockImplementation(async()=>openAIResponse(10,'时长不一致'));
  await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-5',sessionId:'recording-mismatch'},provider:'openai'}),(error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_DURATION_MISMATCH');
  assert.equal(getUsageSummary('org-demo','case-5',true).records[0].status,'unknown');

  network.mock.mockImplementation(async()=>new Response(JSON.stringify({duration:1,text:'长'.repeat(4_001),segments:[]}),{status:200}));
  await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-5',sessionId:'recording-unsegmented'},provider:'openai'}),(error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_RESPONSE_INVALID');
});
