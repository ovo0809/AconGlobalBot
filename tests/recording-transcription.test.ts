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
  const {db}=await import('../lib/db');assert.equal(db().prepare('SELECT outcome FROM ai_usage_completion_receipts WHERE call_id=?').get(record.id)?.outcome,'settled');
});

test('material transcription carries a bounded Unicode-safe suffix as Whisper context only',async(t)=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL']);
  process.env.RECORDING_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-test-key';process.env.RECORDING_TRANSCRIPTION_MODEL='whisper-1';
  const provider=await providerPromise,audio=await wav(1);const previousText=`应被丢弃 ${'长'.repeat(100)} 上一段结尾🛡️`;
  const prompts:Array<FormDataEntryValue|null>=[];
  const network=t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{prompts.push((options?.body as FormData).get('prompt'));return openAIResponse();});
  await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1',sessionId:'material-context'},provider:'openai',allowChunkTimingFallback:true,previousText});
  await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1',sessionId:'material-context-empty'},provider:'openai',allowChunkTimingFallback:true,previousText:'   '});
  await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1',sessionId:'strict-context'},provider:'openai',previousText});
  assert.equal(network.mock.callCount(),3);assert.equal(typeof prompts[0],'string');assert(Buffer.byteLength(String(prompts[0]),'utf8')<=220);assert.match(String(prompts[0]),/上一段结尾🛡️$/);assert(!String(prompts[0]).includes('应被丢弃'));
  assert.equal(prompts[1],null);assert.equal(prompts[2],null,'strict recording transcription never sends material context');
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

test('material timing fallback preserves the full chunk source without fabricated sentence timestamps',async t=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL']);
  Object.assign(process.env,{RECORDING_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-test-key',RECORDING_TRANSCRIPTION_MODEL:'whisper-1'});
  const provider=await providerPromise,{getUsageSummary}=await usagePromise,audio=await wav(30);
  const payload={duration:30,text:'合成完整转写',segments:[{start:0,end:30.64,text:'合成'},{start:30.64,end:32.64,text:'完整转写'}]};
  const network=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(payload)));
  await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-6',sessionId:'strict-timing'},provider:'openai'}),(e:unknown)=>e instanceof provider.RecordingTranscriptionError&&e.message.includes('32.640s')&&!e.message.includes('完整转写'));
  const result=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-7',sessionId:'material-timing'},provider:'openai',allowChunkTimingFallback:true});
  assert.deepEqual(result.segments,[{startSeconds:0,endSeconds:30,text:'合成完整转写'}]);assert.match(result.timingWarning!,/整段音轨/);
  network.mock.mockImplementation(async()=>new Response(JSON.stringify({...payload,text:'合成完整转写补充'})));
  const extended=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-7',sessionId:'material-timing-extended'},provider:'openai',allowChunkTimingFallback:true});
  assert.deepEqual(extended.segments,[{startSeconds:0,endSeconds:30,text:'合成完整转写补充'}]);assert.match(extended.timingWarning!,/完整正文延伸.*整段音轨/);
  for(const conflict of [
    {...payload,text:'合成',segments:[{start:0,end:32.64,text:'合成完整转写'}]},
    {...payload,text:'合成全文',segments:[{start:0,end:32.64,text:'另一份分段'}]},
  ]){
    network.mock.mockImplementation(async()=>new Response(JSON.stringify(conflict)));
    await assert.rejects(
      provider.transcribeRecordingChunk({audio,context:{caseId:'case-7',sessionId:`invalid-content-${conflict.text}`},provider:'openai',allowChunkTimingFallback:true}),
      (error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_RESPONSE_INVALID'&&/完整正文与逐句分段不一致/.test(error.message),
    );
  }
  assert(getUsageSummary('org-demo','case-7',true).records.some(record=>record.status==='settled'));
  for(const invalid of [{...payload,duration:90},{...payload,text:''},{...payload,text:'长'.repeat(4001)},{...payload,segments:[{start:-1,end:2,text:'bad'}]},{...payload,segments:[{start:2,end:1,text:'bad'}]}]){
    network.mock.mockImplementation(async()=>new Response(JSON.stringify(invalid)));
    await assert.rejects(provider.transcribeRecordingChunk({audio,context:{caseId:'case-6',sessionId:'invalid-fallback'},provider:'openai',allowChunkTimingFallback:true}));
  }
});

