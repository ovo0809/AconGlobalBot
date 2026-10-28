import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ProfileField } from '../lib/domain';
import { analyzeWithProvider, interviewWithProvider, buildCloudSafeInput, providerCapabilities, ProviderExtractionValidationError, validateProviderAnalyses, validateProviderFacts } from '../lib/providers';
import { getUsageSummary, beginUsage } from '../lib/ai-usage';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'aeconn-provider-usage-')),'test.sqlite');
const syntheticUsage={input_tokens:2000,output_tokens:100,input_tokens_details:{cached_tokens:500},output_tokens_details:{reasoning_tokens:20},total_tokens:2100};

const messages: Message[] = [{ id: 'm1', caseId: 'c1', sessionId: 's1', turnId: 't1', eventId: 'e1', role: 'user', text: '邮箱 alex@example.com，电话 415-555-1212，年收入 80000 美元。', final: true, interrupted: false, createdAt: '2026-01-01' }];
const facts: ProfileField[] = [
  { key: 'annual_income', value: '80000', currency: 'USD', period: 'year', factStatus: 'reported_unverified', sourceMessageIds: ['m1'], confirmedBy: null, confirmedAt: null },
  { key: 'email', value: 'alex@example.com', currency: null, period: null, factStatus: 'confirmed', sourceMessageIds: [], confirmedBy: 'advisor', confirmedAt: '2026-01-01' },
];

test('cloud payload excludes identity fact fields and redacts final user transcript text', () => {
  const safe = buildCloudSafeInput({ messages, facts });
  assert.equal(safe.facts.length, 1);
  assert.equal(safe.facts[0].key, 'annual_income');
  assert.deepEqual(safe.messages[0], { id: 'm1', role: 'user', text: '邮箱 [email removed]，电话 [phone removed]，年收入 80000 美元。' });
});

test('provider extraction keeps facts unconfirmed and requires case-local source IDs', () => {
  const output = { facts: [{ key: 'income', value: 80_000, currency: 'USD', period: 'year', factStatus: 'reported_unverified', sourceMessageIds: ['m1'] }] };
  const extracted = validateProviderFacts(output, { messages, facts });
  assert.equal(extracted[0].confirmedBy, null);
  assert.equal(extracted[0].confirmedAt, null);
  assert.throws(() => validateProviderFacts({ facts: [{ ...output.facts[0], sourceMessageIds: ['other-case'] }] }, { messages, facts }), /outside this case/);
  assert.throws(() => validateProviderFacts({ facts: [{ ...output.facts[0], factStatus: 'confirmed' }] }, { messages, facts }), /status is invalid/);
});

test('provider validation requires four unique categories and case-local evidence', () => {
  const analyses = ['life', 'annuity', 'ltc', 'disability_income'].map((category) => ({
    category,
    status: 'priority_discussion',
    evidenceRefs: ['m1'],
    reasonSummary: '仅供内部讨论。',
    missingFields: [],
    constraints: ['待人工复核'],
    nextQuestions: [],
  }));
  assert.equal(validateProviderAnalyses({ analyses }, { messages, facts }).length, 4);
  analyses[3].evidenceRefs = ['other-case'];
  assert.throws(() => validateProviderAnalyses({ analyses }, { messages, facts }), /outside this case/);
});

test('provider capability is explicit when credentials are absent', () => {
  const beforeKey = process.env.GEMINI_API_KEY;
  const beforeModel = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  assert.deepEqual(providerCapabilities(), { analysis: 'mock:demo_unapproved', voice: 'not_configured' });
  if (beforeKey) process.env.GEMINI_API_KEY = beforeKey;
  if (beforeModel) process.env.GEMINI_MODEL = beforeModel;
});

