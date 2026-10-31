import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { getUsageSummary } from '../lib/ai-usage';
import { analyzeWithProvider, interviewWithProvider, validateProviderAnalyses } from '../lib/providers';
import { validateInterviewTurn } from '../lib/interview';
import type { KnowledgeContext } from '../lib/knowledge';
import type { Bootstrap, ProfileField } from '../lib/domain';

const root=mkdtempSync(join(tmpdir(),'aeconn-knowledge-integration-'));
process.env.DATABASE_PATH=join(root,'test.sqlite');
process.env.KNOWLEDGE_LOCAL_DIR=root;
process.env.KNOWLEDGE_REMOTE='off';
process.env.DEMO_PASSWORD='AeconnDemo!2026';
process.env.MAIL_MODE='dry_run';
const referenceText='家庭保障与收入中断讨论时，请先核对现有安排和家庭责任。合成示范规则，未经 Charles 批准。';
writeFileSync(join(root,'family.md'),`# 家庭保障访谈示例\nreview_status: demo_unapproved\n\n${referenceText}\n`);
const knowledge:KnowledgeContext={status:'ready',revision:'a'.repeat(40),notices:[],sources:[{id:'K_example',title:'家庭保障访谈示例',path:'knowledge/family.md',url:`https://github.com/ovo0809/AconGlobalBot/blob/${'a'.repeat(40)}/knowledge/family.md#L1-L4`,revision:'a'.repeat(40),startLine:1,endLine:4,excerpt:referenceText,reviewStatus:'demo_unapproved'}]};
const customer={id:'customer-1',caseId:'case-1',sessionId:'session-1',turnId:'turn-1',eventId:'event-1',role:'user' as const,text:'我想保障家庭责任',final:true,interrupted:false,createdAt:'2026-10-29'};
const savedFact:ProfileField={key:'goal',value:customer.text,currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:[customer.id],confirmedBy:null,confirmedAt:null};
const usage={input_tokens:900,output_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0},total_tokens:1000};

function cloud(t:test.TestContext){
  const keys=['LLM_PROVIDER','VOICE_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL','AI_CASE_BUDGET_USD','AI_DAILY_BUDGET_USD','AI_MONTHLY_BUDGET_USD'];
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}});
  process.env.LLM_PROVIDER='openai';process.env.VOICE_PROVIDER='mock';process.env.OPENAI_API_KEY='synthetic-no-network';process.env.OPENAI_MODEL='gpt-6-luna';
  process.env.AI_CASE_BUDGET_USD='8';process.env.AI_DAILY_BUDGET_USD='40';process.env.AI_MONTHLY_BUDGET_USD='160';
}
function response(output:unknown){return new Response(JSON.stringify({id:crypto.randomUUID(),status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}));}
function analyses(refs:string[]=[]){return ['life','annuity','ltc','disability_income'].map(category=>({category,status:'insufficient_information',evidenceRefs:[],knowledgeRefs:refs,reasonSummary:'客户资料不足；参考资料仅用于下一步核对。',missingFields:['existing_life'],constraints:['示范资料待人工复核'],nextQuestions:['目前已有哪些家庭保障安排？']}));}

test('knowledge IDs are separate from customer evidence and unknown citations are rejected',()=>{
  const input={entry:'life' as const,messages:[customer],facts:[],knowledge};
  assert.deepEqual(validateInterviewTurn({reply:'目前已有哪些保障安排？',facts:[],knowledgeRefs:['K_example']},input).knowledgeRefs,['K_example']);
  assert.throws(()=>validateInterviewTurn({reply:'目前已有哪些保障安排？',facts:[],knowledgeRefs:['K_invented']},input));
  assert.throws(()=>validateInterviewTurn({reply:'目前已有哪些保障安排？',facts:[{...savedFact,sourceMessageIds:['K_example']}],knowledgeRefs:['K_example']},input));
  assert.throws(()=>validateProviderAnalyses({analyses:analyses(['K_invented'])},{messages:[customer],facts:[],knowledge}));
  assert.throws(()=>validateProviderAnalyses({analyses:analyses().map(a=>({...a,status:'priority_discussion',evidenceRefs:['K_example']}))},{messages:[customer],facts:[],knowledge}));
});

test('interview/report receive bounded references, final extraction excludes them, and calls retain usage accounting',async t=>{
  cloud(t);
  const requests:string[]=[];
  const fetch=t.mock.method(globalThis,'fetch',async (_url:unknown,options?:RequestInit)=>{
    const request=JSON.parse(String(options?.body));
    const prompt=request.input[0].content as string;
    requests.push(request.text.format.name);
    if(request.text.format.name==='aeconn_extraction'){
      assert(!prompt.includes(referenceText));
      return response({reply:'访谈已保存。',facts:[],knowledgeRefs:[]});
    }
    assert(prompt.includes(referenceText));
    assert(prompt.includes('untrusted'));
    if(request.text.format.name==='aeconn_report')return response({analyses:analyses(['K_example'])});
    return response({reply:'目前已有哪些保障安排？',facts:[],knowledgeRefs:['K_example']});
  });
  const input={entry:'life' as const,messages:[customer],facts:[],knowledge,usageContext:{caseId:'case-1'}};
  assert.deepEqual((await interviewWithProvider(input))?.knowledgeRefs,['K_example']);
  await interviewWithProvider(input,true);
  const result=await analyzeWithProvider({...input,facts:[savedFact]});
  assert.deepEqual(result.analyses[0].knowledgeRefs,['K_example']);
  assert.deepEqual(requests,['aeconn_interview','aeconn_extraction','aeconn_report']);
  const ledger=getUsageSummary('org-demo','case-1',true);
  assert.equal(ledger.records.length,3);
  assert(ledger.records.every(record=>record.costMicros>0&&record.status==='settled'));
  process.env.AI_CASE_BUDGET_USD='0.000001';
  await assert.rejects(()=>interviewWithProvider(input),/费用上限/);
  assert.equal(fetch.mock.callCount(),3,'insufficient allowance blocks before model network');
});