test('partial Whisper segments cannot silently discard the complete transcript',async t=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL']);
  Object.assign(process.env,{RECORDING_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-test-key',RECORDING_TRANSCRIPTION_MODEL:'whisper-1'});
  const provider=await providerPromise,audio=await wav(10);
  const partial={duration:10,text:'前半段，后半段。',segments:[{start:0,end:4,text:'前半段'}]};
  const network=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(partial)));

  await assert.rejects(
    provider.transcribeRecordingChunk({audio,context:{caseId:'case-8',sessionId:'partial-strict'},provider:'openai'}),
    (error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_RESPONSE_INVALID',
  );

  const materialResult=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-9',sessionId:'partial-material'},provider:'openai',allowChunkTimingFallback:true});
  assert.deepEqual(materialResult.segments,[{startSeconds:0,endSeconds:10,text:'前半段，后半段。'}]);
  assert.match(materialResult.timingWarning!,/完整正文.*逐句分段.*整段音轨/);

  network.mock.mockImplementation(async()=>new Response(JSON.stringify({duration:10,text:'前半段， 后半段。',segments:[{start:0,end:4,text:'前半段'},{start:4,end:9,text:'后半段'}]})));
  const formattingOnly=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-10',sessionId:'format-equivalent'},provider:'openai'});
  assert.equal(formattingOnly.timingWarning,undefined);
  assert.deepEqual(formattingOnly.segments,[{startSeconds:0,endSeconds:4,text:'前半段'},{startSeconds:4,endSeconds:9,text:'后半段'}]);

  for(const [text,segmentText] of [['金额 1.5 万','金额 15 万'],['开始时间 12:30','开始时间 1230'],['编号 1 2','编号 12']]){
    network.mock.mockImplementation(async()=>new Response(JSON.stringify({duration:10,text,segments:[{start:0,end:9,text:segmentText}]})));
    await assert.rejects(
      provider.transcribeRecordingChunk({audio,context:{caseId:'case-12',sessionId:`numeric-${text}`},provider:'openai',allowChunkTimingFallback:true}),
      (error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_RESPONSE_INVALID',
    );
  }

  network.mock.mockImplementation(async()=>new Response(JSON.stringify({duration:10,text:'另一份正文',segments:[{start:0,end:4,text:'逐句正文'}]})));
  await assert.rejects(
    provider.transcribeRecordingChunk({audio,context:{caseId:'case-11',sessionId:'conflicting-material'},provider:'openai',allowChunkTimingFallback:true}),
    (error:unknown)=>error instanceof provider.RecordingTranscriptionError&&error.code==='RECORDING_RESPONSE_INVALID',
  );

  const longWhitespace=`前${' '.repeat(190_000)}后`;
  network.mock.mockImplementation(async()=>new Response(JSON.stringify({duration:10,text:longWhitespace,segments:[{start:0,end:9,text:'前后'}]})));
  const longFormattingOnly=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-12',sessionId:'long-whitespace'},provider:'openai'});
  assert.deepEqual(longFormattingOnly.segments,[{startSeconds:0,endSeconds:9,text:'前后'}]);
});

test('Whisper empty segments are ignored and optional segments retain full-chunk provenance',async t=>{
  restoreEnv(t,['RECORDING_PROVIDER','OPENAI_API_KEY','RECORDING_TRANSCRIPTION_MODEL']);
  Object.assign(process.env,{RECORDING_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-test-key',RECORDING_TRANSCRIPTION_MODEL:'whisper-1'});
  const provider=await providerPromise,audio=await wav();
  const network=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({duration:1,text:'合成',segments:[{start:0,end:0,text:' '},{start:0,end:1,text:'合成'}]})));
  let result=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1',sessionId:'empty-segment'},provider:'openai'});assert.deepEqual(result.segments,[{startSeconds:0,endSeconds:1,text:'合成'}]);
  network.mock.mockImplementation(async()=>new Response(JSON.stringify({duration:1,text:'合成'})));
  result=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1',sessionId:'optional-segments'},provider:'openai'});assert.deepEqual(result.segments,[{startSeconds:0,endSeconds:1,text:'合成'}]);assert.equal(result.timingWarning,undefined);
  result=await provider.transcribeRecordingChunk({audio,context:{caseId:'case-1',sessionId:'optional-segments-material'},provider:'openai',allowChunkTimingFallback:true});assert.deepEqual(result.segments,[{startSeconds:0,endSeconds:1,text:'合成'}]);assert.match(result.timingWarning!,/仅定位到整段音轨/);
});