test('prototype mock mode ignores available cloud credentials and never makes a model request', async (t) => {
  const keys = ['LLM_PROVIDER', 'VOICE_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_LIVE_MODEL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.GEMINI_API_KEY = 'synthetic-unused-key';
  process.env.GEMINI_MODEL = 'synthetic-unused-model';
  process.env.GEMINI_LIVE_MODEL = 'synthetic-unused-live-model';
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Prototype must not call a cloud model'); });
  for (const mode of [undefined, 'mock']) {
    if (mode === undefined) { delete process.env.LLM_PROVIDER; delete process.env.VOICE_PROVIDER; }
    else { process.env.LLM_PROVIDER = mode; process.env.VOICE_PROVIDER = mode; }
    const result = await analyzeWithProvider({ messages: [], facts: [] });
    assert.match(result.provider, /^mock/);
    assert.equal(result.analyses.length, 4);
    assert.deepEqual(providerCapabilities(), { analysis: 'mock:demo_unapproved', voice: 'not_configured' });
  }
  assert.equal(network.mock.callCount(), 0);
});

test('cloud analysis requires an explicit selector and does not enable realtime voice', async (t) => {
  const keys = ['LLM_PROVIDER', 'VOICE_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_LIVE_MODEL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.LLM_PROVIDER = 'gemini';
  process.env.VOICE_PROVIDER = 'mock';
  process.env.GEMINI_API_KEY = 'synthetic-cloud-key';
  process.env.GEMINI_MODEL = 'synthetic-cloud-model';
  process.env.GEMINI_LIVE_MODEL = 'synthetic-unused-live-model';
  const analyses = ['life', 'annuity', 'ltc', 'disability_income'].map(category => ({ category, status:'insufficient_information', evidenceRefs:[], reasonSummary:'测试资料不足', missingFields:['goal'], constraints:['待核验'], nextQuestions:['目标是什么？'] }));
  const network = t.mock.method(globalThis, 'fetch', async (_url:unknown, options:RequestInit) => {
    const payload = JSON.parse(String(options.body));
    assert.equal(payload.model, 'synthetic-cloud-model');
    return new Response(JSON.stringify({ steps:[{ type:'model_output', content:[{ type:'text', text:JSON.stringify({facts:[],analyses}) }] }] }));
  });
  const result = await analyzeWithProvider({messages:[],facts:[]});
  assert.equal(result.provider, 'gemini:synthetic-cloud-model');
  assert.equal(network.mock.callCount(), 1);
  assert.equal(providerCapabilities().voice, 'not_configured');
  process.env.LLM_PROVIDER = 'mock';
  process.env.VOICE_PROVIDER = 'gemini';
  assert.deepEqual(providerCapabilities(), { analysis:'mock:demo_unapproved', voice:'configured_not_verified' });
});

test('OpenAI structured interview uses server credentials, saved context and validates grounded facts', async (t) => {
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  let content:unknown={reply:'您希望什么时候开始？',facts:[{key:'income',value:80000,currency:'USD',period:'year',factStatus:'reported_unverified',sourceMessageIds:['m1']}]};
  const network=t.mock.method(globalThis,'fetch',async (url:unknown,options:RequestInit)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal((options.headers as Record<string,string>).Authorization,'Bearer synthetic-key');
    const payload=JSON.parse(String(options.body));
    assert.equal(payload.store,false);assert.equal(payload.text.format.strict,true);assert.equal(payload.text.format.name,'aeconn_interview');
    assert.match(payload.input[0].content,/knownFacts/);assert.doesNotMatch(payload.input[0].content,/alex@example.com/);
    assert.equal(payload.max_output_tokens,2048);
    return new Response(JSON.stringify({usage:syntheticUsage,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(content)}]}]}));
  });
  const input={usageContext:{caseId:'case-1'},entry:'life' as const,messages:[{...messages[0],text:'年收入 80000 美元。'},{...messages[0],id:'m2',text:'邮箱 alex@example.com'}],facts:[]};
  const result=await interviewWithProvider(input);
  assert.equal(result?.facts[0].value,80000);assert.equal(result?.facts[0].confirmedBy,null);
  content={reply:'收到。',facts:[{key:'income',value:99999,currency:'USD',period:'year',factStatus:'reported_unverified',sourceMessageIds:['m1']}]};
  await assert.rejects(()=>interviewWithProvider(input),/not present/);
  assert.equal(network.mock.callCount(),2);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(()=>interviewWithProvider(input),/requires/);
  assert.equal(network.mock.callCount(),2,'incomplete cloud setup must fail, not call a model or fall back to mock');
});

test('final extraction retries one strict validation failure without exposing rejected output',async t=>{
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  const source={...messages[0],caseId:'case-4',text:'年收入 80000 美元。'};
  const interviewInput={usageContext:{caseId:'case-4'},entry:'life' as const,messages:[source],facts:[]};
  const outputs=[
    {reply:'访谈已保存。',facts:[{key:'income',value:99999,currency:'USD',period:'year',factStatus:'reported_unverified',sourceMessageIds:['m1']}]},
    {reply:'访谈已保存。',facts:[{key:'income',value:80000,currency:'USD',period:'year',factStatus:'reported_unverified',sourceMessageIds:['m1']}]},
  ];
  const network=t.mock.method(globalThis,'fetch',async (_url:unknown,options:RequestInit)=>{
    const request=JSON.parse(String(options.body));
    if(network.mock.callCount()===1){
      const correction=String(request.input[0].content).split('STRICT_VALIDATION_RETRY:')[1];
      assert.match(correction,/amount_grounding/);
      assert.doesNotMatch(correction,/99999|income|m1/);
    }
    const output=outputs.shift();
    return new Response(JSON.stringify({id:`retry-${network.mock.callCount()}`,usage:syntheticUsage,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}));
  });
  const result=await interviewWithProvider(interviewInput,true);
  assert.equal(result?.facts[0].value,80000);
  assert.equal(network.mock.callCount(),2);
  assert.equal(getUsageSummary('org-demo','case-4',true).records.length,2);
});