test('service persists interview and voice reference snapshots, reports version changed files, old PDF stays immutable',async t=>{
  cloud(t);
  const service=await import('../lib/service');
  const {db,docs}=await import('../lib/db');
  const requests:string[]=[];
  t.mock.method(globalThis,'fetch',async (_url:unknown,options?:RequestInit)=>{
    const request=JSON.parse(String(options?.body));const prompt=String(request.input[0].content);
    requests.push(request.text.format.name);
    // Retrieval snapshot IDs are emitted as JSON data, never customer message IDs.
    const refs=[...prompt.matchAll(/"id":"(K_[a-f0-9]+)"/g)].map(match=>match[1]);
    if(request.text.format.name==='aeconn_extraction')return response({reply:'访谈已保存。',facts:[],knowledgeRefs:[]});
    assert(prompt.includes(referenceText));
    assert(refs.length>0);
    return request.text.format.name==='aeconn_report'?response({analyses:analyses([refs[0]])}):response({reply:'目前已有哪些保障安排？',facts:[],knowledgeRefs:[refs[0]]});
  });
  let cookie='',csrf='';
  const refresh=async()=>{const r=service.bootstrap(new Request('http://localhost/api/bootstrap',{headers:{cookie}}));cookie=r.headers.get('set-cookie')?.split(';')[0]??cookie;const data=await r.json() as Bootstrap;csrf=data.csrf;return data;};
  const act=async(input:Record<string,unknown>)=>{const r=await service.action(new Request('http://localhost/api/action',{method:'POST',headers:{cookie,origin:'http://localhost','content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(input)}));cookie=r.headers.get('set-cookie')?.split(';')[0]??cookie;await refresh();return r;};
  await refresh();await act({action:'login',email:'advisor1@aeconn.example',password:'AeconnDemo!2026'});
  const created=await act({action:'createClient',name:'合成资料检索客户',birthday:'1980-01-01',gender:'男性',phone:'+1 555 123 4567',email:'knowledge@example.invalid',maritalStatus:'已婚',state:'CA',language:'中文'});
  const createdData=await created.json() as {caseId:string};
  const caseId=createdData.caseId;
  assert(caseId);
  await act({action:'enterClient',caseId});await act({action:'chooseEntry',entry:'life'});
  await act({action:'message',text:'我想保障家庭责任',eventId:'knowledge-answer'});
  const state=await refresh();
  assert.equal(state.messages.find(m=>m.eventId==='knowledge-answer:reply')?.knowledge,undefined,'client API cannot read local reference excerpts');
  const reply=docs<import('../lib/domain').Message>('SELECT doc FROM messages WHERE event_id=?','knowledge-answer:reply')[0];
  assert(reply?.knowledge?.sources.length);assert(reply.knowledgeRefs?.length);
  const sessionId=state.clientSession!.id;
  const voice=JSON.parse(await service.voiceHooks.getContext(sessionId));
  assert(voice.referenceKnowledge.sources.length);
  service.voiceHooks.persist(sessionId,{eventId:'knowledge-voice',turnId:'knowledge-voice',role:'assistant',text:'请核对现有保障。',knowledge:voice.referenceKnowledge});
  const savedVoice=docs<import('../lib/domain').Message>('SELECT doc FROM messages WHERE event_id=?','knowledge-voice')[0];
  assert.deepEqual(savedVoice.knowledge,voice.referenceKnowledge);
  await act({action:'end'});await service.processReportJobs();
  const report1=docs<import('../lib/domain').ReportContent>('SELECT doc FROM reports WHERE case_id=? ORDER BY version',caseId)[0];
  assert(report1?.knowledge?.sources.length);assert(report1.fullText.includes(referenceText));
  const pdf1=db().prepare('SELECT pdf FROM reports WHERE case_id=? AND version=?').get(caseId,report1.version)!.pdf as Uint8Array;
  assert(Buffer.from(pdf1).subarray(0,4).equals(Buffer.from('%PDF')));
  writeFileSync(join(root,'family.md'),`# 家庭保障访谈示例\nreview_status: demo_unapproved\n\n${referenceText}\n新增的家庭保障核对内容。\n`);
  const afterRefresh=Date.now()+6*60_000;
  t.mock.method(Date,'now',()=>afterRefresh);
  await act({action:'generateReport',caseId});
  const reports=docs<import('../lib/domain').ReportContent>('SELECT doc FROM reports WHERE case_id=? ORDER BY version',caseId);
  assert.equal(reports.length,2);assert.notEqual(reports[0].snapshotId,reports[1].snapshotId);
  assert.deepEqual(reports[0],report1);
  assert.deepEqual(db().prepare('SELECT pdf FROM reports WHERE case_id=? AND version=?').get(caseId,report1.version)!.pdf,pdf1);
  assert.equal(requests.filter(name=>name==='aeconn_extraction').length,1);
  assert.equal(getUsageSummary('org-demo',caseId,true).records.length,4);
});