test('final extraction retries at most once and charges both invalid responses',async t=>{
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  const interviewInput={usageContext:{caseId:'case-5'},entry:'life' as const,messages:[{...messages[0],caseId:'case-5',text:'年收入 80000 美元。'}],facts:[]};
  const network=t.mock.method(globalThis,'fetch',async ()=>new Response(JSON.stringify({usage:syntheticUsage,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'访谈已保存。',facts:[{key:'income',value:99999,currency:'USD',period:'year',factStatus:'reported_unverified',sourceMessageIds:['m1']}]})}]}]})));
  await assert.rejects(()=>interviewWithProvider(interviewInput,true),(error:unknown)=>error instanceof ProviderExtractionValidationError&&error.code==='AI_EXTRACTION_VALIDATION'&&error.category==='amount_grounding');
  assert.equal(network.mock.callCount(),2);
  const records=getUsageSummary('org-demo','case-5',true).records;
  assert.equal(records.length,2);
  assert(records.every(record=>record.costMicros>0));
});

test('final extraction budget refusal blocks retry before network, while normal turns never retry',async t=>{
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL','AI_CASE_BUDGET_USD'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';process.env.AI_CASE_BUDGET_USD='0.05';
  const invalid={reply:'访谈已保存。',facts:[{key:'income',value:99999,currency:'USD',period:'year',factStatus:'reported_unverified',sourceMessageIds:['m1']}]};
  const network=t.mock.method(globalThis,'fetch',async ()=>new Response(JSON.stringify({usage:syntheticUsage,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(invalid)}]}]})));
  const finalizeInput={usageContext:{caseId:'case-6'},entry:'life' as const,messages:[{...messages[0],caseId:'case-6',text:'年收入 80000 美元。'}],facts:[]};
  await assert.rejects(()=>interviewWithProvider(finalizeInput,true),/费用上限/);
  assert.equal(network.mock.callCount(),1,'the second reservation is rejected before fetch');

  process.env.AI_CASE_BUDGET_USD='2';
  const normalInput={usageContext:{caseId:'case-7'},entry:'life' as const,messages:[{...messages[0],caseId:'case-7',text:'年收入 80000 美元。'}],facts:[]};
  await assert.rejects(()=>interviewWithProvider(normalInput,false),/not present/);
  assert.equal(network.mock.callCount(),2,'a normal interview turn makes only one request');
});

test('OpenAI report cannot use unsaved transcript evidence or mutate saved facts', async (t) => {
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  let supported=true;
  t.mock.method(globalThis,'fetch',async (_url:unknown,options:RequestInit)=>{
    const request=JSON.parse(String(options.body));assert.equal(request.text.format.name,'aeconn_report');
    assert.equal(request.text.format.schema.properties.facts,undefined);
    const analyses=['life','annuity','ltc','disability_income'].map(category=>({category,status:'insufficient_information',evidenceRefs:supported?[]:['m1'],reasonSummary:'资料不足。',missingFields:['goal'],constraints:[],nextQuestions:[]}));
    return new Response(JSON.stringify({usage:syntheticUsage,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({analyses,facts:[{key:'income',value:99999}]})}]}]}));
  });
  const input={messages,facts:[],usageContext:{caseId:'case-1'}};
  const output=await analyzeWithProvider(input);assert.equal(output.facts,undefined);assert.equal(output.provider,'openai:gpt-6-luna');
  supported=false;await assert.rejects(()=>analyzeWithProvider(input),/outside this case/);
});

test('OpenAI metering reserves before fetch, records refused output, and holds unknown transport costs',async t=>{
  const names=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];
  const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of names){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  const input={usageContext:{caseId:'case-2'},entry:'life' as const,messages:[],facts:[]};
  let mode='refused';
  const network=t.mock.method(globalThis,'fetch',async()=>{
    assert.equal(getUsageSummary('org-demo','case-2',true).case?.heldMicros,50_000);
    if(mode==='timeout')throw new Error('synthetic transport failure');
    return new Response(JSON.stringify({id:'resp-refused',usage:syntheticUsage,status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}));
  });
  await assert.rejects(()=>interviewWithProvider(input),/declined/);
  assert(getUsageSummary('org-demo','case-2',true).case!.costMicros>0);
  mode='timeout';await assert.rejects(()=>interviewWithProvider(input),/transport failure/);
  assert.equal(getUsageSummary('org-demo','case-2',true).case?.heldMicros,50_000);
  beginUsage({context:{caseId:'case-2'},operation:'realtime',model:'gpt-realtime-2.1'});
  await assert.rejects(()=>interviewWithProvider(input));
  assert.equal(network.mock.callCount(),2,'budget refusal happens before network');
});

test('mock with OpenAI credentials creates no paid ledger and unknown rates fail closed',async t=>{
  const names=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of names){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
  process.env.LLM_PROVIDER='mock';process.env.OPENAI_API_KEY='synthetic-unused';process.env.OPENAI_MODEL='unknown-rate';
  const input={usageContext:{caseId:'case-3'},entry:'life' as const,messages:[],facts:[]};
  const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('No network allowed');});
  assert.equal(await interviewWithProvider(input),null);
  assert.equal(getUsageSummary('org-demo','case-3',true).records.length,0);
  process.env.LLM_PROVIDER='openai';await assert.rejects(()=>interviewWithProvider(input));
  await assert.rejects(()=>interviewWithProvider({...input,usageContext:undefined}),/server-owned case/);
  assert.equal(network.mock.callCount(),0);
});
